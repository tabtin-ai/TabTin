import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../ChatPanel'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'

const mocks = vi.hoisted(() => {
  const desktopScopeKey = 'desktop:organization:organization-1:user:user-1'
  const setDraftExecutionSpaceForWorkspace = vi.fn()
  const startDraftSessionForSpace = vi.fn()
  const captureLifecycleInput = vi.fn()
  const sessionsBySpaceId: Record<string, Array<{
    id: string
    title: string
    space_id: string
    workspace_id?: string
    created_at: string
    updated_at: string
  }>> = {
    'space-1': [
      {
        id: 'session-global',
        title: 'Global session',
        space_id: 'space-1',
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      },
      {
        id: 'session-space',
        title: 'Space session',
        space_id: 'space-1',
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      },
    ],
    'space-2': [
      {
        id: 'session-other-space',
        title: 'Other Space session',
        space_id: 'space-2',
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      },
    ],
  }
  const chatState = {
    isPanelOpen: true,
    currentSessionId: 'session-global' as string | null,
    currentSessionIdBySpaceId: { 'space-1': 'session-space' } as Record<string, string | null>,
    currentSessionIdByWorkspaceKey: { [desktopScopeKey]: 'session-workspace' } as Record<string, string | null>,
    draftExecutionSpaceIdByWorkspaceKey: {} as Record<string, string>,
    setDraftExecutionSpaceForWorkspace,
    sessionsBySpaceId,
    draftSessionBySpaceId: {} as Record<string, boolean>,
    rewindPreview: null,
    cancelRewindPreview: vi.fn(),
    confirmRewindPreview: vi.fn(),
    getSessionById: (sessionId: string) => {
      for (const list of Object.values(sessionsBySpaceId)) {
        const found = list.find(session => session.id === sessionId)
        if (found) return found
      }
      return undefined
    },
  }
  return {
    desktopScopeKey,
    chatState,
    setDraftExecutionSpaceForWorkspace,
    startDraftSessionForSpace,
    captureLifecycleInput,
    authState: {
      user: { id: 'user-1' },
      isAuthenticated: true,
    },
    spaceViewPrefsState: {
      getSidebarMode: vi.fn(() => 'desktop'),
    },
    spaceState: {
      spaces: [
        { id: 'space-1', name: 'Agent Space', organization_id: 'organization-1' },
        { id: 'space-2', name: 'Other Agent Space', organization_id: 'organization-1' },
      ] as Array<{
        id: string
        name: string
        organization_id: string
        type?: string
        is_companion?: boolean
        provisioning_source?: string
      }>,
    },
  }
})

vi.mock('../../../../stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: typeof mocks.chatState) => unknown) => selector(mocks.chatState),
}))

vi.mock('@/stores/useChatSplitStore', () => ({
  useChatSplitStore: (selector: (state: { togglePinSession: () => void }) => unknown) =>
    selector({ togglePinSession: vi.fn() }),
}))

vi.mock('../../../../stores/useAuthStore', () => ({
  selectIsAuthenticated: (state: typeof mocks.authState) => state.isAuthenticated,
  useAuthStore: (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
}))

vi.mock('../../../../stores/useTableStore', () => ({
  useTableStore: (selector: (state: { tables: unknown[] }) => unknown) => selector({ tables: [] }),
}))

vi.mock('../../../../stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: typeof mocks.spaceState) => unknown) => selector(mocks.spaceState),
}))

vi.mock('../../../../stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: typeof mocks.spaceViewPrefsState) => unknown) =>
    selector(mocks.spaceViewPrefsState),
}))

vi.mock('@components/layout/SpaceActivityContext', () => ({
  useSpaceActivity: () => ({ isForeground: true }),
}))

vi.mock('../../hooks/useChatActions', () => ({
  useChatActions: () => ({
    sendMessage: vi.fn(),
    abortStream: vi.fn(),
    syncContext: vi.fn(),
    createSession: vi.fn(),
    ensureSessionForSpace: vi.fn(),
    startDraftSessionForSpace: mocks.startDraftSessionForSpace,
    loadSessions: vi.fn(),
    selectSession: vi.fn(),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    loadModels: vi.fn(),
    switchModel: vi.fn(),
    switchContextTier: vi.fn(),
  }),
}))

vi.mock('../../hooks/useChatPanelContext', () => ({
  useChatPanelContext: () => ({
    activeContextKey: null,
    activeContextType: null,
    activeTable: null,
    activeAppMeta: null,
    openTabs: null,
    createWebTab: vi.fn(),
    createTerminal: vi.fn(),
    contextDisplay: {
      icon: '📍',
      label: 'Agent',
      name: 'Test Space',
      type: 'chat' as const,
    },
  }),
}))

