import { describe, expect, it } from 'vitest'
import type { IMMessage } from './contracts'
import {
  mergeAndSortMessages,
  messagesShareStableIdentity,
} from './messageMerge'

function message(
  id: number,
  metadata: IMMessage['metadata'],
  overrides: Partial<IMMessage> = {},
): IMMessage {
  return {
    id,
    seq: id > 0 ? id : undefined,
    conversation_id: 'conversation-a',
    sender_id: 'user-a',
    content: `message-${id}`,
    message_type: 1,
    reply_to_id: null,
    has_attachment: false,
    metadata,
    created_at: '2026-07-30T08:00:00.000Z',
    ...overrides,
  }
}

describe('message identity merge', () => {
  it('converges optimistic, send confirmation, and realtime echo by message_ref', () => {
    const optimistic = message(-1, {
      message_ref: 'message-ref-a',
      client_request_id: 'request-a',
    }, {
      _optimistic: true,
      _tempId: 'message-ref-a',
    })
    const confirmation = message(41, {
      message_ref: 'message-ref-a',
      client_request_id: 'request-a',
    })
    const echo = message(42, {
      message_ref: 'message-ref-a',
      client_request_id: 'request-a',
      revision: 2,
    }, {
      content: 'provider echo',
    })

    expect(mergeAndSortMessages(
      [optimistic],
      [confirmation],
      [echo],
    )).toEqual([
      expect.objectContaining({
        id: 42,
        content: 'provider echo',
        _optimistic: false,
        _tempId: undefined,
        metadata: expect.objectContaining({
          message_ref: 'message-ref-a',
          client_request_id: 'request-a',
          revision: 2,
        }),
      }),
    ])
  })

  it('falls back to client_request_id only when both messages lack message_ref', () => {
    const pending = message(-1, {
      client_request_id: 'request-a',
    }, {
      _optimistic: true,
    })
    const echo = message(7, {
      client_request_id: 'request-a',
    })

    expect(messagesShareStableIdentity(pending, echo)).toBe(true)
    expect(mergeAndSortMessages([pending], [echo])).toHaveLength(1)
  })

  it('does not collapse different message_ref values that share one request ID', () => {
    const first = message(7, {
      message_ref: 'message-ref-a',
      client_request_id: 'request-shared',
    })
    const second = message(8, {
      message_ref: 'message-ref-b',
      client_request_id: 'request-shared',
    })

    expect(messagesShareStableIdentity(first, second)).toBe(false)
    expect(mergeAndSortMessages([first], [second])).toHaveLength(2)
  })

  it('orders confirmed messages by seq and leaves optimistic messages at the tail', () => {
    const pending = message(-1, {
      message_ref: 'message-ref-pending',
      client_request_id: 'request-pending',
    }, {
      _optimistic: true,
    })
    const newest = message(12, {
      message_ref: 'message-ref-12',
      client_request_id: 'request-12',
    })
    const oldest = message(4, {
      message_ref: 'message-ref-4',
      client_request_id: 'request-4',
    })

    expect(
      mergeAndSortMessages([pending, newest], [oldest]).map((item) => item.id),
    ).toEqual([4, 12, -1])
  })

  it('orders C2C messages by send time instead of comparing sender-local sequences', () => {
    const earlierFromMe = message(900, { message_ref: 'c2c-earlier-me' }, {
      created_at: '2026-08-17T08:48:05.000Z',
      transport: {
        kind: 'c2c',
        sequence: 900,
        sent_at: '2026-08-17T08:48:05.000Z',
      },
    })
    const middleFromPeer = message(12, { message_ref: 'c2c-middle-peer' }, {
      sender_id: 'peer',
      created_at: '2026-08-17T08:48:20.000Z',
      transport: {
        kind: 'c2c',
        sequence: 12,
        sent_at: '2026-08-17T08:48:20.000Z',
      },
    })
    const laterFromMe = message(901, { message_ref: 'c2c-later-me' }, {
      created_at: '2026-08-17T08:48:35.000Z',
      transport: {
        kind: 'c2c',
        sequence: 901,
        sent_at: '2026-08-17T08:48:35.000Z',
      },
    })

    expect(
      mergeAndSortMessages([laterFromMe, middleFromPeer, earlierFromMe])
        .map((item) => item.metadata.message_ref),
    ).toEqual(['c2c-earlier-me', 'c2c-middle-peer', 'c2c-later-me'])
  })

  it('keeps C2C messages from different senders when their local sequences match', () => {
    const mine = message(1, { message_ref: 'c2c-mine' }, {
      transport: { kind: 'c2c', sequence: 1, sent_at: '2026-08-17T08:48:05.000Z' },
    })
    const peer = message(1, { message_ref: 'c2c-peer' }, {
      sender_id: 'peer',
      transport: { kind: 'c2c', sequence: 1, sent_at: '2026-08-17T08:48:06.000Z' },
    })

    expect(messagesShareStableIdentity(mine, peer)).toBe(false)
    expect(mergeAndSortMessages([mine], [peer])).toHaveLength(2)
  })

  it('hydrates a missing reply preview from the referenced loaded message', () => {
    const parent = message(12, { message_ref: 'message-ref-parent' }, {
      sender_id: 'me',
      content: '1212',
    })
    const incomingReply = message(13, { message_ref: 'message-ref-reply' }, {
      sender_id: 'peer',
      content: 'xxx',
      reply_to_id: 12,
    })

    expect(mergeAndSortMessages([parent], [incomingReply])).toEqual([
      parent,
      expect.objectContaining({
        id: 13,
        reply_to_preview: {
          sender_id: 'me',
          content: '1212',
          message_type: 1,
        },
      }),
    ])
  })

  it('refreshes reply previews when the referenced message is edited', () => {
    const parent = message(12, { message_ref: 'message-ref-parent' }, {
      sender_id: 'me',
      content: 'old content',
    })
    const reply = message(13, { message_ref: 'message-ref-reply' }, {
      sender_id: 'peer',
      reply_to_id: 12,
      reply_to_preview: { sender_id: 'me', content: 'old content' },
    })
    const editedParent = {
      ...parent,
      content: 'new content',
      edited_at: '2026-07-30T08:05:00.000Z',
    }

    const merged = mergeAndSortMessages([parent, reply], [editedParent])

    expect(merged.find((item) => item.id === 12)?.content).toBe('new content')
    expect(merged.find((item) => item.id === 13)?.reply_to_preview).toEqual({
      sender_id: 'me',
      content: 'new content',
      message_type: 1,
    })
  })

  it('keeps an optimistic reply preview when the provider echo omits it', () => {
    const optimistic = message(-1, {
      message_ref: 'message-ref-reply',
      client_request_id: 'request-reply',
    }, {
      reply_to_id: 12,
      reply_to_preview: { sender_id: 'me', content: '1212' },
      _optimistic: true,
      _tempId: 'message-ref-reply',
    })
    const providerEcho = message(13, {
      message_ref: 'message-ref-reply',
      client_request_id: 'request-reply',
    }, {
      reply_to_id: 12,
      reply_to_preview: undefined,
    })

    expect(mergeAndSortMessages([optimistic], [providerEcho])).toEqual([
      expect.objectContaining({
        id: 13,
        reply_to_preview: {
          sender_id: 'me',
          content: '1212',
        },
      }),
    ])
  })
})
