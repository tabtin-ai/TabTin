import { ChatAPIError, ChatClientOptions, ErrorResponse } from '../types'
import { t, getLocale } from '../i18n'

/**
 * HTTP 请求方法
 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * HTTP 客户端
 * 封装所有 HTTP 请求逻辑，支持认证、错误处理、超时等
 */
export class HttpClient {
  private baseURL: string
  private getToken: () => string | Promise<string>
  private onError?: (error: Error) => void
  private timeout: number
  private clientType?: string

  constructor(options: ChatClientOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, '') // 移除末尾斜杠
    this.getToken = options.getToken
    this.onError = options.onError
    this.timeout = options.timeout || 30000
    this.clientType = options.role === 'electron' ? 'electron' : undefined
  }

  /**
   * 发送 HTTP 请求
   */
  async request<T>(
    method: HttpMethod,
    path: string,
    data?: any,
    queryParams?: Record<string, any>
  ): Promise<T> {
    const url = this.buildURL(path, queryParams)
    const token = await this.getToken()

    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(`Request timeout after ${this.timeout}ms: ${method} ${path}`),
      this.timeout,
    )

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept-Language': getLocale(),
          ...(this.clientType ? { 'X-Client-Type': this.clientType } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        await this.handleErrorResponse(response)
      }

      return this.unwrapResponse(await response.json())
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof ChatAPIError) {
        throw error
      }

      // 处理网络错误、超时等
      const err = new ChatAPIError(
        error instanceof Error ? error.message : t('errors.unknownError'),
        0
      )

      if (this.onError) {
        this.onError(err)
      }

      throw err
    }
  }

  /**
   * GET 请求
   */
  async get<T>(path: string, queryParams?: Record<string, any>): Promise<T> {
    return this.request<T>('GET', path, undefined, queryParams)
  }

  /**
   * POST 请求
   */
  async post<T>(path: string, data?: any): Promise<T> {
    return this.request<T>('POST', path, data)
  }

  /**
   * PUT 请求
   */
  async put<T>(path: string, data?: any): Promise<T> {
    return this.request<T>('PUT', path, data)
  }

  /**
   * DELETE 请求
   */
  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path)
  }

  /**
   * 自动识别两种 wire 形态并解包成 caller 想要的 ``T``：
   *
   * - **新 envelope**（W0 / W1 已铺；``apps/services/common/error_codes.py`` 的
   *   ``ok_response`` / ``err_response`` 产）
   *   - ``{ok: true, data: T, trace_id?, duration_ms?}`` → 解 ``data``（含
   *     SOFT_FAIL 之外的 `data == null` 路径，Caller 自己处理 nullable 业务）
   *   - ``{ok: false, error: {code, message, detail?, ...}, trace_id?, ...}``
   *     → throw ``ChatAPIError`` 含顶层 ``code`` / ``trace_id`` / ``detail``，
   *     SOFT_FAIL / UNAUTHORIZED / NOT_FOUND / VALIDATION_ERROR 等所有 ok:false
   *     **无差别 throw**（D-1：fail-soft 只允许 envelope 形态显式表达，绝
   *     不能透传给 caller 当成功）
   * - **老 success_response**（向后兼容 ``apps/i18n/response.py.success_response``
   *   等仓库内未迁移到 envelope 的旧 helper；W6 / W7 收口 Django 旧 helper 后这条
   *   分支才删，不是历史包袱代码——是双轨过渡的合规手段）
   *   - ``{success: true, code, message, data}`` → 按既有"包装解包"启发式
   *     选择性返 ``data`` 还是整个 ``json``
   *   - ``{success: false, ...}`` → throw ``ChatAPIError``（同样 stamp ``code``
   *     / ``trace_id`` 让 caller 拿到一致字段）
   *
   * envelope 分支放在前面是因为：W0 / W1 改造后新 helper 已经成主流，老 helper
   * 路径会逐渐萎缩；放前面让"新形态优先"是契约层面的引导，并且永远不会让
   * 同时含 ``ok`` 和 ``success`` 的 corner case 走到老分支（envelope 优先匹配
   * 即可——同时含双字段在合规 helper 不会发生，会触发说明 Django 那边出 bug
   * 应当报错，而 envelope 分支会先 throw 把它暴露）。
   */
  private unwrapResponse<T>(json: any): T {
    if (
      json &&
      typeof json === 'object' &&
      !Array.isArray(json)
    ) {
      // ── 1. 新 envelope 形态（W0 / W1 已铺） ─────────────────────────
      if ('ok' in json) {
        if (json.ok === false) {
          const err = (json.error ?? {}) as Record<string, unknown>
          const code = typeof err.code === 'string' ? err.code : undefined
          const message =
            (typeof err.message === 'string' && err.message) ||
            code ||
            t('errors.unknownError')
          throw new ChatAPIError(
            message,
            0,
            json as ErrorResponse,
            {
              code,
              trace_id: typeof json.trace_id === 'string' ? json.trace_id : undefined,
              detail: err.detail,
            },
          )
        }
        if (json.ok === true) {
          // envelope 严格契约：成功路径就是 ``{ok: true, data}``。
          // 没有 ``data`` 字段时退回返整个 envelope（保留观察性，避免静默丢
          // 字段；正常服务端不应返 ok:true 但缺 data，这条防御）。
          return ('data' in json ? json.data : json) as T
        }
        // ``ok`` 字段存在但既非 true 也非 false（异常）→ 退回老分支判定
      }

      // ── 2. 老 success_response 形态（向后兼容；W6 / W7 Django 旧 helper 收口前保留） ─
      if ('success' in json) {
        if (!json.success) {
          const codeRaw = json.code
          const code = typeof codeRaw === 'string' ? codeRaw : undefined
          const message =
            (typeof json.message === 'string' && json.message) ||
            code ||
            t('errors.unknownError')
          throw new ChatAPIError(
            message,
            0,
            json,
            {
              code,
              trace_id: typeof json.trace_id === 'string' ? json.trace_id : undefined,
            },
          )
        }

        if ('data' in json) {
          const baseKeys = ['success', 'data', 'message', 'code', 'error_code', 'trace_id', 'request_id']
          const hasBusinessKeys = Object.keys(json).some(key => !baseKeys.includes(key))

          if (!hasBusinessKeys) {
            return json.data as T
          }
        }

        return json as T
      }
    }
    return json as T
  }

  /**
   * 构建完整 URL
   */
  private buildURL(path: string, queryParams?: Record<string, any>): string {
    const isAbsolute = /^https?:\/\//.test(path)
    const url = isAbsolute ? path : `${this.baseURL}${path}`

    if (!queryParams || Object.keys(queryParams).length === 0) {
      return url
    }

    const params = new URLSearchParams()
    Object.entries(queryParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.append(key, String(value))
      }
    })

    const queryString = params.toString()
    return queryString ? `${url}?${queryString}` : url
  }

  /**
   * 处理错误响应
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorData: ErrorResponse | undefined

    try {
      errorData = await response.json()
    } catch {
      // JSON 解析失败，使用默认错误消息
    }

    const message =
      errorData?.detail ||
      errorData?.error ||
      errorData?.message ||
      t('errors.httpStatus', { status: response.status, statusText: response.statusText })

    const error = new ChatAPIError(message, response.status, errorData)

    if (this.onError) {
      this.onError(error)
    }

    throw error
  }
}














