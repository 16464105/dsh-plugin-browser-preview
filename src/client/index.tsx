/**
 * Browser Preview client half: a draggable floating window in `shell.overlay`
 * holding the noVNC iframe. Same-origin (`/browser-preview/...`), so no CSP
 * change is needed.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  NOVNC_ENTRY_PATH,
  ROUTE_PREFIX,
  STATUS_PATH,
  STREAM_PATH,
  TARGET_PATH,
  VIEW_PATH,
  WS_PATH,
  type PreviewStatus,
  type StackSnapshot,
  type TargetSummary,
} from '../shared.ts'

export const inject = ['slots']

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

function labelOf(target: TargetSummary): string {
  const text = (target.title || target.url).trim()
  if (text.length === 0) return '(空白页)'
  return text.length > 20 ? `${text.slice(0, 20)}…` : text
}

const styles: Record<string, React.CSSProperties> = {
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

function stateText(snapshot: StackSnapshot | null, offline: boolean): string {
  if (offline) return '🟡 插件未连接'
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
  const [offline, setOffline] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = (await res.json()) as PreviewStatus
        if (cancelled) return
        setSnapshot(data)
        setOffline(false)
      } catch {
        if (!cancelled) setOffline(true)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

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

  const ready = snapshot?.ready === true
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
              style={chipStyle((snapshot?.selected ?? null) === null)}
              title="跟随最新打开的页面"
              onClick={() => void selectTarget(null)}
            >
              自动跟随
            </button>
            {(snapshot?.targets ?? []).map((target) => (
              <button
                key={target.id}
                type="button"
                style={chipStyle(snapshot?.selected === target.id)}
                title={target.url}
                onClick={() => void selectTarget(target.id)}
              >
                {labelOf(target)}
              </button>
            ))}
          </div>
          {!ready ? (
            <div style={styles.ghost}>
              <div>
                <div>{stateText(snapshot, offline)}</div>
                {snapshot !== null && snapshot.missing.length > 0 ? (
                  <div style={{ marginTop: 8 }}>
                    缺少：{snapshot.missing.join('、')}
                    <br />
                    <code>apt install -y xvfb chromium x11vnc novnc websockify</code>
                  </div>
                ) : null}
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
