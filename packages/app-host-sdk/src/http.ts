/**
 * App Host SDK HTTP 类型定义
 *
 * 与 table-core 的 TableHttpRequest / TableHttpResponse 结构兼容，
 * 但无导入关系 —— app-host-sdk 保持零外部依赖。
 */

// ─── 基础传输类型 ────────────────────────────────────────────────────

export type AppHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** 低层传输请求（与 TableHttpRequest 结构兼容） */
export interface AppHttpRequest {
  url: string
  method: AppHttpMethod
  headers?: Record<string, string>
  body?: string
}

/** 低层传输响应（与 TableHttpResponse 结构兼容） */
export interface AppHttpResponse<T = unknown> {
  data: T
  status: number
  headers?: Record<string, string>
  statusText?: string
}

/**
 * HTTP 传输函数 —— 由宿主注入
 *
 * - builtin App: 宿主注入 `TableApiPort.request`（含 401 自动刷新）
 * - marketplace App: preload bridge 注入基于 IPC 的传输
 */
export type AppHttpTransport = <T = unknown>(
  req: AppHttpRequest,
) => Promise<AppHttpResponse<T>>

// ─── 高阶请求选项 ────────────────────────────────────────────────────

export interface AppRequestOptions {
  method: AppHttpMethod
  /** 相对端点路径，如 '/api/tabdoc/documents' */
  endpoint: string
  /** Query 参数 —— 自动序列化为 URL search string */
  params?: Record<string, string | number | boolean | undefined | null>
  /** 请求体 —— POST/PUT/PATCH 时自动 JSON.stringify */
  body?: unknown
  /** 额外 headers（合并在自动注入的 auth / content-type 之后） */
  headers?: Record<string, string>
  /** 期望的 HTTP 状态码（默认 200），支持数组以接受多个状态码 */
  expectedStatus?: number | number[]
  /** 跳过 envelope 解包，直接返回 response.data */
  rawResponse?: boolean
}

// ─── 标准 API Envelope ───────────────────────────────────────────────

/** Django 后端标准响应信封 */
export interface AppApiEnvelope<T> {
  success?: boolean
  data?: T
  message?: string
  code?: number | string
  detail?: string
}

/** 标准 API envelope 元字段；此外还有键时视为「裸业务体」（如 BatchUndoRedoResponse）。 */
const ENVELOPE_META_KEYS = new Set(['success', 'data', 'message', 'detail', 'code'])

/**
 * 解包标准 `{ success, data, message }` envelope。
 *
 * ：裸业务体自身带 `success` 但无 `data` 时必须原样返回，不能剥成 `{}`。
 */
export function unwrapApiEnvelope<T>(
  payload: unknown,
  fallbackError = 'API request failed',
): T {
  if (!payload || typeof payload !== 'object') {
    return payload as T
  }

  const envelope = payload as AppApiEnvelope<T> & Record<string, unknown>
  const isEnvelopeLike =
    'success' in envelope ||
    'data' in envelope ||
    'message' in envelope ||
    'detail' in envelope ||
    'code' in envelope
  if (!isEnvelopeLike) {
    return payload as T
  }

  if (envelope.success === false) {
    throw new Error(envelope.message || envelope.detail || fallbackError)
  }

  if (envelope.data !== undefined && envelope.data !== null) {
    return envelope.data
  }

  if (envelope.success === true) {
    const hasBusinessFields = Object.keys(envelope).some(
      (key) => !ENVELOPE_META_KEYS.has(key),
    )
    if (hasBusinessFields) {
      return payload as T
    }
    return {} as T
  }

  throw new Error(envelope.message || envelope.detail || fallbackError)
}
