/**
 * Dependency detection and (opt-in) installation.
 *
 * Installing OS packages is a privileged, network-dependent, distro-specific
 * operation, so nothing here runs unless the user asks for it: either
 * `autoInstall: 'on-start'` or the `/browser-preview/api/deps` endpoint.
 * Commands are fixed argv arrays (no shell), packages come from a whitelist,
 * and every attempt is logged.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DepReport {
  readonly platform: string
  readonly manager: string
  readonly root: boolean
  readonly installed: readonly string[]
  readonly failed: readonly string[]
  readonly log: readonly string[]
}

/** Which plugin stage each dependency serves; only needed ones get installed. */
export type DepName = 'chromium' | 'fonts' | 'Xvfb' | 'x11vnc' | 'novnc' | 'websockify'

type Manager = 'dnf' | 'apt'

interface Platform {
  readonly id: string
  readonly manager: Manager
  /** Candidate packages in order; the first that installs wins. */
  readonly packages: Record<DepName, readonly string[]>
}

const PLATFORMS: readonly Platform[] = [
  {
    id: 'tencentos/rhel/fedora',
    manager: 'dnf',
    packages: {
      // No chromium in TencentOS repos: fall back to Google's RPM.
      chromium: ['chromium', 'https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm'],
      fonts: ['google-noto-sans-cjk-ttc-fonts'],
      Xvfb: ['xorg-x11-server-Xvfb'],
      x11vnc: ['x11vnc'],
      novnc: ['novnc'],
      websockify: ['python3-websockify', 'websockify'],
    },
  },
  {
    id: 'debian/ubuntu',
    manager: 'apt',
    packages: {
      chromium: ['chromium', 'chromium-browser'],
      fonts: ['fonts-noto-cjk'],
      Xvfb: ['xvfb'],
      x11vnc: ['x11vnc'],
      novnc: ['novnc'],
      websockify: ['websockify'],
    },
  },
]

function detectPlatform(): Platform {
  let id = ''
  try {
    const osRelease = readFileSync('/etc/os-release', 'utf8')
    id = [...osRelease.matchAll(/^ID(?:_LIKE)?=(.+)$/gm)].map((match) => match[1].replace(/"/g, '')).join(' ')
  } catch {
    /* unknown */
  }
  const debian = /debian|ubuntu/.test(id)
  return PLATFORMS[debian ? 1 : 0]
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

async function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  })
  return `${stdout}${stderr}`.trim()
}

/** Install one dependency, trying each candidate package in turn. */
async function installDep(
  dep: DepName,
  platform: Platform,
  timeoutMs: number,
  log: string[],
): Promise<boolean> {
  const candidates = platform.packages[dep] ?? []
  for (const pkg of candidates) {
    const base = platform.manager === 'dnf' ? ['dnf', 'install', '-y'] : ['apt-get', 'install', '-y']
    const argv = [...base, pkg]
    const command = isRoot() ? argv[0] : 'sudo'
    const args = isRoot() ? argv.slice(1) : ['-n', ...argv]
    try {
      log.push(`$ ${isRoot() ? '' : 'sudo -n '}${argv.join(' ')}`)
      await run(command, args, timeoutMs)
      log.push(`已安装 ${dep} ← ${pkg}`)
      return true
    } catch (error) {
      log.push(`失败 ${dep} ← ${pkg}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  return false
}

/**
 * Install the given dependencies. Fonts get `fc-cache -f` afterwards because
 * Chromium reads the font table once at startup.
 */
export async function installDeps(deps: readonly DepName[], timeoutMs = 600_000): Promise<DepReport> {
  const platform = detectPlatform()
  const log: string[] = []
  const installed: string[] = []
  const failed: string[] = []

  for (const dep of deps) {
    if (await installDep(dep, platform, timeoutMs, log)) installed.push(dep)
    else failed.push(dep)
  }

  if (installed.includes('fonts')) {
    try {
      await run('fc-cache', ['-f'], 30_000)
      log.push('已刷新字体缓存')
    } catch (error) {
      log.push(`字体缓存刷新失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { platform: platform.id, manager: platform.manager, root: isRoot(), installed, failed, log }
}

/**
 * Whether any CJK glyph is available. When `fc-list` itself is missing the
 * check is inconclusive — assume fonts exist rather than install blindly.
 */
export async function hasCjkFont(): Promise<boolean> {
  try {
    const out = await run('fc-list', [':lang=zh'], 10_000)
    return out.trim().length > 0
  } catch {
    return true
  }
}

export function platformInfo(): { platform: string; manager: string; root: boolean } {
  const platform = detectPlatform()
  return { platform: platform.id, manager: platform.manager, root: isRoot() }
}
