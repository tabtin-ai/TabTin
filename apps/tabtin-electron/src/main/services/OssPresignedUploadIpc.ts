import type { IpcMainInvokeEvent } from 'electron'
import { Readable } from 'node:stream'
import { okResponse, errResponse } from '@tabtin/agent-wire'

import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'
import { API_BASE_URL } from '../config/api'
import {
  OSS_CANCEL_PRESIGNED_DOWNLOAD_CHANNEL,
  OSS_CANCEL_PRESIGNED_OBJECT_CHANNEL,
  OSS_GET_PRESIGNED_OBJECT_CHANNEL,
  OSS_PRESIGNED_DOWNLOAD_MAX_BYTES,
  OSS_PUT_PRESIGNED_OBJECT_CHANNEL,
  OSS_PUT_PRESIGNED_OBJECT_PROGRESS_CHANNEL,
  TRUSTED_ASSET_CDN_HOST,
  type OssGetPresignedObjectPayload,
  type OssGetPresignedObjectResult,
  type OssPutPresignedObjectPayload,
  type OssPutPresignedObjectProgress,
  type OssPutPresignedObjectResult,
} from '../../shared/oss-presigned-upload-ipc'

const log = createLogger('OssUpload')

const UPLOAD_PROGRESS_CHUNK_SIZE_BYTES = 256 * 1024
const ALIYUN_OSS_ENDPOINT_HOST_RE = /^oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/
const ALIYUN_OSS_BUCKET_HOST_RE = /^[a-z0-9][a-z0-9.-]*\.oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/
const LOCAL_OSS_UPLOAD_PATH = '/api/services/oss/local-upload'
const LOCAL_OSS_DOWNLOAD_PATH = '/api/services/oss/local-object'
const PRESIGNED_DOWNLOAD_TIMEOUT_MS = 60_000

const activeUploads = new Map<string, AbortController>()
const activeDownloads = new Map<string, AbortController>()

class OssDownloadTooLargeError extends Error {}

export async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number = OSS_PRESIGNED_DOWNLOAD_MAX_BYTES,
  onLimitExceeded?: () => void,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader()
  if (!reader) return new ArrayBuffer(0)

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        onLimitExceeded?.()
        void reader.cancel().catch(() => {})
        throw new OssDownloadTooLargeError('OSS object exceeds preview limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged.buffer
}

type OssUploadLogStage = 'started' | 'completed' | 'http_failed' | 'network_failed' | 'cancelled'

interface OssUploadLogFields {
  uploadId: string
  stage: OssUploadLogStage
  status?: number
  durationMs?: number
  causeCode?: string
}

function normalizeLogToken(value: string, fallback: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : fallback
}

export function getOssNetworkCauseCode(error: unknown): string {
  const cause = error instanceof Error
    ? (error as Error & { cause?: { code?: unknown; errno?: unknown; syscall?: unknown } }).cause
    : undefined
  return typeof cause?.code === 'string'
    ? normalizeLogToken(cause.code, 'UNKNOWN')
    : 'UNKNOWN'
}

export function formatOssUploadLog(fields: OssUploadLogFields): string {
  const parts = [
    'oss-put',
    `stage=${fields.stage}`,
    `uploadId=${normalizeLogToken(fields.uploadId, 'invalid')}`,
  ]
  if (Number.isInteger(fields.status)) {
    parts.push(`status=${fields.status}`)
  }
  if (typeof fields.durationMs === 'number' && Number.isFinite(fields.durationMs)) {
    parts.push(`durationMs=${Math.max(0, Math.floor(fields.durationMs))}`)
  }
  if (fields.causeCode) {
    parts.push(`causeCode=${normalizeLogToken(fields.causeCode, 'UNKNOWN')}`)
  }
  return parts.join(' ')
}

interface PresignedUrlValidationOptions {
  apiBaseUrl?: string
  isPackaged?: boolean
}

function isConfiguredApiEndpoint(
  url: URL,
  expectedPath: string,
  apiBaseUrl: string,
): boolean {
  if (url.username || url.password || url.pathname !== expectedPath) return false
  try {
    return url.origin === new URL(apiBaseUrl).origin
  } catch {
    return false
  }
}

