import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarConversationList } from './SidebarConversationList'
import { useAppPageStore } from '@stores/useAppPageStore'
import {
  clearAllLocallySubmittedSessions,
  rememberLocallySubmittedSession,
} from '@/stores/chat/session/locallySubmittedSessionRegistry'
import { resetOpenChatSessionIntentForTests } from '@/stores/chat/session/openChatSessionIntent'

type MockSession = {
  id: string
  title?: string | null
  space_id?: string | null
  workspace_id?: string | null
  message_count?: number | null
  last_message_at?: string | null
  updated_at?: string
  created_at?: string
  is_agent_mention_session?: boolean
}

type MockTaskListResponse = {
  tasks: Array<Record<string, unknown>>
  total: number
}

type MockSpace = {
  id: string
  name: string
  organization_id: string
  type?: string
  project_id?: string | null
  execution_space_id?: string | null
  is_default?: boolean
  is_companion?: boolean
  provisioning_source?: string | null
}

const mocks = vi.hoisted(() => {
  const chatState = {
    sessionsBySpaceId: { 'space-1': [] } as Record<string, MockSession[]>,
    excludedAgentMentionSessionIdsBySpaceId: {} as Record<string, string[]>,
    messagesBySessionId: {} as Record<string, Array<{ id: string; role: string; content: string }>>,
    trackerRunSessionsBySpaceId: {},
    trackerRunCountBySpaceId: {},
    trackerRunLoadingBySpaceId: {},
    trackerRunErrorBySpaceId: {},
    currentSessionId: 'session-1' as string | null,
    currentSessionIdBySpaceId: { 'space-1': 'session-1' } as Record<string, string | null>,
    draftSessionBySpaceId: { 'space-1': false } as Record<string, boolean>,
    draftExecutionSpaceIdByWorkspaceKey: {} as Record<string, string | null>,
    loadSessions: vi.fn<(spaceId: string, organizationId?: string) => Promise<void>>().mockResolvedValue(undefined),
    loadTrackerRunSessions: vi.fn(),
    selectSession: vi.fn(),
    getSessionById: vi.fn((sessionId: string) => {
      for (const list of Object.values(chatState.sessionsBySpaceId)) {
        const found = list.find(session => session.id === sessionId)
        if (found) return found
      }
      return undefined
    }),
    pinSessionInSpace: vi.fn((spaceId: string, session: MockSession) => {
      const existing = chatState.sessionsBySpaceId[spaceId] ?? []
      if (existing.some(item => item.id === session.id)) return
      chatState.sessionsBySpaceId = {
        ...chatState.sessionsBySpaceId,
        [spaceId]: [session, ...existing],
      }
    }),
    setCurrentSessionForSpace: vi.fn((spaceId: string, sessionId: string | null) => {
      chatState.currentSessionIdBySpaceId = {
        ...chatState.currentSessionIdBySpaceId,
        [spaceId]: sessionId,
      }
      chatState.currentSessionId = sessionId
    }),
    startDraftSessionForSpace: vi.fn(),
    setDraftExecutionSpaceForWorkspace: vi.fn((workspaceKey: string, spaceId: string | null) => {
      chatState.draftExecutionSpaceIdByWorkspaceKey = {
        ...chatState.draftExecutionSpaceIdByWorkspaceKey,
        [workspaceKey]: spaceId,
      }
    }),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessionPermanently: vi.fn(),
    forkSession: vi.fn(),
  }
  const spaceState = {
    spaces: [
      { id: 'space-1', name: 'Alpha Agent', organization_id: 'organization-1' },
      { id: 'space-2', name: 'Beta Agent', organization_id: 'organization-1' },
    ] as MockSpace[],
  }
  const spaceListState = {
    selectSpaceBySpaceId: vi.fn(() => true),
    activateSpace: vi.fn(),
    setState: vi.fn(),
  }
  const mainNavState = {
    currentTab: 'agent' as 'agent' | 'project',
    setCurrentTab: vi.fn((tab: 'agent' | 'project') => {
      mainNavState.currentTab = tab
    }),
  }
  const settingsState = {
    closeSettings: vi.fn(),
  }
  const imState = {
    closeIM: vi.fn(),
    setCurrentConversation: vi.fn(),
  }
  const uiState = {
    setChatSidePanelCollapsed: vi.fn(),
  }
  const spaceSettingsNav = {
    openSpaceSettingsIntent: vi.fn(),
  }
  const splitState = {
    pinnedSessionsBySpace: {},
    togglePinSession: vi.fn(),
  }
  const projectWorkspaceSelectionState = {
    selectedProjectId: null as string | null,
    activeTaskSessionId: null as string | null,
    setSelectedProjectId: vi.fn((projectId: string | null) => {
      projectWorkspaceSelectionState.selectedProjectId = projectId
    }),
    openTaskSession: vi.fn((sessionId: string) => {
      projectWorkspaceSelectionState.activeTaskSessionId = sessionId
    }),
  }
  const workbenchSceneState = {
    activateForegroundSpace: vi.fn(),
  }
  const projectApi = {
    listTasks: vi.fn(async (): Promise<MockTaskListResponse> => ({ tasks: [], total: 0 })),
  }
  const resetNewTaskDraftUi = vi.fn()
  const sessionAccessState = {
    bySessionId: {} as Record<string, { shareId: string; sessionId: string }>,
  }
  const organizationState = {
    selectedOrganization: { id: 'organization-1' },
  }
  const enterChatSession = vi.fn().mockResolvedValue(1)
  const alignChatPointerToWorkspace = vi.fn()
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  })

  return {
    chatState,
    spaceState,
    spaceListState,
    mainNavState,
    settingsState,
    imState,
    uiState,
    spaceSettingsNav,
    splitState,
    projectWorkspaceSelectionState,
    workbenchSceneState,
    projectApi,
    resetNewTaskDraftUi,
    sessionAccessState,
    organizationState,
    enterChatSession,
    alignChatPointerToWorkspace,
    toast,
  }
})

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    listTasks: (...args: unknown[]) => (
      mocks.projectApi.listTasks as (...callArgs: unknown[]) => Promise<MockTaskListResponse>
    )(...args),
  },
}))

vi.mock('@stores/chat/session/sessionAccessStore', () => ({
  useSessionAccessStore: Object.assign(
    (selector: (state: typeof mocks.sessionAccessState) => unknown) => selector(mocks.sessionAccessState),
    { getState: () => mocks.sessionAccessState },
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof mocks.organizationState) => unknown) => (
    selector(mocks.organizationState)
  ),
}))

vi.mock('@/services/chatSessionNavigation', () => ({
  enterChatSession: (...args: unknown[]) => mocks.enterChatSession(...args),
}))

