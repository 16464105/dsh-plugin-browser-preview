/**
 * Minimal MCP server over stdio — no dependencies.
 *
 * Line-delimited JSON-RPC 2.0 on stdin/stdout, which is what MCP's stdio
 * transport speaks. Only the surface this server needs is implemented:
 * initialize, tools/list, tools/call, ping, plus incoming notifications.
 * stderr stays the log channel so stdout remains pure protocol.
 */
import { createInterface } from 'node:readline'

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function startStdioServer({ serverInfo, tools, callTool }) {
  const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  const handleRequest = async (message) => {
    const params = message.params ?? {}
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        }
      case 'tools/list':
        return { tools }
      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string') throw new RpcError(-32602, 'tools/call 缺少 name')
        const tool = tools.find((entry) => entry.name === name)
        if (tool === undefined) throw new RpcError(-32602, `未知工具：${name}`)
        return await callTool(name, params.arguments ?? {})
      }
      case 'ping':
        return {}
      default:
        throw new RpcError(-32601, `不支持的方法：${message.method}`)
    }
  }

  const handleNotification = (message) => {
    // `notifications/initialized` and `notifications/cancelled` need no reply;
    // anything else is safe to ignore.
    if (message.method === 'notifications/cancelled') return
  }

  const lineReader = createInterface({ input: process.stdin, terminal: false })
  lineReader.on('line', (line) => {
    const text = line.trim()
    if (text.length === 0) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    // Notifications carry no id and must not be answered.
    if (message.id === undefined) {
      handleNotification(message)
      return
    }
    void Promise.resolve()
      .then(() => handleRequest(message))
      .then((result) => send({ jsonrpc: '2.0', id: message.id, result }))
      .catch((error) =>
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: error?.code ?? -32603, message: error?.message ?? String(error) },
        }),
      )
  })

  lineReader.on('close', () => {
    process.exit(0)
  })
}
