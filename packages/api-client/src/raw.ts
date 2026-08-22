/**
 * raw fetch 能力 — 对 OpenAPI spec 未覆盖的端点发起请求，
 * 共享 auth、refresh、envelope unwrap 逻辑。
 *
 * ## ⚠️ 关于泛型 T 的重要约定（必读）
 *
 * 当后端响应是 `{ success: boolean, data: ... }` 形式的 envelope 时，
 * `raw<T>(...)` **会自动 unwrap，直接返回 `envelope.data`**（见函数体内的 envelope 处理分支）。
 *
 * 因此，**泛型 T 永远是 envelope 内部 `data` 的类型，绝不要把 `{ success, data }` 外壳写进 T**：
 *
 * ```ts
 * // ✅ 正确：T 直接对应 envelope.data
 * interface ListResponse { items: Item[]; total: number }
 * const res = await raw<ListResponse>('GET', '/foo')
 * res.items // ← 直接用
 *
 * // ❌ 错误：把 envelope 写进 T
 * interface ListResponse { success: boolean; data: { items: Item[] } }
 * const res = await raw<ListResponse>('GET', '/foo')
 * res.data.items // ← 运行时 res.data 是 undefined，会报 "Cannot read properties of undefined"
 * ```
 *
 * 如需绕过 unwrap（拿原始 `Response` 对象，例如下载 Blob），用 `rawResponse: true`。
 */

import type { ApiClientOptions } from './client.js'
import type { RefreshLock } from './refresh-lock.js'
import { isRefreshTemporarilyUnavailableError } from './refresh-lock.js'
import { ApiError } from './unwrap.js'

const DEFAULT_TIMEOUT_MS = 30_000

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData
}

export interface RawRequestInit {
  body?: unknown
  headers?: Record<string, string>
  params?: Record<string, string | number | boolean | undefined | null>
  /**
   * 跳过 envelope 解包，直接返回 `Response` 对象（如下载文件、Blob）。
   * 默认 `false`：自动 unwrap `{success, data}` 信封并把 `data` 作为 `T` 返回。
   * 此模式下不要给 `raw` 传泛型 T，调用方需自行处理 `Response`。
   */
  rawResponse?: boolean
  /** 请求超时 (ms)。默认 30 000，设为 0 禁用超时。 */
  timeout?: number
}

/**
 * `client.raw(...)` 的函数类型。
 *
 * **泛型 T 是 envelope 内部 `data` 的类型，不要把 `{success, data}` 外壳写进 T**——
 * `raw` 会自动 unwrap 信封。详见模块顶部说明、{@link RawRequestInit.rawResponse}，以及
 * `packages/api-client/README.md` 中的 do/don't 示例。
 */
export interface RawFetcher {
  /**
   * 发起一次 HTTP 请求，自动处理 auth/refresh/envelope unwrap。
   *
   * @template T envelope 内部 `data` 的类型——**不是**整个 `{success, data}` 外壳。
   *   后端如果返回 `{ success: true, data: X }`，这里的 T 就写 X。
   * @param method HTTP 方法
   * @param path 相对路径（会拼接 `baseUrl`）
   * @returns unwrap 后的 `data`
   * @throws {ApiError} 401 未授权、超时、HTTP 非 2xx、或 envelope `success: false`
   */
  <T = unknown>(method: string, path: string, init?: RawRequestInit): Promise<T>
  /** `rawResponse: true` 时返回原始 `Response`，不要传泛型 T。 */
  (method: string, path: string, init: RawRequestInit & { rawResponse: true }): Promise<Response>
}

