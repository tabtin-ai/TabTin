import { getTableRuntime, requireTableApiPort, getAppHostClient, getTableFetch } from '../runtime/registry'
import type { TableHttpRequest, TableHttpResponse } from '../runtime/ports'
import { getTableDataClientConfig } from './config'

/**
 * 统一的 fetch 入口 —— 完整 Fetch 语义（FormData / Blob / 透明 Response）的请求
 * 必须经此函数，禁止直接调全局 `fetch`。
 *
 * 它在调用时解析当前生效的 fetch 实现（宿主注入的 electronFetch，或回退浏览器
 * 原生 fetch），从而让 Electron 生产包的 renderer 请求走主进程代理、不被业务
 * API 的 CORS 拦截；Web / AdminDash 不注入时行为与原生 fetch 完全一致。
 *
 * 仅适用于 table-core 内部对**业务 API** 的请求。对象存储（OSS）预签名直传等
 * 外部 host 不应经此函数（保持原生 fetch 直连，CORS 由桶侧配置处理）。
 */
export const tableFetch: typeof globalThis.fetch = (input, init) => getTableFetch()(input, init)

// ---------------------------------------------------------------------------
// Retry 机制
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1000
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504])
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const requestHeaderScopes: Array<Record<string, string>> = []

/**
 * Attach headers to every request started synchronously by an operation.
 * requestJsonApi snapshots the scope before its first async boundary, so retries
 * keep the same headers without leaking them to concurrent table stores.
 */
export function withTableRequestHeaders<T>(
  headers: Record<string, string>,
  operation: () => T,
): T {
  requestHeaderScopes.push(headers)
  try {
    return operation()
  } finally {
    requestHeaderScopes.pop()
  }
}

export function snapshotTableRequestHeaders(): Record<string, string> {
  return Object.assign({}, ...requestHeaderScopes)
}
interface HttpErrorLike {
  status?: number
  statusCode?: number
  retryAfter?: number
  /** 业务错误码(后端 ErrorResponse.code,如 FIELD_RESTORE_NOT_SUPPORTED) */
  code?: string
  /** 业务错误的 data payload(如 unrestorable_fields[] / restorable_fields[]) */
  data?: unknown
}

function getErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    return (error as HttpErrorLike).status ?? (error as HttpErrorLike).statusCode
  }
  return undefined
}

/** 字段结构乐观锁冲突（HTTP 409 / SCHEMA_VERSION_CONFLICT） */
export function isSchemaVersionConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as HttpErrorLike & { message?: string }
  if (e.code === 'SCHEMA_VERSION_CONFLICT') return true
  const status = getErrorStatus(error)
  if (status !== 409) return false
  return typeof e.message === 'string' && e.message.includes('字段结构已被他人修改')
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  const status = getErrorStatus(error)
  if (typeof status === 'number') {
    return RETRYABLE_STATUS_CODES.has(status)
  }
  return false
}

/**
 * 通用重试（仅处理网络错误和 502/503/504）。
 *
 * 429 由底层 api-proxy（主进程）统一处理，这里不再重试，
 * 避免双层各自重试导致请求量翻倍、加剧限流。
 */
async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      const isRetryable = isRetryableError(error)
      if (!isRetryable || attempt >= retries) {
        throw error
      }
      const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt)
      console.warn(
        `[requestJsonApi] 请求失败 (attempt ${attempt + 1}/${retries + 1}), ` +
          `${delayMs}ms 后重试. error:`,
        error,
      )
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastError
}

function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/** 附带 HTTP status + retryAfter + 业务 code/data 的 Error */
function createHttpError(
  message: string,
  status: number,
  retryAfter?: number,
  code?: string,
  data?: unknown,
): Error {
  const err = new Error(message)
  ;(err as HttpErrorLike).status = status
  if (retryAfter != null) {
    ;(err as HttpErrorLike).retryAfter = retryAfter
  }
  if (code) {
    ;(err as HttpErrorLike).code = code
  }
  if (data !== undefined) {
    ;(err as HttpErrorLike).data = data
  }
  return err
}

export interface TableApiEnvelope<T> {
  success?: boolean
  data?: T
  message?: string
  code?: number
  detail?: string
}

const UNAUTHORIZED_FALLBACK = '未授权，请先登录'

export const translate = (
  key: string,
  fallback: string,
  options?: Record<string, unknown>
): string => {
  const translated = getTableRuntime().i18n?.t?.(key, {
    ...(options ?? {}),
    defaultValue: fallback,
  })

  if (!translated || translated === key) {
    return fallback
  }

  return translated
}

