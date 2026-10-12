/**
 * Browser Preview client half: a draggable floating window in `shell.overlay`
 * holding the noVNC iframe. Same-origin (`/browser-preview/...`), so no CSP
 * change is needed.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: brings ctx.uiSession / ctx.sessions onto the client context.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  CDP_PORT_PATH,
  DEPS_PATH,
  NOVNC_ENTRY_PATH,
  NO_TARGET,
  ROUTE_PREFIX,
  STATUS_PATH,
  STREAM_PATH,
  TARGET_PATH,
  VIEW_PATH,
  WS_PATH,
  type PreviewStatus,
  type StackSnapshot,
} from '../shared.ts'

export const inject = ['slots', 'sessions', 'uiSession']

/** The conversation the user is looking at, mirrored out of the client services. */
interface SessionRef {
  readonly id: string
  readonly title: string
}

let currentSession: SessionRef | null = null
const sessionListeners = new Set<() => void>()
/** id → display title, so the tab strip can name sessions it is not showing. */
const sessionTitles = new Map<string, string>()

function publishSession(next: SessionRef | null): void {
  if (currentSession?.id === next?.id && currentSession?.title === next?.title) return
  currentSession = next
  // Mirrored for troubleshooting: `window.__dshBrowserPreview.session`.
  ;(window as unknown as { __dshBrowserPreview?: { session: SessionRef | null } }).__dshBrowserPreview = {
    session: next,
  }
  for (const listener of sessionListeners) listener()
}

