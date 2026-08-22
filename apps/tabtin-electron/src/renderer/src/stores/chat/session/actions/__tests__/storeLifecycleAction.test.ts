import { describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({ reset: vi.fn(), evictSessionBatch: vi.fn() }),
  },
}))

vi.mock('@/stores/useWsConnectionStore', () => ({
  useWsConnectionStore: {
    getState: () => ({ removeSuspendedSession: vi.fn() }),
  },
}))

vi.mock('@/stores/chat/messages/messageCacheSlice', () => ({
  removeSpacesFromAccessOrder: vi.fn(),
  removeSessionsFromAccessOrder: vi.fn(),
  resetCacheAccessOrder: vi.fn(),
}))

vi.mock('@/stores/chat/messages/actions/failedMessageEditResend', () => ({
  clearAllFailedMessageEditResend: vi.fn(),
}))

vi.mock('@/stores/chat/session/locallySubmittedSessionRegistry', () => ({
  clearAllLocallySubmittedSessions: vi.fn(),
}))

vi.mock('@/stores/chat/session/draftMessageSessionCoordinator', () => ({
  resetDraftMessageSessionState: vi.fn(),
}))

vi.mock('@/stores/chat/session/actions/sessionPrefetchAction', () => ({
  clearAllDraftPrefetchLatches: vi.fn(),
}))

vi.mock('@/stores/chat/session/actions/sessionLifecycleAction', () => ({
  invalidateSessionProvisionGeneration: vi.fn(),
}))

import { createStoreLifecycleActions } from '../storeLifecycleAction'

describe('createStoreLifecycleActions.purgeOrganizationSpaces', () => {
  it('显式移除空会话桶，避免重连继续请求已失效 Workspace', () => {
    const state: {
      sessionsBySpaceId: Record<string, never[]>
      currentSessionIdBySpaceId: Record<string, unknown>
      draftSessionBySpaceId: Record<string, unknown>
      messagesBySessionId: Record<string, unknown>
      pendingApprovalBySessionId: Record<string, unknown>
      approvalSubmittingBySessionId: Record<string, unknown>
      pendingAskUserBySessionId: Record<string, unknown>
      askUserSubmittingBySessionId: Record<string, unknown>
      trackerRunSessionsBySpaceId: Record<string, unknown>
      trackerRunCountBySpaceId: Record<string, unknown>
      trackerRunLoadingBySpaceId: Record<string, unknown>
      trackerRunErrorBySpaceId: Record<string, unknown>
      trackerRunLoadedBySpaceId: Record<string, unknown>
    } = {
      sessionsBySpaceId: { 'removed-space': [] },
      currentSessionIdBySpaceId: { 'removed-space': null },
      draftSessionBySpaceId: { 'removed-space': false },
      messagesBySessionId: {},
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      trackerRunSessionsBySpaceId: { 'removed-space': [] },
      trackerRunCountBySpaceId: { 'removed-space': 0 },
      trackerRunLoadingBySpaceId: { 'removed-space': false },
      trackerRunErrorBySpaceId: { 'removed-space': null },
      trackerRunLoadedBySpaceId: { 'removed-space': true },
    }
    const set = (
      updater: Partial<typeof state> | ((current: typeof state) => Partial<typeof state>),
    ) => {
      Object.assign(state, typeof updater === 'function' ? updater(state) : updater)
    }
    const actions = createStoreLifecycleActions(() => state, set)

    actions.purgeOrganizationSpaces('org-removed', ['removed-space'])

    expect(state.sessionsBySpaceId).toEqual({})
    expect(state.currentSessionIdBySpaceId).toEqual({})
    expect(state.trackerRunLoadedBySpaceId).toEqual({})
  })
})
