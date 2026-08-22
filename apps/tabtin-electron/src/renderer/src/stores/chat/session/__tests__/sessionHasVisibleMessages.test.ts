import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { sessionHasVisibleMessages } from '../sessionHasVisibleMessages'

function session(partial: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: null,
    space_id: 'space-1',
    ...partial,
  } as ChatSession
}

describe('sessionHasVisibleMessages ', () => {
  it('prefers has_messages over message_count and last_message_at', () => {
    expect(sessionHasVisibleMessages(session({
      id: 'a',
      has_messages: true,
      message_count: 0,
      last_message_at: null,
    }))).toBe(true)

    expect(sessionHasVisibleMessages(session({
      id: 'b',
      has_messages: false,
      message_count: 9,
      last_message_at: '2026-08-03T09:00:00.000Z',
    }))).toBe(false)
  })

  it('uses message_count when has_messages is absent', () => {
    expect(sessionHasVisibleMessages(session({ id: 'c', message_count: 2 }))).toBe(true)
    expect(sessionHasVisibleMessages(session({ id: 'd', message_count: 0 }))).toBe(false)
  })

  it('falls back to last_message_at only when both contract fields are missing', () => {
    expect(sessionHasVisibleMessages(session({
      id: 'e',
      message_count: undefined,
      last_message_at: '2026-08-03T09:00:00.000Z',
    }))).toBe(true)

    expect(sessionHasVisibleMessages(session({
      id: 'f',
      message_count: 0,
      last_message_at: '2026-08-03T09:00:00.000Z',
    }))).toBe(false)
  })
})
