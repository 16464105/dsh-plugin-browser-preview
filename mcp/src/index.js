#!/usr/bin/env node
/**
 * MCP server: the shared DSH browser as Agent tools.
 *
 * stdio JSON-RPC, zero dependencies, no network listener. Every tool drives
 * the same Chromium the browser-preview plugin shows in its floating window
 * (CDP on 127.0.0.1:9222), so "Agent opens a page" and "preview shows a page"
 * are one tab.
 *
 * Multiple Agent sessions share this single browser, so:
 *   - `open` creates a NEW tab and returns its `targetId`
 *   - every other tool accepts an optional `targetId` to say which tab it means
 *   - without one, the tool acts on the most recently used tab
 *
 * Logs go to stderr on purpose: stdout is the protocol channel.
 */
import { Cdp } from './cdp.js'
import { startStdioServer } from './protocol.js'

const port = Number(process.env.DSH_BROWSER_CDP_PORT ?? 9222)
const cdp = new Cdp(port)

const ok = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

const fail = (message) => ({
  content: [{ type: 'text', text: `浏览器操作失败：${message}` }],
  isError: true,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Optional per-call target pinning. */
const pin = (targetId) => {
  if (typeof targetId === 'string' && targetId.length > 0) cdp.prefer(targetId)
}

const requireString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`缺少参数：${field}`)
  return value
}

const targetProperty = {
  type: 'string',
  description: '要操作的标签页 id（open 的返回值）。多个会话并行时请带上，否则可能落到别的会话刚打开的页面上',
}

/**
 * `expectNavigation` matters after creating a tab: a brand-new tab is already
 * "complete" at about:blank, so a plain readyState check returns too early.
 */
async function waitReady(timeoutMs = 20_000, expectNavigation = false) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await cdp.evaluate('[location.href, document.readyState]').catch(() => undefined)
    const [href, ready] = Array.isArray(state) ? state : []
    const navigated = !expectNavigation || (typeof href === 'string' && href !== 'about:blank')
    if (navigated && ready === 'complete') return true
    await sleep(300)
  }
  return false
}

const TOOLS = [
  {
    name: 'status',
    description: '当前预览页面的 URL、标题、标签 id 与 CDP 端口',
    inputSchema: { type: 'object', properties: { targetId: { ...targetProperty } } },
  },
  {
    name: 'open',
    description: '新开一个标签页打开 URL（不复用现有页面，多个会话互不干扰）；返回 targetId，后续调用请带上它以免串台',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的 http(s) 地址' }, targetId: { ...targetProperty } },
      required: ['url'],
    },
  },
  {
    name: 'screenshot',
    description: '截取指定（或最近使用的）标签页画面，返回 JPEG 图片',
    inputSchema: { type: 'object', properties: { targetId: { ...targetProperty } } },
  },
  {
    name: 'text',
    description: '读取指定（或最近使用的）标签页的正文文本',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200000, description: '最大字符数，默认 8000' },
        targetId: { ...targetProperty },
      },
    },
  },
  {
    name: 'click',
    description: '点击页面元素：给出 CSS 选择器，或页面坐标 x/y',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，优先使用' },
        x: { type: 'number', description: '页面坐标 X（不使用选择器时）' },
        y: { type: 'number', description: '页面坐标 Y（不使用选择器时）' },
        targetId: { ...targetProperty },
      },
    },
  },
  {
    name: 'type',
    description: '向页面输入文本；可选先聚焦某个输入框，可选回车提交',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        selector: { type: 'string', description: '先聚焦的 CSS 选择器' },
        pressEnter: { type: 'boolean', description: '输入后按回车' },
        targetId: { ...targetProperty },
      },
      required: ['text'],
    },
  },
  {
    name: 'scroll',
    description: '页面滚动（正数向下，负数向上）',
    inputSchema: {
      type: 'object',
      properties: { dy: { type: 'number', description: '滚动像素' }, targetId: { ...targetProperty } },
      required: ['dy'],
    },
  },
  {
    name: 'back',
    description: '后退到上一个页面',
    inputSchema: { type: 'object', properties: { targetId: { ...targetProperty } } },
  },
  {
    name: 'eval',
    description: '在页面里执行 JavaScript 并返回结果（调试用）',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JS 表达式' },
        targetId: { ...targetProperty },
      },
      required: ['expression'],
    },
  },
]

