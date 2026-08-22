/**
 * Electron 端统一 OSS 直传服务
 *
 * 基于 @tabtin/oss-client 共享包，在浏览器环境下增加 XHR 进度回调。
 * 所有前端模块（Chat、TabChat、TabDoc、TabSlide、Crawl）
 * 的文件/图片/媒体上传统一入口。
 *
 * v2 新增：
 *   - 秒传支持：自动计算 file hash，重复文件免上传
 *   - 进度回调：通过 XHR upload.progress 事件提供实时进度
 */

import { API_CONFIG } from '@/config/api'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useAuthStore } from '@/stores/useAuthStore'
import {
  createOSSClient,
  computeFileHash,
  withRetry,
  UploadAbortedError,
  StorageQuotaExceededError,
  BillingBlockedError,
  type OSSClient,
  type UploadResult,
  type QuotaWarning,
  type PendingConfirmStorage,
  type PendingConfirm,
} from '@tabtin/oss-client'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { createLogger } from '@/utils/logger'
import {
  MainProcessOssUploadTimeoutError,
  MainProcessOssUploadUnavailableError,
  putPresignedObjectViaMainProcess,
} from './mainProcessOssUploader'

const log = createLogger('OssUpload')

// ========== 重导出核心类型 ==========

export { UploadAbortedError, StorageQuotaExceededError, BillingBlockedError, AuthExpiredError, PermissionDeniedError, RateLimitError, computeFileHash } from '@tabtin/oss-client'
export type { UploadResult } from '@tabtin/oss-client'

export type DirectUploadResult = UploadResult

export interface DirectUploadOptions {
  folder?: string
  module?: string
  contextType?: string
  contextId?: string
  onProgress?: (progress: number) => void
  signal?: AbortSignal
  maxRetries?: number
  /**
   * 启用秒传：计算文件 hash 并发送给后端。
   * 若后端已有相同 hash 的文件，跳过上传直接返回。
   * 默认 true。
   */
  enableInstantUpload?: boolean
  /**
   * 组织 ID，用于存储计量和配额校验。
   * 不传时自动从 organization store 获取当前组织 ID。
   */
  organizationId?: string
  isPublic?: boolean
}

export interface DirectBatchUploadResult {
  total: number
  successCount: number
  failedCount: number
  results: Array<DirectUploadResult & { success: boolean; error?: string }>
  quotaExceeded?: boolean
  billingBlocked?: boolean
}

/** 兼容旧 oss-batch-uploader 的类型 */
export interface UploadFileItem {
  blob: Blob
  fileName: string
  originalUrl?: string
}

// ========== Token 获取（Electron 特有） ==========

async function getAuthToken(): Promise<string> {
  // contract W2-β：IPC 失败 / 无 token 走 useAuthStore fallback。
  // 这是有意的双层兜底——主进程 keychain 偶发挂掉时仍能用 renderer 端缓存的 token 完成上传，
  // 避免上传任务因为 IPC 闪断而 fail。
  try {
    const result = await window.tabtin.auth.getAccessToken()
    if (result?.token) {
      return result.token
    }
  } catch {
    // 静默 fail-soft，下面 fallback 到 store
  }

  try {
    return useAuthStore.getState().accessToken || ''
  } catch {
    return ''
  }
}

// ========== Pending Confirm localStorage 存储 ==========

const PENDING_CONFIRM_STORAGE_KEY = 'oss_pending_confirms'

const pendingConfirmStorage: PendingConfirmStorage = {
  async load(): Promise<PendingConfirm[]> {
    try {
      return JSON.parse(localStorage.getItem(PENDING_CONFIRM_STORAGE_KEY) || '[]')
    } catch {
      return []
    }
  },
  async save(items: PendingConfirm[]): Promise<void> {
    if (items.length === 0) {
      localStorage.removeItem(PENDING_CONFIRM_STORAGE_KEY)
    } else {
      localStorage.setItem(PENDING_CONFIRM_STORAGE_KEY, JSON.stringify(items))
    }
  },
}

async function addPendingConfirm(item: PendingConfirm): Promise<void> {
  try {
    const items = await pendingConfirmStorage.load()
    await pendingConfirmStorage.save([...items, item])
  } catch (error) {
    log.warn('failed to persist pending confirm:', error)
  }
}

async function removePendingConfirm(objectKey: string): Promise<void> {
  try {
    const items = await pendingConfirmStorage.load()
    await pendingConfirmStorage.save(items.filter(item => item.objectKey !== objectKey))
  } catch (error) {
    log.warn('failed to remove pending confirm:', error)
  }
}

