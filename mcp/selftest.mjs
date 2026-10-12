import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['src/index.js'],
  cwd: process.cwd(),
})
const client = new Client({ name: 'selftest', version: '1.0.0' })
await client.connect(transport)

const tools = await client.listTools()
console.log('tools:', tools.tools.map((t) => t.name).join(', '))

const status = await client.callTool({ name: 'status', arguments: {} })
console.log('status:', status.content?.[0]?.text)

const opened = await client.callTool({ name: 'open', arguments: { url: 'https://example.com' } })
console.log('open:', opened.content?.[0]?.text)

const shot = await client.callTool({ name: 'screenshot', arguments: {} })
console.log('screenshot content types:', shot.content?.map((c) => c.type).join(','))
const image = shot.content?.find((c) => c.type === 'image')
console.log('image bytes (base64 len):', image?.data?.length)

const body = await client.callTool({ name: 'text', arguments: { limit: 200 } })
console.log('text:', String(body.content?.[0]?.text).replace(/\n+/g, ' ').slice(0, 120))

await client.close()
console.log('selftest done')
