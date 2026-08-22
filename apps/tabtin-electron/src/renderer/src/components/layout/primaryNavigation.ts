/**
 * primaryNavigation — 一级导航共享中枢（ActivityRail + 第二列面板 IA）。
 *
 * 窄栏（ActivityRail）与第二列内容面板（SpaceSidebarGlobal）共享同一套
 * 导航派发 / 激活判定 / 未读徽标逻辑，全部收口在本文件：
 *   - 纯函数：resolveEffectiveMainNavTab / resolveActivePrimaryNavId 等（可单测）
 *   - usePrimaryNavigation：订阅各导航 store，产出派发函数与派生态
 *
 * 模块切换的 SSoT 是 useSpaceViewPrefsStore 的 sidebarMode（按 Organization+User
 * 记忆），不再维护组件本地 useState 副本——窄栏与面板两处消费方天然同步。
 */

import { useCallback, useMemo } from 'react'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import {
  useSpaceViewPrefsStore,
  type SidebarMode,
} from '@stores/useSpaceViewPrefsStore'
import { useMainNavStore, type MainNavTab } from '@stores/useMainNavStore'
import { useUIStore } from '@stores/useUIStore'
import { useIMStore } from '@stores/useIMStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useAppPageStore, type AppPageId } from '@stores/useAppPageStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import {
  countPendingProjectInvitations,
  usePendingProjectInvitationStore,
} from '@stores/usePendingProjectInvitationStore'
import { useProjectWorkspaceSelectionStore } from './projectWorkspaceSelectionStore'
import { calculateScopedIMUnread, formatIMUnreadBadge } from './sidebarBottomNavUnread'
import { exitTeamSpaceProjectView } from './project/teamSpaceProjectNavigation'
import { getProjectExecutionSpaceId } from '@/utils/projectExecutionTarget'
import { resolveDefaultExecutionWorkspaceId } from '@/utils/defaultExecutionSpace'
import { buildDesktopScopeKey } from './workspaceContextState'
import { resolveNewTaskWelcomeVisible } from '@components/chat/panel/chatContentState'
import { resetNewTaskDraftUi } from './resetNewTaskDraftUi'
import {
  invalidatePendingHubNavigation,
  openAutomationHub,
  openCollaborationHub,
  openExternalArchives,
  openImportHub,
  openSkillLibrary,
} from '@/services/agentMemoryNavigation'
import { PROJECTS_UI_ENABLED } from '@/utils/featureFlags'

export type PrimaryNavId =
  | 'new-task'
  /** 任务域切换（回到 agent 对话工作台，不重置当前会话为新草稿） */
  | 'tasks'
  | 'apps'
  | 'automation'
  | 'import-data'
  | 'external-history'
  | 'agents'
  | 'skills'
  | 'collaboration'
  | 'messages'
  | 'cloud-docs'

export function showAppsHome(scopeKey: string): void {
  useSpaceContextTabsStore.getState().setActiveKey(scopeKey, null)
  useWorkbenchSurfaceStore.getState().setLastActiveSurface(scopeKey, 'desktop')
}

type ProjectDesktopSpace = {
  id: string
  name?: string
  organization_id: string
  type?: string | null
  is_archived?: boolean | null
  execution_space_id?: string | null
  project_id?: string | null
}

export function resolveProjectDesktopExecutionSpaceId(input: {
  mode: SidebarMode
  isProjectNavActive: boolean
  selectedProjectId: string | null
  organizationId: string | null
  spaces: ProjectDesktopSpace[]
}): string | null {
  if (input.mode !== 'desktop' || !input.isProjectNavActive) return null
  if (!input.organizationId) return null

  const teamSpaces = input.spaces.filter(space => (
    space.type === 'team_space' &&
    !space.is_archived &&
    space.organization_id === input.organizationId
  ))
  const selectedTeamSpace =
    teamSpaces.find(space => space.id === input.selectedProjectId) ??
    teamSpaces[0] ??
    null

  return getProjectExecutionSpaceId(selectedTeamSpace, input.spaces)
}

