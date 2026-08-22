import { describe, expect, it } from 'vitest'
import * as messageListModule from '../MessageList'

type TimelineKey = (message: {
  id: string
  client_event_id?: string | null
  metadata?: Record<string, unknown> | null
} | undefined, fallback: number) => string | number

describe('getTimelineItemKey', () => {
  it('keeps the virtual row key stable when a user ACK replaces the temporary message id', () => {
    const getTimelineItemKey = (
      messageListModule as unknown as { getTimelineItemKey?: TimelineKey }
    ).getTimelineItemKey

    expect(getTimelineItemKey).toEqual(expect.any(Function))
    expect(getTimelineItemKey?.({
      id: 'temp-user-123',
      metadata: { client_message_id: 'client-123' },
    }, 0)).toBe(getTimelineItemKey?.({
      id: 'server-user-456',
      metadata: { client_message_id: 'client-123' },
    }, 0))
  })

  it('keeps the key stable for materialized user-message segments after ACK', () => {
    const getTimelineItemKey = (
      messageListModule as unknown as { getTimelineItemKey?: TimelineKey }
    ).getTimelineItemKey

    expect(getTimelineItemKey?.({
      id: 'temp-user-123',
      metadata: {
        client_message_id: 'client-123',
        _timeline_item_key: 'temp-user-123:100-120',
      },
    }, 0)).toBe(getTimelineItemKey?.({
      id: 'server-user-456',
      metadata: {
        client_message_id: 'client-123',
        _timeline_item_key: 'server-user-456:100-120',
      },
    }, 0))
  })

  it('uses the real API client_event_id after server sync replaces local metadata', () => {
    const getTimelineItemKey = (
      messageListModule as unknown as { getTimelineItemKey?: TimelineKey }
    ).getTimelineItemKey

    expect(getTimelineItemKey?.({
      id: 'temp-user-123',
      metadata: {
        client_message_id: 'client-123',
        _timeline_item_key: 'temp-user-123:100-120',
      },
    }, 0)).toBe(getTimelineItemKey?.({
      id: 'server-user-456',
      client_event_id: 'client-123',
      metadata: {
        _timeline_item_key: 'server-user-456:100-120',
      },
    }, 0))
  })
})

describe('getCurrentStreamingAssistantMessageId', () => {
  it('does not treat the previous turn assistant as the active streaming tail', () => {
    const getCurrentStreamingAssistantMessageId = (
      messageListModule as unknown as {
        getCurrentStreamingAssistantMessageId?: (
          messages: Array<{
            id: string
            role: string
            message_kind?: string
            metadata?: Record<string, unknown>
          }>,
        ) => string | null
      }
    ).getCurrentStreamingAssistantMessageId

    expect(getCurrentStreamingAssistantMessageId).toEqual(expect.any(Function))
    expect(getCurrentStreamingAssistantMessageId?.([
      { id: 'user-old', role: 'user' },
      { id: 'assistant-old', role: 'assistant' },
      { id: 'user-new', role: 'user' },
    ])).toBeNull()
    expect(getCurrentStreamingAssistantMessageId?.([
      { id: 'user-old', role: 'user' },
      { id: 'assistant-old', role: 'assistant' },
      { id: 'user-new', role: 'user' },
      { id: 'assistant-new', role: 'assistant' },
    ])).toBe('assistant-new')
  })

  it('#7533 穿透末尾 compaction / push / profile，不挂空「思考中」尾巴', () => {
    const getCurrentStreamingAssistantMessageId = (
      messageListModule as unknown as {
        getCurrentStreamingAssistantMessageId?: (
          messages: Array<{
            id: string
            role: string
            message_kind?: string
            metadata?: Record<string, unknown>
          }>,
        ) => string | null
      }
    ).getCurrentStreamingAssistantMessageId

    expect(getCurrentStreamingAssistantMessageId?.([
      { id: 'user-1', role: 'user' },
      { id: 'assistant-1', role: 'assistant', message_kind: 'llm' },
      {
        id: 'push-1',
        role: 'user',
        metadata: { triggered_by: 'push-notification' },
      },
      { id: 'assistant-2', role: 'assistant', message_kind: 'llm' },
      { id: 'compaction-1', role: 'user', message_kind: 'compaction_summary' },
      { id: 'profile-1', role: 'user', message_kind: 'agent_profile_context' },
      { id: 'system-prompt-1', role: 'user', message_kind: 'system_prompt_context' },
    ])).toBe('assistant-2')
  })
})
