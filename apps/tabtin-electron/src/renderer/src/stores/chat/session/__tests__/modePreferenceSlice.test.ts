import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setSessionAgentMode: vi.fn(),
  writeAgentDefaultMode: vi.fn(),
  notifyModeSwitched: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
  resolutionSessionIds: [] as Array<string | null>,
  normalizeCalls: [] as Array<{ mode: string; isGroupSpace: boolean }>,
  runtimeState: {
    agentModeBySessionId: {} as Record<string, string>,
  },
  spaceState: {
    selectedAgent: { id: 'agent-1' } as { id: string } | null,
    selectedSpace: { id: 'space-1' } as { id: string } | null,
  },
}))

vi.mock('../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => mocks.runtimeState,
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => mocks.spaceState,
  },
}))

vi.mock('../agentModePreference', () => ({
  writeAgentDefaultMode: (...args: unknown[]) => mocks.writeAgentDefaultMode(...args),
}))

vi.mock('../sessionAgentMode', () => ({
  setSessionAgentMode: (...args: unknown[]) => mocks.setSessionAgentMode(...args),
}))

vi.mock('../sessionApprovalMode', () => ({
  setSessionApprovalMode: vi.fn(),
}))

vi.mock('../../group/groupRuntimeContext', () => ({
  getAgentModeResolutionContextForSession: (sessionId: string | null) => {
    mocks.resolutionSessionIds.push(sessionId)
    if (sessionId === 'sess-group-hidden') {
      return { allowYolo: false, isGroupSpace: true }
    }
    return { allowYolo: false, isGroupSpace: false }
  },
  normalizeAgentModeForContext: (
    mode: string,
    ctx: { isGroupSpace: boolean; allowYolo?: boolean },
  ) => {
    mocks.normalizeCalls.push({ mode, isGroupSpace: ctx.isGroupSpace })
    if (mode === 'yolo' && ctx.isGroupSpace) return 'group'
    if (mode === 'yolo' && !ctx.allowYolo) return 'agent'
    return mode
  },
}))

vi.mock('@/i18n', () => ({
  default: { t: (k: string) => k },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: (...args: unknown[]) => mocks.toast(...args),
}))

vi.mock('@/services/modeSwitchExecuteApi', () => ({
  notifyModeSwitched: (...args: unknown[]) => mocks.notifyModeSwitched(...args),
}))

import {
  bindModePreferenceSessionModeApplier,
  createModePreferenceActions,
  type ModePreferenceSliceStore,
} from '../slices/modePreferenceSlice'
import {
  getDraftMessageByScopeKey,
} from '../draftMessage'
import {
  __resetDraftMessageSessionCoordinatorForTests,
  setDraftSessionModeApplier,
} from '../draftMessageSessionCoordinator'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { resolveEffectiveAgentMode } from '../../shared/types'

