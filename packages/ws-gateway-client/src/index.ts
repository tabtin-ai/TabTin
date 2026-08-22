export {
  AgentStreamEvents,
  AgentSessionEvents,
  AgentActionEvents,
  LocalRuntimeEvents,
  GatewayProtocolEvents,
  DomainEvents,
  ChatSessionPresenceEvents,
  ChatSessionPresenceTiming,
  TrackerEvents,
  ContextSyncEvents,
  BillingEvents,
  BILLING_EVENTS_TOPIC,
  Capabilities,
  isAgentStreamEvent,
  isAgentSessionEvent,
  normalizeStreamEventType,
} from './events.js'

export type {
  AgentStreamEventType,
  AgentSessionEventType,
  AgentActionEventType,
  LocalRuntimeEventType,
  GatewayProtocolEventType,
  DomainEventType,
  ChatSessionPresenceEventType,
  TrackerEventType,
  ContextSyncEventType,
  BillingEventType,
  CapabilityType,
} from './events.js'

import {
  bytesToBase64,
  FRAME_FRAGMENT_C2S_CAPABILITY,
  FRAME_FRAGMENT_ENCODING,
  FRAME_FRAGMENT_TYPE,
  MAX_FRAME_FRAGMENT_COUNT,
  MAX_LOGICAL_FRAME_BYTES,
  sha256Hex,
} from './frame-fragment.js'

export {
  FRAME_FRAGMENT_C2S_CAPABILITY,
  FRAME_FRAGMENT_ENCODING,
  FRAME_FRAGMENT_TYPE,
  MAX_FRAME_FRAGMENT_COUNT,
  MAX_LOGICAL_FRAME_BYTES,
} from './frame-fragment.js'
export type { FrameFragmentPayload } from './frame-fragment.js'

type GatewayRole =
  | 'electron'
  | 'web'
  | 'mobile'
  | 'admin'
  | 'backend'
  | 'channel'
  | 'daemon'
  | 'device_runtime'
  | 'open_api'

export type GatewayDeviceInfo = {
  name?: string
  platform?: string
  os?: string
  os_version?: string
  app_version?: string
  model?: string
  manufacturer?: string
}

export type GatewayAuthContext = {
  token: string
  /** 安装实例持有的设备凭据；旧客户端可不传并保持普通连接。 */
  deviceCredential?: string
  /**
   * 可选：前台 organization id。
   * - 作为 auth.payload.organization_id 传给服务端，服务端用它作为
   *   organization_ctx.primary_id 的 hint（若属于用户有效 membership）。
   * - 客户端 envelope 的 organization_id 默认值也来自这里（可被
   *   options.organizationId 覆盖）。
   * - 不传也能成功 auth：服务端按 membership 自动选 primary。
   */
  organizationId?: string
  /**
   * auth.ok 返回后由客户端回填，表示该用户当前所属的全部 organization。
   * 调用方不需要填这个字段，它由 WsGatewayClient 在 auth 成功后
   * 自动写入 authContext。
   */
  organizationIds?: string[]
  device?: GatewayDeviceInfo
}

export type GatewayRequestOptions = {
  threadId?: string
  traceId?: string
  organizationId?: string
  sessionId?: string
  tableId?: string
  instanceId?: string
}

export type GatewayErrorPayload = {
  code: string
  message: string
  details?: Record<string, unknown>
}

export type GatewayResponse = {
  ok: boolean
  type: string
  requestId: string
  payload?: any
  error?: GatewayErrorPayload
}

export type GatewayEnvelope = {
  v: number
  type: string
  request_id: string
  ts: number
  device_id: string
  role: GatewayRole
  payload: Record<string, any>
  event_id?: string
  _topic?: string
  _delivery?: 'replay'
  reply_to?: string
  thread_id?: string
  trace_id?: string
  organization_id?: string
  session_id?: string
  table_id?: string
  instance_id?: string
}

type GatewayStatus = 'idle' | 'connecting' | 'ready'

export type GatewayClientStatus = GatewayStatus

type GatewayReadyInfo = {
  reconnected: boolean
}

type GatewayClientError = {
  message: string
  code?: string
  details?: Record<string, unknown>
}

export const WS_ORGANIZATION_ACCESS_DENIED = 'WS_ORGANIZATION_ACCESS_DENIED'

export function isOrganizationAccessDeniedError(code?: string, message?: string): boolean {
  if (code !== 'WS_1005_PERMISSION_DENIED') return false
  return typeof message === 'string' && /organization access denied/i.test(message)
}

function isDefinitiveAuthFailureCode(code?: string): boolean {
  if (!code) return false
  return (
    code === 'WS_AUTH_FAILED' ||
    code === 'WS_AUTH_REVOKED' ||
    code === 'WS_TOKEN_REVALIDATION_FAILED' ||
    code === WS_ORGANIZATION_ACCESS_DENIED ||
    code === 'AUTH_FAILED' ||
    code === 'AUTH_TOKEN_EXPIRED' ||
    code === 'AUTH_INVALID' ||
    code === 'AUTH_REVOKED' ||
    code === 'TOKEN_EXPIRED' ||
    code === 'TOKEN_REVOKED' ||
    code === 'TOKEN_INVALID'
  )
}

type WebSocketLike = {
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  addEventListener?: (type: string, listener: (event: any) => void, options?: any) => void
  removeEventListener?: (type: string, listener: (event: any) => void, options?: any) => void
  on?: (event: string, listener: (...args: any[]) => void) => void
  off?: (event: string, listener: (...args: any[]) => void) => void
  once?: (event: string, listener: (...args: any[]) => void) => void
  removeListener?: (event: string, listener: (...args: any[]) => void) => void
  onopen?: ((event: any) => void) | null
  onmessage?: ((event: any) => void) | null
  onerror?: ((event: any) => void) | null
  onclose?: ((event: any) => void) | null
}

type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike

type GatewayClientOptions = {
  role: GatewayRole
  capabilities: string[]
  deviceId?: string
  wsBaseUrl: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
  healthCheckIntervalMs?: number
  reconnectMinDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectFactor?: number
  maxOutboundMessageBytes?: number
  /** 出站空闲超过此时间则主动发 ping，防止被后端静默断连。默认 50s。 */
  outboundPingIntervalMs?: number
  /**
   * 周期性 token 重验间隔（ms）。启用后客户端定期调用 refreshAuth 检查
   * token 是否仍然有效，若无效则主动断开且不自动重连（DS-028）。
   * 设为 0 或不设则禁用。
   */
  tokenRevalidateIntervalMs?: number
  /** 单 topic catch-up 期间最多缓冲的 realtime 事件数；溢出时 fail closed。 */
  catchupBufferLimitPerTopic?: number
  initialTopics?: string[]
  emitTicks?: boolean
  WebSocketImpl?: WebSocketConstructor
  /** 重连前调用以获取最新 auth（如刷新 token）。返回 null 则停止重连。 */
  refreshAuth?: () => Promise<GatewayAuthContext | null>
  onEvent?: (envelope: GatewayEnvelope) => void
  onStatusChange?: (status: GatewayStatus) => void
  onReady?: (info: GatewayReadyInfo) => void
  onError?: (error: GatewayClientError) => void
  /**
   * Redis event buffer 已经无法从当前 cursor 连续回放时调用。
   *
   * 连接仍会进入 ready，由上层通过 HTTP/持久化历史执行权威对账；
   * 不应从 0-0 盲目重放一段已被压缩或裁剪的流。
   */
  onReplayGap?: (error: GatewayClientError) => void
  /** 服务端拒绝认证时调用（如 token 过期），调用后不再自动重连 */
  onAuthFailed?: (error: GatewayClientError) => void
  /** auth 握手时 organization_id hint 无 viewer 权限；调用后不再自动重连 */
  onOrganizationAccessDenied?: (error: GatewayClientError) => void
  onDisconnect?: () => void
}

type PendingRequest = {
  resolve: (value: GatewayResponse) => void
  timeoutId: ReturnType<typeof setTimeout>
}

type SubscriptionRecoveryPhase = 'subscribing' | 'catching_up' | 'flushing' | 'failed'

type SubscriptionRecoveryState = {
  phase: SubscriptionRecoveryPhase
  cursor?: string
  bufferedRealtime: GatewayEnvelope[]
  seenDuringCatchup: Set<string>
  generation: number
  startedAt: number
  pageCount: number
  replayedCount: number
}

type EncodedOutboundFrames = {
  wires: string[]
  physicalRequestIds: string[]
}

const WS_OPEN = 1
/** 与服务端单页 resume 上限对齐；超过则 payload 带 next_cursor，需继续请求。 */
const MAX_RESUME_PAGINATION_ROUNDS = 10
const MAX_RESUME_EVENTS_PER_PAGE = 500
const MAX_CATCHUP_SEEN_EVENTS_PER_TOPIC =
  (MAX_RESUME_PAGINATION_ROUNDS + 1) * MAX_RESUME_EVENTS_PER_PAGE
const RESUME_PAGE_DELAY_MS = 100
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_IDLE_TIMEOUT_MS = 45_000
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000
const DEFAULT_RECONNECT_MIN_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000
const DEFAULT_RECONNECT_FACTOR = 1.5
const DEFAULT_OUTBOUND_PING_INTERVAL_MS = 50_000
const DEFAULT_CATCHUP_BUFFER_LIMIT_PER_TOPIC = 1_000
class OutboundFrameError extends Error {
  constructor(readonly code: 'WS_MESSAGE_TOO_LARGE' | 'WS_FRAME_FRAGMENT_FAILED', message: string) {
    super(message)
  }
}

/**
 * These buffered events are complete only after the business consumer admits
 * them, not when the WebSocket frame arrives. Advancing the resume cursor here
 * would strand a forward whose AgentHost admission failed or was interrupted.
 */
function requiresApplicationAck(envelope: GatewayEnvelope): boolean {
  return envelope.type === 'agent.prompt.forward'
    && typeof envelope._topic === 'string'
    && envelope._topic.startsWith('agent.action.device.')
    && typeof envelope.event_id === 'string'
    && /^[0-9]+-[0-9]+$/.test(envelope.event_id)
    && typeof envelope.payload?.run_id === 'string'
    && envelope.payload.run_id.length > 0
}

const FALLBACK_ERROR: GatewayResponse = {
  ok: false,
  type: 'error',
  requestId: 'req_unavailable',
  error: {
    code: 'WS_CLIENT_NOT_READY',
    message: 'ws connection not ready'
  }
}

function isTimestampSchemaInvalid(response: GatewayResponse): boolean {
  const details = response.error?.details
  return response.ok === false
    && response.error?.code === 'WS_1003_SCHEMA_INVALID'
    && typeof response.error.message === 'string'
    && response.error.message.includes('ts out of acceptable range')
    && !!details
    && typeof details === 'object'
    && (details as { field?: unknown }).field === 'ts'
}

function generateId(prefix: string): string {
  const cryptoRef = typeof crypto !== 'undefined' ? crypto : undefined
  if (cryptoRef?.randomUUID) {
    return `${prefix}_${cryptoRef.randomUUID()}`
  }
  const randomPart = Math.random().toString(16).slice(2)
  const timePart = Date.now().toString(16)
  return `${prefix}_${timePart}${randomPart}`
}