vi.mock('@/stores/chat/session/reconcileSpacePointer', () => ({
  alignChatPointerToWorkspace: (...args: unknown[]) => mocks.alignChatPointerToWorkspace(...args),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: typeof mocks.chatState) => unknown) => selector(mocks.chatState),
    { getState: () => mocks.chatState },
  ),
}))

vi.mock('@stores/useSpaceStore', () => {
  const useSpaceStore = Object.assign(
    (selector: (state: typeof mocks.spaceState) => unknown) => selector(mocks.spaceState),
    { getState: () => mocks.spaceState },
  )
  return { useSpaceStore }
})

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: Object.assign(
    (selector: (state: typeof mocks.spaceListState) => unknown) => selector(mocks.spaceListState),
    {
      getState: () => mocks.spaceListState,
      setState: (...args: Parameters<typeof mocks.spaceListState.setState>) => mocks.spaceListState.setState(...args),
    },
  ),
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: Object.assign(
    (selector: (state: typeof mocks.mainNavState) => unknown) => selector(mocks.mainNavState),
    { getState: () => mocks.mainNavState },
  ),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: Object.assign(
    (selector: (state: typeof mocks.settingsState) => unknown) => selector(mocks.settingsState),
    { getState: () => mocks.settingsState },
  ),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: typeof mocks.imState) => unknown) => selector(mocks.imState),
    { getState: () => mocks.imState },
  ),
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: Object.assign(
    (selector: (state: typeof mocks.uiState) => unknown) => selector(mocks.uiState),
    { getState: () => mocks.uiState },
  ),
}))

vi.mock('@components/space-settings/spaceSettingsNavigation', () => ({
  openSpaceSettingsIntent: (...args: unknown[]) => mocks.spaceSettingsNav.openSpaceSettingsIntent(...args),
}))

vi.mock('@components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: Object.assign(
    (selector: (state: typeof mocks.projectWorkspaceSelectionState) => unknown) =>
      selector(mocks.projectWorkspaceSelectionState),
    { getState: () => mocks.projectWorkspaceSelectionState },
  ),
}))

vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: (projectId: string) => {
    mocks.mainNavState.setCurrentTab('agent')
    mocks.projectWorkspaceSelectionState.setSelectedProjectId(projectId)
    mocks.spaceListState.setState({
      selectedSpaceId: `team:${projectId}`,
      selectedSpaceKind: 'team',
    })
  },
}))

vi.mock('@stores/useAuthStore', () => ({
  selectIsAuthenticated: (state: { isAuthenticated: boolean }) => state.isAuthenticated,
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) => selector({ isAuthenticated: true }),
}))

vi.mock('@stores/useChatSplitStore', () => {
  const useChatSplitStore = Object.assign(
    (selector: (state: typeof mocks.splitState) => unknown) => selector(mocks.splitState),
    { getState: () => mocks.splitState },
  )
  return { useChatSplitStore }
})

vi.mock('@/stores/useWorkbenchSceneStore', () => ({
  useWorkbenchSceneStore: Object.assign(
    (selector: (state: typeof mocks.workbenchSceneState) => unknown) => selector(mocks.workbenchSceneState),
    {
      getState: () => mocks.workbenchSceneState,
      subscribe: vi.fn(() => () => undefined),
    },
  ),
}))

vi.mock('@components/chat/session/ChatSidebarTrackersSection', () => ({
  ChatSidebarTrackersSection: ({
    onSelectRun,
  }: {
    onSelectRun?: (spaceId: string, sessionId: string) => void | Promise<void>
  }) => (
    <div data-testid="tracker-section">
      <button
        type="button"
        onClick={() => { void onSelectRun?.('space-2', 'tracker-run-1') }}
      >
        执行记录
      </button>
    </div>
  ),
}))

vi.mock('@components/chat/session/ChatSidebarSharedTasksSection', () => ({
  ChatSidebarSharedTasksSection: ({
    onSelectSharedSession,
  }: {
    onSelectSharedSession: (selection: { share: Record<string, unknown> }) => void
  }) => (
    <button
      type="button"
      onClick={() => onSelectSharedSession({
        share: {
          id: 'share-1',
          session_id: 'shared-session-1',
          session_title: '共享任务',
          workspace_id: 'owner-workspace',
          workspace_name: '分享者 Workspace',
          owner_user_id: 'owner-1',
          owner_display_name: '分享者',
        },
      })}
    >
      共享任务
    </button>
  ),
}))

