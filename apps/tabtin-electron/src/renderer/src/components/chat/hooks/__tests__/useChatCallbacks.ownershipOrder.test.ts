/**
 * ：ownership 必须先于 bootstrap mutation —— 真实 foreign owner + call-order。
 * 不 mock bindDraftSessionToMessage；用真实 draftMessage 构造占用。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatCallbacks } from '../useChatCallbacks'
import {
  __resetDraftMessageSessionCoordinatorForTests,
  beginDraftMessageSession,
} from '@/stores/chat/session/draftMessageSessionCoordinator'
import * as pendingFirstSend from '@/stores/chat/session/actions/pendingFirstSend'

const callOrder: string[] = []

const mocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  startDraftSessionForSpace: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  forkSession: vi.fn(),
  waitForInFlightSessionCreate: vi.fn(),
  ensureSessionForSpace: vi.fn(),
  sendMessage: vi.fn(),
  abortStreamFromComposer: vi.fn(),
  syncContext: vi.fn(),
  switchModel: vi.fn(),
  switchContextTier: vi.fn(),
  togglePinSession: vi.fn(),
  setPendingModelId: vi.fn(),
}))

const chatState = vi.hoisted(() => ({
  currentSessionId: null as string | null,
  currentSessionIdBySpaceId: {} as Record<string, string | null>,
  draftSessionBySpaceId: {} as Record<string, boolean>,
  messagesBySessionId: {} as Record<string, Array<{ id: string; role: string; sendStatus?: string }>>,
  sessions: [] as Array<{ id: string }>,
  sessionsBySpaceId: {} as Record<string, Array<{ id: string }>>,
  getSessionById: () => undefined,
  updateSessionInCaches: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      rehomeScopeTabs: vi.fn(),
    }),
  },
}))

vi.mock('@/stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({
      getTaskViewMode: () => 'app-focus',
      setTaskViewModeForScope: vi.fn(),
      clearTaskViewModeForScope: vi.fn(),
    }),
  },
}))

vi.mock('@/stores/useChatModelStore', () => ({
  useChatModelStore: (selector: (state: { availableModels: Array<{ id: string }> }) => unknown) =>
    selector({ availableModels: [{ id: 'cbc75d0e-1111-4222-8333-444444444441' }] }),
}))

vi.mock('@/stores/useChatSplitStore', () => {
  const state = { pinnedSessionsBySpace: {} }
  const useChatSplitStore = Object.assign(
    (selector: (input: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useChatSplitStore }
})

vi.mock('@/stores/useSpaceListStore', () => ({
  useSpaceListStore: (selector: (state: { selectSpaceBySpaceId: () => void }) => unknown) =>
    selector({ selectSpaceBySpaceId: vi.fn() }),
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: { getState: () => ({ selectedAgent: null }) },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => chatState,
    setState: (
      partial:
        | Partial<typeof chatState>
        | ((state: typeof chatState) => Partial<typeof chatState>),
    ) => {
      callOrder.push('setState/commit')
      const next = typeof partial === 'function' ? partial(chatState) : partial
      Object.assign(chatState, next)
    },
  },
}))

vi.mock('@/stores/chat/session/actions/sessionLifecycleAction', () => ({
  waitForInFlightSessionCreate: mocks.waitForInFlightSessionCreate,
}))

vi.mock('@/stores/chat/session/slices/contextSyncSlice', () => ({
  getLastAppContext: vi.fn(),
}))

vi.mock('@/stores/chat/messages/actions/failedMessageEditResend', () => ({
  takeFailedMessageEditResend: () => undefined,
}))

function installPendingSpies() {
  const realAllocate = pendingFirstSend.allocatePendingFirstSendTarget
  const realCommit = pendingFirstSend.commitPendingFirstSendState
  vi.spyOn(pendingFirstSend, 'allocatePendingFirstSendTarget').mockImplementation((state, input) => {
    callOrder.push('allocate')
    return realAllocate(state, input)
  })
  vi.spyOn(pendingFirstSend, 'commitPendingFirstSendState').mockImplementation((state, input) => {
    callOrder.push('commit')
    return realCommit(state, input)
  })
}

function renderOwnershipCallbacks(tabScopeKey: string) {
  return renderHook(() => useChatCallbacks({
    selectedSpaceId: 'exec-ws-b',
    resolvedOrganizationId: 'organization-1',
    currentSessionId: null,
    selectedSpace: {
      id: 'exec-ws-b',
      name: 'Exec B',
      organization_id: 'organization-1',
    },
    tabScopeKey,
    effectiveGraphType: 'chat',
    activeContextType: null,
    activeAppMeta: null,
    openTabs: null,
    pendingModelId: null,
    setPendingModelId: mocks.setPendingModelId,
    selectSession: mocks.selectSession,
    startDraftSessionForSpace: mocks.startDraftSessionForSpace,
    deleteSession: mocks.deleteSession,
    renameSession: mocks.renameSession,
    forkSession: mocks.forkSession,
    ensureSessionForSpace: mocks.ensureSessionForSpace,
    sendMessage: mocks.sendMessage,
    abortStreamFromComposer: mocks.abortStreamFromComposer,
    syncContext: mocks.syncContext,
    switchModel: mocks.switchModel,
    switchContextTier: mocks.switchContextTier,
    togglePinSession: mocks.togglePinSession,
  }))
}

describe('useChatCallbacks ownership call-order（真实 foreign owner）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    callOrder.length = 0
    __resetDraftMessageSessionCoordinatorForTests()
    mocks.waitForInFlightSessionCreate.mockResolvedValue(undefined)
    mocks.ensureSessionForSpace.mockImplementation(async () => {
      callOrder.push('ensure')
      return { sessionId: 'sess-new', mode: 'created' as const, contextFingerprint: null }
    })
    mocks.sendMessage.mockImplementation(async () => {
      callOrder.push('send')
    })
    mocks.syncContext.mockResolvedValue(undefined)
    chatState.currentSessionId = null
    chatState.currentSessionIdBySpaceId = { 'exec-ws-b': 'sess-foreign' }
    chatState.draftSessionBySpaceId = { 'exec-ws-b': true }
    chatState.messagesBySessionId = {}
    chatState.sessions = []
    chatState.sessionsBySpaceId = {}
  })

  it('existing target 被 foreign open episode 占用：reclaim 空壳后继续发送', async () => {
    const scopeForeign = 'conversation:draft:foreign-owner'
    const scopeMine = 'conversation:draft:project-a'
    const epForeign = beginDraftMessageSession(scopeForeign, { organizationId: 'organization-1' })
    bindDraftSessionToMessage(scopeForeign, 'sess-foreign', {
      draftMessageId: epForeign.draftMessageId,
      phase: 'open',
    })
    expect(getDraftSessionBySessionId('sess-foreign')?.draftScopeKey).toBe(scopeForeign)
    beginDraftMessageSession(scopeMine, { organizationId: 'organization-1' })
    chatState.sessionsBySpaceId = {
      'exec-ws-b': [{ id: 'sess-foreign', message_count: 0, status: 'active' }],
    }
    installPendingSpies()

    const { result } = renderOwnershipCallbacks(scopeMine)

    await act(async () => {
      await result.current.handleSendMessage('should reclaim')
    })

    // 已有真 session id，无需再 ensure
    expect(callOrder).toEqual([
      'allocate',
      'setState/commit',
      'commit',
      'send',
    ])
    expect(mocks.sendMessage).toHaveBeenCalled()
    expect(getDraftSessionBySessionId('sess-foreign')?.draftScopeKey).toBe(scopeMine)
  })

  it('existing target 被 foreign sending episode 占用：仍 fail-closed', async () => {
    const scopeForeign = 'conversation:draft:foreign-owner'
    const scopeMine = 'conversation:draft:project-a'
    const epForeign = beginDraftMessageSession(scopeForeign, { organizationId: 'organization-1' })
    bindDraftSessionToMessage(scopeForeign, 'sess-foreign', {
      draftMessageId: epForeign.draftMessageId,
      phase: 'sending',
    })
    beginDraftMessageSession(scopeMine, { organizationId: 'organization-1' })
    chatState.sessionsBySpaceId = {
      'exec-ws-b': [{ id: 'sess-foreign', message_count: 0, status: 'active' }],
    }
    installPendingSpies()

    const { result } = renderOwnershipCallbacks(scopeMine)

    await act(async () => {
      await result.current.handleSendMessage('should fail-closed')
    })

    expect(callOrder).toEqual(['allocate'])
    expect(mocks.ensureSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(getDraftSessionBySessionId('sess-foreign')?.draftScopeKey).toBe(scopeForeign)
  })

  it('bind 成功路径：allocate → commit → ensure → send', async () => {
    chatState.currentSessionIdBySpaceId = { 'exec-ws-b': null }
    chatState.sessionsBySpaceId = { 'exec-ws-b': [] }
    const scopeMine = 'conversation:draft:project-a'
    beginDraftMessageSession(scopeMine, { organizationId: 'organization-1' })
    installPendingSpies()

    const { result } = renderOwnershipCallbacks(scopeMine)

    await act(async () => {
      await result.current.handleSendMessage('ok path')
    })

    // 无指针时先 ensure 出真 id，再 allocate/commit/send
    expect(callOrder).toEqual([
      'ensure',
      'allocate',
      'setState/commit',
      'commit',
      'send',
    ])
    expect(mocks.sendMessage).toHaveBeenCalled()
  })
})