export function resolveEffectiveMainNavTab(input: {
  mainNavTab: MainNavTab
  projectsEnabled: boolean
}): MainNavTab {
  const { mainNavTab, projectsEnabled } = input
  if (
    (mainNavTab === 'project' || mainNavTab === 'collaboration') &&
    !projectsEnabled
  ) {
    return 'agent'
  }
  return mainNavTab
}

export function resolveNewTaskMainNavTab(_isProjectNavActive: boolean): MainNavTab {
  return 'agent'
}

/**
 * app-shell 的 activateSpace 只认 workspace kind：传 team_space id 会失败并连坐
 * 清空该组织的 selection 记忆。此处过滤掉 team_space，让调用方走 exit 编排。
 */
function resolveActivatableWorkspaceId(spaceId: string | null): string | null {
  if (!spaceId) return null
  const space = useSpaceStore.getState().spaces.find(item => item.id === spaceId)
  return space?.type === 'team_space' ? null : spaceId
}

/** 恢复当前组织「上次打开的 IM 会话」（会话须仍存在于列表中）。 */
export function resolveLastOpenedConversationId(input: {
  organizationId: string | null
  lastOpenedConversationIdByOrganization: Record<string, string>
  conversations: Array<{ id: string; organization_id: string }>
}): string | null {
  if (!input.organizationId) return null
  const rememberedId = input.lastOpenedConversationIdByOrganization[input.organizationId]
  if (!rememberedId) return null
  return input.conversations.some((conversation) => (
    conversation.id === rememberedId && conversation.organization_id === input.organizationId
  ))
    ? rememberedId
    : null
}

/**
 * 进入消息域的落点计划。
 * 有可恢复会话 → activateConversation（同步 selectedSpaceKind=dm|im-group，
 * 避免 reconcileSelection 把 workspace 记忆当成失同步再拉回任务，）；
 * 否则 → empty-inbox（只钉消息 tab；不要 openIM，否则 isIMActive 与
 * workspace kind 失同步会被 reconcile 关掉）。
 */
export function resolveMessagesNavigationPlan(input: {
  organizationId: string | null
  currentConversationId: string | null
  lastOpenedConversationIdByOrganization: Record<string, string>
  conversations: Array<{ id: string; organization_id: string }>
}): { action: 'activate-conversation'; conversationId: string } | { action: 'empty-inbox' } {
  const conversationId =
    input.currentConversationId
    ?? resolveLastOpenedConversationId({
      organizationId: input.organizationId,
      lastOpenedConversationIdByOrganization: input.lastOpenedConversationIdByOrganization,
      conversations: input.conversations,
    })
  if (conversationId) {
    return { action: 'activate-conversation', conversationId }
  }
  return { action: 'empty-inbox' }
}

export type ImmersiveProjectSpace = {
  id: string
  name: string
  organization_id: string
  type?: string | null
  is_archived?: boolean | null
  execution_space_id?: string | null
  project_id?: string | null
}

/** Project 沉浸侧栏：解析当前选中的 team_space（无选中时回退组织内第一个）。 */
export function resolveSelectedProjectSpace(input: {
  isProjectNavActive: boolean
  selectedProjectId: string | null
  organizationId: string | null
  spaces: ImmersiveProjectSpace[]
}): ImmersiveProjectSpace | null {
  if (!input.isProjectNavActive || !input.organizationId) return null
  const teamSpaces = input.spaces.filter(space => (
    space.type === 'team_space' &&
    !space.is_archived &&
    space.organization_id === input.organizationId
  ))
  return (
    teamSpaces.find(space => space.id === input.selectedProjectId) ??
    teamSpaces[0] ??
    null
  )
}

export function resolvePersonalHomeConversationSpaceId(input: {
  executionSpaceId: string | null
  defaultPersonalWorkspaceId: string | null
}): string | null {
  return input.executionSpaceId ?? input.defaultPersonalWorkspaceId
}