// ── storage-manager 接入（W2.2 G3）──────────────────────────────
//
// `oss:pending-confirms` 是上传链路的尾端兜底：
//   - OSS PUT 完成但 confirm API 失败的条目落在 localStorage，
//     App 启动时 retryPendingConfirms() 自动重试。
//   - category=data 是因为"清掉=后端可能成 orphan blob"，用户应该意识到。
//   - 正常业务下此桶应为空，只有上传失败时才有条目。
if (!getBucket('oss:pending-confirms')) {
  const CONFIRM_AVG_BYTES = 512
  registerStorageBucket({
    id: 'oss:pending-confirms',
    category: 'data',
    group: 'system',
    displayName: '待确认上传',
    description:
      '文件已成功上传到云端但未关联到对话或文件列表，App 启动时会自动重试关联。正常情况下此项应为空。',
    warnings: [
      '清理后本地不再重试关联，这些已上传的文件会在云端永久滞留（占用存储配额但任何人都看不到）',
      '若长期非空，建议先检查网络 / 重新登录让重试完成，只有确实需要放弃时才清理',
    ],
    requiresConfirmation: 'hard',
    sizeFn: async () => {
      try {
        const raw = localStorage.getItem(PENDING_CONFIRM_STORAGE_KEY) || '[]'
        const arr = JSON.parse(raw) as PendingConfirm[]
        const count = Array.isArray(arr) ? arr.length : 0
        // 用 TextEncoder 拿 UTF-8 真实字节数；String.length 对中文文件名偏小。
        const bytes =
          typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(raw).length
            : count * CONFIRM_AVG_BYTES
        return { bytes, itemCount: count }
      } catch {
        return { bytes: 0, itemCount: 0 }
      }
    },
    listFn: async () => {
      try {
        const raw = localStorage.getItem(PENDING_CONFIRM_STORAGE_KEY) || '[]'
        const arr = JSON.parse(raw) as PendingConfirm[]
        if (!Array.isArray(arr)) return []
        return arr.map((item, idx) => ({
          id: String((item as { objectKey?: string }).objectKey ?? idx),
          label: String(
            (item as { fileName?: string; objectKey?: string }).fileName ??
              (item as { objectKey?: string }).objectKey ??
              `pending-${idx}`,
          ),
          bytes: CONFIRM_AVG_BYTES,
          metadata: item as unknown as Record<string, unknown>,
        }))
      } catch {
        return []
      }
    },
    clearFn: async (options) => {
      let count = 0
      try {
        const raw = localStorage.getItem(PENDING_CONFIRM_STORAGE_KEY) || '[]'
        const arr = JSON.parse(raw) as PendingConfirm[]
        count = Array.isArray(arr) ? arr.length : 0
      } catch {
        /* ignore */
      }
      if (options?.dryRun) {
        return { clearedItemCount: count, freedBytes: count * CONFIRM_AVG_BYTES }
      }
      localStorage.removeItem(PENDING_CONFIRM_STORAGE_KEY)
      return { clearedItemCount: count, freedBytes: count * CONFIRM_AVG_BYTES }
    },
  })
}

// ========== 懒初始化客户端 ==========

let _client: OSSClient | null = null

function getClient(): OSSClient {
  if (!_client) {
    _client = createOSSClient({
      apiBaseUrl: API_CONFIG.baseURL,
      getToken: getAuthToken,
      pendingConfirmStorage,
    })
  }
  return _client
}

/**
 * 重试所有待确认的上传。App 启动时调用。
 */
export function retryPendingConfirms(): void {
  const client = getClient()
  client.retryPendingConfirms().catch((e) => {
    log.warn('retryPendingConfirms failed:', e)
  })
}

// ========== 超时计算 ==========

const UPLOAD_TIMEOUT_BASE_MS = 30_000
const UPLOAD_TIMEOUT_PER_MB_MS = 10_000
const UPLOAD_TIMEOUT_MAX_MS = 600_000
const DEFAULT_PRESIGN_EXPIRY_HINT_MS = 240_000

function calculateUploadTimeout(fileSize: number): number {
  const sizeMB = fileSize / (1024 * 1024)
  return Math.min(
    UPLOAD_TIMEOUT_BASE_MS + Math.ceil(sizeMB) * UPLOAD_TIMEOUT_PER_MB_MS,
    UPLOAD_TIMEOUT_MAX_MS,
  )
}

function calculatePresignExpiryHint(expiresIn?: number): number {
  if (expiresIn && expiresIn > 60) {
    return (expiresIn - 60) * 1000
  }
  return DEFAULT_PRESIGN_EXPIRY_HINT_MS
}

// ========== 主进程 OSS PUT（带进度） ==========

