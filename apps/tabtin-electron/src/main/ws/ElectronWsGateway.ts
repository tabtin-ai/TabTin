import WebSocketNode from 'ws'
import { type BrowserWindow } from 'electron'
import { requireSecureCredentialWsBaseUrl } from '@tabtin/config'

import {
  WsGatewayClient as CoreWsGatewayClient,
  type GatewayAuthContext,
  type GatewayResponse,
  type GatewayRequestOptions,
  type GatewayEnvelope,
  type GatewayClientStatus as CoreGatewayClientStatus
} from '@tabtin/ws-gateway-client'
import { configService } from '../services/ConfigService'
import { DAEMON_CONTROL_ENABLED, WS_BASE_URL } from '../config/api.js'
import { getOrCreateDeviceCredential } from '../device-credential.js'
import { getDeviceFingerprint } from '../utils/deviceFingerprint.js'
import { TokenManager } from '../auth.js'
import { createLogger } from '../logger'
import { DEFAULT_ELECTRON_WS_CAPABILITIES } from './electronWsCapabilities'
import { shouldForwardGatewayEnvelopeToRenderer } from './renderer-forward-filter'

const log = createLogger('ElectronWsGateway')

export type { GatewayAuthContext, GatewayResponse, GatewayRequestOptions }
export type GatewayClientStatus = CoreGatewayClientStatus | 'recovering'

export type EventHandler = (data: any, envelope?: GatewayEnvelope) => void

export const ELECTRON_WS_GATEWAY_EVENT_CHANNEL = 'ws:agent-gateway-event'
export const ELECTRON_WS_GATEWAY_RECONNECTED_CHANNEL = 'ws:agent-gateway-reconnected'

type ElectronWsGatewayOptions = {
  role?: 'electron'
  capabilities?: string[]
  deviceId?: string
  wsBaseUrl?: string
  initialTopics?: string[]
  subscribeTopics?: string[]
}

type UpdateProgressStatus =
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'failed'
  | 'skipped'

function getPersistedDeviceId(): string {
  const canonical = getDeviceFingerprint()
  const stored = configService.get('ws.gatewayId')
  if (stored !== canonical) {
    if (stored) {
      log.warn('ws.gatewayId 漂移，重新对齐', { stored, canonical })
    }
    configService.set('ws.gatewayId', canonical)
  }
  return canonical
}

export class ElectronWsGateway {
  private readonly client: CoreWsGatewayClient
  private readonly _deviceId: string
  private readonly wsBaseUrl: string
  private readonly eventHandlers = new Map<string, Set<EventHandler>>()
  /**
   * 原始 envelope 广播监听：不按 `envelope.type` 精确分发，收到任意
   * envelope 都回调。给 ConversationStreamAggregator 用——`agent.stream.*` 事件类型
   * 众多（content_block_delta / lifecycle / tool_use...），按 topic 过滤比逐类型
   * 注册 `on()` 更稳。
   */
  private readonly anyEventHandlers = new Set<(envelope: GatewayEnvelope) => void>()
  private readonly reconnectListeners: Array<() => void> = []
  private lastAuth?: GatewayAuthContext
  private daemonControlActive = false
  private _mainWindow: BrowserWindow | null = null
  private resumeRecovering = false
  private replayGapDuringConnect = false