export function createRawFetcher(options: ApiClientOptions, lock?: RefreshLock): RawFetcher {
  const refreshLock = lock

  async function raw<T = unknown>(
    method: string,
    path: string,
    init?: RawRequestInit,
  ): Promise<T>
  async function raw(
    method: string,
    path: string,
    init: RawRequestInit & { rawResponse: true },
  ): Promise<Response>
  async function raw<T = unknown>(
    method: string,
    path: string,
    init?: RawRequestInit,
  ): Promise<T | Response> {
    const fetchFn = options.fetch ?? globalThis.fetch
    const timeout = init?.timeout ?? DEFAULT_TIMEOUT_MS
    const requestBody = init?.body

    let url = `${options.baseUrl}${path}`
    if (init?.params) {
      const searchParams = new URLSearchParams()
      for (const [k, v] of Object.entries(init.params)) {
        if (v != null) searchParams.set(k, String(v))
      }
      const qs = searchParams.toString()
      if (qs) url = `${url}?${qs}`
    }

    const buildHeaders = async (): Promise<Record<string, string>> => {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...init?.headers,
      }
      if (requestBody !== undefined && !isFormData(requestBody) && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json'
      }
      if (options.clientType) {
        headers['X-Client-Type'] = options.clientType
      }
      if (options.getToken) {
        const token = await options.getToken()
        if (token) {
          headers['Authorization'] = `Bearer ${token}`
        }
      }
      return headers
    }

    const doFetch = async (hdrs: Record<string, string>): Promise<Response> => {
      const reqInit: RequestInit = {
        method: method.toUpperCase(),
        headers: hdrs,
      }
      if (requestBody !== undefined) {
        reqInit.body = isFormData(requestBody) ? requestBody : JSON.stringify(requestBody)
      }
      if (timeout > 0) {
        const controller = new AbortController()
        reqInit.signal = controller.signal
        const timer = setTimeout(() => controller.abort(), timeout)
        try {
          return await fetchFn(url, reqInit)
        } catch (err: unknown) {
          if (controller.signal.aborted) {
            throw new ApiError('TIMEOUT', `Request timed out after ${timeout}ms`, 0)
          }
          throw err
        } finally {
          clearTimeout(timer)
        }
      }
      return fetchFn(url, reqInit)
    }

    let headers = await buildHeaders()
    let response = await doFetch(headers)

    let unauthorizedNotified = false
    let refreshTemporarilyUnavailable = false
    if (response.status === 401 && (refreshLock || options.refresh)) {
      try {
        if (!refreshLock) {
          throw new Error('no lock')
        }
        const newToken = await refreshLock.acquire()
        if (newToken) {
          headers['Authorization'] = `Bearer ${newToken}`
          response = await doFetch(headers)
        } else {
          options.refresh?.onRefreshFailed()
          options.onUnauthorized?.()
          unauthorizedNotified = true
        }
      } catch (error) {
        if (!isRefreshTemporarilyUnavailableError(error)) {
          options.refresh?.onRefreshFailed()
          options.onUnauthorized?.()
          unauthorizedNotified = true
        } else {
          refreshTemporarilyUnavailable = true
        }
      }
    }

    if (response.status === 401) {
      if (!unauthorizedNotified && !options.refresh) options.onUnauthorized?.()
      if (!unauthorizedNotified && options.refresh && !refreshTemporarilyUnavailable) {
        // A refresh succeeded but the replay is still unauthorized. At this
        // point the session is definitively unusable rather than transient.
        options.onUnauthorized?.()
      }
      throw new ApiError('UNAUTHORIZED', 'Unauthorized', 401)
    }

    if (init?.rawResponse) {
      return response
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      if (!response.ok) {
        throw new ApiError('HTTP_ERROR', `HTTP ${response.status}`, response.status)
      }
      return undefined as T
    }

    if (body && typeof body === 'object' && 'success' in body) {
      const envelope = body as { success: boolean; code?: string; message?: string; data?: unknown }
      if (!response.ok || !envelope.success) {
        throw new ApiError(
          envelope.code ?? 'UNKNOWN',
          envelope.message ?? 'Request failed',
          response.status,
        )
      }
      return envelope.data as T
    }

    if (!response.ok) {
      throw new ApiError('HTTP_ERROR', `HTTP ${response.status}`, response.status)
    }

    return body as T
  }

  return raw
}
