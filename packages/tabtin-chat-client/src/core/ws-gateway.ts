import { ChatClientOptions } from '../types'
import { t } from '../i18n'
import {
  ACTION_CAPABILITY,
  STREAM_CAPABILITY,
} from './namespace'
import {
  WsGatewayClient,
  type GatewayEnvelope,
  type GatewayClientOptions,
  type GatewayClientError,
  type GatewayAuthContext,
  type GatewayResponse as CoreGatewayResponse,
} from '@tabtin/ws-gateway-client'

/**
 * 角色定义 — 与后端 protocol.py 的 ALLOWED_ROLES 保持一致。
 * 注意: 'backend' 和 'channel' 仅限服务端内部使用，前端不应使用。
 */
export type GatewayRole = 'electron' | 'web' | 'mobile' | 'admin'

const DEFAULT_ROLE_CAPABILITIES: Record<GatewayRole, string[]> = {
  electron: [STREAM_CAPABILITY, ACTION_CAPABILITY],
  web: [STREAM_CAPABILITY, ACTION_CAPABILITY],
  mobile: [STREAM_CAPABILITY],
  admin: [STREAM_CAPABILITY, ACTION_CAPABILITY],
}

const normalizeCapabilities = (capabilities: string[]): string[] => {
  const result = new Set<string>()
  for (const capability of capabilities) {
    const normalized = capability.trim()
    if (!normalized) continue
    result.add(normalized)
  }
  return Array.from(result)
}

export const resolveGatewayCapabilities = (
  role: GatewayRole,
  capabilities?: string[]
): string[] => {
  const base = capabilities !== undefined ? capabilities : (DEFAULT_ROLE_CAPABILITIES[role] ?? [])
  return normalizeCapabilities(base)
}

type GatewayRequestOptions = {
  threadId?: string
  traceId?: string
  organizationId?: string
  sessionId?: string
  tableId?: string
  instanceId?: string
  /** Per-request timeout override (milliseconds). Falls back to global requestTimeoutMs. */
  timeoutMs?: number
}

