import type { Context } from '@deepseek-ai/cordis'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { STACK_PROC_ORDER, type StackPhase, type StackProcName, type StackSnapshot } from './shared.ts'

const CHROMIUM_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']

interface ManagedProc {
  readonly name: StackProcName
  readonly child: ChildProcess
  exited: boolean
  /** Set when the process was already serving and this plugin only adopted it. */
  readonly reused: boolean
}

async function which(command: string): Promise<string | undefined> {
  if (command.includes('/')) {
    try {
      await access(command, fsConstants.X_OK)
      return command
    } catch {
      return undefined
    }
  }
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, command)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* keep probing */
    }
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tcpProbe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function cdpProbe(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  return false
}

/**
 * Owns the Xvfb → Chromium → x11vnc → websockify chain.
 *
 * Each stage is adopted when something already listens (so a stack started by
 * hand or by another tool keeps working and stays one instance), spawned
 * otherwise. Every spawned child runs in its own process group, so teardown
 * reaps Chromium's children too.
 */
export class BrowserStack {
  private readonly procs = new Map<StackProcName, ManagedProc>()
  private phase: StackPhase = 'stopped'
  /** Stages adopted from an already-running instance rather than spawned. */
  private readonly adopted = new Set<StackProcName>()
  private missing: StackProcName[] = []
  private message: string | undefined
  private stopping = false
  private chromiumBinResolved: string | undefined

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  get snapshot(): StackSnapshot {
    const ready = this.phase === 'ready' || this.phase === 'degraded'
    return {
      ready,
      previewMode: this.config.previewMode,
      screencast: this.config.previewMode === 'screencast' && ready,
      vnc: this.config.vnc && ready,
      phase: this.phase,
      display: this.config.xvfbDisplay,
      cdpPort: this.config.cdpPort,
      vncPort: this.config.vncPort,
      novncPort: this.config.novncPort,
      running: [...this.procs.keys()],
      missing: this.missing,
      reused: [...this.adopted],
      message: this.message,
    }
  }

  async start(): Promise<void> {
    if (this.phase === 'starting' || this.phase === 'ready') return
    this.phase = 'starting'
    this.adopted.clear()
    this.message = undefined
    try {
      const missing = await this.probeBinaries()
      this.missing = missing
      if (missing.length > 0) {
        this.phase = 'error'
        this.message =
          `缺少可执行文件：${missing.join('、')}。` +
          `Debian/Ubuntu: apt install -y xvfb chromium x11vnc novnc websockify；` +
          `TencentOS/RHEL: dnf install -y xorg-x11-server-Xvfb google-chrome-stable x11vnc novnc python3-websockify`
        this.ctx.logger.warn(`browser-preview: ${this.message}`)
        return
      }
      // Xvfb/VNC only exist for the headed (VNC) preview mode; the screencast
      // mode needs nothing but Chromium.
      if (this.config.vnc) await this.ensureXvfb()
      await this.ensureChromium()
      if (this.config.vnc) {
        await this.ensureVnc()
        await this.ensureNoVnc()
      }
      this.phase = 'ready'
      this.message = undefined
      this.ctx.logger.info(
        `browser-preview: stack ready (CDP ws://127.0.0.1:${this.config.cdpPort}, noVNC 127.0.0.1:${this.config.novncPort})`,
      )
    } catch (error) {
      this.phase = 'error'
      this.message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      await this.stop()
    }
  }

  async stop(options: { keepBrowser?: boolean } = {}): Promise<void> {
    this.stopping = true
    for (const name of [...STACK_PROC_ORDER].reverse()) {
      const proc = this.procs.get(name)
      if (proc === undefined) continue
      this.procs.delete(name)
      if (proc.reused || proc.exited) continue
      // Keep the browser on an intentional reload: its tabs (and the target
      // ids the Agent holds) would otherwise be destroyed by every restart.
      // The next start adopts it through the CDP port probe.
      if (options.keepBrowser === true && name === 'chromium') {
        this.ctx.logger.info('browser-preview: 保留正在运行的 Chromium（keepBrowser）')
        continue
      }
      await this.terminate(proc)
    }
    this.phase = 'stopped'
    this.stopping = false
    if (options.keepBrowser !== true) this.adopted.clear()
  }

