import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DRAG_TYPE_CHAT_SESSION } from '@/utils/split-coordinator'
import { warmSpacePathCache } from '@/utils/buildSessionReferenceClipboardText'
import { useSortedSessions } from '@/utils/chat-session-sort'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useDeviceStore } from '@/stores/useDeviceStore'
import { useAppPageStore } from '@/stores/useAppPageStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { resolveCurrentMemberProjectCompanionDeviceStatus } from '@components/context-space/executionDeviceStatus'
import { dedupeSessionsById } from './dedupeSessionsById'
import { useSessionCollapsedGroups } from './useSessionCollapsedGroups'
import { useSessionDraftState } from './useSessionDraftState'
import { useSessionSwitcherActions } from './useSessionSwitcherActions'
import {
  createSessionTabLabelGetter,
  useSessionGroupLabels,
  useSessionSpaceLabelGetter,
  useSessionSwitcherListModel,
} from './useSessionSwitcherListModel'
import type { SessionListScrollIntent } from './sessionListScroll'
import { SessionSwitcherOverlays } from './SessionSwitcherOverlays'
import { SessionNewConversationEntry } from './ChatSessionSwitcherList'
import type { ChatSessionSwitcherProps } from './ChatSessionSwitcher.types'

function buildSessionSwitcherLabels(input: {
  t: (key: string, opts?: Record<string, unknown>) => string
  draft: ReturnType<typeof useSessionDraftState>
  spaceNameById?: Record<string, string>
}) {
  const draftTitle = input.t('sessionList.untitled', { defaultValue: '新任务' })
  const alreadyOnNewTaskLabel = input.t('sessionList.alreadyOnNewTask', { defaultValue: '当前已是新任务' })
  const draftBadge = (
    (input.draft.effectiveDraftBadgeSpaceId ? input.spaceNameById?.[input.draft.effectiveDraftBadgeSpaceId] : undefined)
    ?? input.draft.draftSpaceName
  )?.trim() || input.t('sessionList.draftBadge', { defaultValue: '草稿' })
  const draftEntryTitle = `${draftTitle} · ${draftBadge}`
  const currentWorkspaceBadge = (
    (input.draft.highlightedSpaceId ? input.spaceNameById?.[input.draft.highlightedSpaceId] : undefined)
    ?? input.draft.highlightedSpaceName
  )?.trim() || null
  const createEntryTitle = currentWorkspaceBadge
    ? `${input.draft.isAlreadyOnNewTask ? alreadyOnNewTaskLabel : draftTitle} · ${currentWorkspaceBadge}`
    : (input.draft.isAlreadyOnNewTask ? alreadyOnNewTaskLabel : draftTitle)

  return {
    draftTitle,
    alreadyOnNewTaskLabel,
    draftBadge,
    draftEntryTitle,
    currentWorkspaceBadge,
    createEntryTitle,
  }
}