vi.mock('../../hooks/useChatPanelLifecycle', () => ({
  useChatPanelLifecycle: (input: unknown) => {
    mocks.captureLifecycleInput(input)
    return ({
    effectiveGraphType: 'chat',
    effectiveAgentMode: 'default',
    isRestoring: false,
    canSend: true,
    disabledReason: null,
    currentModel: null,
    currentContextTier: null,
    tokenUsage: null,
    pendingModelId: null,
    setPendingModelId: vi.fn(),
    })
  },
}))

vi.mock('../../hooks/useChatCallbacks', () => ({
  useChatCallbacks: () => ({
    handleTabClick: vi.fn(),
    handleNewSession: vi.fn(),
    handleDeleteSession: vi.fn(),
    handleForkSession: vi.fn(),
    pinnedSessionIdsSet: new Set<string>(),
    handleSendMessage: vi.fn(),
    handleStop: vi.fn(),
    handleModelChange: vi.fn(),
  }),
}))

vi.mock('../../context/useContextInjection', () => ({
  useContextInjection: () => null,
}))

vi.mock('../../composer-presets/useComposerPresetInjection', () => ({
  useComposerPresetInjection: vi.fn(),
}))

vi.mock('../../composer-presets/scope', () => ({
  resolveComposerPresetScopeId: () => 'preset-scope',
}))

vi.mock('../../composer-presets/windowApi', () => ({
  installComposerPresetsWindowAPI: vi.fn(),
}))

vi.mock('../../composer-presets/presets', () => ({}))

vi.mock('../../checkpoint/RestoreOverlay', () => ({
  RestoreOverlay: () => null,
}))

vi.mock('../../checkpoint/RewindPreviewPanel', () => ({
  RewindPreviewPanel: () => null,
}))

vi.mock('../../session/ChatSessionBar', () => ({
  ChatSessionBar: ({
    currentSessionId,
    sessions,
  }: {
    currentSessionId: string | null
    sessions: Array<{ id: string }>
  }) => (
    <div
      data-testid="chat-session-bar"
      data-current-session-id={currentSessionId ?? ''}
      data-session-ids={sessions.map(session => session.id).join(',')}
    />
  ),
}))

vi.mock('../ChatContent', () => ({
  ChatContent: ({
    currentSessionId,
    selectedSpaceId,
    onExecutionSpaceChange,
    sharedAccessShareId,
    forceSessionHydration,
  }: {
    currentSessionId: string | null
    selectedSpaceId: string | null
    onExecutionSpaceChange?: (spaceId: string) => void
    sharedAccessShareId?: string | null
    forceSessionHydration?: boolean
  }) => (
    <>
      <div
        data-testid="chat-content"
        data-current-session-id={currentSessionId ?? ''}
        data-selected-space-id={selectedSpaceId ?? ''}
        data-has-execution-space-change={String(Boolean(onExecutionSpaceChange))}
        data-shared-access-share-id={sharedAccessShareId ?? ''}
        data-force-session-hydration={String(Boolean(forceSessionHydration))}
      />
      {onExecutionSpaceChange ? (
        <button type="button" onClick={() => onExecutionSpaceChange('space-2')}>
          switch execution space
        </button>
      ) : null}
    </>
  ),
}))

