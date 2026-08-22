import { describe, expect, it } from 'vitest'
import { correlateSourceClientEvent } from '@tabtin/agent-host/delivery'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'

describe('Electron host source_client_event_id correlation', () => {
  it.each([
    'agent.stream.lifecycle',
    'agent.stream.message_start',
    'agent.stream.message_delta',
    'agent.stream.content_block_start',
    'agent.stream.content_block_delta',
    'agent.stream.content_block_stop',
    'agent.stream.message_stop',
    'agent.stream.assistant',
    'agent.stream.persist_message',
    'agent.stream.done',
  ])('injects the current request client id into %s', (type) => {
    const event = correlateSourceClientEvent({ type, payload: {} }, SOURCE_ID)
    expect(event.payload.source_client_event_id).toBe(SOURCE_ID)
  })

  it('keeps unrelated IPC stream payloads backward compatible', () => {
    const event = { type: 'agent.stream.user', payload: { client_event_id: SOURCE_ID } }
    expect(correlateSourceClientEvent(event, SOURCE_ID)).toBe(event)
    expect(correlateSourceClientEvent(event)).toBe(event)
  })

  it('does not attach the parent user identity to raw subagent messages', () => {
    const event = {
      type: 'agent.stream.persist_message',
      payload: { subagent_run_id: 'child-run-1' },
    }
    expect(correlateSourceClientEvent(event, SOURCE_ID)).toBe(event)
    expect(event.payload).not.toHaveProperty('source_client_event_id')
  })
})
