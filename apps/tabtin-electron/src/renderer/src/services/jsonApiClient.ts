/**
 * 领域 JSON API 客户端工厂（ W5 抽公共）。
 *
 * ``agentMemoryApi`` 与 ``userPortraitApi`` 原本各自维护一份几乎相同的
 * ``getAuthHeaders()`` + ``request<T>()`` + ``ApiResponse`` envelope 解析。
 * 这里收口成一个工厂：各领域只需提供前缀、日志名与领域 Error 工厂
 * （保留各自 ``*ApiError`` 类型以便调用点 ``instanceof`` 判定），行为不变。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { createLogger } from '@/utils/logger'

/** 后端统一响应信封。 */
export interface ApiEnvelope<T = unknown> {
  success: boolean
  code?: string
  message?: string
  data?: T
  error?: { code: string; message: string }
}

/** 领域 Error 工厂：把 (message, statusCode, errorCode) 造成各领域自己的 Error 类。 */
export type ApiErrorFactory = (message: string, statusCode: number, errorCode?: string) => Error

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface JsonApiRequestOptions {
  path: string
  method: HttpMethod
  body?: unknown
  params?: Record<string, string | number | boolean | undefined>
}

export interface JsonApiClientConfig {
  /** 领域前缀，如 '/agent-memory' / '/user-portrait'（拼在 baseURL 后）。 */
  base: string
  /** 领域错误工厂（保留各自 Error 类型）。 */
  makeError: ApiErrorFactory
  /** 日志器名。 */
  loggerName: string
  /**
   * 是否要求响应 ``data`` 字段非空——缺失即抛领域错误。
   * agentMemoryApi 需要（DTO 必然有值）；userPortraitApi 不需要（部分端点可空）。
   * 默认 false，保持各自历史行为。
   */
  requireData?: boolean
}

export interface JsonApiClient {
  request<T>(opts: JsonApiRequestOptions): Promise<T>
  getAuthHeaders(): Promise<Record<string, string>>
}

export function createJsonApiClient(config: JsonApiClientConfig): JsonApiClient {
  const log = createLogger(config.loggerName)

  async function getAuthHeaders(): Promise<Record<string, string>> {
    try {
      const token = await getAuthToken()
      if (token) return { Authorization: `Bearer ${token}` }
      return {}
    } catch (err) {
      log.warn('failed to get auth token, proceeding without auth:', err)
      return {}
    }
  }

  async function request<T>(opts: JsonApiRequestOptions): Promise<T> {
    const url = new URL(joinApiPath(API_CONFIG.baseURL, `${config.base}${opts.path}`))
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
      }
    }

    const authHeaders = await getAuthHeaders()
    const headers: Record<string, string> = { ...authHeaders }
    if (opts.method !== 'GET') {
      headers['Content-Type'] = 'application/json'
    }

    const response = await adapterApiRequest<ApiEnvelope<T>>({
      url: url.toString(),
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })

    const body = response.data
    if (!body?.success) {
      const message = body?.message || body?.error?.message || body?.code || 'Request failed'
      const errorCode = body?.error?.code || body?.code
      throw config.makeError(message, response.status, errorCode)
    }
    if (config.requireData && (body.data === undefined || body.data === null)) {
      throw config.makeError('Response missing data field', response.status)
    }
    return body.data as T
  }

  return { request, getAuthHeaders }
}