export function resolveActivePrimaryNavId(input: {
  effectiveMainNavTab: MainNavTab
  isProjectNavActive: boolean
  effectiveActiveModuleTab: SidebarMode
  isNewTaskWelcomeActive: boolean
  activeAppPage?: AppPageId | null
}): PrimaryNavId | null {
  if (input.activeAppPage === 'skill') return 'skills'
  if (input.activeAppPage === 'automation') return 'automation'
  if (input.activeAppPage === 'import') return 'import-data'
  if (input.activeAppPage === 'external-archives') return 'external-history'
  if (input.activeAppPage === 'collaboration') return 'collaboration'
  if (input.effectiveMainNavTab === 'agents') return 'agents'
  if (
    (input.effectiveMainNavTab === 'agent' || input.isProjectNavActive) &&
    input.effectiveActiveModuleTab === 'conversations' &&
    input.isNewTaskWelcomeActive
  ) {
    return 'new-task'
  }
  // desktop 工作面归任务域（窄栏「任务」高亮），不在「更多」菜单单列工作台。
  if (input.effectiveMainNavTab === 'im') return 'messages'
  if (input.effectiveMainNavTab === 'cloud-docs') return 'cloud-docs'
  return null
}

export interface PrimaryNavigationState {
  effectiveMainNavTab: MainNavTab
  activeAppPage: AppPageId | null
  isProjectNavActive: boolean
  effectiveActiveModuleTab: SidebarMode
  activePrimaryNavId: PrimaryNavId | null
  /** 当前任务域动作落点：Project 沉浸 → 当前 Project；否则个人首页工作空间 */
  personalConversationSpaceId: string | null
  /** 个人任务侧栏的稳定工作空间，不含 Project 沉浸 alias */
  personalHomeConversationSpaceId: string | null
  projectConversationSpaceId: string | null
  selectedProjectSpace: ImmersiveProjectSpace | null
  messagesUnread: number
  messagesUnreadLabel: string
  collaborationPendingCount: number
  collaborationPendingLabel: string
  handlePrimaryNavigation: (target: PrimaryNavId) => void
  setSidebarMode: (mode: SidebarMode) => void
  handleExitProject: () => void
}

