import { describe, expect, it } from 'vitest'

import { AgentSessionState } from '../src/application/agent/session/agent-session-state.js'

describe('AgentSessionState ownership contract', () => {
  it('deletes every session-scoped side state through one operation', () => {
    const state = new AgentSessionState<{ sessionId: string }, object>()
    state.setInteractionMode('session-1', 'interactive')
    state.setContextTier('session-1', 'tier-1')
    state.setCredentialResolver('session-1', {})
    state.setPendingTurn('run-1', { sessionId: 'session-1' })
    state.setPendingTurn('run-2', { sessionId: 'session-2' })

    state.deleteSession('session-1')

    expect(state.getInteractionMode('session-1')).toBeUndefined()
    expect(state.getContextTier('session-1')).toBeUndefined()
    expect(state.getCredentialResolver('session-1')).toBeUndefined()
    expect(state.getPendingTurn('run-1')).toBeUndefined()
    expect(state.getPendingTurn('run-2')).toBeDefined()
  })

  it('normalizes context tier updates and removes blank values', () => {
    const state = new AgentSessionState<{ sessionId?: unknown }, object>()
    state.setContextTier(' session-1 ', ' tier-1 ')
    expect(state.getContextTier('session-1')).toBe('tier-1')
    state.setContextTier('session-1', ' ')
    expect(state.getContextTier('session-1')).toBeUndefined()
  })

  it('clears all session-owned state on host shutdown', () => {
    const state = new AgentSessionState<{ sessionId?: unknown }, object>()
    state.setInteractionMode('session-1', 'scheduled')
    state.setPendingTurn('run-1', {})
    state.clear()
    expect(state.getInteractionMode('session-1')).toBeUndefined()
    expect(state.getPendingTurn('run-1')).toBeUndefined()
  })
})
