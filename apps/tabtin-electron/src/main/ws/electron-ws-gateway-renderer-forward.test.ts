import { describe, expect, it } from 'vitest'
import { shouldForwardGatewayEnvelopeToRenderer } from './renderer-forward-filter'

describe('shouldForwardGatewayEnvelopeToRenderer', () => {
  it('keeps agent stream envelopes inside main agent-host delivery', () => {
    expect(shouldForwardGatewayEnvelopeToRenderer({
      type: 'agent.stream.lifecycle',
      _topic: 'agent.stream.chat-session-sess-1',
    })).toBe(false)
    expect(shouldForwardGatewayEnvelopeToRenderer({
      type: 'session.event',
      _topic: 'agent.stream.chat-session-sess-1',
    })).toBe(false)
  })

  it('allows non-agent-stream gateway events to reach renderer listeners', () => {
    expect(shouldForwardGatewayEnvelopeToRenderer({
      type: 'table.events.updated',
      _topic: 'table.events.space-1',
    })).toBe(true)
  })
})