export function usePrimaryNavigation(input: {
  executionSpaceId: string | null
}): PrimaryNavigationState {
  const { executionSpaceId } = input
  const userId = useAuthStore(state => state.user?.id ?? null)
  const organizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const spaces = useSpaceStore(state => state.spaces)
  const lastUsedWorkspaceId = useSpaceViewPrefsStore(state =>
    state.getLastUsedWorkspaceId(organizationId),
  )
  const selectedProjectId = useProjectWorkspaceSelectionStore(state => state.selectedProjectId)
  const setSidebarModeForOrganizationUser = useSpaceViewPrefsStore(
    state => state.setSidebarModeForOrganizationUser,
  )
  const sidebarModeFromPrefs = useSpaceViewPrefsStore(state =>
    state.getSidebarMode(organizationId, userId),
  )
  const mainNavTab = useMainNavStore((s) => s.currentTab)
  const setCurrentTab = useMainNavStore((s) => s.setCurrentTab)
  const effectiveMainNavTab = resolveEffectiveMainNavTab({
    mainNavTab,
    projectsEnabled: PROJECTS_UI_ENABLED,
  })
  const activeAppPage = useAppPageStore(s => s.activePage)
  const isProjectNavActive = activeAppPage === 'project'
  const effectiveActiveModuleTab: SidebarMode =
    isProjectNavActive ? 'conversations' : (sidebarModeFromPrefs ?? 'desktop')

  const setSidebarMode = useCallback((
    mode: SidebarMode,
    options?: {
      /**
       * 调用方在 closeAppPage 之前快照的 Project 沉浸态。
       * 不传则实时读 store——但凡调用序里先关了 app page，必须传快照，
       * 否则「沉浸 → 桌面」的执行工作空间交接会被时序打断（#P1）。
       */
      projectImmersive?: boolean
      projectImmersiveProjectId?: string | null
    },
  ) => {
    const projectImmersive =
      options?.projectImmersive
      ?? (useAppPageStore.getState().activePage === 'project')
    const immersiveProjectId =
      options?.projectImmersiveProjectId !== undefined
        ? options.projectImmersiveProjectId
        : useProjectWorkspaceSelectionStore.getState().selectedProjectId
    const projectDesktopExecutionSpaceId = resolveProjectDesktopExecutionSpaceId({
      mode,
      isProjectNavActive: projectImmersive,
      selectedProjectId: immersiveProjectId,
      organizationId,
      spaces: useSpaceStore.getState().spaces,
    })
    if (projectDesktopExecutionSpaceId) {
      exitTeamSpaceProjectView(projectDesktopExecutionSpaceId)
    }

    // 应用门与 AI分身工作台互斥：切到应用时收起分身配置主画布。
    if (mode === 'desktop') {
      useAppPageStore.getState().closeAppPage()
    }

    if (organizationId && userId) {
      setSidebarModeForOrganizationUser(organizationId, userId, mode)
    }
  }, [organizationId, setSidebarModeForOrganizationUser, userId])

  const selectedProjectSpace = useMemo(
    () => resolveSelectedProjectSpace({
      isProjectNavActive,
      selectedProjectId,
      organizationId,
      spaces,
    }),
    [isProjectNavActive, selectedProjectId, organizationId, spaces],
  )
  const projectConversationSpaceId = selectedProjectSpace?.id ?? null
  const defaultPersonalWorkspaceId = useMemo(
    () => resolveDefaultExecutionWorkspaceId(
      organizationId,
      spaces,
      lastUsedWorkspaceId,
    ),
    [lastUsedWorkspaceId, organizationId, spaces],
  )
  const personalHomeConversationSpaceId = resolvePersonalHomeConversationSpaceId({
    executionSpaceId,
    defaultPersonalWorkspaceId,
  })
  const personalConversationSpaceId =
    projectConversationSpaceId ?? personalHomeConversationSpaceId

  const handleExitProject = useCallback(() => {
    if (!selectedProjectSpace) {
      exitTeamSpaceProjectView(defaultPersonalWorkspaceId)
      return
    }
    exitTeamSpaceProjectView(
      getProjectExecutionSpaceId(selectedProjectSpace, spaces) ?? defaultPersonalWorkspaceId,
    )
  }, [defaultPersonalWorkspaceId, selectedProjectSpace, spaces])

  const isDraftActive = useChatStore(state => (
    personalConversationSpaceId
      ? Boolean(state.draftSessionBySpaceId[personalConversationSpaceId])
      : false
  ))
  const newTaskSessionId = useChatStore(state => (
    personalConversationSpaceId
      ? state.currentSessionIdBySpaceId[personalConversationSpaceId] ?? null
      : null
  ))
  const newTaskSessionMessageCount = useChatStore(state => {
    if (!personalConversationSpaceId || !newTaskSessionId) return null
    return state.sessionsBySpaceId[personalConversationSpaceId]
      ?.find(session => session.id === newTaskSessionId)
      ?.message_count ?? null
  })
  const newTaskLocalMessageCount = useChatStore(state => (
    newTaskSessionId
      ? state.messagesBySessionId[newTaskSessionId]?.length ?? 0
      : 0
  ))
  const chatSessionsLoading = useChatStore(state => state.isLoading)
  const isNewTaskWelcomeActive = resolveNewTaskWelcomeVisible({
    currentSessionId: newTaskSessionId,
    currentSessionMessageCount: newTaskSessionMessageCount,
    localMessageCount: newTaskLocalMessageCount,
    isDraftSession: isDraftActive,
    isLoading: chatSessionsLoading,
  })

  const imConversations = useIMStore((s) => s.conversations)
  const imUnreadCounts = useIMStore((s) => s.unreadCounts)
  const imTotalUnread = useIMStore((s) => s.totalUnread)
  const imCurrentConversationId = useIMStore((s) => s.currentConversationId)
  const messagesUnread = useMemo(() => calculateScopedIMUnread({
    conversations: imConversations,
    unreadCounts: imUnreadCounts,
    totalUnread: imTotalUnread,
    currentConversationId: imCurrentConversationId,
    organizationId,
  }), [
    imConversations,
    imCurrentConversationId,
    imTotalUnread,
    imUnreadCounts,
    organizationId,
  ])
  const messagesUnreadLabel = formatIMUnreadBadge(messagesUnread)
  const pendingProjectInvitations = usePendingProjectInvitationStore((s) => s.invitations)
  const collaborationPendingCount = useMemo(
    () => (
      PROJECTS_UI_ENABLED
        ? countPendingProjectInvitations(pendingProjectInvitations, organizationId)
        : 0
    ),
    [organizationId, pendingProjectInvitations],
  )
  const collaborationPendingLabel = formatIMUnreadBadge(collaborationPendingCount)

  const handlePrimaryNavigation = useCallback((target: PrimaryNavId) => {
    if (target === 'collaboration' && !PROJECTS_UI_ENABLED) return
    // 在任何 closeAppPage 之前快照沉浸态：离开 Project 必须统一走 exit 编排，
    // 否则执行工作空间交接会被「先关页、后读态」的时序吞掉（#P1）。
    const wasProjectImmersive = useAppPageStore.getState().activePage === 'project'
    const immersiveProjectId = useProjectWorkspaceSelectionStore.getState().selectedProjectId
    useSettingsSpaceStore.getState().closeSettings()

    // 三大域是「面板即内容」：点域图标时若第二列折叠则自动展开（例如点消息
    // 应弹出会话列表），否则消息域会停在指向空侧栏的「从左侧选择会话」死态。
    if (target === 'tasks' || target === 'messages' || target === 'agents' || target === 'collaboration' || target === 'cloud-docs') {
      const uiStore = useUIStore.getState()
      if (uiStore.sidebarCollapsed) uiStore.toggleSidebar()
    }

    if (target !== 'messages') {
      const spaceListStore = useSpaceListStore.getState()
      const isLeavingConversation =
        spaceListStore.selectedSpaceKind === 'dm' ||
        spaceListStore.selectedSpaceKind === 'im-group'
      // team_space 不能 activateSpace（app-shell 只认 workspace kind，失败还会连坐
      // 清空组织 selection 记忆）；Project 现场统一走下方 exit 编排落回执行工作空间。
      const activatableSpaceId =
        (target === 'new-task' || target === 'tasks' || target === 'apps') && !wasProjectImmersive
          ? resolveActivatableWorkspaceId(personalConversationSpaceId)
          : null
      if (activatableSpaceId) {
        spaceListStore.activateSpace(activatableSpaceId)
      } else if (isLeavingConversation) {
        spaceListStore.clearActiveContext()
      } else {
        const imStore = useIMStore.getState()
        imStore.closeIM()
        imStore.setCurrentConversation(null)
      }
    }

    if (target === 'agents') {
      invalidatePendingHubNavigation()
      useAppPageStore.getState().closeAppPage()
      setCurrentTab('agents')
      return
    }
    if (target === 'skills') {
      openSkillLibrary()
      return
    }
    if (target === 'automation') {
      openAutomationHub()
      return
    }
    if (target === 'import-data') {
      openImportHub()
      return
    }
    if (target === 'external-history') {
      openExternalArchives()
      return
    }
    if (target === 'collaboration') {
      openCollaborationHub()
      return
    }

    // 「apps」不在此关页：交接解析（沉浸 → 桌面）由 setSidebarMode 按快照自理。
    // 离开技能库/自动化等全屏 hub 时先作废异步 open，再 closeAppPage。
    if (target === 'new-task' || target === 'tasks' || target === 'messages' || target === 'cloud-docs') {
      invalidatePendingHubNavigation()
      useAppPageStore.getState().closeAppPage()
    }

    if (target === 'new-task') {
      if (!personalConversationSpaceId) return
      resetNewTaskDraftUi(personalConversationSpaceId)
      setCurrentTab(resolveNewTaskMainNavTab(wasProjectImmersive))
      setSidebarMode('conversations')
      // execution 与 host 一并交给 startDraft，避免 reconcile 用旧指针拉回正式对话
      useChatStore.getState().startDraftSessionForSpace(personalConversationSpaceId, true, {
        ...(executionSpaceId ? { executionWorkspaceId: executionSpaceId } : {}),
      })
      return
    }
    if (target === 'tasks') {
      if (wasProjectImmersive) {
        // 从 Project 沉浸回任务域：走正规退出编排（落回项目执行工作空间 /
        // 默认个人工作空间，并清空 selectedProjectId），不能停在 team_space 上。
        handleExitProject()
      } else {
        setCurrentTab('agent')
      }
      setSidebarMode('conversations')
      return
    }
    if (target === 'apps') {
      showAppsHome(buildDesktopScopeKey({ organizationId, userId }))
      setCurrentTab('agent')
      setSidebarMode('desktop', {
        projectImmersive: wasProjectImmersive,
        projectImmersiveProjectId: immersiveProjectId,
      })
      return
    }
    if (target === 'messages') {
      // 有会话必须 activateConversation（同步 kind=dm|im-group）；空态只钉 tab，
      // 禁止「setCurrentConversation / openIM + 残留 workspace kind」——reconcile 会回拉。
      const imStore = useIMStore.getState()
      const plan = resolveMessagesNavigationPlan({
        organizationId,
        currentConversationId: imStore.currentConversationId,
        lastOpenedConversationIdByOrganization: imStore.lastOpenedConversationIdByOrganization,
        conversations: imStore.conversations,
      })
      if (plan.action === 'activate-conversation') {
        const activated = useSpaceListStore.getState().activateConversation(plan.conversationId)
        if (activated) {
          setCurrentTab('im')
          return
        }
      }
      // 空收件箱 / activate 失败：清会话与 isIMActive 残留，保留 workspace selection
      //（clearActiveContext 双 null 会触发 lifecycle 自动选回 workspace）。
      if (imStore.currentConversationId) imStore.setCurrentConversation(null)
      if (imStore.isIMActive) imStore.closeIM()
      setCurrentTab('im')
      return
    }
    if (target === 'cloud-docs') {
      if (wasProjectImmersive) {
        handleExitProject()
      } else {
        const activatableSpaceId = resolveActivatableWorkspaceId(personalConversationSpaceId)
        if (activatableSpaceId) {
          useSpaceListStore.getState().activateSpace(activatableSpaceId)
        }
      }
      setCurrentTab('cloud-docs')
      return
    }
    setCurrentTab(target)
  }, [
    executionSpaceId,
    handleExitProject,
    organizationId,
    personalConversationSpaceId,
    setCurrentTab,
    setSidebarMode,
    userId,
  ])

  const activePrimaryNavId = resolveActivePrimaryNavId({
    effectiveMainNavTab,
    isProjectNavActive,
    effectiveActiveModuleTab,
    isNewTaskWelcomeActive,
    activeAppPage,
  })

  return {
    effectiveMainNavTab,
    activeAppPage,
    isProjectNavActive,
    effectiveActiveModuleTab,
    activePrimaryNavId,
    personalConversationSpaceId,
    personalHomeConversationSpaceId,
    projectConversationSpaceId,
    selectedProjectSpace,
    messagesUnread,
    messagesUnreadLabel,
    collaborationPendingCount,
    collaborationPendingLabel,
    handlePrimaryNavigation,
    setSidebarMode,
    handleExitProject,
  }
}