/** Accept the configured API upload endpoint or a standard Aliyun HTTPS URL. */
export function validatePresignedUrl(
  rawUrl: string,
  options: PresignedUrlValidationOptions = {},
): URL | null {
  try {
    const url = new URL(rawUrl)
    if (isConfiguredApiEndpoint(
      url,
      LOCAL_OSS_UPLOAD_PATH,
      options.apiBaseUrl ?? API_BASE_URL,
    )) {
      return url
    }
    if (url.username || url.password) return null
    if (url.protocol !== 'https:') return null
    if (url.port && url.port !== '443') return null
    const hostname = url.hostname.toLowerCase()
    return ALIYUN_OSS_ENDPOINT_HOST_RE.test(hostname) || ALIYUN_OSS_BUCKET_HOST_RE.test(hostname)
      ? url
      : null
  } catch {
    return null
  }
}

/** Allow the configured API object endpoint in dev and packaged builds. */
export function validatePresignedDownloadUrl(
  rawUrl: string,
  options: PresignedUrlValidationOptions = {},
): URL | null {
  try {
    const url = new URL(rawUrl)
    if (url.username || url.password) return null
    const hostname = url.hostname.toLowerCase()
    if (isConfiguredApiEndpoint(
      url,
      LOCAL_OSS_DOWNLOAD_PATH,
      options.apiBaseUrl ?? API_BASE_URL,
    )) {
      return url
    }
    if (url.protocol !== 'https:') return null
    if (url.port && url.port !== '443') return null
    if (
      hostname === TRUSTED_ASSET_CDN_HOST
      || ALIYUN_OSS_ENDPOINT_HOST_RE.test(hostname)
      || ALIYUN_OSS_BUCKET_HOST_RE.test(hostname)
    ) {
      return url
    }
    return null
  } catch {
    return null
  }
}

function isValidDownloadPayload(payload: unknown): payload is OssGetPresignedObjectPayload {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as OssGetPresignedObjectPayload
  return (
    typeof candidate.requestId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(candidate.requestId)
    && typeof candidate.presignedUrl === 'string'
    && candidate.presignedUrl.length > 0
  )
}

