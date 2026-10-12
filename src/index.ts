/**
 * Browser Preview host half.
 *
 * Runs the Xvfb + Chromium + x11vnc + noVNC chain and serves it from the DSH
 * Web origin: `/browser-preview/*` proxies websockify (same origin, so the
 * iframe needs no CSP relaxation) and `/browser-preview/ws` bridges the VNC
 * WebSocket. The Agent drives the very same Chromium over CDP.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Event + payload types for ctx.on('tools/result', …).
import type {} from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  NOVNC_UPSTREAM_WS_PATH,
  ROUTE_PREFIX,
  STATUS_PATH,
  STREAM_PATH,
  TARGET_PATH,
  VIEW_PATH,
  WS_PATH,
} from './shared.ts'
import { Config } from './config.ts'
import { BrowserStack } from './stack.ts'
import { ScreencastBridge } from './cdp.ts'
import { proxyHttpRequest, proxyWebSocket } from './proxy.ts'
import { acceptWebSocket, readTextFrames, sendBinary } from './ws.ts'

export const name = 'browser-preview'

export { Config }

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}

async function readJsonBody(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) return null
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Public tool name of the MCP `open` tool: `mcp__<server>__<rawName>`. */
const OPEN_TOOL = 'mcp__browser__open'

/**
 * The MCP bridge answers with `{ value: { content: [ … ] } }` where the first
 * text block is our JSON; pull `targetId` out so a session can be bound to the
 * tab it opened.
 */
function targetIdFromResult(result: unknown): string | undefined {
  const blocks = (result as { value?: { content?: unknown } } | undefined)?.value?.content
  if (!Array.isArray(blocks)) return undefined
  for (const block of blocks) {
    const text = (block as { type?: string; text?: unknown } | null)?.text
    if (typeof text !== 'string') continue
    try {
      const parsed = JSON.parse(text) as { targetId?: unknown }
      if (typeof parsed.targetId === 'string') return parsed.targetId
    } catch {
      /* not JSON: ignore */
    }
  }
  return undefined
}

/**
 * Standalone full-screen viewer: the same frame stream without the DSH chrome.
 * This is what the ↗ button opens in screencast mode (VNC mode opens noVNC).
 */
function renderViewerHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Agent 浏览器预览</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden }
  img { width: 100%; height: 100%; object-fit: contain; display: block }
  #status { position: fixed; left: 10px; top: 10px; padding: 2px 8px; border-radius: 4px;
            background: rgba(0,0,0,.55); color: #9ca3af; font: 12px/1.6 system-ui, sans-serif }
</style>
<img id="view" alt="browser">
<div id="status">连接中…</div>
<script>
  var img = document.getElementById('view')
  // named statusEl on purpose: window.status is a built-in string property,
  // so a global var named status would never reach the element
  var statusEl = document.getElementById('status')
  var socket = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + ${JSON.stringify(STREAM_PATH)})
  socket.binaryType = 'blob'
  socket.onopen = function () { statusEl.textContent = '已连接' }
  socket.onclose = function () { statusEl.textContent = '已断开' }
  socket.onmessage = function (event) {
    if (typeof event.data === 'string') return
    statusEl.textContent = '已连接'
    var previous = img.dataset.url
    img.src = URL.createObjectURL(event.data)
    img.dataset.url = img.src
    if (previous) URL.revokeObjectURL(previous)
  }
  var send = function (payload) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)) }
  var rel = function (event) {
    var rect = img.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }
  img.onmousedown = function (e) { send({ t: 'mouse', type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...rel(e) }) }
  img.onmouseup = function (e) { send({ t: 'mouse', type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...rel(e) }) }
  img.onmousemove = function (e) { send({ t: 'mouse', type: 'mouseMoved', buttons: e.buttons, ...rel(e) }) }
  img.onwheel = function (e) { send({ t: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...rel(e) }) }
