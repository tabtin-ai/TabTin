import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatSessionSwitcher } from '@components/chat/session/ChatSessionSwitcher'
// Wave 5 (charter v1.8 §6.9): Chat sidebar 内自动化区(双入口之 Chat 入口)
import { ChatSidebarTrackersSection } from '@components/chat/session/ChatSidebarTrackersSection'
import {
  ChatSidebarSharedTasksSection,
  type SharedTaskSelection,
} from '@components/chat/session/ChatSidebarSharedTasksSection'
import { NewSpaceButton } from '@components/sidebar/NewSpaceButton'
import { useChatStore } from '@stores/chat/useChatStore'
import { useChatSplitStore } from '@stores/useChatSplitStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useIMStore } from '@stores/useIMStore'
import { useUIStore } from '@stores/useUIStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { openSpaceSettingsIntent } from '@components/space-settings/spaceSettingsNavigation'
import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { compareSpacesByStableOrder, resolveSessionScopeId } from '@tabtin/app-shell'
import type { ChatSession } from '@tabtin/chat-client'
import { useWorkbenchSceneStore } from '@/stores/useWorkbenchSceneStore'
import {
  isProjectCompanionWorkspace,
  resolveProjectExecutionWorkspace,
  resolveUserVisibleWorkspace,
} from '@/utils/projectExecutionTarget'
import { filterSidebarSessions } from '@components/chat/session/filterSidebarSessions'
import { isHiddenAgentMentionSession } from '@/stores/chat/session/isHiddenAgentMentionSession'
import { getLocallySubmittedSessionIds } from '@/stores/chat/session/locallySubmittedSessionRegistry'
import { createLogger } from '@/utils/logger'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useProjectTaskRealtime } from '@/hooks/useProjectTaskRealtime'
import { useProjectTaskStore } from '@/stores/useProjectTaskStore'
import { openProjectTaskChatSession } from '@/services/openProjectTaskChatSession'
import type { ProjectTask } from '@/types/project'
import {
  PROJECT_CONVERSATION_SECTION_KEY,
  buildProjectTaskConversationGroups,
  hasProjectTaskGroups,
  mergeConversationSessionStubs,
  pruneEmptyProjectConversationGroups,
  remapSessionsToTaskGroups,
  resolveProjectConversationGroupDeviceStatus,
} from './projectTaskConversationGroups'
import { resetNewTaskDraftUi } from '@components/layout/resetNewTaskDraftUi'
import { invalidatePendingHubNavigation } from '@/services/agentMemoryNavigation'
import { buildStableConversationDraftScopeKey } from '@/stores/chat/session/draftMessageLegacyAdapter'
import { alignChatPointerToWorkspace } from '@/stores/chat/session/reconcileSpacePointer'
import {
  beginOpenChatSessionIntent,
  clearOpenChatSessionIntent,
} from '@/stores/chat/session/openChatSessionIntent'
import { useOrganizationExternalArchives } from '@components/onboarding/external-import/useOrganizationExternalArchives'
import { openExternalArchiveAsConversation } from '@components/onboarding/external-import/openExternalArchiveAsConversation'
import { deleteExternalArchive } from '@components/onboarding/external-import/deleteExternalArchive'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { toast } from '@components/ui'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'
import { enterChatSession } from '@/services/chatSessionNavigation'

const EMPTY_SESSIONS: ChatSession[] = []
const EMPTY_TASKS: ProjectTask[] = []
const log = createLogger('SidebarConversationList')

interface SidebarConversationListProps {
  spaceId: string
  tabScopeKey: string
  /**
   * 产品宿主上的稳定新草稿 scope A。缺省时由 spaceId（Project / 工作空间）构造。
   * 不得用 execution 工作空间 B 或当前 `conversation:S` 推导。
   */
  draftScopeKey?: string | null
  onOpenConversationWorkspace?: () => void
}

