import type { AppHostContext, AppHostContextUpdate } from './context'
import {
  unwrapApiEnvelope,
  type AppApiEnvelope,
  type AppRequestOptions,
  type AppHttpRequest,
} from './http'

type ContextUpdateHandler = (update: AppHostContextUpdate) => void

/**
 * AppHostClient — App 与宿主通信的统一入口
 *
 * 两种创建方式:
 * - `fromContext(ctx)`: builtin in-process（宿主直接注入 context）
 * - `fromPreload()`: marketplace WebContentsView（读取 window.tabtin.appHost bridge）
 */
export class AppHostClient {
  private _ctx: AppHostContext
  private _listeners = new Set<ContextUpdateHandler>()
  private _destroyed = false
  private _preloadCleanup: (() => void) | null = null

  private constructor(ctx: AppHostContext) {
    this._ctx = ctx
  }

  // ─── 工厂方法 ─────────────────────────────────────────────

  /**
   * builtin in-process：宿主构造 AppHostContext 后直接传入
   */
  static fromContext(ctx: AppHostContext): AppHostClient {
    return new AppHostClient(ctx)
  }

  /**
   * marketplace WebContentsView：从 preload bridge 读取 context
   * 需要宿主事先在 preload 中暴露 `window.tabtin.appHost`
   */
  static fromPreload(): AppHostClient {
    const bridge = (globalThis as any).tabtin?.appHost
    if (!bridge) {
      throw new Error(
        '[AppHostClient] window.tabtin.appHost bridge not found. ' +
        'Ensure App is loaded inside a managed WebContentsView with proper preload.'
      )
    }

    const ctx: AppHostContext = {
      appId: bridge.appId ?? '',
      spaceId: bridge.spaceId ?? bridge.projectId ?? null,
      organizationId: bridge.organizationId ?? null,
      baseApiUrl: bridge.baseApiUrl ?? '',
      getAccessToken: () => bridge.getAccessToken(),
      showToast: bridge.showToast
        ? (msg: string, level?: string) => bridge.showToast(msg, level)
        : undefined,
      navigate: bridge.navigate
        ? (target: { type: string; id: string }) => bridge.navigate(target)
        : undefined,
      // httpTransport 通过 IPC bridge 注入（Phase C 完整实现）
      httpTransport: bridge.httpTransport
        ? (req) => bridge.httpTransport(req)
        : undefined,
    }

    const client = new AppHostClient(ctx)

    // 监听宿主推送的 context 更新
    if (typeof bridge.onContextUpdate === 'function') {
      const handler = (_event: unknown, update: AppHostContextUpdate) => {
        client._applyUpdate(update)
      }
      bridge.onContextUpdate(handler)
      client._preloadCleanup = () => {
        bridge.offContextUpdate?.(handler)
      }
    }

    return client
  }

  // ─── 读取 ─────────────────────────────────────────────────

  getAppId(): string {
    return this._ctx.appId
  }

  getSpaceId(): string | null {
    return this._ctx.spaceId
  }

  /** @deprecated Use getSpaceId */
  getProjectId(): string | null {
    return this._ctx.spaceId
  }

  getOrganizationId(): string | null {
    return this._ctx.organizationId
  }

  getBaseApiUrl(): string {
    return this._ctx.baseApiUrl
  }

  async getAccessToken(): Promise<string | null> {
    return this._ctx.getAccessToken()
  }

  // ─── 宿主能力 ─────────────────────────────────────────────

  showToast(message: string, level?: 'info' | 'error' | 'success' | 'warning'): void {
    this._ctx.showToast?.(message, level)
  }

  navigate(target: { type: string; id: string }): void {
    this._ctx.navigate?.(target)
  }

  // ─── HTTP 请求 ──────────────────────────────────────────────