async function callTool(name, args) {
  switch (name) {
    case 'status': {
      pin(args.targetId)
      return ok({
        targetId: cdp.currentId ?? null,
        url: await cdp.evaluate('location.href'),
        title: await cdp.evaluate('document.title'),
        cdpPort: port,
      })
    }
    case 'open': {
      const url = requireString(args.url, 'url')
      let id = typeof args.targetId === 'string' && args.targetId.length > 0 ? args.targetId : undefined
      if (id !== undefined) {
        // Explicit tab: navigate it instead of opening another.
        pin(id)
        await cdp.call('Page.enable')
        await cdp.call('Page.navigate', { url })
      } else {
        id = await cdp.openTab(url)
        pin(id)
        await cdp.call('Page.enable')
      }
      return ok({
        targetId: id,
        ready: await waitReady(20_000, true),
        url: await cdp.evaluate('location.href'),
        title: await cdp.evaluate('document.title'),
      })
    }
    case 'screenshot': {
      pin(args.targetId)
      const shot = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
      const title = await cdp.evaluate('document.title').catch(() => '')
      const url = await cdp.evaluate('location.href').catch(() => '')
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
          { type: 'text', text: `${title} — ${url}` },
        ],
      }
    }
    case 'text': {
      pin(args.targetId)
      const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : 8000
      const value = await cdp.evaluate(`document.body ? document.body.innerText.slice(0, ${limit}) : ''`)
      return ok(value ?? '')
    }
    case 'click': {
      pin(args.targetId)
      let px = typeof args.x === 'number' ? args.x : undefined
      let py = typeof args.y === 'number' ? args.y : undefined
      if (typeof args.selector === 'string') {
        const box = await cdp.boxOf(args.selector)
        if (box === null || box === undefined) return fail(`找不到元素：${args.selector}`)
        px = box.x
        py = box.y
      }
      if (px === undefined || py === undefined) return fail('需要 selector 或 x/y')
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1, buttons: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1, buttons: 0 })
      return ok(`已点击 ${args.selector ?? `(${px}, ${py})`}`)
    }
    case 'type': {
      pin(args.targetId)
      const value = requireString(args.text, 'text')
      if (typeof args.selector === 'string') {
        const found = await cdp.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.focus(); return true })()`,
        )
        if (found !== true) return fail(`找不到元素：${args.selector}`)
      }
      await cdp.call('Input.insertText', { text: value })
      if (args.pressEnter === true) {
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      }
      return ok(`已输入 ${value.length} 个字符${args.pressEnter === true ? ' 并回车' : ''}`)
    }
    case 'scroll': {
      pin(args.targetId)
      if (typeof args.dy !== 'number') return fail('缺少参数：dy')
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: args.dy })
      return ok(`已滚动 ${args.dy}px`)
    }
    case 'back': {
      pin(args.targetId)
      await cdp.evaluate('history.back()')
      await waitReady(5000)
      return ok(await cdp.evaluate('location.href'))
    }
    case 'eval': {
      pin(args.targetId)
      return ok(await cdp.evaluate(requireString(args.expression, 'expression')))
    }
    default:
      return fail(`未知工具：${name}`)
  }
}

startStdioServer({
  serverInfo: { name: 'dsh-browser', version: '0.3.0' },
  tools: TOOLS,
  callTool: async (name, args) => {
    try {
      return await callTool(name, args ?? {})
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  },
})

console.error(`dsh-browser-mcp: 已连接 CDP ${port}（零依赖）`)
