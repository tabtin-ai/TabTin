/**
 * @tabtin/oss-client — 统一 OSS 直传客户端
 *
 * 提供 presign → PUT → confirm 三步直传流程的核心实现，
 * 同时支持浏览器（Electron renderer）和 Node.js（Electron main / action-tools）。
 *
 * v2 新增：
 *   - 秒传支持（computeFileHash → presign 时传 file_hash）
 *   - onProgress 回调（通过可选的 customPut 注入 XHR 等带进度的实现）
 *   - 分片上传接口设计（需后端通用分片 API 支持）
 *
 * 消费方通过 createOSSClient(config) 创建绑定了认证信息的客户端实例。
 */

import { joinApiPath } from '@tabtin/config'

// ========== Pending Confirm 类型 ==========

export interface PendingConfirm {
  objectKey: string
  fileName: string
  fileSize: number
  contentType: string
  fileHash?: string
  hashAlgorithm?: string
  organizationId?: string
  module?: string
  contextType?: string
  contextId?: string
  isPublic?: boolean
  timestamp: number
  retryCount: number
}

export interface PendingConfirmStorage {
  load(): Promise<PendingConfirm[]>
  save(items: PendingConfirm[]): Promise<void>
}

// ========== 类型 ==========

export interface OSSClientConfig {
  apiBaseUrl: string
  getToken: () => string | Promise<string>
  pendingConfirmStorage?: PendingConfirmStorage
}

export interface UploadOptions {
  folder?: string
  module?: string
  contextType?: string
  contextId?: string
  isPublic?: boolean
  signal?: AbortSignal
  maxRetries?: number
  organizationId?: string
  /**
   * 文件 hash（hex 字符串），传入后 presign 阶段支持秒传。
   * 可通过 computeFileHash() 计算。
   */
  fileHash?: string
  hashAlgorithm?: string
  /**
   * 自定义 PUT 实现，替代内置 fetch PUT。
   * 用于浏览器端 XHR 进度回调等场景。
   */
  customPut?: (presignedUrl: string, file: File | Blob, contentType: string, signal?: AbortSignal) => Promise<void>
}

export interface UploadResult {
  fileId: string
  fileName: string
  fileKey: string
  fileSize: number
  accessUrl: string
  cdnUrl: string
  /** 是否通过秒传命中 */
  instant?: boolean
}

export interface PresignOptions {
  folder?: string
  signal?: AbortSignal
  fileHash?: string
  hashAlgorithm?: string
  organizationId?: string
  module?: string
  contextType?: string
  contextId?: string
  isPublic?: boolean
}

export interface QuotaWarning {
  level: 'info' | 'warning' | 'critical'
  usage_percent: number
}

export interface PresignResult {
  objectKey: string
  presignedUrl: string
  accessUrl: string
  cdnUrl: string
  contentType: string
  expiresIn: number
  /** 秒传命中时为 true，此时无需执行 PUT + confirm */
  instant?: boolean
  /** 秒传命中时返回的完整结果 */
  instantResult?: UploadResult
  /** 后端返回的配额预警（80%/90%/95%） */
  quotaWarning?: QuotaWarning
}

export interface ConfirmOptions {
  module?: string
  contextType?: string
  contextId?: string
  signal?: AbortSignal
  organizationId?: string
  /** XC-16: 文件 hash（hex 字符串），传递给后端写入 FileRecord */
  fileHash?: string
  hashAlgorithm?: string
  isPublic?: boolean
}

export interface OSSClient {
  presign(
    fileName: string,
    fileSize: number,
    contentType: string,
    options?: PresignOptions,
  ): Promise<PresignResult>

  confirm(
    objectKey: string,
    fileName: string,
    fileSize: number,
    contentType: string,
    options?: ConfirmOptions,
  ): Promise<UploadResult>

  /**
   * 完整上传流程：presign → PUT → confirm。
   * 支持秒传（传 fileHash）和自定义 PUT（传 customPut）。
   */
  upload(
    file: File | Blob,
    fileName: string,
    options?: UploadOptions,
  ): Promise<UploadResult>

