#!/usr/bin/env node
/**
 * MCP server: the shared DSH browser as Agent tools.
 *
 * stdio JSON-RPC, no network listener. Every tool drives the same Chromium the
 * browser-preview plugin shows in its floating window (CDP on 127.0.0.1:9222),
 * so "Agent opens a page" and "preview shows a page" are one tab.
 *
 * Multiple Agent sessions share this single browser, so:
 *   - `open` creates a NEW tab and returns its `targetId`
 *   - every other tool accepts an optional `targetId` to say which tab it means
 *   - without one, the tool acts on the newest non-`about:blank` page
 *
 * Logs go to stderr on purpose: stdout is the protocol channel.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Cdp } from './cdp.js'

const port = Number(process.env.DSH_BROWSER_CDP_PORT ?? 9222)
const cdp = new Cdp(port)

const server = new McpServer({ name: 'dsh-browser', version: '0.2.0' })

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

const targetArg = { targetId: z.string().optional().describe('要操作的标签页 id（open 返回值）；省略则作用于最新页面') }

async function waitReady(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await cdp.evaluate('document.readyState').catch(() => undefined)
    if (state === 'complete') return true
    await sleep(300)
  }
  return false
}

server.tool(
  'status',
  '当前预览页面的 URL、标题、标签 id 与 CDP 端口',
  { ...targetArg },
  async ({ targetId }) => {
    try {
      pin(targetId)
      return ok({
        targetId: cdp.currentId ?? null,
        url: await cdp.evaluate('location.href'),
        title: await cdp.evaluate('document.title'),
        cdpPort: port,
      })
    } catch (error) {
      return fail(error.message)
    }
  },
)

server.tool(
  'open',
  '新开一个标签页打开 URL（不复用现有页面，多个会话互不干扰）；返回 targetId 供后续工具指定',
  { url: z.string().describe('要打开的 http(s) 地址'), ...targetArg },
  async ({ url, targetId }) => {
    try {
      let id = targetId
      if (typeof id === 'string' && id.length > 0) {
        // Explicit tab: navigate it instead of opening another.
        pin(id)
        await cdp.call('Page.enable')
        await cdp.call('Page.navigate', { url })
      } else {
        id = await cdp.openTab(url)
        pin(id)
        await cdp.call('Page.enable')
      }
      const ready = await waitReady()
      return ok({
        targetId: id,
        ready,
        url: await cdp.evaluate('location.href'),
        title: await cdp.evaluate('document.title'),
      })
    } catch (error) {
      return fail(error.message)
    }
  },
)

server.tool('screenshot', '截取指定（或最新）标签页画面，返回 JPEG 图片', { ...targetArg }, async ({ targetId }) => {
  try {
    pin(targetId)
    const shot = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
    const title = await cdp.evaluate('document.title').catch(() => '')
    const url = await cdp.evaluate('location.href').catch(() => '')
    return {
      content: [
        { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
        { type: 'text', text: `${title} — ${url}` },
      ],
    }
  } catch (error) {
    return fail(error.message)
  }
})

server.tool(
  'text',
  '读取指定（或最新）标签页的正文文本',
  { limit: z.number().int().min(1).max(200_000).optional().describe('最大字符数，默认 8000'), ...targetArg },
  async ({ limit, targetId }) => {
    try {
      pin(targetId)
      const value = await cdp.evaluate(`document.body ? document.body.innerText.slice(0, ${limit ?? 8000}) : ''`)
      return ok(value ?? '')
    } catch (error) {
      return fail(error.message)
    }
  },
)

server.tool(
  'click',
  '点击页面元素：给出 CSS 选择器，或页面坐标 x/y',
  {
    selector: z.string().optional().describe('CSS 选择器，优先使用'),
    x: z.number().optional().describe('页面坐标 X（不使用选择器时）'),
    y: z.number().optional().describe('页面坐标 Y（不使用选择器时）'),
    ...targetArg,
  },
  async ({ selector, x, y, targetId }) => {
    try {
      pin(targetId)
      let px = x
      let py = y
      if (selector !== undefined) {
        const box = await cdp.boxOf(selector)
        if (box === null || box === undefined) return fail(`找不到元素：${selector}`)
        px = box.x
        py = box.y
      }
      if (px === undefined || py === undefined) return fail('需要 selector 或 x/y')
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1, buttons: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1, buttons: 0 })
      return ok(`已点击 ${selector ?? `(${px}, ${py})`}`)
    } catch (error) {
      return fail(error.message)
    }
  },
)

server.tool(
  'type',
  '向页面输入文本；可选先聚焦某个输入框，可选回车提交',
  {
    text: z.string().describe('要输入的文本'),
    selector: z.string().optional().describe('先聚焦的 CSS 选择器'),
    pressEnter: z.boolean().optional().describe('输入后按回车'),
    ...targetArg,
  },
  async ({ text: value, selector, pressEnter, targetId }) => {
    try {
      pin(targetId)
      if (selector !== undefined) {
        const found = await cdp.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`,
        )
        if (found !== true) return fail(`找不到元素：${selector}`)
      }
      await cdp.call('Input.insertText', { text: value })
      if (pressEnter === true) {
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      }
      return ok(`已输入 ${value.length} 个字符${pressEnter === true ? ' 并回车' : ''}`)
    } catch (error) {
      return fail(error.message)
    }
  },
)

server.tool(
  'scroll',
  '页面滚动（正数向下，负数向上）',
  { dy: z.number().describe('滚动像素'), ...targetArg },
  async ({ dy, targetId }) => {
    try {
      pin(targetId)
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: dy })
      return ok(`已滚动 ${dy}px`)
    } catch (error) {
      return fail(error.message)
    }
  },
)

server.tool('back', '后退到上一个页面', { ...targetArg }, async ({ targetId }) => {
  try {
    pin(targetId)
    await cdp.evaluate('history.back()')
    await waitReady(5000)
    return ok(await cdp.evaluate('location.href'))
  } catch (error) {
    return fail(error.message)
  }
})

server.tool(
  'eval',
  '在页面里执行 JavaScript 并返回结果（调试用）',
  { expression: z.string().describe('JS 表达式'), ...targetArg },
  async ({ expression, targetId }) => {
    try {
      pin(targetId)
      return ok(await cdp.evaluate(expression))
    } catch (error) {
      return fail(error.message)
    }
  },
)

await server.connect(new StdioServerTransport())
console.error(`dsh-browser-mcp: 已连接 CDP ${port}`)