describe('modePreferenceSlice.setAgentMode ', () => {
  beforeEach(() => {
    __resetDraftMessageSessionCoordinatorForTests()
    mocks.setSessionAgentMode.mockReset().mockImplementation((sessionId: string, mode: string) => {
      mocks.runtimeState.agentModeBySessionId[sessionId] = mode
    })
    bindModePreferenceSessionModeApplier((...args) => mocks.setSessionAgentMode(...args))
    setDraftSessionModeApplier((...args) => mocks.setSessionAgentMode(...args))
    mocks.writeAgentDefaultMode.mockReset()
    mocks.notifyModeSwitched.mockClear()
    mocks.toast.mockClear()
    mocks.resolutionSessionIds = []
    mocks.normalizeCalls = []
    mocks.runtimeState.agentModeBySessionId = { 'sess-hidden': 'agent' }
    mocks.spaceState.selectedSpace = { id: 'space-1' }
  })

  it('prefetch 已写旧 mode 且 currentSessionId=null 时，草稿切 plan 写入隐藏 session', () => {
    const store = {
      currentSessionId: null as string | null,
      draftSessionBySpaceId: { 'space-1': true },
      currentSessionIdBySpaceId: { 'space-1': 'sess-hidden' } as Record<string, string | null>,
      agentMode: 'agent' as const,
      setAgentMode: (() => {}) as ModePreferenceSliceStore['setAgentMode'],
      approvalMode: 'always_ask' as const,
      approvalModeBySessionId: {},
      setApprovalMode: () => {},
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
    } satisfies ModePreferenceSliceStore
    const actions = createModePreferenceActions(
      () => store,
      (partial) => Object.assign(store, partial),
    )
    store.setAgentMode = actions.setAgentMode

    actions.setAgentMode('plan', {
      draftScopeKey: 'conversation:draft:workspace-1',
      legacyExecutionHostId: 'space-1',
    })

    expect(store.agentMode).toBe('plan')
    expect(getDraftMessageByScopeKey('conversation:draft:workspace-1')?.mode).toBe('plan')
    expect(mocks.setSessionAgentMode).toHaveBeenCalledWith('sess-hidden', 'plan')
    expect(mocks.runtimeState.agentModeBySessionId['sess-hidden']).toBe('plan')
    expect(mocks.toast).not.toHaveBeenCalled()

    const effective = resolveEffectiveAgentMode(
      'sess-hidden',
      useChatRuntimeStore.getState().agentModeBySessionId,
      store.agentMode,
    )
    expect(effective).toBe('plan')
  })

  it('隐藏 group session：先解析 targetSessionId，再按目标上下文 normalize yolo→group', () => {
    mocks.runtimeState.agentModeBySessionId = { 'sess-group-hidden': 'agent' }
    const store = {
      currentSessionId: null as string | null,
      draftSessionBySpaceId: { 'space-1': true },
      currentSessionIdBySpaceId: { 'space-1': 'sess-group-hidden' } as Record<string, string | null>,
      agentMode: 'agent' as const,
      setAgentMode: (() => {}) as ModePreferenceSliceStore['setAgentMode'],
      approvalMode: 'always_ask' as const,
      approvalModeBySessionId: {},
      setApprovalMode: () => {},
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
    } satisfies ModePreferenceSliceStore
    const actions = createModePreferenceActions(
      () => store,
      (partial) => Object.assign(store, partial),
    )
    store.setAgentMode = actions.setAgentMode

    actions.setAgentMode('yolo', {
      draftScopeKey: 'conversation:draft:workspace-1',
      legacyExecutionHostId: 'space-1',
    })

    expect(mocks.resolutionSessionIds).toContain('sess-group-hidden')
    expect(mocks.normalizeCalls.some(
      (c) => c.mode === 'yolo' && c.isGroupSpace === true,
    )).toBe(true)
    expect(store.agentMode).toBe('group')
    expect(getDraftMessageByScopeKey('conversation:draft:workspace-1')?.mode).toBe('group')
    expect(mocks.setSessionAgentMode).toHaveBeenCalledWith('sess-group-hidden', 'group')
  })

  it('禁止从 selectedSpace 重建领域主键：无 draftScopeKey 时不写 episode', () => {
    const store = {
      currentSessionId: null as string | null,
      draftSessionBySpaceId: { 'space-1': true },
      currentSessionIdBySpaceId: { 'space-1': 'sess-hidden' } as Record<string, string | null>,
      agentMode: 'agent' as const,
      setAgentMode: (() => {}) as ModePreferenceSliceStore['setAgentMode'],
      approvalMode: 'always_ask' as const,
      approvalModeBySessionId: {},
      setApprovalMode: () => {},
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
    } satisfies ModePreferenceSliceStore
    const actions = createModePreferenceActions(
      () => store,
      (partial) => Object.assign(store, partial),
    )
    actions.setAgentMode('plan')
    expect(store.agentMode).toBe('plan')
    expect(getDraftMessageByScopeKey('conversation:draft:space-1')).toBeUndefined()
    expect(getDraftMessageByScopeKey('conversation:draft:workspace-1')).toBeUndefined()
  })

  it('#7636：显式 sessionId 优先于 currentSessionId 写入 runtime map', () => {
    mocks.setSessionAgentMode.mockClear()
    mocks.runtimeState.agentModeBySessionId = {
      'sess-current': 'plan',
      'sess-card': 'plan',
    }
    const store = {
      currentSessionId: 'sess-current' as string | null,
      draftSessionBySpaceId: {},
      currentSessionIdBySpaceId: {},
      agentMode: 'plan' as const,
      setAgentMode: (() => {}) as ModePreferenceSliceStore['setAgentMode'],
      approvalMode: 'always_ask' as const,
      approvalModeBySessionId: {},
      setApprovalMode: () => {},
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
    } satisfies ModePreferenceSliceStore
    const actions = createModePreferenceActions(
      () => store,
      (partial) => Object.assign(store, partial),
    )

    actions.setAgentMode('agent', { sessionId: 'sess-card' })

    // ModeSwitch 卡片必须按卡片 session 落库；勿写到 currentSessionId。
    expect(mocks.setSessionAgentMode).toHaveBeenCalledWith('sess-card', 'agent')
    expect(mocks.setSessionAgentMode).not.toHaveBeenCalledWith('sess-current', 'agent')
    expect(mocks.runtimeState.agentModeBySessionId['sess-card']).toBe('agent')
    expect(mocks.runtimeState.agentModeBySessionId['sess-current']).toBe('plan')
  })
})
