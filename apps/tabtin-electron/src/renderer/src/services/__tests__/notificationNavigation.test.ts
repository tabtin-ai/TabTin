/**
 * Unit tests for notificationNavigation.ts
 *
 * Covers: findSpaceIdForSession, navigateToChatSession, navigateToTarget
 * All Zustand stores are module-level mocked via vi.mock().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted — declare mock fns/state available to hoisted vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockSelectSession,
  mockSelectSpace,
  mockToast,
  mockToastError,
  mockSetIsPanelOpen,
  mockOpenResourceTab,
  mockSelectSpaceById,
  mockSelectSpaceBySpaceId,
  mockActivateSpace,
  mockSetCurrentTab,
  mockLoadSpaces,
  mockLoadConversations,
  mockLoadOrganizations,
  mockSelectOrganization,
  mockRunWithAgentContextSwitchGuard,
  mockGetConversation,
  mockGetConversationNavigationKind,
  mockCloseSettings,
  mockOpenSettings,
  mockOpenIM,
  mockSetImContactsTab,
  mockSetImSidebarView,
  mockSetChatSidePanelCollapsed,
  mockSetTaskViewModeForScope,
  mockSetSidebarModeForOrganizationUser,
  mockSetLastActiveSurface,
  mockCloseAppPage,
  mockCloseIM,
  mockSetCurrentConversation,
  mockEnterTeamSpaceProject,
  mockOpenProjectTaskChatSession,
  mockRequestCommentReveal,
  state,
} = vi.hoisted(() => {
  const toastFn = Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  })
  const s = {
    sessions: [] as Array<{ id: string; space_id?: string | null }>,
    sessionsBySpaceId: {} as Record<string, Array<{ id: string; space_id?: string | null }>>,
    selectedSpace: null as { id: string; name?: string } | null,
    spaces: [] as Array<{ id: string; name: string; organization_id?: string }>,
    conversations: [] as Array<{ id: string; space_id?: string | null }>,
    settingsIsOpen: false,
    selectedOrganizationId: 'ws-1',
    organizations: [{ id: 'ws-1' }, { id: 'ws-2' }] as Array<{ id: string }>,
  }
  const mockSelectSpace = vi.fn()
  const mockSelectOrganization = vi.fn(async (org: { id: string }) => {
    s.selectedOrganizationId = org.id
  })
  return {
    mockSelectSession: vi.fn().mockResolvedValue(undefined),
    mockSelectSpace,
    mockToast: toastFn,
    mockToastError: toastFn.error,
    mockSetIsPanelOpen: vi.fn(),
    mockOpenResourceTab: vi.fn(),
    mockSelectSpaceById: vi.fn(),
    mockActivateSpace: vi.fn(),
    mockSetCurrentTab: vi.fn(),
    mockSelectSpaceBySpaceId: vi.fn((spaceId: string) => {
      if (s.selectedSpace?.id === spaceId) return true
      const targetSpace = s.spaces.find((item) => item.id === spaceId)
      if (!targetSpace) return false
      mockSelectSpace(targetSpace)
      s.selectedSpace = { id: targetSpace.id, name: targetSpace.name }
      return true
    }),
    mockLoadSpaces: vi.fn().mockResolvedValue(undefined),
    mockLoadConversations: vi.fn().mockResolvedValue(undefined),
    mockLoadOrganizations: vi.fn().mockResolvedValue(undefined),
    mockSelectOrganization,
    mockRunWithAgentContextSwitchGuard: vi.fn(async (_kind: string, proceed: () => Promise<void> | void) => {
      await proceed()
      return true
    }),
    mockGetConversation: vi.fn().mockResolvedValue({ id: 'conv-1', type: 'direct' }),
    mockGetConversationNavigationKind: vi.fn().mockReturnValue('dm'),
    mockCloseSettings: vi.fn(),
    mockOpenSettings: vi.fn(),
    mockOpenIM: vi.fn(),
    mockSetImContactsTab: vi.fn(),
    mockSetImSidebarView: vi.fn(),
    mockSetChatSidePanelCollapsed: vi.fn(),
    mockSetTaskViewModeForScope: vi.fn(),
    mockSetSidebarModeForOrganizationUser: vi.fn(),
    mockSetLastActiveSurface: vi.fn(),
    mockCloseAppPage: vi.fn(),
    mockCloseIM: vi.fn(),
    mockSetCurrentConversation: vi.fn(),
    mockEnterTeamSpaceProject: vi.fn(),
    mockOpenProjectTaskChatSession: vi.fn().mockResolvedValue(undefined),
    mockRequestCommentReveal: vi.fn(),
    state: s,
  }
})

// ---------------------------------------------------------------------------
// vi.mock — hoisted before any imports, references only hoisted symbols
// ---------------------------------------------------------------------------

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      sessions: state.sessions,
      sessionsBySpaceId: state.sessionsBySpaceId,
      selectSession: mockSelectSession,
    }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedSpace: state.selectedSpace,
      spaces: state.spaces,
      loadSpaces: mockLoadSpaces,
      selectSpace: mockSelectSpace,
    }),
  },
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
      conversations: state.conversations,
      loadConversations: mockLoadConversations,
      openIM: mockOpenIM,
      closeIM: mockCloseIM,
      setCurrentConversation: mockSetCurrentConversation,
      setImContactsTab: mockSetImContactsTab,
      setImSidebarView: mockSetImSidebarView,
    }),
    setState: (updater: any) => {
      const partial = typeof updater === 'function'
        ? updater({ conversations: state.conversations })
        : updater
      if (partial?.conversations) {
        state.conversations = partial.conversations
      }
    },
  },
}))

// tabagenda 已下线（Tracker 模块收敛波次 1），原 useAgendaStore mock 已移除。

vi.mock('@stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      closeMemo: vi.fn(),
      setChatSidePanelCollapsed: mockSetChatSidePanelCollapsed,
    }),
  },
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({
      setTaskViewModeForScope: mockSetTaskViewModeForScope,
      setSidebarModeForOrganizationUser: mockSetSidebarModeForOrganizationUser,
    }),
  },
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({ closeAppPage: mockCloseAppPage }),
  },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'user-1' } }),
  },
}))

vi.mock('@stores/useWorkbenchSurfaceStore', () => ({
  useWorkbenchSurfaceStore: {
    getState: () => ({ setLastActiveSurface: mockSetLastActiveSurface }),
  },
}))

vi.mock('@stores/useComposerPresetStore', () => ({
  useComposerPresetStore: {
    getState: () => ({
      addPreset: vi.fn(),
    }),
  },
}))

vi.mock('nanoid', () => ({
  nanoid: () => 'test-id',
}))

vi.mock('@stores/useNotificationStore', () => ({
  useNotificationStore: {
    getState: () => ({
      setIsPanelOpen: mockSetIsPanelOpen,
    }),
  },
}))

vi.mock('@stores/useTabDocCommentRevealStore', () => ({
  useTabDocCommentRevealStore: {
    getState: () => ({ requestCommentReveal: mockRequestCommentReveal }),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: mockOpenResourceTab,
      tabOrderBySpace: {},
      itemsBySpace: {},
      activeKeyBySpace: {},
      closeTab: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({
      get isOpen() { return state.settingsIsOpen },
      openSettings: mockOpenSettings,
      closeSettings: mockCloseSettings,
    }),
  },
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({
      selectSpaceById: mockSelectSpaceById,
      selectSpaceBySpaceId: mockSelectSpaceBySpaceId,
      activateSpace: mockActivateSpace,
      clearSelection: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({
      setCurrentTab: mockSetCurrentTab,
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  getConversation: mockGetConversation,
}))

// 测试环境下 contextRegistry 不会注册任何 app handler，
// 导致 ``resolveArtifactAppFromSkill`` 总返回 undefined → 端到端测试
// 永远走 fallback ``type: 'tracker'`` 分支。这里基于 skill_key 命名约定
// （``<app>.action`` / ``<app>-skill`` / ``<app>``）解析出 app id，
// 与真实 contextRegistry 命中行为对齐。
vi.mock('../trackerArtifactMap', () => ({
  resolveArtifactAppFromSkill: (skillKey: string | null | undefined): string | undefined => {
    if (!skillKey || typeof skillKey !== 'string') return undefined
    const trimmed = skillKey.trim().toLowerCase()
    if (!trimmed) return undefined
    const dotIdx = trimmed.indexOf('.')
    if (dotIdx > 0) return trimmed.slice(0, dotIdx)
    const dashIdx = trimmed.indexOf('-')
    if (dashIdx > 0) return trimmed.slice(0, dashIdx)
    return trimmed
  },
}))

// 测试环境无 manifest registry，``getResourceIdEnvelopeKey`` 总返回 undefined →
// ``resolveResourceIdFromArtifact`` 走 fallback 用 ``artifactId``，但测试 fixture
// 用的是具体字段名（``memoId`` / ``docId`` / ``slideId`` / ``codePath``）。
// 用一张硬编码 alias 表把 appId 反查到 envelope 字段名，与各 app manifest
// `objectModel.isResourceId` 约定保持一致。
vi.mock('../manifestResourceIdMap', () => {
  const APP_TO_ENVELOPE_KEY: Record<string, string> = {
    tabmemo: 'memoId',
    tabdoc: 'docId',
    tabslide: 'slideId',
    tabcode: 'codePath',
    tabdata: 'recordIds',
  }
  return {
    getResourceIdEnvelopeKey: (appId: string): string | undefined =>
      APP_TO_ENVELOPE_KEY[appId],
  }
})

vi.mock('../spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: vi.fn(async (
    spaceId: string,
    options?: { failureToast?: { title: string; description?: string; variant?: string } },
  ) => {
    if (state.selectedSpace?.id === spaceId) return true
    const targetSpace = state.spaces.find((item) => item.id === spaceId)
    if (!targetSpace) {
      if (options?.failureToast) {
        mockToast({
          title: options.failureToast.title,
          description: options.failureToast.description,
          variant: options.failureToast.variant,
        })
      }
      return false
    }
    mockSelectSpace(targetSpace)
    state.selectedSpace = { id: targetSpace.id, name: targetSpace.name }
    return true
  }),
}))

vi.mock('../chatSessionNavigation', () => ({
  enterChatSession: vi.fn(async (
    spaceId: string,
    sessionId: string,
    options?: {
      failureToast?: { title: string; description?: string; variant?: string }
      sessionFailureMessage?: string
      sessionNotFoundMessage?: string
      verifySessionExists?: boolean
      messageId?: string
      highlightMessage?: boolean
      loadContextWindow?: number
    },
  ) => {
    if (state.selectedSpace?.id !== spaceId) {
      const targetSpace = state.spaces.find((item) => item.id === spaceId)
      if (!targetSpace) {
        if (options?.failureToast) {
          mockToast({
            title: options.failureToast.title,
            description: options.failureToast.description,
            variant: options.failureToast.variant,
          })
        }
        return 0
      }
      mockSelectSpace(targetSpace)
      state.selectedSpace = { id: targetSpace.id, name: targetSpace.name }
    }
    try {
      await mockSelectSession(spaceId, sessionId)
    } catch {
      mockToastError(options?.sessionFailureMessage ?? '打开对话失败，请重试')
      return 0
    }
    return 1
  }),
}))

vi.mock('../openProjectTaskChatSession', () => ({
  openProjectTaskChatSession: mockOpenProjectTaskChatSession,
}))

vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: mockEnterTeamSpaceProject,
}))

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...mod,
    getConversationNavigationKind: mockGetConversationNavigationKind,
  }
})

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: { id: state.selectedOrganizationId },
      organizations: state.organizations,
      loadOrganizations: mockLoadOrganizations,
      selectOrganization: mockSelectOrganization,
    }),
  },
}))

vi.mock('@/services/agentContextSwitchGuard', () => ({
  runWithAgentContextSwitchGuard: mockRunWithAgentContextSwitchGuard,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}))

vi.mock('@/i18n', () => ({
  default: { t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key },
}))

vi.mock('@services/notificationApi', () => ({
  NotificationApiService: {},
}))

// ：标签桶写入改走 scope key。单测里 identity mock（与
// searchResultNavigation.test.ts 同款），断言仍按裸 spaceId 对照。
vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => spaceId,
}))

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  findSpaceIdForSession,
  navigateToChatSession,
  navigateToTarget,
  _resetNavigatingForTest,
} from '../notificationNavigation'
import { enterChatSession } from '../chatSessionNavigation'

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  _resetNavigatingForTest()
  mockSelectSession.mockResolvedValue(undefined)
  mockLoadSpaces.mockResolvedValue(undefined)
  mockLoadConversations.mockResolvedValue(undefined)
  mockLoadOrganizations.mockResolvedValue(undefined)
  mockSelectOrganization.mockImplementation(async (org: { id: string }) => {
    state.selectedOrganizationId = org.id
  })
  mockRunWithAgentContextSwitchGuard.mockImplementation(async (_kind, proceed) => {
    await proceed()
    return true
  })
  mockGetConversation.mockResolvedValue({ id: 'conv-1', type: 'direct' })
  mockGetConversationNavigationKind.mockReturnValue('dm')
  mockOpenResourceTab.mockImplementation(() => undefined)
  mockSelectSpaceById.mockImplementation(() => undefined)
  mockOpenSettings.mockImplementation(() => undefined)
  Object.defineProperty(window, 'tabtin', {
    value: {
      setAppearance: vi.fn().mockResolvedValue(undefined),
    },
    configurable: true,
    writable: true,
  })
  state.sessions = []
  state.sessionsBySpaceId = {}
  state.selectedSpace = null
  state.spaces = []
  state.conversations = []
  state.settingsIsOpen = false
  state.selectedOrganizationId = 'ws-1'
  state.organizations = [{ id: 'ws-1' }, { id: 'ws-2' }]
})

afterEach(() => {
  vi.useRealTimers()
})

// ===========================================================================
// findSpaceIdForSession
// ===========================================================================

describe('findSpaceIdForSession', () => {
  it('returns asId when session is found in first Space', () => {
    const map = {
      'as-1': [{ id: 'sess-a' }, { id: 'sess-b' }],
    }
    expect(findSpaceIdForSession(map, 'sess-a')).toBe('as-1')
  })

  it('returns asId when session is in a later Space', () => {
    const map = {
      'as-1': [{ id: 'sess-a' }],
      'as-2': [{ id: 'sess-b' }, { id: 'sess-target' }],
      'as-3': [{ id: 'sess-c' }],
    }
    expect(findSpaceIdForSession(map, 'sess-target')).toBe('as-2')
  })

  it('returns undefined when sessionId does not exist', () => {
    const map = {
      'as-1': [{ id: 'sess-a' }],
    }
    expect(findSpaceIdForSession(map, 'nonexistent')).toBeUndefined()
  })

  it('returns undefined for empty map', () => {
    expect(findSpaceIdForSession({}, 'sess-a')).toBeUndefined()
  })
})

// ===========================================================================
// navigateToChatSession
// ===========================================================================

describe('navigateToChatSession', () => {
  it('navigates with hint spaceId directly (same space)', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [{ id: 'as-1', name: 'A' }]

    await navigateToChatSession('sess-1', 'as-1')

    expect(mockSelectSpace).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('as-1', 'sess-1')
  })

  it('switches Space when hint differs from current', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [
      { id: 'as-1', name: 'A' },
      { id: 'as-2', name: 'B' },
    ]

    await navigateToChatSession('sess-2', 'as-2')

    expect(mockSelectSpace).toHaveBeenCalledWith({ id: 'as-2', name: 'B' })
    expect(mockSelectSession).toHaveBeenCalledWith('as-2', 'sess-2')
  })

  it('falls back to sessionsBySpaceId when hint is absent', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [
      { id: 'as-1', name: 'A' },
      { id: 'as-2', name: 'B' },
    ]
    state.sessionsBySpaceId = {
      'as-2': [{ id: 'sess-target', space_id: 'as-2' }],
    }

    await navigateToChatSession('sess-target')

    expect(mockSelectSpace).toHaveBeenCalledWith({ id: 'as-2', name: 'B' })
    expect(mockSelectSession).toHaveBeenCalledWith('as-2', 'sess-target')
  })

  it('falls back to current sessions when sessionsBySpaceId misses', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [{ id: 'as-1', name: 'A' }]
    state.sessions = [{ id: 'sess-local', space_id: 'as-1' }]

    await navigateToChatSession('sess-local')

    expect(mockSelectSpace).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('as-1', 'sess-local')
  })

  it('toasts error when spaceId cannot be resolved at all', async () => {
    state.selectedSpace = { id: 'as-1' }

    await navigateToChatSession('nonexistent')

    expect(mockToastError).toHaveBeenCalledWith('无法定位该对话，可能已被删除')
    expect(mockSelectSession).not.toHaveBeenCalled()
  })

  it('toasts error when target Space is archived/deleted', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [{ id: 'as-1', name: 'A' }]

    await navigateToChatSession('sess-1', 'as-deleted')

    expect(mockToast).toHaveBeenCalledWith({
      title: '该工作空间已不可访问，可能是私有、无权限、已归档或已删除',
      description: undefined,
      variant: 'destructive',
    })
    expect(mockSelectSession).not.toHaveBeenCalled()
  })

  it('blocks concurrent navigation (lock)', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [{ id: 'as-1', name: 'A' }]
    mockSelectSession.mockImplementation(() => new Promise(r => setTimeout(r, 50)))

    const p1 = navigateToChatSession('sess-1', 'as-1')
    const p2 = navigateToChatSession('sess-2', 'as-1')
    await Promise.all([p1, p2])

    expect(mockSelectSession).toHaveBeenCalledTimes(1)
    expect(mockSelectSession).toHaveBeenCalledWith('as-1', 'sess-1')
  })

  it('releases lock after completion so next call can proceed', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [{ id: 'as-1', name: 'A' }]

    await navigateToChatSession('sess-1', 'as-1')
    await navigateToChatSession('sess-2', 'as-1')

    expect(mockSelectSession).toHaveBeenCalledTimes(2)
  })

  it('toasts timeout and releases lock when navigation exceeds 10s', async () => {
    vi.useFakeTimers()
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [{ id: 'as-1', name: 'A' }]
    mockSelectSession.mockImplementation(() => new Promise(() => {}))

    const p = navigateToChatSession('sess-1', 'as-1')
    await vi.advanceTimersByTimeAsync(10_000)
    await p

    expect(mockToastError).toHaveBeenCalledWith('跳转超时，请重试')
  })

  it('toasts navigateFailed when session activation fails', async () => {
    state.selectedSpace = { id: 'as-1' }
    state.spaces = [{ id: 'as-1', name: 'A' }]
    mockSelectSession.mockRejectedValue(new Error('network failure'))

    await navigateToChatSession('sess-1', 'as-1')

    expect(mockToastError).toHaveBeenCalledWith('通知跳转失败')
  })
})

// ===========================================================================
// navigateToTarget
// ===========================================================================

describe('navigateToTarget', () => {
  describe('guard — early return for invalid targets', () => {
    it('returns immediately for null target', async () => {
      await navigateToTarget(null as any)
      expect(mockSelectSession).not.toHaveBeenCalled()
      expect(mockOpenResourceTab).not.toHaveBeenCalled()
    })

    it('returns immediately for undefined target', async () => {
      await navigateToTarget(undefined as any)
      expect(mockSelectSession).not.toHaveBeenCalled()
    })

    it('returns immediately when type is missing', async () => {
      await navigateToTarget({ id: 'x' } as any)
      expect(mockSelectSession).not.toHaveBeenCalled()
    })

    it('returns immediately when id is missing', async () => {
      await navigateToTarget({ type: 'tracker' } as any)
      expect(mockOpenResourceTab).not.toHaveBeenCalled()
    })
  })

  describe('settings page auto-close on navigation', () => {
    it('closes settings before navigating to chat-session when settings is open', async () => {
      state.settingsIsOpen = true
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget({ type: 'chat-session', id: 'sess-1', spaceId: 'as-1' })

      expect(mockCloseSettings).toHaveBeenCalled()
      expect(mockSelectSession).toHaveBeenCalledWith('as-1', 'sess-1')
    })

    it('does not close settings when navigating to settings target', async () => {
      state.settingsIsOpen = true

      await navigateToTarget({ type: 'settings', id: 'extensions' })

      expect(mockCloseSettings).not.toHaveBeenCalled()
      expect(mockOpenSettings).toHaveBeenCalledWith('extensions')
    })

    it('does not close settings when navigating to notification-panel target', async () => {
      state.settingsIsOpen = true

      await navigateToTarget({ type: 'notification-panel', id: '_' })

      expect(mockCloseSettings).not.toHaveBeenCalled()
      expect(mockSetIsPanelOpen).toHaveBeenCalledWith(true)
    })

    it('does not call closeSettings when settings is not open', async () => {
      state.settingsIsOpen = false
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget({ type: 'chat-session', id: 'sess-1', spaceId: 'as-1' })

      expect(mockCloseSettings).not.toHaveBeenCalled()
      expect(mockSelectSession).toHaveBeenCalledWith('as-1', 'sess-1')
    })

    it('closes settings before navigating to tracker when settings is open', async () => {
      state.settingsIsOpen = true
      state.selectedSpace = { id: 'as-1' }

      await navigateToTarget({ type: 'tracker', id: 't-1', spaceId: 'as-1' })

      expect(mockCloseSettings).toHaveBeenCalled()
      expect(mockOpenResourceTab).toHaveBeenCalled()
    })

    it('closes settings before navigating to agentspace-app when settings is open', async () => {
      state.settingsIsOpen = true
      state.selectedSpace = { id: 'as-1' }

      await navigateToTarget({ type: 'agentspace-app', id: 'tabinbox', spaceId: 'as-1' })

      expect(mockCloseSettings).toHaveBeenCalled()
      expect(mockOpenResourceTab).toHaveBeenCalled()
    })
  })

  describe('chat-session', () => {
    it('delegates to navigateToChatSession', async () => {
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget({ type: 'chat-session', id: 'sess-1', spaceId: 'as-1' })

      expect(mockSelectSession).toHaveBeenCalledWith('as-1', 'sess-1')
    })

    it('passes messageId into enterChatSession for highlight navigation', async () => {
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget({
        type: 'chat-session',
        id: 'sess-1',
        spaceId: 'as-1',
        messageId: 'msg-42',
      })

      expect(enterChatSession).toHaveBeenCalledWith(
        'as-1',
        'sess-1',
        expect.objectContaining({
          messageId: 'msg-42',
          highlightMessage: true,
          verifySessionExists: true,
          sessionNotFoundMessage: '该对话已被删除，无法跳转',
        }),
      )
    })

    it('opens a Project session in its Project context instead of the execution Workspace', async () => {
      await navigateToTarget({
        type: 'chat-session',
        id: 'sess-project-1',
        organizationId: 'ws-1',
        workspaceId: 'workspace-execution-1',
        projectId: 'project-1',
      })

      expect(mockEnterTeamSpaceProject).toHaveBeenCalledWith('project-1')
      expect(mockOpenProjectTaskChatSession).toHaveBeenCalledWith({
        projectId: 'project-1',
        organizationId: 'ws-1',
        sessionId: 'sess-project-1',
      })
      expect(enterChatSession).not.toHaveBeenCalled()
    })

    it('uses workspaceId for a non-Project session when the legacy spaceId is absent', async () => {
      state.selectedSpace = { id: 'workspace-1' }
      state.spaces = [{ id: 'workspace-1', name: 'Workspace' }]

      await navigateToTarget({
        type: 'chat-session',
        id: 'sess-workspace-1',
        workspaceId: 'workspace-1',
      })

      expect(mockSelectSession).toHaveBeenCalledWith('workspace-1', 'sess-workspace-1')
    })

    it('toasts navigateFailed when chat session activation fails', async () => {
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]
      mockSelectSession.mockRejectedValue(new Error('boom'))

      await navigateToTarget({ type: 'chat-session', id: 'sess-1', spaceId: 'as-1' })

      expect(mockToastError).toHaveBeenCalledWith('通知跳转失败')
    })
  })

  // Tracker 一刀切（波次 4 Stage 2）：legacy ``type: 'goal'`` / ``type: 'agenda'``
  // union 成员已从 NavigateTarget 删除，对应 dispatch case 也已下线，本处不再保留
  // 兼容测试块。主路径 ``type: 'tracker'`` 在下方 `describe('tracker (主路径)')`
  // 覆盖。

  describe('im-conversation', () => {
    it('delegates to SpaceListStore with the resolved conversation kind', async () => {
      await navigateToTarget({ type: 'im-conversation', id: 'conv-1' })

      expect(mockGetConversation).toHaveBeenCalledWith('conv-1')
      expect(mockSelectSpaceById).toHaveBeenCalledWith('dm', 'conv-1')
    })

    it('reveals the Messages panel instead of leaving canvas / app-focus visible', async () => {
      await navigateToTarget({ type: 'im-conversation', id: 'conv-1' })

      expect(mockOpenIM).toHaveBeenCalled()
      expect(mockSetChatSidePanelCollapsed).toHaveBeenCalledWith(false)
      expect(mockSetTaskViewModeForScope).toHaveBeenCalledWith('im:conv-1', 'chat-focus')
    })

    it('fails fast when target organization is missing', async () => {
      await navigateToTarget({ type: 'im-conversation', id: 'conv-1', organizationId: 'ws-missing' } as any)

      expect(mockToastError).toHaveBeenCalledWith('目标组织不存在或无权限访问')
      expect(mockGetConversation).not.toHaveBeenCalled()
      expect(mockSelectSpaceById).not.toHaveBeenCalled()
      expect(mockOpenIM).not.toHaveBeenCalled()
      expect(mockSetTaskViewModeForScope).not.toHaveBeenCalled()
    })

    it('取消 Agent 忙碌确认时不误报组织不存在', async () => {
      mockRunWithAgentContextSwitchGuard.mockResolvedValueOnce(false)

      await navigateToTarget({
        type: 'im-conversation',
        id: 'conv-1',
        organizationId: 'ws-2',
      } as any)

      expect(mockRunWithAgentContextSwitchGuard).toHaveBeenCalledWith('organization', expect.any(Function))
      expect(mockToastError).not.toHaveBeenCalled()
      expect(mockSelectOrganization).not.toHaveBeenCalled()
      expect(mockGetConversation).not.toHaveBeenCalled()
      expect(mockOpenIM).not.toHaveBeenCalled()
      expect(state.selectedOrganizationId).toBe('ws-1')
    })

    it('跨组织通知在守卫通过后切组织并进入会话', async () => {
      await navigateToTarget({
        type: 'im-conversation',
        id: 'conv-1',
        organizationId: 'ws-2',
      } as any)

      expect(mockRunWithAgentContextSwitchGuard).toHaveBeenCalled()
      expect(mockSelectOrganization).toHaveBeenCalledWith({ id: 'ws-2' })
      expect(mockGetConversation).toHaveBeenCalledWith('conv-1')
      expect(mockOpenIM).toHaveBeenCalled()
      expect(mockToastError).not.toHaveBeenCalled()
    })

    it('catches error and toasts', async () => {
      mockGetConversation.mockRejectedValueOnce(new Error('im error'))

      await navigateToTarget({ type: 'im-conversation', id: 'conv-1' })

      expect(mockToastError).toHaveBeenCalledWith('通知跳转失败')
      expect(mockOpenIM).not.toHaveBeenCalled()
    })
  })

  describe('im-contacts', () => {
    it('opens the incoming external contact requests tab', async () => {
      await navigateToTarget({ type: 'im-contacts', id: 'incoming' })

      expect(mockSetImContactsTab).toHaveBeenCalledWith('incoming')
      expect(mockSetImSidebarView).toHaveBeenCalledWith('contacts')
      expect(mockOpenIM).toHaveBeenCalled()
    })

    it('opens the outgoing external contact requests tab', async () => {
      await navigateToTarget({ type: 'im-contacts', id: 'outgoing' })

      expect(mockSetImContactsTab).toHaveBeenCalledWith('outgoing')
      expect(mockSetImSidebarView).toHaveBeenCalledWith('contacts')
      expect(mockOpenIM).toHaveBeenCalled()
    })
  })

  describe('extension', () => {
    it('opens resource tab when selectedSpace exists', async () => {
      state.selectedSpace = { id: 'as-1' }

      await navigateToTarget({ type: 'extension', id: 'ext-mail' })

      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', {
        type: 'ext-mail',
        id: 'ext-mail',
        title: 'ext-mail',
        meta: { spaceId: 'as-1' },
      })
      expect(mockActivateSpace).toHaveBeenCalledWith('as-1')
      expect(mockSetCurrentTab).toHaveBeenCalledWith('agent')
    })

    it('switches to target Agent Space before opening extension tab', async () => {
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-2', name: 'Space 2' }]

      await navigateToTarget({ type: 'extension', id: 'ext-mail', spaceId: 'as-2', route: 'thread-1' })

      expect(mockSelectSpace).toHaveBeenCalledWith({ id: 'as-2', name: 'Space 2' })
      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-2', {
        type: 'ext-mail',
        id: 'ext-mail',
        title: 'ext-mail',
        meta: { spaceId: 'as-2', route: 'thread-1' },
      })
    })

    it('uses统一失败反馈 when target Agent Space 不可用', async () => {
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget({ type: 'extension', id: 'ext-mail', spaceId: 'as-missing' })

      expect(mockToast).toHaveBeenCalledWith({
        title: '该工作空间已不可访问，可能是私有、无权限、已归档或已删除',
        description: undefined,
        variant: 'destructive',
      })
      expect(mockOpenResourceTab).not.toHaveBeenCalled()
    })

    it('toasts error when no Space is selected', async () => {
      state.selectedSpace = null

      await navigateToTarget({ type: 'extension', id: 'ext-mail' })

      expect(mockToastError).toHaveBeenCalledWith('该工作空间已不可访问，可能是私有、无权限、已归档或已删除')
      expect(mockOpenResourceTab).not.toHaveBeenCalled()
    })

    it('catches dynamic import error and toasts', async () => {
      state.selectedSpace = { id: 'as-1' }
      mockOpenResourceTab.mockImplementation(() => { throw new Error('tab error') })

      await navigateToTarget({ type: 'extension', id: 'ext-x' })

      expect(mockToastError).toHaveBeenCalledWith('通知跳转失败')
    })
  })

  describe('agentspace-app', () => {
    it('opens target app with space metadata', async () => {
      state.selectedSpace = { id: 'as-1' }

      await navigateToTarget({ type: 'agentspace-app', id: 'tabinbox', spaceId: 'as-1' })

      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', {
        type: 'tabinbox',
        id: 'tabinbox',
        title: 'tabinbox',
        meta: { spaceId: 'as-1' },
      })
    })

    it('passes route metadata for deep-linked app notifications', async () => {
      state.selectedSpace = { id: 'as-1' }

      await navigateToTarget({
        type: 'agentspace-app',
        id: 'tabinbox',
        spaceId: 'as-1',
        route: 'message/msg-1?threadId=thread-1',
      })

      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', {
        type: 'tabinbox',
        id: 'tabinbox',
        title: 'tabinbox',
        meta: {
          spaceId: 'as-1',
          route: 'message/msg-1?threadId=thread-1',
          notificationIntentKey: expect.any(Number),
        },
      })
    })

    // ====================================================================
    // Wave 6 二次续作 NEW-P0-1 (反思 14 极端复犯防线 / charter §4.4 "1 步可达"):
    //   navigator 必须把 artifactRef 抽出最具体的产物 ID 作为 openResourceTab.id,
    //   让 app handler renderPane 直接拿到具体产物 ID,而非跳到 app 主面板。
    //   一次续作把 artifactRef 透到 meta,但 app handler 0 处消费——本测试守护
    //   最末端消费(反思 20 教训:链路透传必须断言 openResourceTab 入参)。
    // ====================================================================
    describe('Wave 6 二次续作 NEW-P0-1: artifactRef → openResourceTab.id 透传', () => {
      it('tabmemo + memoId → openResourceTab.id = memoId(直接落到具体 memo)', async () => {
        state.selectedSpace = { id: 'as-1' }

        await navigateToTarget({
          type: 'agentspace-app',
          id: 'tabmemo',
          spaceId: 'as-1',
          artifactRef: { memoId: 'mem_2025_xyz' },
        } as any)

        expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', {
          type: 'tabmemo',
          id: 'mem_2025_xyz',  // ← 关键:不是 'tabmemo' 而是具体 memoId
          title: 'tabmemo',
          meta: expect.objectContaining({
            spaceId: 'as-1',
            artifactRef: { memoId: 'mem_2025_xyz' },
            notificationIntentKey: expect.any(Number),
          }),
        })
      })

      it('tabdoc + docId → openResourceTab.id = docId', async () => {
        state.selectedSpace = { id: 'as-1' }

        await navigateToTarget({
          type: 'agentspace-app',
          id: 'tabdoc',
          spaceId: 'as-1',
          artifactRef: { docId: 'doc_42' },
        } as any)

        expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
          type: 'tabdoc',
          id: 'doc_42',
        }))
      })

      it('tabslide + slideId → openResourceTab.id = slideId', async () => {
        state.selectedSpace = { id: 'as-1' }

        await navigateToTarget({
          type: 'agentspace-app',
          id: 'tabslide',
          spaceId: 'as-1',
          artifactRef: { slideId: 'slide_x' },
        } as any)

        expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
          type: 'tabslide',
          id: 'slide_x',
        }))
      })

      it('tabcode + codePath → openResourceTab.id = btoa(codePath) + meta.path = codePath', async () => {
        state.selectedSpace = { id: 'as-1' }
        const codePath = '/Users/me/proj/foo'

        await navigateToTarget({
          type: 'agentspace-app',
          id: 'tabcode',
          spaceId: 'as-1',
          artifactRef: { codePath },
        } as any)

        const expectedId = btoa(unescape(encodeURIComponent(codePath)))
        expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
          type: 'tabcode',
          id: expectedId,
          meta: expect.objectContaining({
            path: codePath,
            artifactRef: { codePath },
          }),
        }))
      })

      it('artifactRef 缺失 → 兜底用 app id(原行为,跳主面板)', async () => {
        state.selectedSpace = { id: 'as-1' }

        await navigateToTarget({
          type: 'agentspace-app',
          id: 'tabmemo',
          spaceId: 'as-1',
        } as any)

        expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
          type: 'tabmemo',
          id: 'tabmemo',  // ← 兜底:跳主面板
        }))
      })

      it('未知 app + artifactId → 用 artifactId 兜底', async () => {
        state.selectedSpace = { id: 'as-1' }

        await navigateToTarget({
          type: 'agentspace-app',
          id: 'tabsite',
          spaceId: 'as-1',
          artifactRef: { artifactId: 'site_42' },
        } as any)

        expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
          type: 'tabsite',
          id: 'site_42',
        }))
      })
    })
  })

  // ======================================================================
  // Wave 6 二次续作 NEW-P0-1 + 反思 20 防线 — **端到端集成测试**:
  //   envelope payload(含 artifact_ref camelCase) → resolver
  //   → navigator → 断言 openResourceTab 收到具体产物 ID。
  //   仅链路任何一层断在透传上都会让本测试失败。
  // ======================================================================
  describe('Wave 6 二次续作 NEW-P0-1 + 反思 20:envelope → resolver → navigator 端到端', () => {
    it('完整链路:tracker.run.completed envelope (含 artifact_ref.memoId) → openResourceTab id=memoId', async () => {
      // 模拟 envelope payload 被组装成 NotificationItem 的形态
      // (后端 tracker_notification.py 把 metadata.artifact_ref 设为 camelCase)
      const { resolveNotificationNavigateTarget } = await import('../notificationTargetResolver')
      const item = {
        type: 'tracker.run.completed',
        metadata: {
          tracker_id: 'g-42',
          skill_key: 'tabmemo.organize',
          tracker_event_status: 'completed',
          artifact_ref: { memoId: 'mem_e2e_001' },
        },
        organization_id: 'ws-1',
        space_id: 'as-1',
        navigate_to: undefined,
        source_extension_id: undefined,
      }
      const target = resolveNotificationNavigateTarget(item)
      expect(target).toBeDefined()
      expect(target!.type).toBe('agentspace-app')
      expect(target!.id).toBe('tabmemo')

      // 切换到目标 space 并执行 navigateToTarget(模拟用户点 Inbox 通知)
      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget(target!)

      // 反思 20 关键断言:openResourceTab 收到的 id 必须是**具体 memoId**,不是 'tabmemo'
      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
        type: 'tabmemo',
        id: 'mem_e2e_001',
        meta: expect.objectContaining({
          artifactRef: { memoId: 'mem_e2e_001' },
        }),
      }))
    })

    it('完整链路:无 artifact_ref → 兜底跳 app 主面板(向后兼容)', async () => {
      const { resolveNotificationNavigateTarget } = await import('../notificationTargetResolver')
      const target = resolveNotificationNavigateTarget({
        type: 'tracker.run.completed',
        metadata: {
          tracker_id: 'g-42',
          skill_key: 'tabmemo.organize',
          tracker_event_status: 'completed',
        },
        organization_id: 'ws-1',
        space_id: 'as-1',
        navigate_to: undefined,
        source_extension_id: undefined,
      })

      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget(target!)

      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
        type: 'tabmemo',
        id: 'tabmemo',  // 兜底:跳 app 主面板
      }))
    })

    it('完整链路:tabdoc + docId 端到端 → openResourceTab.id = docId', async () => {
      const { resolveNotificationNavigateTarget } = await import('../notificationTargetResolver')
      const target = resolveNotificationNavigateTarget({
        type: 'tracker.run.completed',
        metadata: {
          tracker_id: 'g-42',
          skill_key: 'tabdoc.write',
          tracker_event_status: 'completed',
          artifact_ref: { docId: 'doc_e2e_42' },
        },
        organization_id: 'ws-1',
        space_id: 'as-1',
        navigate_to: undefined,
        source_extension_id: undefined,
      })

      state.selectedSpace = { id: 'as-1' }
      state.spaces = [{ id: 'as-1', name: 'A' }]

      await navigateToTarget(target!)

      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
        type: 'tabdoc',
        id: 'doc_e2e_42',
      }))
    })
  })

  describe('notification-panel', () => {
    it('opens the notification panel', async () => {
      await navigateToTarget({ type: 'notification-panel', id: '_' })

      expect(mockSetIsPanelOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('resource-shared', () => {
    it('leaves Cloud Docs for the resource workbench before opening a foreign shared resource', async () => {
      state.selectedSpace = { id: 'host-space' }
      state.spaces = [{ id: 'host-space', name: 'Host', organization_id: 'ws-1' }]

      await navigateToTarget({
        type: 'resource-shared',
        id: 'foreign-table',
        resourceType: 'table',
        organizationId: 'ws-1',
        spaceId: 'owner-private-space',
      })

      expect(mockSetCurrentTab).toHaveBeenCalledWith('agent')
      expect(mockCloseAppPage).toHaveBeenCalled()
      expect(mockCloseIM).toHaveBeenCalled()
      expect(mockSetCurrentConversation).toHaveBeenCalledWith(null)
      expect(mockSetSidebarModeForOrganizationUser).toHaveBeenCalledWith(
        'ws-1',
        'user-1',
        'desktop',
      )
      expect(mockSetLastActiveSurface).toHaveBeenCalledWith(
        'desktop:organization:ws-1:user:user-1',
        'real_tab',
      )
      expect(mockSetCurrentTab.mock.invocationCallOrder[0]).toBeLessThan(
        mockOpenResourceTab.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      )
    })

    it('hydrates and uses a host Space from the notification target organization', async () => {
      state.selectedOrganizationId = 'ws-1'
      state.selectedSpace = { id: 'old-host-space' }
      state.spaces = [{
        id: 'old-host-space',
        name: 'Old organization host',
        organization_id: 'ws-1',
      }]
      mockLoadSpaces.mockImplementationOnce(async (organizationId: string) => {
        expect(organizationId).toBe('ws-2')
        state.spaces.push({
          id: 'target-host-space',
          name: 'Target organization host',
          organization_id: 'ws-2',
        })
      })

      await navigateToTarget({
        type: 'resource-shared',
        id: 'cross-org-document',
        resourceType: 'doc',
        organizationId: 'ws-2',
        spaceId: 'owner-private-space',
      })

      expect(mockSelectOrganization).toHaveBeenCalledWith({ id: 'ws-2' })
      expect(mockSelectSpace).toHaveBeenCalledWith(expect.objectContaining({
        id: 'target-host-space',
        organization_id: 'ws-2',
      }))
      expect(mockSelectSpace).not.toHaveBeenCalledWith(expect.objectContaining({
        id: 'old-host-space',
      }))
      expect(mockOpenResourceTab).toHaveBeenCalledWith(
        'desktop:organization:ws-2:user:user-1',
        expect.objectContaining({
          type: 'tabdoc',
          id: 'cross-org-document',
        }),
      )
    })

    it('preserves the TabData record comment intent for a foreign shared table', async () => {
      state.selectedSpace = { id: 'host-space' }
      state.spaces = [{ id: 'host-space', name: 'Host', organization_id: 'ws-1' }]

      await navigateToTarget({
        type: 'resource-shared',
        id: 'table-1',
        resourceType: 'table',
        organizationId: 'ws-1',
        recordId: 'record-1',
        commentId: 'comment-1',
        openComments: true,
      })

      expect(mockOpenResourceTab).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'tabdata',
          id: 'table-1',
          meta: expect.objectContaining({
            recordId: 'record-1',
            commentId: 'comment-1',
            openComments: true,
            notificationIntentKey: expect.any(Number),
            recordFocusRecordId: 'record-1',
            recordFocusRequestId: expect.stringMatching(/^record-focus:\d+:0$/),
          }),
        }),
      )
    })

    it('opens an organization-level shared document without a resource Space', async () => {
      state.selectedSpace = { id: 'host-space' }
      state.spaces = [{
        id: 'host-space',
        name: 'Host Space',
        organization_id: 'ws-1',
      }]

      await navigateToTarget({
        type: 'resource-shared',
        id: 'shared-doc',
        resourceType: 'doc',
        resourceTitle: 'Shared document',
        organizationId: 'ws-1',
      })

      expect(mockToastError).not.toHaveBeenCalledWith('通知跳转失败')
      expect(mockOpenResourceTab).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'tabdoc',
          id: 'shared-doc',
          title: 'Shared document',
          meta: expect.objectContaining({
            spaceId: undefined,
            organizationId: 'ws-1',
            foreignShared: true,
          }),
        }),
      )
    })

    it('publishes the exact TabDoc comment before opening a visible document', async () => {
      state.selectedSpace = { id: 'doc-space' }
      state.spaces = [{ id: 'doc-space', name: 'Docs', organization_id: 'ws-1' }]

      await navigateToTarget({
        type: 'resource-shared',
        id: 'doc-1',
        resourceType: 'doc',
        organizationId: 'ws-1',
        spaceId: 'doc-space',
        threadId: 'thread-1',
        commentId: 'comment-1',
        openComments: true,
      })

      expect(mockRequestCommentReveal).toHaveBeenCalledWith('doc-1', {
        threadId: 'thread-1',
        commentId: 'comment-1',
      })
      expect(mockRequestCommentReveal.mock.invocationCallOrder[0]).toBeLessThan(
        mockOpenResourceTab.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      )
    })

    it('publishes a fresh TabDoc comment request for a foreign shared document', async () => {
      state.selectedSpace = { id: 'host-space' }
      state.spaces = [{ id: 'host-space', name: 'Host', organization_id: 'ws-1' }]
      const target = {
        type: 'resource-shared' as const,
        id: 'foreign-doc',
        resourceType: 'doc' as const,
        organizationId: 'ws-1',
        spaceId: 'owner-private-space',
        threadId: 'thread-2',
        commentId: 'comment-2',
        openComments: true,
      }

      await navigateToTarget(target)
      await navigateToTarget(target)

      expect(mockRequestCommentReveal).toHaveBeenNthCalledWith(1, 'foreign-doc', {
        threadId: 'thread-2',
        commentId: 'comment-2',
      })
      expect(mockRequestCommentReveal).toHaveBeenNthCalledWith(2, 'foreign-doc', {
        threadId: 'thread-2',
        commentId: 'comment-2',
      })
    })

    it('keeps the resource Space when opening a private Workspace resource', async () => {
      state.selectedSpace = { id: 'host-space' }
      state.spaces = [{
        id: 'host-space',
        name: 'Host Space',
        organization_id: 'ws-1',
      }]

      await navigateToTarget({
        type: 'resource-shared',
        id: 'shared-table',
        resourceType: 'table',
        resourceTitle: 'Shared table',
        spaceId: 'owner-private-space',
        organizationId: 'ws-1',
      })

      expect(mockToastError).not.toHaveBeenCalledWith('通知跳转失败')
      expect(mockOpenResourceTab).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'tabdata',
          id: 'shared-table',
          meta: expect.objectContaining({
            spaceId: 'owner-private-space',
            organizationId: 'ws-1',
            foreignShared: true,
          }),
        }),
      )
    })
  })

  describe('tracker (主路径)', () => {
    it('opens Tracker detail with target id', async () => {
      state.selectedSpace = { id: 'as-1' }

      await navigateToTarget({ type: 'tracker', id: 't-1', spaceId: 'as-1' })

      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
        type: 'tabtracker',
        id: 't-1',
        meta: { spaceId: 'as-1', taskId: 't-1' },
      }))
    })

    it('打开 Tracker Run 通知对应的执行记录会话', async () => {
      state.selectedSpace = { id: 'as-1' }

      await navigateToTarget({
        type: 'tracker',
        id: 't-1',
        spaceId: 'as-1',
        runId: 'run-4',
        sessionId: 'session-run-4',
      })

      expect(enterChatSession).toHaveBeenCalledWith('as-1', 'session-run-4', {
        verifySessionExists: true,
        sessionFailureMessage: '打开自动化执行记录失败，请重试',
        initialScroll: 'first-message',
      })
      expect(mockOpenResourceTab).toHaveBeenCalledWith('as-1', expect.objectContaining({
        type: 'tabtracker',
        id: 't-1',
        meta: { spaceId: 'as-1', taskId: 't-1', runId: 'run-4' },
      }))
      expect(vi.mocked(enterChatSession).mock.invocationCallOrder[0])
        .toBeLessThan(mockOpenResourceTab.mock.invocationCallOrder[0])
    })

    it('toasts when opening Tracker fails', async () => {
      state.selectedSpace = { id: 'as-1' }
      mockOpenResourceTab.mockImplementation(() => { throw new Error('tracker error') })

      await navigateToTarget({ type: 'tracker', id: 't-1', spaceId: 'as-1' })

      expect(mockToastError).toHaveBeenCalledWith('通知跳转失败')
    })
  })

  describe('settings', () => {
    it('opens settings with route', async () => {
      await navigateToTarget({ type: 'settings', id: 'extensions', route: 'github' })

      expect(mockOpenSettings).toHaveBeenCalledWith('github')
    })

    it('opens settings with id when no route', async () => {
      await navigateToTarget({ type: 'settings', id: 'extensions' })

      expect(mockOpenSettings).toHaveBeenCalledWith('extensions')
    })
  })

  describe('unknown type', () => {
    it('does nothing for unrecognized target type', async () => {
      await navigateToTarget({ type: 'something-new', id: 'x' })

      expect(mockSelectSession).not.toHaveBeenCalled()
      expect(mockSelectSpaceById).not.toHaveBeenCalled()
      expect(mockOpenResourceTab).not.toHaveBeenCalled()
      expect(mockSetIsPanelOpen).not.toHaveBeenCalled()
    })
  })

})
