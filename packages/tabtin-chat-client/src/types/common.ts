/**
 * Chat Client 配置选项
 */
export interface ChatClientOptions {
  /** API 基础 URL */
  baseURL: string
  /** LLM 目录 API 基础 URL（默认从 baseURL 推导） */
  catalogBaseURL?: string
  /** 获取访问令牌的函数 */
  getToken: () => string | Promise<string>
  /**
   * 获取当前前台 organization id（可选）。
   *
   * 返回值作为 WS auth 的 organization_id hint 传给服务端；服务端用它
   * 决定 `organization_ctx.primary_id`（若属于用户 membership）。
   *
   * - 未提供或返回 null/undefined/空字符串：auth 不带 organization_id，
   *   服务端自行从 membership 选 primary。
   * - 登录后前台 organization 未选：允许返回 null，不要抛异常。
   */
  getOrganizationId?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>
  /** WS 角色标识 */
  role?: 'electron' | 'web' | 'mobile' | 'admin'
  /** WS capabilities（覆盖默认角色能力） */
  capabilities?: string[]
  /** WS 设备 ID（用于设备路由与绑定） */
  deviceId?: string
  /**
   * 可选注入 Gateway 实例。
   *
   * Electron renderer 用 main-backed IPC gateway 注入这里，避免在 renderer
   * 再创建第二条 `/ws/v1/gateway` 连接；web / mobile 未注入时保持原行为。
   */
  wsGateway?: unknown
  /** WS 断开连接时的回调 */
  onDisconnect?: () => void
  /** WS 连接成功时的回调（首次 + 重连） */
  onConnected?: () => void
  /** WS 重连成功时的回调 */
  onReconnected?: () => void
  /** WS 开始重连时的回调 */
  onReconnecting?: (attempt: number, delayMs: number) => void
  /** 错误处理回调 */
  onError?: (error: Error) => void
  /** WS 认证失败时回调（如 token 过期被服务端拒绝） */
  onAuthFailed?: (error: Error) => void
  /** WS auth 握手时当前 organization 无访问权限 */
  onOrganizationAccessDenied?: (error: Error) => void
  /** 请求超时时间（毫秒），默认 30000 */
  timeout?: number
  /** 普通流式连接静默超时（毫秒），默认 90000 */
  streamTimeoutMs?: number
  /** Remote runtime 流式连接静默超时（毫秒），默认 600000（10 分钟） */
  remoteRuntimeTimeoutMs?: number
  /** chunk 静默警告阈值（毫秒），超过后触发 onHeartbeat 回调，默认 180000 */
  chunkSilenceWarningMs?: number
  /** 可选：注入 API 适配器查询 run 状态（替代 StreamManager 内部 raw fetch） */
  probeRun?: (runId: string) => Promise<{ status: string; pending_interaction?: Record<string, unknown> }>
  /**
   * v0.4 W1.5（PRD 05 §7.8）：可选注入"该 sessionId 是否仍 streaming"的判定
   * 回调，让 `ChatClient.isStreaming` / `StreamManager.isStreaming` 优先读宿主
   * 单源（譬如 Renderer 的 `useChatStore.streamingBySessionId`），消除"本地 IPC
   * 主路径下 ChatClient 不建 StreamSlot → isStreaming 永远 false → approvalSlice
   * watchdog 误触发"的伪警告。
   *
   * 不注入时退化为 StreamManager 内部 slot.phase 判定（旧行为，未上线 IPC 链路
   * 的 web / mobile 环境维持原状）。
   */
  streamingChecker?: (sessionId: string) => boolean
}

/**
 * 错误响应
 */
export interface ErrorResponse {
  /** 成功标志 */
  success?: boolean
  /** 错误消息 */
  message?: string
  /** 错误详情 */
  detail?: string
  /** 错误信息 */
  error?: string
  /** 错误代码 */
  code?: number
  /** 错误类别（insufficient_credits / budget_exceeded 等） */
  error_category?: string
}

/**
 * 附加诊断字段（W2 F5 新增）。
 *
 * 单独抽 interface 是为了让顶层的 ``code`` / ``trace_id`` / ``detail`` 区别
 * 于历史的 ``ErrorResponse.code``（后者是 HTTP 风格的 ``number``，仅出现在
 * Django 老 ``{success, code, message, data}`` helper 里）。新 envelope
 * ``error.code`` 是字符串 ErrorCode，譬如 ``'SOFT_FAIL'`` / ``'UNAUTHORIZED'``。
 */
export interface ChatAPIErrorExtras {
  /**
   * envelope ``error.code``（字符串 ErrorCode），譬如 ``'SOFT_FAIL'`` /
   * ``'UNAUTHORIZED'`` / ``'NOT_FOUND'``。caller 用它做 silentCodes 过滤、
   * sentry 分组、分支处理。
   */
  code?: string
  /**
   * envelope 顶层 ``trace_id``，由 Django ``RequestIdMiddleware`` 注入；
   * 与 ``GatewayEnvelope.trace_id`` 同位置同语义。caller / toast 取末 6 位
   * 让用户截屏复述给开发者反查 audit log。
   */
  trace_id?: string
  /**
   * envelope ``error.detail``。SOFT_FAIL 标准形态是
   * ``{ fallback: <originalData>, reason: <machine-code> }``；CONFLICT
   * 等其他码可带各自子结构。caller 主动消费时按 code 解构。
   */
  detail?: unknown
}

/**
 * API 错误类
 *
 * Wave 2 F5 起在历史的 ``message`` / ``statusCode`` / ``response`` 三字段之上
 * 增三个顶层字段（``code`` / ``trace_id`` / ``detail``）—— 由 ``HttpClient
 * .unwrapResponse`` 在识别新 envelope ``{ok:false}`` 时自动 stamp。caller
 * 如果在 catch 里只访问 ``err.message`` / ``err.statusCode`` / ``err.response``
 * 仍兼容（新字段是可选的）。
 *
 * **注意**：``response.code`` 是 HTTP 风格的 ``number`` 字段（来自老
 * ``{success, code, message, data}`` helper），与顶层 ``code: string``（来自
 * envelope ``error.code``）**不是同一字段**。请按用途选择。
 */
export class ChatAPIError extends Error {
  /** envelope ``error.code`` 顶层访问（详见 {@link ChatAPIErrorExtras.code}） */
  readonly code?: string
  /** envelope 顶层 ``trace_id`` 顶层访问（详见 {@link ChatAPIErrorExtras.trace_id}） */
  readonly trace_id?: string
  /** envelope ``error.detail`` 顶层访问（详见 {@link ChatAPIErrorExtras.detail}） */
  readonly detail?: unknown

  constructor(
    message: string,
    public statusCode: number,
    public response?: ErrorResponse,
    extras?: ChatAPIErrorExtras,
  ) {
    super(message)
    this.name = 'ChatAPIError'
    this.code = extras?.code
    this.trace_id = extras?.trace_id
    this.detail = extras?.detail
  }
}













