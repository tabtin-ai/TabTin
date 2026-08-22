import type { ChatMessage } from '@tabtin/chat-client'

export type CheckpointPendingContext = {
  spaceId?: string
  baselineHashPromise: Promise<string | undefined>
  userLocalMessageId?: string
  userClientMessageId?: string
  userServerMessageId?: string
}

function getMessageClientId(message: ChatMessage): string | undefined {
  const metadata = message.metadata
  if (!metadata || typeof metadata !== 'object') return undefined
  const record = metadata as Record<string, unknown>
  const value = record.client_event_id ?? record.client_message_id
  return typeof value === 'string' && value ? value : undefined
}

export function isCheckpointAnchorAssistant(message: ChatMessage): boolean {
  return message.role === 'assistant'
    && !message.id.startsWith('temp-')
    && (message.message_kind ?? 'llm') === 'llm'
}

export function findAssistantAfterPendingUser(
  messages: ChatMessage[],
  ctx: CheckpointPendingContext,
): ChatMessage | null {
  const userIndex = messages.findIndex(message => {
    if (message.role !== 'user') return false
    if (ctx.userServerMessageId && message.id === ctx.userServerMessageId) return true
    if (ctx.userLocalMessageId && message.id === ctx.userLocalMessageId) return true
    return !!ctx.userClientMessageId && getMessageClientId(message) === ctx.userClientMessageId
  })
  if (userIndex < 0) return null

  for (let index = messages.length - 1; index > userIndex; index--) {
    const message = messages[index]
    if (isCheckpointAnchorAssistant(message)) {
      return message
    }
  }
  return null
}
