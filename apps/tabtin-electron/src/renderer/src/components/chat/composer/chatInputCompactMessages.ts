import type { ChatMessage } from '@tabtin/chat-client'
import { useChatStore } from '@/stores/chat/useChatStore'

export function appendLocalSystemMessage(
  sessionId: string,
  content: string,
  options?: { status?: 'running' | 'idle' },
): string {
  const now = new Date().toISOString()
  const id = `local-compact-${crypto.randomUUID()}`
  const message: ChatMessage = {
    id,
    role: 'system',
    content,
    content_blocks_json: [{ type: 'text', text: content }],
    message_kind: 'llm',
    metadata: {
      source: 'manual_compact_status',
      status: options?.status ?? 'idle',
    },
    created_at: now,
    updated_at: now,
  }
  useChatStore.getState().injectSystemMessage(sessionId, message)
  return id
}

export function removeLocalSystemMessage(sessionId: string, messageId: string): void {
  useChatStore.getState().removeMessage(sessionId, messageId)
}
