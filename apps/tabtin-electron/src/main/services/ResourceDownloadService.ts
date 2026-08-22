/**
 * ResourceDownloadService — 通用资源下载引擎
 *
 * 提供单文件下载和批量下载能力，供 FrontendActionBridge / Agent 工具调用。
 * 从 FrontendActionBridge.downloadResource 抽离，保持桥接层职责单一。
 */

import { net, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { getUniquePath } from '../utils/file-path'
import { normalizeDownloadFilename } from '../download-security'
import type { ResourceContentRef } from '@tabtin/action-tools/types'
import { buildNetRequestOptions } from './resourceRequestContext'
import { isBlockedApiHost } from '../api-proxy'
import { isTrustedLocalOssUrl } from '../../shared/llm-image-url'

// ========== 类型定义 ==========

export interface DownloadOptions {
  url: string
  filename?: string
  headers?: Record<string, string>
  requestSession?: Electron.Session
  outputDir?: string
  timeoutMs?: number
  maxBytes?: number
}

export interface DownloadResult {
  filePath: string
  size: number
  mimeType: string
}

export interface BatchDownloadItemResult {
  url: string
  success: boolean
  data?: DownloadResult
  error?: string
}

export interface BatchDownloadResult {
  total: number
  succeeded: number
  failed: number
  results: BatchDownloadItemResult[]
}

const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/flac': '.flac', 'application/pdf': '.pdf',
  'application/vnd.apple.mpegurl': '.m3u8', 'application/x-mpegurl': '.m3u8',
  'audio/mpegurl': '.m3u8', 'audio/x-mpegurl': '.m3u8',
  'application/dash+xml': '.mpd', 'application/json': '.json',
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_BATCH_CONCURRENCY = 3
/** 内存拉取上限：与 fs:readBinaryFile 对齐，避免拖回 Composer 时撑爆 renderer。 */
export const MEDIA_FETCH_BUFFER_MAX_BYTES = 50 * 1024 * 1024

export interface FetchBufferOptions {
  url: string
  headers?: Record<string, string>
  requestSession?: Electron.Session
  timeoutMs?: number
  maxBytes?: number
}

export interface FetchBufferResult {
  buffer: Buffer
  mimeType: string
  size: number
}

// ========== 服务 ==========

export class ResourceDownloadService {
  private getDownloadsDir(outputDir?: string): string {
    const dir = outputDir || path.join(app.getPath('downloads'), 'TabTin')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  private resolveFilename(url: string, providedName?: string): string {
    if (providedName) {
      return normalizeDownloadFilename(providedName, 'download')
    }
    try {
      const urlObj = new URL(url)
      return normalizeDownloadFilename(path.basename(urlObj.pathname), 'download')
    } catch {
      return normalizeDownloadFilename('', 'download')
    }
  }

  private ensureExtension(filename: string, mimeType?: string, fallbackExt?: string): string {
    if (filename.includes('.')) {
      return filename
    }
    if (mimeType && MIME_EXT_MAP[mimeType]) {
      return `${filename}${MIME_EXT_MAP[mimeType]}`
    }
    if (fallbackExt) {
      return `${filename}${fallbackExt}`
    }
    return filename
  }

  private parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) {
      throw new Error('Invalid data URL')
    }
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64')
    }
  }

  async saveCapturedContent(options: {
    url?: string
    filename?: string
    mimeType?: string
    contentRef: ResourceContentRef
    outputDir?: string
  }): Promise<DownloadResult> {
    const downloadsDir = this.getDownloadsDir(options.outputDir)

    if (options.contentRef.kind === 'file_path' && options.contentRef.filePath) {
      const stat = fs.statSync(options.contentRef.filePath)
      return {
        filePath: options.contentRef.filePath,
        size: stat.size,
        mimeType: options.contentRef.mimeType || options.mimeType || 'application/octet-stream'
      }
    }

    const baseName = this.resolveFilename(options.url || 'resource', options.filename)
    let buffer: Buffer
    let mimeType = options.mimeType || options.contentRef.mimeType || 'application/octet-stream'
    let fallbackExt: string | undefined

    if (options.contentRef.kind === 'data_url') {
      if (!options.contentRef.data) {
        throw new Error('Missing data URL content')
      }
      const parsed = this.parseDataUrl(options.contentRef.data)
      buffer = parsed.buffer
      mimeType = options.mimeType || options.contentRef.mimeType || parsed.mimeType
    } else if (options.contentRef.kind === 'text') {
      buffer = Buffer.from(options.contentRef.data || '', 'utf8')
      fallbackExt = mimeType.includes('mpegurl') ? '.m3u8' : mimeType.includes('dash+xml') ? '.mpd' : '.txt'
    } else {
      throw new Error(`Unsupported content kind: ${options.contentRef.kind}`)
    }

    const finalName = this.ensureExtension(baseName, mimeType, fallbackExt)
    const finalPath = getUniquePath(path.join(downloadsDir, finalName))
    fs.writeFileSync(finalPath, buffer)
    return {
      filePath: finalPath,
      size: buffer.length,
      mimeType
    }
  }

  async download(options: DownloadOptions): Promise<DownloadResult> {
    const downloadsDir = this.getDownloadsDir(options.outputDir)
    let filename = this.resolveFilename(options.url, options.filename)
    const tempPath = path.join(downloadsDir, `.dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = options.maxBytes

    return new Promise<DownloadResult>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn() }
      }

      const request = net.request(buildNetRequestOptions(options.url, options.requestSession))

      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          request.setHeader(key, value)
        }
      }

      const writeStream = fs.createWriteStream(tempPath)
      let totalSize = 0
      let mimeType = 'application/octet-stream'

      const cleanup = () => {
        try { fs.unlinkSync(tempPath) } catch { /* temp file may already be gone */ }
      }

      const rejectTooLarge = (size: number) => {
        clearTimeout(timeoutId)
        try { request.abort() } catch { /* already aborted */ }
        writeStream.destroy()
        cleanup()
        settle(() => reject(new Error(`File too large (${size} bytes, max ${maxBytes})`)))
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
        settle(() => reject(new Error(`Download timeout (${timeoutMs / 1000}s)`)))
      }, timeoutMs)

      request.on('response', (response: Electron.IncomingMessage) => {
        if (response.statusCode && response.statusCode >= 400) {
          clearTimeout(timeoutId)
          writeStream.destroy()
          cleanup()
          settle(() => reject(new Error(`HTTP ${response.statusCode}`)))
          return
        }

        const ct = response.headers['content-type']
        const rawMime = Array.isArray(ct) ? ct[0] : ct
        if (rawMime) mimeType = rawMime.split(';')[0].trim()

        const contentLengthRaw = response.headers['content-length']
        const contentLength = Number(
          Array.isArray(contentLengthRaw) ? contentLengthRaw[0] : contentLengthRaw,
        )
        if (maxBytes != null && Number.isFinite(contentLength) && contentLength > maxBytes) {
          rejectTooLarge(contentLength)
          return
        }

        if (!filename.includes('.') && MIME_EXT_MAP[mimeType]) {
          filename = filename + MIME_EXT_MAP[mimeType]
        }

        response.on('data', (chunk: Buffer) => {
          if (settled || writeStream.destroyed) return
          totalSize += chunk.length
          if (maxBytes != null && totalSize > maxBytes) {
            rejectTooLarge(totalSize)
            return
          }
          writeStream.write(chunk)
        })

        response.on('end', () => {
          clearTimeout(timeoutId)
          if (settled) return
          writeStream.end(() => {
            const finalPath = getUniquePath(path.join(downloadsDir, filename))
            try {
              fs.renameSync(tempPath, finalPath)
              settle(() => resolve({ filePath: finalPath, size: totalSize, mimeType }))
            } catch (renameErr) {
              cleanup()
              settle(() => reject(new Error(`Rename failed: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`)))
            }
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

  /**
   * 把远程 http(s) 资源拉进内存（不落盘）。
   * 供聊天附件预览 / file-ref 拖回 Composer——第三方 CDN
   * （如火山 TOS）不在 api-proxy 白名单内，不能走 electronFetch。
   * 安全：仅 http(s) + isBlockedApiHost（私网 / metadata）拒绝；有字节上限。
   */
  async fetchToBuffer(options: FetchBufferOptions): Promise<FetchBufferResult> {
    let parsed: URL
    try {
      parsed = new URL(options.url)
    } catch {
      throw new Error('Invalid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are allowed')
    }
    // 本机 Django local-object 必须可拉（访达上传后的 127.0.0.1），供 LLM data: 改写；
    // 其它私网仍拦 SSRF。
    if (isBlockedApiHost(options.url) && !isTrustedLocalOssUrl(options.url)) {
      throw new Error('Request blocked: target host is not allowed')
    }

    const maxBytes = options.maxBytes ?? MEDIA_FETCH_BUFFER_MAX_BYTES
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<FetchBufferResult>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn() }
      }

      const request = net.request(buildNetRequestOptions(options.url, options.requestSession))
      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          request.setHeader(key, value)
        }
      }

      const chunks: Buffer[] = []
      let totalSize = 0
      let mimeType = 'application/octet-stream'

      const timeoutId = setTimeout(() => {
        try { request.abort() } catch { /* already aborted */ }
        settle(() => reject(new Error(`Download timeout (${timeoutMs / 1000}s)`)))
      }, timeoutMs)

      request.on('response', (response: Electron.IncomingMessage) => {
        if (response.statusCode && response.statusCode >= 400) {
          clearTimeout(timeoutId)
          settle(() => reject(new Error(`HTTP ${response.statusCode}`)))
          return
        }

        const ct = response.headers['content-type']
        const rawMime = Array.isArray(ct) ? ct[0] : ct
        if (rawMime) mimeType = rawMime.split(';')[0].trim()

        const contentLengthRaw = response.headers['content-length']
        const contentLength = Number(
          Array.isArray(contentLengthRaw) ? contentLengthRaw[0] : contentLengthRaw,
        )
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          clearTimeout(timeoutId)
          try { request.abort() } catch { /* ignore */ }
          settle(() => reject(new Error(`File too large (${contentLength} bytes, max ${maxBytes})`)))
          return
        }

        response.on('data', (chunk: Buffer) => {
          if (settled) return
          totalSize += chunk.length
          if (totalSize > maxBytes) {
            clearTimeout(timeoutId)
            try { request.abort() } catch { /* ignore */ }
            settle(() => reject(new Error(`File too large (max ${maxBytes} bytes)`)))
            return
          }
          chunks.push(chunk)
        })

        response.on('end', () => {
          clearTimeout(timeoutId)
          if (settled) return
          const buffer = Buffer.concat(chunks, totalSize)
          settle(() => resolve({ buffer, mimeType, size: buffer.length }))
        })

        response.on('error', (err: Error) => {
          clearTimeout(timeoutId)
          settle(() => reject(err))
        })
      })

      request.on('error', (err: Error) => {
        clearTimeout(timeoutId)
        settle(() => reject(err))
      })

      request.end()
    })
  }

  async downloadBatch(
    tasks: DownloadOptions[],
    concurrency = DEFAULT_BATCH_CONCURRENCY
  ): Promise<BatchDownloadResult> {
    const results = new Array<BatchDownloadItemResult>(tasks.length)
    let succeeded = 0
    let failed = 0

    const pool: Promise<void>[] = []
    let cursor = 0

    const runNext = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const idx = cursor++
        const task = tasks[idx]
        try {
          const data = await this.download(task)
          results[idx] = { url: task.url, success: true, data }
          succeeded++
        } catch (err) {
          results[idx] = {
            url: task.url,
            success: false,
            error: err instanceof Error ? err.message : String(err)
          }
          failed++
        }
      }
    }

    for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
      pool.push(runNext())
    }
    await Promise.all(pool)

    return { total: tasks.length, succeeded, failed, results }
  }
}

// ========== 单例 ==========

let instance: ResourceDownloadService | null = null

export function getResourceDownloadService(): ResourceDownloadService {
  if (!instance) {
    instance = new ResourceDownloadService()
  }
  return instance
}