function generateDeviceId(role: string): string {
  const cryptoRef = typeof crypto !== 'undefined' ? crypto : undefined
  if (cryptoRef?.randomUUID) {
    return `${role}-${cryptoRef.randomUUID()}`
  }
  const randomPart = Math.random().toString(16).slice(2)
  const timePart = Date.now().toString(16)
  return `${role}-${timePart}${randomPart}`
}

function resolveWebSocketImpl(explicit?: WebSocketConstructor): WebSocketConstructor | null {
  if (explicit) {
    return explicit
  }
  if (typeof WebSocket !== 'undefined') {
    return WebSocket as unknown as WebSocketConstructor
  }
  return null
}

function sanitizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const item of input) {
    if (typeof item === 'string' && item.length > 0) out.push(item)
  }
  return out
}

const DEFINITIVE_SUBSCRIBE_FAILURE_CODES = new Set([
  'WS_1003_SCHEMA_INVALID',
  'WS_1004_TYPE_UNKNOWN',
  'WS_1005_PERMISSION_DENIED',
  'WS_1006_NOT_FOUND',
])

const TRANSPORT_FAILURE_CODES = new Set([
  'WS_DISCONNECTED',
  'WS_NOT_CONNECTED',
  'WS_SEND_FAILED',
  'WS_CLOSED',
  'WS_SUSPENDED',
])

function isDefinitiveSubscribeFailureCode(code?: string): boolean {
  return !!code && DEFINITIVE_SUBSCRIBE_FAILURE_CODES.has(code)
}

function isTransportFailureCode(code?: string): boolean {
  return !!code && TRANSPORT_FAILURE_CODES.has(code)
}

function extractFailedSubscribeTopics(response: GatewayResponse, fallbackTopics: string[]): string[] {
  const details = response.error?.details
  if (details && typeof details === 'object') {
    const rawTopics = details.topics
    if (Array.isArray(rawTopics)) {
      const topics = sanitizeStringArray(rawTopics)
      if (topics.length > 0) return topics
    }
    const rawTopic = details.topic
    if (typeof rawTopic === 'string' && rawTopic.length > 0) {
      return [rawTopic]
    }
  }
  // A single-topic request identifies its culprit by construction. A failed batch
  // without server-provided topic details is ambiguous: never discard the whole batch.
  return fallbackTopics.length === 1 ? fallbackTopics : []
}

function toTextPayload(raw: any): string | null {
  if (raw == null) return null
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw))
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw as ArrayBufferView)
  }
  if (typeof raw === 'object' && typeof raw.toString === 'function') {
    return raw.toString()
  }
  return null
}

export class WsGatewayClient {
  private readonly role: GatewayRole
  private readonly capabilities: string[]
  private readonly deviceId: string
  private readonly wsBaseUrl: string
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly healthCheckIntervalMs: number
  private readonly reconnectMinDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly reconnectFactor: number
  private readonly maxOutboundMessageBytes: number
  private readonly catchupBufferLimitPerTopic: number
  private readonly emitTicks: boolean
  private readonly WebSocketImpl?: WebSocketConstructor
  private readonly onEvent?: GatewayClientOptions['onEvent']
  private readonly onStatusChange?: GatewayClientOptions['onStatusChange']
  private readonly onReady?: GatewayClientOptions['onReady']
  private readonly onError?: GatewayClientOptions['onError']
  private readonly onReplayGap?: GatewayClientOptions['onReplayGap']
  private readonly onAuthFailed?: GatewayClientOptions['onAuthFailed']
  private readonly onOrganizationAccessDenied?: GatewayClientOptions['onOrganizationAccessDenied']
  private readonly onDisconnect?: GatewayClientOptions['onDisconnect']
  private readonly refreshAuth?: GatewayClientOptions['refreshAuth']
  private socket?: WebSocketLike
  private status: GatewayStatus = 'idle'
  private connectPromise?: Promise<boolean>
  private authContext?: GatewayAuthContext
  private authKey?: string
  private readonly pending = new Map<string, PendingRequest>()
  private readonly fragmentRequestToOriginal = new Map<string, string>()
  private readonly transportCapabilities = new Set<string>()
  //  网关高延迟韧性：公有 subscribe() 的微任务合批。同一 tick 内多个调用方
  // （如每个 useGatewayTopic 各订一个 topic）的并发单 topic 订阅会被合并成一条
  // sendSubscribe，避免 N 条请求在「后端每消息注入延迟 / 单 worker 拥塞」下 tail
  // 累积超过 requestTimeoutMs 触发超时与重连风暴。
  private pendingSubscribeTopics = new Set<string>()
  private pendingSubscribeWaiters: Array<{ topics: string[]; resolve: (value: GatewayResponse) => void }> = []
  private subscribeFlushScheduled = false
  private readonly desiredTopics = new Set<string>()
  private readonly confirmedTopics = new Set<string>()
  /** Per-topic subscribe extras (e.g. share.events share_collab_token). Kept for reconnect. */
  private readonly desiredTopicContexts = new Map<string, Record<string, unknown>>()
  private subscriptionRetryAttempts = 0
  private subscriptionRetryTimer?: ReturnType<typeof setTimeout>
  private subscriptionReconcilePromise?: Promise<void>
  /** 原始 catch-up 起点跨 transport 保留，直到该 topic 完整恢复。 */
  private readonly subscriptionCatchupCursors = new Map<string, string>()
  /** 当前 generation 的逐 topic barrier；transport 断开即丢弃 buffer，起点仍保留。 */
  private readonly subscriptionRecoveryStates = new Map<string, SubscriptionRecoveryState>()
  private subscriptionReconciliationBlocked = false
  private hasConnected = false
  private reconnectAttempts = 0
  private currentReconnectDelayMs = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private healthTimer?: ReturnType<typeof setInterval>
  private lastInboundAt = 0
  private lastOutboundAt = 0
  private pendingPingRequestId?: string
  private pendingPingSentAt = 0
  private connectionHadHealthyHeartbeat = false
  private readonly outboundPingIntervalMs: number
  private lastEventId?: string
  private readonly lastEventIdPerTopic = new Map<string, string>()
  private readonly pendingApplicationAcksByTopic = new Map<string, Set<string>>()
  private readonly recentEventIdSet = new Set<string>()
  private readonly recentEventIdRing: string[] = []
  private recentEventIdHead = 0
  private recentEventIdCount = 0
  private readonly recentEventIdLimit = 2000
  private closing = false
  private authFailed = false
  private connectionEpoch = 0
  private readonly textEncoder = new TextEncoder()
  private readonly tokenRevalidateIntervalMs: number
  private tokenRevalidateTimer?: ReturnType<typeof setInterval>
  private lastConnectedAt = 0
  private disconnectedAt = 0
  private resumeStartedAt = 0
  /** 当前 resume 序列中已发起的分页次数（不含首次 resume）。 */
  private resumePageCount = 0
  private resumeReplayedTotal = 0
  private resumePaginationTimer?: ReturnType<typeof setTimeout>

  constructor(options: GatewayClientOptions) {
    this.role = options.role
    this.capabilities = options.capabilities
    this.deviceId = options.deviceId ?? generateDeviceId(options.role)
    this.wsBaseUrl = options.wsBaseUrl
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
    this.reconnectMinDelayMs = options.reconnectMinDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
    this.reconnectFactor = options.reconnectFactor ?? DEFAULT_RECONNECT_FACTOR
    this.maxOutboundMessageBytes = options.maxOutboundMessageBytes ?? 0
    this.catchupBufferLimitPerTopic = Math.max(
      1,
      options.catchupBufferLimitPerTopic ?? DEFAULT_CATCHUP_BUFFER_LIMIT_PER_TOPIC,
    )
    this.outboundPingIntervalMs = options.outboundPingIntervalMs ?? DEFAULT_OUTBOUND_PING_INTERVAL_MS
    this.tokenRevalidateIntervalMs = options.tokenRevalidateIntervalMs ?? 0
    this.emitTicks = options.emitTicks ?? false
    this.WebSocketImpl = options.WebSocketImpl
    this.onEvent = options.onEvent
    this.onStatusChange = options.onStatusChange
    this.onReady = options.onReady
    this.onError = options.onError
    this.onReplayGap = options.onReplayGap
    this.onAuthFailed = options.onAuthFailed
    this.onOrganizationAccessDenied = options.onOrganizationAccessDenied
    this.onDisconnect = options.onDisconnect
    this.refreshAuth = options.refreshAuth

    if (options.initialTopics) {
      for (const topic of options.initialTopics) {
        this.desiredTopics.add(topic)
      }
    }
  }

  getStatus(): GatewayStatus {
    return this.status
  }

  getLastEventId(): string | undefined {
    return this.lastEventId
  }

  /**
   * Mark a buffered business event complete after its server-side admission
   * request succeeds. Until then reconnect resumes from 0-0 so neither this
   * event nor a later event on the same topic can move the cursor past it.
   */
  acknowledgeApplicationEvent(eventId: string, topic: string): void {
    const pending = this.pendingApplicationAcksByTopic.get(topic)
    if (!pending?.delete(eventId)) return
    if (pending.size === 0) this.pendingApplicationAcksByTopic.delete(topic)
    this.trackRecentEventId(eventId)
    const current = this.lastEventIdPerTopic.get(topic)
    if (!current || this.compareStreamIds(eventId, current) > 0) {
      this.lastEventIdPerTopic.set(topic, eventId)
    }
    this.lastEventId = this.computeResumeEventId()
  }

  /**
   * W4c · §3.6 catchup 协议：在 `connect()` 之前由调用方注入跨重启持久化的
   * lastEventId，让首次握手完成后自动跑 `sendResume(lastEventId)` 续传断网/
   * 关闭进程期间 backend Redis Stream 缓冲的事件。
   *
   * 调用方约束：
   *   - 仅 connect 之前 / status === 'idle' 调用——此后 lastEventId 由
   *     `handleMessage` 路径权威更新（envelope.event_id），外部覆盖会破坏
   *     "只前进不回退"的语义；status 非 idle 时 noop（避免连接中误覆盖）。
   *   - 传 undefined 等价于"无历史 cursor，从订阅时刻开始接收新事件"
   *     （v2 §3.6 默认行为）。
   *   - 调用方负责 localStorage（或等价持久化）的读写；本类只接受 / 暴露
   *     lastEventId 字符串，不做 IO。
   *
   * 不变量：
   *   - 同一 token + 同一 deviceId 下 lastEventId 单调递增（Redis Stream
   *     eventId 是 timestamp-based）；调用方持久化时直接覆盖即可，无需 max
   *     合并。
   *   - 多 organization 切换 / 重新登录时调用方应清 localStorage（token 变化），
   *     避免新会话拿到旧 cursor 触发 WS_RESUME_OVERFLOW。
   */
  setInitialLastEventId(id: string | undefined): void {
    if (this.status !== 'idle') {
      console.warn('[WsGatewayClient] setInitialLastEventId noop: status is %s, expect "idle"', this.status)
      return
    }
    this.lastEventId = id && typeof id === 'string' && id.length > 0 ? id : undefined
  }

