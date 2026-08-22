import { describe, expect, it } from 'vitest'
import { StreamEvents } from '@tabtin/agent-wire'
import type { StreamEvent } from '@tabtin/agent-runtime'
import { routeDeliveryEvent } from '../src/delivery/delivery-event-routing.js'

describe('routeDeliveryEvent', () => {
  it('keeps normal runtime events on durable delivery', () => {
    const event = {
      type: StreamEvents.SYSTEM_NOTICE,
      payload: { notice_type: 'tool_completed' },
    } as StreamEvent

    expect(routeDeliveryEvent(event, 'runtime')).toBe('durable')
  })

  it('routes subagent visible message facts durably', () => {
    const event = {
      type: StreamEvents.PERSIST_MESSAGE,
      payload: {
        message_id: 'child-message-1',
        blocks_json: [{ type: 'text', text: 'child history' }],
        subagent_run_id: 'child-1',
      },
    } as StreamEvent

    expect(routeDeliveryEvent(event, 'subagent_trace')).toBe('durable')
  })

  it('keeps subagent observer trace events transient', () => {
    const event = {
      type: StreamEvents.SUBAGENT_STREAM_EVENT,
      payload: { subagent_run_id: 'child-1' },
    } as StreamEvent

    expect(routeDeliveryEvent(event, 'subagent_trace')).toBe('transient')
  })

  it('keeps subagent stream wrappers transient while preserving progress durability', () => {
    expect(routeDeliveryEvent({
      type: StreamEvents.SUBAGENT_STREAM_EVENT,
      payload: { subagent_run_id: 'child-1' },
    } as StreamEvent, 'subagent_stream')).toBe('transient')

    expect(routeDeliveryEvent({
      type: StreamEvents.SUBAGENT_PROGRESS,
      payload: { subagent_run_id: 'child-1', step_count: 1 },
    } as StreamEvent, 'subagent_stream')).toBe('durable')
  })
})