async function putToOSSWithProgress(
  presignedUrl: string,
  file: File | Blob,
  contentType: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  presignExpiryHintMs?: number,
): Promise<void> {
  const expiryHint = presignExpiryHintMs ?? DEFAULT_PRESIGN_EXPIRY_HINT_MS
  const startedAt = Date.now()

  if (signal?.aborted) throw new UploadAbortedError()

  try {
    const result = await putPresignedObjectViaMainProcess({
      presignedUrl,
      body: file,
      contentType,
      signal,
      timeoutMs: calculateUploadTimeout(file.size),
      onProgress: (loaded, total) => {
        if (total > 0) {
          onProgress?.(Math.min(1, loaded / total))
        }
      },
    })

    if (result.status >= 200 && result.status < 300) {
      onProgress?.(1)
      return
    }

    const elapsed = Date.now() - startedAt
    if (result.status === 403 && elapsed > expiryHint) {
      throw new Error(i18n.t('chat:upload.presignExpired', {
        defaultValue: '上传失败：签名链接已过期，请重新上传文件（大文件在弱网环境下容易超时）',
      }))
    }
    const bodyText = result.bodyText ? `: ${result.bodyText.slice(0, 500)}` : ''
    throw new Error(i18n.t('chat:upload.httpError', {
      defaultValue: `OSS 上传失败: HTTP ${result.status}`,
      status: result.status,
    }) + bodyText)
  } catch (error) {
    if (signal?.aborted) throw new UploadAbortedError()
    if (error instanceof MainProcessOssUploadTimeoutError) {
      throw new Error(i18n.t('chat:upload.timeout', {
        defaultValue: '上传超时：网络速度过慢或连接已中断，请检查网络后重试',
      }))
    }
    if (error instanceof MainProcessOssUploadUnavailableError) {
      throw new Error(i18n.t('chat:upload.mainUploaderUnavailable', {
        defaultValue: '主进程上传通道不可用，请重启应用后重试',
      }))
    }
    throw error instanceof Error
      ? error
      : new Error(i18n.t('chat:upload.networkError', {
        defaultValue: 'OSS 上传网络错误',
      }))
  }
}

// ========== organization 自动注入 ==========

function resolveOrganizationId(explicit?: string): string | undefined {
  if (explicit) return explicit
  try {
    return useOrganizationStore.getState().getEffectiveOrganizationId() ?? undefined
  } catch {
    return undefined
  }
}

// ========== 秒传 hash 计算阈值 ==========

const INSTANT_UPLOAD_MIN_SIZE = 100 * 1024
const HASH_CHUNK_SIZE = 2 * 1024 * 1024
const FULL_FILE_HASH_MAX_SIZE = HASH_CHUNK_SIZE * 4

// ========== Quota Warning 防抖 ==========

const QUOTA_LEVEL_PRIORITY: Record<string, number> = { info: 1, warning: 2, critical: 3 }
let _lastQuotaWarningLevel: string | null = null

export function resetQuotaWarningLevel(): void {
  _lastQuotaWarningLevel = null
}

function showQuotaWarningToast(warning: QuotaWarning): void {
  const currentPriority = QUOTA_LEVEL_PRIORITY[warning.level] ?? 0
  const lastPriority = _lastQuotaWarningLevel ? (QUOTA_LEVEL_PRIORITY[_lastQuotaWarningLevel] ?? 0) : 0

  if (currentPriority <= lastPriority) return
  _lastQuotaWarningLevel = warning.level

  const percent = Math.round(warning.usage_percent)
  const params = { percent, defaultValue: '' }

  if (warning.level === 'critical') {
    toast.error(i18n.t('chat:upload.quotaCritical', {
      ...params,
      defaultValue: '存储空间已使用 {{percent}}%，即将达到上限，请尽快清理或升级',
    }))
  } else if (warning.level === 'warning') {
    toast.warning(i18n.t('chat:upload.quotaWarning', {
      ...params,
      defaultValue: '存储空间已使用 {{percent}}%，请及时清理',
    }))
  } else {
    toast.info(i18n.t('chat:upload.quotaInfo', {
      ...params,
      defaultValue: '存储空间已使用 {{percent}}%',
    }))
  }
}

// ========== 公开 API ==========

/**
 * 单文件直传 OSS（带 XHR 进度回调 + 秒传支持）
 */
