/**
 * fetchToFile — Electron net.request → 本地文件的通用下载原语
 *
 * ResourceDownloadService 和 StreamDownloadService 共享此底层实现，
 * 消除两处独立维护的 request/writeStream/timeout/cleanup 模式。
 */

import { net } from 'electron'
import * as fs from 'fs'

// ========== 错误类型 ==========

export class HttpError extends Error {
  constructor(public readonly statusCode: number) {
    super(`HTTP ${statusCode}`)
    this.name = 'HttpError'
  }
}

export class FetchTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Download timeout (${timeoutMs / 1000}s)`)
    this.name = 'FetchTimeoutError'
  }
}

// ========== 接口 ==========

export interface FetchToFileOptions {
  url: string
  destPath: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface FetchToFileResult {
  size: number
  mimeType: string
}

// ========== 实现 ==========

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 将 URL 内容下载到 destPath。
 * - 成功时 destPath 存在，返回 { size, mimeType }
 * - 失败时 destPath 自动清理，抛出 HttpError / FetchTimeoutError / Error
 */
export function fetchToFile(options: FetchToFileOptions): Promise<FetchToFileResult> {
  const { url, destPath, headers, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  return new Promise<FetchToFileResult>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn() }
    }

    const request = net.request({ url, method: 'GET', redirect: 'follow' })

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        request.setHeader(key, value)
      }
    }

    const writeStream = fs.createWriteStream(destPath)
    let totalSize = 0
    let mimeType = 'application/octet-stream'

    const cleanup = () => {
      try { fs.unlinkSync(destPath) } catch { /* file may already be gone */ }
    }

    writeStream.on('error', (err: Error) => {
      clearTimeout(timeoutId)
      try { request.abort() } catch { /* already aborted */ }
      cleanup()
      settle(() => reject(new Error(`Write error: ${err.message}`)))
    })

    const timeoutId = setTimeout(() => {
      try { request.abort() } catch { /* already aborted */ }
      writeStream.destroy()
      cleanup()
      settle(() => reject(new FetchTimeoutError(timeoutMs)))
    }, timeoutMs)

    request.on('response', (response: Electron.IncomingMessage) => {
      if (response.statusCode && response.statusCode >= 400) {
        clearTimeout(timeoutId)
        writeStream.destroy()
        cleanup()
        settle(() => reject(new HttpError(response.statusCode!)))
        return
      }

      const ct = response.headers['content-type']
      const rawMime = Array.isArray(ct) ? ct[0] : ct
      if (rawMime) mimeType = rawMime.split(';')[0].trim()

      response.on('data', (chunk: Buffer) => {
        if (settled || writeStream.destroyed) return
        totalSize += chunk.length
        writeStream.write(chunk)
      })

      response.on('end', () => {
        clearTimeout(timeoutId)
        if (settled) return
        writeStream.end(() => {
          settle(() => resolve({ size: totalSize, mimeType }))
        })
      })

      response.on('error', (err: Error) => {
        clearTimeout(timeoutId)
        writeStream.destroy()
        cleanup()
        settle(() => reject(err))
      })
    })

    request.on('error', (err: Error) => {
      clearTimeout(timeoutId)
      writeStream.destroy()
      cleanup()
      settle(() => reject(err))
    })

    request.end()
  })
}
