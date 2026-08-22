import type { ChatMessage } from '@tabtin/chat-client'

export const buildCheckpointMapFromMessages = (messages: ChatMessage[]): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const msg of messages) {
    if (msg.checkpoint_hash) {
      result[msg.id] = msg.checkpoint_hash
    }
  }
  return result
}
