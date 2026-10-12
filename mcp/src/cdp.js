/**
 * Minimal CDP client for one browser instance.
 *
 * Talks to the Chromium the browser-preview plugin owns, so the Agent's page
 * and the preview window are literally the same tab.
 */
import { get } from 'node:http'

const CALL_TIMEOUT_MS = 15_000

function listTargets(port) {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: '/json/list', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    req.setTimeout(3000, () => req.destroy(new Error('json/list timeout')))
    req.on('error', reject)
  })
}

export class Cdp {
  constructor(port = 9222) {
    this.port = port
    this.socket = undefined
    this.targetUrl = undefined
    this.nextId = 1
    this.pending = new Map()
  }

  get connected() {
    return this.socket?.readyState === 1
  }

  /** Pick the same page the preview shows: newest non-`about:blank` tab. */
  async ensure() {
    const targets = await listTargets(this.port)
    const pages = targets.filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
    const page = [...pages].reverse().find((t) => t.url !== 'about:blank') ?? pages[pages.length - 1]
    if (page === undefined) throw new Error('浏览器里没有可用页面（CDP 端口未开放？）')
    if (page.webSocketDebuggerUrl === this.targetUrl && this.connected) return
    this.targetUrl = page.webSocketDebuggerUrl
    this.socket?.close()
    await this.attach(page.webSocketDebuggerUrl)
  }

  async attach(url) {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      this.socket = socket
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        if (typeof message.id !== 'number') return
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(String(message.error.message ?? 'cdp error')))
        else entry.resolve(message.result)
      })
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = undefined
      })
    })
  }

  async call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    await this.ensure()
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
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

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result?.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 抛异常')
    }
    return result?.result?.value
  }

  /** Bounding box of a selector in CSS pixels, or null when not found. */
  async boxOf(selector) {
    return this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`,
    )
  }
}