const subscribeSession = (listener: () => void): (() => void) => {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

const readSession = (): SessionRef | null => currentSession

/** Replaced at build time by build.mjs (esbuild define). */
declare const __DSH_BUILD_ID__: string
const BUILD_ID = typeof __DSH_BUILD_ID__ === 'string' ? __DSH_BUILD_ID__ : 'dev'

const POLL_MS = 3000
const PANEL_WIDTH = 960
const PANEL_HEIGHT = 600

const novncUrl = new URL(NOVNC_ENTRY_PATH, 'http://localhost')
novncUrl.searchParams.set('path', WS_PATH)
novncUrl.searchParams.set('autoconnect', 'true')
novncUrl.searchParams.set('resize', 'scale')
novncUrl.searchParams.set('reconnect', 'true')
novncUrl.searchParams.set('reconnect_delay', '2000')
novncUrl.searchParams.set('show_dot', 'true')
const NOVNC_SRC = `${novncUrl.pathname}${novncUrl.search}`

/** Tab chip: `active` marks the page currently being previewed. */
function chipStyle(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? '#2563eb' : 'rgba(255,255,255,0.12)'}`,
    background: active ? 'rgba(37,99,235,0.25)' : 'transparent',
    color: active ? '#dbeafe' : '#9ca3af',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    maxWidth: 160,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }
}

interface EnvItem {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly needed: boolean
  readonly detail: string
  readonly installable: boolean
}

interface DepsPayload {
  readonly platform?: string
  readonly manager?: string
  readonly root?: boolean
  readonly ready?: boolean
  readonly items?: readonly EnvItem[]
  readonly missing?: readonly string[]
}

/** Which browser to follow: scan this host, switch ports in one click. */
function CdpSection({ onChanged }: { onChanged: () => void }): React.ReactElement {
  const [data, setData] = useState<{ port?: number; discovered?: { port: number; browser: string }[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(CDP_PORT_PATH, { headers: { accept: 'application/json' } })
      if (res.ok) setData((await res.json()) as typeof data)
    } catch {
      /* offline: parent reports it */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const switchTo = useCallback(
    async (port: number) => {
      setBusy(true)
      try {
        await fetch(CDP_PORT_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port }),
        })
        await load()
        onChanged()
      } finally {
        setBusy(false)
      }
    },
    [load, onChanged],
  )

  const current = data?.port
  const discovered = data?.discovered ?? []
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ opacity: 0.75 }}>浏览器调试端口（CDP）：当前 {current ?? '—'}</div>
      {discovered.length === 0 ? (
        <div style={{ opacity: 0.6, marginTop: 4 }}>未在插件配置的端口范围内发现浏览器</div>
      ) : (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
          {discovered.map((endpoint) => (
            <button
              key={endpoint.port}
              type="button"
              style={chipStyle(endpoint.port === current)}
              disabled={busy}
              title={endpoint.browser}
              onClick={() => void switchTo(endpoint.port)}
            >
              {endpoint.port}
              {endpoint.port === current ? ' · 当前' : ''}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" style={chipStyle(false)} disabled={busy} onClick={() => void load()}>
          重新扫描
        </button>
      </div>
    </div>
  )
}

/**
 * First-entry checklist: the window shows what is installed, what is missing,
 * and installs a row on demand. Package installation is always user-triggered.
 */
function EnvPanel({ onRefresh }: { onRefresh: () => void }): React.ReactElement {
  const [env, setEnv] = useState<DepsPayload | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(DEPS_PATH, { headers: { accept: 'application/json' } })
      if (res.ok) setEnv((await res.json()) as DepsPayload)
    } catch {
      /* offline: the parent already reports it */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const install = useCallback(
    async (deps?: readonly string[]) => {
      setBusy(deps?.[0] ?? 'all')
      setNote(null)
      try {
        const res = await fetch(DEPS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(deps === undefined ? {} : { deps }),
        })
        const report = (await res.json()) as { installed?: string[]; failed?: string[]; error?: string }
        if (typeof report.error === 'string') setNote(report.error)
        else {
          const failed = report.failed?.length ? `；失败：${report.failed.join('、')}` : ''
          setNote(`已安装 ${report.installed?.join('、') || '无'}${failed}`)
        }
        await load()
      } catch {
        setNote('安装请求失败，请查看 DSH 日志')
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  const items = env?.items ?? []
  const missing = items.filter((item) => item.needed && !item.ok)
  // An empty list means the probe never answered — do not call that "complete".
  const complete = items.length > 0 && missing.length === 0
  const headline =
    env === null ? '环境检测：正在检测…' : items.length === 0 ? '环境检测：后端未响应（接口 404？）' : complete ? '环境检测：完整' : `环境检测：缺少 ${missing.length} 项`

  return (
    <div style={styles.env}>
      <div style={styles.envHead}>{headline}</div>
      {items.map((item) => (
        <div key={item.id} style={styles.envRow}>
          <span style={{ width: 14, color: item.ok ? '#34d399' : item.needed ? '#f87171' : '#6b7280' }}>
            {item.ok ? '✓' : item.needed ? '✗' : '–'}
          </span>
          <span style={{ minWidth: 170 }}>{item.label}</span>
          <span style={styles.envDetail as React.CSSProperties} title={item.detail}>
            {item.detail}
          </span>
          {!item.ok && item.installable ? (
            <button
              type="button"
              style={chipStyle(false)}
              disabled={busy !== null}
              onClick={() => void install([item.id])}
            >
              {busy === item.id ? '安装中…' : '安装'}
            </button>
          ) : null}
        </div>
      ))}
      {items.length === 0 && env !== null ? (
        <div style={{ opacity: 0.6 }}>拿不到依赖清单：host 半可能没有加载（见 README 的 404 排查）</div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button type="button" style={chipStyle(true)} disabled={busy !== null || complete} onClick={() => void install()}>
          {busy === 'all' ? '安装中…' : '一键安装缺失项'}
        </button>
        <button type="button" style={chipStyle(false)} disabled={busy !== null} onClick={() => void load()}>
          重新检测
        </button>
      </div>
      <CdpSection onChanged={onRefresh} />
      {env?.platform !== undefined ? (
        <div style={{ marginTop: 8, opacity: 0.6, fontSize: 11 }}>
          {env.platform} · {env.manager} · {env.root === true ? 'root 直接安装' : 'sudo -n 安装（需免密 sudo）'}
        </div>
      ) : null}
      {note !== null ? <div style={{ marginTop: 6 }}>{note}</div> : null}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  env: {
    flex: '1 1 auto',
    overflow: 'auto',
    padding: '10px 12px',
    background: '#151515',
    color: '#d1d5db',
    fontSize: 12,
    lineHeight: 1.7,
  },
  envHead: { fontWeight: 600, marginBottom: 6 },
  envRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '2px 0',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  envDetail: {
    flex: '1 1 auto',
    opacity: 0.6,
    fontSize: 11,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  tabs: {
    display: 'flex',
    gap: 4,
    padding: '4px 8px',
    background: '#1c1c1c',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    overflowX: 'auto',
    flex: '0 0 auto',
  },
  launcher: {
    position: 'fixed',
    right: 24,
    bottom: 24,
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.16)',
    background: '#2563eb',
    color: '#fff',
    fontSize: 18,
    lineHeight: '42px',
    textAlign: 'center',
    cursor: 'pointer',
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    pointerEvents: 'auto',
  },
  panel: {
    position: 'fixed',
    right: 24,
    bottom: 84,
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    minWidth: 420,
    minHeight: 320,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    resize: 'both',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 10,
    background: '#151515',
    boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
    pointerEvents: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: '#242424',
    color: '#e5e7eb',
    fontSize: 12,
    cursor: 'move',
    userSelect: 'none',
    flex: '0 0 auto',
  },
  iframe: { flex: '1 1 auto', width: '100%', border: 'none', background: '#000' },
  ghost: {
    flex: '1 1 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: 13,
    lineHeight: 1.7,
  },
  iconButton: {
    border: 'none',
    background: 'transparent',
    color: '#e5e7eb',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
  },
}

function stateText(snapshot: StackSnapshot | null, offline: string | null): string {
  if (offline !== null) return `🟡 ${offline}`
  if (snapshot === null) return '⏳ 检查中…'
  return snapshot.ready ? `🟢 就绪 · CDP ${snapshot.cdpPort}` : `🔴 ${snapshot.message ?? '未就绪'}`
}

/**
 * Live CDP screencast: JPEG frames arrive on `/browser-preview/stream` and
 * pointer events go back on the same socket, so the window is interactive and
 * always shows the instance the Agent drives.
 */
function ScreencastView(): React.ReactElement {
  const socketRef = useRef<WebSocket | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}${STREAM_PATH}`)
    socketRef.current = socket
    socket.binaryType = 'blob'
    socket.onopen = () => setLive(true)
    socket.onclose = () => setLive(false)
    socket.onerror = () => setLive(false)
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') return
      setFrameUrl(URL.createObjectURL(event.data as Blob))
    }
    return () => {
      socketRef.current = null
      socket.close()
    }
  }, [])

  useEffect(() => {
    if (frameUrl === null) return
    return () => URL.revokeObjectURL(frameUrl)
  }, [frameUrl])

  const send = (payload: Record<string, unknown>): void => {
    const socket = socketRef.current
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  const relative = (
    event: React.MouseEvent<HTMLImageElement> | React.WheelEvent<HTMLImageElement>,
  ): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  return (
    <div style={styles.iframe}>
      {frameUrl === null ? (
        <div style={styles.ghost}>{live ? '等待画面…' : '画面流未连接'}</div>
      ) : (
        <img
          src={frameUrl}
          alt="Agent browser"
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
          onMouseDown={(event) =>
            send({ t: 'mouse', type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...relative(event) })
          }
          onMouseUp={(event) =>
            send({ t: 'mouse', type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...relative(event) })
          }
          onMouseMove={(event) => send({ t: 'mouse', type: 'mouseMoved', buttons: event.buttons, ...relative(event) })}
          onWheel={(event) => send({ t: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY, ...relative(event) })}
        />
      )}
    </div>
  )
}