  /**
   * 统一 HTTP 请求方法 —— App 调用后端 API 的唯一入口
   *
   * Pipeline:
   * 1. 拼接 URL: baseApiUrl + endpoint + query params
   * 2. 注入 Authorization header (Bearer token)
   * 3. POST/PUT/PATCH 自动设置 Content-Type: application/json
   * 4. 委托给宿主注入的 httpTransport
   * 5. 校验 HTTP 状态码
   * 6. 解包标准 API envelope → 返回 T
   *
   * @example
   * const docs = await client.request<{ documents: Doc[] }>({
   *   method: 'GET',
   *   endpoint: '/api/tabdoc/documents',
   *   params: { organization_id: wsId, space_id: spaceId },
   * })
   */
  async request<T = unknown>(options: AppRequestOptions): Promise<T> {
    if (this._destroyed) {
      throw new Error('[AppHostClient] Client has been destroyed')
    }

    const transport = this._ctx.httpTransport
    if (!transport) {
      throw new Error(
        '[AppHostClient] httpTransport not available. ' +
          'Ensure the host injected httpTransport into AppHostContext.',
      )
    }

    // 1. 拼接 URL
    const baseUrl = this._ctx.baseApiUrl.replace(/\/$/, '')
    const endpoint = options.endpoint.startsWith('/')
      ? options.endpoint
      : `/${options.endpoint}`
    let url = `${baseUrl}${endpoint}`

    if (options.params) {
      const searchParams = new URLSearchParams()
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== null) {
          searchParams.set(key, String(value))
        }
      }
      const qs = searchParams.toString()
      if (qs) {
        url += `?${qs}`
      }
    }

    // 2. 构建 headers
    const headers: Record<string, string> = {}

    // Auth
    const token = await this._ctx.getAccessToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    // Content-Type（有 body 的方法自动设置）
    const hasBody = options.method !== 'GET' && options.method !== 'DELETE'
    if (hasBody) {
      headers['Content-Type'] = 'application/json'
    }

    // 合并用户自定义 headers
    if (options.headers) {
      Object.assign(headers, options.headers)
    }

    // 3. 构造传输层请求
    const transportReq: AppHttpRequest = {
      url,
      method: options.method,
      headers,
      body:
        hasBody && options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    }

    // 4. 执行请求
    const response = await transport<AppApiEnvelope<T>>(transportReq)

    // 5. 状态码校验
    const expected = options.expectedStatus ?? 200
    const statusOk = Array.isArray(expected)
      ? expected.includes(response.status)
      : response.status === expected
    if (!statusOk) {
      const envelope = response.data as (AppApiEnvelope<T> & { code?: string; data?: unknown }) | undefined
      const msg =
        envelope?.message || envelope?.detail || `HTTP ${response.status}`
      const err = new Error(msg) as Error & {
        status?: number
        statusCode?: number
        detail?: unknown
        code?: string
        data?: unknown
      }
      err.status = response.status
      err.statusCode = response.status
      err.detail = envelope?.detail
      // W1.4:保留业务错误码 + 数据 payload(供 catch 处理 409 + FIELD_RESTORE_NOT_SUPPORTED 等)
      if (typeof envelope?.code === 'string') {
        err.code = envelope.code
      }
      if (envelope?.data !== undefined) {
        err.data = envelope.data
      }
      throw err
    }

    // 6. Envelope 解包
    if (options.rawResponse) {
      return response.data as unknown as T
    }

    return this._unwrapEnvelope<T>(response.data)
  }

  // ─── Context 更新 ─────────────────────────────────────────

  /**
   * 订阅 context 变更（spaceId、organizationId 等发生变化时触发）
   * 返回取消订阅函数
   */
  onContextUpdate(handler: ContextUpdateHandler): () => void {
    this._listeners.add(handler)
    return () => {
      this._listeners.delete(handler)
    }
  }

  /**
   * 宿主调用：推送 context 变更给 App
   * （builtin 模式下宿主直接调用此方法；preload 模式自动桥接）
   */
  pushContextUpdate(update: AppHostContextUpdate): void {
    this._applyUpdate(update)
  }

  // ─── 生命周期 ─────────────────────────────────────────────

  destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this._listeners.clear()
    this._preloadCleanup?.()
    this._preloadCleanup = null
  }

  isDestroyed(): boolean {
    return this._destroyed
  }

  // ─── 内部 ─────────────────────────────────────────────────

  private _applyUpdate(update: AppHostContextUpdate): void {
    if (this._destroyed) return

    if (update.spaceId !== undefined) {
      this._ctx.spaceId = update.spaceId
    }
    if (update.organizationId !== undefined) {
      this._ctx.organizationId = update.organizationId
    }
    if (update.baseApiUrl !== undefined) {
      this._ctx.baseApiUrl = update.baseApiUrl
    }

    this._listeners.forEach(handler => {
      try {
        handler(update)
      } catch {
        // listener 异常不影响其他订阅者
      }
    })
  }

  /** 解包标准 {success, data, message} API envelope（见 unwrapApiEnvelope / ） */
  private _unwrapEnvelope<T>(payload: unknown): T {
    return unwrapApiEnvelope<T>(payload)
  }
}