  /**
   * 重试所有待确认的上传。
   * 过滤掉超过 24 小时或重试次数 >= 3 的条目，逐个调用 confirm，
   * 成功则移除，失败则 retryCount++。
   * 仅在传入了 pendingConfirmStorage 时有效。
   */
  retryPendingConfirms(): Promise<void>
}

// ========== 错误类型 ==========

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload aborted')
    this.name = 'UploadAbortedError'
  }
}

export class StorageQuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageQuotaExceededError'
  }
}

export class BillingBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillingBlockedError'
  }
}

export class AuthExpiredError extends Error {
  constructor(message?: string) {
    super(message || 'Authentication expired, please re-login')
    this.name = 'AuthExpiredError'
  }
}

export class PermissionDeniedError extends Error {
  constructor(message?: string) {
    super(message || 'Permission denied')
    this.name = 'PermissionDeniedError'
  }
}

export class RateLimitError extends Error {
  retryAfter?: number
  constructor(message?: string, retryAfter?: number) {
    super(message || 'Rate limit exceeded, please try again later')
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter
  }
}

// ========== 内部工具 ==========

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UploadAbortedError()
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new UploadAbortedError()); return }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new UploadAbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    checkAborted(signal)
    try {
      return await fn()
    } catch (err) {
      if (err instanceof UploadAbortedError) throw err
      if (err instanceof StorageQuotaExceededError) throw err
      if (err instanceof BillingBlockedError) throw err
      if (err instanceof AuthExpiredError) throw err
      if (err instanceof PermissionDeniedError) throw err
      if (err instanceof RateLimitError) throw err
      lastError = err
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000)
        await abortableDelay(delay, signal)
      }
    }
  }
  throw lastError
}

// 统一 helper 委托 `@tabtin/config/joinApiPath`，避免行为漂移。
// （历史上 oss-client 自己实现了一份 buildUrl，跟主流派的 dev-warn 防御理念
// 不一致；2026-04-30 全仓 baseUrl 拼接收敛专题统一委托。）
function buildUrl(base: string, path: string): string {
  return joinApiPath(base, path)
}

interface ApiErrorPayload {
  message?: unknown
  error_code?: unknown
  detail?: unknown
  data?: unknown
}

const TEMPLATE_PLACEHOLDER_RE = /\{[a-zA-Z_][\w.]*\}/
const SENSITIVE_ERROR_RE = /(access[_-]?key[_-]?secret|secret[_-]?key|password|authorization|credential|security[_-]?token|token=)/i

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectStringValue(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  return stringValue((value as Record<string, unknown>)[key])
}

function redactDiagnosticText(value: string): string {
  if (!value) return ''
  return SENSITIVE_ERROR_RE.test(value) ? 'OSS 配置或权限不可用' : value
}

function resolveApiErrorMessage(payload: ApiErrorPayload, fallback: string): string {
  const rawMessage = redactDiagnosticText(stringValue(payload.message))
  const detail = redactDiagnosticText(
    stringValue(payload.detail) || objectStringValue(payload.data, 'detail'),
  )
  const errorCode = stringValue(payload.error_code) || objectStringValue(payload.data, 'error_code')

  let message = rawMessage
  if (message && detail) {
    message = message.replace(/\{detail\}/g, detail)
  }
  if (!message || TEMPLATE_PLACEHOLDER_RE.test(message)) {
    message = detail || fallback
  }

  if (
    message
    && errorCode
    && errorCode !== 'STORAGE_QUOTA_EXCEEDED'
    && !message.includes(errorCode)
  ) return `${message} (${errorCode})`
  if (message) return message
  if (errorCode) return errorCode
  return fallback
}

async function readErrorMessage(resp: Response, fallback: string): Promise<string> {
  try {
    const json = await resp.json() as ApiErrorPayload
    return resolveApiErrorMessage(json, fallback)
  } catch {
    // Response body may be empty or non-JSON.
  }
  return fallback
}

