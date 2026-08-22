import type { components } from '@tabtin/api-client'
import { getApiClient } from './tabtin-client'

export type ChatMessageItem = components['schemas']['ChatMessage']

export async function getChatMessages(sessionId: string, limit = 200): Promise<ChatMessageItem[]> {
  const client = getApiClient()
  const { data, error } = await client.GET('/chat/sessions/{session_id}/messages', {
    params: {
      path: { session_id: sessionId },
      query: { limit },
    },
  })
  if (error) throw error
  const response = data as Record<string, unknown> | undefined
  const messages = response?.messages
  return Array.isArray(messages) ? messages : []
}
