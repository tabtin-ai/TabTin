import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  buildIdentityIndex,
  findByIdentity,
  getClientMessageId,
  identityKeys,
  listHasIdentity,
  sharesIdentity,
} from '@/stores/chat/domain/messageIdentity'

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'user',
    content: 'hello',
    created_at: new Date().toISOString(),
    ...overrides,
  } as ChatMessage
}

describe('messageIdentity', () => {
  it('collects id + client_event_id + metadata client/message ids', () => {
    const keys = identityKeys(msg({
      id: 'local-1',
      client_event_id: 'cid-top',
      metadata: {
        client_message_id: 'cid-msg',
        client_event_id: 'cid-meta',
        message_id: 'server-uuid',
      },
    }))
    expect(keys.sort()).toEqual(['cid-meta', 'cid-msg', 'cid-top', 'local-1', 'server-uuid'].sort())
  })

  it('sharesIdentity matches across local shell and server uuid via metadata.message_id', () => {
    const local = msg({ id: 'local-abc', metadata: { message_id: 'srv-1' } })
    const server = msg({ id: 'srv-1', client_event_id: 'cid-1' })
    expect(sharesIdentity(local, server)).toBe(true)
  })

  it('listHasIdentity / findByIdentity use the same key set', () => {
    const existing = [
      msg({ id: 'temp-user-1', metadata: { client_message_id: 'cid-1' } }),
    ]
    const incoming = msg({ id: 'srv-uuid', client_event_id: 'cid-1' })
    expect(listHasIdentity(existing, incoming)).toBe(true)
    expect(findByIdentity(buildIdentityIndex(existing), incoming)?.id).toBe('temp-user-1')
  })

  it('getClientMessageId prefers top-level client_event_id', () => {
    expect(getClientMessageId(msg({
      id: 'x',
      client_event_id: 'top',
      metadata: { client_message_id: 'meta' },
    }))).toBe('top')
  })
})