export const SidebarConversationList: React.FC<SidebarConversationListProps> = React.memo(({
  spaceId,
  tabScopeKey,
  draftScopeKey: draftScopeKeyProp,
  onOpenConversationWorkspace,
}) => {
  const spaces = useSpaceStore(s => s.spaces)
  const closeAppPage = useAppPageStore(s => s.closeAppPage)
  const activeSpace = useMemo(
    () => spaces.find(space => space.id === spaceId) ?? null,
    [spaces, spaceId],
  )
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const isTeamConversationSpace = activeSpace?.type === 'team_space'
  const personalConversationSpace = useMemo(() => {
    if (!activeSpace) return null
    if (activeSpace.type !== 'team_space') {
      return resolveUserVisibleWorkspace(activeSpace, spaces)
    }
    return resolveProjectExecutionWorkspace(activeSpace, spaces)
  }, [activeSpace, spaces])
  const conversationSpace = isTeamConversationSpace ? activeSpace : personalConversationSpace
  const conversationSpaceId = conversationSpace?.id ?? spaceId
  /** Project / 工作空间产品宿主上的稳定 draft A（与 tabScopeKey=conversation:S 解耦） */
  const stableDraftScopeKey = useMemo(
    () => draftScopeKeyProp ?? buildStableConversationDraftScopeKey(conversationSpaceId),
    [conversationSpaceId, draftScopeKeyProp],
  )
  const trackedProjectId = isTeamConversationSpace ? conversationSpaceId : null
  useProjectTaskRealtime(trackedProjectId)
  const projectTasks = useProjectTaskStore((state) => (
    trackedProjectId
      ? (state.byProjectId[trackedProjectId]?.tasks ?? EMPTY_TASKS)
      : EMPTY_TASKS
  ))
  const refreshProjectTasks = useCallback(() => {
    if (!trackedProjectId) return
    void useProjectTaskStore.getState().fetchTasks(trackedProjectId, { quiet: true })
  }, [trackedProjectId])

  const { t: tContext } = useTranslation('context')
  const { t: tChat } = useTranslation('chat')
  const currentDevice = useDeviceStore(s => s.currentDevice ?? null)
  const devices = useDeviceStore(s => s.devices)
  const resolveProjectGroupDeviceStatus = useCallback((targetSpaceId: string | null) => (
    resolveProjectConversationGroupDeviceStatus({
      groupId: targetSpaceId,
      tasks: projectTasks,
      spaces,
      currentDevice,
      devices,
      t: tContext,
    })
  ), [currentDevice, devices, projectTasks, spaces, tContext])

  // Project 沉浸态：只保留当前 team_space，隐去全局 WORKSPACE 段。
  // 未进 Project / 未点「协作」时：侧栏不列 PROJECT——入口只在主导航「协作」。
  const organizationSpaces = useMemo(() => {
    if (isTeamConversationSpace) {
      return activeSpace ? [activeSpace] : []
    }
    const organizationId = activeSpace?.organization_id ?? personalConversationSpace?.organization_id
    if (!organizationId) return personalConversationSpace ? [personalConversationSpace] : []
    return spaces
      .filter(space => (
        space.organization_id === organizationId &&
        !space.is_archived &&
        (space.type === 'workspace' || !space.type) &&
        !isProjectCompanionWorkspace(space)
      ))
      .slice()
      .sort(compareSpacesByStableOrder)
  }, [activeSpace, isTeamConversationSpace, personalConversationSpace, spaces])
  const organizationSpaceIds = useMemo(
    () => organizationSpaces.map(space => space.id),
    [organizationSpaces],
  )
  const sessionsBySpaceId = useChatStore(s => s.sessionsBySpaceId)
  const excludedAgentMentionSessionIdsBySpaceId = useChatStore(
    s => s.excludedAgentMentionSessionIdsBySpaceId,
  )
  const rawSpaceSessions = useMemo(() => {
    const visibleWorkspaceIds = new Set(organizationSpaceIds)
    const seen = new Set<string>()
    const result: ChatSession[] = []
    for (const targetSpaceId of organizationSpaceIds) {
      const excludedSessionIds = new Set(
        excludedAgentMentionSessionIdsBySpaceId[targetSpaceId] ?? [],
      )
      for (const session of sessionsBySpaceId[targetSpaceId] ?? EMPTY_SESSIONS) {
        if (
          isHiddenAgentMentionSession(session, excludedSessionIds)
          || seen.has(session.id)
        ) continue
        const sessionScopeId = resolveSessionScopeId(session)
        if (!isTeamConversationSpace && sessionScopeId && !visibleWorkspaceIds.has(sessionScopeId)) continue
        seen.add(session.id)
        result.push(sessionScopeId ? session : { ...session, space_id: targetSpaceId })
      }
    }
    return result
  }, [
    excludedAgentMentionSessionIdsBySpaceId,
    isTeamConversationSpace,
    sessionsBySpaceId,
    organizationSpaceIds,
  ])

  // 会话 id 集合变化时刷新任务 conversations（开跑 / 重跑后侧栏否则仍用旧映射）。
  const projectSessionFingerprint = useMemo(() => {
    if (!isTeamConversationSpace) return ''
    return rawSpaceSessions.map(session => session.id).sort().join('|')
  }, [isTeamConversationSpace, rawSpaceSessions])

  useEffect(() => {
    if (!isTeamConversationSpace || !projectSessionFingerprint) return
    refreshProjectTasks()
  }, [isTeamConversationSpace, projectSessionFingerprint, refreshProjectTasks])

  // 有任务才进「任务 ▸ 会话」分组；零任务时不套「项目对话」，列表保持未分组。
  const taskConversationGroups = useMemo(() => {
    if (!isTeamConversationSpace) return null
    const groups = pruneEmptyProjectConversationGroups({
      groups: buildProjectTaskConversationGroups(projectTasks, rawSpaceSessions),
      sessions: rawSpaceSessions,
    })
    return hasProjectTaskGroups(groups) ? groups : null
  }, [isTeamConversationSpace, projectTasks, rawSpaceSessions])

  const spaceSectionKeyById = useMemo(() => {
    if (taskConversationGroups) return taskConversationGroups.spaceSectionKeyById
    // Project 零任务：不传 Space 分组，避免项目名再包一层文件夹。
    if (isTeamConversationSpace) return undefined
    const result: Record<string, string> = {}
    for (const space of organizationSpaces) {
      result[space.id] = 'workspace'
    }
    return result
  }, [isTeamConversationSpace, organizationSpaces, taskConversationGroups])
  const spaceNameById = useMemo(() => {
    if (taskConversationGroups) return taskConversationGroups.spaceNameById
    if (isTeamConversationSpace) return undefined
    const result: Record<string, string> = {}
    for (const space of organizationSpaces) {
      result[space.id] = space.name
    }
    return result
  }, [isTeamConversationSpace, organizationSpaces, taskConversationGroups])
  const spaceLastActivityById = useMemo(() => {
    if (taskConversationGroups) return taskConversationGroups.spaceLastActivityById
    if (isTeamConversationSpace) return undefined
    const result: Record<string, string | null | undefined> = {}
    for (const space of organizationSpaces) {
      result[space.id] = space.last_activity_at
    }
    return result
  }, [isTeamConversationSpace, organizationSpaces, taskConversationGroups])
  // 导航 / 选中用真实 space_id；列表展示另做任务分组 remap。
  const allSessions = useMemo(() => {
    if (!taskConversationGroups || !activeSpace) return rawSpaceSessions
    return mergeConversationSessionStubs({
      sessions: rawSpaceSessions,
      sessionTitleBySessionId: taskConversationGroups.sessionTitleBySessionId,
      projectSpaceId: conversationSpaceId,
      organizationId: activeSpace.organization_id,
    })
  }, [activeSpace, conversationSpaceId, rawSpaceSessions, taskConversationGroups])
  const listSessionsSource = useMemo(() => {
    if (!taskConversationGroups) return allSessions
    return remapSessionsToTaskGroups({
      sessions: allSessions,
      sessionGroupIdBySessionId: taskConversationGroups.sessionGroupIdBySessionId,
      sessionTitleBySessionId: taskConversationGroups.sessionTitleBySessionId,
      spaceNameById: taskConversationGroups.spaceNameById,
    })
  }, [allSessions, taskConversationGroups])
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const loadSessions = useChatStore(s => s.loadSessions)
  const sessionLoadRequestsRef = useRef<Map<string, Promise<void>>>(new Map())
  // ：始终走 loadSessions SWR（缓存立即可用 + 后台 revalidate）。
  // 旧逻辑把「桶存在（含空数组）」当成已加载并永久短路，冷启动空桶后历史会话永远不回填。
  const ensureSpaceSessionsLoaded = useCallback((targetSpaceId: string, organizationId?: string) => {
    const pendingRequest = sessionLoadRequestsRef.current.get(targetSpaceId)
    if (pendingRequest) return pendingRequest

    const request = loadSessions(targetSpaceId, organizationId, {
      excludeAgentMentionSessions: true,
    })
      .then(() => {
        if (useChatStore.getState().sessionsBySpaceId[targetSpaceId] === undefined) {
          throw new Error(`Space sessions unavailable after load: ${targetSpaceId}`)
        }
      })
      .finally(() => {
        if (sessionLoadRequestsRef.current.get(targetSpaceId) === request) {
          sessionLoadRequestsRef.current.delete(targetSpaceId)
        }
      })
    sessionLoadRequestsRef.current.set(targetSpaceId, request)
    return request
  }, [loadSessions])

  // ：Space list merge 常换数组引用；旧逻辑会对组织内全部 Workspace 反复
  // loadSessions，放大 draft prefetch quick-start。每个 spaceId 只主动拉取一次，
  // 新增 Workspace 才补拉；失败从集合移除以便后续重试。选中 Space 的 SWR 仍由 ChatPanel 负责。
  const loadedSpaceIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!isAuthenticated) {
      loadedSpaceIdsRef.current = new Set()
      return
    }
    const knownSpaceIds = new Set(organizationSpaceIds)
    for (const requestedSpaceId of sessionLoadRequestsRef.current.keys()) {
      if (!knownSpaceIds.has(requestedSpaceId)) {
        sessionLoadRequestsRef.current.delete(requestedSpaceId)
      }
    }
    for (const loadedId of [...loadedSpaceIdsRef.current]) {
      if (!knownSpaceIds.has(loadedId)) {
        loadedSpaceIdsRef.current.delete(loadedId)
      }
    }
    for (const space of organizationSpaces) {
      if (loadedSpaceIdsRef.current.has(space.id)) continue
      loadedSpaceIdsRef.current.add(space.id)
      void ensureSpaceSessionsLoaded(space.id, space.organization_id).catch((error: unknown) => {
        loadedSpaceIdsRef.current.delete(space.id)
        log.warn('加载 Space 会话列表失败', { spaceId: space.id, error })
      })
    }
  }, [ensureSpaceSessionsLoaded, isAuthenticated, organizationSpaces, organizationSpaceIds])

  const currentSessionId = useChatStore(useCallback((s) => (
    isTeamConversationSpace
      ? (s.currentSessionIdBySpaceId[conversationSpaceId] ?? null)
      : s.currentSessionId
  ), [conversationSpaceId, isTeamConversationSpace]))
  const sharedSessionAccess = useSessionAccessStore(s => (
    currentSessionId ? s.bySessionId[currentSessionId] ?? null : null
  ))
  const archiveSpaces = useMemo(
    () => organizationSpaces.map((space) => ({
      id: space.id,
      working_dir: space.working_dir ?? null,
    })),
    [organizationSpaces],
  )
  const { archives, archivesBySpaceId, boundSessionIds } = useOrganizationExternalArchives(archiveSpaces)
  const externalArchiveByOpenedSessionId = useMemo(() => {
    const map = new Map<string, {
      source: string
      sourceSessionId: string
      title: string
      openedSessionId?: string | null
    }>()
    for (const entry of archives) {
      const openedId = entry.openedSessionId?.trim()
      if (!openedId) continue
      map.set(openedId, {
        source: entry.source,
        sourceSessionId: entry.sourceSessionId,
        title: entry.title?.trim() || entry.sourceSessionId,
        openedSessionId: openedId,
      })
    }
    return map
  }, [archives])
  const resolveExternalArchiveByOpenedSessionId = useCallback((sessionId: string) => (
    externalArchiveByOpenedSessionId.get(sessionId) ?? null
  ), [externalArchiveByOpenedSessionId])
  // ：不订阅 messagesBySessionId——流式 chunk 会换顶层引用拖垮整侧栏。
  // 保活只读 session 元数据 + 发送登记表 + 外部档案集合。
  // 登记表是模块级 Set、不触发 React；用 listSessionsSource 作同帧重读信号
  //（send / loadSessions 会换 sessions 引用）。
  const keepAliveSessionIds = useMemo(() => {
    const result = new Set<string>(getLocallySubmittedSessionIds())
    for (const id of boundSessionIds) result.add(id)
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listSessionsSource 仅作登记表重读信号
  }, [boundSessionIds, listSessionsSource])
  // 空会话（预建未发消息）不进侧栏；已下发指令但执行失败的任务仍需可追溯。
  const sessions = useMemo(
    () => filterSidebarSessions(listSessionsSource, currentSessionId, keepAliveSessionIds),
    [listSessionsSource, currentSessionId, keepAliveSessionIds],
  )
  const draftExecutionSpaceId = useChatStore(
    useCallback((s) => s.draftExecutionSpaceIdByWorkspaceKey[tabScopeKey] ?? conversationSpaceId, [conversationSpaceId, tabScopeKey]),
  )
  const isDraftSession = useChatStore(
    useCallback((s) => {
      if (isTeamConversationSpace) {
        return Boolean(s.draftSessionBySpaceId[conversationSpaceId])
      }
      const workspaceDraftSpaceId = s.draftExecutionSpaceIdByWorkspaceKey[tabScopeKey] ?? null
      return Boolean(
        s.draftSessionBySpaceId[conversationSpaceId] ||
        (workspaceDraftSpaceId && s.draftSessionBySpaceId[workspaceDraftSpaceId]) ||
        workspaceDraftSpaceId,
      )
    }, [conversationSpaceId, isTeamConversationSpace, tabScopeKey]),
  )
  const selectSpaceBySpaceId = useSpaceListStore(s => s.selectSpaceBySpaceId)
  const activateSpace = useSpaceListStore(s => s.activateSpace)
  const activateForegroundSpace = useWorkbenchSceneStore(s => s.activateForegroundSpace)
  const setCurrentTab = useMainNavStore(s => s.setCurrentTab)
  const closeSettings = useSettingsSpaceStore(s => s.closeSettings)
  const closeIM = useIMStore(s => s.closeIM)
  const setCurrentConversation = useIMStore(s => s.setCurrentConversation)
  const setChatSidePanelCollapsed = useUIStore(s => s.setChatSidePanelCollapsed)
  const setDraftExecutionSpaceForWorkspace = useChatStore(s => s.setDraftExecutionSpaceForWorkspace)
  const setLastUsedWorkspaceId = useSpaceViewPrefsStore(s => s.setLastUsedWorkspaceId)
  const renameSession = useChatStore(s => s.renameSession)
  const deleteSession = useChatStore(s => s.deleteSession)
  const deleteSessionPermanently = useChatStore(s => s.deleteSessionPermanently)
  const forkSession = useChatStore(s => s.forkSession)
  const unforkSession = useChatStore(s => s.unforkSession)
  const startDraftSessionForSpace = useChatStore(s => s.startDraftSessionForSpace)

  useEffect(() => {
    if (
      isTeamConversationSpace
      || !activeSpace
      || !isProjectCompanionWorkspace(activeSpace)
      || !personalConversationSpace
      || personalConversationSpace.id === activeSpace.id
    ) return
    if (!selectSpaceBySpaceId(personalConversationSpace.id)) return
    activateForegroundSpace(personalConversationSpace.id)
    setDraftExecutionSpaceForWorkspace(tabScopeKey, personalConversationSpace.id)
  }, [
    activeSpace,
    activateForegroundSpace,
    isTeamConversationSpace,
    personalConversationSpace,
    selectSpaceBySpaceId,
    setDraftExecutionSpaceForWorkspace,
    tabScopeKey,
  ])

  const returnToConversation = useCallback((
    targetSpaceId: string,
    options?: { alignPointer?: boolean },
  ) => {
    const targetSpace = spaces.find(space => space.id === targetSpaceId) ?? null
    const isTeamTarget = targetSpace?.type === 'team_space'
    const shouldAlignPointer = options?.alignPointer !== false
    // 从技能库/自动化等 hub 回到任务时，先作废异步 open，避免晚到 then() 盖回
    invalidatePendingHubNavigation()
    closeAppPage()
    closeSettings()
    if (isTeamTarget) {
      enterTeamSpaceProject(targetSpaceId)
      setChatSidePanelCollapsed(false)
      activateForegroundSpace(targetSpaceId)
      return true
    }
    setCurrentTab('agent')
    closeIM()
    setCurrentConversation(null)
    if (targetSpaceId === conversationSpaceId) {
      activateSpace(targetSpaceId)
      activateForegroundSpace(targetSpaceId)
      // 同步中间 composer「执行于」徽章（草稿态读 draft map，不跟 selectedSpace）
      setDraftExecutionSpaceForWorkspace(tabScopeKey, targetSpaceId)
      // ：只切 Workspace、没有指定会话时才对齐指针。点开某条会话时
      // 对齐器会在空桶 / 失效指针下先开草稿，抢走前台。
      if (shouldAlignPointer) {
        alignChatPointerToWorkspace(targetSpaceId)
      }
      if (targetSpace?.organization_id) {
        setLastUsedWorkspaceId(targetSpace.organization_id, targetSpaceId)
      }
      return true
    }
    if (!selectSpaceBySpaceId(targetSpaceId)) return false
    activateForegroundSpace(targetSpaceId)
    setDraftExecutionSpaceForWorkspace(tabScopeKey, targetSpaceId)
    if (shouldAlignPointer) {
      alignChatPointerToWorkspace(targetSpaceId)
    }
    if (targetSpace?.organization_id) {
      setLastUsedWorkspaceId(targetSpace.organization_id, targetSpaceId)
    }
    return true
  }, [
    activateForegroundSpace,
    activateSpace,
    closeAppPage,
    closeSettings,
    closeIM,
    conversationSpaceId,
    selectSpaceBySpaceId,
    setChatSidePanelCollapsed,
    setCurrentConversation,
    setCurrentTab,
    setDraftExecutionSpaceForWorkspace,
    setLastUsedWorkspaceId,
    spaces,
    tabScopeKey,
  ])

  // 齿轮入口打开完整「Space 管理」tab（AgentProfilePane，含工作目录·设备 / 子 Agent /
  // 授权策略 / 记忆等全部配置），而非精简的编辑 dialog。tab 在 spaceId scope 打开，
  // 与通知深链 / SpaceCard 同一条 openResourceTab 路径。
  const handleOpenSpaceSettings = useCallback((targetSpaceId: string) => {
    closeAppPage()
    const targetSpace = organizationSpaces.find(space => space.id === targetSpaceId)
    if (targetSpace?.type === 'team_space') return
    if (targetSpaceId !== conversationSpaceId) {
      selectSpaceBySpaceId(targetSpaceId)
    }
    // 必须把当前工作台 scope（tabScopeKey）透传，否则 tab 落到不可见的 spaceId scope（点了没反应）。
    openSpaceSettingsIntent(targetSpaceId, { tabScopeKey })
  }, [closeAppPage, selectSpaceBySpaceId, conversationSpaceId, organizationSpaces, tabScopeKey])

  const handleCreateSessionInSpace = useCallback((targetSpaceId: string) => {
    const targetSpace = organizationSpaces.find(space => space.id === targetSpaceId)
    if (targetSpace?.type === 'team_space') return
    const didNavigate = returnToConversation(targetSpaceId)
    if (!didNavigate) return
    onOpenConversationWorkspace?.()
    setCurrentTab('agent')
    resetNewTaskDraftUi(targetSpaceId)
    // 新任务 begin 稳定 A；targetSpaceId 可能是执行现场，不得另开 B episode
    startDraftSessionForSpace(targetSpaceId, true, {
      draftScopeKey: stableDraftScopeKey,
      executionWorkspaceId: targetSpaceId,
    })
  }, [
    onOpenConversationWorkspace,
    organizationSpaces,
    returnToConversation,
    setCurrentTab,
    stableDraftScopeKey,
    startDraftSessionForSpace,
  ])

  const canCreateSessionInSpace = useCallback((targetSpaceId: string) => (
    organizationSpaces.some(space => space.id === targetSpaceId && space.type !== 'team_space')
  ), [organizationSpaces])

  const resolveSessionSpaceId = useCallback((sessionId: string) => {
    // 沉浸态列表可能把 space_id 改写成任务分组键；导航始终落回真实 Project space。
    if (isTeamConversationSpace) return conversationSpaceId
    const session = allSessions.find(s => s.id === sessionId)
    return resolveSessionScopeId(session) ?? conversationSpaceId
  }, [allSessions, conversationSpaceId, isTeamConversationSpace])

  const handleSelectSessionInSpace = useCallback(async (
    targetSpaceId: string,
    sessionId: string,
  ) => {
    const token = beginOpenChatSessionIntent(targetSpaceId, sessionId)
    try {
      // 指定会话只打开那条，不准先走「回到 Workspace」对齐器。
      const didNavigate = returnToConversation(targetSpaceId, { alignPointer: false })
      if (!didNavigate) return
      onOpenConversationWorkspace?.()
      const targetSpace = spaces.find(space => space.id === targetSpaceId) ?? null
      if (targetSpace?.type === 'team_space' && targetSpace.organization_id) {
        // ：任务「执行」可能仅有 stub；pin + 强制 sync，避免 reconcile 打回草稿。
        await openProjectTaskChatSession({
          projectId: targetSpaceId,
          organizationId: targetSpace.organization_id,
          sessionId,
          session: useChatStore.getState().getSessionById(sessionId)
            ?? allSessions.find(item => item.id === sessionId)
            ?? null,
          loadSessions: false,
        })
        return
      }
      setCurrentTab('agent')
      await enterChatSession(targetSpaceId, sessionId, {
        draftScopeKey: stableDraftScopeKey ?? undefined,
        organizationId: organizationId ?? undefined,
      })
    } finally {
      clearOpenChatSessionIntent(token)
    }
  }, [
    allSessions,
    onOpenConversationWorkspace,
    organizationId,
    returnToConversation,
    setCurrentTab,
    spaces,
    stableDraftScopeKey,
  ])

  const handleSelectSharedSession = useCallback(async ({ share }: SharedTaskSelection) => {
    onOpenConversationWorkspace?.()
    setCurrentTab('agent')
    await enterChatSession(conversationSpaceId, share.session_id, {
      draftScopeKey: stableDraftScopeKey ?? undefined,
      organizationId: organizationId ?? undefined,
      verifySessionExists: true,
      sharedAccess: {
        shareId: share.id,
        organizationId,
        workspaceId: share.workspace_id ?? null,
        workspaceName: share.workspace_name || undefined,
        ownerUserId: share.owner_user_id,
        ownerDisplayName: share.owner_display_name || undefined,
        role: 'grantee',
      },
    })
  }, [
    conversationSpaceId,
    onOpenConversationWorkspace,
    organizationId,
    setCurrentTab,
    stableDraftScopeKey,
  ])

  const handleSelectSession = useCallback((sessionId: string) => (
    handleSelectSessionInSpace(resolveSessionSpaceId(sessionId), sessionId)
  ), [handleSelectSessionInSpace, resolveSessionSpaceId])

  const handleSelectTrackerRun = useCallback(async (
    targetSpaceId: string,
    sessionId: string,
  ) => {
    onOpenConversationWorkspace?.()
    await enterChatSession(targetSpaceId, sessionId, {
      organizationId: organizationId ?? undefined,
      draftScopeKey: stableDraftScopeKey ?? undefined,
      initialScroll: 'first-message',
    })
  }, [onOpenConversationWorkspace, organizationId, stableDraftScopeKey])

  const handleDeleteArchivedTrackerRuns = useCallback(async (
    targetSpaceId: string,
    sessionIds: string[],
  ) => {
    await Promise.all(
      sessionIds.map(sessionId => deleteSessionPermanently(targetSpaceId, sessionId)),
    )
  }, [deleteSessionPermanently])

  const handleRenameSession = useCallback(async (sessionId: string, title: string) => {
    await renameSession(resolveSessionSpaceId(sessionId), sessionId, title)
  }, [resolveSessionSpaceId, renameSession])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const targetSpaceId = resolveSessionSpaceId(sessionId)
    await deleteSession(targetSpaceId, sessionId)
    const pinned = useChatSplitStore.getState().pinnedSessionsBySpace[targetSpaceId]
    if (pinned?.includes(sessionId)) {
      useChatSplitStore.getState().togglePinSession(targetSpaceId, sessionId)
    }
  }, [resolveSessionSpaceId, deleteSession])

  const handleForkSession = useCallback(async (sessionId: string) => {
    const targetSpaceId = resolveSessionSpaceId(sessionId)
    returnToConversation(targetSpaceId)
    await forkSession(targetSpaceId, sessionId)
  }, [resolveSessionSpaceId, returnToConversation, forkSession])

  const handleUnforkSession = useCallback(async (sessionId: string) => {
    const targetSpaceId = resolveSessionSpaceId(sessionId)
    await unforkSession(targetSpaceId, sessionId)
  }, [resolveSessionSpaceId, unforkSession])

  const pinnedSessionsBySpace = useChatSplitStore(s => s.pinnedSessionsBySpace)
  const pinnedSessionIdsSet = useMemo(() => {
    const result = new Set<string>()
    for (const targetSpaceId of organizationSpaceIds) {
      for (const sessionId of pinnedSessionsBySpace[targetSpaceId] ?? []) {
        result.add(sessionId)
      }
    }
    return result
  }, [pinnedSessionsBySpace, organizationSpaceIds])

  const togglePinSession = useChatSplitStore(s => s.togglePinSession)
  const handleTogglePin = useCallback((sessionId: string) => {
    togglePinSession(resolveSessionSpaceId(sessionId), sessionId)
  }, [resolveSessionSpaceId, togglePinSession])

  const handleOpenExternalArchive = useCallback((archive: {
    source: string
    sourceSessionId: string
  }) => {
    const orgId = organizationId
      ?? organizationSpaces[0]?.organization_id
      ?? null
    if (!orgId) return
    void openExternalArchiveAsConversation({
      organizationId: orgId,
      source: archive.source,
      sourceSessionId: archive.sourceSessionId,
    })
  }, [organizationId, organizationSpaces])

  const handleDeleteExternalArchive = useCallback(async (archive: {
    source: string
    sourceSessionId: string
    title: string
    openedSessionId?: string | null
  }) => {
    const orgId = organizationId
      ?? organizationSpaces[0]?.organization_id
      ?? null
    if (!orgId) {
      toast.error(tChat('sessionList.deleteExternalArchiveFailed', { defaultValue: '删除外部档案失败' }))
      return
    }
    try {
      const { deleted } = await deleteExternalArchive({
        organizationId: orgId,
        source: archive.source,
        sourceSessionId: archive.sourceSessionId,
        openedSessionId: archive.openedSessionId,
      })
      if (deleted <= 0) {
        toast.error(tChat('sessionList.deleteExternalArchiveFailed', { defaultValue: '删除外部档案失败' }))
        return
      }
      // 已展开的会话壳一并清掉，避免只删本机档案后侧栏残留空对话
      const openedId = archive.openedSessionId?.trim()
      if (openedId) {
        try {
          await handleDeleteSession(openedId)
        } catch (sessionErr) {
          log.warn('外部档案已删，但清理展开会话失败', {
            sessionId: openedId,
            source: archive.source,
            sourceSessionId: archive.sourceSessionId,
          }, sessionErr)
        }
      }
      toast.success(tChat('sessionList.deleteExternalArchiveSuccess', { defaultValue: '已删除外部档案' }))
    } catch (err) {
      log.error('删除外部档案失败', {
        source: archive.source,
        sourceSessionId: archive.sourceSessionId,
      }, err)
      toast.error(
        err instanceof Error
          ? err.message
          : tChat('sessionList.deleteExternalArchiveFailed', { defaultValue: '删除外部档案失败' }),
      )
    }
  }, [handleDeleteSession, organizationId, organizationSpaces, tChat])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ChatSessionSwitcher
          variant="list"
          sessions={sessions}
          draftLookupSessions={allSessions}
          currentSessionId={sharedSessionAccess ? null : currentSessionId}
          showDraftSession={sharedSessionAccess ? false : (isTeamConversationSpace ? false : isDraftSession)}
          workspaceHighlightSpaceId={sharedSessionAccess ? null : undefined}
          onSelectSession={handleSelectSession}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          onForkSession={handleForkSession}
          onUnforkSession={handleUnforkSession}
          onTogglePin={handleTogglePin}
          pinnedSessionIds={pinnedSessionIdsSet}
          scopeKey={conversationSpaceId}
          draftBadgeSpaceId={draftExecutionSpaceId}
          spaceNameById={spaceNameById}
          spaceLastActivityById={spaceLastActivityById}
          spaceSectionKeyById={spaceSectionKeyById}
          spaceSectionOrder={
            taskConversationGroups
              ? [PROJECT_CONVERSATION_SECTION_KEY]
              : isTeamConversationSpace
                ? undefined
                : ['workspace']
          }
          spaceSectionTitleByKey={
            taskConversationGroups
              ? { [PROJECT_CONVERSATION_SECTION_KEY]: '任务' }
              : isTeamConversationSpace
                ? undefined
                : { workspace: '工作空间' }
          }
          showWorkspaceSortControl={!isTeamConversationSpace}
          showWorkspaceSortControlBySectionKey={
            taskConversationGroups
              ? { [PROJECT_CONVERSATION_SECTION_KEY]: false }
              : isTeamConversationSpace
                ? undefined
                : { workspace: true }
          }
          createSpaceActionBySectionKey={
            isTeamConversationSpace
              ? undefined
              : { workspace: <NewSpaceButton variant="icon" className="h-5 w-5" /> }
          }
          onOpenSpaceSettings={isTeamConversationSpace ? undefined : handleOpenSpaceSettings}
          resolveSpaceDeviceStatus={
            taskConversationGroups ? resolveProjectGroupDeviceStatus : undefined
          }
          onCreateSessionInSpace={isTeamConversationSpace ? undefined : handleCreateSessionInSpace}
          canCreateSessionInSpace={canCreateSessionInSpace}
          externalArchivesBySpaceId={isTeamConversationSpace ? undefined : archivesBySpaceId}
          onOpenExternalArchive={isTeamConversationSpace ? undefined : handleOpenExternalArchive}
          onDeleteExternalArchive={isTeamConversationSpace ? undefined : handleDeleteExternalArchive}
          externalOpenedSessionIds={isTeamConversationSpace ? undefined : boundSessionIds}
          resolveExternalArchiveByOpenedSessionId={
            isTeamConversationSpace ? undefined : resolveExternalArchiveByOpenedSessionId
          }
          listContent="sessions"
          listFooter={isTeamConversationSpace ? undefined : (
            <>
              {/* 「协作任务」与 WORKSPACE / 自动化平级，范围跟随当前选定组织。 */}
              {organizationId ? (
                <ChatSidebarSharedTasksSection
                  organizationId={organizationId}
                  onSelectSharedSession={handleSelectSharedSession}
                />
              ) : null}
              {/* 「自动化」与 WORKSPACE 平级，随会话列表一起滚动（非侧栏底部固定块）。 */}
              <ChatSidebarTrackersSection
                spaceId={conversationSpaceId}
                tabScopeKey={tabScopeKey}
                onSelectRun={handleSelectTrackerRun}
                onDeleteArchivedRuns={handleDeleteArchivedTrackerRuns}
              />
            </>
          )}
        />
      </div>
    </div>
  )
})
SidebarConversationList.displayName = 'SidebarConversationList'