function isValidPayload(payload: unknown): payload is OssPutPresignedObjectPayload {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as OssPutPresignedObjectPayload
  return (
    typeof candidate.uploadId === 'string'
    && candidate.uploadId.length > 0
    && typeof candidate.presignedUrl === 'string'
    && candidate.presignedUrl.length > 0
    && candidate.data instanceof ArrayBuffer
    && (candidate.contentType === undefined || typeof candidate.contentType === 'string')
  )
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function createUploadStream(
  buffer: Buffer,
  onProgress: (loaded: number) => void,
): Readable {
  let offset = 0
  return new Readable({
    read() {
      if (offset >= buffer.length) {
        this.push(null)
        return
      }
      const nextOffset = Math.min(offset + UPLOAD_PROGRESS_CHUNK_SIZE_BYTES, buffer.length)
      const chunk = buffer.subarray(offset, nextOffset)
      offset = nextOffset
      onProgress(offset)
      this.push(chunk)
    },
  })
}

export function registerOssPresignedUploadIpc(): void {
  guardedHandle(OSS_CANCEL_PRESIGNED_DOWNLOAD_CHANNEL, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string' || !requestId) {
      return errResponse('INVALID_ARGUMENT', 'requestId is required')
    }
    const controller = activeDownloads.get(requestId)
    if (controller) controller.abort()
    return okResponse({ cancelled: Boolean(controller) })
  })

  guardedHandle(OSS_GET_PRESIGNED_OBJECT_CHANNEL, async (_event, payload: unknown) => {
    if (!isValidDownloadPayload(payload)) {
      return errResponse('INVALID_ARGUMENT', 'Invalid OSS download payload')
    }
    const url = validatePresignedDownloadUrl(payload.presignedUrl)
    if (!url) {
      return errResponse('INVALID_ARGUMENT', 'Invalid OSS download URL')
    }
    if (activeDownloads.has(payload.requestId)) {
      return errResponse('CONFLICT', 'OSS download request already active')
    }

    const controller = new AbortController()
    activeDownloads.set(payload.requestId, controller)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, PRESIGNED_DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      })
      const contentLength = Number(response.headers.get('content-length') || 0)
      if (contentLength > OSS_PRESIGNED_DOWNLOAD_MAX_BYTES) {
        controller.abort()
        void response.body?.cancel().catch(() => {})
        return errResponse('PAYLOAD_TOO_LARGE', 'OSS object exceeds preview limit')
      }
      if (!response.ok) {
        return errResponse('HTTP_ERROR', `OSS download failed with HTTP ${response.status}`)
      }
      const data = await readResponseBodyWithLimit(
        response,
        OSS_PRESIGNED_DOWNLOAD_MAX_BYTES,
        () => controller.abort(),
      )
      return okResponse<OssGetPresignedObjectResult>({
        status: response.status,
        headers: responseHeadersToRecord(response.headers),
        data,
      })
    } catch (error) {
      if (error instanceof OssDownloadTooLargeError) {
        return errResponse('PAYLOAD_TOO_LARGE', 'OSS object exceeds preview limit')
      }
      if (controller.signal.aborted) {
        return errResponse(
          timedOut ? 'TIMEOUT' : 'ABORTED',
          timedOut ? 'OSS download timed out' : 'OSS download cancelled',
        )
      }
      log.warn(`oss-get stage=network_failed causeCode=${getOssNetworkCauseCode(error)}`)
      return errResponse('NETWORK_ERROR', 'OSS download failed')
    } finally {
      clearTimeout(timeout)
      activeDownloads.delete(payload.requestId)
    }
  })

  guardedHandle(OSS_CANCEL_PRESIGNED_OBJECT_CHANNEL, (_event, uploadId: unknown) => {
    if (typeof uploadId !== 'string' || !uploadId) {
      return errResponse('INVALID_ARGUMENT', 'uploadId is required')
    }

    const controller = activeUploads.get(uploadId)
    if (controller) {
      controller.abort()
      activeUploads.delete(uploadId)
    }
    return okResponse({ cancelled: Boolean(controller) })
  })

  guardedHandle(OSS_PUT_PRESIGNED_OBJECT_CHANNEL, async (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ) => {
    if (!isValidPayload(payload)) {
      return errResponse('INVALID_ARGUMENT', 'Invalid OSS upload payload')
    }

    const url = validatePresignedUrl(payload.presignedUrl)
    if (!url) {
      return errResponse('INVALID_ARGUMENT', 'Invalid OSS presigned URL')
    }

    if (activeUploads.has(payload.uploadId)) {
      return errResponse('CONFLICT', `Upload already active: ${payload.uploadId}`)
    }

    const controller = new AbortController()
    activeUploads.set(payload.uploadId, controller)
    const startedAt = Date.now()

    try {
      const buffer = Buffer.from(payload.data)
      const total = buffer.length
      log.info(formatOssUploadLog({
        uploadId: payload.uploadId,
        stage: 'started',
      }))
      const headers: Record<string, string> = {
        'Content-Length': String(total),
      }
      if (payload.contentType) {
        headers['Content-Type'] = payload.contentType
      }

      const stream = createUploadStream(buffer, (loaded) => {
        const progress: OssPutPresignedObjectProgress = {
          uploadId: payload.uploadId,
          loaded,
          total,
        }
        event.sender.send(OSS_PUT_PRESIGNED_OBJECT_PROGRESS_CHANNEL, progress)
      })

      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body: stream as unknown as BodyInit,
        duplex: 'half',
        signal: controller.signal,
      } as RequestInit & { duplex: 'half' })

      if (!response.ok) {
        log.warn(formatOssUploadLog({
          uploadId: payload.uploadId,
          stage: 'http_failed',
          status: response.status,
          durationMs: Date.now() - startedAt,
        }))
      } else {
        log.info(formatOssUploadLog({
          uploadId: payload.uploadId,
          stage: 'completed',
          status: response.status,
          durationMs: Date.now() - startedAt,
        }))
      }

      return okResponse<OssPutPresignedObjectResult>({
        status: response.status,
        headers: responseHeadersToRecord(response.headers),
      })
    } catch (error) {
      const code = controller.signal.aborted ? 'ABORTED' : 'NETWORK_ERROR'
      // 用户主动取消 (ABORTED) 属正常流程，仅 debug；真实网络失败 warn
      if (code === 'ABORTED') {
        log.debug(formatOssUploadLog({
          uploadId: payload.uploadId,
          stage: 'cancelled',
          durationMs: Date.now() - startedAt,
        }))
      } else {
        log.warn(formatOssUploadLog({
          uploadId: payload.uploadId,
          stage: 'network_failed',
          durationMs: Date.now() - startedAt,
          causeCode: getOssNetworkCauseCode(error),
        }))
      }
      return errResponse(
        code,
        code === 'ABORTED' ? 'OSS upload cancelled' : 'OSS upload network failure',
      )
    } finally {
      activeUploads.delete(payload.uploadId)
    }
  })
}