  isConnected(): boolean {
    return this.status === 'ready'
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  getReconnectDelayMs(): number {
    return this.currentReconnectDelayMs
  }

  getDeviceId(): string {
    return this.deviceId
  }

  /** 用户所属全部 organization 快照（auth.ok 或 organization.membership_changed 后由 WsGatewayClient 回填）。 */
  getOrganizationIds(): string[] {
    return this.authContext?.organizationIds ? [...this.authContext.organizationIds] : []
  }

  /** 当前前台 organization（primary） —— 作为 envelope organization_id 默认值的那一个。 */
  getPrimaryOrganizationId(): string | undefined {
    return this.authContext?.organizationId
  }

  async connect(auth: GatewayAuthContext): Promise<boolean> {
    this.updateAuthContext(auth)
    this.authFailed = false
    this.maybeResetForAuthChange(auth)
    this.closing = false
    this.clearReconnectTimer()
    return this.ensureReady()
  }

  async request(
    auth: GatewayAuthContext,
    messageType: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): Promise<GatewayResponse> {
    this.updateAuthContext(auth)
    this.maybeResetForAuthChange(auth)
    this.closing = false
    const ready = await this.ensureReady()
    if (!ready) {
      return FALLBACK_ERROR
    }

    let lastResponse: GatewayResponse | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestId = this.newRequestId()
      const envelope = this.buildEnvelope(messageType, requestId, payload, options)
      const response = await this.sendEnvelope(envelope)
      lastResponse = response
      if (!isTimestampSchemaInvalid(response)) return response
      if (attempt === 0) {
        console.warn(
          '[WsGatewayClient] retrying request with fresh envelope after stale ts rejection: type=%s',
          messageType,
        )
      }
    }
    return lastResponse ?? {
      ok: false,
      type: 'error',
      requestId: 'req_stale_ts_retry_exhausted',
      error: {
        code: 'WS_1003_SCHEMA_INVALID',
        message: 'ts out of acceptable range after retry',
        details: { field: 'ts' },
      },
    }
  }

  /**
   * 合并式更新 authContext：同一 token 下保留服务端回填的 membership 快照
   * （organizationIds / primary organizationId）。token 变化视为新会话，完全替换。
   *
   * 动机：调用方（如 WsGateway._resolveAuth / refreshAuth）通常只携带
   * `{ token, organizationId? }`，若直接整对象赋值会把 auth.ok 回填的
   * `organizationIds` 清空，后续 `getOrganizationIds()` 长期为空列表。
   */
  private updateAuthContext(auth: GatewayAuthContext): void {
    const prev = this.authContext
    if (!prev || prev.token !== auth.token) {
      // 首次或 token 变化：完全新建会话状态
      this.authContext = { ...auth }
      return
    }
    // 同一 token：合并调用方提供的字段到现有 session state
    this.authContext = {
      ...prev,
      ...auth,
      // organizationIds 是服务端回填字段；调用方没传就保留现有快照
      organizationIds: auth.organizationIds ?? prev.organizationIds,
    }
  }