  /** Binaries absent from PATH; the status endpoint reports them verbatim. */
  private async probeBinaries(): Promise<StackProcName[]> {
    const chromium = await this.resolveChromium()
    const wanted: [StackProcName, string | undefined][] = [['chromium', chromium]]
    if (this.config.vnc) {
      wanted.push(['Xvfb', this.config.xvfbBin], ['x11vnc', this.config.x11vncBin], ['websockify', this.config.websockifyBin])
    }
    const missing: StackProcName[] = []
    for (const [name, bin] of wanted) {
      if (bin === undefined || (await which(bin)) === undefined) missing.push(name)
    }
    if (missing.length === 0 && !(await this.exists(this.config.novncWebRoot))) {
      this.message = `noVNC 静态目录不存在：${this.config.novncWebRoot}（配置 novncWebRoot）`
      this.ctx.logger.warn(`browser-preview: ${this.message}`)
    }
    return missing
  }

  /**
   * Resolve the browser binary once: an explicit path from config, otherwise
   * the first candidate on PATH. `undefined` means "not installed" and is what
   * the status endpoint reports, so probing and spawning never disagree.
   */
  private async resolveChromium(): Promise<string | undefined> {
    if (this.chromiumBinResolved !== undefined) return this.chromiumBinResolved
    if (this.config.chromiumBin !== 'auto') {
      this.chromiumBinResolved = await which(this.config.chromiumBin)
      return this.chromiumBinResolved
    }
    for (const candidate of CHROMIUM_CANDIDATES) {
      const found = await which(candidate)
      if (found !== undefined) {
        this.chromiumBinResolved = found
        return found
      }
    }
    return undefined
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  private async ensureXvfb(): Promise<void> {
    const socket = `/tmp/.X11-unix/X${this.config.xvfbDisplay.replace(/^:/, '')}`
    if (await this.exists(socket)) {
      this.ctx.logger.info(`browser-preview: reusing Xvfb ${this.config.xvfbDisplay}`)
      return
    }
    const bin = this.config.xvfbBin
    await this.spawn('Xvfb', bin, [
      this.config.xvfbDisplay,
      '-screen',
      '0',
      `${this.config.screenWidth}x${this.config.screenHeight}x24`,
      '-ac',
      '-nolisten',
      'tcp',
    ])
    const deadline = Date.now() + this.config.startTimeoutMs
    while (Date.now() < deadline) {
      if (await this.exists(socket)) return
      await sleep(300)
    }
    throw new Error(`Xvfb 未能在 ${this.config.startTimeoutMs}ms 内创建 ${socket}`)
  }

  private async ensureChromium(): Promise<void> {
    if (await cdpProbe(this.config.cdpPort, 1500)) {
      this.ctx.logger.info(`browser-preview: reusing Chromium on CDP ${this.config.cdpPort}`)
      this.adopted.add('chromium')
      return
    }
    const bin = await this.resolveChromium()
    if (bin === undefined) throw new Error('未找到 Chromium/Chrome 可执行文件（请配置 chromiumBin）')
    await mkdir(this.config.userDataDir, { recursive: true })
    await this.spawn(
      'chromium',
      bin,
      [
        ...(this.config.headless ? ['--headless=new'] : []),
        `--remote-debugging-port=${this.config.cdpPort}`,
        `--user-data-dir=${this.config.userDataDir}`,
        `--window-size=${this.config.screenWidth},${this.config.screenHeight}`,
        ...this.config.chromiumArgs,
        'about:blank',
      ],
      { ...process.env, DISPLAY: this.config.xvfbDisplay },
    )
    if (this.config.headless) {
      if (!(await cdpProbe(this.config.cdpPort, this.config.startTimeoutMs))) {
        throw new Error(`Chromium 未能在 ${this.config.startTimeoutMs}ms 内开放 CDP 端口 ${this.config.cdpPort}`)
      }
      return
    }
    // Headful Chromium keeps the DevTools endpoint closed on some hosts, so
    // there is nothing to wait for — only give the window time to appear.
    await sleep(3000)
  }

  private async ensureVnc(): Promise<void> {
    if (await tcpProbe(this.config.vncPort, 500)) {
      this.ctx.logger.info(`browser-preview: reusing VNC server on ${this.config.vncPort}`)
      return
    }
    await this.spawn(
      'x11vnc',
      this.config.x11vncBin,
      ['-display', this.config.xvfbDisplay, '-forever', '-nopw', '-shared', '-rfbport', String(this.config.vncPort), '-listen', '127.0.0.1'],
      { ...process.env, DISPLAY: this.config.xvfbDisplay },
    )
    if (!(await this.waitForPort(this.config.vncPort))) {
      throw new Error(`x11vnc 未能在 ${this.config.startTimeoutMs}ms 内监听 ${this.config.vncPort}`)
    }
  }

  private async ensureNoVnc(): Promise<void> {
    if (await tcpProbe(this.config.novncPort, 500)) {
      this.ctx.logger.info(`browser-preview: reusing websockify on ${this.config.novncPort}`)
      return
    }
    await this.spawn('websockify', this.config.websockifyBin, [
      '--web',
      this.config.novncWebRoot,
      String(this.config.novncPort),
      `127.0.0.1:${this.config.vncPort}`,
    ])
    if (!(await this.waitForPort(this.config.novncPort))) {
      throw new Error(`websockify 未能在 ${this.config.startTimeoutMs}ms 内监听 ${this.config.novncPort}`)
    }
  }

  private async waitForPort(port: number): Promise<boolean> {
    const deadline = Date.now() + this.config.startTimeoutMs
    while (Date.now() < deadline) {
      if (await tcpProbe(port, 500)) return true
      await sleep(300)
    }
    return false
  }

  private async spawn(name: StackProcName, bin: string, argv: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    const child = spawn(bin, argv, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const proc: ManagedProc = { name, child, exited: false, reused: false }
    this.procs.set(name, proc)
    child.on('error', (error) => {
      proc.exited = true
      this.degrade(`${name} 启动失败：${error.message}`)
    })
    child.on('exit', (code, signal) => {
      proc.exited = true
      if (!this.stopping) this.degrade(`${name} 已退出（code=${code} signal=${signal}）`)
    })
    this.pipeLog(name, child)
    child.unref()
  }

  private pipeLog(name: StackProcName, child: ChildProcess): void {
    const forward = (stream: ChildProcess['stdout'], level: 'warn' | 'debug'): void => {
      stream?.setEncoding('utf8')
      let lines = 0
      stream?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          const text = line.trim()
          if (text.length === 0) continue
          lines += 1
          // Verbose off: only the first burst plus anything after startup.
          if (this.config.verbose || lines <= 10) this.ctx.logger[level](`browser-preview/${name}: ${text}`)
        }
      })
    }
    forward(child.stdout, 'debug')
    forward(child.stderr, 'warn')
  }

  private degrade(message: string): void {
    if (this.phase === 'stopped') return
    this.phase = 'degraded'
    this.message = message
    this.ctx.logger.warn(`browser-preview: ${message}`)
  }

  private async terminate(proc: ManagedProc): Promise<void> {
    const pid = proc.child.pid
    if (pid === undefined) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        resolve()
      }
      const signal = (name: NodeJS.Signals): void => {
        try {
          process.kill(-pid, name)
        } catch {
          try {
            proc.child.kill(name)
          } catch {
            /* already gone */
          }
        }
      }
      const killTimer = setTimeout(() => {
        signal('SIGKILL')
        finish()
      }, 3000)
      proc.child.once('exit', finish)
      signal('SIGTERM')
    })
  }
}
