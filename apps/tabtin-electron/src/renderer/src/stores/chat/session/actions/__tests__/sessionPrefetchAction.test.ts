import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPrewarmRuntime = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }))

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    tabtin: {
      agentEngine: {
        prewarmRuntime: (...args: unknown[]) => mockPrewarmRuntime(...args),
      },
    },
  },
})

const mockPrepareRuntimeDispatchContext = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const mockWarmupLlmConnection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockTrackChatTelemetry = vi.hoisted(() => vi.fn())
const mockGetCurrentModel = vi.hoisted(() => vi.fn(() => ({ id: 'model-current' })))
const mockEnsureGroupRuntimeSynced = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockResolveChatScopeHost = vi.hoisted(() => vi.fn(() => ({
  currentProjectId: null,
  space: { id: 'space-1', type: 'workspace' },
})))

vi.mock('../../../execution/runtimeDispatchPrep', () => ({
  prepareRuntimeDispatchContext: (...args: unknown[]) => mockPrepareRuntimeDispatchContext(...args),
}))

vi.mock('@/services/api', () => {
  const apiService = {
    warmupLlmConnection: (...args: unknown[]) => mockWarmupLlmConnection(...args),
    clearAuth: vi.fn(),
    setAuthToken: vi.fn(),
  }
  return { apiService, default: apiService }
})

vi.mock('../../../execution/chatTelemetry', () => ({
  trackChatTelemetry: (...args: unknown[]) => mockTrackChatTelemetry(...args),
}))

vi.mock('../../../../useChatModelStore', () => ({
  useChatModelStore: {
    getState: () => ({ getCurrentModel: mockGetCurrentModel }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedAgent: { id: 'agent-1', personal_rules: 'cached-rules' },
      spaces: [{ id: 'space-1', working_dir: '/tmp/ws', name: 'Space 1' }],
    }),
  },
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: { id: 'org-1', name: 'Org 1', settings: {} },
    }),
  },
}))

vi.mock('@stores/useMemoRecordStyleStore', () => ({
  useMemoRecordStyleStore: {
    getState: () => ({ isEnabled: () => false }),
  },
}))

vi.mock('../../../useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      agentMode: 'agent',
      approvalModeBySessionId: {},
    }),
  },
}))

vi.mock('../../resolveSendAgentPolicy', () => ({
  resolveSendAgentPolicy: () => ({
    currentAgentMode: 'agent',
    currentApprovalMode: 'always_ask',
    resolutionContext: { isGroupSpace: false, allowYolo: false, approvalGrant: 'always_ask' },
  }),
}))

vi.mock('../../../execution/captureEnabledAppsForSend', () => ({
  captureEnabledAppsForSend: () => [],
}))

vi.mock('../../../group/groupRuntimeSessionSync', () => ({
  ensureGroupRuntimeSynced: (...args: unknown[]) => mockEnsureGroupRuntimeSynced(...args),
}))

vi.mock('../../utils/chatSessionScope', () => ({
  resolveChatScopeHost: (...args: unknown[]) => mockResolveChatScopeHost(...args),
}))

import {
  __resetDraftMessageSessionCoordinatorForTests,
  beginDraftMessageSession,
  cancelDraftMessageSessionByScopeKey,
} from '../../draftMessageSessionCoordinator'
import {
  clearAllDraftPrefetchLatches,
  createSessionPrefetchAction,
  isDraftPrefetchDone,
  resetDraftPrefetchMessage,
  _resetDraftPrefetchLatchesForTests,
} from '../sessionPrefetchAction'

const SCOPE = 'conversation:draft:workspace-1'

