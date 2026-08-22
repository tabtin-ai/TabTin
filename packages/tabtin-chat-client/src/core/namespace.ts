export const PRIMARY_NAMESPACE = 'agent'

export const STREAM_CAPABILITY = `${PRIMARY_NAMESPACE}.stream`
export const ACTION_CAPABILITY = `${PRIMARY_NAMESPACE}.action`
// session topic 与 stream 共享 capability（后端 TOPIC_CAPABILITIES 中映射到 agent.stream）。
export const SESSION_CAPABILITY = STREAM_CAPABILITY

export const streamTopic = (threadId: string): string => {
  return `${PRIMARY_NAMESPACE}.stream.${threadId}`
}

export const actionTopic = (threadId: string): string => {
  return `${PRIMARY_NAMESPACE}.action.${threadId}`
}

/**
 * Session-level WS topic，生命周期与 ChatSession 激活/离开绑定，
 * 独立于 stream slot 的 agent.stream topic 退订。
 * 用于投递跨 stream 轮次、stream.done 之后才就绪的 session 级异步事件。
 */
export const sessionTopic = (sessionId: string): string => {
  return `${PRIMARY_NAMESPACE}.session.${sessionId}`
}

export const streamEventType = (eventName: string): string => {
  return `${PRIMARY_NAMESPACE}.stream.${eventName}`
}

export const actionEventType = (eventName: string): string => {
  return `${PRIMARY_NAMESPACE}.action.${eventName}`
}

export const sessionEventType = (eventName: string): string => {
  return `${PRIMARY_NAMESPACE}.session.${eventName}`
}

export const canonicalizeEventType = (eventType: string): string => eventType
