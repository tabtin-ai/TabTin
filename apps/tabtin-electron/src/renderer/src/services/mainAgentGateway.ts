import { createLogger } from '@/utils/logger'

const log = createLogger('MainAgentGateway')

export type MainGatewayResponse = {
  ok?: boolean
  type?: string
  requestId?: string
  payload?: Record<string, unknown>
  error?: { code?: string; message?: string }
}

type GatewayEventListener = (envelope: Record<string, unknown>) => void
type ReconnectListener = () => void
type MainGatewayStatus = 'idle' | 'connecting' | 'ready'

const eventListeners = new Set<GatewayEventListener>()
const reconnectListeners = new Set<ReconnectListener>()
const MAIN_GATEWAY_CAPABILITIES = new Set([
  'context.sync',
  'agent.action',
  'table.events',
  'doc.events',
  'docparse.events',
  'tracker.events',
  'notifications',
  'extension.events',
  'billing.events',
  'asr.stream',
  'session.collaboration',
])

let eventBridgeStarted = false
let eventBridgeUnsubscribe: (() => void) | null = null
let reconnectBridgeUnsubscribe: (() => void) | null = null
let organizationIdsSnapshot: string[] = []
let statusSnapshot: MainGatewayStatus = 'idle'

function normalizeStatus(status: string | undefined): MainGatewayStatus {
  if (status === 'ready' || status === 'connecting' || status === 'idle') return status
  if (status === 'recovering') return 'connecting'
  return 'idle'
}

function getBridge(): any | null {
  if (typeof window === 'undefined') return null
  return (window as any).tabtin?.agentGateway ?? null
}

function ensureBridgeSubscriptions(): void {
  if (eventBridgeStarted) return
  const bridge = getBridge()
  if (!bridge) return

  eventBridgeStarted = true
  eventBridgeUnsubscribe = bridge.onEvent?.((envelope: Record<string, unknown>) => {
    for (const listener of Array.from(eventListeners)) {
      try {
        listener(envelope)
      } catch (error) {
        log.error('gateway event listener failed', error)
      }
    }
  }) ?? null
  reconnectBridgeUnsubscribe = bridge.onReconnected?.(() => {
    for (const listener of Array.from(reconnectListeners)) {
      try {
        listener()
      } catch (error) {
        log.error('gateway reconnect listener failed', error)
      }
    }
  }) ?? null
}

function notReadyResponse(message: string): MainGatewayResponse {
  return {
    ok: false,
    type: 'error',
    requestId: '',
    error: { code: 'WS_CLIENT_NOT_READY', message },
  }
}

function blockedAgentStreamResponse(): MainGatewayResponse {
  return {
    ok: false,
    type: 'error',
    requestId: '',
    error: {
      code: 'AGENT_STREAM_IPC_ONLY',
      message: 'agent.stream topics are owned by the main agent-host IPC stream',
    },
  }
}

function hasAgentStreamTopic(topics: unknown[]): boolean {
  return topics.some(topic => (
    typeof topic === 'string'
    && (topic === 'agent.stream' || topic.startsWith('agent.stream.'))
  ))
}

function isAgentStreamSubscribeMessage(messageType: string, payload: Record<string, unknown>): boolean {
  return (
    (messageType === 'subscribe' || messageType === 'unsubscribe')
    && Array.isArray((payload as { topics?: unknown }).topics)
    && hasAgentStreamTopic((payload as { topics: unknown[] }).topics)
  )
}

