import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
vi.mock('@/services/agentMemoryNavigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/agentMemoryNavigation')>()
  const { useAppPageStore: appPageStore } = await import('@/stores/useAppPageStore')
  return {
    ...actual,
    openCollaborationHub: () => {
      appPageStore.getState().openAppPage('collaboration')
    },
  }
})

import { useProjectWorkspaceSelectionStore } from './projectWorkspaceSelectionStore'
import { __test__ as projectTaskStoreTest } from '@/stores/useProjectTaskStore'
import { useAppPageStore } from '@/stores/useAppPageStore'

const mocks = vi.hoisted(() => ({
  closeIM: vi.fn(),
  openIM: vi.fn(),
  closeSettings: vi.fn(),
  setCurrentConversation: vi.fn(),
  onNewConversation: vi.fn(),
  setCurrentTab: vi.fn(),
  currentTab: 'agent',
  setChatSidePanelCollapsed: vi.fn(),
  activateSpace: vi.fn(),
  selectSpaceBySpaceId: vi.fn(),
  activateConversation: vi.fn(() => true),
  clearActiveContext: vi.fn(),
  setSpaceListState: vi.fn(),
  listConversations: vi.fn(() => Promise.resolve([])),
  createSpaceChannel: vi.fn(() => Promise.resolve({ conversation_id: 'conv-design' })),
  getConversation: vi.fn(() => Promise.resolve({
    id: 'conv-design',
    organization_id: 'organization-1',
    space_id: 'team-space-1',
    name: '#design-review',
    type: 2,
    avatar_url: '',
    member_count: 2,
    is_archived: false,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-07-04T00:00:00Z',
    updated_at: '2026-07-04T00:00:00Z',
    is_team_space_channel: true,
    space_name: '发布准备',
  })),
  updateSpace: vi.fn(() => Promise.resolve({
    id: 'team-space-1',
    name: '发布准备更新',
    organization_id: 'organization-1',
    type: 'team_space',
    execution_space_id: null,
    is_archived: false,
  })),
  currentConversationId: null as string | null,
  conversations: [
    {
      id: 'conv-general',
      organization_id: 'organization-1',
      space_id: 'team-space-1',
      name: '#general',
      type: 2,
      avatar_url: '',
      member_count: 2,
      is_archived: false,
      last_message_at: '2026-07-02T02:00:00Z',
      last_message_preview: '准备开始发布讨论',
      unread_count: 1,
      created_at: '2026-07-02T00:00:00Z',
      updated_at: '2026-07-02T02:00:00Z',
      is_team_space_channel: true,
      space_name: '发布准备',
    },
    {
      id: 'conv-agent-updates',
      organization_id: 'organization-1',
      space_id: 'team-space-1',
      name: '#agent-updates',
      type: 2,
      avatar_url: '',
      member_count: 2,
      is_archived: false,
      last_message_at: null,
      last_message_preview: '',
      unread_count: 0,
      created_at: '2026-07-02T00:00:00Z',
      updated_at: '2026-07-02T00:00:00Z',
      is_team_space_channel: true,
      space_name: '发布准备',
    },
  ] as Array<Record<string, unknown>>,
  unreadCounts: { 'conv-general': 0, 'conv-agent-updates': 0 } as Record<string, number>,
  loadConversations: vi.fn(() => Promise.resolve()),
  chatPanelProps: [] as Array<Record<string, unknown>>,
  loadSessions: vi.fn(() => Promise.resolve()),
  selectSession: vi.fn(() => Promise.resolve()),
  getSessionById: vi.fn((sessionId: string) => (
    Object.values(mocks.chatState.sessionsBySpaceId)
      .flat()
      .find(session => session.id === sessionId)
  )),
  pinSessionInSpace: vi.fn(),
  setCurrentSessionForSpace: vi.fn(),
  ensureSessionForSpace: vi.fn(() => Promise.resolve({
    sessionId: 'project-orchestration-session',
    mode: 'quick_start',
  })),
  createSession: vi.fn(async () => {
    mocks.chatState.currentSessionIdBySpaceId['team-space-1'] = 'project-orchestration-session'
  }),
  sendMessage: vi.fn(async (
    _message: string,
    _streaming?: boolean,
    _attachments?: unknown,
    _contextBlocks?: unknown,
    targetSessionId?: string,
    options?: { source?: string },
  ) => {
    if (!targetSessionId) return
    mocks.chatState.messagesBySessionId[targetSessionId] = [{
      metadata: { source: options?.source },
    }]
  }),
  syncContext: vi.fn(() => Promise.resolve()),
  startDraftSessionForSpace: vi.fn(),
  chatState: {
    sessionsBySpaceId: {
      'team-space-1': [
        {
          id: 'session-task-1',
          title: '发布任务对话',
          space_id: 'team-space-1',
          last_message_preview: '继续整理发布清单',
          created_at: '2026-07-02T00:00:00Z',
          updated_at: '2026-07-02T00:00:00Z',
          last_message_at: '2026-07-02T01:00:00Z',
        },
      ],
    },
    currentSessionIdBySpaceId: { 'team-space-1': 'session-task-1' },
    draftSessionBySpaceId: {},
    messagesBySessionId: {} as Record<string, Array<{
      metadata?: Record<string, unknown>
      sendStatus?: 'sending' | 'sent' | 'failed'
    }>>,
  },
  scopedResources: [] as Array<Record<string, unknown>>,
  loadResources: vi.fn(() => Promise.resolve()),
  directUpload: vi.fn(() => Promise.resolve({
    fileId: 'file-record-1',
    fileName: '过程文档.txt',
    fileKey: 'team-space-assets/file-record-1.txt',
    fileSize: 12,
    accessUrl: 'https://files.example.test/raw.txt',
    cdnUrl: '',
  })),
  uploadSpaceFile: vi.fn(() => Promise.resolve({
    id: 'file-item-1',
    space_id: 'team-space-1',
    item_type: 'tabfiles',
    title: '过程文档.txt',
    metadata: { asset_kind: 'cloud_file' },
  })),
  recordResourceAccess: vi.fn(() => Promise.resolve()),
  getSpaceFileDownloadUrl: vi.fn(() => Promise.resolve({ url: 'https://files.example.test/doc.pdf' })),
  openTeamSpaceTabdoc: vi.fn(() => Promise.resolve(true)),
  getProject: vi.fn(),
  listMyPendingInvitations: vi.fn(() => Promise.resolve([])),
  getTask: vi.fn(),
  listTasks: vi.fn(() => Promise.resolve({ tasks: [], total: 0 })),
  createTask: vi.fn(),
  respondTaskAssignment: vi.fn(),
  configureTaskExecution: vi.fn(),
  prepareTaskRun: vi.fn(),
  startTaskRun: vi.fn(),
  cancelTask: vi.fn(),
  acceptTaskResult: vi.fn(),
  setTaskResultVisibility: vi.fn(),
  activities: [] as Array<Record<string, unknown>>,
  listActivities: vi.fn(() => Promise.resolve({
    items: mocks.activities,
    total: mocks.activities.length,
    page: 1,
    limit: 20,
  })),
  createProjectWithCompanionWorkspace: vi.fn(),
  provisionProjectCompanionWorkspace: vi.fn(),
  getMembers: vi.fn(() => Promise.resolve({
    members: [
      {
        id: 'member-1',
        organization_id: 'organization-1',
        user_id: 'user-1',
        role: 'owner',
        joined_at: '2026-07-02T00:00:00Z',
        user: { nickname: 'Seda Owner', email: 'seda@example.test' },
      },
      {
        id: 'member-2',
        organization_id: 'organization-1',
        user_id: 'user-2',
        role: 'editor',
        joined_at: '2026-07-02T00:00:00Z',
        user: { nickname: 'Mira Editor', email: 'mira@example.test' },
      },
    ],
    total: 2,
  })),
  listOrganizationAgents: vi.fn(() => Promise.resolve({
    agents: [
      {
        id: 'human-agent-1',
        organization_id: 'organization-1',
        name: 'Seda Human Agent',
        type: 'human',
        is_active: true,
        created_at: '2026-07-02T00:00:00Z',
        updated_at: '2026-07-02T00:00:00Z',
      },
      {
        id: 'bot-agent-1',
        organization_id: 'organization-1',
        name: '真实 Research Agent',
        type: 'bot',
        is_active: true,
        created_at: '2026-07-02T00:00:00Z',
        updated_at: '2026-07-02T00:00:00Z',
      },
      {
        id: 'system-agent-1',
        organization_id: 'organization-1',
        name: '系统调度 Agent',
        type: 'system',
        is_active: true,
        created_at: '2026-07-02T00:00:00Z',
        updated_at: '2026-07-02T00:00:00Z',
      },
    ],
    total: 3,
  })),
  listSpaceMemberships: vi.fn(() => Promise.resolve({
    memberships: [
      { id: 'membership-user-1', space_id: 'team-space-1', user_id: 'user-1', role: 'owner', is_active: true },
      { id: 'membership-user-2', space_id: 'team-space-1', user_id: 'user-2', role: 'editor', is_active: true },
      { id: 'membership-agent-1', space_id: 'team-space-1', agent_id: 'bot-agent-1', role: 'editor', is_active: true },
      { id: 'membership-agent-2', space_id: 'team-space-1', agent_id: 'system-agent-1', role: 'editor', is_active: true },
    ],
    total: 4,
  })),
  addSpaceMembership: vi.fn(() => Promise.resolve({ id: 'membership-agent-new' })),
  spaces: [
    { id: 'space-1', name: '默认 Space', organization_id: 'organization-1', type: 'workspace' },
    {
      id: 'team-space-1',
      name: '发布准备',
      description: '发布前准备工作',
      organization_id: 'organization-1',
      type: 'team_space',
      execution_space_id: null,
      is_archived: false,
      config_version: 7,
    },
  ] as Array<Record<string, unknown>>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@/services/openTeamSpaceTabdoc', () => ({
  openTeamSpaceTabdoc: (...args: unknown[]) => mocks.openTeamSpaceTabdoc(...args),
}))

// 内嵌只读文档预览走 REST 快照 + tiptap 渲染，jsdom 里过重；用轻量桩件断言挂载与 documentId。
vi.mock('@/components/context-space/tabdoc/InlineDocPreview', () => ({
  InlineDocPreview: ({ documentId }: { documentId: string }) => (
    <div data-testid="inline-doc-preview" data-document-id={documentId} />
  ),
}))

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    getProject: mocks.getProject,
    listMyPendingInvitations: mocks.listMyPendingInvitations,
    getTask: mocks.getTask,
    listTasks: mocks.listTasks,
    createTask: mocks.createTask,
    respondTaskAssignment: mocks.respondTaskAssignment,
    configureTaskExecution: mocks.configureTaskExecution,
    prepareTaskRun: mocks.prepareTaskRun,
    startTaskRun: mocks.startTaskRun,
    cancelTask: mocks.cancelTask,
    acceptTaskResult: mocks.acceptTaskResult,
    setTaskResultVisibility: mocks.setTaskResultVisibility,
  },
}))

vi.mock('@/services/spaceActivityApi', () => ({
  SpaceActivityApiService: {
    listActivities: (...args: unknown[]) => mocks.listActivities(...args),
  },
}))

