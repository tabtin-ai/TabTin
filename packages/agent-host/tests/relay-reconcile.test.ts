import type {
  EventStorageEntry,
  TranscriptEntry,
} from '@tabtin/agent-runtime'
import {
  ContentBlockEvents,
  StreamEvents,
} from '@tabtin/agent-wire'
import { describe, expect, it, vi } from 'vitest'

import {
  SessionMessagesNotFoundError,
  collectServerPersistedKeys,
  fetchAllServerMessageRefs,
  planRelayBackfillEvents,
  resolveRelaySessionIdForReconcile,
} from '../src/delivery/relay-reconcile.js'

const timestamp = (milliseconds: number) =>
  new Date(milliseconds).toISOString()

describe('relay reconcile', () => {
  it('normalizes chat-session ids and rejects prompt-only ids', () => {
    expect(resolveRelaySessionIdForReconcile({
      mapKey: 'prompt_local',
    })).toBeUndefined()
    expect(resolveRelaySessionIdForReconcile({
      mapKey: 'prompt_local',
      businessThreadId:
        'chat-session-3fa85f64-5717-4562-b3fc-2c963f66afa6',
    })).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6')
  })

  it('treats a missing server session as a typed non-recoverable result', async () => {
    await expect(fetchAllServerMessageRefs({
      apiBaseUrl: 'https://api.example.test',
      sessionId: 'missing-session',
      getAccessToken: async () => 'token',
      fetchFn: async () => ({ ok: false, status: 404 }) as Response,
    })).rejects.toBeInstanceOf(SessionMessagesNotFoundError)
  })

  it('deduplicates against both server ids and client event ids', () => {
    const keys = collectServerPersistedKeys([
      { id: 'message-1', client_event_id: 'client-event-1' },
    ])
    expect([...keys]).toEqual(['message-1', 'client-event-1'])
  })

  it('does not backfill an empty assistant message without an error payload', () => {
    const { planned } = planRelayBackfillEvents([
      {
        type: StreamEvents.PERSIST_MESSAGE,
        timestamp: 100,
        payload: {
          message_id: 'assistant-empty',
          role: 'assistant',
          blocks_json: [],
        },
      },
    ], [], new Set())

    expect(planned).toEqual([])
  })

  it('keeps pre-rewind events in order and never revives reverted events', () => {
    const eventLog: EventStorageEntry[] = [
      {
        type: StreamEvents.USER,
        timestamp: 105,
        payload: {
          client_event_id: 'user-keep',
          content: 'keep',
        },
      },
      {
        type: StreamEvents.PERSIST_MESSAGE,
        timestamp: 155,
        payload: {
          message_id: 'assistant-keep',
          role: 'assistant',
          blocks_json: [{ type: 'text', text: 'keep' }],
        },
      },
      {
        type: StreamEvents.USER,
        timestamp: 205,
        payload: {
          client_event_id: 'user-reverted',
          content: 'reverted',
        },
      },
    ]
    const transcript: TranscriptEntry[] = [
      {
        uuid: 'user-start',
        parentUuid: null,
        timestamp: timestamp(100),
        threadId: 'session-1',
        version: 1,
        type: ContentBlockEvents.MESSAGE_START,
        payload: { message_id: 'user-keep', role: 'user' },
      },
      {
        uuid: 'user-stop',
        parentUuid: 'user-start',
        timestamp: timestamp(110),
        threadId: 'session-1',
        version: 2,
        type: ContentBlockEvents.MESSAGE_STOP,
        payload: {},
      },
      {
        uuid: 'assistant-start',
        parentUuid: 'user-stop',
        timestamp: timestamp(150),
        threadId: 'session-1',
        version: 3,
        type: ContentBlockEvents.MESSAGE_START,
        payload: { message_id: 'assistant-keep', role: 'assistant' },
      },
      {
        uuid: 'assistant-stop',
        parentUuid: 'assistant-start',
        timestamp: timestamp(160),
        threadId: 'session-1',
        version: 4,
        type: ContentBlockEvents.MESSAGE_STOP,
        payload: {},
      },
      {
        uuid: 'reverted-start',
        parentUuid: 'assistant-stop',
        timestamp: timestamp(200),
        threadId: 'session-1',
        version: 5,
        type: ContentBlockEvents.MESSAGE_START,
        payload: { message_id: 'user-reverted', role: 'user' },
      },
      {
        uuid: 'rewind',
        parentUuid: 'reverted-start',
        timestamp: timestamp(300),
        threadId: 'session-1',
        version: 6,
        type: StreamEvents.REWIND,
        payload: { phase: 'mark', keep_message_count: 2 },
      },
    ]

    const { planned } = planRelayBackfillEvents(
      eventLog,
      transcript,
      new Set(),
    )

    expect(planned.map((event) =>
      event.payload.client_event_id ?? event.payload.message_id,
    )).toEqual(['user-keep', 'assistant-keep'])
  })

  it('uses block records first and skips already persisted messages', () => {
    const { planned, skipped } = planRelayBackfillEvents(
      [],
      [],
      new Set(['assistant-existing']),
      [{
        message_id: 'assistant-existing',
        role: 'assistant',
        blocks_json: [{ type: 'text', text: 'existing' }],
        message_kind: 'llm',
      }, {
        message_id: 'assistant-missing',
        role: 'assistant',
        blocks_json: [{ type: 'text', text: 'missing' }],
        message_kind: 'llm',
      }],
    )

    expect(planned).toHaveLength(1)
    expect(planned[0]?.payload.message_id).toBe('assistant-missing')
    expect(skipped).toBe(1)
  })

  it('does not backfill local-only external archive records', () => {
    const { planned } = planRelayBackfillEvents(
      [],
      [],
      new Set(),
      [{
        message_id: 'ext-imported-assistant',
        role: 'assistant',
        blocks_json: [{ type: 'text', text: 'imported' }],
        message_kind: 'llm',
      }, {
        message_id: 'ext-llm-boundary-sess-1',
        role: 'user',
        blocks_json: [{ type: 'text', text: '<context type="external-archive">boundary</context>' }],
        message_kind: 'external_archive_context',
      }, {
        message_id: 'live-assistant',
        role: 'assistant',
        blocks_json: [{ type: 'text', text: 'live' }],
        message_kind: 'llm',
      }],
    )

    expect(planned.map((event) => event.payload.message_id)).toEqual(['live-assistant'])
  })

  it('paginates the server message index without duplicate ids', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            messages: [{ id: 'message-2' }, { id: 'message-1' }],
            has_more: true,
            oldest_id: 'message-1',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            messages: [{ id: 'message-1' }],
            has_more: false,
          },
        }),
      } as Response)

    const refs = await fetchAllServerMessageRefs({
      apiBaseUrl: 'https://api.example.test/',
      sessionId: 'session-1',
      getAccessToken: async () => 'token',
      fetchFn,
    })

    expect(refs.map(({ id }) => id)).toEqual(['message-2', 'message-1'])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
