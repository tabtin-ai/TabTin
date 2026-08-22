import { describe, expect, it } from 'vitest'
import { buildChatMessagesFilename } from './chat-message-export'

describe('chat message export', () => {
  it('names the download after the chat session id', () => {
    expect(buildChatMessagesFilename('chat-session-ignored', { session_id: 'session-1' })).toBe(
      'chat-messages-session-1.json'
    )
  })

  it('falls back to thread id when session id is empty', () => {
    expect(buildChatMessagesFilename('chat-session-abc', { session_id: '' })).toBe(
      'chat-messages-chat-session-abc.json'
    )
  })
})
