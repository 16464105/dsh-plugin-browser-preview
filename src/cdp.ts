/**
 * Minimal CDP client: pictures and input for the browser the Agent drives.
 *
 * Frames come from `Page.captureScreenshot` on a timer rather than
 * `Page.startScreencast`. Screencast depends on the compositor pushing
 * `Page.screencastFrame`, which stays silent on headless builds that park the
 * renderer (observed on Chrome 155/156 here — one frame, then nothing); a
 * capture always forces a fresh frame. Identical frames are dropped, so a
 * quiet page costs nothing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { get } from 'node:http'
import type { TargetSummary } from './shared.ts'

interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: any) => void): void
}

type SocketFactory = new (url: string) => SocketLike

const WebSocketCtor = (globalThis as { WebSocket?: SocketFactory }).WebSocket

export interface FrameSink {
  (frame: Buffer): void
}

/** A `/json/list` row — only the fields this client reads. */
interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly title?: string
  readonly webSocketDebuggerUrl?: string
}

/** Re-exported so the host half and this client agree on the tab shape. */
export type { TargetSummary } from './shared.ts'

interface Pending {
  resolve(value: any): void
  reject(error: Error): void
}

const RETARGET_MS = 4000
const CALL_TIMEOUT_MS = 5000

export class ScreencastBridge {
  private socket: SocketLike | undefined
  private targetUrl: string | undefined
  private nextId = 1
  private viewport = { width: 1280, height: 800 }
  private readonly pending = new Map<number, Pending>()
  private retargetTimer: NodeJS.Timeout | undefined
  private captureTimer: NodeJS.Timeout | undefined
  private lastFrame: Buffer | undefined
  private frames = 0
  private captured = 0
  private lastError: string | undefined
  private timeouts = 0
  private closed = false
  /** Pinned target id; `undefined` means "follow the newest page". */
  private selected: string | undefined
  private lastTargets: TargetSummary[] = []

  constructor(
    private readonly ctx: Context,
    private readonly port: number,
    private readonly fps: number,
    private readonly quality: number,
    private readonly onFrame: FrameSink,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === 1
  }

  /** Latest pushed frame, replayed to a viewer that just connected. */
  get currentFrame(): Buffer | undefined {
    return this.lastFrame
  }

  /** Surfaced on the status endpoint — the only way to see inside the bridge. */
  get diagnostics(): Record<string, unknown> {
    return {
      started: this.captureTimer !== undefined,
      connected: this.connected,
      fps: this.fps,
      frames: this.frames,
      captured: this.captured,
      target: this.targetUrl ?? null,
      selected: this.selected ?? null,
      lastError: this.lastError ?? null,
    }
  }

  /** Every page open in the shared browser, for the preview tab strip. */
  get targets(): readonly TargetSummary[] {
    return this.lastTargets
  }

  /**
   * Pin the preview to one page. Several Agent sessions share this browser,
   * so "follow the newest" alone makes the window jump between them.
   * `null` resumes following.
   */
  select(id: string | null): void {
    this.selected = id ?? undefined
    this.socket?.close()
    this.socket = undefined
    if (!this.closed) void this.retarget()
  }

  async start(): Promise<void> {
    if (WebSocketCtor === undefined) {
      this.lastError = '当前 Node 版本缺少全局 WebSocket'
      this.ctx.logger.warn(`browser-preview: ${this.lastError}`)
      return
    }
    this.retargetTimer = setInterval(() => void this.retarget(), RETARGET_MS)
    this.captureTimer = setInterval(() => void this.capture(), Math.max(120, Math.round(1000 / this.fps)))
    await this.retarget()
  }

  stop(): void {
    this.closed = true
    if (this.retargetTimer !== undefined) clearInterval(this.retargetTimer)
    if (this.captureTimer !== undefined) clearInterval(this.captureTimer)
    this.retargetTimer = undefined
    this.captureTimer = undefined
    this.socket?.close()
    this.socket = undefined
  }

