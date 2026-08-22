import type { IMMessage } from '@/services/tabchatApi'

/**
 * 长消息展开状态的身份键。
 *
 * 乐观消息的服务端 id 均为 -1；确认后 `_tempId` 会移除但 client_request_id 保留。
 * 因此两态统一优先使用 client request id，并加入会话与发送者命名空间，避免模块级
 * 展开状态缓存跨会话、跨发送者串到另一条消息。
 */
export function resolveIMCollapsibleMessageKey(message: Pick<
  IMMessage,
  'conversation_id' | 'sender_id' | 'id' | '_tempId' | 'metadata'
>): string {
  const clientRequestId = message._tempId ?? message.metadata?.client_request_id
  return JSON.stringify([
    message.conversation_id,
    message.sender_id ?? '',
    clientRequestId ? 'client' : 'server',
    clientRequestId ?? message.id,
  ])
}