vi.mock('@/services/provisionProjectWorkspace', () => ({
  createProjectWithCompanionWorkspace: mocks.createProjectWithCompanionWorkspace,
  provisionProjectCompanionWorkspace: mocks.provisionProjectCompanionWorkspace,
}))

vi.mock('@components/chat/panel/ChatPanel', () => ({
  ChatPanel: (props: Record<string, unknown>) => {
    mocks.chatPanelProps.push(props)
    const spaceContext = props.spaceContext as { id?: string; name?: string } | null
    return <div data-testid="team-agent-chat-panel">{spaceContext?.id ?? 'no-space'}</div>
  },
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string; name: string } }) => unknown) =>
    selector({ selectedOrganization: { id: 'organization-1', name: '测试团队' } }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: {
      spaces: Array<Record<string, unknown>>
      updateSpace: typeof mocks.updateSpace
    }) => unknown) =>
      selector({
        spaces: mocks.spaces,
        updateSpace: mocks.updateSpace,
      }),
    {
      setState: (updater: ((state: { spaces: Array<Record<string, unknown>> }) => { spaces?: Array<Record<string, unknown>> }) | { spaces?: Array<Record<string, unknown>> }) => {
        const next = typeof updater === 'function' ? updater({ spaces: mocks.spaces }) : updater
        if (next.spaces) mocks.spaces = next.spaces
      },
    },
  ),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        openIM: mocks.openIM,
        closeIM: mocks.closeIM,
        setCurrentConversation: mocks.setCurrentConversation,
        onNewConversation: mocks.onNewConversation,
        currentConversationId: mocks.currentConversationId,
        conversations: mocks.conversations,
        unreadCounts: mocks.unreadCounts,
        isLoadingConversations: false,
      }),
    {
      getState: () => ({
        closeIM: mocks.closeIM,
        setCurrentConversation: mocks.setCurrentConversation,
        loadConversations: mocks.loadConversations,
      }),
    },
  ),
}))

vi.mock('@/services/tabchatApi', () => ({
  listConversations: mocks.listConversations,
  createSpaceChannel: mocks.createSpaceChannel,
  getConversation: mocks.getConversation,
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        ...mocks.chatState,
        loadSessions: mocks.loadSessions,
        selectSession: mocks.selectSession,
        getSessionById: mocks.getSessionById,
        pinSessionInSpace: mocks.pinSessionInSpace,
        setCurrentSessionForSpace: mocks.setCurrentSessionForSpace,
        ensureSessionForSpace: mocks.ensureSessionForSpace,
        createSession: mocks.createSession,
        sendMessage: mocks.sendMessage,
        syncContext: mocks.syncContext,
        startDraftSessionForSpace: mocks.startDraftSessionForSpace,
      }),
    {
      getState: () => ({
        ...mocks.chatState,
        loadSessions: mocks.loadSessions,
        selectSession: mocks.selectSession,
        getSessionById: mocks.getSessionById,
        pinSessionInSpace: mocks.pinSessionInSpace,
        setCurrentSessionForSpace: mocks.setCurrentSessionForSpace,
        ensureSessionForSpace: mocks.ensureSessionForSpace,
        createSession: mocks.createSession,
        sendMessage: mocks.sendMessage,
        syncContext: mocks.syncContext,
        startDraftSessionForSpace: mocks.startDraftSessionForSpace,
      }),
    },
  ),
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: Object.assign(
    (selector: (state: {
      activateSpace: (spaceId: string) => void
      selectSpaceBySpaceId: (spaceId: string) => void
      activateConversation: (conversationId: string, preferredKind?: 'dm' | 'im-group') => boolean
      clearActiveContext: (options?: { preserveOrganizationMemory?: boolean }) => void
    }) => unknown) => selector({
      activateSpace: mocks.activateSpace,
      selectSpaceBySpaceId: mocks.selectSpaceBySpaceId,
      activateConversation: mocks.activateConversation,
      clearActiveContext: mocks.clearActiveContext,
    }),
    {
      setState: mocks.setSpaceListState,
      getState: () => ({
        activateSpace: mocks.activateSpace,
        selectSpaceBySpaceId: mocks.selectSpaceBySpaceId,
        activateConversation: mocks.activateConversation,
        clearActiveContext: mocks.clearActiveContext,
      }),
    },
  ),
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: Object.assign(
    (selector: (state: { currentTab: string; setCurrentTab: (tab: string) => void }) => unknown) =>
      selector({
        currentTab: mocks.currentTab,
        setCurrentTab: (tab: string) => {
          mocks.currentTab = tab
          mocks.setCurrentTab(tab)
        },
      }),
    {
      getState: () => ({
        currentTab: mocks.currentTab,
        setCurrentTab: (tab: string) => {
          mocks.currentTab = tab
          mocks.setCurrentTab(tab)
        },
      }),
    },
  ),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: Object.assign(
    (selector: (state: { closeSettings: () => void }) => unknown) =>
      selector({ closeSettings: mocks.closeSettings }),
    { getState: () => ({ closeSettings: mocks.closeSettings }) },
  ),
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: Object.assign(
    (selector: (state: { setChatSidePanelCollapsed: (collapsed: boolean) => void }) => unknown) =>
      selector({ setChatSidePanelCollapsed: mocks.setChatSidePanelCollapsed }),
    { getState: () => ({ setChatSidePanelCollapsed: mocks.setChatSidePanelCollapsed }) },
  ),
}))

vi.mock('@/services/memberApi', () => ({
  MemberApiService: {
    getMembers: mocks.getMembers,
  },
}))

vi.mock('@/services/spaceAccessApi', () => ({
  SpaceAccessApiService: {
    listOrganizationAgents: mocks.listOrganizationAgents,
    listSpaceMemberships: mocks.listSpaceMemberships,
    addSpaceMembership: mocks.addSpaceMembership,
  },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useUnifiedResources', () => ({
  useScopedUnifiedResources: () => ({ resources: mocks.scopedResources, isLoading: false, error: null, refresh: vi.fn() }),
  useUnifiedResources: (selector: (state: { load: typeof mocks.loadResources }) => unknown) =>
    selector({ load: mocks.loadResources }),
}))

vi.mock('@/services/oss-direct-uploader', () => ({
  directUpload: mocks.directUpload,
}))

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...actual,
    SpaceApiService: {
      createTeamSpace: vi.fn(),
      listTeamAssets: vi.fn(() => Promise.resolve([])),
      uploadSpaceFile: mocks.uploadSpaceFile,
      recordResourceAccess: mocks.recordResourceAccess,
      getSpaceFileDownloadUrl: mocks.getSpaceFileDownloadUrl,
    },
    WorkspaceApiService: {
      list: vi.fn(() => Promise.resolve([
        {
          id: 'space-1',
          organization_id: 'organization-1',
          name: '默认 Space',
          working_dir: '/tmp/space-1',
          device_online: true,
          is_home: false,
          trust_status: 'trusted',
          approval_grant: 'always_ask',
          approval_memo_generation: 0,
        },
      ])),
    },
  }
})

async function expandProjectAiOrchestration() {
  const header = await screen.findByRole('button', { name: /AI 编排项目任务/ })
  if (header.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(header)
  }
}

