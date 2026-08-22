/**
 * M3U8Parser — HLS 流媒体 Playlist 解析
 *
 * 解析 M3U8 (HLS) 文件，提取：
 * - Master Playlist：多质量流（带宽、分辨率、编解码器）
 * - Media Playlist：TS/fMP4 分片地址、时长、序号
 * - 直播 vs 点播 判断
 *
 * 支持特性：
 * - #EXT-X-STREAM-INF（Master Playlist 多质量流）
 * - #EXTINF（分片时长）
 * - #EXT-X-ENDLIST（VOD 结束标记）
 * - #EXT-X-MEDIA-SEQUENCE（分片序号起点）
 * - #EXT-X-KEY（加密信息检测）
 * - 相对 URL 自动解析为绝对 URL
 */

import { net } from 'electron'
import type { StreamVariant, M3U8Segment, StreamInfo } from '@tabtin/action-tools/types'
import { buildNetRequestOptions } from './resourceRequestContext'

/**
 * M3U8 解析专用错误（与网络获取错误区分）。
 * StreamDownloadService 通过 instanceof 判断，而非脆弱的字符串匹配。
 */
const MANIFEST_MAX_SIZE = 5 * 1024 * 1024
const MANIFEST_FETCH_TIMEOUT_MS = 10_000

export class M3U8ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'M3U8ParseError'
  }
}

export interface M3U8ParseResult {
  isMasterPlaylist: boolean
  variants: StreamVariant[]
  segments: M3U8Segment[]
  duration: number
  isLive: boolean
  isEncrypted: boolean
  mediaSequence: number
  version?: number
}

export class M3U8Parser {
  /**
   * 获取并解析 m3u8 URL
   */
  async fetchAndParse(
    url: string,
    headers?: Record<string, string>,
    options?: { requestSession?: Electron.Session; signal?: AbortSignal }
  ): Promise<M3U8ParseResult> {
    const content = await this.fetchContent(url, headers, options)
    return this.parse(content, url)
  }

  /**
   * 解析 m3u8 文本内容
   */
  parse(content: string, baseUrl: string): M3U8ParseResult {
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

    if (!lines[0]?.startsWith('#EXTM3U')) {
      throw new M3U8ParseError('Invalid M3U8: missing #EXTM3U header')
    }

    const isMasterPlaylist = lines.some(l => l.startsWith('#EXT-X-STREAM-INF:'))

    if (isMasterPlaylist) {
      return this.parseMasterPlaylist(lines, baseUrl)
    }

    return this.parseMediaPlaylist(lines, baseUrl)
  }

  /**
   * 将解析结果转为 StreamInfo（用于注入 DetectedResource）
   */
  toStreamInfo(result: M3U8ParseResult): StreamInfo {
    return {
      isMasterPlaylist: result.isMasterPlaylist,
      variants: result.variants.length > 0 ? result.variants : undefined,
      duration: result.duration > 0 ? result.duration : undefined,
      segmentCount: result.segments.length || undefined,
      isLive: result.isLive,
      isEncrypted: result.isEncrypted || undefined
    }
  }

  private parseMasterPlaylist(lines: string[], baseUrl: string): M3U8ParseResult {
    const variants: StreamVariant[] = []
    let version: number | undefined

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('#EXT-X-VERSION:')) {
        version = parseInt(line.split(':')[1], 10)
        continue
      }

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = this.parseAttributes(line.substring('#EXT-X-STREAM-INF:'.length))
        const nextLine = lines[i + 1]