describe('createSessionPrefetchAction（ 预建单槽）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetDraftPrefetchLatchesForTests()
    __resetDraftMessageSessionCoordinatorForTests()
    beginDraftMessageSession(SCOPE, { agentId: 'agent-1' })
  })

  const makeGet = (overrides?: {
    pointer?: string | null
    draft?: boolean
    /** 覆盖整个 draft 旗标桶（A≠B 时 host 有 draft、execution 无） */
    draftBySpaceId?: Record<string, boolean>
    sessions?: Array<{ id: string; message_count?: number }>
    messagesBySessionId?: Record<string, Array<{ id: string }>>
    spaceId?: string
    discardAbandonedEmptySessions?: ReturnType<typeof vi.fn>
  }) => {
    const spaceId = overrides?.spaceId ?? 'space-1'
    const discardAbandonedEmptySessions = overrides?.discardAbandonedEmptySessions
      ?? vi.fn()
    return vi.fn(() => ({
      currentSessionIdBySpaceId: { [spaceId]: overrides?.pointer ?? null },
      draftSessionBySpaceId: overrides?.draftBySpaceId
        ?? { [spaceId]: overrides?.draft ?? true },
      sessionsBySpaceId: { [spaceId]: overrides?.sessions ?? [] },
      messagesBySessionId: overrides?.messagesBySessionId ?? {},
      discardAbandonedEmptySessions,
    }))
  }

  const makeDeps = (ensure = vi.fn().mockResolvedValue({
    sessionId: 'sess-new',
    mode: 'quick_start' as const,
    contextFingerprint: 'fp',
  })) => ({
    ensureSessionForSpace: ensure,
    syncContext: vi.fn().mockResolvedValue(undefined),
  })

  it('无指针无空槽：ensure prefetch + retainDraft，并预热 runtime', async () => {
    const ensure = vi.fn().mockResolvedValue({
      sessionId: 'sess-new',
      mode: 'quick_start',
      contextFingerprint: 'fp',
    })
    const { prefetchSessionForDraft } = createSessionPrefetchAction(makeGet(), makeDeps(ensure))

    await prefetchSessionForDraft({
      spaceId: 'space-1',
      organizationId: 'org-1',
      tabScopeKey: SCOPE,
    })

    expect(ensure).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      undefined,
      expect.objectContaining({
        trigger: 'prefetch',
        preferQuickStart: true,
        retainDraftMessage: true,
      }),
    )
    expect(mockEnsureGroupRuntimeSynced).toHaveBeenCalledWith('sess-new')
    expect(mockPrepareRuntimeDispatchContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-new', spaceId: 'space-1' }),
    )
    expect(isDraftPrefetchDone('space-1')).toBe(true)
  })

  it('已有空槽：仍走 ensure（lifecycle 单槽 adopt），不重复堆行', async () => {
    const ensure = vi.fn().mockResolvedValue({
      sessionId: 'empty-1',
      mode: 'existing',
    })
    const { prefetchSessionForDraft } = createSessionPrefetchAction(
      makeGet({ sessions: [{ id: 'empty-1', message_count: 0 }] }),
      makeDeps(ensure),
    )
    await prefetchSessionForDraft({
      spaceId: 'space-1',
      organizationId: 'org-1',
      tabScopeKey: SCOPE,
    })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure.mock.calls[0][3]).toEqual(expect.objectContaining({
      trigger: 'prefetch',
      retainDraftMessage: true,
    }))
  })

  it('已有指针：只 bind + 暖机，不 ensure', async () => {
    const ensure = vi.fn()
    const { prefetchSessionForDraft } = createSessionPrefetchAction(
      makeGet({
        pointer: 'sess-existing',
        sessions: [{ id: 'sess-existing', message_count: 0 }],
      }),
      makeDeps(ensure),
    )
    await prefetchSessionForDraft({
      spaceId: 'space-1',
      organizationId: 'org-1',
      tabScopeKey: SCOPE,
    })
    expect(ensure).not.toHaveBeenCalled()
    expect(mockPrepareRuntimeDispatchContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-existing' }),
    )
    expect(isDraftPrefetchDone('space-1')).toBe(true)
  })

  it('同一 draft episode 只预建一次', async () => {
    const ensure = vi.fn().mockResolvedValue({
      sessionId: 'sess-new',
      mode: 'quick_start',
      contextFingerprint: 'fp',
    })
    const { prefetchSessionForDraft } = createSessionPrefetchAction(makeGet(), makeDeps(ensure))
    await prefetchSessionForDraft({ spaceId: 'space-1', organizationId: 'org-1', tabScopeKey: SCOPE })
    await prefetchSessionForDraft({ spaceId: 'space-1', organizationId: 'org-1', tabScopeKey: SCOPE })
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('resetDraftPrefetchMessage 后允许新 episode 再预建', async () => {
    const ensure = vi.fn().mockResolvedValue({
      sessionId: 'sess-new',
      mode: 'quick_start',
      contextFingerprint: 'fp',
    })
    const { prefetchSessionForDraft } = createSessionPrefetchAction(makeGet(), makeDeps(ensure))
    await prefetchSessionForDraft({ spaceId: 'space-1', organizationId: 'org-1', tabScopeKey: SCOPE })
    resetDraftPrefetchMessage('space-1')
    beginDraftMessageSession(SCOPE, { agentId: 'agent-1' })
    // 指针仍空且 latch 已清 → 再 ensure；单槽会复用空行由 lifecycle 负责
    await prefetchSessionForDraft({
      spaceId: 'space-1',
      organizationId: 'org-1',
      tabScopeKey: SCOPE,
    })
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('clearAllDraftPrefetchLatches 清全部闩锁', async () => {
    const ensure = vi.fn().mockResolvedValue({
      sessionId: 'sess-new',
      mode: 'quick_start',
      contextFingerprint: 'fp',
    })
    const { prefetchSessionForDraft } = createSessionPrefetchAction(makeGet(), makeDeps(ensure))
    await prefetchSessionForDraft({ spaceId: 'space-1', organizationId: 'org-1', tabScopeKey: SCOPE })
    clearAllDraftPrefetchLatches()
    expect(isDraftPrefetchDone('space-1')).toBe(false)
  })

  it('非 draft / 无 episode：不 ensure', async () => {
    const ensure = vi.fn()
    const { prefetchSessionForDraft: notDraft } = createSessionPrefetchAction(
      makeGet({ draft: false }),
      makeDeps(ensure),
    )
    await notDraft({ spaceId: 'space-1', organizationId: 'org-1', tabScopeKey: SCOPE })
    expect(ensure).not.toHaveBeenCalled()

    __resetDraftMessageSessionCoordinatorForTests()
    const { prefetchSessionForDraft } = createSessionPrefetchAction(makeGet(), makeDeps(ensure))
    await prefetchSessionForDraft({ spaceId: 'space-1', organizationId: 'org-1', tabScopeKey: SCOPE })
    expect(ensure).not.toHaveBeenCalled()
  })

  it('draftUiSpaceId=host、execution 无旗标：仍认 host draft 并预建', async () => {
    __resetDraftMessageSessionCoordinatorForTests()
    const hostScope = 'conversation:draft:project-a'
    beginDraftMessageSession(hostScope, { agentId: 'agent-1' })
    const ensure = vi.fn().mockResolvedValue({
      sessionId: 'sess-exec',
      mode: 'quick_start',
      contextFingerprint: 'fp',
    })
    const { prefetchSessionForDraft } = createSessionPrefetchAction(
      makeGet({
        spaceId: 'exec-b',
        draftBySpaceId: { 'project-a': true },
        sessions: [],
      }),
      makeDeps(ensure),
    )
    await prefetchSessionForDraft({
      spaceId: 'exec-b',
      draftUiSpaceId: 'project-a',
      organizationId: 'org-1',
      tabScopeKey: hostScope,
    })
    expect(ensure).toHaveBeenCalledWith(
      'exec-b',
      'org-1',
      undefined,
      expect.objectContaining({ trigger: 'prefetch', retainDraftMessage: true }),
    )
  })

  it('指针/空槽已有本地气泡：不算可复用，改为 ensure 新建', async () => {
    const ensure = vi.fn().mockResolvedValue({
      sessionId: 'sess-fresh',
      mode: 'quick_start',
      contextFingerprint: 'fp',
    })
    const { prefetchSessionForDraft } = createSessionPrefetchAction(
      makeGet({
        pointer: 'sess-stale',
        sessions: [{ id: 'sess-stale', message_count: 0 }],
        messagesBySessionId: {
          'sess-stale': [{ id: 'm1' }],
        },
      }),
      makeDeps(ensure),
    )
    await prefetchSessionForDraft({
      spaceId: 'space-1',
      organizationId: 'org-1',
      tabScopeKey: SCOPE,
    })
    // 不得 reuse_pointer / reuse_empty 命中已有气泡的 sess-stale
    expect(ensure).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      undefined,
      expect.objectContaining({ trigger: 'prefetch', retainDraftMessage: true }),
    )
    expect(mockPrepareRuntimeDispatchContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-fresh' }),
    )
  })

  it('#7898 预建回包时 episode 已取消：丢弃空会话', async () => {
    const discardAbandonedEmptySessions = vi.fn()
    let resolveEnsure: ((value: {
      sessionId: string
      mode: 'quick_start'
      contextFingerprint: string
    }) => void) | null = null
    const ensure = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveEnsure = resolve
    }))
    const { prefetchSessionForDraft } = createSessionPrefetchAction(
      makeGet({ discardAbandonedEmptySessions }),
      makeDeps(ensure),
    )

    const pending = prefetchSessionForDraft({
      spaceId: 'space-1',
      organizationId: 'org-1',
      tabScopeKey: SCOPE,
    })
    cancelDraftMessageSessionByScopeKey(SCOPE)
    resolveEnsure?.({
      sessionId: 'sess-stale',
      mode: 'quick_start',
      contextFingerprint: 'fp',
    })
    await pending

    expect(discardAbandonedEmptySessions).toHaveBeenCalledWith({
      sessionIds: ['sess-stale'],
      reason: 'prefetch_stale',
      sessionSpaceById: { 'sess-stale': 'space-1' },
    })
  })
})