export const buildTableApiUrl = (endpoint: string): string => {
  const { baseURL } = getTableDataClientConfig()
  const normalizedBaseURL = baseURL.replace(/\/$/, '')
  const normalizedEndpoint = endpoint.replace(/^\/api(?=\/|$)/, '')
  const sep = normalizedEndpoint.startsWith('/') ? '' : '/'
  return normalizedBaseURL ? `${normalizedBaseURL}${sep}${normalizedEndpoint}` : `${sep}${normalizedEndpoint}`
}

export const requestTableApi = async <T = unknown>(options: TableHttpRequest): Promise<TableHttpResponse<T>> => {
  const apiPort = requireTableApiPort()
  return apiPort.request<T>(options)
}

export const getRequiredAccessToken = async (): Promise<string> => {
  const apiPort = requireTableApiPort()
  const token = await apiPort.getAccessToken()

  if (!token) {
    throw new Error(translate('auth:errors.unauthorized', UNAUTHORIZED_FALLBACK))
  }

  return token
}

export const getOptionalAuthHeaders = async (): Promise<Record<string, string>> => {
  try {
    const token = await getRequiredAccessToken()
    return {
      Authorization: `Bearer ${token}`,
    }
  } catch {
    return {}
  }
}

export const getOptionalWindowIdHeader = (): Record<string, string> => {
  const windowId = getTableRuntime().api?.getWindowId?.()
  if (!windowId) {
    return {}
  }
  const normalized = String(windowId).trim()
  if (!normalized) {
    return {}
  }
  return {
    'X-Window-Id': normalized,
  }
}

export const buildJsonHeaders = (
  token?: string,
  headers?: Record<string, string>
): Record<string, string> => {
  return {
    ...(token
      ? {
          Authorization: `Bearer ${token}`,
        }
      : {}),
    'Content-Type': 'application/json',
    ...(headers ?? {}),
  }
}

const getDefaultMutationHeaders = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
): Record<string, string> => {
  if (method === 'GET') {
    return {}
  }
  return getOptionalWindowIdHeader()
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** 标准 API envelope 元字段；此外还有键时视为「裸业务体」（如 BatchUndoRedoResponse）。 */
const ENVELOPE_META_KEYS = new Set(['success', 'data', 'message', 'detail', 'code'])

/**
 * 判断 payload 是否符合 TableApiEnvelope 结构。
 */
export const hasEnvelopeShape = <T,>(payload: unknown): payload is TableApiEnvelope<T> => {
  if (!isObjectLike(payload)) return false
  return 'success' in payload || 'data' in payload || 'message' in payload || 'detail' in payload || 'code' in payload
}

function hasNonEnvelopeBusinessFields(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).some((key) => !ENVELOPE_META_KEYS.has(key))
}

/**
 * 从 TableApiEnvelope 中提取 data，失败则 throw Error。
 *
 * 通用的响应解包逻辑，原先仅在 import-export-api.ts 内部使用，
 * 现在提升到 http.ts 供所有 service 复用。
 *
 * ：部分后端 schema（如 BatchUndoRedoResponse）自身带 `success`/`message`，
 * 但没有外层 `data` 包装。若在 `success === true` 且无 `data` 时一律返回 `{}`，
 * 会把真实业务字段剥掉，调用方误判为失败（撤销已生效却 toast「没有可撤销的操作」）。
 */
export const unwrapEnvelopeData = <T,>(payload: unknown, fallbackError: string): T => {
  if (!hasEnvelopeShape<T>(payload)) {
    return payload as T
  }
  if (payload.success === false) {
    throw new Error(
      (typeof payload.message === 'string' && payload.message) ||
        (typeof payload.detail === 'string' && payload.detail) ||
        fallbackError,
    )
  }
  if (payload.data !== undefined && payload.data !== null) {
    return payload.data as T
  }
  if (payload.success === true) {
    // 裸业务体：原样返回；纯成功 ack（仅 envelope 元字段）：返回 {}
    if (hasNonEnvelopeBusinessFields(payload as Record<string, unknown>)) {
      return payload as T
    }
    return {} as T
  }
  throw new Error(
    (typeof payload.message === 'string' && payload.message) ||
      (typeof payload.detail === 'string' && payload.detail) ||
      fallbackError,
  )
}