beforeEach(() => {
  useSessionAccessStore.setState({ bySessionId: {} })
  mocks.chatState.sessionsBySpaceId['space-1'] = [
    {
      id: 'session-global',
      title: 'Global session',
      space_id: 'space-1',
      created_at: '2026-06-25T00:00:00.000Z',
      updated_at: '2026-06-25T00:00:00.000Z',
    },
    {
      id: 'session-space',
      title: 'Space session',
      space_id: 'space-1',
      created_at: '2026-06-25T00:00:00.000Z',
      updated_at: '2026-06-25T00:00:00.000Z',
    },
  ]
  mocks.chatState.currentSessionId = 'session-global'
  mocks.chatState.currentSessionIdBySpaceId = { 'space-1': 'session-space' }
  mocks.chatState.draftExecutionSpaceIdByWorkspaceKey = {}
  mocks.spaceViewPrefsState.getSidebarMode.mockReset()
  mocks.spaceViewPrefsState.getSidebarMode.mockReturnValue('desktop')
  mocks.setDraftExecutionSpaceForWorkspace.mockReset()
  mocks.startDraftSessionForSpace.mockReset()
  mocks.captureLifecycleInput.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ChatPanel', () => {
  it('首次渲染直接使用持久标签提供的共享访问上下文', () => {
    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        organizationId="organization-1"
        controlledSessionId="shared-session-restored"
        sharedSessionAccess={{
          shareId: 'share-restored',
          sessionId: 'shared-session-restored',
          organizationId: 'organization-1',
          workspaceId: 'space-1',
          role: 'grantee',
        }}
        forceControlledSessionHydration
      />,
    )

    const content = screen.getByTestId('chat-content')
    expect(content.getAttribute('data-current-session-id')).toBe('shared-session-restored')
    expect(content.getAttribute('data-shared-access-share-id')).toBe('share-restored')
    expect(content.getAttribute('data-selected-space-id')).toBe('space-1')
    expect(mocks.captureLifecycleInput).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedSpaceId: 'space-1',
    }))
  })

  it('incoming 共享持久标签没有本地宿主 Space 时使用授权 Workspace 装载只读历史', () => {
    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        organizationId="organization-1"
        controlledSessionId="shared-session-no-host-space"
        sharedSessionAccess={{
          shareId: 'share-no-host-space',
          sessionId: 'shared-session-no-host-space',
          organizationId: 'organization-1',
          workspaceId: 'owner-workspace',
          role: 'grantee',
        }}
        forceControlledSessionHydration
      />,
    )

    const content = screen.getByTestId('chat-content')
    expect(content.getAttribute('data-current-session-id')).toBe('shared-session-no-host-space')
    expect(content.getAttribute('data-shared-access-share-id')).toBe('share-no-host-space')
    expect(content.getAttribute('data-selected-space-id')).toBe('owner-workspace')
    expect(content.getAttribute('data-has-execution-space-change')).toBe('false')
    expect(mocks.captureLifecycleInput).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedSpaceId: 'owner-workspace',
    }))
  })

  it('不使用其他会话的持久共享访问上下文', () => {
    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        organizationId="organization-1"
        controlledSessionId="current-session"
        sharedSessionAccess={{
          shareId: 'share-for-another-session',
          sessionId: 'another-session',
          organizationId: 'organization-1',
          role: 'grantee',
        }}
        forceControlledSessionHydration
      />,
    )

    const content = screen.getByTestId('chat-content')
    expect(content.getAttribute('data-current-session-id')).toBe('current-session')
    expect(content.getAttribute('data-shared-access-share-id')).toBe('')
  })

  it('显式缺少共享访问上下文时不回退到同会话的旧内存授权', () => {
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'stale-share',
      sessionId: 'session-without-share',
      role: 'grantee',
    })

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        organizationId="organization-1"
        controlledSessionId="session-without-share"
        sharedSessionAccess={null}
        forceControlledSessionHydration
      />,
    )

    expect(screen.getByTestId('chat-content').getAttribute('data-shared-access-share-id')).toBe('')
  })

  it('把共享会话作为当前真实会话交给正常 ChatContent 渲染', () => {
    mocks.chatState.currentSessionId = 'shared-session-1'
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'share-1',
      sessionId: 'shared-session-1',
    })

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-content').getAttribute('data-current-session-id')).toBe('shared-session-1')
    expect(screen.getByTestId('chat-content').getAttribute('data-shared-access-share-id')).toBe('share-1')
    expect(screen.getByTestId('chat-content').getAttribute('data-selected-space-id')).toBe('space-1')
    expect(screen.getByTestId('chat-session-bar').getAttribute('data-current-session-id')).toBe('shared-session-1')
    expect(screen.queryByTestId('shared-session-pane')).toBeNull()
  })

  it('v1 共享接收者的列表生命周期仍使用当前 Workspace', () => {
    mocks.chatState.currentSessionId = 'shared-session-owner-workspace'
    mocks.chatState.sessionsBySpaceId['space-1'] = [{
      id: 'shared-session-owner-workspace',
      title: '共享任务',
      space_id: 'owner-workspace',
      workspace_id: 'owner-workspace',
      created_at: '2026-08-13T00:00:00.000Z',
      updated_at: '2026-08-13T00:00:00.000Z',
    }]
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'share-owner-workspace',
      sessionId: 'shared-session-owner-workspace',
      workspaceId: 'owner-workspace',
      role: 'grantee',
    })

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(mocks.captureLifecycleInput).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedSpaceId: 'space-1',
      conversationHostSpaceId: 'space-1',
    }))
  })

  it('owner 的共享卡工作台携带 shareId 加载历史，同时保留 owner 执行空间', () => {
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'share-owner',
      sessionId: 'session-global',
      role: 'owner',
      workspaceId: 'space-1',
    })

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
        controlledSessionId="session-global"
        forceControlledSessionHydration
      />,
    )

    const content = screen.getByTestId('chat-content')
    expect(content.getAttribute('data-shared-access-share-id')).toBe('')
    expect(content.getAttribute('data-force-session-hydration')).toBe('true')
    expect(content.getAttribute('data-selected-space-id')).toBe('space-1')
  })

  it('uses the globally selected chat session independent from workspace and per-space caches', () => {
    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-session-bar').getAttribute('data-current-session-id')).toBe('session-global')
    expect(screen.getByTestId('chat-session-bar').getAttribute('data-session-ids')).toContain('session-other-space')
    expect(screen.getByTestId('chat-content').getAttribute('data-current-session-id')).toBe('session-global')
  })

  it('switching the new-task 工作空间 starts a draft in the selected execution Space', () => {
    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'switch execution space' }))

    expect(mocks.setDraftExecutionSpaceForWorkspace).toHaveBeenCalledWith(
      mocks.desktopScopeKey,
      'space-2',
    )
    expect(mocks.startDraftSessionForSpace).toHaveBeenCalledWith(
      'space-2',
      true,
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:space-1',
        executionWorkspaceId: 'space-2',
        preserveDraftMessageIntent: true,
      }),
    )
  })

  it('organization scope follows open session 工作空间, not stale draft ', () => {
    mocks.chatState.currentSessionId = 'session-global'
    mocks.chatState.draftExecutionSpaceIdByWorkspaceKey = {
      [mocks.desktopScopeKey]: 'space-2',
    }

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-content').getAttribute('data-selected-space-id')).toBe('space-1')
  })

  it('organization scope follows draft execution Space when no session is open ', () => {
    mocks.chatState.currentSessionId = null
    mocks.chatState.draftExecutionSpaceIdByWorkspaceKey = {
      [mocks.desktopScopeKey]: 'space-2',
    }

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-content').getAttribute('data-selected-space-id')).toBe('space-2')
  })

  it('conversations mode writes both current and post-draft keys when switching 工作空间 ', () => {
    mocks.spaceViewPrefsState.getSidebarMode.mockReturnValue('conversations')
    mocks.chatState.currentSessionId = 'session-global'

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'switch execution space' }))

    expect(mocks.setDraftExecutionSpaceForWorkspace).toHaveBeenCalledWith(
      'conversation:session-global',
      'space-2',
    )
    expect(mocks.setDraftExecutionSpaceForWorkspace).toHaveBeenCalledWith(
      'conversation:draft:space-1',
      'space-2',
    )
    expect(mocks.startDraftSessionForSpace).toHaveBeenCalledWith(
      'space-2',
      true,
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:space-1',
        executionWorkspaceId: 'space-2',
        preserveDraftMessageIntent: true,
      }),
    )
  })

  it('locks selectedSpaceOnly mode to the provided execution Space even when a draft points elsewhere', () => {
    mocks.chatState.currentSessionId = null
    mocks.chatState.currentSessionIdBySpaceId = { 'space-1': null, 'space-2': 'session-other-space' }
    mocks.chatState.draftExecutionSpaceIdByWorkspaceKey = { [mocks.desktopScopeKey]: 'space-2' }

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        sessionListScope="selectedSpaceOnly"
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-session-bar').getAttribute('data-current-session-id')).toBe('')
    expect(screen.getByTestId('chat-session-bar').getAttribute('data-session-ids')).not.toContain('session-other-space')
    expect(screen.getByTestId('chat-content').getAttribute('data-selected-space-id')).toBe('space-1')
    expect(screen.getByTestId('chat-content').getAttribute('data-has-execution-space-change')).toBe('false')
  })

  it('excludes Project companion 工作空间 sessions from organization-wide navigation', () => {
    mocks.spaceState.spaces = [
      { id: 'space-1', name: 'Agent Space', organization_id: 'organization-1' },
      {
        id: 'project-workspace-1',
        name: 'Project internal 工作空间',
        organization_id: 'organization-1',
        is_companion: true,
      },
    ]
    mocks.chatState.sessionsBySpaceId['project-workspace-1'] = [
      {
        id: 'session-project-internal',
        title: 'Project internal session',
        space_id: 'project-workspace-1',
        created_at: '2026-06-25T00:00:00.000Z',
        updated_at: '2026-06-25T00:00:00.000Z',
      },
    ]

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'space-1',
          name: 'Agent Space',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-session-bar').getAttribute('data-session-ids'))
      .not.toContain('session-project-internal')
  })

  it('does not fall back to a companion 工作空间 when it is the only organization 工作空间', () => {
    mocks.spaceState.spaces = [
      {
        id: 'project-workspace-1',
        name: 'Project internal 工作空间',
        organization_id: 'organization-1',
        is_companion: true,
      },
    ]

    render(
      <ChatPanel
        isActive
        variant="embedded"
        hideSessionTabs
        spaceContext={{
          id: 'project-workspace-1',
          name: 'Project internal 工作空间',
          organization_id: 'organization-1',
        }}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-session-bar').getAttribute('data-session-ids'))
      .not.toContain('session-project-internal')
  })

})