        if (nextLine && !nextLine.startsWith('#')) {
          variants.push({
            bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
            resolution: attrs.RESOLUTION,
            codecs: attrs.CODECS,
            url: this.resolveUrl(nextLine, baseUrl)
          })
          i++
        }
      }
    }

    variants.sort((a, b) => b.bandwidth - a.bandwidth)

    return {
      isMasterPlaylist: true,
      variants,
      segments: [],
      duration: 0,
      isLive: false,
      isEncrypted: false,
      mediaSequence: 0,
      version
    }
  }

  private parseMediaPlaylist(lines: string[], baseUrl: string): M3U8ParseResult {
    const segments: M3U8Segment[] = []
    let totalDuration = 0
    let mediaSequence = 0
    let isLive = true
    let isEncrypted = false
    let version: number | undefined
    let currentSegmentDuration = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('#EXT-X-VERSION:')) {
        version = parseInt(line.split(':')[1], 10)
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.split(':')[1], 10)
      } else if (line === '#EXT-X-ENDLIST') {
        isLive = false
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = this.parseAttributes(line.substring('#EXT-X-KEY:'.length))
        if (attrs.METHOD && attrs.METHOD !== 'NONE') {
          isEncrypted = true
        }
      } else if (line.startsWith('#EXTINF:')) {
        const durationStr = line.substring('#EXTINF:'.length).split(',')[0]
        currentSegmentDuration = parseFloat(durationStr) || 0
      } else if (!line.startsWith('#') && currentSegmentDuration > 0) {
        const sequence = mediaSequence + segments.length
        segments.push({
          url: this.resolveUrl(line, baseUrl),
          duration: currentSegmentDuration,
          sequence
        })
        totalDuration += currentSegmentDuration
        currentSegmentDuration = 0
      }
    }

    return {
      isMasterPlaylist: false,
      variants: [],
      segments,
      duration: totalDuration,
      isLive,
      isEncrypted,
      mediaSequence,
      version
    }
  }

  private parseAttributes(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {}
    const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([\w./-]+))/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(attrString)) !== null) {
      attrs[match[1]] = match[2] ?? match[3]
    }

    return attrs
  }

  private resolveUrl(url: string, baseUrl: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url
    }

    try {
      return new URL(url, baseUrl).href
    } catch {
      return url
    }
  }

  private fetchContent(
    url: string,
    headers?: Record<string, string>,
    options?: { requestSession?: Electron.Session; signal?: AbortSignal }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request(buildNetRequestOptions(url, options?.requestSession))
        let timeoutId: ReturnType<typeof setTimeout>
        let settled = false
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          options?.signal?.removeEventListener('abort', onAbort)
          fn()
        }
        const onAbort = () => {
          clearTimeout(timeoutId)
          try { request.abort() } catch {}
          finish(() => reject(new Error('M3U8 fetch aborted')))
        }

        if (headers) {
          for (const [key, value] of Object.entries(headers)) {
            request.setHeader(key, value)
          }
        }

        const chunks: Buffer[] = []
        let totalSize = 0

        timeoutId = setTimeout(() => {
          try { request.abort() } catch {}
          finish(() => reject(new Error(`M3U8 fetch timeout (${MANIFEST_FETCH_TIMEOUT_MS}ms)`)))
        }, MANIFEST_FETCH_TIMEOUT_MS)

        if (options?.signal?.aborted) {
          onAbort()
          return
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true })

        request.on('response', (response) => {
          const statusCode: number = (response as any).statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300) {
            clearTimeout(timeoutId)
            try { request.abort() } catch {}
            finish(() => reject(new Error(`M3U8 fetch failed: HTTP ${statusCode} for ${url}`)))
            return
          }

          response.on('data', (chunk) => {
            if (settled) return
            totalSize += chunk.length
            if (totalSize > MANIFEST_MAX_SIZE) {
              clearTimeout(timeoutId)
              try { request.abort() } catch {}
              finish(() => reject(new Error(`M3U8 too large: ${totalSize} bytes`)))
              return
            }
            chunks.push(chunk)
          })

          response.on('end', () => {
            clearTimeout(timeoutId)
            finish(() => resolve(Buffer.concat(chunks).toString('utf8')))
          })

          response.on('error', (err) => {
            clearTimeout(timeoutId)
            finish(() => reject(err))
          })
        })

        request.on('error', (err) => {
          clearTimeout(timeoutId)
          finish(() => reject(err))
        })

        request.end()
      } catch (err) {
        reject(err)
      }
    })
  }
}

let instance: M3U8Parser | null = null

export function getM3U8Parser(): M3U8Parser {
  if (!instance) {
    instance = new M3U8Parser()
  }
  return instance
}
