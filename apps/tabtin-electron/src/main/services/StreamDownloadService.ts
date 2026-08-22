/**
 * StreamDownloadService — HLS/DASH 流媒体下载引擎
 *
 * 将 m3u8/mpd 的 N 个分片并发下载后按顺序合并为一个完整文件。
 * HLS: TS 分片直接拼接；DASH: init segment + fMP4 分片二进制拼接。
 *
 * 设计原则：
 * - 并发受控：可配置并发数（默认 5），避免打满带宽或触发服务端限流
 * - 顺序合并：分片可以乱序下载，但合并时严格按 sequence 排列
 * - 进度反馈：通过 EventEmitter 推送实时进度（已下载分片数 / 总数 / 速度）
 * - 错误容忍：单个分片失败自动重试（最多 3 次），全部失败才报错
 * - 资源安全：临时分片文件在合并完成后自动清理
 * - 防盗链支持：下载请求自动携带 Referer/Origin 等 headers
 */

import { EventEmitter } from 'events'
import { net, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'node:child_process'

import { getM3U8Parser, M3U8ParseError } from './M3U8Parser'
import { getMPDParser, MPDParseError } from './MPDParser'
import { getResourceDetectionService } from './ResourceDetectionService'
import { getResourceHubService } from './ResourceHubService'
import { buildNetRequestOptions, resolveResourceRequestSession } from './resourceRequestContext'
import { getUniquePath, formatBytes } from '../utils/file-path'
import { findFFmpegSync } from '../utils/ffmpeg'
import { logger } from '../utils/logger'
import { isPathSafe, normalizeDownloadFilename } from '../download-security'
import type { StreamVariant, M3U8Segment, ResourceCategory, ResourceRecord } from '@tabtin/action-tools/types'
import { StreamErrorCode } from '@shared/types/download'
import type { StreamProgressEvent } from '@shared/types/download'

// ========== 类型定义 ==========

export type StreamDownloadQuality = 'best' | 'worst' | string

export interface StreamDownloadOptions {
  url: string
  headers?: Record<string, string>
  filename?: string
  outputPath?: string
  outputDir?: string
  concurrency?: number
  retryCount?: number
  segmentTimeout?: number
  quality?: StreamDownloadQuality
  viewId?: string
  resource?: Pick<ResourceRecord, 'viewId' | 'authContextRef' | 'category' | 'resourceId'> | null
  signal?: AbortSignal
}

export interface StreamDownloadResult {
  success: boolean
  downloadId: string
  data?: {
    filePath: string
    size: number
    duration?: number
    segmentCount: number
    elapsedMs: number
  }
  error?: string
  errorCode?: StreamErrorCode
}

interface SegmentTask {
  segment: M3U8Segment
  tempPath: string
  downloaded: boolean
  size: number
  retries: number
}

interface ActiveDownloadContext {
  aborted: boolean
  requests: Set<Electron.ClientRequest>
}

export class StreamDownloadError extends Error {
  constructor(
    public readonly code: StreamErrorCode,
    message: string,
    public readonly statusCode?: number
  ) {
    super(message)
    this.name = 'StreamDownloadError'
  }
}

// ========== 服务实现 ==========

const DEFAULT_CONCURRENCY = 5
const DEFAULT_RETRY_COUNT = 3
const DEFAULT_SEGMENT_TIMEOUT = 30000

export class StreamDownloadService extends EventEmitter {
  private activeDownloads = new Map<string, ActiveDownloadContext>()
  private downloadCounter = 0

  /**
   * 下载完整 HLS/DASH 流
   */
  async download(options: StreamDownloadOptions): Promise<StreamDownloadResult> {
    const downloadId = `stream-${Date.now()}-${++this.downloadCounter}`
    const startTime = Date.now()
    const abortCtrl: ActiveDownloadContext = { aborted: false, requests: new Set() }
    this.activeDownloads.set(downloadId, abortCtrl)
    const abortFromSignal = () => this.abort(downloadId)
    if (options.signal?.aborted) {
      abortCtrl.aborted = true
    } else {
      options.signal?.addEventListener('abort', abortFromSignal, { once: true })
    }

    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT
    const segmentTimeout = options.segmentTimeout ?? DEFAULT_SEGMENT_TIMEOUT

    const headers = await this.resolveHeaders(options)
    const requestSession = resolveResourceRequestSession({
      viewId: options.viewId,
      resource: options.resource ?? null
    })

    const outputDir = options.outputDir || path.join(app.getPath('downloads'), 'TabTin')
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const tempDir = path.join(app.getPath('temp'), 'tabtin-stream', downloadId)
    fs.mkdirSync(tempDir, { recursive: true })

    try {
      const emitProgress = (partial: Omit<StreamProgressEvent, 'downloadId'>) => {
        this.emitProgress(downloadId, {
          url: options.url,
          resourceId: options.resource?.resourceId,
          ...partial
        })
      }

      if (abortCtrl.aborted) {
        throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
      }

      // Phase 1: 解析 manifest (HLS/DASH)
      emitProgress({
        phase: 'resolving',
        downloadedSegments: 0,
        totalSegments: 0,
        downloadedBytes: 0,
        speed: 0,
        percent: 0
      })

      const isDash = /\.mpd(\?|#|$)/i.test(options.url)
        || options.resource?.category === 'dash'

      let segments: M3U8Segment[]
      let duration: number
      let initSegmentUrl: string | undefined
      let isLive = false
      let isEncrypted = false
      let dashAudioSegments: M3U8Segment[] | undefined
      let dashAudioInitUrl: string | undefined

      if (isDash) {
        const dashParser = getMPDParser()
        let dashResult
        try {
          logger.info('StreamDownload', `[DASH诊断] 开始解析 MPD: ${options.url}`)
          logger.info('StreamDownload', `[DASH诊断] 使用 headers: ${JSON.stringify(Object.keys(headers))}`)
          logger.info('StreamDownload', `[DASH诊断] requestSession: ${requestSession ? 'yes' : 'no'}`)
          dashResult = await dashParser.fetchAndParse(options.url, headers, {
            requestSession,
            signal: options.signal,
          })
        } catch (err) {
          if (err instanceof StreamDownloadError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          const code = err instanceof MPDParseError ? StreamErrorCode.PARSE_ERROR : StreamErrorCode.NETWORK_ERROR
          throw new StreamDownloadError(code, `MPD fetch/parse failed: ${msg}`)
        }

        segments = dashResult.segments
        initSegmentUrl = dashResult.initSegmentUrl
        duration = dashResult.duration
        isLive = dashResult.isLive
        isEncrypted = dashResult.isEncrypted

        logger.info('StreamDownload', `[DASH诊断] 解析完成: ${dashResult.variants.length} variants, ${segments.length} segments, duration=${duration}s, isLive=${isLive}, isEncrypted=${isEncrypted}`)
        logger.info('StreamDownload', `[DASH诊断] initSegmentUrl: ${initSegmentUrl || 'none'}`)
        if (segments.length > 0) {
          logger.info('StreamDownload', `[DASH诊断] 第一个分片 URL: ${segments[0].url.substring(0, 200)}`)
          logger.info('StreamDownload', `[DASH诊断] 最后一个分片 URL: ${segments[segments.length - 1].url.substring(0, 200)}`)
        }

        if (dashResult.variants.length > 1 && dashResult.variantSegmentMap) {
          const selectedVariant = this.selectVariant(dashResult.variants, options.quality)
          if (selectedVariant) {
            const variantIndex = dashResult.variants.indexOf(selectedVariant)
            const variantData = dashResult.variantSegmentMap.get(variantIndex)
            if (variantData) {
              segments = variantData.segments
              initSegmentUrl = variantData.initUrl
              logger.info('StreamDownload', `选择流: ${selectedVariant.resolution || 'N/A'} @ ${Math.round(selectedVariant.bandwidth / 1000)}kbps`)
            }
          }
        }

        if (dashResult.audioSegments?.segments?.length) {
          dashAudioSegments = dashResult.audioSegments.segments
          dashAudioInitUrl = dashResult.audioSegments.initUrl
          logger.info('StreamDownload', `检测到独立音频轨: ${dashAudioSegments.length} 分片`)
        }
      } else {
        const parser = getM3U8Parser()
        let parseResult
        try {
          parseResult = await parser.fetchAndParse(options.url, headers, {
            requestSession,
            signal: options.signal,
          })
        } catch (err) {
          if (err instanceof StreamDownloadError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          const code = err instanceof M3U8ParseError ? StreamErrorCode.PARSE_ERROR : StreamErrorCode.NETWORK_ERROR
          throw new StreamDownloadError(code, `M3U8 fetch/parse failed: ${msg}`)
        }

        if (parseResult.isMasterPlaylist) {
          const selectedVariant = this.selectVariant(parseResult.variants, options.quality)
          if (!selectedVariant) {
            throw new StreamDownloadError(StreamErrorCode.NO_QUALITY_MATCH, 'No suitable quality variant found in master playlist')
          }

          logger.info('StreamDownload', `选择流: ${selectedVariant.resolution || 'N/A'} @ ${Math.round(selectedVariant.bandwidth / 1000)}kbps`)

          let mediaResult
          try {
            mediaResult = await parser.fetchAndParse(selectedVariant.url, headers, {
              requestSession,
              signal: options.signal,
            })
          } catch (err) {
            if (err instanceof StreamDownloadError) throw err
            const msg = err instanceof Error ? err.message : String(err)
            const code = err instanceof M3U8ParseError ? StreamErrorCode.PARSE_ERROR : StreamErrorCode.NETWORK_ERROR
            throw new StreamDownloadError(code, `Media playlist fetch failed: ${msg}`)
          }
          segments = mediaResult.segments
          duration = mediaResult.duration
        } else {
          segments = parseResult.segments
          duration = parseResult.duration
        }

        isLive = parseResult.isLive
        isEncrypted = parseResult.isEncrypted
      }

      if (segments.length === 0) {
        throw new StreamDownloadError(StreamErrorCode.NO_SEGMENTS, `No segments found in ${isDash ? 'MPD' : 'm3u8'} manifest`)
      }
      if (abortCtrl.aborted) {
        throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
      }

      if (isLive) {
        throw new StreamDownloadError(StreamErrorCode.LIVE_STREAM, 'Live stream download is not supported')
      }

      if (isEncrypted) {
        throw new StreamDownloadError(StreamErrorCode.ENCRYPTED_STREAM, `Encrypted ${isDash ? 'DASH' : 'HLS'} stream is not supported`)
      }

      logger.info('StreamDownload', `开始下载: ${segments.length} 分片, 时长 ${duration.toFixed(1)}s`)

      // Phase 2: 并发下载分片
      const segExt = isDash ? '.m4s' : '.ts'
      const tasks: SegmentTask[] = segments.map((seg, i) => ({
        segment: seg,
        tempPath: path.join(tempDir, `seg-${String(i).padStart(5, '0')}${segExt}`),
        downloaded: false,
        size: 0,
        retries: 0
      }))

      let downloadedBytes = 0
      let completedCount = 0
      let lastSpeedCalcTime = Date.now()
      let lastSpeedCalcBytes = 0
      let currentSpeed = 0

      const downloadSegment = async (task: SegmentTask): Promise<void> => {
        if (abortCtrl.aborted) return

        for (let attempt = 0; attempt <= retryCount; attempt++) {
          if (abortCtrl.aborted) return

          try {
            const size = await this.fetchSegment(
              task.segment.url,
              task.tempPath,
              headers,
              segmentTimeout,
              abortCtrl,
              requestSession
            )
            task.downloaded = true
            task.size = size
            downloadedBytes += size
            completedCount++

            const now = Date.now()
            const elapsed = (now - lastSpeedCalcTime) / 1000
            if (elapsed >= 0.5) {
              currentSpeed = (downloadedBytes - lastSpeedCalcBytes) / elapsed
              lastSpeedCalcTime = now
              lastSpeedCalcBytes = downloadedBytes
            }

            emitProgress({
              phase: 'downloading',
              downloadedSegments: completedCount,
              totalSegments: tasks.length,
              downloadedBytes,
              speed: currentSpeed,
              percent: Math.round((completedCount / tasks.length) * (dashAudioSegments ? 85 : 90)),
              duration
            })

            return
          } catch (err) {
            if (abortCtrl.aborted) {
              throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
            }
            task.retries++
            if (attempt < retryCount) {
              const delay = Math.min(1000 * Math.pow(2, attempt), 5000)
              logger.warn('StreamDownload', `分片 ${task.segment.sequence} 重试 ${attempt + 1}/${retryCount} (等 ${delay}ms)`)
              await new Promise(r => setTimeout(r, delay))
            } else {
              abortCtrl.aborted = true
              throw new StreamDownloadError(StreamErrorCode.SEGMENT_FAILED, `Segment ${task.segment.sequence} failed after ${retryCount} retries: ${err}`)
            }
          }
        }
      }

      await this.runWithConcurrency(tasks, downloadSegment, concurrency)

      if (abortCtrl.aborted) {
        throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
      }

      const failedTasks = tasks.filter(t => !t.downloaded)
      if (failedTasks.length > 0) {
        throw new StreamDownloadError(StreamErrorCode.SEGMENT_FAILED, `${failedTasks.length}/${tasks.length} segments failed to download`)
      }

      // Phase 2.5: 下载音频分片（DASH 独立音频轨）
      let audioTasks: SegmentTask[] | undefined
      if (dashAudioSegments && dashAudioSegments.length > 0) {
        logger.info('StreamDownload', `开始下载音频轨: ${dashAudioSegments.length} 分片`)

        audioTasks = dashAudioSegments.map((seg, i) => ({
          segment: seg,
          tempPath: path.join(tempDir, `audio-seg-${String(i).padStart(5, '0')}.m4s`),
          downloaded: false,
          size: 0,
          retries: 0
        }))

        let audioCompletedCount = 0
        const downloadAudioSegment = async (task: SegmentTask): Promise<void> => {
          if (abortCtrl.aborted) return

          for (let attempt = 0; attempt <= retryCount; attempt++) {
            if (abortCtrl.aborted) return

            try {
              const size = await this.fetchSegment(
                task.segment.url, task.tempPath, headers, segmentTimeout, abortCtrl, requestSession
              )
              task.downloaded = true
              task.size = size
              downloadedBytes += size
              audioCompletedCount++

              const now = Date.now()
              const elapsed = (now - lastSpeedCalcTime) / 1000
              if (elapsed >= 0.5) {
                currentSpeed = (downloadedBytes - lastSpeedCalcBytes) / elapsed
                lastSpeedCalcTime = now
                lastSpeedCalcBytes = downloadedBytes
              }

              emitProgress({
                phase: 'downloading',
                downloadedSegments: completedCount + audioCompletedCount,
                totalSegments: tasks.length + audioTasks!.length,
                downloadedBytes,
                speed: currentSpeed,
                percent: 85 + Math.round((audioCompletedCount / audioTasks!.length) * 10),
                duration
              })
              return
            } catch (err) {
              if (abortCtrl.aborted) {
                throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
              }
              task.retries++
              if (attempt < retryCount) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000)
                logger.warn('StreamDownload', `音频分片 ${task.segment.sequence} 重试 ${attempt + 1}/${retryCount}`)
                await new Promise(r => setTimeout(r, delay))
              } else {
                abortCtrl.aborted = true
                throw new StreamDownloadError(
                  StreamErrorCode.SEGMENT_FAILED,
                  `Audio segment ${task.segment.sequence} failed after ${retryCount} retries: ${err}`
                )
              }
            }
          }
        }

        await this.runWithConcurrency(audioTasks, downloadAudioSegment, concurrency)

        if (abortCtrl.aborted) {
          throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
        }

        const failedAudioTasks = audioTasks.filter(t => !t.downloaded)
        if (failedAudioTasks.length > 0) {
          throw new StreamDownloadError(
            StreamErrorCode.SEGMENT_FAILED,
            `${failedAudioTasks.length}/${audioTasks.length} audio segments failed to download`
          )
        }
      }

      // Phase 3: 合并分片
      const totalSegmentCount = tasks.length + (audioTasks?.length ?? 0)
      emitProgress({
        phase: 'merging',
        downloadedSegments: totalSegmentCount,
        totalSegments: totalSegmentCount,
        downloadedBytes,
        speed: 0,
        percent: 95,
        duration
      })

      let initSegmentPath: string | undefined
      if (initSegmentUrl) {
        initSegmentPath = path.join(tempDir, 'init-segment.mp4')
        try {
          await this.fetchSegment(initSegmentUrl, initSegmentPath, headers, segmentTimeout, abortCtrl, requestSession)
        } catch (err) {
          throw new StreamDownloadError(
            StreamErrorCode.SEGMENT_FAILED,
            `Init segment download failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      const outputPath = options.outputPath
        ? getUniquePath(this.validateOutputPath(options.outputPath))
        : getUniquePath(path.join(
          outputDir,
          normalizeDownloadFilename(options.filename ?? '', this.inferFilename(options.url, duration))
        ))

      if (audioTasks && audioTasks.length > 0) {
        const videoTempPath = path.join(tempDir, 'video_only.mp4')
        const audioTempPath = path.join(tempDir, 'audio_only.m4a')

        await this.mergeSegments(tasks, videoTempPath, initSegmentPath, abortCtrl)

        let audioInitPath: string | undefined
        if (dashAudioInitUrl) {
          audioInitPath = path.join(tempDir, 'audio-init-segment.mp4')
          try {
            await this.fetchSegment(dashAudioInitUrl, audioInitPath, headers, segmentTimeout, abortCtrl, requestSession)
          } catch (err) {
            throw new StreamDownloadError(
              StreamErrorCode.SEGMENT_FAILED,
              `Audio init segment download failed: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
        await this.mergeSegments(audioTasks, audioTempPath, audioInitPath, abortCtrl)

        logger.info('StreamDownload', 'ffmpeg remux: 合并音视频轨')
        await this.remuxWithFFmpeg(videoTempPath, audioTempPath, outputPath, abortCtrl)
        logger.info('StreamDownload', '音视频合并完成')
      } else {
        await this.mergeSegments(tasks, outputPath, initSegmentPath, abortCtrl)
      }
      if (abortCtrl.aborted) {
        throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
      }

      const totalSize = fs.statSync(outputPath).size
      const elapsedMs = Date.now() - startTime

      // Phase 4: 完成
      emitProgress({
        phase: 'completed',
        downloadedSegments: totalSegmentCount,
        totalSegments: totalSegmentCount,
        downloadedBytes: totalSize,
        speed: 0,
        percent: 100,
        outputPath,
        totalSize,
        duration
      })

      logger.info('StreamDownload', `完成: ${outputPath} (${totalSegmentCount} 分片, ${formatBytes(totalSize)}, ${(elapsedMs / 1000).toFixed(1)}s)`)

      return {
        success: true,
        downloadId,
        data: {
          filePath: outputPath,
          size: totalSize,
          duration,
          segmentCount: totalSegmentCount,
          elapsedMs
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      const errorCode = error instanceof StreamDownloadError ? error.code : undefined
      logger.error('StreamDownload', `失败: ${errorCode || 'UNKNOWN'} ${errorMsg}`)

      this.emitProgress(downloadId, {
        phase: 'failed',
        downloadedSegments: 0,
        totalSegments: 0,
        downloadedBytes: 0,
        speed: 0,
        percent: 0,
        error: errorMsg,
        errorCode
      })

      return { success: false, downloadId, error: errorMsg, errorCode }
    } finally {
      options.signal?.removeEventListener('abort', abortFromSignal)
      this.activeDownloads.delete(downloadId)
      this.cleanupTempDir(tempDir)
    }
  }

  /**
   * 取消正在进行的下载
   */
  abort(downloadId: string): boolean {
    const ctrl = this.activeDownloads.get(downloadId)
    if (!ctrl) return false
    ctrl.aborted = true
    for (const request of ctrl.requests) {
      try { request.abort() } catch { /* request may already be closed */ }
    }
    ctrl.requests.clear()
    return true
  }

  // ========== 内部方法 ==========

  /**
   * 智能解析请求头：优先使用用户传入的，其次从 ResourceHub / ResourceDetection 继承
   */
  private async resolveHeaders(options: StreamDownloadOptions): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}

    if (options.viewId) {
      try {
        const hub = getResourceHubService()
        const matchingResource = hub.getResourceByUrl(options.viewId, options.url)
        const streamCategory: ResourceCategory = /\.mpd(\?|#|$)/i.test(options.url) ? 'dash' : 'hls'
        const fallbackResource = hub.getResources(options.viewId, {
          category: streamCategory,
          limit: 10
        })[0]

        if (matchingResource?.requestHeaders) {
          Object.assign(headers, matchingResource.requestHeaders)
        } else if (fallbackResource?.requestHeaders) {
          Object.assign(headers, fallbackResource.requestHeaders)
        } else {
          const service = getResourceDetectionService()
          const resources = service.getResources(options.viewId, { category: streamCategory, limit: 10 })
          const legacyMatch = resources.find(r => r.url === options.url)
          if (legacyMatch?.requestHeaders) {
            Object.assign(headers, legacyMatch.requestHeaders)
          }
        }
      } catch (err) {
        logger.warn('StreamDownload', '从资源检测链继承 headers 失败:', err)
      }
    }

    if (!headers['Referer'] && options.url) {
      try {
        const urlObj = new URL(options.url)
        headers['Referer'] = urlObj.origin + '/'
      } catch (err) {
        logger.debug('StreamDownload', 'URL 解析失败, 跳过 Referer:', options.url)
      }
    }

    if (options.headers) {
      Object.assign(headers, options.headers)
    }

    logger.info('StreamDownload', `[Headers诊断] 最终 headers keys: ${JSON.stringify(Object.keys(headers))}`)
    if (headers['Referer']) {
      logger.info('StreamDownload', `[Headers诊断] Referer: ${headers['Referer']}`)
    }

    return headers
  }

  private validateOutputPath(outputPath: string): string {
    const resolved = path.resolve(outputPath)
    if (!isPathSafe(resolved)) {
      throw new StreamDownloadError(StreamErrorCode.NETWORK_ERROR, 'Output path is outside the allowed downloads directory')
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    return resolved
  }

  /**
   * Master Playlist 质量选择
   */
  private static readonly QUALITY_ALIASES: Record<string, number> = {
    '4k': 2160, 'uhd': 2160, '2160p': 2160,
    '2k': 1440, 'qhd': 1440, '1440p': 1440,
    '1080p': 1080, 'fhd': 1080, '1080': 1080,
    '720p': 720, 'hd': 720, '720': 720,
    '480p': 480, 'sd': 480, '480': 480,
    '360p': 360, '360': 360,
    '240p': 240, '240': 240,
    '144p': 144, '144': 144
  }

  private selectVariant(
    variants: StreamVariant[],
    quality?: 'best' | 'worst' | string
  ): StreamVariant | undefined {
    if (variants.length === 0) return undefined

    const sorted = [...variants].sort((a, b) => b.bandwidth - a.bandwidth)

    if (!quality || quality === 'best') {
      return sorted[0]
    }

    if (quality === 'worst') {
      return sorted[sorted.length - 1]
    }

    const targetHeight =
      StreamDownloadService.QUALITY_ALIASES[quality.toLowerCase()] ??
      parseInt(quality, 10)

    if (!isNaN(targetHeight) && targetHeight > 0) {
      const withHeight = sorted
        .map(v => {
          const h = parseInt(v.resolution?.split('x')[1] || '0', 10)
          return { variant: v, height: h }
        })
        .filter(x => x.height > 0)

      if (withHeight.length > 0) {
        const exact = withHeight.find(x => x.height === targetHeight)
        if (exact) return exact.variant

        withHeight.sort((a, b) =>
          Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight)
        )
        return withHeight[0].variant
      }
    }

    const resMatch = sorted.find(v =>
      v.resolution?.toLowerCase().includes(quality.toLowerCase())
    )
    return resMatch || sorted[0]
  }

  /**
   * 下载单个分片到临时文件
   */
  private fetchSegment(
    url: string,
    tempPath: string,
    headers: Record<string, string>,
    timeout: number,
    abortCtrl: ActiveDownloadContext,
    requestSession?: Electron.Session
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = net.request(buildNetRequestOptions(url, requestSession))
      abortCtrl.requests.add(request)

      for (const [key, value] of Object.entries(headers)) {
        request.setHeader(key, value)
      }

      const writeStream = fs.createWriteStream(tempPath)
      let size = 0
      let settled = false

      const untrackRequest = () => {
        abortCtrl.requests.delete(request)
      }

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          untrackRequest()
          fn()
        }
      }

      if (abortCtrl.aborted) {
        settle(() => {
          try { request.abort() } catch { /* request may already be aborted */ }
          writeStream.destroy()
          reject(new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted'))
        })
        return
      }

      writeStream.on('error', (err) => {
        clearTimeout(timeoutId)
        settle(() => {
          try { request.abort() } catch { /* request may already be aborted */ }
          reject(err)
        })
      })

      const timeoutId = setTimeout(() => {
        settle(() => {
          try { request.abort() } catch { /* request may already be aborted */ }
          writeStream.destroy()
          reject(new StreamDownloadError(StreamErrorCode.DOWNLOAD_TIMEOUT, `Segment timeout (${timeout}ms)`))
        })
      }, timeout)

      request.on('response', (response: Electron.IncomingMessage) => {
        if (response.statusCode >= 400) {
          clearTimeout(timeoutId)
          logger.warn('StreamDownload', `[分片诊断] HTTP ${response.statusCode} for ${url.substring(0, 150)}`)
          settle(() => {
            try { request.abort() } catch { /* request may already be aborted */ }
            writeStream.destroy()
            reject(new StreamDownloadError(StreamErrorCode.HTTP_ERROR, `HTTP ${response.statusCode} for ${url.substring(0, 100)}`, response.statusCode))
          })
          return
        }

        response.on('data', (chunk: Buffer) => {
          if (settled || writeStream.destroyed) return
          size += chunk.length
          writeStream.write(chunk)
        })

        response.on('end', () => {
          clearTimeout(timeoutId)
          if (settled) return
          writeStream.end(() => {
            settle(() => resolve(size))
          })
        })

        response.on('error', (err: Error) => {
          clearTimeout(timeoutId)
          settle(() => {
            writeStream.destroy()
            reject(err)
          })
        })
      })

      request.on('error', (err: Error) => {
        clearTimeout(timeoutId)
        logger.warn('StreamDownload', `[分片诊断] 请求错误: ${err.message} for ${url.substring(0, 150)}`)
        settle(() => {
          writeStream.destroy()
          if (abortCtrl.aborted) {
            reject(new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted'))
          } else {
            reject(err)
          }
        })
      })

      request.end()
    })
  }

  /**
   * 并发控制器：最多 N 个任务同时执行
   */
  private async runWithConcurrency<T>(
    tasks: T[],
    executor: (task: T) => Promise<void>,
    concurrency: number
  ): Promise<void> {
    let index = 0
    const errors: Error[] = []

    const worker = async () => {
      while (index < tasks.length && errors.length === 0) {
        const currentIndex = index++
        if (currentIndex >= tasks.length) break
        try {
          await executor(tasks[currentIndex])
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)))
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, tasks.length) },
      () => worker()
    )

    await Promise.all(workers)

    if (errors.length > 0) {
      if (errors.length === 1) throw errors[0]
      const primary = errors.find(e => e instanceof StreamDownloadError) ?? errors[0]
      throw primary
    }
  }

  /**
   * 按 sequence 顺序合并分片。
   * DASH fMP4: init segment 在所有 media segment 之前写入。
   */
  private async mergeSegments(tasks: SegmentTask[], outputPath: string, initSegmentPath?: string, abortCtrl?: ActiveDownloadContext): Promise<void> {
    const sortedTasks = [...tasks].sort(
      (a, b) => a.segment.sequence - b.segment.sequence
    )

    const missingTasks = sortedTasks.filter(t => !t.downloaded || !fs.existsSync(t.tempPath))
    if (missingTasks.length > 0) {
      const missingSeqs = missingTasks.map(t => t.segment.sequence).join(', ')
      throw new StreamDownloadError(
        StreamErrorCode.MERGE_FAILED,
        `${missingTasks.length} segment(s) missing before merge (sequences: ${missingSeqs})`
      )
    }

    const writeStream = fs.createWriteStream(outputPath)

    const writeError = new Promise<never>((_, reject) => {
      writeStream.on('error', reject)
    })

    const pipeFile = (filePath: string) =>
      Promise.race([
        new Promise<void>((resolve, reject) => {
          const readStream = fs.createReadStream(filePath)
          readStream.on('error', (err) => {
            readStream.destroy()
            reject(err)
          })
          readStream.on('end', resolve)
          readStream.pipe(writeStream, { end: false })
        }),
        writeError
      ])

    try {
      if (initSegmentPath && fs.existsSync(initSegmentPath)) {
        if (abortCtrl?.aborted) throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
        await pipeFile(initSegmentPath)
      }

      for (const task of sortedTasks) {
        if (abortCtrl?.aborted) throw new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted')
        if (!task.downloaded || !fs.existsSync(task.tempPath)) continue
        await pipeFile(task.tempPath)
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end((err: Error | null) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (err) {
      writeStream.destroy()
      try { fs.unlinkSync(outputPath) } catch (cleanErr) {
        logger.warn('StreamDownload', '清理失败的输出文件失败:', cleanErr)
      }
      throw new StreamDownloadError(
        StreamErrorCode.MERGE_FAILED,
        `Merge failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * 使用 ffmpeg 将视频轨和音频轨无损合并为完整 MP4。
   * -c copy 不重编码，仅容器级 remux，速度极快。
   */
  private remuxWithFFmpeg(videoPath: string, audioPath: string, outputPath: string, abortCtrl?: ActiveDownloadContext): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpegPath = findFFmpegSync()
      if (abortCtrl?.aborted) {
        reject(new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted'))
        return
      }
      const child = execFile(ffmpegPath, [
        '-i', videoPath,
        '-i', audioPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y',
        outputPath
      ], { timeout: 5 * 60 * 1000 }, (error) => {
        if (error) {
          reject(new StreamDownloadError(
            StreamErrorCode.MERGE_FAILED,
            `ffmpeg remux failed: ${error.message}`
          ))
        } else {
          resolve()
        }
      })
      const abort = () => {
        try { child.kill('SIGTERM') } catch { /* child may have exited */ }
        reject(new StreamDownloadError(StreamErrorCode.DOWNLOAD_ABORTED, 'Download aborted'))
      }
      if (abortCtrl) {
        const timer = setInterval(() => {
          if (abortCtrl.aborted) {
            clearInterval(timer)
            abort()
          }
        }, 250)
        timer.unref?.()
        child.once('exit', () => clearInterval(timer))
      }
    })
  }

  /**
   * 从 URL 推断输出文件名
   */
  private inferFilename(url: string, duration?: number): string {
    const ext = /\.mpd(\?|#|$)/i.test(url) ? '.mp4' : '.ts'

    try {
      const urlObj = new URL(url)
      const basename = path.basename(urlObj.pathname)
        .replace(/\.(m3u8|mpd)$/i, '')
        .replace(/[^\w\-.]/g, '_')

      if (basename && basename !== '_') {
        return `${basename}${ext}`
      }
    } catch (err) {
      logger.debug('StreamDownload', 'inferFilename: URL 解析失败, 使用 fallback 文件名:', url)
    }

    const datePart = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
    const durPart = duration ? `_${Math.round(duration)}s` : ''
    return `stream_${datePart}${durPart}${ext}`
  }

  private emitProgress(downloadId: string, partial: Omit<StreamProgressEvent, 'downloadId'>): void {
    const progress: StreamProgressEvent = { downloadId, ...partial }
    this.emit('progress', progress)
  }

  private cleanupTempDir(tempDir: string): void {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (err) {
      logger.warn('StreamDownload', '清理临时目录失败:', err)
    }
  }

}

// ========== 单例 ==========

let instance: StreamDownloadService | null = null

export function getStreamDownloadService(): StreamDownloadService {
  if (!instance) {
    instance = new StreamDownloadService()
  }
  return instance
}