describe('ProjectMainContent team conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectTaskStoreTest.resetStore()
    useAppPageStore.setState({ activePage: null, activeProjectId: null })
    mocks.currentTab = 'agent'
    mocks.currentConversationId = null
    mocks.chatPanelProps.length = 0
    mocks.updateSpace.mockResolvedValue({
      id: 'team-space-1',
      name: '发布准备更新',
      organization_id: 'organization-1',
      type: 'team_space',
      execution_space_id: null,
      is_archived: false,
    })
    mocks.spaces = [
      { id: 'space-1', name: '默认 Space', organization_id: 'organization-1', type: 'workspace', project_id: 'team-space-1' },
      {
        id: 'team-space-1',
        name: '发布准备',
        description: '发布前准备工作',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
        is_archived: false,
        config_version: 7,
      },
    ]
    mocks.chatState.sessionsBySpaceId = {
      'team-space-1': [
        {
          id: 'session-task-1',
          title: '发布任务对话',
          space_id: 'team-space-1',
          last_message_preview: '继续整理发布清单',
          created_at: '2026-07-02T00:00:00Z',
          updated_at: '2026-07-02T00:00:00Z',
          last_message_at: '2026-07-02T01:00:00Z',
        },
      ],
    }
    mocks.chatState.currentSessionIdBySpaceId = { 'team-space-1': 'session-task-1' }
    mocks.chatState.draftSessionBySpaceId = {}
    mocks.chatState.messagesBySessionId = {}
    useProjectWorkspaceSelectionStore.setState({ orchestrationSessionByProjectId: {} })
    mocks.conversations = [
      {
        id: 'conv-general',
        organization_id: 'organization-1',
        space_id: 'team-space-1',
        name: '#general',
        type: 2,
        avatar_url: '',
        member_count: 2,
        is_archived: false,
        last_message_at: '2026-07-02T02:00:00Z',
        last_message_preview: '准备开始发布讨论',
        unread_count: 1,
        created_at: '2026-07-02T00:00:00Z',
        updated_at: '2026-07-02T02:00:00Z',
        is_team_space_channel: true,
        space_name: '发布准备',
      },
      {
        id: 'conv-agent-updates',
        organization_id: 'organization-1',
        space_id: 'team-space-1',
        name: '#agent-updates',
        type: 2,
        avatar_url: '',
        member_count: 2,
        is_archived: false,
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '2026-07-02T00:00:00Z',
        updated_at: '2026-07-02T00:00:00Z',
        is_team_space_channel: true,
        space_name: '发布准备',
      },
    ]
    mocks.listConversations.mockResolvedValue(mocks.conversations)
    mocks.unreadCounts = { 'conv-general': 0, 'conv-agent-updates': 0 }
    mocks.loadConversations.mockClear()
    mocks.createSpaceChannel.mockResolvedValue({ conversation_id: 'conv-design' })
    mocks.getConversation.mockResolvedValue({
      id: 'conv-design',
      organization_id: 'organization-1',
      space_id: 'team-space-1',
      name: '#design-review',
      type: 2,
      avatar_url: '',
      member_count: 2,
      is_archived: false,
      last_message_at: null,
      last_message_preview: '',
      unread_count: 0,
      created_at: '2026-07-04T00:00:00Z',
      updated_at: '2026-07-04T00:00:00Z',
      is_team_space_channel: true,
      space_name: '发布准备',
    })
    mocks.scopedResources = []
    mocks.activities = []
    mocks.listActivities.mockImplementation(() => Promise.resolve({
      items: mocks.activities,
      total: mocks.activities.length,
      page: 1,
      limit: 20,
    }))
    mocks.loadResources.mockClear()
    mocks.directUpload.mockClear()
    mocks.uploadSpaceFile.mockClear()
    mocks.recordResourceAccess.mockClear()
    mocks.getSpaceFileDownloadUrl.mockClear()
    mocks.getProject.mockResolvedValue({
      id: 'team-space-1',
      name: '发布准备',
      organization_id: 'organization-1',
      my_workspace: {
        id: 'space-1',
        name: '默认 Space',
        working_dir: 'C:\\Users\\me\\TabTin\\测试团队\\发布准备',
        control_device_id: 'device-1',
        control_device_status: 'online',
        is_companion: true,
      },
    })
    mocks.listTasks.mockResolvedValue({ tasks: [], total: 0 })
    mocks.getTask.mockImplementation((_projectId: string, taskId: string) => Promise.resolve({
      id: taskId,
      project_id: 'team-space-1',
      title: '任务详情',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'todo',
      selected_agent: null,
      project_workspace: null,
      workspace_confirmed: false,
      execution_ready: false,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      events: [],
      version: 1,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
    }))
    mocks.provisionProjectCompanionWorkspace.mockResolvedValue({
      ok: true,
      workspace: {
        id: 'space-1',
        name: '默认 Space',
        working_dir: 'C:\\Users\\me\\TabTin\\测试团队\\发布准备',
      },
    })
    mocks.createProjectWithCompanionWorkspace.mockResolvedValue({
      ok: true,
      project: {
        id: 'team-space-new',
        name: '新 Project',
        description: '',
        organization_id: 'organization-1',
        type: 'team_space',
        execution_space_id: null,
        is_archived: false,
      },
      workspace: {
        id: 'workspace-new',
        name: '新 Project 的工作空间',
        organization_id: 'organization-1',
        project_id: 'team-space-new',
        type: 'workspace',
        working_dir: 'C:\\Users\\me\\TabTin\\测试团队\\新 Project',
        execution_agent_id: null,
        control_device_id: 'device-1',
        control_device_status: 'online',
        is_companion: true,
      },
    })
  })

  it('点击Project 会进入项目模式并清理旧的全局 IM 会话态', async () => {
    const { ProjectSidebarContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(null)

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getAllByRole('button', { name: '发布准备' })[0]!)

    expect(mocks.closeSettings).toHaveBeenCalled()
    expect(mocks.setSpaceListState).toHaveBeenCalledWith({
      selectedSpaceId: 'team:team-space-1',
      selectedSpaceKind: 'team',
    })
    expect(mocks.clearActiveContext).not.toHaveBeenCalled()
    expect(mocks.closeIM).toHaveBeenCalled()
    expect(mocks.setCurrentConversation).toHaveBeenCalledWith(null)
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-1')
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('project')
  }, 20_000)

  it('退出Project 会关闭全屏页面并清空项目选择态', async () => {
    const { useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    const { exitTeamSpaceProjectView } = await import('./project/teamSpaceProjectNavigation')
    useAppPageStore.getState().openProjectPage('team-space-1')

    exitTeamSpaceProjectView('space-1')

    expect(useAppPageStore.getState()).toMatchObject({
      activePage: null,
      activeProjectId: null,
    })
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBeNull()
    expect(mocks.setCurrentTab).toHaveBeenLastCalledWith('agent')
    expect(mocks.selectSpaceBySpaceId).toHaveBeenCalledWith('space-1')
  })

  it('再次点击当前Project 会保持项目模式', async () => {
    const { ProjectSidebarContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    mocks.currentTab = 'project'
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getAllByRole('button', { name: '发布准备' })[0]!)

    expect(mocks.closeSettings).toHaveBeenCalled()
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-1')
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('project')
    expect(mocks.setSpaceListState).toHaveBeenCalledWith({
      selectedSpaceId: 'team:team-space-1',
      selectedSpaceKind: 'team',
    })
    expect(mocks.selectSpaceBySpaceId).not.toHaveBeenCalled()
    expect(mocks.clearActiveContext).not.toHaveBeenCalled()
    expect(mocks.closeIM).toHaveBeenCalled()
    expect(mocks.setCurrentConversation).toHaveBeenCalledWith(null)
  })

  it('未选中 Project 时侧栏点击会显式进入该 Project', async () => {
    const { ProjectSidebarContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    mocks.currentTab = 'collaboration'
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(null)

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getByRole('button', { name: '发布准备' }))

    expect(mocks.closeSettings).toHaveBeenCalled()
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-1')
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('project')
    expect(mocks.selectSpaceBySpaceId).not.toHaveBeenCalled()
    expect(mocks.setSpaceListState).toHaveBeenCalledWith({
      selectedSpaceId: 'team:team-space-1',
      selectedSpaceKind: 'team',
    })
    expect(mocks.clearActiveContext).not.toHaveBeenCalled()
    expect(mocks.closeIM).toHaveBeenCalled()
    expect(mocks.setCurrentConversation).toHaveBeenCalledWith(null)
  })

  it('左侧Project 行提供设置入口', async () => {
    const { ProjectSidebarContent } = await import('./ProjectWorkspacePanel')

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getByRole('button', { name: '管理 发布准备' }))

    expect(screen.getByText('Project 设置')).not.toBeNull()
    expect(screen.getByDisplayValue('发布准备')).not.toBeNull()
    expect(screen.getByText('我的工作空间')).not.toBeNull()
    expect(screen.getByText('只读')).not.toBeNull()
    expect(await screen.findByText('默认 Space')).not.toBeNull()
    expect(screen.getByText('C:\\Users\\me\\TabTin\\测试团队\\发布准备')).not.toBeNull()
    expect(mocks.closeIM).not.toHaveBeenCalled()
    expect(mocks.setCurrentConversation).not.toHaveBeenCalled()
    expect(mocks.setCurrentTab).not.toHaveBeenCalled()
  })

  it('Project 设置在我的工作空间尚未准备时显示只读空态', async () => {
    mocks.getProject.mockResolvedValueOnce({
      id: 'team-space-1',
      name: '发布准备',
      organization_id: 'organization-1',
      my_workspace: null,
    })
    const { ProjectSidebarContent } = await import('./ProjectWorkspacePanel')

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getByRole('button', { name: '管理 发布准备' }))

    expect(await screen.findByText('尚未准备工作空间')).not.toBeNull()
    expect(screen.getByText('可在成员模块中准备你的私有执行位置。')).not.toBeNull()
  })

  it('Project 设置在我的工作空间加载失败时显示可诊断状态', async () => {
    mocks.getProject.mockRejectedValueOnce(new Error('network unavailable'))
    const { ProjectSidebarContent } = await import('./ProjectWorkspacePanel')

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getByRole('button', { name: '管理 发布准备' }))

    expect(await screen.findByText('工作空间信息暂时无法加载')).not.toBeNull()
  })

  it('Project 设置关闭后会忽略迟到的工作空间响应', async () => {
    type ProjectDetail = {
      id: string
      name: string
      organization_id: string
      my_workspace: {
        id: string
        name: string
        working_dir: string
        control_device_id: string
        control_device_status: string
        is_companion: boolean
      }
    }
    let resolveStaleProject: (project: ProjectDetail) => void = () => {}
    let resolveCurrentProject: (project: ProjectDetail) => void = () => {}
    const staleRequest = new Promise<ProjectDetail>(resolve => {
      resolveStaleProject = resolve
    })
    const currentRequest = new Promise<ProjectDetail>(resolve => {
      resolveCurrentProject = resolve
    })
    mocks.getProject
      .mockReturnValueOnce(staleRequest)
      .mockReturnValueOnce(currentRequest)
    const { ProjectSidebarContent } = await import('./ProjectWorkspacePanel')

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getByRole('button', { name: '管理 发布准备' }))
    expect(screen.getByText('正在加载工作空间…')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '管理 发布准备' }))

    await act(async () => {
      resolveStaleProject({
        id: 'team-space-1',
        name: '发布准备',
        organization_id: 'organization-1',
        my_workspace: {
          id: 'workspace-stale',
          name: '旧工作空间',
          working_dir: '/stale',
          control_device_id: 'device-1',
          control_device_status: 'online',
          is_companion: true,
        },
      })
      await staleRequest
    })
    expect(screen.queryByText('旧工作空间')).toBeNull()
    expect(screen.getByText('正在加载工作空间…')).not.toBeNull()

    await act(async () => {
      resolveCurrentProject({
        id: 'team-space-1',
        name: '发布准备',
        organization_id: 'organization-1',
        my_workspace: {
          id: 'workspace-current',
          name: '当前工作空间',
          working_dir: '/current',
          control_device_id: 'device-1',
          control_device_status: 'online',
          is_companion: true,
        },
      })
      await currentRequest
    })
    expect(await screen.findByText('当前工作空间')).not.toBeNull()
  })

  it('协作空状态提供新建 Project 入口', async () => {
    mocks.spaces = [
      { id: 'space-1', name: '默认 Space', organization_id: 'organization-1', type: 'workspace' },
    ]
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(null)

    render(<ProjectMainContent surface="gallery" />)

    expect(screen.getByText('还没有Project')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '新建 Project' }))
    expect(screen.getByPlaceholderText('例如：发布准备')).not.toBeNull()
    expect(screen.getByRole('button', { name: '创建' })).not.toBeNull()
  })

  it('协作入口展示全部 Project 卡片，而不是直接进入某一个', async () => {
    mocks.spaces = [
      { id: 'space-1', name: '默认 Space', organization_id: 'organization-1', type: 'workspace' },
      {
        id: 'team-space-1',
        name: '发布准备',
        description: '发布前准备工作',
        organization_id: 'organization-1',
        type: 'team_space',
        member_count: 3,
        is_archived: false,
      },
      {
        id: 'team-space-2',
        name: '市场活动',
        description: '春季活动协作',
        organization_id: 'organization-1',
        type: 'team_space',
        member_count: 2,
        is_archived: false,
      },
    ]
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent surface="gallery" />)

    expect(screen.getByRole('heading', { name: '协作' })).not.toBeNull()
    expect(screen.getByRole('list', { name: '全部 Project' })).not.toBeNull()
    expect(screen.getByRole('button', { name: /发布准备/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /市场活动/ })).not.toBeNull()
    expect(screen.queryByRole('tab', { name: '概况' })).toBeNull()
  })

  it('详情页面包屑可返回协作列表', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent surface="detail" />)

    const crumb = screen.getByRole('navigation', { name: '面包屑' })
    expect(within(crumb).getByText('测试团队')).not.toBeNull()
    expect(within(crumb).getByRole('button', { name: '协作' })).not.toBeNull()
    expect(within(crumb).getByText('发布准备')).not.toBeNull()

    fireEvent.click(within(crumb).getByRole('button', { name: '协作' }))

    expect(useAppPageStore.getState().activePage).toBe('collaboration')
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe(null)
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
  })

  it('点击协作卡片会进入对应 Project 详情', async () => {
    mocks.spaces = [
      { id: 'space-1', name: '默认 Space', organization_id: 'organization-1', type: 'workspace' },
      {
        id: 'team-space-1',
        name: '发布准备',
        description: '发布前准备工作',
        organization_id: 'organization-1',
        type: 'team_space',
        is_archived: false,
      },
      {
        id: 'team-space-2',
        name: '市场活动',
        description: '春季活动协作',
        organization_id: 'organization-1',
        type: 'team_space',
        is_archived: false,
      },
    ]
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(null)

    render(<ProjectMainContent surface="gallery" />)
    fireEvent.click(screen.getByRole('button', { name: /市场活动/ }))

    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-2')
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('project')
    expect(mocks.setSpaceListState).toHaveBeenCalledWith({
      selectedSpaceId: 'team:team-space-2',
      selectedSpaceKind: 'team',
    })
  })

  it('新建Project 会一次性创建 Project 和我的工作空间', async () => {
    const { ProjectSidebarContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(null)

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getByRole('button', { name: '新建Project' }))

    expect(screen.getByText('Project 不拥有团队共享本地目录，也不会额外创建项目专属 Agent。', { exact: false })).not.toBeNull()
    const companionWorkspaceCopy = screen.getByText('创建后会为当前成员在该 Project 下新建私有执行工作空间，并绑定当前设备、准备默认工作目录；不会新建项目专属 Agent。Agent 产物会回流到 Project，并按团队权限共享。')
    expect(companionWorkspaceCopy.textContent).toContain('当前成员在该 Project 下新建私有执行工作空间')
    expect(companionWorkspaceCopy.textContent).toContain('绑定当前设备、准备默认工作目录')
    expect(companionWorkspaceCopy.textContent).toContain('不会新建项目专属 Agent')

    fireEvent.change(screen.getByPlaceholderText('例如：发布准备'), { target: { value: '新 Project' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(mocks.createProjectWithCompanionWorkspace).toHaveBeenCalledWith({
        organizationId: 'organization-1',
        organizationName: '测试团队',
        projectName: '新 Project',
        description: '',
      })
    })
    expect(mocks.provisionProjectCompanionWorkspace).not.toHaveBeenCalled()
    expect(mocks.spaces.some(item => item.id === 'team-space-new')).toBe(true)
    expect(mocks.spaces).toContainEqual(expect.objectContaining({
      id: 'workspace-new',
      organization_id: 'organization-1',
      type: 'workspace',
      project_id: 'team-space-new',
      control_device_id: 'device-1',
      execution_agent_id: null,
    }))
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-new')
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('project')
  })

  it('选中的Project 行提供退出入口并回到 Agent 视图', async () => {
    const { ProjectSidebarContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useAppPageStore.getState().openProjectPage('team-space-1')

    render(<ProjectSidebarContent />)
    fireEvent.click(screen.getByRole('button', { name: '退出 发布准备' }))

    expect(mocks.closeSettings).toHaveBeenCalled()
    expect(mocks.closeIM).toHaveBeenCalled()
    expect(mocks.setCurrentConversation).toHaveBeenCalledWith(null)
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe(null)
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(mocks.selectSpaceBySpaceId).toHaveBeenCalledWith('space-1')
  })

  it('详情页管理入口可以保存Project 基本信息', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    fireEvent.change(screen.getByDisplayValue('发布准备'), { target: { value: '发布准备更新' } })
    fireEvent.change(screen.getByDisplayValue('发布前准备工作'), { target: { value: '更新后的说明' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mocks.updateSpace).toHaveBeenCalledWith('team-space-1', {
        name: '发布准备更新',
        description: '更新后的说明',
        expected_version: 7,
      })
    })
  })

  it('Project 默认展示关于我的任务收件箱，并保留历史讨论读取入口', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)

    expect(screen.getByText('关于我的 Project 收件箱')).not.toBeNull()
    expect(await screen.findByText('暂时没有需要你处理的事项')).not.toBeNull()
    const overviewTab = screen.getByRole('tab', { name: '概况' })
    expect(overviewTab.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '任务' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: '讨论' }))

    expect(screen.getByText('历史讨论仅保留读取')).not.toBeNull()
    expect(await screen.findByText('#general')).not.toBeNull()
    expect(screen.getByText('#agent-updates')).not.toBeNull()
    expect(mocks.listConversations).toHaveBeenCalledWith('organization-1')

    fireEvent.click(screen.getByText('#general'))

    expect(mocks.activateConversation).not.toHaveBeenCalled()
    expect(mocks.onNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-general' }),
    )
    expect(mocks.setCurrentConversation).toHaveBeenCalledWith('conv-general')
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('project')
    expect(mocks.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
  })

  it('讨论页只读历史频道，不提供新建群或 Project Ask', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '讨论' }))

    expect(await screen.findByText('#general')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '新建讨论群' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发起 Agent 对话' })).toBeNull()
    expect(screen.getByText(/新 Project 本期不会创建频道/)).not.toBeNull()
  })

  it('Project 任务页提供全局面板 UI，不内嵌任务聊天区', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))

    expect(await screen.findByText('项目任务')).not.toBeNull()
    expect(await screen.findByText('还没有项目任务')).not.toBeNull()
    expect(screen.getByText(/责任人确认完成后结果才进入团队资产/)).not.toBeNull()
    expect(screen.getByRole('button', { name: '手动新建' })).not.toBeNull()
    expect(screen.queryByTestId('team-agent-chat-panel')).toBeNull()
    expect(mocks.activateSpace).not.toHaveBeenCalled()
    expect(mocks.loadSessions).not.toHaveBeenCalled()
  })

  it('Project 任务页会创建专属 AI 编排对话，不复用当前任务会话', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    // ：AI 编排区默认折叠，先展开再点启动
    await expandProjectAiOrchestration()
    fireEvent.click(await screen.findByRole('button', { name: '开始 AI 编排' }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        'team-space-1',
        'organization-1',
        undefined,
        { trigger: 'explicit' },
      )
      expect(mocks.ensureSessionForSpace).not.toHaveBeenCalled()
      expect(mocks.selectSession).toHaveBeenCalledWith(
        'team-space-1',
        'project-orchestration-session',
      )
      expect(mocks.syncContext).toHaveBeenCalledWith(
        'team-space-1',
        'project_tasks',
        expect.objectContaining({ project_id: 'team-space-1' }),
        [],
        { force: true, targetSessionId: 'project-orchestration-session' },
      )
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('现在只进入需求澄清阶段'),
        true,
        undefined,
        undefined,
        'project-orchestration-session',
        {
          source: 'project_orchestration',
          displayMessage: '开始 AI 编排',
        },
      )
      expect(mocks.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    })
    expect(useProjectWorkspaceSelectionStore.getState().activeTaskSessionId).toBe(
      'project-orchestration-session',
    )

    fireEvent.click(screen.getByRole('tab', { name: '概况' }))
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    await expandProjectAiOrchestration()
    fireEvent.click(await screen.findByRole('button', { name: '开始 AI 编排' }))
    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledTimes(2))
    expect(mocks.createSession).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('编排启动消息未进入会话时允许用户重试', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.sendMessage.mockImplementationOnce(async (
      _message: string,
      _streaming?: boolean,
      _attachments?: unknown,
      _contextBlocks?: unknown,
      targetSessionId?: string,
    ) => {
      if (!targetSessionId) return
      mocks.chatState.messagesBySessionId[targetSessionId] = [{
        metadata: { source: 'project_orchestration' },
        sendStatus: 'failed',
      }]
    })

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    await expandProjectAiOrchestration()
    fireEvent.click(await screen.findByRole('button', { name: '开始 AI 编排' }))
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(
        useProjectWorkspaceSelectionStore.getState()
          .orchestrationSessionByProjectId['team-space-1']?.started,
      ).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: '开始 AI 编排' }))
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2))
  })

  it('Project 任务按生命周期进入四列看板，受阻与存量待验收归入执行中', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const taskBase = {
      project_id: 'team-space-1',
      description: '用于验证看板分组',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      selected_agent: null,
      project_workspace: null,
      workspace_confirmed: false,
      execution_ready: false,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
    }
    const boardTasks = [
      { ...taskBase, id: 'task-todo', title: '等待确认执行现场', work_status: 'todo' },
      { ...taskBase, id: 'task-running', title: '正在执行发布检查', work_status: 'in_progress' },
      { ...taskBase, id: 'task-blocked', title: '等待外部依赖', work_status: 'blocked' },
      { ...taskBase, id: 'task-review', title: '存量待验收任务', work_status: 'in_review' },
      { ...taskBase, id: 'task-done', title: '已发布交付结果', work_status: 'done' },
      { ...taskBase, id: 'task-cancelled', title: '已停止的旧任务', work_status: 'cancelled' },
    ]
    mocks.listTasks.mockResolvedValue({ tasks: boardTasks, total: boardTasks.length })

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))

    const backlog = await screen.findByRole('region', { name: '待处理，1 项任务' })
    const active = screen.getByRole('region', { name: '执行中，3 项任务' })
    const closed = screen.getByRole('region', { name: '已完成，1 项任务' })
    const cancelled = screen.getByRole('region', { name: '已取消，1 项任务' })

    expect(within(backlog).getByText('等待确认执行现场')).not.toBeNull()
    expect(within(active).getByText('正在执行发布检查')).not.toBeNull()
    expect(within(active).getByText('等待外部依赖')).not.toBeNull()
    expect(within(active).getByText('受阻')).not.toBeNull()
    expect(within(active).getByText('存量待验收任务')).not.toBeNull()
    expect(screen.queryByRole('region', { name: /待验收/ })).toBeNull()
    expect(within(closed).getByText('已发布交付结果')).not.toBeNull()
    expect(within(closed).queryByText('已停止的旧任务')).toBeNull()
    expect(within(cancelled).getByText('已停止的旧任务')).not.toBeNull()
    const board = screen.getByTestId('project-task-board')
    expect(board.firstElementChild?.className).toContain('min-w-[52rem]')
    expect(board.firstElementChild?.className).toContain('grid-cols-4')
    expect(screen.queryByRole('button', { name: '完成' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '打开对话' })).toBeNull()
    expect(screen.queryByRole('button', { name: /查看对话/ })).toBeNull()
  })

  it('责任人可在执行中确认停止并取消任务', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const runningTask = {
      id: 'task-running-cancel',
      project_id: 'team-space-1',
      title: '停止这次执行',
      description: '中途决定不再继续',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'in_progress',
      selected_agent: { id: 'bot-agent-1', name: '真实 Research Agent' },
      project_workspace: {
        id: 'workspace-1',
        name: 'Project 工作空间',
        device_status: 'online',
        confirmed_at: '2026-07-20T08:00:00Z',
      },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '',
      result_visibility: 'private',
      latest_run: {
        id: 'run-cancel-1',
        status: 'running',
        rerun_of_id: null,
        chat_session_id: null,
        result_summary: '',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T08:01:00Z',
        ended_at: null,
        created_at: '2026-07-20T08:01:00Z',
      },
      deliverables: [],
      version: 2,
      created_at: '2026-07-20T08:00:00Z',
      updated_at: '2026-07-20T08:01:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [runningTask], total: 1 })
    mocks.cancelTask.mockResolvedValue({
      ...runningTask,
      work_status: 'cancelled',
      latest_run: { ...runningTask.latest_run, status: 'cancelled' },
    })
    mocks.getTask.mockResolvedValue(runningTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：停止这次执行' }))
    const detailDialog = await screen.findByTestId('project-task-detail-page')
    expect(within(detailDialog).getByText('操作')).not.toBeNull()
    fireEvent.click(within(detailDialog).getByRole('button', { name: '停止执行' }))

    expect(screen.getByRole('heading', { name: '停止并取消任务？' })).not.toBeNull()
    expect(screen.getByText(/已经产生的中间内容仍保留/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认取消' }))

    await waitFor(() => {
      expect(mocks.cancelTask).toHaveBeenCalledWith('team-space-1', 'task-running-cancel')
    })
  })

  it('责任人拒绝任务后仍可从详情取消', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const rejectedTask = {
      id: 'task-rejected-cancel',
      project_id: 'team-space-1',
      title: '不再处理的任务',
      description: '责任人已经拒绝任务',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'rejected',
      work_status: 'todo',
      selected_agent: null,
      project_workspace: null,
      workspace_confirmed: false,
      execution_ready: false,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      version: 2,
      created_at: '2026-07-20T08:00:00Z',
      updated_at: '2026-07-20T08:01:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [rejectedTask], total: 1 })
    mocks.getTask.mockResolvedValue(rejectedTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：不再处理的任务' }))

    const detailDialog = await screen.findByTestId('project-task-detail-page')
    expect(within(detailDialog).getByRole('button', { name: '取消任务' })).not.toBeNull()
  })

  it('待确认任务使用对称的接受与拒绝文案', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const pendingTask = {
      id: 'task-pending-acceptance',
      project_id: 'team-space-1',
      title: '等待确认的任务',
      description: '等待责任人确认',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'pending',
      work_status: 'todo',
      selected_agent: null,
      project_workspace: null,
      workspace_confirmed: false,
      execution_ready: false,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T08:00:00Z',
      updated_at: '2026-07-20T08:00:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [pendingTask], total: 1 })
    mocks.getTask.mockResolvedValue(pendingTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：等待确认的任务' }))

    const detailDialog = await screen.findByTestId('project-task-detail-page')
    expect(within(detailDialog).getByRole('button', { name: '接受任务' })).not.toBeNull()
    expect(within(detailDialog).getByRole('button', { name: '拒绝任务' })).not.toBeNull()
    expect(within(detailDialog).queryByRole('button', { name: '接单' })).toBeNull()
  })

  it('关闭或切换任务详情后忽略迟到的详情响应', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const taskBase = {
      project_id: 'team-space-1',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'todo',
      selected_agent: null,
      project_workspace: null,
      workspace_confirmed: false,
      execution_ready: false,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T08:00:00Z',
      updated_at: '2026-07-20T08:00:00Z',
    }
    const firstTask = { ...taskBase, id: 'task-detail-first', title: '第一个任务' }
    const secondTask = { ...taskBase, id: 'task-detail-second', title: '第二个任务' }
    let resolveFirst: (task: typeof firstTask) => void = () => {}
    let resolveSecond: (task: typeof secondTask) => void = () => {}
    const firstResponse = new Promise<typeof firstTask>(resolve => {
      resolveFirst = resolve
    })
    const secondResponse = new Promise<typeof secondTask>(resolve => {
      resolveSecond = resolve
    })
    mocks.listTasks.mockResolvedValue({ tasks: [firstTask, secondTask], total: 2 })
    mocks.getTask.mockImplementation((_projectId: string, taskId: string) => (
      taskId === firstTask.id ? firstResponse : secondResponse
    ))

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：第一个任务' }))
    fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))

    await act(async () => {
      resolveFirst(firstTask)
      await firstResponse
    })
    expect(screen.queryByRole('dialog')).toBeNull()

    let resolveFirstAfterReopen: (task: typeof firstTask) => void = () => {}
    const firstResponseAfterReopen = new Promise<typeof firstTask>(resolve => {
      resolveFirstAfterReopen = resolve
    })
    mocks.getTask.mockImplementation((_projectId: string, taskId: string) => (
      taskId === firstTask.id ? firstResponseAfterReopen : secondResponse
    ))
    fireEvent.click(screen.getByRole('button', { name: '查看任务详情：第一个任务' }))
    fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))
    fireEvent.click(screen.getByRole('button', { name: '查看任务详情：第二个任务' }))
    await act(async () => {
      resolveSecond(secondTask)
      await secondResponse
    })
    await act(async () => {
      resolveFirstAfterReopen(firstTask)
      await firstResponseAfterReopen
    })

    const detailPage = screen.getByTestId('project-task-detail-page')
    expect(within(detailPage).getByRole('heading', { name: '第二个任务' })).not.toBeNull()
    expect(within(detailPage).queryByRole('heading', { name: '第一个任务' })).toBeNull()
  })

  it('旧任务操作完成前会禁用新任务操作', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const taskBase = {
      project_id: 'team-space-1',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'todo',
      selected_agent: { id: 'bot-agent-1', name: 'Agent' },
      project_workspace: { id: 'workspace-1', name: '工作空间' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T08:00:00Z',
      updated_at: '2026-07-20T08:00:00Z',
    }
    const firstTask = { ...taskBase, id: 'task-action-first', title: '先执行的任务' }
    const secondTask = { ...taskBase, id: 'task-action-second', title: '后打开的任务' }
    const startedFirstTask = {
      ...firstTask,
      work_status: 'in_progress',
      latest_run: {
        id: 'run-action-first',
        status: 'running',
        rerun_of_id: null,
        chat_session_id: 'session-action-first',
        result_summary: '',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T08:01:00Z',
        ended_at: null,
        created_at: '2026-07-20T08:01:00Z',
      },
    }
    let resolveRun: (task: typeof startedFirstTask) => void = () => {}
    const runResponse = new Promise<typeof startedFirstTask>(resolve => {
      resolveRun = resolve
    })
    mocks.listTasks.mockResolvedValue({ tasks: [firstTask, secondTask], total: 2 })
    mocks.getTask.mockImplementation((_projectId: string, taskId: string) => (
      Promise.resolve(taskId === firstTask.id ? firstTask : secondTask)
    ))
    mocks.startTaskRun.mockReturnValue(runResponse)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：先执行的任务' }))
    const firstDialog = await screen.findByTestId('project-task-detail-page')
    expect(within(firstDialog).getByLabelText('执行补充说明')).not.toBeNull()
    fireEvent.click(within(firstDialog).getByRole('button', { name: '开始执行' }))
    fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))
    fireEvent.click(screen.getByRole('button', { name: '查看任务详情：后打开的任务' }))

    const secondDialog = await screen.findByTestId('project-task-detail-page')
    expect((within(secondDialog).getByRole('button', { name: '开始执行' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveRun(startedFirstTask)
      await runResponse
    })
    // 开始执行成功后会关掉详情并切入执行会话，全局 action 锁也随即释放。
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(mocks.selectSession).toHaveBeenCalledWith('team-space-1', 'session-action-first', {
      draftScopeKey: 'conversation:draft:team-space-1',
      organizationId: 'organization-1',
      projectId: 'team-space-1',
    })
    expect(useProjectWorkspaceSelectionStore.getState().activeTaskSessionId).toBe('session-action-first')
  }, 10000)

  it('开始执行成功后关闭详情并打开执行会话', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const readyTask = {
      id: 'task-start-run',
      project_id: 'team-space-1',
      title: '起草周末团建策划手册',
      description: '产出一篇在线文档',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'todo',
      selected_agent: { id: 'bot-agent-1', name: 'Agent' },
      project_workspace: { id: 'workspace-1', name: '工作空间' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      version: 1,
      created_at: '2026-07-21T03:31:00Z',
      updated_at: '2026-07-21T03:31:00Z',
    }
    const startedTask = {
      ...readyTask,
      work_status: 'in_progress',
      latest_run: {
        id: 'run-start-1',
        status: 'running',
        rerun_of_id: null,
        chat_session_id: 'session-start-1',
        result_summary: '',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-21T03:50:00Z',
        ended_at: null,
        created_at: '2026-07-21T03:50:00Z',
      },
    }
    mocks.listTasks.mockResolvedValue({ tasks: [readyTask], total: 1 })
    mocks.getTask.mockResolvedValue(readyTask)
    mocks.startTaskRun.mockResolvedValue(startedTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：起草周末团建策划手册' }))
    fireEvent.click(within(await screen.findByTestId('project-task-detail-page')).getByRole('button', { name: '开始执行' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(mocks.startTaskRun).toHaveBeenCalledWith('team-space-1', 'task-start-run', {
        message: '',
        attachments: [],
      })
      expect(mocks.selectSession).toHaveBeenCalledWith('team-space-1', 'session-start-1', {
        draftScopeKey: 'conversation:draft:team-space-1',
        organizationId: 'organization-1',
        projectId: 'team-space-1',
      })
    })
    expect(useProjectWorkspaceSelectionStore.getState().activeTaskSessionId).toBe('session-start-1')
    expect(mocks.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
  })

  it('点击任务卡片打开完整详情，并可从执行结果打开在线文档', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const task = {
      id: 'task-detail-1',
      project_id: 'team-space-1',
      title: '整理发布说明',
      description: '输出一份团队可协作编辑的发布说明。',
      priority: 'high',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-2', name: 'Mira Editor' },
      assignment_status: 'accepted',
      work_status: 'done',
      selected_agent: { id: 'bot-agent-1', name: '真实 Research Agent' },
      project_workspace: { id: 'space-1', name: '默认 Space' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '发布说明已整理完成：\n\n- **结论**：可以发布\n- 已补齐验证记录',
      latest_run: {
        id: 'run-detail-1',
        status: 'completed',
        rerun_of_id: null,
        chat_session_id: 'session-detail-1',
        result_summary: '',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      deliverables: [{
        id: 'deliverable-summary',
        context_item_id: 'context-summary',
        title: '整理发布说明 · 交付结果',
        item_type: 'team_asset',
        resource_id: 'project_task_run:run-detail-1',
        preview: '发布说明已整理完成。',
        metadata: { asset_kind: 'task_deliverable' },
        created_at: '2026-07-20T00:01:00Z',
      }, {
        id: 'deliverable-doc',
        context_item_id: 'context-detail-doc',
        title: '版本发布说明',
        item_type: 'tabdoc',
        resource_id: 'doc-detail-1',
        preview: '包含改动摘要与验证记录。',
        metadata: { asset_kind: 'tabdoc' },
        created_at: '2026-07-20T00:01:00Z',
      }],
      events: [{
        id: 'event-created',
        event_type: 'created',
        actor: { id: 'user-1', name: 'Seda Owner' },
        payload: {},
        created_at: '2026-07-20T00:00:00Z',
      }],
      version: 1,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:01:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [task], total: 1 })
    mocks.getTask.mockResolvedValue(task)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：整理发布说明' }))

    const detailPage = await screen.findByTestId('project-task-detail-page')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(detailPage).getByRole('heading', { name: '整理发布说明' })).not.toBeNull()
    expect(within(detailPage).getByText('输出一份团队可协作编辑的发布说明。')).not.toBeNull()
    expect(within(detailPage).getByText('结论').tagName).toBe('STRONG')
    expect(within(detailPage).getByText('已补齐验证记录')).not.toBeNull()
    expect(within(detailPage).getByText('属性')).not.toBeNull()
    expect(within(detailPage).getByText('动态')).not.toBeNull()
    expect(within(detailPage).getByRole('button', { name: '返回任务列表' })).not.toBeNull()
    expect(screen.getByTestId('project-task-detail-scroll').className).toContain('overflow-auto')
    expect(screen.getByTestId('project-task-detail-layout').className).toContain('min-w-[52rem]')
    expect(screen.getByTestId('project-task-detail-layout').className).toContain('grid-cols-[minmax(0,1fr)_17rem]')
    const { useCloudDocumentPreviewStore } = await import('@/components/chat/preview/useCloudDocumentPreviewStore')
    useCloudDocumentPreviewStore.getState().close()

    // 文档正文默认内嵌只读展示，不再需要点卡片弹窗。
    expect(within(detailPage).getByTestId('inline-doc-preview').getAttribute('data-document-id')).toBe('doc-detail-1')
    expect(within(detailPage).getByText('版本发布说明')).not.toBeNull()

    // 「打开」仍作为次级入口在弹窗中打开完整文档。
    fireEvent.click(within(detailPage).getByRole('button', { name: '打开' }))

    await waitFor(() => {
      expect(useCloudDocumentPreviewStore.getState().target).toEqual({
        documentId: 'doc-detail-1',
        resourceSpaceId: 'team-space-1',
        organizationId: 'organization-1',
        title: '版本发布说明',
      })
    })
    expect(mocks.openTeamSpaceTabdoc).not.toHaveBeenCalled()
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-1')

    useCloudDocumentPreviewStore.getState().close()
    fireEvent.click(within(detailPage).getByRole('button', { name: '版本历史' }))
    await waitFor(() => {
      expect(useCloudDocumentPreviewStore.getState().target).toEqual({
        documentId: 'doc-detail-1',
        resourceSpaceId: 'team-space-1',
        organizationId: 'organization-1',
        title: '版本发布说明',
        openVersionHistory: true,
      })
    })
  })

  it('执行中结果自动带入云端交付物，并允许移除后重新添加再完成', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const reviewTask = {
      id: 'task-review-assets',
      project_id: 'team-space-1',
      title: '生成天气文档',
      description: '生成一篇可协作的在线文档',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'in_progress',
      selected_agent: { id: 'bot-agent-1', name: '真实 Research Agent' },
      project_workspace: { id: 'space-1', name: '默认 Space' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '',
      result_visibility: 'private',
      latest_run: {
        id: 'run-review-assets',
        status: 'completed',
        rerun_of_id: null,
        chat_session_id: 'session-task-run-assets',
        result_summary: '已生成上海天气在线文档。',
        result_items: [{
          id: 'context-doc-1',
          context_item_id: 'context-doc-1',
          resource_type: 'tabdoc',
          resource_id: 'doc-1',
          item_type: 'tabdoc',
          title: '上海今日天气',
          preview: '包含天气概况和生活建议。',
        }],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      latest_completed_run: {
        id: 'run-review-assets',
        status: 'completed',
        rerun_of_id: null,
        chat_session_id: 'session-task-run-assets',
        result_summary: '已生成上海天气在线文档。',
        result_items: [{
          id: 'context-doc-1',
          context_item_id: 'context-doc-1',
          resource_type: 'tabdoc',
          resource_id: 'doc-1',
          item_type: 'tabdoc',
          title: '上海今日天气',
          preview: '包含天气概况和生活建议。',
        }],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:01:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [reviewTask], total: 1 })
    mocks.acceptTaskResult.mockResolvedValue({ ...reviewTask, work_status: 'done' })
    mocks.getTask.mockResolvedValue(reviewTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：生成天气文档' }))
    fireEvent.click(within(await screen.findByTestId('project-task-detail-page')).getByRole('button', { name: '完成' }))

    expect(screen.getByText('上海今日天气')).not.toBeNull()
    const included = screen.getByRole('button', { name: '已加入执行结果' })
    expect(included.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(included)
    expect(screen.getByRole('button', { name: '添加到执行结果' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加到执行结果' }))
    fireEvent.click(screen.getByRole('button', { name: '确认完成并发布' }))

    await waitFor(() => {
      expect(mocks.acceptTaskResult).toHaveBeenCalledWith(
        'team-space-1',
        'task-review-assets',
        expect.objectContaining({
          result_summary: '已生成上海天气在线文档。',
          result_item_ids: ['context-doc-1'],
        }),
      )
    })
  })

  it('责任人无需开关，中间产物默认内嵌展示且不再有可见性两态文案', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const reviewTask = {
      id: 'task-preview-visibility',
      project_id: 'team-space-1',
      title: '常态展示中间产物',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'in_progress',
      selected_agent: { id: 'bot-agent-1', name: '真实 Research Agent' },
      project_workspace: { id: 'space-1', name: '默认 Space' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '',
      // 仍保留私有可见性，验证内嵌预览不再依赖「先给大家看」放开。
      result_visibility: 'private' as const,
      latest_run: {
        id: 'run-preview-visibility',
        status: 'completed' as const,
        rerun_of_id: null,
        chat_session_id: 'session-preview',
        result_summary: '可供预览的摘要',
        result_items: [{
          id: 'context-preview-1',
          context_item_id: 'context-preview-1',
          resource_type: 'tabdoc',
          resource_id: 'doc-preview-1',
          item_type: 'tabdoc',
          title: '预览文档',
          preview: '摘要',
        }],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      latest_completed_run: {
        id: 'run-preview-visibility',
        status: 'completed' as const,
        rerun_of_id: null,
        chat_session_id: 'session-preview',
        result_summary: '可供预览的摘要',
        result_items: [{
          id: 'context-preview-1',
          context_item_id: 'context-preview-1',
          resource_type: 'tabdoc',
          resource_id: 'doc-preview-1',
          item_type: 'tabdoc',
          title: '预览文档',
          preview: '摘要',
        }],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:01:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [reviewTask], total: 1 })
    mocks.getTask.mockResolvedValue(reviewTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：常态展示中间产物' }))

    const detail = await screen.findByTestId('project-task-detail-page')
    // 文档正文内嵌展示，即使可见性仍为私有。
    expect(within(detail).getByTestId('inline-doc-preview').getAttribute('data-document-id')).toBe('doc-preview-1')
    // 「先给大家看」开关与两态文案已彻底移除。
    expect(within(detail).queryByRole('switch', { name: '先给大家看结果预览' })).toBeNull()
    expect(within(detail).queryByText('放开≠完成。成员可只读打开候选正文并评论；可随时收回。')).toBeNull()
    expect(within(detail).queryByText('结果预览')).toBeNull()
    expect(mocks.setTaskResultVisibility).not.toHaveBeenCalled()
  })

  it('非责任成员默认内嵌只读预览候选 TabDoc（不依赖放开开关）', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    const { useCloudDocumentPreviewStore } = await import('@/components/chat/preview/useCloudDocumentPreviewStore')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    useCloudDocumentPreviewStore.getState().close()
    mocks.openTeamSpaceTabdoc.mockClear()

    const previewTask = {
      id: 'task-member-preview-open',
      project_id: 'team-space-1',
      title: '成员预览候选文档',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-2', name: 'Mira Editor' },
      responsible_user: { id: 'user-2', name: 'Mira Editor' },
      assignment_status: 'accepted',
      work_status: 'in_progress',
      selected_agent: { id: 'bot-agent-2', name: 'Mira Agent' },
      project_workspace: { id: 'companion-workspace-mira', name: 'Mira 工作空间' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '可供成员阅读的摘要',
      // 私有可见性下成员仍应看到内嵌预览：前端不再按可见性门控，真实访问由后端 ACL 决定。
      result_visibility: 'private' as const,
      latest_run: {
        id: 'run-member-preview',
        status: 'completed' as const,
        rerun_of_id: null,
        chat_session_id: null,
        result_summary: '可供成员阅读的摘要',
        result_items: [{
          id: 'context-member-preview-1',
          context_item_id: 'context-member-preview-1',
          resource_type: 'tabdoc',
          resource_id: 'doc-member-preview-1',
          item_type: 'tabdoc',
          title: '周末团建策划手册',
          preview: '摘要',
          resource_space_id: 'companion-workspace-mira',
        }],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      latest_completed_run: {
        id: 'run-member-preview',
        status: 'completed' as const,
        rerun_of_id: null,
        chat_session_id: null,
        result_summary: '可供成员阅读的摘要',
        result_items: [{
          id: 'context-member-preview-1',
          context_item_id: 'context-member-preview-1',
          resource_type: 'tabdoc',
          resource_id: 'doc-member-preview-1',
          item_type: 'tabdoc',
          title: '周末团建策划手册',
          preview: '摘要',
          resource_space_id: 'companion-workspace-mira',
        }],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      deliverables: [],
      version: 2,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:01:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [previewTask], total: 1 })
    mocks.getTask.mockResolvedValue(previewTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：成员预览候选文档' }))

    const detail = await screen.findByTestId('project-task-detail-page')
    // 成员直接看到内嵌正文预览，不再有「只读预览」等可见性两态文案。
    expect(within(detail).getByTestId('inline-doc-preview').getAttribute('data-document-id')).toBe('doc-member-preview-1')
    expect(within(detail).queryByText('只读预览', { exact: false })).toBeNull()

    // 「打开」次级入口仍在弹窗中按候选文档真实归属（责任人伴生 Workspace）只读打开。
    fireEvent.click(within(detail).getByRole('button', { name: '打开' }))

    await waitFor(() => {
      expect(useCloudDocumentPreviewStore.getState().target).toEqual({
        documentId: 'doc-member-preview-1',
        resourceSpaceId: 'companion-workspace-mira',
        organizationId: 'organization-1',
        title: '周末团建策划手册',
      })
    })
    expect(mocks.openTeamSpaceTabdoc).not.toHaveBeenCalled()
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-1')
  }, 15000)

  it('取消新建任务后会清空草稿，重新打开不带入上次输入', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '手动新建' }))
    expect(screen.getByLabelText('指派人')).not.toBeNull()
    fireEvent.change(screen.getByPlaceholderText('例如：完成上线前验收'), {
      target: { value: '不应保留的草稿' },
    })
    fireEvent.change(screen.getByPlaceholderText('补充范围、约束和验收标准'), {
      target: { value: '临时说明' },
    })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '手动新建' }))

    expect((screen.getByPlaceholderText('例如：完成上线前验收') as HTMLInputElement).value).toBe('')
    expect((screen.getByPlaceholderText('补充范围、约束和验收标准') as HTMLTextAreaElement).value).toBe('')
  })

  it('新建任务提交期间不可关闭弹窗或清空草稿', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    let resolveCreate: (task: { id: string }) => void = () => {}
    const createResponse = new Promise<{ id: string }>(resolve => {
      resolveCreate = resolve
    })
    mocks.createTask.mockReturnValue(createResponse)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '手动新建' }))
    fireEvent.change(screen.getByPlaceholderText('例如：完成上线前验收'), {
      target: { value: '提交中的任务' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    const createDialog = screen.getByRole('dialog')
    expect((within(createDialog).getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(createDialog).getByRole('button', { name: '关闭新建任务' }))
    expect(screen.getByRole('dialog')).toBe(createDialog)
    expect((screen.getByPlaceholderText('例如：完成上线前验收') as HTMLInputElement).value).toBe('提交中的任务')

    await act(async () => {
      resolveCreate({ id: 'task-created' })
      await createResponse
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('任务详情动态里的开始执行事件可前往对话', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const runningTask = {
      id: 'task-go-chat',
      project_id: 'team-space-1',
      title: '起草周末团建策划手册',
      description: '产出一篇在线文档',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'in_progress',
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      selected_agent: { id: 'bot-agent-1', name: '默认工作空间执行身份' },
      project_workspace: { id: 'space-1', name: '团建 2 项目的默认工作空间' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '',
      result_visibility: 'private',
      latest_run: {
        id: '889dbdb4-87d3-421a-8dbe-598b7109ac3e',
        status: 'running',
        rerun_of_id: null,
        chat_session_id: 'session-go-chat-1',
        result_summary: '',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-21T03:50:00Z',
        ended_at: null,
        created_at: '2026-07-21T03:32:00Z',
      },
      events: [
        {
          id: 'event-created',
          event_type: 'created',
          actor: { id: 'user-1', name: '主人' },
          payload: {},
          created_at: '2026-07-21T03:31:00Z',
        },
        {
          id: 'event-run-started',
          event_type: 'run_started',
          actor: { id: 'user-1', name: '主人' },
          payload: {
            run_id: '889dbdb4-87d3-421a-8dbe-598b7109ac3e',
            chat_session_id: 'session-go-chat-1',
          },
          created_at: '2026-07-21T03:50:00Z',
        },
      ],
      deliverables: [],
      version: 1,
      created_at: '2026-07-21T03:31:00Z',
      updated_at: '2026-07-21T03:50:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [runningTask], total: 1 })
    mocks.getTask.mockResolvedValue(runningTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：起草周末团建策划手册' }))
    const detailPage = await screen.findByTestId('project-task-detail-page')
    fireEvent.click(within(detailPage).getByRole('button', { name: '前往对话' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(mocks.selectSession).toHaveBeenCalledWith('team-space-1', 'session-go-chat-1', {
        draftScopeKey: 'conversation:draft:team-space-1',
        organizationId: 'organization-1',
        projectId: 'team-space-1',
      })
    })
    expect(useProjectWorkspaceSelectionStore.getState().activeTaskSessionId).toBe('session-go-chat-1')
    expect(mocks.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
  })

  it('任务详情列出多条对话并可分别打开', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const multiConversationTask = {
      id: 'task-multi-conv',
      project_id: 'team-space-1',
      title: '多次执行的任务',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'blocked',
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      selected_agent: { id: 'bot-agent-1', name: '真实 Research Agent' },
      project_workspace: { id: 'space-1', name: '默认 Space' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '',
      result_visibility: 'private',
      latest_run: {
        id: 'run-2',
        status: 'failed',
        rerun_of_id: 'run-1',
        chat_session_id: 'session-run-2',
        result_summary: '第二次失败',
        result_items: [],
        safe_failure_reason: '需要补充约束',
        binding: {},
        started_at: '2026-07-21T01:00:00Z',
        ended_at: '2026-07-21T01:05:00Z',
        created_at: '2026-07-21T01:00:00Z',
      },
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
      version: 2,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-21T01:05:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [multiConversationTask], total: 1 })
    mocks.getTask.mockResolvedValue(multiConversationTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：多次执行的任务' }))

    const conversations = await screen.findByTestId('project-task-conversations')
    expect(within(conversations).getByText('[Task] 多次执行的任务 · 2')).not.toBeNull()
    expect(within(conversations).getByText('[Task] 多次执行的任务 · 1')).not.toBeNull()
    expect(within(conversations).getByRole('button', { name: '新开对话' })).not.toBeNull()

    fireEvent.click(within(conversations).getByRole('button', {
      name: /\[Task\] 多次执行的任务 · 1/,
    }))
    await waitFor(() => {
      expect(mocks.selectSession).toHaveBeenCalledWith('team-space-1', 'session-run-1', {
        draftScopeKey: 'conversation:draft:team-space-1',
        organizationId: 'organization-1',
        projectId: 'team-space-1',
      })
    })
    expect(useProjectWorkspaceSelectionStore.getState().activeTaskSessionId).toBe('session-run-1')

    fireEvent.click(within(await screen.findByTestId('project-task-detail-page')).getByRole('button', {
      name: '查看对话（2）',
    }))
    expect(mocks.selectSession).toHaveBeenCalledTimes(1)
  })

  it('执行会话在 Project 内打开，不把 Project 当作执行工作空间导航', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const completedTask = {
      id: 'task-1',
      project_id: 'team-space-1',
      title: '发布验收',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'done',
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      selected_agent: { id: 'bot-agent-1', name: '真实 Research Agent' },
      project_workspace: { id: 'space-1', name: '默认 Space' },
      workspace_confirmed: true,
      execution_ready: true,
      result_summary: '已完成',
      latest_run: {
        id: 'run-1',
        status: 'completed',
        rerun_of_id: null,
        chat_session_id: 'session-task-run-1',
        result_summary: '已完成',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-20T00:00:00Z',
        ended_at: '2026-07-20T00:01:00Z',
        created_at: '2026-07-20T00:00:00Z',
      },
      conversations: [
        {
          session_id: 'session-task-run-1',
          run_id: 'run-1',
          kind: 'execution',
          run_status: 'completed',
          rerun_of_id: null,
          title: '[Task] 发布验收',
          is_active: false,
          created_at: '2026-07-20T00:00:00Z',
        },
      ],
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:01:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [completedTask], total: 1 })
    mocks.getTask.mockResolvedValue(completedTask)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：发布验收' }))
    fireEvent.click(within(await screen.findByTestId('project-task-detail-page')).getByRole('button', { name: '打开对话' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    await waitFor(() => {
      expect(mocks.loadSessions).toHaveBeenCalledWith('team-space-1', 'organization-1')
      expect(mocks.selectSession).toHaveBeenCalledWith('team-space-1', 'session-task-run-1', {
        draftScopeKey: 'conversation:draft:team-space-1',
        organizationId: 'organization-1',
        projectId: 'team-space-1',
      })
    })
    expect(useProjectWorkspaceSelectionStore.getState().activeTaskSessionId).toBe('session-task-run-1')
    expect(mocks.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    expect(mocks.selectSpaceBySpaceId).not.toHaveBeenCalledWith('team-space-1')
  })

  it('动态流可按任务、Agent、资产、讨论、成员和 Project 分类筛选', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const base = {
      actor_user_id: 'user-1',
      actor_name: '小燕子',
      metadata: {},
      created_at: '2026-07-20T10:00:00Z',
    }
    mocks.activities = [
      {
        ...base,
        id: 'event-task',
        event_type: 'task_created',
        target_type: 'task',
        target_id: 'task-1',
        target_name: '整理发布说明',
        metadata: {
          responsible_user_name: '小燕子',
          priority: 'medium',
        },
      },
      { ...base, id: 'event-agent', event_type: 'agent_run_started', target_type: 'agent_run', target_id: 'run-1', target_name: '执行发布检查' },
      { ...base, id: 'event-asset', event_type: 'asset_created', target_type: 'asset', target_id: 'asset-1', target_name: '发布说明文档' },
      { ...base, id: 'event-channel', event_type: 'channel_created', target_type: 'channel', target_id: 'channel-1', target_name: '设计讨论' },
      { ...base, id: 'event-member', event_type: 'member_joined', target_type: 'member', target_id: 'user-2', target_name: '主人' },
      { ...base, id: 'event-project', event_type: 'settings_updated', target_type: 'space', target_id: 'team-space-1', target_name: '发布准备' },
    ]

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '动态' }))

    expect(
      await screen.findByText('小燕子 创建了任务「整理发布说明」 · 指派给 小燕子 · 优先级 中'),
    ).not.toBeNull()
    expect(screen.getByText('小燕子 新增了资产「发布说明文档」')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '任务' }))
    expect(
      screen.getByText('小燕子 创建了任务「整理发布说明」 · 指派给 小燕子 · 优先级 中'),
    ).not.toBeNull()
    expect(screen.queryByText('小燕子 新增了资产「发布说明文档」')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '交付资产' }))
    expect(screen.getByText('小燕子 新增了资产「发布说明文档」')).not.toBeNull()
    expect(
      screen.queryByText('小燕子 创建了任务「整理发布说明」 · 指派给 小燕子 · 优先级 中'),
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    expect(screen.getByText('小燕子 更新了 Project 设置')).not.toBeNull()
  })

  it('讨论频道展示 IM unreadCounts 角标并在未读变化时刷新列表', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.unreadCounts = { 'conv-general': 3, 'conv-agent-updates': 0 }
    mocks.listConversations
      .mockResolvedValueOnce(mocks.conversations)
      .mockResolvedValueOnce([
        {
          ...mocks.conversations[0],
          last_message_at: '2026-07-04T03:00:00Z',
          last_message_preview: 'TS验-成员: 我听说他们不能吃辣',
        },
        mocks.conversations[1],
      ])

    const { rerender } = render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '讨论' }))
    expect(await screen.findByText('3')).not.toBeNull()

    mocks.unreadCounts = { 'conv-general': 4, 'conv-agent-updates': 0 }
    rerender(<ProjectMainContent />)

    await waitFor(() => {
      expect(mocks.listConversations.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    expect(await screen.findByText('TS验-成员: 我听说他们不能吃辣')).not.toBeNull()
    expect(screen.getByText('4')).not.toBeNull()
  })

  it('正在查看的讨论频道不展示未读角标', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.unreadCounts = { 'conv-general': 2, 'conv-agent-updates': 0 }
    mocks.currentConversationId = 'conv-general'
    mocks.listConversations.mockResolvedValue(mocks.conversations)

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '讨论' }))

    expect(await screen.findByText('#general')).not.toBeNull()
    expect(screen.queryByText('2')).toBeNull()
  })

  it('从讨论频道切到其他 tab 会关闭 IM 频道', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.currentConversationId = 'conv-general'

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))

    expect(mocks.setCurrentConversation).toHaveBeenCalledWith(null)
  })

  it('概况快速入口进入任务面板，不创建 Project 对话', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('button', { name: '创建或处理任务' }))

    expect(await screen.findByText('项目任务')).not.toBeNull()
    expect(mocks.startDraftSessionForSpace).not.toHaveBeenCalled()
    expect(mocks.activateSpace).not.toHaveBeenCalled()
    expect(mocks.provisionProjectCompanionWorkspace).not.toHaveBeenCalled()
  })

  it('资产页不展示聊天里的 AI 最终答复，只展示文件和明确产物', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.scopedResources = [
      {
        id: 'final-answer-1',
        space_id: 'team-space-1',
        item_type: 'team_asset',
        title: '新对话 · AI 最终答复',
        preview: '这是一段普通聊天答复',
        updated_at: '2026-07-02T04:00:00Z',
        metadata: {
          asset_kind: 'ai_final_answer',
          asset_source: { kind: 'ai_final_answer' },
        },
      },
      {
        id: 'doc-1',
        space_id: 'team-space-1',
        item_type: 'cloud_file',
        title: '产品说明文档',
        preview: '过程中沉淀出来的文档',
        updated_at: '2026-07-02T04:05:00Z',
        metadata: {
          asset_kind: 'cloud_file',
          asset_source: { kind: 'ai_deliverable' },
        },
      },
    ]

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))

    expect(screen.getByText('产品说明文档')).not.toBeNull()
    expect(screen.queryByText('新对话 · AI 最终答复')).toBeNull()
    expect(screen.queryByText('这是一段普通聊天答复')).toBeNull()
  })

  it('资产页文件卡片可以打开归一化后的文件资产', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    mocks.scopedResources = [
      {
        id: 'file-item-1',
        space_id: 'team-space-1',
        item_type: 'file',
        title: '过程文档.pdf',
        preview: '过程中沉淀出来的文件',
        updated_at: '2026-07-02T04:05:00Z',
        metadata: {
          asset_kind: 'cloud_file',
          asset_source: { kind: 'member_upload' },
        },
      },
    ]

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))
    fireEvent.click(screen.getByText('过程文档.pdf'))

    await waitFor(() => {
      expect(mocks.recordResourceAccess).toHaveBeenCalledWith('file-item-1')
      expect(mocks.getSpaceFileDownloadUrl).toHaveBeenCalledWith('team-space-1', 'file-item-1', {
        hostKind: 'project',
      })
      expect(openSpy).toHaveBeenCalledWith('https://files.example.test/doc.pdf', '_blank', 'noopener,noreferrer')
    })

    openSpy.mockRestore()
  })

  it('资产页展示Project 内的 TabDoc 交付物', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.scopedResources = [
      {
        id: 'doc-item-1',
        space_id: 'team-space-1',
        item_type: 'tabdoc',
        resource_id: 'doc-uuid-1',
        title: '甜风格设计方向整理',
        preview: '团队文档摘要',
        updated_at: '2026-07-04T04:05:00Z',
        metadata: {
          asset_kind: 'tabdoc',
          asset_source: { kind: 'ai_deliverable' },
        },
      },
    ]

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))

    expect(screen.getByText('甜风格设计方向整理')).not.toBeNull()
    expect(screen.getByText('团队文档摘要')).not.toBeNull()
  })

  it('资产页 TabDoc 卡片会留在 Project 内打开文档弹窗', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    const { useCloudDocumentPreviewStore } = await import('@/components/chat/preview/useCloudDocumentPreviewStore')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    useCloudDocumentPreviewStore.getState().close()
    mocks.openTeamSpaceTabdoc.mockClear()
    mocks.scopedResources = [
      {
        id: 'doc-item-1',
        space_id: 'team-space-1',
        item_type: 'tabdoc',
        resource_id: 'doc-uuid-1',
        title: '甜风格设计方向整理',
        preview: '团队文档摘要',
        updated_at: '2026-07-04T04:05:00Z',
        metadata: {
          asset_kind: 'tabdoc',
          asset_source: { kind: 'ai_deliverable' },
        },
      },
    ]

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))
    fireEvent.click(screen.getByText('甜风格设计方向整理'))

    await waitFor(() => {
      expect(mocks.recordResourceAccess).toHaveBeenCalledWith('doc-item-1')
      expect(useCloudDocumentPreviewStore.getState().target).toEqual({
        documentId: 'doc-uuid-1',
        resourceSpaceId: 'team-space-1',
        title: '甜风格设计方向整理',
        organizationId: 'organization-1',
      })
    })
    expect(mocks.openTeamSpaceTabdoc).not.toHaveBeenCalled()
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-1')
  })

  it('资产页 AI 交付摘要会留在 Project 并打开对应任务执行会话', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.scopedResources = [{
      id: 'summary-item-1',
      space_id: 'team-space-1',
      item_type: 'team_asset',
      resource_id: 'project_task_run:run-1',
      title: '发布说明 · 交付结果',
      preview: '已整理完成',
      updated_at: '2026-07-04T04:05:00Z',
      metadata: {
        asset_kind: 'task_deliverable',
        asset_source: {
          kind: 'ai_deliverable',
          task_id: 'task-1',
          task_run_id: 'run-1',
          chat_session_id: 'session-result-1',
        },
      },
    }]

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))
    fireEvent.click(screen.getByRole('button', { name: '查看执行会话' }))

    await waitFor(() => {
      expect(mocks.recordResourceAccess).toHaveBeenCalledWith('summary-item-1')
      expect(mocks.loadSessions).toHaveBeenCalledWith('team-space-1', 'organization-1')
      expect(mocks.selectSession).toHaveBeenCalledWith('team-space-1', 'session-result-1', {
        draftScopeKey: 'conversation:draft:team-space-1',
        organizationId: 'organization-1',
        projectId: 'team-space-1',
      })
    })
    expect(useProjectWorkspaceSelectionStore.getState().activeTaskSessionId).toBe('session-result-1')
    expect(useProjectWorkspaceSelectionStore.getState().selectedProjectId).toBe('team-space-1')
    expect(mocks.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
  })

  it('同一次 TaskRun 的结论和云端资产合并成一个可操作交付包', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    const { useContextInjectionStore } = await import('@/stores/useContextInjectionStore')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    useContextInjectionStore.setState({
      activeScopeId: 'conversation:next-session',
      contextRefsByScopeId: {},
    })
    mocks.scopedResources = [{
      id: 'doc-item-1',
      space_id: 'team-space-1',
      item_type: 'tabdoc',
      resource_id: 'doc-uuid-1',
      title: '周末团建策划手册',
      preview: '目标、行程草案、待补充',
      updated_at: '2026-07-20T11:37:00Z',
      metadata: {
        asset_kind: 'tabdoc',
        asset_source: {
          kind: 'task_deliverable',
          task_id: 'task-1',
          task_run_id: 'run-1',
        },
      },
    }, {
      id: 'summary-item-1',
      space_id: 'team-space-1',
      item_type: 'team_asset',
      resource_id: 'project_task_run:run-1',
      title: '撰写团建手册 · 交付结果',
      preview: '在线文档已完成：\n\n- **文档名称**：周末团建策划手册\n- 包含目标、行程和待补充事项',
      updated_at: '2026-07-20T11:37:00Z',
      metadata: {
        asset_kind: 'task_deliverable',
        asset_source: {
          kind: 'ai_deliverable',
          task_id: 'task-1',
          task_run_id: 'run-1',
        },
      },
    }]

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))

    expect(screen.getByText('任务交付')).not.toBeNull()
    expect(screen.getByText('结论')).not.toBeNull()
    expect(screen.getByText('文档名称').tagName).toBe('STRONG')
    expect(screen.getByText('包含目标、行程和待补充事项')).not.toBeNull()
    expect(screen.getByText('相关资产 · 1')).not.toBeNull()
    expect(screen.getAllByText('周末团建策划手册')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /打开资产：周末团建策划手册/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '查看执行会话' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加到当前对话' }))
    expect(
      useContextInjectionStore.getState().contextRefsByScopeId['conversation:next-session'],
    ).toEqual([
      expect.objectContaining({
        type: 'document',
        resourceId: 'doc-uuid-1',
        label: '周末团建策划手册',
        spaceId: 'team-space-1',
        tabType: 'tabdoc',
        meta: {
          preview: '周末团建策划手册\n交付结论：在线文档已完成：\n\n- **文档名称**：周末团建策划手册\n- 包含目标、行程和待补充事项',
        },
      }),
    ])
  })

  it('上传资产复用云盘文件能力并刷新团队资产列表', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    const file = new File(['hello'], '过程文档.txt', { type: 'text/plain' })

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '资产' }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(mocks.directUpload).toHaveBeenCalledWith(file, '过程文档.txt', expect.objectContaining({
        module: 'tabfiles',
        contextType: 'team_space_asset',
        contextId: 'team-space-1',
        organizationId: 'organization-1',
        isPublic: true,
      }))
      expect(mocks.uploadSpaceFile).toHaveBeenCalledWith('team-space-1', {
        file_record_id: 'file-record-1',
        title: '过程文档.txt',
      }, 'project')
    })
    expect(mocks.loadResources).toHaveBeenCalledWith('team-space-1', true, 'space')
  })

  it('成员页展示组织成员与可选用的非 human Agent，不再提供加入 Project', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '成员与执行' }))

    expect((await screen.findAllByText('Seda Owner')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Mira Editor').length).toBeGreaterThan(0)
    expect(screen.getByText('真实 Research Agent')).not.toBeNull()
    expect(screen.getByText('系统调度 Agent')).not.toBeNull()
    expect(screen.getByText('我的默认执行位置')).not.toBeNull()
    expect(screen.getByText('任务执行用的 Agent')).not.toBeNull()
    expect(screen.getByText('我的 Agent（任务中选用）')).not.toBeNull()
    expect(await screen.findByText('默认 Space')).not.toBeNull()
    expect(screen.queryByText('Seda Human Agent')).toBeNull()
    expect(screen.queryByRole('button', { name: '加入 Project' })).toBeNull()
    expect(screen.queryByText('已加入 Project 的我的 Agent')).toBeNull()
    expect(mocks.getMembers).toHaveBeenCalledWith('organization-1', { limit: 200 })
    expect(mocks.listOrganizationAgents).toHaveBeenCalledWith('organization-1', { pageSize: 200 })
    expect(mocks.addSpaceMembership).not.toHaveBeenCalled()
  })

  it('任务详情可同时选择工作空间与 Agent 并确认', async () => {
    const { ProjectMainContent, useProjectWorkspaceSelectionStore } = await import('./ProjectWorkspacePanel')
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId('team-space-1')
    mocks.listSpaceMemberships.mockResolvedValue({
      memberships: [
        { id: 'membership-user-1', space_id: 'team-space-1', user_id: 'user-1', role: 'owner', is_active: true },
      ],
      total: 1,
    })
    const acceptedTask = {
      id: 'task-configure-owned-agent',
      project_id: 'team-space-1',
      title: '确认执行现场任务',
      description: '',
      priority: 'medium',
      created_by: { id: 'user-1', name: 'Seda Owner' },
      responsible_user: { id: 'user-1', name: 'Seda Owner' },
      assignment_status: 'accepted',
      work_status: 'todo',
      selected_agent: null,
      project_workspace: null,
      workspace_confirmed: false,
      execution_ready: false,
      result_summary: '',
      result_visibility: 'private',
      latest_run: null,
      deliverables: [],
      version: 1,
      created_at: '2026-07-20T08:00:00Z',
      updated_at: '2026-07-20T08:00:00Z',
    }
    mocks.listTasks.mockResolvedValue({ tasks: [acceptedTask], total: 1 })
    mocks.getTask.mockResolvedValue(acceptedTask)
    mocks.configureTaskExecution.mockResolvedValue({
      ...acceptedTask,
      selected_agent: { id: 'bot-agent-1', name: '真实 Research Agent' },
      project_workspace: {
        id: 'workspace-1',
        name: '默认 Space',
        device_status: 'online',
        confirmed_at: '2026-07-20T08:05:00Z',
      },
      workspace_confirmed: true,
      execution_ready: true,
    })

    render(<ProjectMainContent />)
    fireEvent.click(screen.getByRole('tab', { name: '任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看任务详情：确认执行现场任务' }))

    const detailPage = await screen.findByTestId('project-task-detail-page')
    const workspaceSelect = within(detailPage).getByLabelText('选择执行工作空间') as HTMLSelectElement
    const agentSelect = within(detailPage).getByLabelText('选择执行 Agent') as HTMLSelectElement
    expect(workspaceSelect.value).toBe('space-1')
    expect(agentSelect.value).toBe('bot-agent-1')
    expect(within(detailPage).queryByText('暂无可用的 Agent')).toBeNull()
    fireEvent.click(within(detailPage).getByRole('button', { name: '确认工作空间与 Agent' }))

    await waitFor(() => {
      expect(mocks.configureTaskExecution).toHaveBeenCalledWith(
        'team-space-1',
        'task-configure-owned-agent',
        { agent_id: 'bot-agent-1', workspace_id: 'space-1' },
      )
    })
  })
})
