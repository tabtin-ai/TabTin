/**
 * Common HTTP utilities shared by Electron and Daemon CLI Servers.
 */

import type http from 'node:http'

export const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10 MB
export const BODY_READ_TIMEOUT_MS = 30_000     // 30 s

/**
 * Parse request body as JSON with size and timeout protection.
 *
 * Prevents slow-client DoS via the 30s timeout and 10MB size cap.
 * Uses a `settled` flag to prevent double-settle in edge-case races.
 */
export function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('Body read timeout'))
    }, BODY_READ_TIMEOUT_MS)

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      receivedBytes += chunk.length
      if (receivedBytes > MAX_BODY_SIZE) {
        settle(() => {
          req.destroy()
          reject(new Error('Request body too large'))
        })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      settle(() => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (!raw) { resolve(undefined); return }
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error('Invalid JSON body'))
        }
      })
    })
    req.on('error', (err) => settle(() => reject(err)))
  })
}

/**
 * Send a JSON response with correct Content-Type and Content-Length.
 */
export function sendJSON(res: http.ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
