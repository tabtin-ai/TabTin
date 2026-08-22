import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatCallbacks } from '../useChatCallbacks'

const mocks = vi.hoisted(() => ({
  selectSpaceBySpaceId: vi.fn(),
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
  setModelParamOverride: vi.fn(),
  togglePinSession: vi.fn(),
  setPendingModelId: vi.fn(),
  setPendingModelParamOverride: vi.fn(),
  replacePendingModelParamOverrides: vi.fn(),
  rehomeRuntime: vi.fn(),
  rehomeScopeTabs: vi.fn(),
  getTaskViewMode: vi.fn(() => 'app-focus'),
  setTaskViewModeForScope: vi.fn(),
  clearTaskViewModeForScope: vi.fn(),
  getLastAppContext: vi.fn(),
  beginDraftMessage: vi.fn((draftScopeKey: string) => ({
    draftMessageId: `ep-${draftScopeKey}`,
    draftScopeKey,
    phase: 'open' as const,
  })),
  bindDraftSessionToMessage: vi.fn((): { draftMessageId: string } | null => ({ draftMessageId: 'ep-bound' })),
  getDraftMessageByScopeKey: vi.fn(),
  findBoundLocalPendingForDraftMessage: vi.fn(() => null),
  getDraftSessionBySessionId: vi.fn(() => undefined),
  isDraftMessageActive: vi.fn(() => true),
  resolveConversationDraftScopeKey: vi.fn((input: {
    tabScopeKey?: string | null
    stableDraftScopeKey?: string | null
    legacyExecutionHostId?: string | null
  }) => {
    if (input.stableDraftScopeKey?.startsWith('conversation:draft:')) {
      return input.stableDraftScopeKey
    }
    if (input.stableDraftScopeKey != null && String(input.stableDraftScopeKey).trim() !== '') {
      return null
    }
    if (input.tabScopeKey?.startsWith('conversation:draft:')) {
      return input.tabScopeKey
    }
    return input.legacyExecutionHostId
      ? `conversation:draft:${input.legacyExecutionHostId}`
      : null
  }),
  buildDraftMessageMetadataFromLegacy: vi.fn((m: unknown) => m),
  syncDraftModelIntent: vi.fn((_modelId: string, ctx: { hiddenSessionId?: string | null }) => (
    ctx.hiddenSessionId ?? null
  )),
  peekDraftModelParamOverrides: vi.fn(() => null),
  peekDraftModelIntent: vi.fn(() => null),
  setChatState: vi.fn(),
  setPreferredModel: vi.fn(),
  writeRuntimeModelPreference: vi.fn(),
  writeRuntimeModelParamPreference: vi.fn(),
  readRuntimeModelPreference: vi.fn(() => null),
  createRuntimeModelAvailabilityChecker: vi.fn((
    catalogHas: (modelId: string) => boolean,
  ) => (modelId: string) => catalogHas(modelId) || modelId.startsWith('gpt-')),
  resolveRuntimeDefaultModelId: vi.fn((options: {
    pendingModelId?: string | null
    stickyModelId?: string | null
    preferredModelId?: string | null
    isAvailable: (modelId: string) => boolean
  }) => {
    for (const candidate of [
      options.pendingModelId,
      options.stickyModelId,
      options.preferredModelId,
    ]) {
      const trimmed = (candidate || '').trim()
      if (trimmed && options.isAvailable(trimmed)) return trimmed
    }
    return undefined
  }),
  resolveLocalRuntimeAlignTarget: vi.fn((options: {
    pendingModelId?: string | null
    stickyModelId?: string | null
    catalogHas: (modelId: string) => boolean
  }) => {
    for (const candidate of [options.pendingModelId, options.stickyModelId]) {
      const trimmed = (candidate || '').trim()
      if (!trimmed) continue
      if (options.catalogHas(trimmed) || trimmed.startsWith('gpt-')) return trimmed
    }
    return undefined
  }),
  toProvisionModelId: vi.fn((
    runtimeModelId: string | undefined,
    options?: {
      preferredModelId?: string | null
      isAvailable?: (modelId: string) => boolean
    },
  ) => {
    if (runtimeModelId && !runtimeModelId.startsWith('gpt-')) return runtimeModelId
    const preferred = (options?.preferredModelId || '').trim()
    if (preferred && !preferred.startsWith('gpt-') && (!options?.isAvailable || options.isAvailable(preferred))) {
      return preferred
    }
    return undefined
  }),
}))

const spaceStoreState = vi.hoisted(() => ({
  selectedAgent: { id: 'agent-1', name: '小Tin' } as { id: string; name: string } | null,
  setPreferredModel: mocks.setPreferredModel,
}))

const chatState = vi.hoisted(() => ({
  currentSessionId: 'session-current' as string | null,
  currentSessionIdBySpaceId: {} as Record<string, string | null>,
  draftSessionBySpaceId: {} as Record<string, boolean>,
  messagesBySessionId: {} as Record<string, Array<{ id: string; role: string; sendStatus?: string }>>,
  sessions: [] as Array<{ id: string; current_model_id?: string | null; agent_id?: string | null }>,
  sessionsBySpaceId: {} as Record<string, Array<{ id: string; current_model_id?: string | null; agent_id?: string | null }>>,
  getSessionById: (sessionId: string) => (
    chatState.sessions.find(s => s.id === sessionId)
      ?? Object.values(chatState.sessionsBySpaceId).flat().find(s => s.id === sessionId)
  ),
  updateSessionInCaches: vi.fn(),
  registerComposerDraftKeyForSend: vi.fn(),
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
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      rehomeScopeTabs: mocks.rehomeScopeTabs,
    }),
  },
}))

vi.mock('@/stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({
      getTaskViewMode: mocks.getTaskViewMode,
      setTaskViewModeForScope: mocks.setTaskViewModeForScope,
      clearTaskViewModeForScope: mocks.clearTaskViewModeForScope,
      taskViewModeByScopeKey: {},
    }),
  },
}))

vi.mock('@/services/rehomeConversationScopeLayout', () => ({
  rehomeConversationScopeLayout: (fromKey: string, toKey: string) => {
    mocks.setTaskViewModeForScope(toKey, mocks.getTaskViewMode(fromKey))
  },
  rehomeConversationScopeLayoutAfterProvision: vi.fn(),
}))

vi.mock('@/services/rehomeConversationScopeRuntime', () => ({
  rehomeConversationScopeRuntime: mocks.rehomeRuntime,
}))

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      appFocusChatOverlayOpenByScopeKey: {},
      setAppFocusChatOverlayOpen: vi.fn(),
    }),
  },
}))