</script>`
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('browser-preview')
  const stack = new BrowserStack(ctx, config)
  const viewers = new Set<Duplex>()
  /** session id → the tab that session opened. */
  const sessionTargets = new Map<string, string>()

  // Screencast fans one Chromium out to every open preview window; VNC mode
  // leaves the bridge uncreated and serves noVNC instead.
  const bridge =
    config.previewMode === 'screencast'
      ? new ScreencastBridge(ctx, config.cdpPort, config.screencastFps, config.screencastQuality, (frame) => {
          for (const viewer of viewers) {
            try {
              sendBinary(viewer, frame)
            } catch {
              viewers.delete(viewer)
            }
          }
        })
      : undefined

  ctx.effect(() => async () => {
    bridge?.stop()
    for (const viewer of viewers) viewer.destroy()
    viewers.clear()
    await stack.stop()
  }, 'browser-preview: stack')

  // Bind every session to the tab its Agent opened. The tool result carries the
  // target id and exec.agent carries the session, so the preview can follow the
  // selected conversation instead of guessing "the newest page".
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== OPEN_TOOL) return
    const sessionId = exec.agent?.session?.id
    const targetId = targetIdFromResult(result)
    if (typeof sessionId !== 'string' || targetId === undefined) return
    sessionTargets.set(sessionId, targetId)
    // A freshly opened page is what the user wants to see right now.
    bridge?.select(targetId)
  })

  // webServer is optional so a headless profile still loads the plugin (CDP
  // stays useful without a Web carrier); only the routes depend on it.
  ctx.effect(
    () =>
      ctx.inject(['webServer'], (web) => {
        web.effect(
          () =>
            web.webServer.register({
              kind: 'exact',
              path: STATUS_PATH,
              handler: async (_req: IncomingMessage, res: ServerResponse) => {
                // Drop bindings whose tab has been closed.
                const live = new Set((bridge?.targets ?? []).map((target) => target.id))
                for (const [sessionId, targetId] of sessionTargets) {
                  if (!live.has(targetId)) sessionTargets.delete(sessionId)
                }
                sendJson(res, 200, {
                  ...stack.snapshot,
                  targets: bridge?.targets ?? [],
                  sessions: [...sessionTargets].map(([sessionId, targetId]) => ({ sessionId, targetId })),
                  selected: (bridge?.diagnostics?.selected as string | null) ?? null,
                  viewers: viewers.size,
                  stream: bridge?.diagnostics ?? null,
                })
              },
            }),
          `browser-preview: GET ${STATUS_PATH}`,
        )

        web.effect(
          () =>
            web.webServer.register({
              kind: 'exact',
              path: TARGET_PATH,
              handler: async (req: IncomingMessage, res: ServerResponse) => {
                if (req.method === 'GET') {
                  sendJson(res, 200, {
                    targets: bridge?.targets ?? [],
                    sessions: [...sessionTargets].map(([sessionId, targetId]) => ({ sessionId, targetId })),
                    selected: (bridge?.diagnostics?.selected as string | null) ?? null,
                  })
                  return
                }
                if (req.method !== 'POST') {
                  sendJson(res, 405, { error: 'POST { id } expected' })
                  return
                }
                const body = await readJsonBody(req)
                // `session` selects the tab that session opened — this is what
                // the client sends when the user switches conversations.
                if (typeof body?.session === 'string') {
                  const id = sessionTargets.get(body.session) ?? null
                  bridge?.select(id)
                  sendJson(res, 200, { session: body.session, selected: id })
                  return
                }
                const id = typeof body?.id === 'string' ? body.id : null
                bridge?.select(id)
                sendJson(res, 200, { selected: id })
              },
            }),
          `browser-preview: ${TARGET_PATH}`,
        )

        web.effect(
          () =>
            web.webServer.register({
              kind: 'exact',
              path: VIEW_PATH,
              handler: async (_req: IncomingMessage, res: ServerResponse) => {
                if (config.previewMode === 'vnc') {
                  res.writeHead(302, {
                    location: `${ROUTE_PREFIX}/vnc.html?path=${encodeURIComponent(WS_PATH)}&autoconnect=true&resize=scale`,
                  })
                  res.end()
                  return
                }
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
                res.end(renderViewerHtml())
              },
            }),
          `browser-preview: GET ${VIEW_PATH}`,
        )

        web.effect(
          () =>
            web.webServer.register({
              kind: 'prefix',
              path: ROUTE_PREFIX,
              handler: async (req: IncomingMessage, res: ServerResponse) => {
                const snapshot = stack.snapshot
                // The noVNC leg only makes sense in VNC mode.
                if (config.previewMode !== 'vnc') {
                  sendJson(res, 404, { error: 'vnc preview disabled; use /browser-preview/stream' })
                  return
                }
                if (!snapshot.ready) {
                  const hint = snapshot.message ?? '浏览器栈尚未就绪'
                  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
                  res.end(
                    `<!doctype html><meta charset="utf-8"><title>Browser Preview</title>` +
                      `<div style="font:14px/1.6 system-ui;padding:24px;color:#ddd;background:#151515;min-height:100vh">` +
                      `<h2 style="margin:0 0 8px">浏览器预览未就绪</h2>` +
                      `<p style="color:#f87171">${escapeHtml(hint)}</p>` +
                      `<pre style="white-space:pre-wrap;color:#9ca3af">apt install -y xvfb chromium x11vnc novnc websockify</pre>` +
                      `</div>`,
                  )
                  return
                }
                await proxyHttpRequest(req, res, config.novncPort)
              },
            }),
          `browser-preview: ${ROUTE_PREFIX}/*`,
        )

        web.effect(
          () =>
            web.webServer.registerUpgrade({
              path: WS_PATH,
              handler: (req: IncomingMessage, socket, head) => {
                proxyWebSocket(req, socket, head, config.novncPort)
              },
            }),
          `browser-preview: ${WS_PATH} (websocket)`,
        )

        web.effect(
          () =>
            web.webServer.registerUpgrade({
              path: STREAM_PATH,
              handler: (req: IncomingMessage, socket, head) => {
                if (!acceptWebSocket(req, socket)) return
                viewers.add(socket)
                // Paint immediately instead of waiting for the page to change.
                const latest = bridge?.currentFrame
                if (latest !== undefined) sendBinary(socket, latest)
                socket.on('close', () => viewers.delete(socket))
                socket.on('error', () => viewers.delete(socket))
                readTextFrames(socket, (text) => {
                  try {
                    bridge?.dispatch(JSON.parse(text) as Record<string, unknown>)
                  } catch {
                    /* malformed input frame: drop */
                  }
                })
                if (head.length > 0) socket.emit('data', head)
              },
            }),
          `browser-preview: ${STREAM_PATH} (screencast)`,
        )
      }).dispose,
    'browser-preview: webServer routes',
  )

  if (config.autoStart) {
    void stack
      .start()
      .then(() => bridge?.start())
      .catch((error: unknown) => {
        logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
  }

  ctx.logger.info(`browser-preview: routes mounted at ${ROUTE_PREFIX} (ws ${WS_PATH} → ${NOVNC_UPSTREAM_WS_PATH})`)
}