/**
 * 统一的 "认证 + JSON 请求 + envelope 解包" 便捷方法。
 *
 * 当宿主注入了 AppHostClient（通过 setAppHostClient），
 * 请求会委托给 client.request<T>()，实现 URL 拼接 / token 注入 /
 * Content-Type / envelope 解包 的统一管道。
 *
 * 未注入 AppHostClient 时，fallback 到原有手动链路
 * （getRequiredAccessToken → buildJsonHeaders → requestTableApi → unwrapEnvelopeData）。
 *
 * @example
 * const data = await requestJsonApi<MyType>({
 *   method: 'GET',
 *   endpoint: '/api/v1/tables',
 *   fallbackError: '获取表格列表失败',
 * })
 */
export const requestJsonApi = async <T = unknown>(options: {
  /** 相对端点路径（优先使用） */
  endpoint?: string
  /** 完整 URL（兼容旧调用；endpoint 存在时忽略） */
  url?: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 请求体 —— 接受对象（自动 stringify）或字符串 */
  body?: unknown
  /** 失败时的兜底错误文案 */
  fallbackError: string
  /** 额外 headers（会合并到默认 headers 之后） */
  extraHeaders?: Record<string, string>
  /** 期望的 HTTP 状态码（默认 200），支持数组 */
  expectedStatus?: number | number[]
  /** 是否启用重试。默认：GET 请求启用，非 GET 不启用（避免重复写入） */
  retry?: boolean
  /** 请求超时时间（ms），默认 30s。设为 0 或 Infinity 禁用超时 */
  timeout?: number
}): Promise<T> => {
  const shouldRetry = options.retry ?? options.method === 'GET'
  const timeoutMs = options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS
  const scopedHeaders = snapshotTableRequestHeaders()

  const doRequest = async (): Promise<T> => {
    const requestHeaders = {
      ...scopedHeaders,
      ...getDefaultMutationHeaders(options.method),
      ...(options.extraHeaders ?? {}),
    }

    // ── 优先走 AppHostClient 统一管道 ──────────────────────────────────
    const client = getAppHostClient()
    if (client && options.endpoint) {
      return client.request<T>({
        method: options.method,
        endpoint: options.endpoint,
        body: options.body != null
          ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body)
          : undefined,
        headers: requestHeaders,
        expectedStatus: options.expectedStatus,
      })
    }

    // ── Fallback: 原有手动链路 ────────────────────────────────────────
    const resolvedUrl = options.url
      ?? (options.endpoint ? buildTableApiUrl(options.endpoint) : '')
    if (!resolvedUrl) {
      throw new Error('[requestJsonApi] Either endpoint or url must be provided')
    }

    const token = await getRequiredAccessToken()
    const bodyStr = typeof options.body === 'string'
      ? options.body
      : options.body != null
        ? JSON.stringify(options.body)
        : undefined

    const response = await requestTableApi<TableApiEnvelope<T>>({
      url: resolvedUrl,
      method: options.method,
      headers: buildJsonHeaders(token, requestHeaders),
      body: bodyStr,
    })

    const expected = options.expectedStatus ?? 200
    const statusOk = Array.isArray(expected)
      ? expected.includes(response.status)
      : response.status === expected
    if (!statusOk) {
      const errEnvelope = response.data as (TableApiEnvelope<T> & { code?: string; data?: unknown }) | undefined
      const msg = errEnvelope?.message
      const errCode = typeof errEnvelope?.code === 'string' ? errEnvelope.code : undefined
      const errData = errEnvelope?.data
      const retryAfterRaw = getHeaderCaseInsensitive(response.headers, 'retry-after')
      const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) : undefined
      const embeddedAccessUnavailable = getHeaderCaseInsensitive(
        response.headers,
        'x-tabtin-embedded-access-unavailable',
      ) === '1'
      throw createHttpError(
        msg || options.fallbackError,
        response.status,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
        embeddedAccessUnavailable ? 'EMBEDDED_ACCESS_UNAVAILABLE' : errCode,
        errData,
      )
    }

    return unwrapEnvelopeData<T>(response.data, options.fallbackError)
  }

  const executeRequest = shouldRetry ? () => withRetry(doRequest) : doRequest

  if (timeoutMs > 0 && timeoutMs < Infinity) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          translate('table:errors.request_timeout', `请求超时（${Math.round(timeoutMs / 1000)}s）`)
        ))
      }, timeoutMs)
      executeRequest().then(
        (result) => { clearTimeout(timer); resolve(result) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  return executeRequest()
}
