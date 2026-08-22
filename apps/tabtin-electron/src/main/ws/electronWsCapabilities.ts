import { Capabilities, DomainEvents } from '@tabtin/ws-gateway-client'

/**
 * Electron 主网关是桌面端唯一 Gateway 连接，承载 renderer 旧 WS 的实时能力
 * 与本地 Agent 控制面。AgentHost 会动态订阅 agent.stream.{thread_id}，
 * 因此观察流能力不是可选项。
 */
export const DEFAULT_ELECTRON_WS_CAPABILITIES = [
  DomainEvents.CONTEXT_SYNC,
  Capabilities.AGENT_ACTION,
  Capabilities.AGENT_STREAM,
  Capabilities.TABLE_EVENTS,
  Capabilities.CONTEXT_SYNC,
  Capabilities.DOC_EVENTS,
  Capabilities.DOCPARSE_EVENTS,
  Capabilities.TRACKER_EVENTS,
  Capabilities.NOTIFICATIONS,
  Capabilities.EXTENSION_EVENTS,
  Capabilities.BILLING_EVENTS,
  Capabilities.ASR_STREAM,
  Capabilities.SESSION_COLLABORATION,
]