vi.mock('@/stores/useChatModelStore', () => {
  const state = {
    availableModels: [
      { id: 'cbc75d0e-1111-4222-8333-444444444441' },
      { id: 'cbc75d0e-1111-4222-8333-444444444442' },
      { id: 'cbc75d0e-1111-4222-8333-444444444443' },
      { id: 'gpt-5.6-sol' },
      { id: '42ae58c8-feea-4098-b80b-9a0aedc35007' },
    ],
    getCurrentModel: () => ({ id: 'cbc75d0e-1111-4222-8333-444444444441' }),
  }
  const useChatModelStore = Object.assign(
    (selector: (input: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useChatModelStore }
})

vi.mock('@/stores/useChatSplitStore', () => {
  const state = {
    pinnedSessionsBySpace: {},
  }
  const useChatSplitStore = Object.assign(
    (selector: (input: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useChatSplitStore }
})

vi.mock('@/stores/useSpaceListStore', () => ({
  useSpaceListStore: (selector: (state: { selectSpaceBySpaceId: typeof mocks.selectSpaceBySpaceId }) => unknown) =>
    selector({ selectSpaceBySpaceId: mocks.selectSpaceBySpaceId }),
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceStoreState,
  },
}))

vi.mock('@/stores/chat/session/runtimeModelPreference', () => ({
  writeRuntimeModelPreference: mocks.writeRuntimeModelPreference,
  writeRuntimeModelParamPreference: mocks.writeRuntimeModelParamPreference,
  readRuntimeModelPreference: mocks.readRuntimeModelPreference,
  createRuntimeModelAvailabilityChecker: mocks.createRuntimeModelAvailabilityChecker,
  resolveRuntimeDefaultModelId: mocks.resolveRuntimeDefaultModelId,
  resolveLocalRuntimeAlignTarget: mocks.resolveLocalRuntimeAlignTarget,
  toProvisionModelId: mocks.toProvisionModelId,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => chatState,
    setState: (
      partial:
        | Partial<typeof chatState>
        | ((state: typeof chatState) => Partial<typeof chatState>),
    ) => {
      mocks.setChatState()
      const next = typeof partial === 'function' ? partial(chatState) : partial
      Object.assign(chatState, next)
    },
  },
}))

vi.mock('@/stores/chat/session/actions/sessionLifecycleAction', () => ({
  waitForInFlightSessionCreate: mocks.waitForInFlightSessionCreate,
}))

vi.mock('@/stores/chat/session/slices/contextSyncSlice', () => ({
  getLastAppContext: mocks.getLastAppContext,
}))

vi.mock('@/stores/chat/session/draftMessage', () => ({
  beginDraftMessage: mocks.beginDraftMessage,
  bindDraftSessionToMessage: mocks.bindDraftSessionToMessage,
  getDraftMessageByScopeKey: mocks.getDraftMessageByScopeKey,
  findBoundLocalPendingForDraftMessage: mocks.findBoundLocalPendingForDraftMessage,
  getDraftSessionBySessionId: mocks.getDraftSessionBySessionId,
  isDraftMessageActive: mocks.isDraftMessageActive,
  syncDraftModelIntent: mocks.syncDraftModelIntent,
  peekDraftModelParamOverrides: mocks.peekDraftModelParamOverrides,
  peekDraftModelIntent: mocks.peekDraftModelIntent,
}))

vi.mock('@/stores/chat/session/draftMessageLegacyAdapter', () => ({
  resolveConversationDraftScopeKey: mocks.resolveConversationDraftScopeKey,
  buildDraftMessageMetadataFromLegacy: mocks.buildDraftMessageMetadataFromLegacy,
  buildDraftMessageSessionContext: ({
    draftScopeKey,
    legacyExecutionHostId,
    pointers,
  }: {
    draftScopeKey: string
    legacyExecutionHostId?: string | null
    pointers?: {
      draftSessionBySpaceId: Record<string, boolean>
      currentSessionIdBySpaceId: Record<string, string | null>
    }
  }) => {
    const host = legacyExecutionHostId ?? null
    const isUiDraft = !!(host && pointers?.draftSessionBySpaceId?.[host])
    const hiddenSessionId = isUiDraft
      ? (pointers?.currentSessionIdBySpaceId?.[host!] ?? null)
      : null
    return { draftScopeKey, isUiDraft, hiddenSessionId }
  },
}))

vi.mock('@/stores/chat/messages/actions/failedMessageEditResend', () => ({
  takeFailedMessageEditResend: () => undefined,
}))

function renderCallbacks(overrides: Partial<Parameters<typeof useChatCallbacks>[0]> = {}) {
  return renderHook(() => useChatCallbacks({
    selectedSpaceId: 'space-a',
    resolvedOrganizationId: 'organization-1',
    currentSessionId: 'session-a',
    selectedSpace: { id: 'space-a', name: 'Agent A', organization_id: 'organization-1' },
    tabScopeKey: 'conversation:session-a',
    resolveSessionSpaceId: (sessionId) => sessionId === 'session-b' ? 'space-b' : 'space-a',
    effectiveGraphType: 'chat',
    activeContextType: null,
    activeAppMeta: null,
    openTabs: null,
    pendingModelId: null,
    setPendingModelId: mocks.setPendingModelId,
    setPendingModelParamOverride: mocks.setPendingModelParamOverride,
    replacePendingModelParamOverrides: mocks.replacePendingModelParamOverrides,
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
    setModelParamOverride: mocks.setModelParamOverride,
    togglePinSession: mocks.togglePinSession,
    ...overrides,
  }))
}

describe('useChatCallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectSession.mockResolvedValue(undefined)
    mocks.deleteSession.mockResolvedValue(undefined)
    mocks.forkSession.mockResolvedValue(undefined)
    mocks.waitForInFlightSessionCreate.mockResolvedValue(undefined)
    mocks.ensureSessionForSpace.mockImplementation(async (spaceId: string) => {
      const fromSpace = chatState.currentSessionIdBySpaceId[spaceId]
      if (fromSpace) {
        // 模拟 apply：把 pending 消息迁到真 session
        const pendingId = chatState.currentSessionId
        if (typeof pendingId === 'string' && pendingId.startsWith('local-pending-')) {
          const pendingMsgs = chatState.messagesBySessionId[pendingId] ?? []
          chatState.messagesBySessionId = {
            ...chatState.messagesBySessionId,
            [fromSpace]: pendingMsgs,
          }
          delete chatState.messagesBySessionId[pendingId]
          chatState.currentSessionId = fromSpace
        }
        return {
          sessionId: fromSpace,
          mode: 'existing' as const,
          contextFingerprint: null,
        }
      }
      const createdId = 'session-created'
      const pendingId = chatState.currentSessionId
      if (typeof pendingId === 'string' && pendingId.startsWith('local-pending-')) {
        const pendingMsgs = chatState.messagesBySessionId[pendingId] ?? []
        chatState.messagesBySessionId = {
          ...chatState.messagesBySessionId,
          [createdId]: pendingMsgs,
        }
        delete chatState.messagesBySessionId[pendingId]
      }
      chatState.currentSessionId = createdId
      chatState.currentSessionIdBySpaceId = {
        ...chatState.currentSessionIdBySpaceId,
        [spaceId]: createdId,
      }
      return {
        sessionId: createdId,
        mode: 'created' as const,
        contextFingerprint: null,
      }
    })
    mocks.sendMessage.mockResolvedValue(undefined)
    mocks.syncContext.mockResolvedValue(undefined)
    mocks.switchModel.mockResolvedValue(undefined)
    mocks.readRuntimeModelPreference.mockReturnValue(null)
    mocks.peekDraftModelIntent.mockReturnValue(null)
    mocks.resolveLocalRuntimeAlignTarget.mockImplementation((options: {
      pendingModelId?: string | null
      stickyModelId?: string | null
      catalogHas: (modelId: string) => boolean
    }) => {
      for (const candidate of [options.pendingModelId, options.stickyModelId]) {
        const trimmed = (candidate || '').trim()
        if (!trimmed) continue
        if (options.catalogHas(trimmed) || trimmed.startsWith('gpt-')) return trimmed
      }
      return undefined
    })
    mocks.beginDraftMessage.mockReset().mockImplementation((draftScopeKey: string) => ({
      draftMessageId: `ep-${draftScopeKey}`,
      draftScopeKey,
      phase: 'open' as const,
    }))
    mocks.bindDraftSessionToMessage.mockReset().mockReturnValue({ draftMessageId: 'ep-bound' })
    mocks.getDraftMessageByScopeKey.mockReset().mockReturnValue(undefined)
    mocks.findBoundLocalPendingForDraftMessage.mockReset().mockReturnValue(null)
    mocks.getDraftSessionBySessionId.mockReset().mockReturnValue(undefined)
    mocks.isDraftMessageActive.mockReset().mockReturnValue(true)
    mocks.resolveConversationDraftScopeKey.mockClear()
    mocks.buildDraftMessageMetadataFromLegacy.mockClear()
    chatState.currentSessionId = 'session-current'
    chatState.currentSessionIdBySpaceId = {}
    chatState.draftSessionBySpaceId = {}
    chatState.messagesBySessionId = {}
    chatState.sessions = []
    chatState.sessionsBySpaceId = {}
  })

  it('switches the global Space before selecting a cross-Space session tab', async () => {
    const { result } = renderCallbacks()

    await act(async () => {
      await result.current.handleTabClick('session-b')
    })

    expect(mocks.selectSpaceBySpaceId).toHaveBeenCalledWith('space-b')
    expect(mocks.selectSession).toHaveBeenCalledWith(
      'space-b',
      'session-b',
      expect.objectContaining({
        organizationId: 'organization-1',
      }),
    )
  })

  it('does not switch Space for a session in the current Space', async () => {
    const { result } = renderCallbacks()

    await act(async () => {
      await result.current.handleTabClick('session-c')
    })

    expect(mocks.selectSpaceBySpaceId).not.toHaveBeenCalled()
    expect(mocks.selectSession).toHaveBeenCalledWith(
      'space-a',
      'session-c',
      expect.objectContaining({
        organizationId: 'organization-1',
      }),
    )
  })

  it('关历史 Tab 不切 Space，避免跨 Space 空会话归档后 quick-start 回弹', async () => {
    const { result } = renderCallbacks()

    await act(async () => {
      await result.current.handleDeleteSession('session-b')
    })

    expect(mocks.selectSpaceBySpaceId).not.toHaveBeenCalled()
    expect(mocks.deleteSession).toHaveBeenCalledWith('space-b', 'session-b')
  })

  it('发送前 syncContext 使用真实视觉 Focus，不再保留陈旧 project_task（R2-1 / #7）', async () => {
    mocks.getLastAppContext.mockReturnValue({
      appType: 'project_task',
      appMeta: { project_id: 'proj-1', task_id: 'task-1' },
    })
    // ：发送读 store 快照，不能只改 hook 闭包 currentSessionId
    chatState.currentSessionId = 'session-a'
    chatState.currentSessionIdBySpaceId = { 'space-a': 'session-a' }
    const { result } = renderCallbacks({
      currentSessionId: 'session-a',
      tabScopeKey: 'conversation:session-a',
      activeContextType: 'chat',
      activeAppMeta: null,
      openTabs: [],
    })

    await act(async () => {
      await result.current.handleSendMessage('追问一句')
    })

    expect(mocks.syncContext).toHaveBeenCalledWith('space-a', 'chat', null, [], {
      force: false,
      deferHttpPersist: true,
      tabScopeKey: 'conversation:session-a',
      workspaceScopeKey: 'conversation:session-a',
    })
    expect(mocks.syncContext).not.toHaveBeenCalledWith(
      'space-a',
      'project_task',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('受控侧栏发送使用可见会话，不误投到全局会话', async () => {
    chatState.currentSessionId = 'global-session'
    chatState.currentSessionIdBySpaceId = { 'space-a': 'global-session' }
    const { result } = renderCallbacks({
      currentSessionId: 'shared-session',
      controlledSessionId: 'shared-session',
      tabScopeKey: 'im:conversation-1',
    })

    await act(async () => {
      await result.current.handleSendMessage('测试用例')
    })

    expect(mocks.ensureSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '测试用例',
      true,
      undefined,
      undefined,
      'shared-session',
      expect.objectContaining({
        spaceId: 'space-a',
        tabScopeKey: 'im:conversation-1',
      }),
    )
  })

  it('发送时按实际 sessionId 重算 conversation tab scope，而不是沿用 draft/旧 scope', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    const { result } = renderCallbacks({
      currentSessionId: null,
      tabScopeKey: 'conversation:draft:space-a',
    })

    await act(async () => {
      await result.current.handleSendMessage('打开百度')
    })

    expect(mocks.syncContext).toHaveBeenCalledWith('space-a', null, null, null, {
      force: false,
      deferHttpPersist: true,
      tabScopeKey: 'conversation:session-created',
      workspaceScopeKey: 'conversation:session-created',
    })
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '打开百度',
      true,
      undefined,
      undefined,
      'session-created',
      expect.objectContaining({
        spaceId: 'space-a',
        tabScopeKey: 'conversation:session-created',
        existingClientMessageId: expect.any(String),
        sendTimingTrace: expect.objectContaining({
          traceId: expect.stringMatching(/^send-/),
          isNewSession: true,
        }),
      }),
    )
    expect(mocks.rehomeRuntime).toHaveBeenCalledWith(
      'conversation:draft:space-a',
      'conversation:session-created',
    )
    expect(mocks.rehomeScopeTabs).toHaveBeenCalledWith(
      'conversation:draft:space-a',
      'conversation:session-created',
    )
    expect(mocks.rehomeRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rehomeScopeTabs.mock.invocationCallOrder[0],
    )
    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:session-created',
      'app-focus',
    )
    expect(mocks.clearTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:draft:space-a',
    )
  })

  it('稳定草稿 A + 历史 conversation:S 首发成功时从 A 迁移 runtime、标签并清理草稿', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'project-a': true }
    chatState.currentSessionIdBySpaceId = {
      'project-a': null,
      'exec-ws-b': null,
    }

    const { result } = renderCallbacks({
      currentSessionId: null,
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      draftScopeKey: 'conversation:draft:project-a',
      tabScopeKey: 'conversation:sess-historical-s',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    await act(async () => {
      await result.current.handleSendMessage('继续草稿任务')
    })

    expect(mocks.rehomeRuntime).toHaveBeenCalledWith(
      'conversation:draft:project-a',
      'conversation:session-created',
    )
    expect(mocks.rehomeScopeTabs).toHaveBeenCalledWith(
      'conversation:draft:project-a',
      'conversation:session-created',
    )
    expect(mocks.clearTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:draft:project-a',
    )
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '继续草稿任务',
      true,
      undefined,
      undefined,
      'session-created',
      expect.objectContaining({
        spaceId: 'exec-ws-b',
        tabScopeKey: 'conversation:session-created',
      }),
    )
  })

  it('发送新建的非当前激活 Space 会话时使用 per-space current session id', async () => {
    // 全局 current 仍停在个人会话；目标 Space 草稿 + 预建指针 → 首发复用指针
    chatState.currentSessionId = 'personal-session'
    chatState.currentSessionIdBySpaceId = { 'team-space-1': 'team-session-created' }
    chatState.draftSessionBySpaceId = { 'team-space-1': true }
    chatState.sessionsBySpaceId = {
      'team-space-1': [{ id: 'team-session-created', message_count: 0, status: 'active' }],
    }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-team-draft',
      draftScopeKey: 'conversation:draft:team-space-1',
      phase: 'open',
    })
    const { result } = renderCallbacks({
      selectedSpaceId: 'team-space-1',
      currentSessionId: null,
      selectedSpace: {
        id: 'team-space-1',
        name: '发布',
        organization_id: 'organization-1',
        type: 'team_space',
      } as Parameters<typeof useChatCallbacks>[0]['selectedSpace'],
      tabScopeKey: 'conversation:draft:team-space-1',
    })

    await act(async () => {
      await result.current.handleSendMessage('我在哪个目录？')
    })

    expect(mocks.ensureSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '我在哪个目录？',
      true,
      undefined,
      undefined,
      'team-session-created',
      expect.objectContaining({
        spaceId: 'team-space-1',
        tabScopeKey: 'conversation:team-session-created',
        expectedDraftMessageId: 'ep-team-draft',
        sendTimingTrace: expect.objectContaining({
          traceId: expect.stringMatching(/^send-/),
        }),
      }),
    )
  })

  it('#7324 无预建时先 ensure 真 id，再 commit 清 draft 并挂乐观气泡', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    mocks.ensureSessionForSpace.mockImplementation(async (spaceId: string) => {
      // ：主路径先拿到真 id，再 bootstrap——ensure 时尚未 commit
      expect(chatState.currentSessionId).toBeNull()
      expect(chatState.draftSessionBySpaceId['space-a']).toBe(true)
      expect(mocks.sendMessage).not.toHaveBeenCalled()
      const createdId = 'session-created'
      chatState.currentSessionIdBySpaceId = {
        ...chatState.currentSessionIdBySpaceId,
        [spaceId]: createdId,
      }
      return {
        sessionId: createdId,
        mode: 'created' as const,
        contextFingerprint: null,
      }
    })
    const { result } = renderCallbacks({
      currentSessionId: null,
      tabScopeKey: 'conversation:draft:space-a',
    })

    await result.current.handleSendMessage('你好')

    expect(chatState.draftSessionBySpaceId['space-a']).toBeUndefined()
    expect(chatState.currentSessionId).toBe('session-created')
    expect(chatState.messagesBySessionId['session-created']?.[0]).toMatchObject({
      role: 'user',
      content: '你好',
      sendStatus: 'sending',
    })
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '你好',
      true,
      undefined,
      undefined,
      'session-created',
      expect.objectContaining({
        existingClientMessageId: expect.any(String),
      }),
    )
  })

  it('切换工作空间后立即发送会先等待目标工作空间的草稿预建', async () => {
    let releaseProvision: (() => void) | null = null
    mocks.waitForInFlightSessionCreate.mockImplementation(() => (
      new Promise<void>((resolve) => {
        releaseProvision = resolve
      })
    ))
    chatState.currentSessionId = null
    chatState.currentSessionIdBySpaceId = { 'space-b': 'session-space-b' }
    const { result } = renderCallbacks({
      selectedSpaceId: 'space-b',
      currentSessionId: null,
      selectedSpace: { id: 'space-b', name: 'Space B', organization_id: 'organization-1' },
      tabScopeKey: 'conversation:draft:space-b',
    })

    // 勿包进 act：React 19 act 会等未完成的 waitForInFlight Promise
    const sendPromise = result.current.handleSendMessage('立即发送')

    expect(mocks.waitForInFlightSessionCreate).toHaveBeenCalledWith('space-b')
    expect(mocks.ensureSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()

    expect(releaseProvision).toEqual(expect.any(Function))
    releaseProvision!()
    await sendPromise

    expect(mocks.ensureSessionForSpace).toHaveBeenCalledWith(
      'space-b',
      'organization-1',
      undefined,
      expect.objectContaining({ trigger: 'pre_send', preferQuickStart: true }),
    )
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '立即发送',
      true,
      undefined,
      undefined,
      'session-space-b',
      expect.objectContaining({
        spaceId: 'space-b',
        tabScopeKey: 'conversation:session-space-b',
      }),
    )
  })

  it('聊天输入区 Stop 走单一 Composer 中断动作', async () => {
    const { result } = renderCallbacks({ currentSessionId: 'session-a' })

    act(() => {
      result.current.handleStop()
    })

    expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-a')
  })

  it('#7868 草稿态切模型：同步 pending，并对预建 hidden session switchModel', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    chatState.currentSessionIdBySpaceId = { 'space-a': 'sess-hidden' }
    mocks.switchModel.mockResolvedValue(undefined)

    const { result } = renderCallbacks({
      currentSessionId: null,
      draftScopeKey: 'conversation:draft:space-a',
      selectedSpaceId: 'space-a',
    })

    await act(async () => {
      await result.current.handleModelChange('cbc75d0e-1111-4222-8333-444444444442')
    })

    expect(mocks.setPendingModelId).toHaveBeenCalledWith(
      'cbc75d0e-1111-4222-8333-444444444442',
    )
    expect(mocks.syncDraftModelIntent).toHaveBeenCalledWith(
      'cbc75d0e-1111-4222-8333-444444444442',
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:space-a',
        hiddenSessionId: 'sess-hidden',
      }),
      expect.objectContaining({ contextTierId: undefined }),
    )
    expect(mocks.switchModel).toHaveBeenCalledWith(
      'sess-hidden',
      'cbc75d0e-1111-4222-8333-444444444442',
    )
  })

  it('#7868 草稿态切模型+档位：switchModel 带 contextTierId', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    chatState.currentSessionIdBySpaceId = { 'space-a': 'sess-hidden' }
    mocks.switchModel.mockResolvedValue(undefined)

    const { result } = renderCallbacks({
      currentSessionId: null,
      draftScopeKey: 'conversation:draft:space-a',
      selectedSpaceId: 'space-a',
    })

    await act(async () => {
      await result.current.handleModelChange(
        'cbc75d0e-1111-4222-8333-444444444442',
        'tier-long',
      )
    })

    expect(mocks.syncDraftModelIntent).toHaveBeenCalledWith(
      'cbc75d0e-1111-4222-8333-444444444442',
      expect.objectContaining({ hiddenSessionId: 'sess-hidden' }),
      { contextTierId: 'tier-long' },
    )
    expect(mocks.switchModel).toHaveBeenCalledWith(
      'sess-hidden',
      'cbc75d0e-1111-4222-8333-444444444442',
      'tier-long',
    )
  })

  it('草稿态选择思考强度：预建 session 第一轮前完成持久化', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    chatState.currentSessionIdBySpaceId = { 'space-a': 'sess-hidden' }
    chatState.sessions = [{
      id: 'sess-hidden',
      current_model_id: 'cbc75d0e-1111-4222-8333-444444444442',
      model_param_overrides: null,
    }]
    mocks.switchModel.mockResolvedValue(undefined)
    mocks.setModelParamOverride.mockImplementation(async (sessionId, key, value) => {
      const session = chatState.getSessionById(sessionId) as {
        model_param_overrides?: Record<string, unknown> | null
      } | undefined
      if (session) {
        session.model_param_overrides = {
          ...(session.model_param_overrides ?? {}),
          [key]: value,
        }
      }
    })

    const { result } = renderCallbacks({
      currentSessionId: null,
      draftScopeKey: 'conversation:draft:space-a',
      selectedSpaceId: 'space-a',
    })

    await act(async () => {
      await result.current.handleModelChange(
        'cbc75d0e-1111-4222-8333-444444444442',
        undefined,
        { key: 'reasoning_effort', value: 'high' },
      )
    })

    expect(mocks.syncDraftModelIntent).toHaveBeenCalledWith(
      'cbc75d0e-1111-4222-8333-444444444442',
      expect.anything(),
      {
        contextTierId: undefined,
        controlChange: { key: 'reasoning_effort', value: 'high' },
      },
    )
    expect(mocks.setModelParamOverride).toHaveBeenCalledWith(
      'sess-hidden',
      'reasoning_effort',
      'high',
    )
    expect(mocks.replacePendingModelParamOverrides).toHaveBeenCalledWith({
      reasoning_effort: 'high',
    })
    expect(mocks.setPendingModelParamOverride).not.toHaveBeenCalled()
  })

  it('草稿态开 Fast 后 pending 回写含 fast_by_model，不单落 service_tier', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    chatState.currentSessionIdBySpaceId = { 'space-a': 'sess-hidden' }
    chatState.sessions = [{
      id: 'sess-hidden',
      current_model_id: 'gpt-5.6-sol',
      model_param_overrides: null,
    }]
    mocks.switchModel.mockResolvedValue(undefined)
    mocks.setModelParamOverride.mockImplementation(async (sessionId, key, value) => {
      const session = chatState.getSessionById(sessionId) as {
        model_param_overrides?: Record<string, unknown> | null
      } | undefined
      if (!session) return
      session.model_param_overrides = {
        service_tier: value,
        fast_by_model: JSON.stringify({ 'gpt-5.6-sol': value === 'fast' }),
      }
    })

    const { result } = renderCallbacks({
      currentSessionId: null,
      draftScopeKey: 'conversation:draft:space-a',
      selectedSpaceId: 'space-a',
    })

    await act(async () => {
      await result.current.handleModelChange(
        'gpt-5.6-sol',
        undefined,
        { key: 'service_tier', value: 'fast' },
      )
    })

    expect(mocks.replacePendingModelParamOverrides).toHaveBeenCalledWith({
      service_tier: 'fast',
      fast_by_model: JSON.stringify({ 'gpt-5.6-sol': true }),
    })
    expect(mocks.setPendingModelParamOverride).not.toHaveBeenCalled()
  })

  it('create 已带 modelId 且 session 一致时不调用 switchModel', async () => {
    chatState.currentSessionId = null
    chatState.currentSessionIdBySpaceId = { 'space-a': 'session-created' }
    chatState.sessionsBySpaceId = {
      'space-a': [{ id: 'session-created', current_model_id: 'cbc75d0e-1111-4222-8333-444444444441' }],
    }
    const { result } = renderCallbacks({
      currentSessionId: null,
      pendingModelId: 'cbc75d0e-1111-4222-8333-444444444441',
    })

    await act(async () => {
      await result.current.handleSendMessage('hello')
    })

    expect(mocks.ensureSessionForSpace).toHaveBeenCalled()
    expect(mocks.switchModel).not.toHaveBeenCalled()
  })

  it('create 后 model 不一致时才 switchModel', async () => {
    chatState.currentSessionId = null
    chatState.currentSessionIdBySpaceId = { 'space-a': 'session-created' }
    chatState.sessionsBySpaceId = {
      'space-a': [{ id: 'session-created', current_model_id: 'cbc75d0e-1111-4222-8333-444444444443' }],
    }
    const { result } = renderCallbacks({
      currentSessionId: null,
      pendingModelId: 'cbc75d0e-1111-4222-8333-444444444442',
    })

    await act(async () => {
      await result.current.handleSendMessage('hello')
    })

    expect(mocks.ensureSessionForSpace).toHaveBeenCalled()
    expect(mocks.switchModel).toHaveBeenCalledWith(
      'session-created',
      'cbc75d0e-1111-4222-8333-444444444442',
    )
  })

  it('草稿首发 bootstrap 后 bind episode token，commit 交给 sendMessage 前门禁', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    chatState.currentSessionIdBySpaceId = { 'space-a': 'sess-hidden' }
    chatState.sessionsBySpaceId = {
      'space-a': [{ id: 'sess-hidden', agent_id: 'agent-old' }],
    }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-1',
      draftScopeKey: 'conversation:draft:space-a',
    })

    const { result } = renderCallbacks({
      currentSessionId: null,
      tabScopeKey: 'conversation:draft:space-a',
    })

    await act(async () => {
      await result.current.handleSendMessage('hello')
    })

    expect(mocks.resolveConversationDraftScopeKey).toHaveBeenCalledWith(
      expect.objectContaining({ tabScopeKey: 'conversation:draft:space-a' }),
    )
    expect(mocks.bindDraftSessionToMessage).toHaveBeenCalled()
    expect(chatState.registerComposerDraftKeyForSend).toHaveBeenCalledWith(
      'sess-hidden',
      'space:space-a',
    )
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'hello',
      true,
      undefined,
      undefined,
      'sess-hidden',
      expect.objectContaining({
        existingClientMessageId: expect.any(String),
      }),
    )
  })

  it('预建会话首发先迁草稿 app-focus，再切正式 session scope', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'project-a': true }
    chatState.currentSessionIdBySpaceId = { 'exec-ws-b': 'sess-prefetched' }
    chatState.sessionsBySpaceId = {
      'exec-ws-b': [{ id: 'sess-prefetched', agent_id: 'agent-a' }],
    }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-project-a',
      draftScopeKey: 'conversation:draft:project-a',
    })

    const { result } = renderCallbacks({
      currentSessionId: null,
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      // 预建完成后 tab 已指向真实 session，但可见产品现场仍是 draft:A。
      tabScopeKey: 'conversation:sess-prefetched',
      draftScopeKey: 'conversation:draft:project-a',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    await act(async () => {
      await result.current.handleSendMessage('保持应用聚焦')
    })

    expect(mocks.getTaskViewMode).toHaveBeenCalledWith(
      'conversation:draft:project-a',
    )
    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:sess-prefetched',
      'app-focus',
    )
    expect(
      mocks.setTaskViewModeForScope.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.setChatState.mock.invocationCallOrder[0])
  })

  it('D. 无 tabScopeKey 时 adapter fallback 生成 draftScopeKey', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    const { result } = renderCallbacks({
      currentSessionId: null,
      tabScopeKey: null,
    })

    await act(async () => {
      await result.current.handleSendMessage('fallback scope')
    })

    expect(mocks.resolveConversationDraftScopeKey).toHaveBeenCalledWith(
      expect.objectContaining({
        tabScopeKey: null,
        legacyExecutionHostId: 'space-a',
      }),
    )
    expect(mocks.beginDraftMessage).toHaveBeenCalledWith(
      'conversation:draft:space-a',
      expect.anything(),
    )
  })

  it('历史会话发送不 bind 新 episode（ A）', async () => {
    chatState.currentSessionId = 'session-history'
    chatState.draftSessionBySpaceId = {}
    chatState.currentSessionIdBySpaceId = { 'space-a': 'session-history' }

    const { result } = renderCallbacks({ currentSessionId: 'session-history' })

    await act(async () => {
      await result.current.handleSendMessage('hello from history')
    })

    expect(mocks.bindDraftSessionToMessage).not.toHaveBeenCalled()
    expect(mocks.sendMessage).toHaveBeenCalled()
  })

  it('F.  ensure 返回空 id：commit 前失败，无乐观气泡、draft 保留', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    chatState.currentSessionIdBySpaceId = {}
    mocks.ensureSessionForSpace.mockImplementationOnce(async () => {
      chatState.currentSessionId = 'session-on-space-b'
      return {
        sessionId: null as unknown as string,
        mode: 'created' as const,
        contextFingerprint: null,
      }
    })

    const { result } = renderCallbacks({ currentSessionId: null })

    await act(async () => {
      await result.current.handleSendMessage('hello')
    })

    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(chatState.draftSessionBySpaceId['space-a']).toBe(true)
    expect(Object.keys(chatState.messagesBySessionId)).toHaveLength(0)
  })

  it('B.  ensure reject：无 commit / 无 send，draft 与 episode 保留', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-a',
      draftScopeKey: 'conversation:draft:space-a',
    })
    mocks.ensureSessionForSpace.mockRejectedValueOnce(new Error('provision rejected'))

    const { result } = renderCallbacks({
      currentSessionId: null,
      tabScopeKey: 'conversation:draft:space-a',
    })

    await act(async () => {
      await result.current.handleSendMessage('hello reject')
    })

    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(chatState.draftSessionBySpaceId['space-a']).toBe(true)
    expect(Object.keys(chatState.messagesBySessionId)).toHaveLength(0)
    expect(mocks.getDraftMessageByScopeKey).toHaveBeenCalled()
  })

  it('ownership：bind 失败于 commit 前 → 不清 draft / 不追加消息（ensure 可已发生）', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    chatState.currentSessionIdBySpaceId = { 'space-a': null }
    chatState.messagesBySessionId = {}
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-a',
      draftScopeKey: 'conversation:draft:space-a',
    })
    // ensure 只返回 id，不模拟 lifecycle 写 current——断言 commit 未执行
    mocks.ensureSessionForSpace.mockResolvedValueOnce({
      sessionId: 'sess-from-ensure',
      mode: 'created' as const,
      contextFingerprint: null,
    })
    mocks.bindDraftSessionToMessage.mockReturnValueOnce(null)

    const { result } = renderCallbacks({
      currentSessionId: null,
      tabScopeKey: 'conversation:draft:space-a',
    })

    await act(async () => {
      await result.current.handleSendMessage('bind conflict')
    })

    expect(mocks.ensureSessionForSpace).toHaveBeenCalled()
    expect(mocks.bindDraftSessionToMessage).toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(chatState.draftSessionBySpaceId['space-a']).toBe(true)
    expect(chatState.currentSessionId).toBeNull()
    expect(Object.keys(chatState.messagesBySessionId)).toHaveLength(0)
  })

  it('handleNewSession 显式传稳定 draftScopeKey A（非 tabScopeKey）', () => {
    const { result } = renderCallbacks({
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      tabScopeKey: 'conversation:draft:project-a',
      draftScopeKey: 'conversation:draft:project-a',
      resolvedOrganizationId: 'organization-1',
    })

    act(() => {
      result.current.handleNewSession()
    })

    expect(mocks.startDraftSessionForSpace).toHaveBeenCalledWith(
      'project-a',
      true,
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:project-a',
        organizationId: 'organization-1',
        executionWorkspaceId: 'exec-ws-b',
      }),
    )
  })

  it('历史 conversation:S + execution B：handleNew 只 start A，绝不 fallback B', () => {
    const { result } = renderCallbacks({
      // 当前执行现场是 B；产品宿主是 Project A
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      // 关键：初始 key 是历史会话 scope，不是 draft:A
      tabScopeKey: 'conversation:sess-historical-s',
      draftScopeKey: 'conversation:draft:project-a',
      resolvedOrganizationId: 'organization-1',
      currentSessionId: 'sess-historical-s',
    })

    act(() => {
      result.current.handleNewSession()
    })

    expect(mocks.resolveConversationDraftScopeKey).toHaveBeenCalledWith(
      expect.objectContaining({
        stableDraftScopeKey: 'conversation:draft:project-a',
        tabScopeKey: 'conversation:sess-historical-s',
        legacyExecutionHostId: null,
      }),
    )
    expect(mocks.startDraftSessionForSpace).toHaveBeenCalledWith(
      'project-a',
      true,
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:project-a',
        executionWorkspaceId: 'exec-ws-b',
      }),
    )
    // 不得以 B 为 draftScopeKey / host 开启 episode
    expect(mocks.startDraftSessionForSpace).not.toHaveBeenCalledWith(
      'exec-ws-b',
      expect.anything(),
      expect.objectContaining({ draftScopeKey: 'conversation:draft:exec-ws-b' }),
    )
    expect(mocks.beginDraftMessage).not.toHaveBeenCalledWith(
      'conversation:draft:exec-ws-b',
      expect.anything(),
    )
  })

  it('历史 conversation:S：handleTabClick 透传稳定 A 给 select/cancel', async () => {
    const { result } = renderCallbacks({
      currentSessionId: 'sess-historical-s',
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      tabScopeKey: 'conversation:sess-historical-s',
      draftScopeKey: 'conversation:draft:project-a',
      resolvedOrganizationId: 'organization-1',
      resolveSessionSpaceId: () => 'exec-ws-b',
    })

    await act(async () => {
      await result.current.handleTabClick('sess-other')
    })

    expect(mocks.selectSession).toHaveBeenCalledWith(
      'exec-ws-b',
      'sess-other',
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:project-a',
        organizationId: 'organization-1',
      }),
    )
  })

  it('Project scope A + Mode/首发期间切历史：episode inactive → 零 send、不 commit', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'project-a': true }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-project-a',
      draftScopeKey: 'conversation:draft:project-a',
    })
    mocks.ensureSessionForSpace.mockImplementationOnce(async () => {
      mocks.isDraftMessageActive.mockReturnValue(false)
      chatState.currentSessionId = 'sess-historical'
      chatState.currentSessionIdBySpaceId = { 'exec-ws-b': 'sess-historical' }
      return {
        sessionId: 'sess-orphan',
        mode: 'created' as const,
        contextFingerprint: null,
      }
    })

    const { result } = renderCallbacks({
      currentSessionId: null,
      tabScopeKey: 'conversation:sess-historical-s',
      draftScopeKey: 'conversation:draft:project-a',
      conversationHostSpaceId: 'project-a',
      selectedSpaceId: 'exec-ws-b',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    await act(async () => {
      await result.current.handleSendMessage('project scope send')
    })

    expect(mocks.resolveConversationDraftScopeKey).toHaveBeenCalledWith(
      expect.objectContaining({
        stableDraftScopeKey: 'conversation:draft:project-a',
        tabScopeKey: 'conversation:sess-historical-s',
      }),
    )
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(chatState.draftSessionBySpaceId['project-a']).toBe(true)
    expect(chatState.currentSessionIdBySpaceId['exec-ws-b']).toBe('sess-historical')
  })

  it('迟到 deferred ensure：历史 conversation:S 上 cancel A 后回包不 send、不覆盖 pointer', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'project-a': true }
    chatState.currentSessionIdBySpaceId = { 'project-a': null, 'exec-ws-b': null }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-project-a',
      draftScopeKey: 'conversation:draft:project-a',
    })

    let resolveEnsure!: (value: {
      sessionId: string
      mode: 'created'
      contextFingerprint: null
    }) => void
    mocks.ensureSessionForSpace.mockImplementationOnce(
      () => new Promise((resolve) => { resolveEnsure = resolve }),
    )

    const { result } = renderCallbacks({
      currentSessionId: null,
      // 关键：当前已是历史会话 scope，不是 draft:A
      tabScopeKey: 'conversation:sess-historical-s',
      draftScopeKey: 'conversation:draft:project-a',
      conversationHostSpaceId: 'project-a',
      selectedSpaceId: 'exec-ws-b',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = result.current.handleSendMessage('deferred cancel')
    })

    // 发送已进入 ensure 等待；模拟切历史 cancel A（select 透传 A）
    mocks.isDraftMessageActive.mockReturnValue(false)
    chatState.currentSessionId = 'sess-historical-s'
    chatState.currentSessionIdBySpaceId = {
      'project-a': 'sess-historical-s',
      'exec-ws-b': 'sess-historical-s',
    }

    await act(async () => {
      resolveEnsure({
        sessionId: 'sess-orphan-late',
        mode: 'created',
        contextFingerprint: null,
      })
      await sendPromise
    })

    expect(mocks.resolveConversationDraftScopeKey).toHaveBeenCalledWith(
      expect.objectContaining({
        stableDraftScopeKey: 'conversation:draft:project-a',
        tabScopeKey: 'conversation:sess-historical-s',
        legacyExecutionHostId: null,
      }),
    )
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(chatState.currentSessionIdBySpaceId['exec-ws-b']).toBe('sess-historical-s')
    expect(chatState.currentSessionIdBySpaceId['project-a']).toBe('sess-historical-s')
    expect(chatState.currentSessionId).toBe('sess-historical-s')
    expect(chatState.draftSessionBySpaceId['project-a']).toBe(true)
  })

  it('D. deferred ensure + 切历史：episode inactive → 零 send、不 commit', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'space-a': true }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-a',
      draftScopeKey: 'conversation:draft:space-a',
    })
    mocks.ensureSessionForSpace.mockImplementationOnce(async () => {
      mocks.isDraftMessageActive.mockReturnValue(false)
      chatState.currentSessionId = 'sess-historical'
      chatState.currentSessionIdBySpaceId = { 'space-a': 'sess-historical' }
      return {
        sessionId: 'sess-orphan-new',
        mode: 'created' as const,
        contextFingerprint: null,
      }
    })

    const { result } = renderCallbacks({ currentSessionId: null })
    await act(async () => {
      await result.current.handleSendMessage('switch history mid ensure')
    })

    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(Object.keys(chatState.messagesBySessionId)).toHaveLength(0)
    expect(chatState.draftSessionBySpaceId['space-a']).toBe(true)
    expect(chatState.currentSessionIdBySpaceId['space-a']).toBe('sess-historical')
  })

  it('#7324 host A 有 draft、execution B 有预建指针：首发清 host 旗标并单跳', async () => {
    chatState.currentSessionId = null
    // 复现：draft 只挂在产品宿主 A；B 已有 prefetch 指针
    chatState.draftSessionBySpaceId = { 'project-a': true }
    chatState.currentSessionIdBySpaceId = {
      'project-a': null,
      'exec-ws-b': 'sess-prefetched',
    }
    chatState.sessionsBySpaceId = {
      'exec-ws-b': [{ id: 'sess-prefetched', message_count: 0, status: 'active' }],
    }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-project-a',
      draftScopeKey: 'conversation:draft:project-a',
    })
    mocks.waitForInFlightSessionCreate.mockResolvedValue(undefined)

    const { result } = renderCallbacks({
      currentSessionId: null,
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      draftScopeKey: 'conversation:draft:project-a',
      tabScopeKey: 'conversation:draft:project-a',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    await act(async () => {
      await result.current.handleSendMessage('哈哈哈')
    })

    expect(chatState.draftSessionBySpaceId['project-a']).toBeUndefined()
    expect(chatState.currentSessionId).toBe('sess-prefetched')
    expect(chatState.currentSessionIdBySpaceId['exec-ws-b']).toBe('sess-prefetched')
    expect(chatState.currentSessionIdBySpaceId['project-a']).toBe('sess-prefetched')
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '哈哈哈',
      true,
      undefined,
      undefined,
      'sess-prefetched',
      expect.objectContaining({
        spaceId: 'exec-ws-b',
        tabScopeKey: 'conversation:sess-prefetched',
      }),
    )
  })

  it('草稿首发复用预建会话：sticky Codex 与 session 平台模型不一致时先对齐', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'project-a': true }
    chatState.currentSessionIdBySpaceId = {
      'project-a': null,
      'exec-ws-b': 'sess-prefetched',
    }
    chatState.sessionsBySpaceId = {
      'exec-ws-b': [{
        id: 'sess-prefetched',
        message_count: 0,
        status: 'active',
        current_model_id: '6c16c211-c2ed-4932-a9f4-c7863e10ccc0',
      }],
    }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-project-a',
      draftScopeKey: 'conversation:draft:project-a',
    })
    mocks.waitForInFlightSessionCreate.mockResolvedValue(undefined)
    mocks.readRuntimeModelPreference.mockReturnValue('gpt-5.6-sol')
    mocks.resolveLocalRuntimeAlignTarget.mockReturnValue('gpt-5.6-sol')
    mocks.switchModel.mockResolvedValue(undefined)

    const { result } = renderCallbacks({
      currentSessionId: null,
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      draftScopeKey: 'conversation:draft:project-a',
      tabScopeKey: 'conversation:draft:project-a',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    await act(async () => {
      await result.current.handleSendMessage('你好')
    })

    expect(mocks.switchModel).toHaveBeenCalledWith('sess-prefetched', 'gpt-5.6-sol')
    expect(mocks.sendMessage).toHaveBeenCalled()
  })

  it('草稿首发复用预建：draft intent 为平台模型时不得被 sticky Codex 盖掉', async () => {
    const platformId = '42ae58c8-feea-4098-b80b-9a0aedc35007'
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'project-a': true }
    chatState.currentSessionIdBySpaceId = {
      'project-a': null,
      'exec-ws-b': 'sess-prefetched',
    }
    chatState.sessionsBySpaceId = {
      'exec-ws-b': [{
        id: 'sess-prefetched',
        message_count: 0,
        status: 'active',
        current_model_id: '6c16c211-c2ed-4932-a9f4-c7863e10ccc0',
      }],
    }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-project-a',
      draftScopeKey: 'conversation:draft:project-a',
    })
    mocks.waitForInFlightSessionCreate.mockResolvedValue(undefined)
    mocks.peekDraftModelIntent.mockReturnValue(platformId)
    mocks.readRuntimeModelPreference.mockReturnValue('gpt-5.6-sol')
    mocks.resolveLocalRuntimeAlignTarget.mockImplementation((options: {
      pendingModelId?: string | null
      stickyModelId?: string | null
      catalogHas: (modelId: string) => boolean
    }) => {
      for (const candidate of [options.pendingModelId, options.stickyModelId]) {
        const trimmed = (candidate || '').trim()
        if (!trimmed) continue
        if (options.catalogHas(trimmed) || trimmed.startsWith('gpt-')) return trimmed
      }
      return undefined
    })
    mocks.switchModel.mockResolvedValue(undefined)

    const { result } = renderCallbacks({
      currentSessionId: null,
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      draftScopeKey: 'conversation:draft:project-a',
      tabScopeKey: 'conversation:draft:project-a',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    await act(async () => {
      await result.current.handleSendMessage('平台意图')
    })

    expect(mocks.resolveLocalRuntimeAlignTarget).toHaveBeenCalledWith(
      expect.objectContaining({ pendingModelId: platformId, stickyModelId: 'gpt-5.6-sol' }),
    )
    expect(mocks.switchModel).toHaveBeenCalledWith('sess-prefetched', platformId)
    expect(mocks.switchModel).not.toHaveBeenCalledWith('sess-prefetched', 'gpt-5.6-sol')
    expect(mocks.sendMessage).toHaveBeenCalled()
  })

  it('草稿首发复用预建：Codex 对齐失败时中止发送', async () => {
    chatState.currentSessionId = null
    chatState.draftSessionBySpaceId = { 'project-a': true }
    chatState.currentSessionIdBySpaceId = {
      'project-a': null,
      'exec-ws-b': 'sess-prefetched',
    }
    chatState.sessionsBySpaceId = {
      'exec-ws-b': [{
        id: 'sess-prefetched',
        message_count: 0,
        status: 'active',
        current_model_id: '6c16c211-c2ed-4932-a9f4-c7863e10ccc0',
      }],
    }
    mocks.getDraftMessageByScopeKey.mockReturnValue({
      draftMessageId: 'ep-project-a',
      draftScopeKey: 'conversation:draft:project-a',
    })
    mocks.waitForInFlightSessionCreate.mockResolvedValue(undefined)
    mocks.readRuntimeModelPreference.mockReturnValue('gpt-5.6-sol')
    mocks.resolveLocalRuntimeAlignTarget.mockReturnValue('gpt-5.6-sol')
    mocks.switchModel.mockRejectedValue(new Error('请先登录 ChatGPT'))

    const { result } = renderCallbacks({
      currentSessionId: null,
      selectedSpaceId: 'exec-ws-b',
      conversationHostSpaceId: 'project-a',
      draftScopeKey: 'conversation:draft:project-a',
      tabScopeKey: 'conversation:draft:project-a',
      selectedSpace: {
        id: 'exec-ws-b',
        name: 'Exec WS',
        organization_id: 'organization-1',
      },
    })

    await act(async () => {
      await result.current.handleSendMessage('你好')
    })

    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('#7872 切到本机 Codex 不写 Agent.preferred_model_id，但写本机 sticky', async () => {
    chatState.sessions = [{ id: 'session-a', current_model_id: 'old-model' }]
    const { result } = renderCallbacks({ currentSessionId: 'session-a' })

    await act(async () => {
      await result.current.handleModelChange('gpt-5.6-sol')
    })

    expect(mocks.setPreferredModel).not.toHaveBeenCalled()
    expect(mocks.writeRuntimeModelPreference).toHaveBeenCalledWith('agent-1', 'gpt-5.6-sol')
    expect(mocks.switchModel).toHaveBeenCalledWith('session-a', 'gpt-5.6-sol')
  })

  it('切到 Codex 并带 Fast controlChange：先 switchModel 再写 service_tier=fast', async () => {
    chatState.sessions = [{ id: 'session-a', current_model_id: 'old-model' }]
    mocks.switchModel.mockResolvedValue(undefined)
    mocks.setModelParamOverride.mockResolvedValue(undefined)
    const { result } = renderCallbacks({ currentSessionId: 'session-a' })

    await act(async () => {
      await result.current.handleModelChange(
        'gpt-5.6-sol',
        undefined,
        { key: 'service_tier', value: 'fast' },
      )
    })

    expect(mocks.switchModel).toHaveBeenCalledWith('session-a', 'gpt-5.6-sol')
    expect(mocks.writeRuntimeModelParamPreference).toHaveBeenCalledWith(
      'agent-1',
      'gpt-5.6-sol',
      'service_tier',
      'fast',
    )
    expect(mocks.setModelParamOverride).toHaveBeenCalledWith(
      'session-a',
      'service_tier',
      'fast',
    )
  })

  it('#7872 切到平台模型仍写 Agent.preferred_model_id，并写本机 sticky', async () => {
    const platformId = '42ae58c8-feea-4098-b80b-9a0aedc35007'
    chatState.sessions = [{ id: 'session-a', current_model_id: 'old-model' }]
    const { result } = renderCallbacks({ currentSessionId: 'session-a' })

    await act(async () => {
      await result.current.handleModelChange(platformId)
    })

    expect(mocks.setPreferredModel).toHaveBeenCalledWith('agent-1', platformId)
    expect(mocks.writeRuntimeModelPreference).toHaveBeenCalledWith('agent-1', platformId)
    expect(mocks.switchModel).toHaveBeenCalledWith('session-a', platformId)
  })
})
