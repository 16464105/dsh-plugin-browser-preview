import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { NOVNC_UPSTREAM_WS_PATH } from './shared.ts'

/** Headers that must not survive a hop (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
])

function forwardHeaders(headers: IncomingMessage['headers'], port: number): Record<string, string> {
  const out: Record<string, string> = { host: `127.0.0.1:${port}` }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    // The Web server already negotiated gzip with the browser; asking the
    // upstream for encoding too would double-compress.
    if (HOP_BY_HOP.has(lower) || lower === 'accept-encoding' || lower === 'content-length') continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

/**
 * Plain-HTTP leg: noVNC static assets (vnc.html, app/*.js, core/*.js).
 * The caller owns the response lifecycle — errors answer 502 here.
 */
export async function proxyHttpRequest(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  const target = req.url ?? '/'
  await new Promise<void>((resolve) => {
    const upstream = httpRequest(
      { host: '127.0.0.1', port, path: target, method: req.method, headers: forwardHeaders(req.headers, port) },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
        upstreamRes.on('end', resolve)
        upstreamRes.on('error', resolve)
      },
    )
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy()
        resolve()
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`browser-preview: noVNC upstream 127.0.0.1:${port} unreachable`)
      resolve()
    })
    req.pipe(upstream)
    req.on('error', () => {
      upstream.destroy()
      resolve()
    })
  })
}

/**
 * WebSocket leg: bridge `/browser-preview/ws` onto websockify.
 *
 * The Web server matches upgrade routes by exact path, so the client pins the
 * noVNC `path` query to that single path instead of relying on a prefix.
 */
export function proxyWebSocket(req: IncomingMessage, socket: Socket, head: Buffer, port: number): void {
  const upstream = connect(port, '127.0.0.1')
  const teardown = (): void => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', teardown)
  socket.on('error', teardown)
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())

  upstream.on('connect', () => {
    const lines: string[] = [`GET ${NOVNC_UPSTREAM_WS_PATH} HTTP/1.1`]
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue
      lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    }
    lines.push(`Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket')
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
}