  constructor(options?: ElectronWsGatewayOptions) {
    const preferredDeviceId = options?.deviceId?.trim()
    this._deviceId = preferredDeviceId && preferredDeviceId.length > 0
      ? preferredDeviceId
      : getPersistedDeviceId()
    const initialTopics = Array.from(
      new Set(options?.initialTopics ?? options?.subscribeTopics ?? [])
    )
    const capabilities =
      options?.capabilities && options.capabilities.length > 0
        ? options.capabilities
        : DEFAULT_ELECTRON_WS_CAPABILITIES
    this.wsBaseUrl = options?.wsBaseUrl ?? WS_BASE_URL

    this.client = new CoreWsGatewayClient({
      role: 'electron',
      capabilities,
      deviceId: this._deviceId,
      wsBaseUrl: this.wsBaseUrl,
      initialTopics,
      WebSocketImpl: WebSocketNode as any,
      // ：对齐 Django MAX_MESSAGE_BYTES=1_000_000，留 envelope 余量。
      // 未开启时超限帧会在服务端以 req_unknown 拒绝，客户端对不上 pending
      // 变成可重试的 WS_REQUEST_TIMEOUT，堵死串行 relay 补发队列。
      maxOutboundMessageBytes: 900_000,
      refreshAuth: async () => {
        try {
          const token = await TokenManager.getAccessToken()
          if (!token || !this.lastAuth) return null
          return { ...this.lastAuth, token }
        } catch (err) {
          // 取 token 失败等价于"当前无可用鉴权"，返回 null 让 client 走
          // 未鉴权分支；不打断流程，但记一条便于排查为何重连拿不到 token
          log.warn('refreshAuth 取 token 失败，返回无鉴权', err)
          return null
        }
      },
      tokenRevalidateIntervalMs: 300_000,
      reconnectMaxDelayMs: 30_000,
      onEvent: (envelope) => this.dispatchEvent(envelope),
      onError: (err) => log.warn('网关连接错误', {
        message: err.message,
        code: err.code || '',
        ...(err.details ? { details: err.details } : {}),
      }),
      onReplayGap: (err) => {
        log.warn('网关回放出现缺口，执行权威状态对账', {
          code: err.code || '',
          ...(err.details ? { details: err.details } : {}),
        })
        if (this.client.isConnected()) {
          this.notifyReconnectListeners()
        } else {
          this.replayGapDuringConnect = true
        }
      },
      onAuthFailed: (err) => log.error('网关鉴权失败', {
        message: err.message,
        code: err.code || '',
        ...(err.details ? { details: err.details } : {}),
      }),
      onStatusChange: (status) => {
        log.info('连接状态迁移', { status })
        if (!this.resumeRecovering || status === 'ready') {
          this.resumeRecovering = false
          this.broadcastStatus(status)
        }
      },
      onReady: (info) => {
        log.info('网关就绪', { reconnected: info.reconnected })
        const needsAuthoritativeReconcile = info.reconnected || this.replayGapDuringConnect
        this.replayGapDuringConnect = false
        if (needsAuthoritativeReconcile) {
          this.notifyReconnectListeners()
        }
      }
    })

  }

  private notifyReconnectListeners(): void {
    for (const cb of this.reconnectListeners) {
      try { cb() } catch { /* ignore */ }
    }
    this.broadcastReconnected()
  }

  setDaemonControlActive(active: boolean): void {
    if (active) requireSecureCredentialWsBaseUrl(this.wsBaseUrl)
    this.daemonControlActive = DAEMON_CONTROL_ENABLED && active
  }

  async connect(auth: GatewayAuthContext): Promise<boolean> {
    const deviceCredential = this.daemonControlActive
      ? await getOrCreateDeviceCredential(this._deviceId)
      : null
    const resolvedAuth = deviceCredential ? { ...auth, deviceCredential } : auth
    this.lastAuth = resolvedAuth
    return this.client.connect(resolvedAuth)
  }

  async connectWithAuth(auth: GatewayAuthContext): Promise<boolean> {
    return this.connect(auth)
  }

  async request(
    auth: GatewayAuthContext,
    messageType: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): Promise<GatewayResponse> {
    const deviceCredential = this.daemonControlActive
      ? await getOrCreateDeviceCredential(this._deviceId)
      : null
    const resolvedAuth = deviceCredential ? { ...auth, deviceCredential } : auth
    this.lastAuth = resolvedAuth
    return this.client.request(resolvedAuth, messageType, payload, options)
  }

  async requestWithLastAuth(
    messageType: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): Promise<GatewayResponse> {
    if (!this.lastAuth) {
      return {
        ok: false,
        type: 'error',
        requestId: '',
        error: {
          code: 'WS_NOT_AUTHENTICATED',
          message: 'no cached gateway auth context',
        },
      }
    }
    return this.client.request(this.lastAuth, messageType, payload, options)
  }

  send(
    messageType: string,
    payload: Record<string, any>,
    options?: GatewayRequestOptions
  ): boolean {
    return this.client.send(messageType, payload, options)
  }

  async subscribe(
    topics: string[],
    options?: { topicContexts?: Record<string, Record<string, unknown>> },
  ): Promise<GatewayResponse> {
    return this.client.subscribe(topics, options)
  }

  async unsubscribe(topics: string[]): Promise<GatewayResponse> {
    return this.client.unsubscribe(topics)
  }

  /** Cold-start catch-up for the reliable device action stream. */
  async resumeDeviceActionsFromStart(): Promise<GatewayResponse> {
    return this.requestWithLastAuth('resume', { last_event_id: '0-0' })
  }

  suspend(): void {
    this.resumeRecovering = false
    this.client.suspend()
  }

  close(): void {
    this.resumeRecovering = false
    this.lastAuth = undefined
    this.client.close()
  }

  markResumeRecovering(): void {
    if (this.resumeRecovering) return
    this.resumeRecovering = true
    log.info('连接状态迁移', { status: 'recovering' })
    this.broadcastStatus('recovering')
  }

  clearResumeRecovering(): void {
    if (!this.resumeRecovering) return
    this.resumeRecovering = false
    this.broadcastStatus(this.client.getStatus())
  }