  /**
   * Fire-and-forget: build & send an envelope without waiting for a response.
   * Used for streaming protocols (ASR audio chunks, etc.) where responses arrive as events.
   * Returns true if the message was sent successfully, false otherwise.
   */
  send(
    messageType: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): boolean {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      return false
    }
    const requestId = generateId('evt')
    const envelope = this.buildEnvelope(messageType, requestId, payload, options)
    try {
      const serialized = JSON.stringify(envelope)
      const outboundFrames = this.encodeOutboundFrames(envelope, serialized)
      for (const frame of outboundFrames.wires) {
        this.socket.send(frame)
      }
      this.markOutbound()
      return true
    } catch {
      return false
    }
  }

  async subscribe(
    topics: string[],
    options?: { topicContexts?: Record<string, Record<string, unknown>> },
  ): Promise<GatewayResponse> {
    for (const topic of topics) {
      this.desiredTopics.add(topic)
      const ctx = options?.topicContexts?.[topic]
      if (ctx && typeof ctx === 'object') {
        this.desiredTopicContexts.set(topic, ctx)
      }
    }
    if (this.status !== 'ready') {
      return FALLBACK_ERROR
    }
    return this.enqueueSubscribe(topics)
  }

  /**
   * 把一次 subscribe 调用挂入当前微任务合批批次；同一 tick 内的并发调用共享
   * 一条 sendSubscribe。返回的 Promise 在批次 flush 后按本调用的 topics 得到结果。
   */
  private enqueueSubscribe(topics: string[]): Promise<GatewayResponse> {
    return new Promise((resolve) => {
      for (const topic of topics) this.pendingSubscribeTopics.add(topic)
      this.pendingSubscribeWaiters.push({ topics, resolve })
      if (!this.subscribeFlushScheduled) {
        this.subscribeFlushScheduled = true
        queueMicrotask(() => { void this.flushPendingSubscribes() })
      }
    })
  }

  private async flushPendingSubscribes(): Promise<void> {
    this.subscribeFlushScheduled = false
    const topics = [...this.pendingSubscribeTopics]
    const waiters = this.pendingSubscribeWaiters
    this.pendingSubscribeTopics = new Set()
    this.pendingSubscribeWaiters = []
    if (waiters.length === 0) return
    // 批次窗口内连接可能已关闭 / 未就绪：与旧 subscribe() 的 not-ready 语义一致，
    // 回 FALLBACK_ERROR（retryable），由上层 useGatewayTopic 退避重试。
    if (this.status !== 'ready') {
      for (const w of waiters) w.resolve(FALLBACK_ERROR)
      return
    }
    const response = await this.sendSubscribe(topics)
    if (response.ok) {
      this.confirmSubscriptionTopics(topics, response)
      const caughtUp = await this.finishSubscriptionReconciliationIfComplete()
      const result = caughtUp ? response : {
        ok: false,
        type: 'error',
        requestId: response.requestId,
        error: {
          code: 'WS_CATCHUP_FAILED',
          message: 'subscription catch-up did not complete',
        },
      }
      for (const w of waiters) w.resolve(result)
      return
    }
    if (isDefinitiveSubscribeFailureCode(response.error?.code)) {
      // 确定性失败只应归因于坏 topic 本身；服务端订阅是原子的（坏 topic → 整批
      // 零订阅）。剔除坏 topic，并让不含坏 topic 的同批调用方拿到可重试错误，
      // 下一批不带坏 topic 即可成功——避免一个坏 topic 误伤整批。
      const failedTopics = new Set(this.dropFailedSubscribeTopics(response, topics, 'subscribe'))
      if (failedTopics.size === 0) {
        this.subscriptionReconciliationBlocked = true
        for (const w of waiters) w.resolve(response)
        return
      }
      for (const w of waiters) {
        const culprit = w.topics.some((t) => failedTopics.has(t))
        // 非肇事方拿 retryable 错误（FALLBACK_ERROR 的 WS_CLIENT_NOT_READY 在
        // useGatewayTopic 的可重试集合内），下一批不带坏 topic 即可成功。
        w.resolve(culprit ? response : FALLBACK_ERROR)
      }
      this.scheduleSubscriptionReconciliation()
      return
    }
    // 瞬时失败（超时 / 断连）：整批可重试。
    if (this.recordSubscriptionTransientFailure(response)) {
      this.scheduleSubscriptionReconciliation()
    }
    for (const w of waiters) w.resolve(response)
  }

  async unsubscribe(topics: string[]): Promise<GatewayResponse> {
    for (const topic of topics) {
      this.desiredTopics.delete(topic)
      this.confirmedTopics.delete(topic)
      this.desiredTopicContexts.delete(topic)
      this.lastEventIdPerTopic.delete(topic)
      this.pendingApplicationAcksByTopic.delete(topic)
      this.subscriptionCatchupCursors.delete(topic)
      this.subscriptionRecoveryStates.delete(topic)
    }
    this.lastEventId = this.computeResumeEventId()
    if (this.status !== 'ready') {
      return FALLBACK_ERROR
    }
    return this.sendUnsubscribe(topics)
  }

  suspend(): void {
    this.disconnectTransport('WS_SUSPENDED', 'ws suspended')
  }

  close(): void {
    this.disconnectTransport('WS_CLOSED', 'ws closed')
    this.subscriptionCatchupCursors.clear()
    this.subscriptionRecoveryStates.clear()
    this.lastEventIdPerTopic.clear()
    this.pendingApplicationAcksByTopic.clear()
    this.recentEventIdSet.clear()
    this.recentEventIdRing.length = 0
    this.recentEventIdHead = 0
    this.recentEventIdCount = 0
    this.lastConnectedAt = 0
    this.disconnectedAt = 0
    this.resumeStartedAt = 0
  }

  private disconnectTransport(code: string, message: string): void {
    this.connectionEpoch += 1
    this.closing = true
    this.discardSubscriptionRecoveryGeneration()
    this.clearResumePaginationTimer()
    this.stopHealthMonitor()
    this.stopTokenRevalidation()
    this.clearReconnectTimer()
    this.clearSubscriptionReconciliation()
    this.connectPromise = undefined
    this.setStatus('idle')
    if (this.socket && this.socket.readyState < 2) {
      this.socket.close()
    }
    this.socket = undefined
    this.confirmedTopics.clear()
    this.clearAllPending(code, message)
    this.fragmentRequestToOriginal.clear()
    this.clearPendingSubscribeBatch(code, message)
  }

  /** 结清尚未 flush 的 subscribe 合批批次（close / 连接重置时调用）。 */
  private clearPendingSubscribeBatch(code: string, message: string): void {
    const waiters = this.pendingSubscribeWaiters
    this.pendingSubscribeWaiters = []
    this.pendingSubscribeTopics = new Set()
    this.subscribeFlushScheduled = false
    for (const w of waiters) {
      w.resolve({ ok: false, type: 'error', requestId: 'req_closed', error: { code, message } })
    }
  }

  private clearAllPending(code: string, message: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId)
      pending.resolve({
        ok: false,
        type: 'error',
        requestId,
        error: { code, message }
      })
    }
    this.pending.clear()
    this.fragmentRequestToOriginal.clear()
  }

  private clearFragmentRequestMappings(originalRequestId: string): void {
    for (const [physicalRequestId, mappedOriginalRequestId] of this.fragmentRequestToOriginal) {
      if (mappedOriginalRequestId === originalRequestId) {
        this.fragmentRequestToOriginal.delete(physicalRequestId)
      }
    }
  }

  private ensureReady(): Promise<boolean> {
    if (this.status === 'ready') return Promise.resolve(true)
    if (!this.authContext) return Promise.resolve(false)
    if (this.connectPromise) return this.connectPromise

    const startEpoch = this.connectionEpoch
    const connectPromise = this.refreshAndConnect(startEpoch)
    this.connectPromise = connectPromise
    void connectPromise.then(
      () => this.clearConnectPromise(connectPromise),
      () => this.clearConnectPromise(connectPromise),
    )
    return connectPromise
  }

  private clearConnectPromise(connectPromise: Promise<boolean>): void {
    if (this.connectPromise === connectPromise) {
      this.connectPromise = undefined
    }
  }

  private async refreshAndConnect(startEpoch: number): Promise<boolean> {
    if (this.refreshAuth) {
      try {
        const freshAuth = await this.refreshAuth()
        if (this.connectionEpoch !== startEpoch || this.closing) return false
        if (!freshAuth) return false
        // 走合并语义：若 token 不变则保留服务端已回填的 organizationIds 快照；
        // 若 refreshAuth 返回新 token（token 轮换场景）则按新会话替换。
        // 与 request / connect / revalidateToken 的路径保持一致。
        this.updateAuthContext(freshAuth)
        // ensureReady 的后续 connectSocket 会用新 token 完成一次完整 auth，
        // 这里同步对齐 authKey，避免下次 request / connect 的
        // maybeResetForAuthChange 判定"authKey 与 token 不一致"又做一次
        // 不必要的断连重连。token 不变时 authKey 也不变，无副作用。
        this.authKey = freshAuth.token
      } catch {
        if (this.connectionEpoch !== startEpoch || this.closing) return false
        // refreshAuth failed – proceed with existing auth
      }
    }
    if (this.connectionEpoch !== startEpoch || this.closing) return false
    return this.connectSocket()
  }

  private async connectSocket(): Promise<boolean> {
    if (!this.authContext) return false
    this.connectionEpoch += 1
    const epoch = this.connectionEpoch
    this.confirmedTopics.clear()
    this.subscriptionReconciliationBlocked = false
    this.connectionHadHealthyHeartbeat = false
    const WebSocketImpl = resolveWebSocketImpl(this.WebSocketImpl)
    if (!WebSocketImpl) {
      this.handleError({ message: 'WebSocket not available in this runtime' })
      this.setStatus('idle')
      return false
    }

    this.setStatus('connecting')
    const gatewayUrl = new URL('/ws/v1/gateway', this.wsBaseUrl).toString()
    try {
      this.socket = new WebSocketImpl(gatewayUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'WebSocket connection failed'
      this.handleError({ message })
      this.setStatus('idle')
      return false
    }

    this.bindSocket(this.socket)

    const opened = await this.waitForOpen(this.socket)
    if (this.connectionEpoch !== epoch) return false
    if (!opened || this.closing) {
      console.warn('[WsGatewayClient] waitForOpen failed: opened=%s closing=%s readyState=%s url=%s', opened, this.closing, this.socket?.readyState, gatewayUrl)
      this.setStatus('idle')
      return false
    }

    const authResponse = await this.sendAuth()
    if (
      this.connectionEpoch !== epoch
      || this.closing
      || !this.socket
      || this.socket.readyState !== WS_OPEN
    ) return false
    if (!authResponse.ok || authResponse.type !== 'auth.ok') {
      const authError: GatewayClientError = {
        message: authResponse.error?.message || 'Authentication failed',
        code: authResponse.error?.code || 'WS_AUTH_FAILED',
        details: authResponse.error?.details,
      }
      const organizationAccessDenied = isOrganizationAccessDeniedError(
        authError.code,
        authError.message,
      )
      const definitiveAuthFailure = isDefinitiveAuthFailureCode(authError.code)
        || organizationAccessDenied
      const telemetryCode = organizationAccessDenied
        ? WS_ORGANIZATION_ACCESS_DENIED
        : authError.code
      console.log('[WS Telemetry]', JSON.stringify({
        event: definitiveAuthFailure ? 'auth_failure' : 'connect_failure',
        system: 'gateway',
        code: telemetryCode,
      }))
      if (organizationAccessDenied) {
        const orgError: GatewayClientError = {
          ...authError,
          code: WS_ORGANIZATION_ACCESS_DENIED,
        }
        this.authFailed = true
        this.onOrganizationAccessDenied?.(orgError)
      } else if (definitiveAuthFailure) {
        this.authFailed = true
        this.onAuthFailed?.(authError)
      } else {
        this.onError?.(authError)
      }
      this.setStatus('idle')
      if (this.socket && this.socket.readyState < 2) {
        this.socket.close()
      }
      this.socket = undefined
      return false
    }

    this.applyAuthOkPayload(authResponse.payload)

    const subscribed = await this.syncSubscriptions()
    if (
      this.connectionEpoch !== epoch
      || this.closing
      || !this.socket
      || this.socket.readyState !== WS_OPEN
    ) return false

    const caughtUp = subscribed
      ? await this.finishSubscriptionReconciliationIfComplete()
      : true
    if (!caughtUp) return false

    // 无显式 topic 的旧调用方继续使用全局 cursor 协议；显式订阅由逐 topic barrier 接管。
    if (subscribed && this.desiredTopics.size === 0 && this.lastEventId) {
      await this.sendResume(this.lastEventId)
      if (
        this.connectionEpoch !== epoch
        || this.closing
        || !this.socket
        || this.socket.readyState !== WS_OPEN
      ) return false
    }
    if (subscribed && !this.hasPendingSubscriptionRecovery()) {
      this.subscriptionRetryAttempts = 0
    }

    if (
      this.connectionEpoch !== epoch
      || this.closing
      || !this.socket
      || this.socket.readyState !== WS_OPEN
    ) return false
    this.startHealthMonitor()
    this.startTokenRevalidation()
    const reconnectAttemptCount = this.reconnectAttempts
    this.setStatus('ready')
    if (!subscribed || this.hasPendingSubscriptionRecovery()) {
      this.scheduleSubscriptionReconciliation()
    }
    if (this.disconnectedAt > 0) {
      console.log('[WS Telemetry]', JSON.stringify({
        event: 'reconnect',
        system: 'gateway',
        attempt: reconnectAttemptCount,
        reconnectDuration: Date.now() - this.disconnectedAt,
      }))
      this.disconnectedAt = 0
    }
    this.lastConnectedAt = Date.now()
    const reconnected = this.hasConnected
    this.hasConnected = true
    this.onReady?.({ reconnected })
    return true
  }

  private bindSocket(socket: WebSocketLike): void {
    const epoch = this.connectionEpoch
    const isStale = () => this.connectionEpoch !== epoch

    const onMessage = (data: any) => {
      if (isStale()) return
      this.handleMessage(data)
    }
    const onClose = (codeOrEvent?: any, reason?: any) => {
      if (isStale()) return
      const code = typeof codeOrEvent === 'number' ? codeOrEvent : codeOrEvent?.code
      const closeReason = typeof codeOrEvent === 'number'
        ? (reason != null ? String(reason) : undefined)
        : codeOrEvent?.reason
      this.handleClose(code, closeReason)
    }
    const onError = (error: any) => {
      if (isStale()) return
      this.handleSocketError(error)
    }

    if (typeof socket.on === 'function') {
      socket.on('message', onMessage)
      socket.on('close', onClose)
      socket.on('error', onError)
      return
    }

    socket.onmessage = (event: any) => onMessage(event?.data)
    socket.onclose = onClose
    socket.onerror = onError
  }

  private waitForOpen(socket: WebSocketLike): Promise<boolean> {
    if (socket.readyState === WS_OPEN) return Promise.resolve(true)
    return new Promise((resolve) => {
      let resolved = false
      let removeListeners = () => {}

      const done = (result: boolean, reason: string) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeoutId)
        removeListeners()
        if (!result) {
          console.warn('[WsGatewayClient] waitForOpen → %s (readyState=%s)', reason, socket.readyState)
        }
        resolve(result)
      }

      const timeoutId = setTimeout(() => done(false, 'timeout'), this.connectTimeoutMs)

      const handleOpen = () => done(true, 'opened')
      const handleError = (err?: any) => {
        const msg = err?.message || err?.type || err || 'unknown'
        done(false, `error: ${msg}`)
      }
      const handleClose = (code?: any, reason?: any) => {
        done(false, `closed(code=${code}, reason=${reason || ''})`)
      }

      if (typeof socket.once === 'function') {
        socket.once('open', handleOpen)
        socket.once('error', handleError)
        socket.once('close', handleClose)
        removeListeners = () => {
          const remove = socket.removeListener ?? socket.off
          if (typeof remove === 'function') {
            remove.call(socket, 'open', handleOpen)
            remove.call(socket, 'error', handleError)
            remove.call(socket, 'close', handleClose)
          }
        }
        return
      }

      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', handleOpen, { once: true })
        socket.addEventListener('error', handleError, { once: true })
        socket.addEventListener('close', handleClose, { once: true })
        removeListeners = () => {
          socket.removeEventListener!('open', handleOpen)
          socket.removeEventListener!('error', handleError)
          socket.removeEventListener!('close', handleClose)
        }
        return
      }

      socket.onopen = handleOpen
      socket.onerror = handleError
      removeListeners = () => {
        socket.onopen = null
        socket.onerror = null
      }
    })
  }

  private async sendAuth(): Promise<GatewayResponse> {
    if (!this.authContext) {
      return {
        ok: false,
        type: 'error',
        requestId: 'req_no_auth',
        error: { code: 'WS_NO_AUTH_CONTEXT', message: 'No auth context provided' },
      }
    }
    const requestId = this.newRequestId()
    const authPayload: Record<string, any> = {
      access_token: this.authContext.token,
      capabilities: this.capabilities,
    }
    if (this.authContext.organizationId) {
      authPayload.organization_id = this.authContext.organizationId
    }
    if (this.authContext.deviceCredential) {
      authPayload.device_credential = this.authContext.deviceCredential
    }
    if (this.authContext.device) {
      authPayload.device = this.authContext.device
    }
    const envelope = this.buildEnvelope('auth', requestId, authPayload)
    return this.sendEnvelope(envelope)
  }

  private async syncSubscriptions(): Promise<boolean> {
    while (true) {
      const topics = this.getMissingSubscriptionTopics()
      if (topics.length === 0) return true
      const response = await this.sendSubscribe(topics)
      if (response.ok && response.type === 'subscribe.ok') {
        this.confirmSubscriptionTopics(topics, response)
        return this.getMissingSubscriptionTopics().length === 0
      }
      if (isDefinitiveSubscribeFailureCode(response.error?.code)) {
        const failedTopics = this.dropFailedSubscribeTopics(response, topics, 'syncSubscriptions')
        if (failedTopics.length === 0) {
          this.subscriptionReconciliationBlocked = true
          return false
        }
        continue
      }
      this.recordSubscriptionTransientFailure(response)
      return false
    }
  }

  private getMissingSubscriptionTopics(): string[] {
    return [...this.desiredTopics].filter((topic) => !this.confirmedTopics.has(topic))
  }

  private confirmSubscriptionTopics(topics: string[], response: GatewayResponse): void {
    this.subscriptionReconciliationBlocked = false
    const boundaries = this.extractBoundaryCursors(response.payload)
    for (const topic of topics) {
      if (!this.desiredTopics.has(topic)) continue
      this.confirmedTopics.add(topic)
      const state = this.subscriptionRecoveryStates.get(topic)
      if (!state) continue
      const cursor = this.pendingApplicationAcksByTopic.has(topic)
        ? '0-0'
        : this.subscriptionCatchupCursors.get(topic)
        ?? this.lastEventIdPerTopic.get(topic)
        ?? boundaries.get(topic)
      if (!cursor) {
        // 旧服务端没有 boundary_cursors：保持向前兼容，但绝不猜测 0-0。
        this.subscriptionRecoveryStates.delete(topic)
        continue
      }
      state.cursor = cursor
      state.phase = 'catching_up'
      this.subscriptionCatchupCursors.set(topic, cursor)
    }
  }

  private extractBoundaryCursors(payload: unknown): Map<string, string> {
    const result = new Map<string, string>()
    if (!payload || typeof payload !== 'object') return result
    const raw = (payload as Record<string, unknown>).boundary_cursors
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
    for (const [topic, cursor] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof cursor === 'string' && cursor.length > 0) result.set(topic, cursor)
    }
    return result
  }

  private recordSubscriptionTransientFailure(response: GatewayResponse): boolean {
    const code = response.error?.code
    if (isTransportFailureCode(code)) return false
    console.log('[WS Telemetry]', JSON.stringify({
      event: code === 'WS_REQUEST_TIMEOUT' ? 'subscription_timeout' : 'subscription_retryable_failure',
      system: 'gateway',
      code: code ?? response.type,
      desiredSubscriptions: this.desiredTopics.size,
      confirmedSubscriptions: this.confirmedTopics.size,
      retrySubscriptions: this.getMissingSubscriptionTopics().length,
    }))
    return true
  }

  private scheduleSubscriptionReconciliation(): void {
    if (this.subscriptionRetryTimer || this.subscriptionReconcilePromise) return
    if (this.subscriptionReconciliationBlocked) return
    if (!this.socket || this.socket.readyState !== WS_OPEN || this.closing) return
    if (
      this.getMissingSubscriptionTopics().length === 0
      && !this.hasPendingSubscriptionRecovery()
    ) return
    const baseDelay = Math.min(
      this.reconnectMaxDelayMs,
      Math.round(this.reconnectMinDelayMs * Math.pow(this.reconnectFactor, this.subscriptionRetryAttempts)),
    )
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      Math.round(baseDelay * (0.5 + Math.random())),
    )
    this.subscriptionRetryAttempts += 1
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'subscription_retry',
      system: 'gateway',
      attempt: this.subscriptionRetryAttempts,
      backoffMs: delay,
      desiredSubscriptions: this.desiredTopics.size,
      confirmedSubscriptions: this.confirmedTopics.size,
      retrySubscriptions: this.getMissingSubscriptionTopics().length,
    }))
    this.subscriptionRetryTimer = setTimeout(() => {
      this.subscriptionRetryTimer = undefined
      void this.reconcileSubscriptions()
    }, delay)
  }

  private reconcileSubscriptions(): Promise<void> {
    if (this.subscriptionReconcilePromise) return this.subscriptionReconcilePromise
    const epoch = this.connectionEpoch
    const promise = (async () => {
      const reconciled = await this.syncSubscriptions()
      if (this.connectionEpoch !== epoch || this.closing) return
      if (!reconciled) return
      await this.finishSubscriptionReconciliationIfComplete()
    })()
    this.subscriptionReconcilePromise = promise
    void promise.finally(() => {
      if (this.subscriptionReconcilePromise === promise) {
        this.subscriptionReconcilePromise = undefined
      }
      if (
        this.connectionEpoch === epoch
        && !this.closing
        && (
          this.getMissingSubscriptionTopics().length > 0
          || this.hasPendingSubscriptionRecovery()
        )
      ) {
        this.scheduleSubscriptionReconciliation()
      }
    })
    return promise
  }

  private async finishSubscriptionReconciliationIfComplete(): Promise<boolean> {
    if (this.getMissingSubscriptionTopics().length > 0) return false
    const retryAttempts = this.subscriptionRetryAttempts
    if (retryAttempts > 0 || this.hasPendingSubscriptionRecovery()) {
      console.log('[WS Telemetry]', JSON.stringify({
        event: 'subscription_reconciled',
        system: 'gateway',
        attempts: retryAttempts,
        desiredSubscriptions: this.desiredTopics.size,
        confirmedSubscriptions: this.confirmedTopics.size,
      }))
    }
    if (this.hasPendingSubscriptionRecovery()) {
      const caughtUp = await this.runSubscriptionCatchup()
      if (!caughtUp) return false
    }
    this.subscriptionRetryAttempts = 0
    this.maybeResetReconnectBackoff()
    return true
  }

  private clearSubscriptionReconciliation(resetAttempts = true): void {
    if (this.subscriptionRetryTimer) {
      clearTimeout(this.subscriptionRetryTimer)
      this.subscriptionRetryTimer = undefined
    }
    this.subscriptionReconcilePromise = undefined
    if (resetAttempts) this.subscriptionRetryAttempts = 0
  }

  private dropFailedSubscribeTopics(
    response: GatewayResponse,
    fallbackTopics: string[],
    source: 'subscribe' | 'syncSubscriptions',
  ): string[] {
    const failedTopics = extractFailedSubscribeTopics(response, fallbackTopics)
    if (failedTopics.length === 0) {
      console.warn('[WsGatewayClient] definitive subscription failure omitted culprit topics: source=%s code=%s desiredTopics=%d',
        source,
        response.error?.code,
        this.desiredTopics.size,
      )
      console.log('[WS Telemetry]', JSON.stringify({
        event: 'subscription_permission_unscoped',
        system: 'gateway',
        code: response.error?.code,
        desiredSubscriptions: this.desiredTopics.size,
        confirmedSubscriptions: this.confirmedTopics.size,
      }))
      return failedTopics
    }
    this.subscriptionReconciliationBlocked = false
    for (const topic of failedTopics) {
      this.desiredTopics.delete(topic)
      this.confirmedTopics.delete(topic)
      this.desiredTopicContexts.delete(topic)
      this.lastEventIdPerTopic.delete(topic)
      this.pendingApplicationAcksByTopic.delete(topic)
      this.subscriptionCatchupCursors.delete(topic)
      this.subscriptionRecoveryStates.delete(topic)
    }
    this.lastEventId = this.computeResumeEventId()
    console.warn('[WsGatewayClient] dropped definitive failed subscription: source=%s code=%s topics=%s desiredTopics=%d',
      source,
      response.error?.code,
      failedTopics.join(','),
      this.desiredTopics.size,
    )
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'subscription_permission_denied',
      system: 'gateway',
      code: response.error?.code,
      failedSubscriptions: failedTopics.length,
      desiredSubscriptions: this.desiredTopics.size,
      confirmedSubscriptions: this.confirmedTopics.size,
    }))
    return failedTopics
  }

  private async sendSubscribe(topics: string[]): Promise<GatewayResponse> {
    this.prepareSubscriptionRecovery(topics)
    const requestId = this.newRequestId()
    const payload: Record<string, unknown> = { topics }
    const topicContexts: Record<string, Record<string, unknown>> = {}
    for (const topic of topics) {
      const ctx = this.desiredTopicContexts.get(topic)
      if (ctx) {
        topicContexts[topic] = ctx
      }
    }
    if (Object.keys(topicContexts).length > 0) {
      payload.topic_contexts = topicContexts
    }
    const envelope = this.buildEnvelope('subscribe', requestId, payload)
    return this.sendEnvelope(envelope)
  }

  private prepareSubscriptionRecovery(topics: string[]): void {
    for (const topic of topics) {
      if (this.confirmedTopics.has(topic)) continue
      const existing = this.subscriptionRecoveryStates.get(topic)
      if (existing) {
        if (existing.generation !== this.connectionEpoch) {
          existing.phase = 'subscribing'
          existing.generation = this.connectionEpoch
          existing.bufferedRealtime = []
          existing.startedAt = Date.now()
          existing.pageCount = 0
          existing.replayedCount = 0
        }
        continue
      }
      this.subscriptionRecoveryStates.set(topic, {
        phase: 'subscribing',
        cursor: this.subscriptionCatchupCursors.get(topic) ?? this.lastEventIdPerTopic.get(topic),
        bufferedRealtime: [],
        seenDuringCatchup: new Set<string>(),
        generation: this.connectionEpoch,
        startedAt: Date.now(),
        pageCount: 0,
        replayedCount: 0,
      })
    }
  }

  private hasPendingSubscriptionRecovery(): boolean {
    for (const state of this.subscriptionRecoveryStates.values()) {
      if (state.phase === 'subscribing' || state.phase === 'catching_up' || state.phase === 'failed') {
        return true
      }
    }
    return false
  }

  private async runSubscriptionCatchup(): Promise<boolean> {
    const epoch = this.connectionEpoch
    let cursors = new Map<string, string>()
    for (const [topic, state] of this.subscriptionRecoveryStates) {
      if (state.phase === 'failed') return false
      if (state.phase === 'catching_up' && state.cursor) cursors.set(topic, state.cursor)
    }
    if (cursors.size === 0) return true

    for (let page = 1; page <= MAX_RESUME_PAGINATION_ROUNDS + 1; page += 1) {
      if (!this.isCurrentOpenConnection(epoch)) return false
      console.log('[WS Telemetry]', JSON.stringify({
        event: 'subscription_replay_page',
        system: 'gateway',
        page,
        topics: cursors.size,
      }))
      const response = await this.dispatchTopicResumeEnvelope(cursors)
      if (!response.ok) {
        console.log('[WS Telemetry]', JSON.stringify({
          event: 'cursor_catchup_failure',
          system: 'gateway',
          code: response.error?.code ?? response.type,
          topics: cursors.size,
        }))
        if (response.error?.code === 'WS_1014_REPLAY_GAP') {
          this.abandonSubscriptionCatchupForReplayGap(
            [...cursors.keys()],
            {
              message: response.error.message || 'WS replay gap requires authoritative history',
              code: response.error.code,
              details: response.error.details,
            },
          )
          return true
        }
        if (!isTransportFailureCode(response.error?.code)) {
          this.failSubscriptionCatchup(
            [...cursors.keys()],
            response.error?.code ?? 'WS_CATCHUP_FAILED',
            response.error?.message ?? 'subscription catch-up request failed',
          )
        }
        return false
      }
      if (!this.isCurrentOpenConnection(epoch)) return false

      const payload = response.payload && typeof response.payload === 'object'
        ? response.payload as Record<string, unknown>
        : {}
      const replayed = Number(payload.replayed ?? payload.events_count) || 0
      for (const topic of cursors.keys()) {
        const state = this.subscriptionRecoveryStates.get(topic)
        if (!state || state.generation !== epoch) return false
        state.pageCount = page
        state.replayedCount += replayed
      }

      const nextCursors = this.extractNextTopicCursors(payload.next_cursors, cursors)
      const hasMore = payload.has_more === true || nextCursors.size > 0
      for (const topic of cursors.keys()) {
        if (!nextCursors.has(topic)) this.flushTopicRecovery(topic, epoch)
      }
      if (!hasMore) return true

      if (nextCursors.size === 0) {
        this.failSubscriptionCatchup(
          [...cursors.keys()],
          'WS_RESUME_PROTOCOL_ERROR',
          'resume response declared more pages without next topic cursors',
        )
        return false
      }
      if (page >= MAX_RESUME_PAGINATION_ROUNDS + 1) {
        this.failSubscriptionCatchup(
          [...nextCursors.keys()],
          'WS_RESUME_OVERFLOW',
          `resume pagination exceeded ${MAX_RESUME_PAGINATION_ROUNDS + 1} pages`,
        )
        return false
      }
      cursors = nextCursors
    }
    return false
  }

  private abandonSubscriptionCatchupForReplayGap(
    topics: string[],
    error: GatewayClientError,
  ): void {
    for (const topic of topics) {
      this.subscriptionCatchupCursors.delete(topic)
      this.subscriptionRecoveryStates.delete(topic)
      this.lastEventIdPerTopic.delete(topic)
    }
    this.lastEventId = this.computeResumeEventId()
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'subscription_replay_gap',
      system: 'gateway',
      topics: topics.length,
    }))
    this.handleError(error)
    this.onReplayGap?.(error)
  }

  private dispatchTopicResumeEnvelope(cursors: Map<string, string>): Promise<GatewayResponse> {
    const requestId = this.newRequestId()
    const envelope = this.buildEnvelope('resume', requestId, {
      topic_cursors: Object.fromEntries(cursors),
    })
    return this.sendEnvelope(envelope)
  }

  private extractNextTopicCursors(
    value: unknown,
    requested: Map<string, string>,
  ): Map<string, string> {
    const result = new Map<string, string>()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result
    for (const [topic, cursor] of Object.entries(value as Record<string, unknown>)) {
      if (requested.has(topic) && typeof cursor === 'string' && cursor.length > 0) {
        result.set(topic, cursor)
      }
    }
    return result
  }

  private flushTopicRecovery(topic: string, epoch: number): void {
    const state = this.subscriptionRecoveryStates.get(topic)
    if (!state || state.generation !== epoch || state.phase === 'failed') return
    state.phase = 'flushing'
    for (const envelope of state.bufferedRealtime) {
      const eventId = this.getEffectiveEventId(envelope)
      if (eventId && state.seenDuringCatchup.has(eventId)) continue
      if (eventId) state.seenDuringCatchup.add(eventId)
      this.handleMessage(JSON.stringify(envelope))
    }
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'subscription_catchup_complete',
      system: 'gateway',
      topic,
      pages: state.pageCount,
      replayed: state.replayedCount,
      bufferedRealtime: state.bufferedRealtime.length,
      latencyMs: Date.now() - state.startedAt,
    }))
    this.subscriptionRecoveryStates.delete(topic)
    this.subscriptionCatchupCursors.delete(topic)
  }

  private failSubscriptionCatchup(
    topics: string[],
    code: string,
    message: string,
  ): void {
    for (const topic of topics) {
      const state = this.subscriptionRecoveryStates.get(topic)
      if (state) state.phase = 'failed'
    }
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'subscription_catchup_failure',
      system: 'gateway',
      code,
      topics: topics.length,
    }))
    this.handleError({ code, message, details: { topics } })
    // correctness failure requires an explicit new connect owner; never auto-reconnect
    // into a loop that repeatedly releases incomplete history.
    this.closing = true
    this.clearAllPending(code, message)
    if (this.socket && this.socket.readyState < 2) this.socket.close(1011, code)
    this.setStatus('idle')
  }

  private isCurrentOpenConnection(epoch: number): boolean {
    return this.connectionEpoch === epoch
      && !this.closing
      && !!this.socket
      && this.socket.readyState === WS_OPEN
  }

  private async sendUnsubscribe(topics: string[]): Promise<GatewayResponse> {
    const requestId = this.newRequestId()
    const envelope = this.buildEnvelope('unsubscribe', requestId, { topics })
    return this.sendEnvelope(envelope)
  }

  private async sendResume(lastEventId: string): Promise<GatewayResponse> {
    this.clearResumePaginationTimer()
    this.resumePageCount = 0
    this.resumeReplayedTotal = 0
    this.resumeStartedAt = Date.now()
    const response = await this.dispatchResumeEnvelope(lastEventId)
    this.reportResumeFailure(response)
    return response
  }

  private reportResumeFailure(response: GatewayResponse): void {
    if (response.ok) return
    const error: GatewayClientError = {
      message: response.error?.message || 'WS resume failed',
      code: response.error?.code,
      details: response.error?.details,
    }
    if (error.code === 'WS_1014_REPLAY_GAP') {
      this.abandonGlobalResumeForReplayGap(error)
      return
    }
    this.handleError(error)
  }

  private abandonGlobalResumeForReplayGap(error: GatewayClientError): void {
    this.lastEventId = undefined
    this.lastEventIdPerTopic.clear()
    this.subscriptionCatchupCursors.clear()
    this.subscriptionRecoveryStates.clear()
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'resume_replay_gap',
      system: 'gateway',
    }))
    this.handleError(error)
    this.onReplayGap?.(error)
  }

  private dispatchResumeEnvelope(lastEventId: string): Promise<GatewayResponse> {
    const requestId = this.newRequestId()
    const envelope = this.buildEnvelope('resume', requestId, { last_event_id: lastEventId })
    return this.sendEnvelope(envelope)
  }

  private clearResumePaginationTimer(): void {
    if (this.resumePaginationTimer == null) return
    clearTimeout(this.resumePaginationTimer)
    this.resumePaginationTimer = undefined
  }

  /**
   * resume.ok：累加重放条数；若有 next_cursor 则延迟后续页（与 iOS/Android 一致）。
   * 遥测仅在整段 resume 完成（无更多分页或达到轮次上限）时打一条。
   */
  private finalizeResumeOkTelemetry(envelope: GatewayEnvelope): void {
    const payload = envelope.payload ?? {}
    // 新逐 topic barrier 自己负责完整分页与遥测，不能让旧的后台分页器并发抢 owner。
    if ('next_cursors' in payload || 'has_more' in payload) return
    const raw = payload.replayed ?? payload.events_count
    const replayed =
      typeof raw === 'number' && Number.isFinite(raw) ? raw : (Number(raw) || 0)
    this.resumeReplayedTotal += replayed

    const nc = payload.next_cursor
    const nextCursor = typeof nc === 'string' && nc.length > 0 ? nc : undefined

    if (nextCursor && this.resumePageCount < MAX_RESUME_PAGINATION_ROUNDS) {
      this.resumePageCount += 1
      const epoch = this.connectionEpoch
      this.clearResumePaginationTimer()
      this.resumePaginationTimer = setTimeout(() => {
        this.resumePaginationTimer = undefined
        if (this.connectionEpoch !== epoch) return
        if (this.closing) return
        if (this.status !== 'ready') return
        if (!this.socket || this.socket.readyState !== WS_OPEN) return
        void this.dispatchResumeEnvelope(nextCursor).then((response) => {
          this.reportResumeFailure(response)
        })
      }, RESUME_PAGE_DELAY_MS)
      return
    }

    if (nextCursor && this.resumePageCount >= MAX_RESUME_PAGINATION_ROUNDS) {
      console.warn(
        `[WsGatewayClient] Resume pagination limit reached (${MAX_RESUME_PAGINATION_ROUNDS} rounds); remaining events may be omitted`
      )
      this.handleError({
        message: `Resume pagination overflow: reached ${MAX_RESUME_PAGINATION_ROUNDS} rounds, some offline events may have been lost. Consider a full state sync.`,
        code: 'WS_RESUME_OVERFLOW',
      })
    }

    console.log('[WS Telemetry]', JSON.stringify({
      event: 'resume',
      system: 'gateway',
      eventsReplayed: this.resumeReplayedTotal,
      latencyMs: this.resumeStartedAt > 0 ? Date.now() - this.resumeStartedAt : 0,
    }))
    this.resumeStartedAt = 0
    this.resumePageCount = 0
    this.resumeReplayedTotal = 0
  }

  private sendEnvelope(envelope: GatewayEnvelope): Promise<GatewayResponse> {
    return new Promise((resolve) => {
      const requestId = envelope.request_id

      if (!this.socket || this.socket.readyState !== WS_OPEN) {
        resolve({
          ok: false,
          type: 'error',
          requestId,
          error: {
            code: 'WS_NOT_CONNECTED',
            message: 'socket is not open',
          },
        })
        return
      }

      let serialized: string
      try {
        serialized = JSON.stringify(envelope)
      } catch (error) {
        resolve({
          ok: false,
          type: 'error',
          requestId,
          error: {
            code: 'WS_SERIALIZE_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        })
        return
      }

      let outboundFrames: EncodedOutboundFrames
      try {
        outboundFrames = this.encodeOutboundFrames(envelope, serialized)
      } catch (error) {
        const frameError = error instanceof OutboundFrameError ? error : undefined
        resolve({
          ok: false,
          type: 'error',
          requestId,
          error: {
            code: frameError?.code ?? 'WS_FRAME_FRAGMENT_FAILED',
            message: error instanceof Error ? error.message : 'outbound frame fragmentation failed',
          }
        })
        return
      }

      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId)
        this.clearFragmentRequestMappings(requestId)
        resolve({
          ok: false,
          type: 'error',
          requestId,
          error: {
            code: 'WS_REQUEST_TIMEOUT',
            message: 'request timeout'
          }
        })
      }, this.requestTimeoutMs)

      this.pending.set(requestId, {
        resolve,
        timeoutId
      })
      for (const physicalRequestId of outboundFrames.physicalRequestIds) {
        this.fragmentRequestToOriginal.set(physicalRequestId, requestId)
      }

      try {
        for (const frame of outboundFrames.wires) {
          this.socket.send(frame)
        }
        this.markOutbound()
      } catch (error) {
        clearTimeout(timeoutId)
        this.pending.delete(requestId)
        this.clearFragmentRequestMappings(requestId)
        resolve({
          ok: false,
          type: 'error',
          requestId,
          error: {
            code: 'WS_SEND_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        })
      }
    })
  }

  /**
   * 保持小帧 wire 完全不变；大帧则把原 envelope 的 UTF-8 bytes 装入通用物理分片。
   * 分片尺寸以最终 JSON wire 实测，避免 base64、字段名或多字节字符造成估算偏差。
   */
  private encodeOutboundFrames(envelope: GatewayEnvelope, serialized: string): EncodedOutboundFrames {
    if (this.maxOutboundMessageBytes <= 0) return { wires: [serialized], physicalRequestIds: [] }
    const bytes = this.textEncoder.encode(serialized)
    if (bytes.byteLength <= this.maxOutboundMessageBytes) {
      return { wires: [serialized], physicalRequestIds: [] }
    }
    if (!this.transportCapabilities.has(FRAME_FRAGMENT_C2S_CAPABILITY)) {
      throw new OutboundFrameError(
        'WS_MESSAGE_TOO_LARGE',
        `outbound message exceeds limit ${this.maxOutboundMessageBytes}; server does not support ${FRAME_FRAGMENT_C2S_CAPABILITY}`,
      )
    }
    if (envelope.type === FRAME_FRAGMENT_TYPE) {
      throw new OutboundFrameError('WS_FRAME_FRAGMENT_FAILED', 'nested frame_fragment is not supported')
    }
    if (bytes.byteLength > MAX_LOGICAL_FRAME_BYTES) {
      throw new OutboundFrameError(
        'WS_MESSAGE_TOO_LARGE',
        `outbound logical frame exceeds ${MAX_LOGICAL_FRAME_BYTES} bytes`,
      )
    }

    const frameId = generateId('frame')
    // 用最大合法 index/count 构造固定开销模板。data 是纯 ASCII base64，模板
    // 之外的可用 UTF-8 字节即可直接换算为安全的原始 chunk 容量。
    const sizingEnvelope: GatewayEnvelope = {
      ...envelope,
      type: FRAME_FRAGMENT_TYPE,
      request_id: `${frameId}_${MAX_FRAME_FRAGMENT_COUNT - 1}`,
      event_id: undefined,
      payload: {
        frame_id: frameId,
        original_request_id: envelope.request_id,
        original_type: envelope.type,
        index: MAX_FRAME_FRAGMENT_COUNT - 1,
        count: MAX_FRAME_FRAGMENT_COUNT,
        total_bytes: bytes.byteLength,
        sha256: '0'.repeat(64),
        encoding: FRAME_FRAGMENT_ENCODING,
        data: '',
      },
    }
    const metadataBytes = this.textEncoder.encode(JSON.stringify(sizingEnvelope)).byteLength
    const availableBase64Bytes = this.maxOutboundMessageBytes - metadataBytes - 1
    const rawChunkBytes = Math.floor(availableBase64Bytes / 4) * 3
    if (rawChunkBytes <= 0) {
      throw new OutboundFrameError(
        'WS_FRAME_FRAGMENT_FAILED',
        `maxOutboundMessageBytes=${this.maxOutboundMessageBytes} cannot fit frame_fragment metadata`,
      )
    }
    const count = Math.ceil(bytes.byteLength / rawChunkBytes)
    if (count > MAX_FRAME_FRAGMENT_COUNT) {
      throw new OutboundFrameError(
        'WS_MESSAGE_TOO_LARGE',
        `outbound logical frame requires ${count} fragments; limit is ${MAX_FRAME_FRAGMENT_COUNT}`,
      )
    }

    const digest = sha256Hex(bytes)
    const frames: string[] = []
    const physicalRequestIds: string[] = []
    for (let index = 0; index < count; index += 1) {
      const chunk = bytes.subarray(index * rawChunkBytes, (index + 1) * rawChunkBytes)
      const fragmentEnvelope: GatewayEnvelope = {
        ...envelope,
        type: FRAME_FRAGMENT_TYPE,
        request_id: `${frameId}_${index}`,
        event_id: undefined,
        payload: {
          frame_id: frameId,
          original_request_id: envelope.request_id,
          original_type: envelope.type,
          index,
          count,
          total_bytes: bytes.byteLength,
          sha256: digest,
          encoding: FRAME_FRAGMENT_ENCODING,
          data: bytesToBase64(chunk),
        },
      }
      const wire = JSON.stringify(fragmentEnvelope)
      if (this.textEncoder.encode(wire).byteLength >= this.maxOutboundMessageBytes) {
        throw new OutboundFrameError('WS_FRAME_FRAGMENT_FAILED', 'fragment wire size calculation mismatch')
      }
      frames.push(wire)
      physicalRequestIds.push(fragmentEnvelope.request_id)
    }
    return { wires: frames, physicalRequestIds }
  }

  private handleMessage(raw: any): void {
    const payload = toTextPayload(raw)
    if (!payload) return

    let envelope: GatewayEnvelope
    try {
      envelope = JSON.parse(payload)
    } catch (error) {
      this.handleError({ message: 'WS message parse failed' })
      return
    }

    this.markInbound()
    if (envelope.type === 'pong' && envelope.request_id === this.pendingPingRequestId) {
      this.clearPendingProbe()
      this.connectionHadHealthyHeartbeat = true
      this.maybeResetReconnectBackoff()
      return
    }
    if (this.routeSubscriptionRecoveryEvent(envelope)) return
    const effectiveEventId = this.getEffectiveEventId(envelope)
    if (effectiveEventId) {
      if (requiresApplicationAck(envelope)) {
        if (envelope._topic) {
          const pending = this.pendingApplicationAcksByTopic.get(envelope._topic)
            ?? new Set<string>()
          pending.add(effectiveEventId)
          this.pendingApplicationAcksByTopic.set(envelope._topic, pending)
        }
        this.lastEventId = '0-0'
      } else {
        if (this.trackRecentEventId(effectiveEventId)) {
          return
        }
        if (envelope._topic) {
          this.lastEventIdPerTopic.set(envelope._topic, effectiveEventId)
        }
        this.lastEventId = this.computeResumeEventId() ?? effectiveEventId
      }
    }

    if (!this.emitTicks && envelope.type === 'tick') {
      return
    }

    const requestId = envelope.request_id
    const originalRequestId = requestId
      ? this.fragmentRequestToOriginal.get(requestId)
      : undefined
    if (originalRequestId && envelope.type === 'error') {
      const pending = this.pending.get(originalRequestId)
      this.clearFragmentRequestMappings(originalRequestId)
      if (pending) {
        clearTimeout(pending.timeoutId)
        this.pending.delete(originalRequestId)
        pending.resolve({
          ok: false,
          type: envelope.type,
          requestId: originalRequestId,
          error: envelope.payload as GatewayErrorPayload,
        })
      }
      return
    }
    if (requestId && this.pending.has(requestId)) {
      const pending = this.pending.get(requestId)
      if (pending) {
        clearTimeout(pending.timeoutId)
        this.pending.delete(requestId)
        this.clearFragmentRequestMappings(requestId)
        if (envelope.type === 'resume.ok') {
          this.finalizeResumeOkTelemetry(envelope)
        }
        if (envelope.type === 'error') {
          pending.resolve({
            ok: false,
            type: envelope.type,
            requestId,
            error: envelope.payload as GatewayErrorPayload
          })
          return
        }
        // 终端假运行根治 v3 P1-1（治 F3/F16）：`*.nak` 是协议级"否定确认"
        // （negative ack），统一映射成 `ok:false`——让所有调用方的 `!ok` /
        // `ok===false` 判定自然生效（典型：Django relay_handler 在终态 merge+stash
        // 双失败时回 `relay_events.nak{retryable:true}`，过去被这里当成 ok:true 静默
        // 吞掉 → host 不落盘 → 假运行复发）。映射时**两头都填**：保留原始 `payload`
        // 供读 `error_code` / `retryable` 的调用方（assertRelayAck、ElectronAgentHost
        // 的 M2.5 NAK 告警），同时填充 `error` 供读 `error.message` 的调用方（daemon
        // `relayEvents` / `sendAgentEvent` / `ElectronAgentService`）。
        if (typeof envelope.type === 'string' && envelope.type.endsWith('.nak')) {
          const nak = (envelope.payload ?? {}) as {
            error_code?: string
            error_message?: string
            message?: string
            retryable?: boolean
          }
          // fallback message **折入 error_code + retryable**：很多 nak（如 Django
          // `relay_events.nak` 只带 `{error_code, retryable}`、无 error_message）下，
          // 只读 `error.message` 的调用方（daemon `gateway-client.relayEvents` 把
          // `error.message` 写进 warn 日志）否则会丢掉真实失败码（三视角 review P3：
          // 两端日志可观测性对齐）。读 `payload.error_code/retryable` 的调用方
          // （assertRelayAck / M2.5 告警）不受影响——payload 始终原样保留。
          const fallbackMessage =
            `request rejected: ${envelope.type}` +
            (nak.error_code
              ? ` (error_code=${nak.error_code}${nak.retryable != null ? `, retryable=${nak.retryable}` : ''})`
              : '')
          pending.resolve({
            ok: false,
            type: envelope.type,
            requestId,
            payload: envelope.payload,
            error: {
              code: nak.error_code ?? 'NAK',
              message: nak.error_message ?? nak.message ?? fallbackMessage,
              details: envelope.payload,
            },
          })
          return
        }
        pending.resolve({
          ok: true,
          type: envelope.type,
          requestId,
          payload: envelope.payload
        })
      }
      return
    }

    if (envelope.type === 'auth.revoke') {
      const revokeError: GatewayClientError = {
        message: envelope.payload?.message || 'Authentication revoked by server',
        code: envelope.payload?.code || 'WS_AUTH_REVOKED',
        details: envelope.payload?.details,
      }
      this.authFailed = true
      console.log('[WS Telemetry]', JSON.stringify({
        event: 'auth_failure',
        system: 'gateway',
        code: revokeError.code,
      }))
      this.onAuthFailed?.(revokeError)
      this.onEvent?.(envelope)
      this.stopTokenRevalidation()
      if (this.socket && this.socket.readyState < 2) {
        this.socket.close()
      }
      return
    }

    if (envelope.type === 'connection.resume_hint') {
      if (this.lastEventId) {
        const jitter = Math.random() * 2000
        setTimeout(() => {
          if (this.status === 'ready' && this.lastEventId) {
            void this.sendResume(this.lastEventId)
          }
        }, jitter)
      }
      return
    }

    if (envelope.type === 'organization.membership_changed') {
      this.applyMembershipChange(envelope.payload)
    }

    if (envelope.type === 'error') {
      this.handleError({
        message: envelope.payload?.message || 'WS error',
        code: envelope.payload?.code,
        details: envelope.payload?.details
      })
    }

    this.onEvent?.(envelope)
  }

  private getEffectiveEventId(envelope: GatewayEnvelope): string | undefined {
    return envelope.event_id
      || (envelope.request_id?.startsWith('evt_') ? envelope.request_id : undefined)
  }

  /**
   * Catch-up barrier only intercepts the affected topic. Replay is applied in stream
   * order; realtime waits until the final page, and overlap is removed by the
   * recovery-scoped set rather than the normal 2k observability ring.
   */
  private routeSubscriptionRecoveryEvent(envelope: GatewayEnvelope): boolean {
    const topic = envelope._topic
    if (!topic) return false
    const state = this.subscriptionRecoveryStates.get(topic)
    if (!state || state.phase === 'flushing') return false
    if (state.generation !== this.connectionEpoch || state.phase === 'failed') return true

    const eventId = this.getEffectiveEventId(envelope)
    if (envelope._delivery === 'replay') {
      if (eventId && state.seenDuringCatchup.has(eventId)) return true
      if (eventId) {
        if (state.seenDuringCatchup.size >= MAX_CATCHUP_SEEN_EVENTS_PER_TOPIC) {
          this.failSubscriptionCatchup(
            [topic],
            'WS_CATCHUP_DEDUP_OVERFLOW',
            `catch-up overlap window exceeded ${MAX_CATCHUP_SEEN_EVENTS_PER_TOPIC} events for ${topic}`,
          )
          return true
        }
        state.seenDuringCatchup.add(eventId)
      }
      return false
    }

    if (state.bufferedRealtime.length >= this.catchupBufferLimitPerTopic) {
      this.failSubscriptionCatchup(
        [topic],
        'WS_CATCHUP_BUFFER_OVERFLOW',
        `realtime catch-up buffer exceeded ${this.catchupBufferLimitPerTopic} events for ${topic}`,
      )
      return true
    }
    state.bufferedRealtime.push(envelope)
    return true
  }

  private applyAuthOkPayload(payload: unknown): void {
    if (!this.authContext) return
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    if (Array.isArray(p.organization_ids)) {
      this.authContext.organizationIds = sanitizeStringArray(p.organization_ids)
    }
    this.transportCapabilities.clear()
    for (const capability of sanitizeStringArray(p.transport_capabilities)) {
      this.transportCapabilities.add(capability)
    }
    const rawPrimary = p.organization_id
    if (typeof rawPrimary === 'string' && rawPrimary.length > 0) {
      this.authContext.organizationId = rawPrimary
    }
  }

  private applyMembershipChange(payload: unknown): void {
    if (!this.authContext) return
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    if (Array.isArray(p.all_ids)) {
      this.authContext.organizationIds = sanitizeStringArray(p.all_ids)
    }
    const rawPrimary = p.primary_id
    if (typeof rawPrimary === 'string' && rawPrimary.length > 0) {
      this.authContext.organizationId = rawPrimary
    } else if (rawPrimary === null) {
      this.authContext.organizationId = undefined
    }
    const logBody: Record<string, unknown> = {
      added: sanitizeStringArray(p.added),
      removed: sanitizeStringArray(p.removed),
      all_ids: this.authContext.organizationIds ?? [],
      primary_id: this.authContext.organizationId ?? null,
      pruned_topics_count: Array.isArray(p.pruned_topics)
        ? (p.pruned_topics as unknown[]).length
        : 0,
    }
    if (typeof p.reason === 'string' && p.reason.length > 0) {
      logBody.reason = p.reason
    }
    console.log('[WsGatewayClient] organization membership changed', logBody)
  }

  private handleSocketError(error: any): void {
    const message = error instanceof Error ? error.message : 'WS connection error'
    this.handleError({ message })
  }

  private handleClose(closeCode?: number, closeReason?: string): void {
    this.clearResumePaginationTimer()
    this.stopHealthMonitor()
    this.stopTokenRevalidation()
    this.clearSubscriptionReconciliation(false)
    this.discardSubscriptionRecoveryGeneration()
    this.confirmedTopics.clear()
    this.disconnectedAt = Date.now()
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'disconnect',
      system: 'gateway',
      reasonKind: 'transport_disconnect',
      code: closeCode,
      reason: closeReason,
      connectedDuration: this.lastConnectedAt > 0 ? Date.now() - this.lastConnectedAt : 0,
      status: this.status,
      desiredTopics: this.desiredTopics.size,
      confirmedTopics: this.confirmedTopics.size,
      pendingRequests: this.pending.size,
    }))
    this.socket = undefined
    this.clearAllPending('WS_DISCONNECTED', 'connection closed unexpectedly')
    this.setStatus('idle')
    this.onDisconnect?.()
    if (this.closing || this.authFailed) return
    this.scheduleReconnect()
  }

  private discardSubscriptionRecoveryGeneration(): void {
    for (const [topic, state] of this.subscriptionRecoveryStates) {
      if (state.cursor) this.subscriptionCatchupCursors.set(topic, state.cursor)
      if (state.bufferedRealtime.length > 0) {
        console.log('[WS Telemetry]', JSON.stringify({
          event: 'subscription_catchup_transport_reset',
          system: 'gateway',
          topic,
          discardedBufferedRealtime: state.bufferedRealtime.length,
        }))
      }
      // 旧 transport 的 realtime 不能跨 generation 释放；已 apply 的 replay IDs
      // 继续保留在本次 catch-up 生命周期内，避免从 pinned cursor 重放时重复 apply。
      state.bufferedRealtime = []
      if (state.phase !== 'failed') state.phase = 'subscribing'
    }
  }

  private scheduleReconnect(): void {
    if (!this.authContext) return
    if (this.reconnectTimer) return
    const baseDelay = Math.min(
      this.reconnectMaxDelayMs,
      Math.round(this.reconnectMinDelayMs * Math.pow(this.reconnectFactor, this.reconnectAttempts))
    )
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      Math.round(baseDelay * (0.5 + Math.random()))
    )
    this.currentReconnectDelayMs = delay
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.ensureReady()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private startHealthMonitor(): void {
    if (this.healthTimer) return
    const now = Date.now()
    this.lastInboundAt = now
    this.lastOutboundAt = now
    this.clearPendingProbe()
    this.healthTimer = setInterval(() => {
      if (this.status !== 'ready') return
      const now = Date.now()
      if (this.pendingPingRequestId) {
        if (now - this.pendingPingSentAt > this.idleTimeoutMs) {
          this.failHealthProbe('WS pong timeout, reconnecting')
        }
        return
      }
      const inboundIdleMs = now - this.lastInboundAt
      const outboundIdleMs = now - this.lastOutboundAt
      if (outboundIdleMs >= this.outboundPingIntervalMs || inboundIdleMs > this.idleTimeoutMs / 2) {
        this.sendPing(now)
      }
    }, this.healthCheckIntervalMs)
  }

  private sendPing(now = Date.now()): void {
    if (
      this.pendingPingRequestId
      || this.status !== 'ready'
      || !this.socket
      || this.socket.readyState !== WS_OPEN
    ) return
    const requestId = generateId('ping')
    try {
      const envelope: GatewayEnvelope = {
        v: 1,
        type: 'ping',
        request_id: requestId,
        ts: Math.floor(now / 1000),
        device_id: this.deviceId,
        role: this.role,
        payload: {},
      }
      const serialized = JSON.stringify(envelope)
      const frames = this.encodeOutboundFrames(envelope, serialized).wires
      this.pendingPingRequestId = requestId
      this.pendingPingSentAt = now
      for (const frame of frames) {
        this.socket.send(frame)
      }
      this.markOutbound()
    } catch {
      this.failHealthProbe('WS ping send failed, reconnecting')
    }
  }

  private failHealthProbe(message: string): void {
    this.stopHealthMonitor()
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'heartbeat_timeout',
      system: 'gateway',
      reconnectAttempt: this.reconnectAttempts + 1,
      desiredSubscriptions: this.desiredTopics.size,
      confirmedSubscriptions: this.confirmedTopics.size,
    }))
    this.handleError({ message })
    this.socket?.close()
  }

  private clearPendingProbe(): void {
    this.pendingPingRequestId = undefined
    this.pendingPingSentAt = 0
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
    this.clearPendingProbe()
  }

  private maybeResetReconnectBackoff(): void {
    if (!this.connectionHadHealthyHeartbeat) return
    if (this.getMissingSubscriptionTopics().length > 0) return
    if (this.reconnectAttempts === 0) return
    console.log('[WS Telemetry]', JSON.stringify({
      event: 'reconnect_stable',
      system: 'gateway',
      previousAttempts: this.reconnectAttempts,
      connectedDuration: this.lastConnectedAt > 0 ? Date.now() - this.lastConnectedAt : 0,
      desiredSubscriptions: this.desiredTopics.size,
      confirmedSubscriptions: this.confirmedTopics.size,
    }))
    this.reconnectAttempts = 0
    this.currentReconnectDelayMs = 0
  }

  private startTokenRevalidation(): void {
    if (this.tokenRevalidateIntervalMs <= 0 || !this.refreshAuth) return
    if (this.tokenRevalidateTimer) return
    this.tokenRevalidateTimer = setInterval(() => {
      void this.revalidateToken()
    }, this.tokenRevalidateIntervalMs)
  }

  private stopTokenRevalidation(): void {
    if (!this.tokenRevalidateTimer) return
    clearInterval(this.tokenRevalidateTimer)
    this.tokenRevalidateTimer = undefined
  }

  private async revalidateToken(): Promise<void> {
    if (this.status !== 'ready' || !this.refreshAuth) return
    try {
      const freshAuth = await this.refreshAuth()
      if (!freshAuth) {
        const revokeError: GatewayClientError = {
          message: 'Token revalidation failed: refreshAuth returned null',
          code: 'WS_TOKEN_REVALIDATION_FAILED',
        }
        this.authFailed = true
        console.log('[WS Telemetry]', JSON.stringify({
          event: 'auth_failure',
          system: 'gateway',
          code: revokeError.code,
        }))
        this.onAuthFailed?.(revokeError)
        this.stopTokenRevalidation()
        if (this.socket && this.socket.readyState < 2) {
          this.socket.close()
        }
        return
      }
      // 合并而非替换：保留服务端回填的 organizationIds / primary。
      // 注意：如果 token 变化 updateAuthContext 会整体替换，此时 envelope
      // 下次 `auth` 消息走到新 token，`auth.ok` 会回填最新 organizationIds。
      this.updateAuthContext(freshAuth)
    } catch {
      // transient failure — will retry on next interval
    }
  }

  private markInbound(): void {
    this.lastInboundAt = Date.now()
  }

  private markOutbound(): void {
    this.lastOutboundAt = Date.now()
  }

  private compareStreamIds(a: string, b: string): number {
    const [aTs, aSeq] = a.split('-').map(Number)
    const [bTs, bSeq] = b.split('-').map(Number)
    if (!Number.isFinite(aTs) || !Number.isFinite(bTs)) {
      return a < b ? -1 : a > b ? 1 : 0
    }
    if (!Number.isFinite(aSeq) || !Number.isFinite(bSeq)) {
      return a < b ? -1 : a > b ? 1 : 0
    }
    return aTs !== bTs ? aTs - bTs : aSeq - bSeq
  }

  private computeMinEventId(): string | undefined {
    if (this.lastEventIdPerTopic.size === 0) return undefined
    let min: string | undefined
    for (const id of this.lastEventIdPerTopic.values()) {
      if (min === undefined || this.compareStreamIds(id, min) < 0) {
        min = id
      }
    }
    return min
  }

  private computeResumeEventId(): string | undefined {
    if (this.pendingApplicationAcksByTopic.size > 0) return '0-0'
    return this.computeMinEventId()
  }

  /**
   * 环形缓冲区去重：O(1) 插入和查重。
   * @returns true 表示该 eventId 是重复的（已存在于窗口中）
   */
  private trackRecentEventId(eventId: string): boolean {
    if (this.recentEventIdSet.has(eventId)) return true

    // 初始化环形数组（惰性分配）
    if (this.recentEventIdRing.length === 0) {
      this.recentEventIdRing.length = this.recentEventIdLimit
    }

    // 容量满时淘汰最老的条目
    if (this.recentEventIdCount >= this.recentEventIdLimit) {
      const evicted = this.recentEventIdRing[this.recentEventIdHead]
      if (evicted !== undefined) {
        this.recentEventIdSet.delete(evicted)
      }
      this.recentEventIdRing[this.recentEventIdHead] = eventId
      this.recentEventIdHead = (this.recentEventIdHead + 1) % this.recentEventIdLimit
    } else {
      const tail = (this.recentEventIdHead + this.recentEventIdCount) % this.recentEventIdLimit
      this.recentEventIdRing[tail] = eventId
      this.recentEventIdCount++
    }

    this.recentEventIdSet.add(eventId)
    return false
  }

  private handleError(error: GatewayClientError): void {
    this.onError?.(error)
  }

  private maybeResetForAuthChange(auth: GatewayAuthContext): void {
    // 连接绑定用户而不绑定 organization —— authKey 只用 token，
    // 这样用户在多个 organization 之间切换时 token 不变 ⇒ 不会触发断连重置。
    // 真正需要重建连接的是 token 变化（登出/重登/token 刷新为不同的 token）。
    const nextKey = auth.token
    if (this.authKey && this.authKey !== nextKey && this.status !== 'idle') {
      this.connectionEpoch += 1
      this.closing = true
      this.clearResumePaginationTimer()
      this.stopHealthMonitor()
      this.stopTokenRevalidation()
      this.clearReconnectTimer()
      if (this.socket && this.socket.readyState < 2) {
        this.socket.close()
      }
      this.socket = undefined
      this.connectPromise = undefined
      this.clearAllPending('WS_AUTH_CHANGED', 'auth context changed, connection reset')
      this.clearPendingSubscribeBatch('WS_AUTH_CHANGED', 'auth context changed, connection reset')
      this.setStatus('idle')
    }
    this.authKey = nextKey
  }

  private setStatus(status: GatewayStatus): void {
    if (this.status === status) return
    this.status = status
    this.onStatusChange?.(status)
  }

  private buildEnvelope(
    messageType: string,
    requestId: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): GatewayEnvelope {
    const envelope: GatewayEnvelope = {
      v: 1,
      type: messageType,
      request_id: requestId,
      ts: Math.floor(Date.now() / 1000),
      device_id: this.deviceId,
      role: this.role,
      payload
    }

    if (options?.threadId) envelope.thread_id = options.threadId
    if (options?.traceId) envelope.trace_id = options.traceId
    const effectiveOrganizationId = options?.organizationId ?? this.authContext?.organizationId
    if (effectiveOrganizationId) envelope.organization_id = effectiveOrganizationId
    if (options?.sessionId) envelope.session_id = options.sessionId
    if (options?.tableId) envelope.table_id = options.tableId
    if (options?.instanceId) envelope.instance_id = options.instanceId

    return envelope
  }

  private newRequestId(): string {
    return generateId('req')
  }
}

export type { GatewayClientOptions, GatewayClientError, WebSocketConstructor }

// ── Permission types re-exported from @tabtin/contracts/agent ──
export type { PermissionMode } from '@tabtin/contracts/agent'
export { PERMISSION_TIMEOUTS } from '@tabtin/contracts/agent'
