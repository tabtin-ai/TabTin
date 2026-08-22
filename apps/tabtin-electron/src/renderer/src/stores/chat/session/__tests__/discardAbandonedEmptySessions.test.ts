import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { selectAbandonedEmptySessions } from '../discardAbandonedEmptySessions'

function session(partial: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: partial.title ?? null,
    message_count: partial.message_count ?? 0,
    status: partial.status ?? 'active',
    space_id: partial.space_id ?? 'space-1',
    ...partial,
  } as ChatSession
}

describe('selectAbandonedEmptySessions ', () => {
  it('selects unused empty sessions from store buckets', () => {
    const empty = session({ id: 'empty-1', message_count: 0 })
    const real = session({ id: 'real-1', message_count: 2 })
    expect(selectAbandonedEmptySessions({
      sessionIds: ['empty-1', 'real-1'],
      sessionsBySpaceId: { 'space-1': [empty, real] },
      isDraftSessionReleased: () => true,
    })).toEqual([{ sessionId: 'empty-1', spaceId: 'space-1' }])
  })

  it('keeps sessions with local user bubbles even when message_count is 0', () => {
    const failed = session({ id: 'failed-1', message_count: 0 })
    expect(selectAbandonedEmptySessions({
      sessionIds: ['failed-1'],
      sessionsBySpaceId: { 'space-1': [failed] },
      isDraftSessionReleased: () => true,
      messagesBySessionId: {
        'failed-1': [{ id: 'm1', role: 'user', content: 'hi' } as never],
      },
    })).toEqual([])
  })

  it('skips local-pending and sending episode', () => {
    const empty = session({ id: 'empty-1' })
    expect(selectAbandonedEmptySessions({
      sessionIds: ['local-pending-abc', 'empty-1'],
      sessionsBySpaceId: { 'space-1': [empty] },
      draftSessionPhase: 'sending',
      isDraftSessionReleased: () => true,
    })).toEqual([])
  })

  it('uses explicit space when bucket has not merged the prefetch session yet', () => {
    expect(selectAbandonedEmptySessions({
      sessionIds: ['fresh-1'],
      sessionsBySpaceId: {},
      sessionSpaceById: { 'fresh-1': 'space-x' },
      isDraftSessionReleased: () => true,
    })).toEqual([{ sessionId: 'fresh-1', spaceId: 'space-x' }])
  })

  it('only discards sessions with an explicitly released claim', () => {
    const empty = session({ id: 'empty-1' })
    expect(selectAbandonedEmptySessions({
      sessionIds: ['empty-1'],
      sessionsBySpaceId: { 'space-1': [empty] },
      isDraftSessionReleased: () => false,
    })).toEqual([])
    expect(selectAbandonedEmptySessions({
      sessionIds: ['empty-1'],
      sessionsBySpaceId: { 'space-1': [empty] },
      isDraftSessionReleased: () => true,
    })).toEqual([{ sessionId: 'empty-1', spaceId: 'space-1' }])
  })
})
