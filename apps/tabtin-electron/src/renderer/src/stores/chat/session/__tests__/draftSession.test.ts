import { afterEach, describe, expect, it } from 'vitest'
import {
  bindDraftSessionToMessage,
  registerDraftSession,
  registerDraftMessageScope,
  getDraftSession,
  getPendingDraftSessionByScopeKey,
  markDraftSessionClaimed,
  rehomeDraftSession,
  releaseDraftSession,
  resetDraftSessions,
} from '../draftSession'

describe('draft session lifecycle', () => {
  afterEach(() => resetDraftSessions())

  it('keeps DraftMessage ownership after the message draft is no longer active', () => {
    registerDraftSession({ sessionId: 'session-1', draftMessageId: 'draft-message-1', draftScopeKey: 'scope-1' })

    expect(getDraftSession('session-1')).toMatchObject({
      draftMessageId: 'draft-message-1',
      status: 'pending',
    })
  })

  it('promotes a pending draft session when sending starts', () => {
    registerDraftSession({ sessionId: 'session-1', draftMessageId: 'draft-message-1', draftScopeKey: 'scope-1' })

    expect(markDraftSessionClaimed('session-1')?.status).toBe('claimed')
  })

  it('sending phase remains pending until send commit claims the session', () => {
    registerDraftMessageScope('scope-1', 'draft-message-1')

    expect(bindDraftSessionToMessage('scope-1', 'session-1', { phase: 'sending' })?.status)
      .toBe('pending')
    expect(getPendingDraftSessionByScopeKey('scope-1')?.sessionId).toBe('session-1')
  })

  it('claimed sessions no longer appear in pending draft queries', () => {
    registerDraftSession({ sessionId: 'session-1', draftMessageId: 'draft-message-1', draftScopeKey: 'scope-1' })

    markDraftSessionClaimed('session-1')

    expect(getPendingDraftSessionByScopeKey('scope-1')).toBeUndefined()
  })

  it('transfers ownership when another DraftMessage reuses the session', () => {
    registerDraftSession({ sessionId: 'session-1', draftMessageId: 'draft-message-1', draftScopeKey: 'scope-1' })

    expect(registerDraftSession({ sessionId: 'session-1', draftMessageId: 'draft-message-2', draftScopeKey: 'scope-2' })).toMatchObject({
      draftMessageId: 'draft-message-2',
      status: 'pending',
    })
  })

  it('rehomes a local pending draft session without retaining the old identity', () => {
    registerDraftSession({ sessionId: 'local-pending-1', draftMessageId: 'draft-message-1', draftScopeKey: 'scope-1' })

    expect(rehomeDraftSession('local-pending-1', 'session-1')).toMatchObject({
      sessionId: 'session-1',
      draftMessageId: 'draft-message-1',
    })
    expect(getDraftSession('local-pending-1')).toBeUndefined()
  })

  it('rehoming removes the old ownership index', () => {
    registerDraftMessageScope('scope-1', 'draft-message-1')
    bindDraftSessionToMessage('scope-1', 'local-pending-1')
    rehomeDraftSession('local-pending-1', 'session-1')

    registerDraftMessageScope('scope-2', 'draft-message-2')
    expect(bindDraftSessionToMessage('scope-2', 'local-pending-1')).toMatchObject({
      draftMessageId: 'draft-message-2',
    })
  })

  it('requires an explicit release before cleanup may treat a draft session as abandoned', () => {
    registerDraftSession({ sessionId: 'session-1', draftMessageId: 'draft-message-1', draftScopeKey: 'scope-1' })

    expect(getDraftSession('session-1')?.status).not.toBe('released')
    expect(releaseDraftSession('session-1')?.status).toBe('released')
  })
})