export const mainAgentGateway = {
  async connect(): Promise<boolean> {
    const bridge = getBridge()
    if (!bridge) return false
    const status = await bridge.getStatus?.()
    statusSnapshot = normalizeStatus(status)
    if (statusSnapshot === 'ready') return true
    const connected = await bridge.reconnect?.() ?? false
    if (connected) statusSnapshot = 'ready'
    return connected
  },

  async forceReconnect(): Promise<boolean> {
    const bridge = getBridge()
    if (!bridge?.reconnect) return false
    const connected = await bridge.reconnect()
    statusSnapshot = connected ? 'ready' : normalizeStatus(await bridge.getStatus?.())
    return connected
  },

  close(): void {
    // 主进程 ElectronWsGateway 是进程级共享连接，renderer 不能直接关闭。
  },

  setInitialLastEventId(): void {
    // Main gateway owns resume state. Renderer no longer injects a cursor.
  },

  getConnectionStatus(): MainGatewayStatus {
    const bridge = getBridge()
    void bridge?.getStatus?.().then((status: string) => {
      statusSnapshot = normalizeStatus(status)
    })
    return statusSnapshot
  },

  isConnected(): boolean {
    return this.getConnectionStatus() === 'ready'
  },

  async sendResume(): Promise<void> {
    // Main gateway owns resume state; keep WsGateway compatibility for StreamManager.
  },

  async request(
    messageType: string,
    payload: Record<string, unknown>,
    requestOptions?: Record<string, unknown>,
  ): Promise<MainGatewayResponse> {
    if (isAgentStreamSubscribeMessage(messageType, payload)) {
      return blockedAgentStreamResponse()
    }
    const bridge = getBridge()
    if (!bridge?.request) return notReadyResponse('agent gateway bridge unavailable')
    return bridge.request({ messageType, payload, requestOptions })
  },

  async subscribe(
    topics: string[],
    options?: { topicContexts?: Record<string, Record<string, unknown>> },
  ): Promise<MainGatewayResponse> {
    if (hasAgentStreamTopic(topics)) return blockedAgentStreamResponse()
    const bridge = getBridge()
    if (!bridge?.subscribe) return notReadyResponse('agent gateway bridge unavailable')
    return bridge.subscribe({ topics, options })
  },

  async unsubscribe(topics: string[]): Promise<MainGatewayResponse> {
    if (hasAgentStreamTopic(topics)) return blockedAgentStreamResponse()
    const bridge = getBridge()
    if (!bridge?.unsubscribe) return notReadyResponse('agent gateway bridge unavailable')
    return bridge.unsubscribe({ topics })
  },

  send(
    messageType: string,
    payload: Record<string, unknown>,
    requestOptions?: Record<string, unknown>,
  ): boolean {
    if (isAgentStreamSubscribeMessage(messageType, payload)) return false
    const bridge = getBridge()
    if (!bridge?.send) return false
    void bridge.send({ messageType, payload, requestOptions })
    return true
  },

  addListener(listener: GatewayEventListener): void {
    ensureBridgeSubscriptions()
    eventListeners.add(listener)
  },

  removeListener(listener: GatewayEventListener): void {
    eventListeners.delete(listener)
  },

  onReconnectedEvent(listener: ReconnectListener): void {
    ensureBridgeSubscriptions()
    reconnectListeners.add(listener)
  },

  offReconnectedEvent(listener: ReconnectListener): void {
    reconnectListeners.delete(listener)
  },

  getOrganizationIds(): string[] {
    const bridge = getBridge()
    void bridge?.getOrganizationIds?.()
      .then((ids: string[]) => {
        organizationIdsSnapshot = Array.isArray(ids) ? ids : []
      })
      .catch(() => {})
    return organizationIdsSnapshot
  },

  getPrimaryOrganizationId(): string | undefined {
    return organizationIdsSnapshot[0]
  },

  hasCapability(capability: string): boolean {
    return MAIN_GATEWAY_CAPABILITIES.has(capability)
  },

  async refreshOrganizationIds(): Promise<string[]> {
    const bridge = getBridge()
    organizationIdsSnapshot = await bridge?.getOrganizationIds?.() ?? []
    return organizationIdsSnapshot
  },
}

export function __resetMainAgentGatewayBridgeForTests(): void {
  eventBridgeUnsubscribe?.()
  reconnectBridgeUnsubscribe?.()
  eventBridgeUnsubscribe = null
  reconnectBridgeUnsubscribe = null
  eventBridgeStarted = false
  eventListeners.clear()
  reconnectListeners.clear()
  statusSnapshot = 'idle'
}