// ========== 文件 Hash（秒传） ==========

const HASH_CHUNK_SIZE = 2 * 1024 * 1024

/**
 * 计算文件 hash 用于秒传。
 *
 * 策略：文件 <= 8MB 时全量 SHA-256，> 8MB 时取首尾各 2MB + 文件大小做 SHA-256。
 * 同时支持浏览器（SubtleCrypto）和 Node.js（crypto）。
 */
export async function computeFileHash(file: File | Blob): Promise<string> {
  const size = file.size
  let buffer: ArrayBuffer

  if (size <= HASH_CHUNK_SIZE * 4) {
    buffer = await file.arrayBuffer()
  } else {
    const head = await file.slice(0, HASH_CHUNK_SIZE).arrayBuffer()
    const tail = await file.slice(size - HASH_CHUNK_SIZE).arrayBuffer()
    const sizeBytes = new TextEncoder().encode(String(size))

    const combined = new Uint8Array(head.byteLength + tail.byteLength + sizeBytes.byteLength)
    combined.set(new Uint8Array(head), 0)
    combined.set(new Uint8Array(tail), head.byteLength)
    combined.set(sizeBytes, head.byteLength + tail.byteLength)
    buffer = combined.buffer
  }

  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  // Node.js fallback
  try {
    const crypto = await import('crypto')
    return crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex')
  } catch {
    return ''
  }
}

// ========== 工厂函数 ==========

// ========== Pending Confirm 内部常量 ==========

const PENDING_CONFIRM_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PENDING_CONFIRM_MAX_RETRIES = 3