type GatewayErrorPayload = {
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

// ---- 默认配置 (保持与原实现一致的默认值) ----
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15_000
const DEFAULT_RECONNECT_MIN_DELAY_MS = 1_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15_000
const DEFAULT_RECONNECT_FACTOR = 1.5
const DEFAULT_MAX_OUTBOUND_MESSAGE_BYTES = 900_000

type GatewayOptions = ChatClientOptions & {
  role?: GatewayRole
  capabilities: string[]
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  maxOutboundMessageBytes?: number
  idleTimeoutMs?: number
  healthCheckIntervalMs?: number
  reconnectMinDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectFactor?: number
  onDisconnect?: () => void
  onConnected?: () => void
  onReconnected?: () => void
  onReconnecting?: (attempt: number, delayMs: number) => void
  onError?: (error: Error) => void
  onAuthFailed?: (error: Error) => void
  onOrganizationAccessDenied?: (error: Error) => void
}

const NOT_READY_RESPONSE: GatewayResponse = {
  ok: false,
  type: 'error',
  requestId: 'req_unavailable',
  error: {
    code: 'WS_CLIENT_NOT_READY',
    message: 'ws connection not ready'
  }
}

/**
 * WsGateway — Thin adapter over @tabtin/ws-gateway-client.
 *
 * Preserves the original public API (addListener, onReconnectedEvent, no-arg
 * connect, etc.) while delegating all WebSocket protocol logic to the core
 * WsGatewayClient.
 */
export class WsGateway {
  private readonly getToken: ChatClientOptions['getToken']
  private readonly getOrganizationId?: ChatClientOptions['getOrganizationId']
  private readonly role: GatewayRole
  private readonly capabilities: string[]
  private readonly capabilitySet: Set<string>
  private readonly onDisconnectCb?: () => void
  private readonly onConnectedCb?: () => void
  private readonly onReconnectedCb?: () => void
  private readonly onReconnectingCb?: (attempt: number, delayMs: number) => void
  private readonly onErrorCb?: (error: Error) => void
  private readonly onAuthFailedCb?: (error: Error) => void
  private readonly onOrganizationAccessDeniedCb?: (error: Error) => void

  private readonly listeners = new Set<(envelope: any) => void>()
  private readonly reconnectedListeners = new Set<() => void>()

  private coreClient: WsGatewayClient
  private connectPromise: Promise<boolean> | null = null
  private closing = false
  private replayGapDuringConnect = false

  constructor(options: GatewayOptions) {
    this.getToken = options.getToken
    this.getOrganizationId = options.getOrganizationId
    this.role = options.role ?? 'electron'
    this.capabilities = normalizeCapabilities(options.capabilities)
    this.capabilitySet = new Set(this.capabilities)
    this.onDisconnectCb = options.onDisconnect
    this.onConnectedCb = options.onConnected
    this.onReconnectedCb = options.onReconnected
    this.onReconnectingCb = options.onReconnecting
    this.onErrorCb = options.onError
    this.onAuthFailedCb = options.onAuthFailed
    this.onOrganizationAccessDeniedCb = options.onOrganizationAccessDenied

    const wsBaseUrl = deriveWsBaseUrl(options.baseURL)

    this.coreClient = new WsGatewayClient({
      role: this.role,
      capabilities: this.capabilities,
      deviceId: options.deviceId,
      wsBaseUrl,
      connectTimeoutMs: options.connectTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      maxOutboundMessageBytes: options.maxOutboundMessageBytes ?? DEFAULT_MAX_OUTBOUND_MESSAGE_BYTES,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      reconnectMinDelayMs: options.reconnectMinDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      reconnectFactor: options.reconnectFactor ?? DEFAULT_RECONNECT_FACTOR,
      onEvent: (envelope: GatewayEnvelope) => {
        for (const listener of this.listeners) {
          try { listener(envelope) } catch (err) {
            console.error('[WsGateway] Listener error:', err)
          }
        }
      },
      onStatusChange: (status) => {
        if (status === 'connecting' && this.coreClient.getReconnectAttempts() > 0) {
          this.onReconnectingCb?.(
            this.coreClient.getReconnectAttempts(),
            this.coreClient.getReconnectDelayMs(),
          )
        }
      },
      onReady: (info) => {
        console.log(
          `[WsGateway] Ready (reconnected=${info.reconnected}, listeners=${this.reconnectedListeners.size})`,
        )
        this.onConnectedCb?.()
        const needsAuthoritativeReconcile = info.reconnected || this.replayGapDuringConnect
        this.replayGapDuringConnect = false
        if (needsAuthoritativeReconcile) {
          this.notifyReconnected()
        }
      },
      onReplayGap: () => {
        // connect() 尚未 ready 时等 onReady 合并触发，避免与普通
        // reconnect 回调重复对账。resume_hint 发生在 ready 态时则立即对账。
        if (this.coreClient.isConnected()) {
          this.notifyReconnected()
        } else {
          this.replayGapDuringConnect = true
        }
      },
      onError: (err: GatewayClientError) => {
        const error = new Error(err.message)
        if (err.code) {
          (error as any).code = err.code
        }
        this.onErrorCb?.(error)
      },
      onAuthFailed: (err: GatewayClientError) => {
        const error = new Error(err.message)
        ;(error as any).code = err.code || 'WS_AUTH_FAILED'
        this.onAuthFailedCb?.(error)
      },
      onOrganizationAccessDenied: (err: GatewayClientError) => {
        const error = new Error(err.message)
        ;(error as any).code = err.code || 'WS_ORGANIZATION_ACCESS_DENIED'
        this.onOrganizationAccessDeniedCb?.(error)
      },
      refreshAuth: async (): Promise<GatewayAuthContext | null> => {
        const auth = await this._resolveAuth()
        return auth
      },
      onDisconnect: () => {
        console.log('[WsGateway] Disconnected')
        this.onDisconnectCb?.()
      },
    })
  }

  private notifyReconnected(): void {
    this.onReconnectedCb?.()
    for (const cb of this.reconnectedListeners) {
      try { cb() } catch (err) {
        console.error('[WsGateway] Reconnected listener error:', err)
      }
    }
  }

  // ---- Public API (unchanged signatures) ----

  isConnected(): boolean {
    return this.coreClient.isConnected()
  }

  getConnectionStatus(): 'idle' | 'connecting' | 'ready' {
    return this.coreClient.getStatus()
  }

  getReconnectAttempts(): number {
    return this.coreClient.getReconnectAttempts()
  }

  /** 用户所属全部 organization 快照（auth.ok / organization.membership_changed 驱动）。 */
  getOrganizationIds(): string[] {
    return this.coreClient.getOrganizationIds()
  }

  /** 当前前台 organization（primary） —— envelope organization_id 默认值来源。 */
  getPrimaryOrganizationId(): string | undefined {
    return this.coreClient.getPrimaryOrganizationId()
  }

  addListener(listener: (envelope: any) => void): void {
    this.listeners.add(listener)
  }

  removeListener(listener: (envelope: any) => void): void {
    this.listeners.delete(listener)
  }

  onReconnectedEvent(listener: () => void): void {
    this.reconnectedListeners.add(listener)
  }

  offReconnectedEvent(listener: () => void): void {
    this.reconnectedListeners.delete(listener)
  }

  async sendResume(): Promise<void> {
    // Core client handles resume automatically during reconnect.
    // Keep as public API for backward compatibility.
  }

  hasCapability(capability: string): boolean {
    return this.capabilitySet.has(capability)
  }

  async connect(): Promise<boolean> {
    if (this.coreClient.isConnected()) return true
    if (this.connectPromise) return this.connectPromise

    this.closing = false
    this.connectPromise = this._doConnect()
    const ready = await this.connectPromise
    this.connectPromise = null
    return ready
  }

  close(): void {
    this.closing = true
    this.connectPromise = null
    this.coreClient.close()
  }

  async subscribe(
    topics: string[],
    options?: { topicContexts?: Record<string, Record<string, unknown>> },
  ): Promise<GatewayResponse> {
    const ready = await this.connect()
    if (!ready) {
      return NOT_READY_RESPONSE
    }
    const coreResponse = await this.coreClient.subscribe(topics, options)
    const response = toGatewayResponse(coreResponse)
    if (!response.ok || response.type !== 'subscribe.ok') {
      console.error('[WsGateway] subscribe failed', {
        ok: response.ok,
        type: response.type,
        errorCode: response.error?.code,
      })
    }
    return response
  }

  async unsubscribe(topics: string[]): Promise<GatewayResponse> {
    return toGatewayResponse(await this.coreClient.unsubscribe(topics))
  }

  async request(
    messageType: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): Promise<GatewayResponse> {
    const ready = await this.connect()
    if (!ready) {
      return NOT_READY_RESPONSE
    }

    const auth = await this._resolveAuth()
    if (!auth) return NOT_READY_RESPONSE

    const coreResponse = await this.coreClient.request(auth, messageType, payload, options)
    return toGatewayResponse(coreResponse)
  }

  /**
   * Fire-and-forget: send a message without waiting for a response.
   * Used for streaming protocols (ASR audio chunks, etc.).
   */
  send(
    messageType: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): boolean {
    return this.coreClient.send(messageType, payload, options)
  }

  // ---- Internal helpers ----

  private async _doConnect(): Promise<boolean> {
    const auth = await this._resolveAuth()
    if (!auth) {
      // token 尚未就绪属于启动时序的正常状态，静默返回 false 即可，
      // 不触发 onError 以免污染错误上报。organization 是否就绪不影响 auth。
      return false
    }
    return this.coreClient.connect(auth)
  }

  private async _resolveAuth(): Promise<GatewayAuthContext | null> {
    let token: string
    try {
      token = await this.getToken()
    } catch (e) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
        console.debug('[WsGateway] getToken not ready:', e)
      }
      return null
    }
    if (!token) return null

    let organizationId: string | undefined
    if (this.getOrganizationId) {
      try {
        const raw = await this.getOrganizationId()
        if (typeof raw === 'string' && raw.length > 0) {
          organizationId = raw
        }
      } catch (e) {
        // organization 未选只是"前台 hint 缺失"，连接本身不依赖它。
        // 仅在开发模式打印，便于排查非预期错误。
        if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
          console.debug('[WsGateway] getOrganizationId not ready, auth without hint:', e)
        }
      }
    }

    return {
      token,
      ...(organizationId ? { organizationId } : {}),
    }
  }
}

function toGatewayResponse(r: CoreGatewayResponse): GatewayResponse {
  return {
    ok: r.ok,
    type: r.type,
    requestId: r.requestId,
    payload: r.payload,
    error: r.error,
  }
}

function deriveWsBaseUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/$/, '')
  let root = trimmed
  if (root.endsWith('/api/chat')) {
    root = root.replace(/\/api\/chat$/, '')
  } else if (root.endsWith('/api')) {
    root = root.replace(/\/api$/, '')
  } else if (root.endsWith('/chat')) {
    root = root.replace(/\/chat$/, '')
  }
  if (root.startsWith('https://')) return root.replace(/^https:/, 'wss:')
  if (root.startsWith('http://')) return root.replace(/^http:/, 'ws:')
  return root
}