function BrowserPreviewWindow(): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<PreviewStatus | null>(null)
  const [offline, setOffline] = useState<string | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  const poll = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
      // Surface why: 404 means the host half never registered its routes
      // (plugin not active / DSH too old), 403 means a stale tab.
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? '插件后端未注册路由（HTTP 404）：确认插件已在 DSH 中激活'
            : `插件未响应（HTTP ${res.status}）`,
        )
      }
      setSnapshot((await res.json()) as PreviewStatus)
      setOffline(null)
    } catch (error) {
      setOffline(error instanceof Error ? error.message : '插件未连接')
    }
  }, [])

  useEffect(() => {
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [poll])

  /** Pin the preview to one of the pages an Agent session opened. */
  const selectTarget = useCallback(async (id: string | null) => {
    try {
      await fetch(TARGET_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
      if (res.ok) setSnapshot((await res.json()) as PreviewStatus)
    } catch {
      /* offline: the next poll picks it up */
    }
  }, [])

  /** Show the page that a given conversation opened. */
  const selectSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(TARGET_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId }),
      })
      const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
      if (res.ok) setSnapshot((await res.json()) as PreviewStatus)
    } catch {
      /* offline: the next poll picks it up */
    }
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Capturing the pointer on the header would retarget the button's
    // mousedown/mouseup away from it, so its click never fires.
    if ((event.target as HTMLElement).closest('button, a') !== null) return
    const el = panelRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  /** Keep the header's drag handler out of the buttons entirely. */
  const stopDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation()
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    setPosition({
      left: Math.max(0, Math.min(event.clientX - drag.dx, window.innerWidth - 80)),
      top: Math.max(0, Math.min(event.clientY - drag.dy, window.innerHeight - 40)),
    })
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const current = useSyncExternalStore(subscribeSession, readSession)
  const [follow, setFollow] = useState(true)

  // Switching conversations switches the preview to that conversation's page.
  useEffect(() => {
    if (!follow || current === null) return
    void selectSession(current.id)
  }, [follow, current?.id, selectSession])

  // Keep the picture aligned with the conversation being read: the session's
  // binding can change (a new `open`, or a tab closed) without the selection
  // changing, and a background session must not override it.
  useEffect(() => {
    if (!follow || current === null || snapshot === null) return
    const binding = snapshot.sessions.find((entry) => entry.sessionId === current.id)
    if (binding === undefined || snapshot.selected === binding.targetId) return
    void selectSession(current.id)
  }, [follow, current?.id, snapshot?.selected, snapshot?.sessions, selectSession])

  const ready = snapshot?.ready === true
  // Following mode with nothing but about:blank open would render a black box:
  // say so instead, it usually means the Agent is driving a different browser.
  const hasVisiblePage = (snapshot?.targets ?? []).some((target) => target.url !== 'about:blank')
  // `env` shows the dependency checklist even when everything is fine.
  const [view, setView] = useState<'preview' | 'env'>('preview')
  const showEnv = !ready || view === 'env'
  const [reloadKey, setReloadKey] = useState(0)
  // VNC mode has a real noVNC page; screencast mode gets the plugin's own viewer.
  const openHref = snapshot?.previewMode === 'vnc' ? NOVNC_SRC : VIEW_PATH

  return (
    <>
      <div
        style={styles.launcher}
        role="button"
        tabIndex={0}
        title="Agent 浏览器预览"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') setOpen((value) => !value)
        }}
      >
        🖥️
      </div>
      {open ? (
        <div
          ref={panelRef}
          style={position === null ? styles.panel : { ...styles.panel, left: position.left, top: position.top, right: 'auto', bottom: 'auto' }}
        >
          <div style={styles.header} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <span>Agent 浏览器预览</span>
            <span style={{ opacity: 0.75 }}>{stateText(snapshot, offline)}</span>
            <span style={{ fontSize: 10, opacity: 0.45 }} title="客户端构建版本">
              {BUILD_ID}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button
                type="button"
                style={styles.iconButton}
                title="重新连接"
                onPointerDown={stopDrag}
                onClick={() => setReloadKey((value) => value + 1)}
              >
                ⟳
              </button>
              <a
                href={openHref}
                target="_blank"
                rel="noreferrer"
                style={{ ...styles.iconButton, textDecoration: 'none' }}
                title="新标签打开"
                onPointerDown={stopDrag}
              >
                ↗
              </a>
              <button
                type="button"
                style={styles.iconButton}
                title="关闭"
                onPointerDown={stopDrag}
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </span>
          </div>
          <div style={styles.tabs}>
            <button
              type="button"
              style={chipStyle(follow)}
              title={follow ? '切换会话时自动显示该会话打开的页面（点击关闭）' : '手动选择要预览的会话（点击开启自动跟随）'}
              onClick={() => setFollow((value) => !value)}
            >
              跟随会话
            </button>
            {(snapshot?.sessions ?? []).map((entry) => {
              const page = snapshot?.targets.find((target) => target.id === entry.targetId)
              return (
                <button
                  key={entry.sessionId}
                  type="button"
                  style={chipStyle(snapshot?.selected === entry.targetId)}
                  title={`${sessionTitles.get(entry.sessionId) ?? entry.sessionId} — ${page?.url ?? '页面已关闭'}`}
                  onClick={() => void selectSession(entry.sessionId)}
                >
                  {sessionTitles.get(entry.sessionId) ?? entry.sessionId.slice(0, 8)}
                  {current?.id === entry.sessionId ? ' ●' : ''}
                </button>
              )
            })}
            <button
              type="button"
              style={{ ...chipStyle(view === 'env'), marginLeft: 'auto' }}
              title="依赖环境检测"
              onClick={() => setView((value) => (value === 'env' ? 'preview' : 'env'))}
            >
              {view === 'env' ? '返回预览' : '环境'}
            </button>
          </div>
          {showEnv ? (
            // First entry (and the `环境` tab): the checklist, not a bare error.
            <EnvPanel onRefresh={poll} />
          ) : snapshot?.selected === NO_TARGET ? (
            <div style={styles.ghost}>
              <div>
                <div>当前会话还没有打开页面</div>
                <div style={{ marginTop: 8, opacity: 0.7 }}>
                  让 Agent 用浏览器工具打开一个页面，画面会自动出现在这里
                </div>
              </div>
            </div>
          ) : snapshot?.selected === null && !hasVisiblePage ? (
            <div style={styles.ghost}>
              <div>
                <div>浏览器停在空白页，没有可预览的画面</div>
                <div style={{ marginTop: 8, opacity: 0.7 }}>
                  预览跟随的是本插件托管的浏览器（CDP {snapshot.cdpPort}）。
                  <br />
                  如果 Agent 用的是另一个浏览器实例（别的调试端口），画面不会出现在这里 ——
                  让它改用 <code>mcp__browser__*</code> 工具打开页面即可。
                </div>
              </div>
            </div>
          ) : snapshot?.previewMode === 'vnc' ? (
            <iframe
              key={reloadKey}
              style={styles.iframe}
              src={NOVNC_SRC}
              title="Agent browser preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            // remount on reload: the ⟳ button restarts the frame stream
            <ScreencastView key={reloadKey} />
          )}
        </div>
      ) : null}
    </>
  )
}

export function apply(ctx: ClientContext): void {
  // Mirror the selected conversation into module state. The preview window is
  // a root-scope overlay, so it cannot read the session from slot props.
  ctx.effect(() => {
    const read = (): SessionRef | null => {
      const id = ctx.uiSession.adapter.current.getSnapshot().key as string | undefined
      if (id === undefined) return null
      const rows = Object.values(ctx.sessions.list.getSnapshot().byId)
      for (const row of rows) if (row.displayTitle !== undefined) sessionTitles.set(row.id, row.displayTitle)
      const summary = rows.find((row) => row.id === id)
      return { id, title: summary?.displayTitle ?? id }
    }
    const sync = (): void => publishSession(read())
    const offCurrent = ctx.uiSession.adapter.current.subscribe(sync)
    const offList = ctx.sessions.list.subscribe(sync)
    sync()
    return () => {
      offCurrent()
      offList()
      publishSession(null)
    }
  }, 'browser-preview: current session')

  ctx.slots.inject(
    'shell.overlay',
    () =>
      ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'browser-preview',
          order: 100,
          label: () => 'Browser Preview',
        },
        BrowserPreviewWindow,
      ),
  )
}

export { ROUTE_PREFIX }