export async function directUpload(
  file: File | Blob,
  fileName: string,
  options: DirectUploadOptions = {},
): Promise<DirectUploadResult> {
  const client = getClient()
  const contentType = (file as File).type || 'application/octet-stream'
  const maxRetries = options.maxRetries ?? 1
  const enableInstant = options.enableInstantUpload !== false
  const organizationId = resolveOrganizationId(options.organizationId)
  const uploadStartedAt = Date.now()
  log.info(
    `directUpload start name=${fileName} size=${file.size} type=${contentType} module=${options.module ?? '-'} organization=${organizationId ?? '-'}`,
  )

  let fileHash: string | undefined
  let hashAlgorithm: string | undefined
  if (enableInstant && file.size >= INSTANT_UPLOAD_MIN_SIZE) {
    try {
      fileHash = await computeFileHash(file)
      hashAlgorithm = file.size <= FULL_FILE_HASH_MAX_SIZE ? 'sha256' : 'sha256-sampled'
    } catch {
      // hash 计算失败不阻断上传
    }
  }

  const presignResult = await withRetry(
    () => client.presign(fileName, file.size, contentType, {
      folder: options.folder,
      signal: options.signal,
      fileHash,
      hashAlgorithm,
      organizationId,
      module: options.module,
      contextType: options.contextType,
      contextId: options.contextId,
      isPublic: options.isPublic ?? false,
    }),
    maxRetries,
    options.signal,
  )

  if (presignResult.quotaWarning) {
    showQuotaWarningToast(presignResult.quotaWarning)
  }

  if (presignResult.instant && presignResult.instantResult) {
    options.onProgress?.(1)
    log.info(`directUpload instant-hit name=${fileName} size=${file.size} (${Date.now() - uploadStartedAt}ms)`)
    return presignResult.instantResult
  }

  const presignExpiryHintMs = calculatePresignExpiryHint(presignResult.expiresIn)

  await withRetry(
    () => putToOSSWithProgress(
      presignResult.presignedUrl,
      file,
      presignResult.contentType || contentType,
      options.onProgress,
      options.signal,
      presignExpiryHintMs,
    ),
    maxRetries,
    options.signal,
  )

  const pendingItem: PendingConfirm = {
    objectKey: presignResult.objectKey,
    fileName,
    fileSize: file.size,
    contentType,
    fileHash,
    hashAlgorithm,
    organizationId,
    module: options.module,
    contextType: options.contextType,
    contextId: options.contextId,
    isPublic: options.isPublic ?? false,
    timestamp: Date.now(),
    retryCount: 0,
  }
  await addPendingConfirm(pendingItem)

  try {
    const result = await withRetry(
      () => client.confirm(presignResult.objectKey, fileName, file.size, contentType, {
        module: options.module,
        contextType: options.contextType,
        contextId: options.contextId,
        signal: options.signal,
        organizationId,
        fileHash,
        hashAlgorithm,
        isPublic: options.isPublic ?? false,
      }),
      maxRetries,
      options.signal,
    )
    await removePendingConfirm(presignResult.objectKey)
    log.info(`directUpload done name=${fileName} objectKey=${presignResult.objectKey} (${Date.now() - uploadStartedAt}ms)`)
    return result
  } catch (error) {
    log.warn(`confirm failed after PUT succeeded, pending retry saved objectKey=${presignResult.objectKey}:`, error)
    throw error
  }
}

/**
 * 批量直传 OSS（并发控制）
 */
export async function directUploadBatch(
  files: Array<{ file: File | Blob; fileName: string }>,
  options: DirectUploadOptions & {
    concurrency?: number
    onFileProgress?: (index: number, progress: number) => void
    onFileComplete?: (index: number, result: DirectUploadResult | null, error?: string) => void
  } = {},
): Promise<DirectBatchUploadResult> {
  resetQuotaWarningLevel()
  const concurrency = options.concurrency ?? 3
  const results: DirectBatchUploadResult['results'] = []
  let successCount = 0
  let failedCount = 0

  const queue = files.map((f, i) => ({ ...f, index: i }))
  let cursor = 0
  let quotaExceeded = false
  let billingBlocked = false

  async function worker() {
    while (cursor < queue.length) {
      if (options.signal?.aborted) throw new UploadAbortedError()
      if (quotaExceeded || billingBlocked) break
      const idx = cursor++
      const item = queue[idx]
      try {
        const result = await directUpload(item.file, item.fileName, {
          ...options,
          onProgress: (p) => options.onFileProgress?.(item.index, p),
        })
        successCount++
        results[item.index] = { ...result, success: true }
        options.onFileComplete?.(item.index, result)
      } catch (err) {
        if (err instanceof UploadAbortedError) throw err
        if (err instanceof StorageQuotaExceededError) {
          quotaExceeded = true
        }
        if (err instanceof BillingBlockedError) {
          billingBlocked = true
        }
        failedCount++
        const msg = err instanceof Error ? err.message : String(err)
        results[item.index] = {
          fileId: '',
          fileName: item.fileName,
          fileKey: '',
          fileSize: 0,
          accessUrl: '',
          cdnUrl: '',
          success: false,
          error: msg,
        }
        options.onFileComplete?.(item.index, null, msg)
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker())
  await Promise.all(workers)

  return {
    total: files.length,
    successCount,
    failedCount,
    results,
    quotaExceeded,
    billingBlocked,
  }
}
