/**
 * Find every Chrome/Chromium on this host that publishes a DevTools endpoint.
 *
 * The preview can only show the instance it is pointed at, and Agents
 * sometimes bring their own browser (started by a script, on a random port).
 * Scanning answers "which port is the browser on?" instead of making the user
 * guess.
 */
import { get } from 'node:http'

export interface CdpEndpoint {
  readonly port: number
  readonly browser: string
  readonly protocolVersion: string
}

function probe(port: number, timeoutMs: number): Promise<CdpEndpoint | undefined> {
  return new Promise((resolve) => {
    const req = get(
      { host: '127.0.0.1', port, path: '/json/version', headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { Browser?: string; 'Protocol-Version'?: string }
            if (typeof parsed.Browser !== 'string') {
              resolve(undefined)
              return
            }
            resolve({ port, browser: parsed.Browser, protocolVersion: parsed['Protocol-Version'] ?? '' })
          } catch {
            resolve(undefined)
          }
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(undefined)
    })
    req.on('error', () => resolve(undefined))
  })
}

/** Scan a port range concurrently; closed ports are cheap misses. */
export async function scanCdpPorts(from: number, to: number, timeoutMs = 400): Promise<CdpEndpoint[]> {
  const ports: number[] = []
  for (let port = Math.min(from, to); port <= Math.max(from, to); port += 1) ports.push(port)
  const found: CdpEndpoint[] = []
  const concurrency = 24
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, ports.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= ports.length) return
      const endpoint = await probe(ports[index], timeoutMs)
      if (endpoint !== undefined) found.push(endpoint)
    }
  })
  await Promise.all(workers)
  return found.sort((a, b) => a.port - b.port)
}

export function parseRange(spec: string, fallback: [number, number] = [9222, 9333]): [number, number] {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(spec.trim())
  if (match === null) return fallback
  return [Number(match[1]), Number(match[2])]
}