  async reconnectAfterResume(): Promise<boolean> {
    if (!this.lastAuth) return false
    log.info('resume_reconnect', { phase: 'start', status: this.client.getStatus() })
    try {
      const isExpiring = await TokenManager.isAccessTokenExpiringSoon(10)
      if (isExpiring) {
        const freshToken = await TokenManager.refreshAccessToken()
        this.lastAuth = { ...this.lastAuth, token: freshToken }
      } else {
        const token = await TokenManager.getAccessToken()
        if (token) this.lastAuth = { ...this.lastAuth, token }
      }
    } catch (err) {
      // token 刷新失败时仍用现有 token 尝试连接（降级路径）
      log.warn('唤醒重连前刷新 token 失败，沿用现有 token 尝试连接', err)
    }
    const connected = await this.connect(this.lastAuth)
    log.info('resume_reconnect', {
      phase: connected ? 'connected' : 'failed',
      status: this.client.getStatus(),
    })
    return connected
  }

  getStatus(): GatewayClientStatus {
    if (this.resumeRecovering) return 'recovering'
    return this.client.getStatus()
  }

  /** 主进程视角下用户所属全部 organization 快照（auth.ok / organization.membership_changed 回填）。 */
  getOrganizationIds(): string[] {
    return this.client.getOrganizationIds()
  }

  /** 主进程视角下的前台 organization（primary）。 */
  getPrimaryOrganizationId(): string | undefined {
    return this.client.getPrimaryOrganizationId()
  }

  setMainWindow(win: BrowserWindow | null): void {
    this._mainWindow = win
  }

  private broadcastStatus(status: GatewayClientStatus): void {
    try {
      if (this._mainWindow && !this._mainWindow.isDestroyed()) {
        this._mainWindow.webContents.send('ws:agent-gateway-status', status)
      }
    } catch { /* ignore */ }
  }

  private broadcastReconnected(): void {
    try {
      if (this._mainWindow && !this._mainWindow.isDestroyed()) {
        this._mainWindow.webContents.send(ELECTRON_WS_GATEWAY_RECONNECTED_CHANNEL)
      }
    } catch { /* ignore */ }
  }

  getDeviceId(): string {
    return this._deviceId
  }

  acknowledgeApplicationEvent(eventId: string, topic: string): void {
    this.client.acknowledgeApplicationEvent(eventId, topic)
  }

  onReconnect(callback: () => void): () => void {
    this.reconnectListeners.push(callback)
    return () => {
      const idx = this.reconnectListeners.indexOf(callback)
      if (idx >= 0) this.reconnectListeners.splice(idx, 1)
    }
  }

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set())
    }
    this.eventHandlers.get(eventType)!.add(handler)
    return () => {
      this.eventHandlers.get(eventType)?.delete(handler)
    }
  }

  off(eventType: string, handler: EventHandler): void {
    this.eventHandlers.get(eventType)?.delete(handler)
  }

  /**
   * 订阅所有 envelope（原始广播，不按 type 精确匹配）。返回注销函数。
   * ConversationStreamAggregator 用它接 `agent.stream.*` 观察流，再按 topic /
   * thread_id 自行过滤。
   */
  onAnyEvent(handler: (envelope: GatewayEnvelope) => void): () => void {
    this.anyEventHandlers.add(handler)
    return () => {
      this.anyEventHandlers.delete(handler)
    }
  }

  async reportUpdateProgress(
    version: string,
    status: UpdateProgressStatus,
    progress: number,
    error?: { code: string; message: string },
    triggerSource: 'ws_push' | 'http_poll' | 'manual' = 'ws_push',
  ): Promise<void> {
    if (!this.lastAuth) return

    try {
      const { app } = await import('electron')
      await this.client.request(this.lastAuth, 'app.update.progress', {
        version,
        status,
        progress,
        from_version: app.getVersion(),
        trigger_source: triggerSource,
        error_code: error?.code,
        error_message: error?.message
      })
    } catch (err) {
      log.error('上报更新进度失败', { version, status }, err)
    }
  }

  private dispatchEvent(envelope: GatewayEnvelope): void {
    try {
      if (
        shouldForwardGatewayEnvelopeToRenderer(envelope)
        && this._mainWindow
        && !this._mainWindow.isDestroyed()
      ) {
        this._mainWindow.webContents.send(ELECTRON_WS_GATEWAY_EVENT_CHANNEL, envelope)
      }
    } catch { /* ignore */ }

    const handlers = this.eventHandlers.get(envelope.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(envelope.payload, envelope)
        } catch (err) {
          log.error('事件处理器异常', { type: envelope.type }, err)
        }
      }
    }
    if (this.anyEventHandlers.size > 0) {
      for (const handler of this.anyEventHandlers) {
        try {
          handler(envelope)
        } catch (err) {
          log.error('原始 envelope 处理器异常', { type: envelope.type }, err)
        }
      }
    }
  }
}

export const electronWsGateway = new ElectronWsGateway()
