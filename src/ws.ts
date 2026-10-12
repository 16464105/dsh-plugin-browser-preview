/**
 * The smallest WebSocket server half that covers the preview stream.
 *
 * `webServer.registerUpgrade` hands over the raw socket after the HTTP
 * Upgrade request, so the 101 handshake and framing are ours. The noVNC leg
 * does not need this: it forwards the request verbatim and lets websockify
 * answer.
 */
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Complete the opening handshake; `false` means the request was not a WS one. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.destroy()
    return false
  }
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  return true
}

/** Send one unmasked binary frame (server→client is never masked). */
export function sendBinary(socket: Duplex, payload: Buffer): void {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x82
  socket.write(Buffer.concat([header, payload]))
}

/**
 * Decode client frames (always masked) and surface text payloads.
 * Ping is answered with a pong so idle preview windows survive proxies.
 */
export function readTextFrames(socket: Duplex, onText: (text: string) => void): void {
  let pending: Buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    for (;;) {
      if (pending.length < 2) return
      const first = pending[0]
      const second = pending[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (pending.length < offset + 2) return
        length = pending.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (pending.length < offset + 8) return
        length = Number(pending.readBigUInt64BE(offset))
        offset += 8
      }
      const maskKey = masked ? pending.subarray(offset, offset + 4) : undefined
      if (maskKey !== undefined) offset += 4
      if (pending.length < offset + length) return
      const payload = Buffer.from(pending.subarray(offset, offset + length))
      pending = pending.subarray(offset + length)
      if (maskKey !== undefined) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
      }
      if (opcode === 0x1) onText(payload.toString('utf8'))
      else if (opcode === 0x8) socket.end()
      else if (opcode === 0x9) sendBinary(socket, payload)
    }
  })
}