export function useChatSessionSwitcherOrchestration(props: ChatSessionSwitcherProps) {
  const {
    variant,
    sessions,
    draftLookupSessions,
    currentSessionId,
    showDraftSession = false,
    isLoading = false,
    onSelectSession,
    onCreateSession,
    onRenameSession,
    onDeleteSession,
    onForkSession,
    onUnforkSession,
    onTogglePin,
    pinnedSessionIds,
    scopeKey,
    draftBadgeSpaceId,
    workspaceHighlightSpaceId,
    trackerRunSessions: extraTrackerRunSessions,
    trackerRunCount,
    trackerRunsLoading,
    trackerRunsError,
    onExpandTrackerRuns,
    onRetryTrackerRuns,
    spaceNameById,
    spaceLastActivityById,
    spaceSectionTitle,
    spaceSectionKeyById,
    spaceSectionOrder,
    spaceSectionTitleByKey,
    createSpaceActionBySectionKey,
    showWorkspaceSortControlBySectionKey,
    createSpaceAction,
    showWorkspaceSortControl = false,
    onOpenSpaceSettings,
    onCreateSessionInSpace,
    resolveSpaceDeviceStatus: resolveSpaceDeviceStatusOverride,
    canCreateSessionInSpace,
    listContent = 'all',
    externalArchivesBySpaceId,
    onOpenExternalArchive,
    onDeleteExternalArchive,
    externalOpenedSessionIds,
    resolveExternalArchiveByOpenedSessionId,
  } = props

  const { t } = useTranslation('chat')
  const { t: tContext } = useTranslation('context')
  const organizationId = useResolvedOrganizationId()
  const workspaceListSortMode = useSpaceViewPrefsStore(s => s.workspaceListSortMode)
  const setWorkspaceListSortMode = useSpaceViewPrefsStore(s => s.setWorkspaceListSortMode)
  const sortedSessionsWithDuplicates = useSortedSessions(sessions)
  const sortedSessions = useMemo(
    () => dedupeSessionsById(sortedSessionsWithDuplicates),
    [sortedSessionsWithDuplicates],
  )
  const forkingSessionId = useChatStore(s => s.forkingSessionId)
  const suspendedSessionIds = useWsConnectionStore(s => s.suspendedSessionIds)
  const spaces = useSpaceStore(s => s.spaces)
  const currentDevice = useDeviceStore(s => s.currentDevice ?? null)
  const devices = useDeviceStore(s => s.devices)
  // 技能库/自动化/协作/通知中心等全屏页盖住时，底下草稿仍在；工作空间旁「新建」不能再按
  // 「当前已是新任务」禁用——点它应等同回到新任务。
  const isTaskHubAppPage = useAppPageStore((s) => (
    s.activePage === 'skill'
    || s.activePage === 'automation'
    || s.activePage === 'collaboration'
    || s.activePage === 'import'
    || s.activePage === 'external-archives'
    || s.activePage === 'notification'
  ))

  const draft = useSessionDraftState({
    showDraftSession,
    currentSessionId,
    scopeKey,
    draftBadgeSpaceId,
    highlightedSpaceIdOverride: workspaceHighlightSpaceId,
    spaceNameById,
    sessions,
    draftLookupSessions,
  })
  const draftSpaceAlreadyOnNewTask = draft.isSpaceAlreadyOnNewTask
  const isSpaceAlreadyOnNewTask = useCallback((targetSpaceId: string | null) => {
    if (isTaskHubAppPage) return false
    return draftSpaceAlreadyOnNewTask(targetSpaceId)
  }, [draftSpaceAlreadyOnNewTask, isTaskHubAppPage])
  const actions = useSessionSwitcherActions({
    sessions,
    scopeKey,
    onRenameSession,
    onDeleteSession,
    externalOpenedSessionIds,
    resolveExternalArchiveByOpenedSessionId,
    t,
  })
  const collapsed = useSessionCollapsedGroups(organizationId, onExpandTrackerRuns)
  const groupLabels = useSessionGroupLabels(t)
  const getSessionSpaceLabel = useSessionSpaceLabelGetter(spaceNameById, t)
  const labels = buildSessionSwitcherLabels({ t, draft, spaceNameById })

  useEffect(() => {
    if (!scopeKey || !organizationId) return
    warmSpacePathCache(scopeKey, organizationId)
  }, [scopeKey, organizationId])

  const resolveSpaceDeviceStatus = useCallback((targetSpaceId: string | null) => {
    if (resolveSpaceDeviceStatusOverride) {
      return resolveSpaceDeviceStatusOverride(targetSpaceId)
    }
    if (!targetSpaceId) return null
    const project = spaces.find(item => item.id === targetSpaceId) ?? null
    return resolveCurrentMemberProjectCompanionDeviceStatus(project, spaces, currentDevice, devices, tContext)
  }, [resolveSpaceDeviceStatusOverride, spaces, currentDevice, devices, tContext])

  const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
    e.dataTransfer.setData(DRAG_TYPE_CHAT_SESSION, sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const [scrollIntent, setScrollIntent] = useState<SessionListScrollIntent | null>(null)
  const scrollIntentSequenceRef = useRef(0)
  const handleListSelectSession = useCallback((sessionId: string) => {
    if (variant === 'list') {
      setScrollIntent({
        sessionId,
        sequence: ++scrollIntentSequenceRef.current,
      })
    }
    return onSelectSession(sessionId)
  }, [onSelectSession, variant])

  const listModel = useSessionSwitcherListModel({
    variant,
    sortedSessions,
    currentSessionId,
    scopeKey,
    pinnedSessionIds,
    groupLabels,
    collapsedGroups: collapsed.collapsedGroups,
    extraTrackerRunSessions,
    trackerRunCount,
    trackerRunsLoading,
    trackerRunsError,
    spaceNameById,
    spaceSectionKeyById,
    spaceSectionOrder,
    spaceLastActivityById,
    workspaceListSortMode,
    getSessionSpaceId: draft.getSessionSpaceId,
    getSessionSpaceLabel,
    listContent,
    externalArchivesBySpaceId,
    draftHighlightedSpaceId: draft.highlightedSpaceId,
    alreadyOnNewTaskLabel: labels.alreadyOnNewTaskLabel,
    spaceSectionTitle,
    spaceSectionTitleByKey,
    createSpaceActionBySectionKey,
    showWorkspaceSortControlBySectionKey,
    showWorkspaceSortControl,
    setWorkspaceListSortMode,
    createSpaceAction,
    resolveSpaceDeviceStatus,
    isSpaceAlreadyOnNewTask,
    toggleGroupCollapse: collapsed.toggleGroupCollapse,
    onCreateSessionInSpace,
    canCreateSessionInSpace,
    onOpenSpaceSettings,
    onSelectSession: handleListSelectSession,
    scrollIntent,
    onForkSession,
    onUnforkSession,
    onDeleteSession,
    onTogglePin,
    onDragStart: handleDragStart,
    onSetContextMenu: actions.setCtxMenu,
    onSetArchiveTarget: actions.handleArchiveRequest,
    pendingArchiveSessionId: actions.pendingArchiveSessionId,
    onRetryTrackerRuns,
    onOpenExternalArchive,
    onRequestDeleteExternalArchive: onDeleteExternalArchive
      ? actions.handleDeleteExternalArchiveRequest
      : undefined,
    externalOpenedSessionIds,
    forkingSessionId,
    t,
  })

  return {
    t,
    sortedSessions,
    isTrackerRunsOnly: listModel.isTrackerRunsOnly,
    flatListItems: listModel.flatListItems,
    draftTitle: labels.draftTitle,
    draftBadge: labels.draftBadge,
    draftEntryTitle: labels.draftEntryTitle,
    alreadyOnNewTaskLabel: labels.alreadyOnNewTaskLabel,
    getTabLabel: createSessionTabLabelGetter(t),
    listVirtualizer: listModel.listVirtualizer,
    newConversationEntry: (
      <SessionNewConversationEntry
        isDraftActive={draft.isDraftActive}
        draftTitle={labels.draftTitle}
        draftEntryTitle={labels.draftEntryTitle}
        draftBadge={labels.draftBadge}
        createEntryTitle={labels.createEntryTitle}
        isAlreadyOnNewTask={draft.isAlreadyOnNewTask}
        currentWorkspaceBadge={labels.currentWorkspaceBadge}
        onCreateSession={onCreateSession}
      />
    ),
    virtualRowProps: listModel.virtualRowProps,
    overlays: (
      <SessionSwitcherOverlays
        mode={variant}
        actions={actions}
        forkingSessionId={forkingSessionId}
        pinnedSessionIds={pinnedSessionIds}
        onDeleteSession={onDeleteSession}
        onDeleteExternalArchive={onDeleteExternalArchive}
        onForkSession={onForkSession}
        onRenameSession={onRenameSession}
        onTogglePin={onTogglePin}
        externalOpenedSessionIds={externalOpenedSessionIds}
        t={t}
      />
    ),
    forkingSessionId,
    suspendedSessionIds,
    isLoading,
    isDraftActive: draft.isDraftActive,
    isAlreadyOnNewTask: draft.isAlreadyOnNewTask,
    actions,
  }
}