  /** Follow the newest page target so an Agent opening a tab is what shows. */
  private async retarget(): Promise<void> {
    if (this.closed) return
    let targets: CdpTarget[]
    try {
      targets = await listTargets(this.port)
    } catch (error) {
      this.lastError = `json/list: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    this.lastTargets = targets
      .filter((target) => target.type === 'page')
      .map((target) => ({ id: target.id, url: target.url, title: target.title ?? target.url }))
    const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl !== undefined)
    const pinned = this.selected === undefined ? undefined : pages.find((target) => target.id === this.selected)
    // The pinned tab was closed — fall back to following.
    if (this.selected !== undefined && pinned === undefined) this.selected = undefined
    // `/json/list` order is not a creation order, so prefer the newest page
    // that is not the startup `about:blank` — that is the tab an Agent opened.
    const page = pinned ?? [...pages].reverse().find((target) => target.url !== 'about:blank') ?? pages[pages.length - 1]
    if (page?.webSocketDebuggerUrl === undefined) return
    if (page.webSocketDebuggerUrl === this.targetUrl && this.connected) return
    this.targetUrl = page.webSocketDebuggerUrl
    this.socket?.close()
    this.attach(page.webSocketDebuggerUrl)
  }

  private attach(url: string): void {
    const socket = new (WebSocketCtor as SocketFactory)(url)
    this.socket = socket
    socket.addEventListener('open', () => {
      void this.measure()
    })
    socket.addEventListener('message', (event: any) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(String(message.error.message ?? 'cdp error')))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = undefined
    })
    socket.addEventListener('error', () => {
      this.lastError = 'cdp websocket error'
      socket.close()
    })
  }

  /** Viewport size in CSS pixels, used to scale pointer input back. */
  private async measure(): Promise<void> {
    try {
      const metrics = await this.call('Page.getLayoutMetrics')
      const width = metrics?.cssVisualViewport?.width ?? metrics?.contentSize?.width
      const height = metrics?.cssVisualViewport?.height ?? metrics?.contentSize?.height
      if (typeof width === 'number' && typeof height === 'number') this.viewport = { width, height }
      this.lastError = undefined
    } catch (error) {
      this.lastError = `getLayoutMetrics: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async capture(): Promise<void> {
    if (!this.connected) return
    try {
      const result = await this.call('Page.captureScreenshot', { format: 'jpeg', quality: this.quality })
      const data = result?.data
      if (typeof data !== 'string') return
      this.captured += 1
      const frame = Buffer.from(data, 'base64')
      if (this.lastFrame !== undefined && this.lastFrame.equals(frame)) return
      this.lastFrame = frame
      this.frames += 1
      this.onFrame(frame)
      this.lastError = undefined
      this.timeouts = 0
    } catch (error) {
      this.lastError = `captureScreenshot: ${error instanceof Error ? error.message : String(error)}`
      // A stuck renderer never answers again; drop the session so the next
      // retarget picks a healthy page instead of wedging the stream.
      this.timeouts += 1
      if (this.timeouts >= 3) {
        this.timeouts = 0
        this.socket?.close()
        this.socket = undefined
      }
    }
  }

  /** Pointer/key input from the preview window, in 0..1 image space. */
  dispatch(payload: Record<string, unknown>): void {
    if (!this.connected) return
    const scaleX = this.viewport.width
    const scaleY = this.viewport.height
    switch (payload.t) {
      case 'mouse': {
        const x = Math.round(Number(payload.x ?? 0) * scaleX)
        const y = Math.round(Number(payload.y ?? 0) * scaleY)
        void this.call('Input.dispatchMouseEvent', {
          type: String(payload.type ?? 'mouseMoved'),
          x,
          y,
          button: payload.button === undefined ? 'none' : String(payload.button),
          clickCount: Number(payload.clickCount ?? 1),
          buttons: Number(payload.buttons ?? 0),
        }).catch(() => undefined)
        return
      }
      case 'wheel': {
        void this.call('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(Number(payload.x ?? 0) * scaleX),
          y: Math.round(Number(payload.y ?? 0) * scaleY),
          deltaX: Number(payload.deltaX ?? 0),
          deltaY: Number(payload.deltaY ?? 0),
        }).catch(() => undefined)
        return
      }
      case 'text': {
        void this.call('Input.insertText', { text: String(payload.text ?? '') }).catch(() => undefined)
        return
      }
      case 'key': {
        const key = String(payload.key ?? '')
        void this.call('Input.dispatchKeyEvent', {
          type: String(payload.type ?? 'keyDown'),
          key,
          code: String(payload.code ?? key),
          windowsVirtualKeyCode: Number(payload.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 13)),
        }).catch(() => undefined)
        return
      }
      default:
        return
    }
  }

  private call(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('cdp not connected'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timeout`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket?.send(JSON.stringify({ id, method, params }))
    })
  }
}

/**
 * Read the DevTools HTTP endpoint with `node:http`, not `fetch`: the host may
 * install a global undici dispatcher (outbound proxy support) that would
 * swallow loopback requests.
 */
function listTargets(port: number): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: '/json/list', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as CdpTarget[])
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    req.setTimeout(3000, () => req.destroy(new Error('json/list timeout')))
    req.on('error', reject)
  })
}
