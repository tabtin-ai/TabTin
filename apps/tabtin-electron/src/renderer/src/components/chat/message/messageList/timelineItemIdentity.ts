import type { ChatMessage } from '@tabtin/chat-client'
import { isLlmAssistantSegment, isRegularUserMessage } from '@stores/chat/presentation/messageTimeline/turnTransparency'

/** 稳定虚拟行身份：用户消息 ACK 前后及物化分段都保持同一语义 key。 */
// eslint-disable-next-line complexity -- key 稳定性同时兼容 ACK 前 client id 与物化段 suffix。
export function getTimelineItemKey(message: ChatMessage | undefined, fallback: number): string | number {
  const metadata = message?.metadata as Record<string, unknown> | null | undefined
  const timelineKey = metadata?._timeline_item_key
  const clientMessageId = message?.client_event_id ?? metadata?.client_message_id ?? metadata?.client_event_id
  if (typeof clientMessageId === 'string' && clientMessageId) {
    if (typeof timelineKey === 'string' && timelineKey) {
      const separator = timelineKey.lastIndexOf(':')
      const segmentSuffix = separator >= 0 ? timelineKey.slice(separator) : `:${timelineKey}`
      return `client:${clientMessageId}${segmentSuffix}`
    }
    return `client:${clientMessageId}`
  }
  if (typeof timelineKey === 'string' && timelineKey) return timelineKey
  return message?.id ?? fallback
}

/** 当前流式尾巴应对齐的 llm assistant id；真实用户消息是唯一截断点。 */
export function getCurrentStreamingAssistantMessageId(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRegularUserMessage(message)) return null
    if (isLlmAssistantSegment(message)) return message.id
  }
  return null
}