export function createOSSClient(config: OSSClientConfig): OSSClient {
  const storage = config.pendingConfirmStorage

  async function authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    checkAborted(signal)
    const token = await Promise.resolve(config.getToken())
    return {
      Authorization: token ? `Bearer ${token}` : '',
      'Content-Type': 'application/json',
    }
  }

  async function addPendingConfirm(item: PendingConfirm): Promise<void> {
    if (!storage) return
    try {
      const items = await storage.load()
      items.push(item)
      await storage.save(items)
    } catch (e) {
      console.warn('[oss-client] failed to persist pending confirm:', e)
    }
  }

  async function removePendingConfirm(objectKey: string): Promise<void> {
    if (!storage) return
    try {
      const items = await storage.load()
      await storage.save(items.filter(i => i.objectKey !== objectKey))
    } catch (e) {
      console.warn('[oss-client] failed to remove pending confirm:', e)
    }
  }

  async function presign(
    fileName: string,
    fileSize: number,
    contentType: string,
    options?: PresignOptions,
  ): Promise<PresignResult> {
    const headers = await authHeaders(options?.signal)

    const body: Record<string, unknown> = {
      filename: fileName,
      folder: options?.folder || '',
      content_type: contentType,
      file_size: fileSize,
      is_public: options?.isPublic ?? false,
    }
    if (options?.fileHash) {
      body.file_hash = options.fileHash
    }
    if (options?.hashAlgorithm) {
      body.hash_algorithm = options.hashAlgorithm
    }
    if (options?.organizationId) {
      body.organization_id = options.organizationId
    }
    if (options?.module) {
      body.module = options.module
    }
    if (options?.contextType) {
      body.context_type = options.contextType
    }
    if (options?.contextId) {
      body.context_id = options.contextId
    }

    const resp = await fetch(buildUrl(config.apiBaseUrl, '/services/oss/presign-upload'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!resp.ok) {
      if (resp.status === 401) throw new AuthExpiredError()
      if (resp.status === 403) throw new PermissionDeniedError()
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '', 10) || undefined
        throw new RateLimitError(undefined, retryAfter)
      }
      throw new Error(await readErrorMessage(resp, `Presign request failed: ${resp.status}`))
    }

    const json = await resp.json()
    if (!json.success) {
      const errorMessage = resolveApiErrorMessage(json, 'Presign request failed')
      if (json.error_code === 'STORAGE_QUOTA_EXCEEDED') {
        throw new StorageQuotaExceededError(errorMessage || 'Storage quota exceeded')
      }
      if (json.error_code === 'BILLING_BLOCKED') {
        throw new BillingBlockedError(errorMessage || 'Operation blocked due to billing anomaly')
      }
      throw new Error(errorMessage)
    }

    const d = json.data

    const quotaWarning: QuotaWarning | undefined = d.quota_warning
      ? { level: d.quota_warning.level, usage_percent: d.quota_warning.usage_percent }
      : undefined

    if (d.instant) {
      return {
        objectKey: d.file_key || d.object_key || '',
        presignedUrl: '',
        accessUrl: d.access_url,
        cdnUrl: d.cdn_url || '',
        contentType,
        expiresIn: 0,
        instant: true,
        instantResult: {
          fileId: d.file_id,
          fileName: d.file_name,
          fileKey: d.file_key,
          fileSize: d.file_size,
          accessUrl: d.access_url,
          cdnUrl: d.cdn_url || '',
          instant: true,
        },
        quotaWarning,
      }
    }

    return {
      objectKey: d.object_key,
      presignedUrl: d.presigned_url,
      accessUrl: d.access_url,
      cdnUrl: d.cdn_url,
      contentType: d.content_type,
      expiresIn: d.expires_in,
      quotaWarning,
    }
  }

  async function confirm(
    objectKey: string,
    fileName: string,
    fileSize: number,
    contentType: string,
    options?: ConfirmOptions,
  ): Promise<UploadResult> {
    const headers = await authHeaders(options?.signal)
    const confirmBody: Record<string, unknown> = {
      object_key: objectKey,
      file_name: fileName,
      file_size: fileSize,
      content_type: contentType,
      module: options?.module || 'other',
      context_type: options?.contextType || '',
      context_id: options?.contextId || '',
      is_public: options?.isPublic ?? false,
    }
    if (options?.organizationId) {
      confirmBody.organization_id = options.organizationId
    }
    // XC-16: 传递 file_hash 供后端写入 FileRecord，支持后续秒传命中
    if (options?.fileHash) {
      confirmBody.file_hash = options.fileHash
    }
    if (options?.hashAlgorithm) {
      confirmBody.hash_algorithm = options.hashAlgorithm
    }
    const resp = await fetch(buildUrl(config.apiBaseUrl, '/services/oss/confirm-upload'), {
      method: 'POST',
      headers,
      body: JSON.stringify(confirmBody),
      signal: options?.signal,
    })

    if (!resp.ok) {
      if (resp.status === 401) throw new AuthExpiredError()
      if (resp.status === 403) throw new PermissionDeniedError()
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '', 10) || undefined
        throw new RateLimitError(undefined, retryAfter)
      }
      throw new Error(await readErrorMessage(resp, `Confirm request failed: ${resp.status}`))
    }

    const json = await resp.json()
    if (!json.success) {
      const errorMessage = resolveApiErrorMessage(json, 'Confirm request failed')
      // XC-14: confirm 阶段也检查计费专项错误码
      if (json.error_code === 'STORAGE_QUOTA_EXCEEDED') {
        throw new StorageQuotaExceededError(errorMessage || 'Storage quota exceeded')
      }
      if (json.error_code === 'BILLING_BLOCKED') {
        throw new BillingBlockedError(errorMessage || 'Operation blocked due to billing anomaly')
      }
      throw new Error(errorMessage)
    }

    const d = json.data
    return {
      fileId: d.file_id,
      fileName: d.file_name,
      fileKey: d.file_key,
      fileSize: d.file_size,
      accessUrl: d.access_url,
      cdnUrl: d.cdn_url || '',
    }
  }

  async function upload(
    file: File | Blob,
    fileName: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    const contentType = (file as File).type || 'application/octet-stream'
    const maxRetries = options?.maxRetries ?? 1

    const presignResult = await withRetry(
      () => presign(fileName, file.size, contentType, {
        folder: options?.folder,
        signal: options?.signal,
        fileHash: options?.fileHash,
        hashAlgorithm: options?.hashAlgorithm,
        organizationId: options?.organizationId,
        module: options?.module,
        contextType: options?.contextType,
        contextId: options?.contextId,
        isPublic: options?.isPublic,
      }),
      maxRetries,
      options?.signal,
    )

    if (presignResult.instant && presignResult.instantResult) {
      return presignResult.instantResult
    }

    checkAborted(options?.signal)

    await withRetry(
      async () => {
        if (options?.customPut) {
          await options.customPut(
            presignResult.presignedUrl,
            file,
            presignResult.contentType || contentType,
            options.signal,
          )
        } else {
          const putResp = await fetch(presignResult.presignedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': presignResult.contentType || contentType },
            body: file,
            signal: options?.signal,
          })

          if (!putResp.ok) {
            throw new Error(`OSS PUT failed: HTTP ${putResp.status}`)
          }
        }
      },
      maxRetries,
      options?.signal,
    )

    const pendingItem: PendingConfirm = {
      objectKey: presignResult.objectKey,
      fileName,
      fileSize: file.size,
      contentType,
      fileHash: options?.fileHash,
      hashAlgorithm: options?.hashAlgorithm,
      organizationId: options?.organizationId,
      module: options?.module,
      contextType: options?.contextType,
      contextId: options?.contextId,
      isPublic: options?.isPublic,
      timestamp: Date.now(),
      retryCount: 0,
    }
    await addPendingConfirm(pendingItem)

    try {
      const result = await withRetry(
        () => confirm(presignResult.objectKey, fileName, file.size, contentType, {
          module: options?.module,
          contextType: options?.contextType,
          contextId: options?.contextId,
          signal: options?.signal,
          organizationId: options?.organizationId,
          fileHash: options?.fileHash,
          hashAlgorithm: options?.hashAlgorithm,
          isPublic: options?.isPublic,
        }),
        maxRetries,
        options?.signal,
      )
      await removePendingConfirm(presignResult.objectKey)
      return result
    } catch (confirmErr) {
      console.warn(
        '[oss-client] confirm failed after PUT succeeded, orphan object_key:',
        presignResult.objectKey,
      )
      throw confirmErr
    }
  }

  async function retryPendingConfirms(): Promise<void> {
    if (!storage) return

    let items: PendingConfirm[]
    try {
      items = await storage.load()
    } catch (e) {
      console.warn('[oss-client] failed to load pending confirms:', e)
      return
    }

    if (items.length === 0) return

    const now = Date.now()
    const remaining: PendingConfirm[] = []

    for (const item of items) {
      if (now - item.timestamp > PENDING_CONFIRM_MAX_AGE_MS) {
        console.warn('[oss-client] pending confirm expired, discarding:', item.objectKey)
        continue
      }
      if (item.retryCount >= PENDING_CONFIRM_MAX_RETRIES) {
        console.warn('[oss-client] pending confirm max retries reached, discarding:', item.objectKey)
        continue
      }

      try {
        await confirm(item.objectKey, item.fileName, item.fileSize, item.contentType, {
          module: item.module,
          contextType: item.contextType,
          contextId: item.contextId,
          organizationId: item.organizationId,
          fileHash: item.fileHash,
          hashAlgorithm: item.hashAlgorithm,
          isPublic: item.isPublic,
        })
        console.info('[oss-client] pending confirm retry succeeded:', item.objectKey)
      } catch (e) {
        console.warn(
          `[oss-client] pending confirm retry failed (${item.retryCount + 1}/${PENDING_CONFIRM_MAX_RETRIES}):`,
          item.objectKey, e,
        )
        remaining.push({ ...item, retryCount: item.retryCount + 1 })
      }
    }

    try {
      await storage.save(remaining)
    } catch (e) {
      console.warn('[oss-client] failed to save pending confirms after retry:', e)
    }
  }

  return { presign, confirm, upload, retryPendingConfirms }
}