vi.mock('@components/sidebar/NewSpaceButton', () => ({
  NewSpaceButton: ({ variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button type="button" {...props}>新建 Space</button>
  ),
}))

vi.mock('@components/layout/resetNewTaskDraftUi', () => ({
  resetNewTaskDraftUi: (...args: unknown[]) => mocks.resetNewTaskDraftUi(...args),
}))

vi.mock('@components/ui', () => ({
  toast: mocks.toast,
}))

type ChatSessionSwitcherMockProps = {
  sessions: Array<{ id: string; title?: string; space_id?: string | null }>
  currentSessionId?: string | null
  spaceNameById?: Record<string, string>
  spaceSectionTitle?: string
  spaceSectionTitleByKey?: Record<string, string>
  spaceSectionKeyById?: Record<string, string>
  createSpaceActionBySectionKey?: Record<string, React.ReactNode>
  draftBadgeSpaceId?: string | null
  workspaceHighlightSpaceId?: string | null
  showDraftSession?: boolean
  onCreateSession?: () => void
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  onSelectSession: (sessionId: string) => void | Promise<void>
  onForkSession?: (sessionId: string) => void | Promise<void>
  onCreateSessionInSpace?: (spaceId: string) => void
  canCreateSessionInSpace?: (spaceId: string) => boolean
  createSpaceAction?: React.ReactNode
  onOpenSpaceSettings?: (spaceId: string) => void
  listContent?: 'all' | 'sessions' | 'trackerRuns'
  listFooter?: React.ReactNode
}

vi.mock('@components/chat/session/ChatSessionSwitcher', () => ({
  ChatSessionSwitcher: ({
    sessions,
    currentSessionId,
    spaceNameById,
    spaceSectionTitle,
    spaceSectionTitleByKey,
    spaceSectionKeyById,
    draftBadgeSpaceId,
    workspaceHighlightSpaceId,
    showDraftSession,
    onCreateSession,
    onDeleteSession,
    onSelectSession,
    onForkSession,
    onCreateSessionInSpace,
    canCreateSessionInSpace,
    createSpaceAction,
    createSpaceActionBySectionKey,
    onOpenSpaceSettings,
    listContent = 'all',
    listFooter,
  }: ChatSessionSwitcherMockProps) => (
    <div
      data-testid={listContent === 'trackerRuns' ? 'tracker-run-switcher' : 'session-switcher'}
      data-space-names={JSON.stringify(spaceNameById)}
      data-space-section-title={spaceSectionTitle ?? ''}
      data-space-section-titles={JSON.stringify(spaceSectionTitleByKey)}
      data-space-section-keys={JSON.stringify(spaceSectionKeyById)}
      data-draft-badge-space-id={draftBadgeSpaceId ?? ''}
      data-workspace-highlight-space-id={workspaceHighlightSpaceId === undefined ? 'auto' : (workspaceHighlightSpaceId ?? '')}
      data-show-draft-session={showDraftSession ? 'true' : 'false'}
      data-has-create-session={onCreateSession ? 'true' : 'false'}
      data-has-create-session-in-space={onCreateSessionInSpace ? 'true' : 'false'}
      data-session-ids={JSON.stringify(sessions.map(session => session.id))}
      data-current-session-id={currentSessionId ?? ''}
    >
      {listContent !== 'trackerRuns' && (
        <>
          {onCreateSession && <button type="button" onClick={onCreateSession}>新任务</button>}
          {createSpaceAction}
          {Object.entries(createSpaceActionBySectionKey ?? {}).map(([key, action]) => (
            <React.Fragment key={key}>{action}</React.Fragment>
          ))}
          {Object.keys(spaceNameById ?? {}).map(spaceId => (
            <React.Fragment key={spaceId}>
              <button type="button">
                折叠 {spaceNameById?.[spaceId]}
              </button>
              {onCreateSessionInSpace && (canCreateSessionInSpace?.(spaceId) ?? true) ? (
                <button type="button" onClick={() => onCreateSessionInSpace(spaceId)}>
                  新建任务 {spaceNameById?.[spaceId]}
                </button>
              ) : null}
              <button type="button" onClick={() => onOpenSpaceSettings?.(spaceId)}>
                设置 {spaceNameById?.[spaceId]}
              </button>
            </React.Fragment>
          ))}
          {sessions.map(session => (
            <button key={session.id} type="button" onClick={() => { void onSelectSession(session.id) }}>
              {session.title}
            </button>
          ))}
          {sessions.map(session => (
            <button key={`${session.id}:fork`} type="button" onClick={() => { void onForkSession?.(session.id) }}>
              Fork {session.title}
            </button>
          ))}
          {sessions.map(session => (
            <button
              key={`${session.id}:archive`}
              type="button"
              onClick={() => {
                void Promise.resolve(onDeleteSession?.(session.id)).catch((error: unknown) => {
                  mocks.toast.error(error instanceof Error ? error.message : String(error))
                })
              }}
            >
              归档 {session.title}
            </button>
          ))}
          {listFooter}
        </>
      )}
    </div>
  ),
}))

describe('SidebarConversationList', () => {
  beforeEach(() => {
    resetOpenChatSessionIntentForTests()
    clearAllLocallySubmittedSessions()
    mocks.chatState.sessionsBySpaceId = { 'space-1': [] }
    mocks.chatState.excludedAgentMentionSessionIdsBySpaceId = {}
    mocks.chatState.messagesBySessionId = {}
    mocks.chatState.currentSessionId = 'session-1'
    mocks.chatState.currentSessionIdBySpaceId = { 'space-1': 'session-1' }
    mocks.chatState.draftSessionBySpaceId = { 'space-1': false }
    mocks.chatState.draftExecutionSpaceIdByWorkspaceKey = {}
    mocks.spaceState.spaces = [
      { id: 'space-1', name: 'Alpha Agent', organization_id: 'organization-1' },
      { id: 'space-2', name: 'Beta Agent', organization_id: 'organization-1' },
    ]
    mocks.chatState.loadSessions.mockReset()
    mocks.chatState.loadSessions.mockImplementation(async (spaceId: string) => {
      if (mocks.chatState.sessionsBySpaceId[spaceId] !== undefined) return
      mocks.chatState.sessionsBySpaceId = {
        ...mocks.chatState.sessionsBySpaceId,
        [spaceId]: [],
      }
    })
    mocks.chatState.selectSession.mockClear()
    mocks.chatState.pinSessionInSpace.mockClear()
    mocks.chatState.setCurrentSessionForSpace.mockClear()
    mocks.chatState.startDraftSessionForSpace.mockClear()
    mocks.chatState.setDraftExecutionSpaceForWorkspace.mockClear()
    mocks.chatState.forkSession.mockClear()
    mocks.chatState.deleteSession.mockReset()
    mocks.chatState.deleteSession.mockResolvedValue(undefined)
    mocks.toast.mockClear()
    mocks.toast.success.mockClear()
    mocks.toast.error.mockClear()
    mocks.splitState.pinnedSessionsBySpace = {}
    mocks.splitState.togglePinSession.mockClear()
    mocks.spaceListState.selectSpaceBySpaceId.mockClear()
    mocks.spaceListState.activateSpace.mockClear()
    mocks.spaceListState.setState.mockClear()
    mocks.workbenchSceneState.activateForegroundSpace.mockClear()
    mocks.mainNavState.currentTab = 'agent'
    mocks.mainNavState.setCurrentTab.mockClear()
    mocks.projectWorkspaceSelectionState.selectedProjectId = null
    mocks.projectWorkspaceSelectionState.setSelectedProjectId.mockClear()
    mocks.projectApi.listTasks.mockReset()
    mocks.projectApi.listTasks.mockResolvedValue({ tasks: [], total: 0 })
    mocks.settingsState.closeSettings.mockClear()
    mocks.imState.closeIM.mockClear()
    mocks.imState.setCurrentConversation.mockClear()
    mocks.uiState.setChatSidePanelCollapsed.mockClear()
    mocks.spaceSettingsNav.openSpaceSettingsIntent.mockClear()
    mocks.resetNewTaskDraftUi.mockClear()
    mocks.enterChatSession.mockReset().mockResolvedValue(1)
    mocks.alignChatPointerToWorkspace.mockClear()
    mocks.sessionAccessState.bySessionId = {}
    useAppPageStore.setState({ activePage: null, activeProjectId: null })
  })

  it('选中共享任务时取消工作空间会话和新任务选中态', () => {
    const scopeKey = 'desktop:organization-1:user:user-1'
    mocks.chatState.currentSessionId = 'shared-session-1'
    mocks.chatState.draftSessionBySpaceId = { 'space-1': true }
    mocks.sessionAccessState.bySessionId = {
      'shared-session-1': {
      shareId: 'share-1',
      sessionId: 'shared-session-1',
      },
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey={scopeKey} />)

    const switcher = screen.getByTestId('session-switcher')
    expect(switcher.getAttribute('data-current-session-id')).toBe('')
    expect(switcher.getAttribute('data-show-draft-session')).toBe('false')
    expect(switcher.getAttribute('data-workspace-highlight-space-id')).toBe('')
  })

  it('点击自动化 Run 使用统一历史会话导航并定位首条消息', async () => {
    const onOpenConversationWorkspace = vi.fn()
    render(
      <SidebarConversationList
        spaceId="space-1"
        tabScopeKey="desktop:organization-1:user:user-1"
        onOpenConversationWorkspace={onOpenConversationWorkspace}
      />,
    )

    fireEvent.click(screen.getByText('执行记录'))

    await waitFor(() => {
      expect(mocks.enterChatSession).toHaveBeenCalledWith('space-2', 'tracker-run-1', {
        organizationId: 'organization-1',
        draftScopeKey: 'conversation:draft:space-1',
        initialScroll: 'first-message',
      })
    })
    expect(mocks.chatState.selectSession).not.toHaveBeenCalled()
    expect(onOpenConversationWorkspace).toHaveBeenCalledTimes(1)
  })

  it('#11070 点击协作任务仍按任务入口打开，不依赖 IM 会话', async () => {
    mocks.chatState.draftSessionBySpaceId = { 'space-1': true }

    render(
      <SidebarConversationList
        spaceId="space-1"
        tabScopeKey="desktop:organization-1:user:user-1"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '共享任务' }))

    await waitFor(() => expect(mocks.enterChatSession).toHaveBeenCalledWith('space-1', 'shared-session-1', {
      draftScopeKey: 'conversation:draft:space-1',
      organizationId: 'organization-1',
      verifySessionExists: true,
      sharedAccess: {
        shareId: 'share-1',
        organizationId: 'organization-1',
        workspaceId: 'owner-workspace',
        workspaceName: '分享者 Workspace',
        ownerUserId: 'owner-1',
        ownerDisplayName: '分享者',
        role: 'grantee',
      },
    }))
    expect(mocks.mainNavState.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(mocks.chatState.selectSession).not.toHaveBeenCalled()
  })

  it('Workspace 分组标题不再接管导航，具体任务仍由会话行进入', () => {
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'session-1', title: 'Alpha 对话', space_id: 'space-1', message_count: 1 }],
      'space-2': [
        {
          id: 'session-2-old',
          title: 'Beta 旧对话',
          space_id: 'space-2',
          message_count: 1,
          last_message_at: '2026-07-12T08:00:00Z',
        },
        {
          id: 'session-2-latest',
          title: 'Beta 最近对话',
          space_id: 'space-2',
          message_count: 1,
          last_message_at: '2026-07-13T08:00:00Z',
        },
      ],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    expect(screen.getByRole('button', { name: '折叠 Beta Agent' })).toBeTruthy()
    expect(mocks.chatState.selectSession).not.toHaveBeenCalled()
    expect(mocks.spaceListState.selectSpaceBySpaceId).not.toHaveBeenCalled()
    expect(mocks.workbenchSceneState.activateForegroundSpace).not.toHaveBeenCalled()
    expect(mocks.chatState.setDraftExecutionSpaceForWorkspace).not.toHaveBeenCalled()
    expect(mocks.chatState.startDraftSessionForSpace).not.toHaveBeenCalled()
  })

  it('聚合当前团队所有 Space 的对话，并按被点击对话的 Space 选择会话', () => {
    const onOpenConversationWorkspace = vi.fn()
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'session-1', title: 'Alpha 对话', space_id: 'space-1', message_count: 1 }],
      'space-2': [{ id: 'session-2', title: 'Beta 对话', space_id: 'space-2', message_count: 1 }],
    }

    render(
      <SidebarConversationList
        spaceId="space-1"
        tabScopeKey="desktop:organization-1:user:user-1"
        onOpenConversationWorkspace={onOpenConversationWorkspace}
      />,
    )

    expect(screen.getByText('Alpha 对话')).toBeTruthy()
    expect(screen.getByText('Beta 对话')).toBeTruthy()
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-names')).toContain('Beta Agent')

    fireEvent.click(screen.getByText('Beta 对话'))

    expect(mocks.settingsState.closeSettings).toHaveBeenCalled()
    expect(mocks.mainNavState.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(mocks.imState.closeIM).toHaveBeenCalled()
    expect(mocks.imState.setCurrentConversation).toHaveBeenCalledWith(null)
    expect(mocks.spaceListState.selectSpaceBySpaceId).toHaveBeenCalledWith('space-2')
    expect(mocks.spaceListState.activateSpace).not.toHaveBeenCalled()
    expect(mocks.alignChatPointerToWorkspace).not.toHaveBeenCalled()
    expect(mocks.chatState.startDraftSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.chatState.selectSession).not.toHaveBeenCalled()
    expect(mocks.enterChatSession).toHaveBeenCalledWith('space-2', 'session-2', expect.objectContaining({
      draftScopeKey: 'conversation:draft:space-1',
      organizationId: 'organization-1',
    }))
    expect(onOpenConversationWorkspace).toHaveBeenCalledTimes(1)
  })

  it('#11321 activity 写入的 mention 会话不进任务侧栏，仅标题像私信的普通任务仍可见', () => {
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [
        { id: 'session-normal', title: '写周报', space_id: 'space-1', message_count: 1 },
        {
          id: 'session-mention',
          title: '[私信@小Tin]',
          space_id: 'space-1',
          message_count: 1,
          is_agent_mention_session: true,
        },
        {
          id: 'session-title-only',
          title: '[私信@看起来像]',
          space_id: 'space-1',
          message_count: 1,
        },
      ],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    expect(screen.getByText('写周报')).toBeTruthy()
    expect(screen.getByText('[私信@看起来像]')).toBeTruthy()
    expect(screen.queryByText('[私信@小Tin]')).toBeNull()
  })

  it('普通 Workspace 导航不展示 Project 伴生 Workspace', () => {
    mocks.spaceState.spaces = [
      { id: 'space-1', name: '默认工作空间', organization_id: 'organization-1', type: 'workspace' },
      {
        id: 'project-workspace-1',
        name: '上山 项目的默认工作空间',
        organization_id: 'organization-1',
        type: 'workspace',
        project_id: 'project-1',
        is_companion: true,
        provisioning_source: 'system_project',
      },
      {
        id: 'task-workspace-1',
        name: '海边 项目的默认工作空间',
        organization_id: 'organization-1',
        type: 'workspace',
        project_id: 'project-2',
        is_companion: true,
        provisioning_source: 'system_project',
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [
        { id: 'personal-session', title: '个人日常', space_id: 'space-1', message_count: 1 },
      ],
      'project-workspace-1': [
        { id: 'private-task-session', title: '[Task] 爬山前的准备', space_id: 'project-workspace-1', message_count: 1 },
      ],
      'task-workspace-1': [
        { id: 'beach-task-session', title: '[Task] 去海边玩', space_id: 'task-workspace-1', message_count: 1 },
      ],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    const switcher = screen.getByTestId('session-switcher')
    expect(switcher.getAttribute('data-space-names')).toContain('默认工作空间')
    expect(switcher.getAttribute('data-space-names')).not.toContain('上山 项目的默认工作空间')
    expect(switcher.getAttribute('data-space-names')).not.toContain('海边 项目的默认工作空间')
    expect(screen.getByText('个人日常')).toBeTruthy()
    expect(screen.queryByText('[Task] 爬山前的准备')).toBeNull()
    expect(screen.queryByText('[Task] 去海边玩')).toBeNull()
  })

  it('普通 Workspace 树不展示归属于其他成员 Workspace 的共享会话', () => {
    mocks.spaceState.spaces = [
      { id: 'viewer-workspace', name: '我的工作空间', organization_id: 'organization-1', type: 'workspace' },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'viewer-workspace': [
        {
          id: 'owned-session',
          title: '我的任务',
          space_id: 'viewer-workspace',
          workspace_id: 'viewer-workspace',
          message_count: 1,
        },
        {
          id: 'shared-session',
          title: '共享任务',
          space_id: 'owner-workspace',
          workspace_id: 'owner-workspace',
          message_count: 1,
        },
      ],
    }

    render(
      <SidebarConversationList
        spaceId="viewer-workspace"
        tabScopeKey="desktop:organization-1:user:user-1"
      />,
    )

    const switcher = screen.getByTestId('session-switcher')
    expect(switcher.getAttribute('data-session-ids')).toBe('["owned-session"]')
  })

  it('未进 Project 时侧栏不展示 PROJECT 段，入口只在协作', () => {
    mocks.spaceState.spaces = [
      { id: 'space-1', name: '默认工作空间', organization_id: 'organization-1', type: 'workspace' },
      {
        id: 'team-space-1',
        name: '上山',
        organization_id: 'organization-1',
        type: 'team_space',
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [
        { id: 'personal-session', title: '个人日常', space_id: 'space-1', message_count: 1 },
      ],
      'team-space-1': [
        { id: 'team-session', title: '项目讨论', space_id: 'team-space-1', message_count: 1 },
      ],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    const switcher = screen.getByTestId('session-switcher')
    expect(switcher.getAttribute('data-space-section-titles')).toBe('{"workspace":"工作空间"}')
    expect(switcher.getAttribute('data-space-names')).toContain('默认工作空间')
    expect(switcher.getAttribute('data-space-names')).not.toContain('上山')
    expect(screen.getByText('个人日常')).toBeTruthy()
    expect(screen.queryByText('项目讨论')).toBeNull()
  })

  it('普通工作台恢复到伴生工作空间时回退到默认工作空间', async () => {
    mocks.spaceState.spaces = [
      {
        id: 'project-workspace-1',
        name: '发布 的伴生工作空间',
        organization_id: 'organization-1',
        type: 'workspace',
        project_id: 'project-1',
        is_companion: true,
        provisioning_source: 'system_project',
      },
      {
        id: 'space-default',
        name: '默认工作空间',
        organization_id: 'organization-1',
        type: 'workspace',
        is_default: true,
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'project-workspace-1': [],
      'space-default': [],
    }

    render(
      <SidebarConversationList
        spaceId="project-workspace-1"
        tabScopeKey="desktop:organization-1:user:user-1"
      />,
    )

    await waitFor(() => {
      expect(mocks.spaceListState.selectSpaceBySpaceId).toHaveBeenCalledWith('space-default')
    })
    expect(mocks.workbenchSceneState.activateForegroundSpace).toHaveBeenCalledWith('space-default')
    expect(mocks.chatState.setDraftExecutionSpaceForWorkspace).toHaveBeenCalledWith(
      'desktop:organization-1:user:user-1',
      'space-default',
    )
  })

  it('点击当前个人会话也会从Project 详情页回到普通对话模式', () => {
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'session-1', title: 'Alpha 对话', space_id: 'space-1', message_count: 1 }],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    fireEvent.click(screen.getByText('Alpha 对话'))

    expect(mocks.settingsState.closeSettings).toHaveBeenCalled()
    expect(mocks.mainNavState.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(mocks.imState.closeIM).toHaveBeenCalled()
    expect(mocks.imState.setCurrentConversation).toHaveBeenCalledWith(null)
    expect(mocks.spaceListState.activateSpace).toHaveBeenCalledWith('space-1')
    expect(mocks.alignChatPointerToWorkspace).not.toHaveBeenCalled()
    expect(mocks.chatState.selectSession).not.toHaveBeenCalled()
    expect(mocks.enterChatSession).toHaveBeenCalledWith('space-1', 'session-1', expect.objectContaining({
      draftScopeKey: 'conversation:draft:space-1',
    }))
  })

  it('#10951 侧栏点指定会话不先回到 Workspace 对齐，空桶也不会开草稿', async () => {
    mocks.chatState.currentSessionId = 'session-other'
    mocks.chatState.currentSessionIdBySpaceId = { 'space-1': 'dead-pointer-repro' }
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'session-1', title: 'Alpha 对话', space_id: 'space-1', message_count: 1 }],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)
    fireEvent.click(screen.getByText('Alpha 对话'))

    expect(mocks.alignChatPointerToWorkspace).not.toHaveBeenCalled()
    expect(mocks.chatState.startDraftSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.enterChatSession).toHaveBeenCalledWith('space-1', 'session-1', expect.objectContaining({
      organizationId: 'organization-1',
    }))
  })

  it('归档失败时展示原因，不让错误冒泡成按钮无反馈', async () => {
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'session-1', title: 'Alpha 对话', space_id: 'space-1', message_count: 1 }],
    }
    mocks.splitState.pinnedSessionsBySpace = { 'space-1': ['session-1'] }
    mocks.chatState.deleteSession.mockRejectedValue(new Error('任务仍在运行，停止失败后不能归档'))

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    fireEvent.click(screen.getByRole('button', { name: '归档 Alpha 对话' }))

    await waitFor(() => {
      expect(mocks.toast.error).toHaveBeenCalledWith('任务仍在运行，停止失败后不能归档')
    })
    expect(mocks.chatState.deleteSession).toHaveBeenCalledWith('space-1', 'session-1')
    expect(mocks.splitState.togglePinSession).not.toHaveBeenCalled()
  })

  it('Project 沉浸态隐去 WORKSPACE；零任务时不套项目对话分组', async () => {
    mocks.spaceState.spaces = [
      { id: 'space-1', name: '默认 Space', organization_id: 'organization-1', type: 'workspace' },
      {
        id: 'team-space-1',
        name: '发布Project',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'personal-session-1', title: '个人旧对话', space_id: 'space-1', message_count: 1 }],
      'team-space-1': [{ id: 'team-session-1', title: '发布任务对话', space_id: 'team-space-1', message_count: 1 }],
    }
    mocks.chatState.currentSessionId = 'team-session-1'
    mocks.chatState.currentSessionIdBySpaceId = { 'team-space-1': 'team-session-1' }

    render(<SidebarConversationList spaceId="team-space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    await waitFor(() => {
      expect(mocks.projectApi.listTasks).toHaveBeenCalledWith('team-space-1', false)
    })
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-section-titles')).toBeNull()
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-names')).toBeNull()
    expect(screen.queryByText('个人旧对话')).toBeNull()
    expect(screen.getByText('发布任务对话')).toBeTruthy()

    fireEvent.click(screen.getByText('发布任务对话'))

    expect(mocks.settingsState.closeSettings).toHaveBeenCalled()
    expect(mocks.mainNavState.setCurrentTab).toHaveBeenLastCalledWith('agent')
    expect(mocks.projectWorkspaceSelectionState.openTaskSession).toHaveBeenCalledWith('team-session-1')
    expect(mocks.uiState.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    expect(mocks.spaceListState.setState).toHaveBeenCalledWith({
      selectedSpaceId: 'team:team-space-1',
      selectedSpaceKind: 'team',
    })
    expect(mocks.projectWorkspaceSelectionState.selectedProjectId).toBe('team-space-1')
    expect(mocks.spaceListState.activateSpace).not.toHaveBeenCalled()
    expect(mocks.spaceListState.selectSpaceBySpaceId).not.toHaveBeenCalled()
    // 已是当前会话：只挂 Task rail，不再重复 select
    expect(mocks.chatState.selectSession).not.toHaveBeenCalled()
  })

  it('Project 沉浸态在 conversations 无 session_id 时仍按任务标题分组', async () => {
    mocks.spaceState.spaces = [
      {
        id: 'team-space-1',
        name: '上山',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'team-space-1': [
        {
          id: 'sess-task-123',
          title: '[Task] 123',
          space_id: 'companion-ws',
          workspace_id: 'companion-ws',
          message_count: 2,
        },
      ],
    }
    mocks.projectApi.listTasks.mockResolvedValue({
      tasks: [{
        id: 'task-123',
        project_id: 'team-space-1',
        title: '123',
        description: '',
        priority: 'medium',
        created_by: { id: 'user-1', name: 'Owner' },
        responsible_user: { id: 'user-2', name: '师傅2' },
        assignment_status: 'accepted',
        work_status: 'blocked',
        selected_agent: { id: 'agent-1', name: '小Tin' },
        project_workspace: null,
        workspace_confirmed: true,
        execution_ready: true,
        result_summary: '',
        result_visibility: 'private',
        latest_run: null,
        conversations: [{
          session_id: null,
          run_id: 'run-1',
          kind: 'execution',
          run_status: 'failed',
          rerun_of_id: null,
          title: '[Task] 123',
          is_active: false,
          created_at: '2026-07-21T00:00:00Z',
        }],
        deliverables: [],
        version: 1,
        created_at: '2026-07-20T00:00:00Z',
        updated_at: '2026-07-21T01:00:00Z',
      }],
      total: 1,
    })

    render(<SidebarConversationList spaceId="team-space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    await waitFor(() => {
      // 组内展示缩短为「执行」，不再重复 [Task] 123
      expect(screen.getByText('执行')).toBeTruthy()
    })
    const spaceNames = screen.getByTestId('session-switcher').getAttribute('data-space-names') ?? ''
    expect(spaceNames).toContain('123')
    expect(spaceNames).not.toContain('项目对话')
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-section-keys')).toContain(
      '"task-123":"conversations"',
    )
  })

  it('Project 沉浸态按任务 conversations[] 分组多条对话', async () => {
    mocks.spaceState.spaces = [
      {
        id: 'team-space-1',
        name: '发布Project',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'team-space-1': [
        { id: 'session-run-1', title: '旧标题 1', space_id: 'team-space-1', message_count: 1 },
        { id: 'session-run-2', title: '旧标题 2', space_id: 'team-space-1', message_count: 2 },
      ],
    }
    mocks.projectApi.listTasks.mockResolvedValue({
      tasks: [{
        id: 'task-multi',
        project_id: 'team-space-1',
        title: '多次执行的任务',
        description: '',
        priority: 'medium',
        created_by: { id: 'user-1', name: 'Owner' },
        responsible_user: { id: 'user-1', name: 'Owner' },
        assignment_status: 'accepted',
        work_status: 'blocked',
        selected_agent: null,
        project_workspace: null,
        workspace_confirmed: true,
        execution_ready: true,
        result_summary: '',
        latest_run: null,
        conversations: [
          {
            session_id: 'session-run-2',
            run_id: 'run-2',
            kind: 'execution',
            run_status: 'failed',
            rerun_of_id: 'run-1',
            title: '[Task] 多次执行的任务 · 2',
            is_active: false,
            created_at: '2026-07-21T01:00:00Z',
          },
          {
            session_id: 'session-run-1',
            run_id: 'run-1',
            kind: 'execution',
            run_status: 'completed',
            rerun_of_id: null,
            title: '[Task] 多次执行的任务 · 1',
            is_active: false,
            created_at: '2026-07-20T00:00:00Z',
          },
        ],
        deliverables: [],
        version: 1,
        created_at: '2026-07-20T00:00:00Z',
        updated_at: '2026-07-21T01:00:00Z',
      }],
      total: 1,
    })

    render(<SidebarConversationList spaceId="team-space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    await waitFor(() => {
      expect(screen.getByText('对话 · 1')).toBeTruthy()
    })
    expect(screen.getByText('对话 · 2')).toBeTruthy()
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-names')).toContain('多次执行的任务')
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-section-titles')).toBe(
      '{"conversations":"任务"}',
    )
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-section-keys')).toContain(
      '"task-multi":"conversations"',
    )
  })

  it('点击 Project 对话时先激活对应工作面，再切换页面当前会话', async () => {
    mocks.spaceState.spaces = [
      {
        id: 'team-space-1',
        name: '发布Project',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
      },
    ]
    mocks.chatState.currentSessionId = 'team-session-old'
    mocks.chatState.sessionsBySpaceId = {
      'team-space-1': [
        { id: 'team-session-old', title: '旧任务', space_id: 'team-space-1', message_count: 1 },
        { id: 'team-session-target', title: '目标任务', space_id: 'team-space-1', message_count: 2 },
      ],
    }

    render(<SidebarConversationList spaceId="team-space-1" tabScopeKey="desktop:organization-1:user:user-1" />)
    fireEvent.click(screen.getByText('目标任务'))

    await waitFor(() => {
      expect(mocks.chatState.selectSession).toHaveBeenCalledWith(
      'team-space-1',
      'team-session-target',
      expect.objectContaining({ draftScopeKey: 'conversation:draft:team-space-1' }),
    )
    })
    expect(mocks.mainNavState.setCurrentTab).toHaveBeenLastCalledWith('agent')
    expect(mocks.projectWorkspaceSelectionState.openTaskSession).toHaveBeenCalledWith('team-session-target')
    expect(mocks.workbenchSceneState.activateForegroundSpace).toHaveBeenCalledWith('team-space-1')
    expect(
      mocks.workbenchSceneState.activateForegroundSpace.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.chatState.selectSession.mock.invocationCallOrder[0])
  })

  it('点击仅有 conversations stub 的任务执行会话时先钉进 team 桶再 select', async () => {
    mocks.spaceState.spaces = [
      {
        id: 'team-space-1',
        name: '上山',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
      },
    ]
    mocks.chatState.currentSessionId = 'team-session-old'
    mocks.chatState.currentSessionIdBySpaceId = { 'team-space-1': 'team-session-old' }
    mocks.chatState.sessionsBySpaceId = {
      'team-space-1': [
        { id: 'team-session-old', title: '项目编排', space_id: 'team-space-1', message_count: 1 },
      ],
    }
    mocks.projectApi.listTasks.mockResolvedValue({
      tasks: [{
        id: 'task-hike-2',
        project_id: 'team-space-1',
        title: '去爬山 2',
        description: '',
        priority: 'medium',
        created_by: { id: 'user-1', name: 'Owner' },
        responsible_user: { id: 'user-2', name: '师傅2' },
        assignment_status: 'accepted',
        work_status: 'in_review',
        selected_agent: { id: 'agent-1', name: '小Tin' },
        project_workspace: null,
        workspace_confirmed: true,
        execution_ready: true,
        result_summary: '',
        result_visibility: 'private',
        latest_run: null,
        conversations: [{
          session_id: 'sess-hike-2',
          run_id: 'run-hike-2',
          kind: 'execution',
          run_status: 'completed',
          rerun_of_id: null,
          title: '[Task] 去爬山 2',
          is_active: false,
          created_at: '2026-07-21T00:00:00Z',
        }],
        deliverables: [],
        version: 1,
        created_at: '2026-07-20T00:00:00Z',
        updated_at: '2026-07-21T01:00:00Z',
      }],
      total: 1,
    })

    render(<SidebarConversationList spaceId="team-space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    await waitFor(() => {
      expect(screen.getByText('执行')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('执行'))

    await waitFor(() => {
      expect(mocks.chatState.selectSession).toHaveBeenCalledWith(
      'team-space-1',
      'sess-hike-2',
      expect.objectContaining({ draftScopeKey: 'conversation:draft:team-space-1' }),
    )
    })
    expect(mocks.chatState.pinSessionInSpace).toHaveBeenCalledWith(
      'team-space-1',
      expect.objectContaining({ id: 'sess-hike-2' }),
    )
    expect(mocks.chatState.pinSessionInSpace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.chatState.selectSession.mock.invocationCallOrder[0],
    )
    expect(mocks.chatState.setCurrentSessionForSpace).toHaveBeenCalledWith(
      'team-space-1',
      'sess-hike-2',
      true,
      expect.objectContaining({ draftScopeKey: 'conversation:draft:team-space-1' }),
    )
  })

  it('侧栏隐藏所有未发消息的空会话，包括当前预热会话', () => {
    mocks.chatState.currentSessionId = 'empty-current'
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [
        { id: 'empty-current', title: null, space_id: 'space-1', message_count: 0 },
        { id: 'empty-old', title: null, space_id: 'space-1', message_count: 0 },
        { id: 'session-1', title: 'Alpha 对话', space_id: 'space-1', message_count: 1 },
      ],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    // 预建空会话由顶部「新任务」承载，列表只留有消息的会话
    expect(screen.getByText('Alpha 对话')).toBeTruthy()
    expect(screen.getByTestId('session-switcher').getAttribute('data-session-ids')).toBe('["session-1"]')
  })

  it('切到其它 Space 后仍保留已下发指令但发送失败的任务', () => {
    //  / ：侧栏不再扫 messages；保活靠发送登记表（message_count 仍可为 0）
    mocks.chatState.currentSessionId = 'session-2'
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [
        { id: 'failed-after-submit', title: '新任务', space_id: 'space-1', message_count: 0 },
        { id: 'abandoned-prefetch', title: '废弃空壳', space_id: 'space-1', message_count: 0 },
      ],
      'space-2': [
        { id: 'session-2', title: 'Beta 对话', space_id: 'space-2', message_count: 1 },
      ],
    }
    rememberLocallySubmittedSession('failed-after-submit')

    render(<SidebarConversationList spaceId="space-2" tabScopeKey="desktop:organization-1:user:user-1" />)

    expect(screen.getByText('Fork 新任务')).toBeTruthy()
    expect(screen.getByText('Beta 对话')).toBeTruthy()
    expect(screen.queryByText('废弃空壳')).toBeNull()
  })

  it('Project 没有历史对话时不自动创建团队草稿，零任务也不套分组', async () => {
    mocks.spaceState.spaces = [
      { id: 'space-1', name: '默认 Space', organization_id: 'organization-1', type: 'workspace' },
      {
        id: 'team-space-1',
        name: '发布Project',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [],
      'team-space-1': [],
    }

    render(<SidebarConversationList spaceId="team-space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    await waitFor(() => {
      expect(mocks.projectApi.listTasks).toHaveBeenCalledWith('team-space-1', false)
    })
    expect(screen.queryByRole('button', { name: '折叠 项目对话' })).toBeNull()
    expect(screen.getByTestId('session-switcher').getAttribute('data-space-names')).toBeNull()
    expect(screen.getByTestId('session-switcher').getAttribute('data-show-draft-session')).toBe('false')
    expect(mocks.chatState.startDraftSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.chatState.selectSession).not.toHaveBeenCalled()
  })

  it('跨 Space fork 会先切到目标 Space 再 fork 对话', () => {
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'session-1', title: 'Alpha 对话', space_id: 'space-1', message_count: 1 }],
      'space-2': [{ id: 'session-2', title: 'Beta 对话', space_id: 'space-2', message_count: 1 }],
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    fireEvent.click(screen.getByText('Fork Beta 对话'))

    expect(mocks.spaceListState.selectSpaceBySpaceId).toHaveBeenCalledWith('space-2')
    expect(mocks.chatState.forkSession).toHaveBeenCalledWith('space-2', 'session-2')
  })

  it('点击 Space 设置入口会先切换 Space 再打开完整 Space 管理 tab', () => {
    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    fireEvent.click(screen.getByRole('button', { name: '设置 Beta Agent' }))

    expect(mocks.spaceListState.selectSpaceBySpaceId).toHaveBeenCalledWith('space-2')
    expect(mocks.spaceSettingsNav.openSpaceSettingsIntent).toHaveBeenCalledWith('space-2', {
      tabScopeKey: 'desktop:organization-1:user:user-1',
    })
  })

  it('自动化区作为对话列表底部 footer 渲染，不再有独立执行记录平铺列表', () => {
    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    const sessionSwitcher = screen.getByTestId('session-switcher')
    const trackerSection = screen.getByTestId('tracker-section')

    // 自动化作为主列表 footer 渲染在其内部（随列表滚动），不再是独立的 trackerRuns switcher
    expect(sessionSwitcher.contains(trackerSection)).toBe(true)
    expect(screen.queryByTestId('tracker-run-switcher')).toBeNull()
  })

  it('从全屏 App 页点击自动化任务执行记录会委托统一会话导航', async () => {
    useAppPageStore.getState().openAppPage('skill')

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    fireEvent.click(screen.getByRole('button', { name: '执行记录' }))

    await waitFor(() => {
      expect(mocks.enterChatSession).toHaveBeenCalledWith(
        'space-2',
        'tracker-run-1',
        expect.objectContaining({
          draftScopeKey: 'conversation:draft:space-1',
          initialScroll: 'first-message',
        }),
      )
    })
  })

  it('执行记录已是当前会话时仍会委托统一会话导航', async () => {
    mocks.chatState.currentSessionId = 'tracker-run-1'
    useAppPageStore.getState().openAppPage('automation')

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    fireEvent.click(screen.getByRole('button', { name: '执行记录' }))

    await waitFor(() => {
      expect(mocks.enterChatSession).toHaveBeenCalledWith(
        'space-2',
        'tracker-run-1',
        expect.objectContaining({ initialScroll: 'first-message' }),
      )
    })
  })

  it('草稿入口 badge 使用 workspace 草稿执行 Space，且存在草稿指针时展示任务入口', () => {
    mocks.chatState.draftExecutionSpaceIdByWorkspaceKey = {
      'desktop:organization-1:user:user-1': 'space-2',
    }

    render(<SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />)

    expect(screen.getByTestId('session-switcher').getAttribute('data-draft-badge-space-id')).toBe('space-2')
    expect(screen.getByTestId('session-switcher').getAttribute('data-show-draft-session')).toBe('true')
  })

  it('工作空间行提供按现场新建任务入口，顶部全局新建入口仍不重复', () => {
    const onOpenConversationWorkspace = vi.fn()
    mocks.spaceState.spaces = [
      { id: 'space-1', name: 'Alpha Agent', organization_id: 'organization-1', type: 'workspace' },
      { id: 'project-1', name: '发布 Project', organization_id: 'organization-1', type: 'team_space' },
    ]
    render(
      <SidebarConversationList
        spaceId="space-1"
        tabScopeKey="desktop:organization-1:user:user-1"
        onOpenConversationWorkspace={onOpenConversationWorkspace}
      />,
    )

    const switcher = screen.getByTestId('session-switcher')
    expect(switcher.getAttribute('data-has-create-session')).toBe('false')
    expect(switcher.getAttribute('data-has-create-session-in-space')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '新建任务 Alpha Agent' }))
    expect(mocks.alignChatPointerToWorkspace).toHaveBeenCalledWith('space-1')
    expect(mocks.chatState.startDraftSessionForSpace).toHaveBeenCalledWith('space-1', true, expect.objectContaining({ draftScopeKey: 'conversation:draft:space-1' }))
    expect(onOpenConversationWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.mainNavState.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(mocks.resetNewTaskDraftUi).toHaveBeenCalledWith('space-1')
    expect(screen.queryByRole('button', { name: '新建任务 发布 Project' })).toBeNull()
  })

  it('#7903 Space list 仅换引用时不重复 fan-out loadSessions；新增 Workspace 只补拉一次', async () => {
    mocks.chatState.sessionsBySpaceId = {
      'space-1': [],
      'space-2': [],
    }
    const { rerender } = render(
      <SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1" />,
    )

    await waitFor(() => {
      expect(mocks.chatState.loadSessions.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    const callsAfterMount = mocks.chatState.loadSessions.mock.calls.length
    const loadedSpaceIds = new Set(
      mocks.chatState.loadSessions.mock.calls.map((call) => call[0] as string),
    )
    expect(loadedSpaceIds.has('space-1')).toBe(true)
    expect(loadedSpaceIds.has('space-2')).toBe(true)

    // 模拟 loadSpaces(merge)：同 id 新数组引用。
    // mock store 无订阅通知，改 tabScopeKey 绕过 memo 强制重读 spaces。
    mocks.spaceState.spaces = [
      { id: 'space-1', name: 'Alpha Agent', organization_id: 'organization-1' },
      { id: 'space-2', name: 'Beta Agent', organization_id: 'organization-1' },
    ]
    rerender(
      <SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1:merge" />,
    )
    expect(mocks.chatState.loadSessions.mock.calls.length).toBe(callsAfterMount)

    mocks.spaceState.spaces = [
      { id: 'space-1', name: 'Alpha Agent', organization_id: 'organization-1' },
      { id: 'space-2', name: 'Beta Agent', organization_id: 'organization-1' },
      { id: 'space-3', name: 'Gamma Agent', organization_id: 'organization-1' },
    ]
    mocks.chatState.sessionsBySpaceId = {
      ...mocks.chatState.sessionsBySpaceId,
      'space-3': [],
    }
    rerender(
      <SidebarConversationList spaceId="space-1" tabScopeKey="desktop:organization-1:user:user-1:add" />,
    )
    await waitFor(() => {
      expect(mocks.chatState.loadSessions).toHaveBeenCalledWith('space-3', 'organization-1')
    })
    const space3Calls = mocks.chatState.loadSessions.mock.calls.filter(
      (call) => call[0] === 'space-3',
    )
    expect(space3Calls).toHaveLength(1)
    expect(mocks.chatState.loadSessions.mock.calls.length).toBe(callsAfterMount + 1)
  })
})
