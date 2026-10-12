/**
 * Minimal CDP client for one browser instance.
 *
 * Talks to the Chromium the browser-preview plugin owns, so the Agent's page
 * and the preview window are literally the same tab.
 */
import { get } from 'node:http'

const CALL_TIMEOUT_MS = 15_000

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
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
    // Pinned target: several Agent sessions share this browser, so tools must
    // be able to say which tab they mean instead of always using "the last one".
    this.fixed = undefined
    // Last tab this server touched. Preferring it over "the newest page" keeps
    // a session from landing on a tab another session just opened.
    this.lastUsed = undefined
    this.browserSocket = undefined
    this.browserPending = new Map()
    this.browserNextId = 1
  }

  /** Id of the page currently attached, so a caller can pin it later. */
  get currentId() {
    return this.fixed ?? undefined
  }

  /** Pin subsequent calls (and the preview) to a target id. */
  prefer(id) {
    this.fixed = id ?? undefined
    if (id !== undefined && id !== null && this.targetUrl !== undefined) {
      this.socket?.close()
      this.socket = undefined
    }
  }

  get connected() {
    return this.socket?.readyState === 1
  }

  /** Pick the pinned page when set, else the newest non-`about:blank` tab. */
  async ensure() {
    const targets = await getJson(this.port, '/json/list')
    const pages = targets.filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
    let page = this.fixed === undefined ? undefined : pages.find((t) => t.id === this.fixed)
    // The pinned tab was closed — fall back to following.
    if (this.fixed !== undefined && page === undefined) this.fixed = undefined
    page =
      page ??
      (this.lastUsed === undefined ? undefined : pages.find((t) => t.id === this.lastUsed)) ??
      [...pages].reverse().find((t) => t.url !== 'about:blank') ??
      pages[pages.length - 1]
    if (page !== undefined) this.lastUsed = page.id
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

  /**
   * Open a URL in a NEW tab. Two Agent sessions sharing one browser must not
   * navigate each other's page, so `open` never reuses an existing tab.
   */
  async openTab(url) {
    await this.ensureBrowser()
    const created = await this.browserCall('Target.createTarget', { url })
    const id = created?.targetId
    if (typeof id !== 'string') throw new Error('创建标签页失败')
    // A new tab takes a moment to show up in /json/list; without waiting, the
    // first call against it falls back to "the newest page" (wrong tab).
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const targets = await getJson(this.port, '/json/list').catch(() => [])
      if (targets.some((t) => t.id === id)) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    this.fixed = id
    this.socket?.close()
    this.socket = undefined
    return id
  }

  async ensureBrowser() {
    if (this.browserSocket?.readyState === 1) return
    const version = await getJson(this.port, '/json/version')
    const url = version?.webSocketDebuggerUrl
    if (typeof url !== 'string') throw new Error('无法获取 browser CDP 端点')
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      this.browserSocket = socket
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('browser CDP 连接失败')))
      socket.addEventListener('close', () => {
        if (this.browserSocket === socket) this.browserSocket = undefined
      })
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        if (typeof message.id !== 'number') return
        const entry = this.browserPending.get(message.id)
        if (entry === undefined) return
        this.browserPending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(String(message.error.message ?? 'cdp error')))
        else entry.resolve(message.result)
      })
    })
  }

  browserCall(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.browserNextId++
      const timer = setTimeout(() => {
        this.browserPending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      this.browserPending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.browserSocket?.send(JSON.stringify({ id, method, params }))
    })
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
