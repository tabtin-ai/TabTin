import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadSessionShareV2, sessionShares } = vi.hoisted(() => ({
  loadSessionShareV2: vi.fn(),
  sessionShares: {} as Record<string, { detail: { session_id?: string | null } | null }>,
}))

vi.mock('@/stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({ loadSessionShareV2, sessionShares }),
  },
}))

import { handleSessionCollaborationEnvelope } from './sessionCollaborationEventHandler'

describe('handleSessionCollaborationEnvelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(sessionShares).forEach((key) => delete sessionShares[key])
  })

  it('reloads authoritative card detail after a state change', () => {
    expect(handleSessionCollaborationEnvelope({
      type: 'session.collaboration.changed',
      payload: { object_id: 'share-1', version: 3 },
    })).toBe(true)

    expect(loadSessionShareV2).toHaveBeenCalledWith('share-1', 3)
  })

  it('reloads a stopped sibling whose session_id was cleared after revoke', () => {
    sessionShares['share-old'] = {
      detail: {
        session_id: null,
        shared_session_id: 'session-1',
        effective_share_id: 'share-latest',
      },
    }
    sessionShares['share-latest'] = {
      detail: { session_id: null, shared_session_id: 'session-1' },
    }

    expect(handleSessionCollaborationEnvelope({
      type: 'session.collaboration.changed',
      payload: {
        object_id: 'share-latest',
        session_id: 'session-1',
        version: 5,
      },
    })).toBe(true)

    expect(loadSessionShareV2).toHaveBeenCalledWith('share-latest', 5)
    expect(loadSessionShareV2).toHaveBeenCalledWith('share-old')
  })

  it('reloads a stopped sibling by effective_share_id when no session id remains', () => {
    sessionShares['share-old'] = {
      detail: { session_id: null, effective_share_id: 'share-latest' },
    }

    expect(handleSessionCollaborationEnvelope({
      type: 'session.collaboration.changed',
      payload: {
        object_id: 'share-latest',
        session_id: 'session-1',
        version: 6,
      },
    })).toBe(true)

    expect(loadSessionShareV2).toHaveBeenCalledWith('share-old')
  })

  it('reloads every cached card for the same shared task', () => {
    sessionShares['share-old'] = { detail: { session_id: 'session-1' } }
    sessionShares['share-latest'] = { detail: { session_id: 'session-1' } }
    sessionShares['share-other'] = { detail: { session_id: 'session-2' } }

    expect(handleSessionCollaborationEnvelope({
      type: 'session.collaboration.changed',
      payload: {
        object_id: 'share-latest',
        session_id: 'session-1',
        version: 4,
      },
    })).toBe(true)

    expect(loadSessionShareV2).toHaveBeenCalledWith('share-latest', 4)
    expect(loadSessionShareV2).toHaveBeenCalledWith('share-old')
    expect(loadSessionShareV2).not.toHaveBeenCalledWith('share-other')
  })

  it('ignores malformed and unrelated events', () => {
    expect(handleSessionCollaborationEnvelope({
      type: 'session.collaboration.changed',
      payload: { object_id: 'share-1', version: 0 },
    })).toBe(false)
    expect(handleSessionCollaborationEnvelope({
      type: 'session.collaboration.access_restored',
      payload: { object_id: 'share-1', version: 3 },
    })).toBe(false)
    expect(handleSessionCollaborationEnvelope({ type: 'agent.stream.step' })).toBe(false)
    expect(loadSessionShareV2).not.toHaveBeenCalled()
  })
})
