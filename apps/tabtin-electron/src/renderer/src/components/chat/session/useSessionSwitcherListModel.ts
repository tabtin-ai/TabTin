import { useCallback, useMemo } from 'react'
import type { ChatSession } from '@tabtin/chat-client'
import type { GroupKey } from '@/utils/chat-session-sort'
import {
  buildSessionListVirtualItems,
  type ExternalArchiveListItem,
  type SessionListVirtualItem,
} from './buildSessionListVirtualItems'
import { useSessionListVirtualizer } from './useSessionListVirtualizer'
import { useSessionLinkedWorktreeIndicators } from './useSessionLinkedWorktreeIndicators'
import type { SessionSpaceTreeHeaderProps } from './SessionSpaceTreeHeader'
import type { SessionListVirtualRowProps } from './SessionListVirtualRow'
import type { SessionListScrollIntent } from './sessionListScroll'

export interface UseSessionSwitcherListModelInput {
  variant: 'tabs' | 'list'
  sortedSessions: ChatSession[]
  currentSessionId: string | null
  scopeKey?: string | null
  pinnedSessionIds?: Set<string>
  groupLabels: Record<GroupKey, string>
  collapsedGroups: ReturnType<typeof import('./useSessionCollapsedGroups').useSessionCollapsedGroups>['collapsedGroups']
  extraTrackerRunSessions?: ChatSession[]
  trackerRunCount?: number | null
  trackerRunsLoading?: boolean
  trackerRunsError?: string | null
  spaceNameById?: Record<string, string>
  spaceSectionKeyById?: Record<string, string>
  spaceSectionOrder?: string[]
  spaceLastActivityById?: Record<string, string | null | undefined>
  workspaceListSortMode: 'name' | 'activity'
  getSessionSpaceId: (session: ChatSession) => string
  getSessionSpaceLabel: (targetSpaceId: string) => string
  listContent: 'all' | 'sessions' | 'trackerRuns'
  externalArchivesBySpaceId?: Record<string, ExternalArchiveListItem[]>
  draftHighlightedSpaceId: string | null
  alreadyOnNewTaskLabel: string
  spaceSectionTitle?: string
  spaceSectionTitleByKey?: Record<string, string>
  createSpaceActionBySectionKey?: Record<string, React.ReactNode>
  showWorkspaceSortControlBySectionKey?: Record<string, boolean>
  showWorkspaceSortControl: boolean
  setWorkspaceListSortMode: (mode: 'name' | 'activity') => void
  createSpaceAction?: React.ReactNode
  resolveSpaceDeviceStatus: SessionSpaceTreeHeaderProps['resolveSpaceDeviceStatus']
  isSpaceAlreadyOnNewTask: SessionSpaceTreeHeaderProps['isSpaceAlreadyOnNewTask']
  toggleGroupCollapse: SessionSpaceTreeHeaderProps['onToggleCollapse']
  onCreateSessionInSpace?: SessionSpaceTreeHeaderProps['onCreateSessionInSpace']
  canCreateSessionInSpace?: SessionSpaceTreeHeaderProps['canCreateSessionInSpace']
  onOpenSpaceSettings?: SessionSpaceTreeHeaderProps['onOpenSpaceSettings']
  onSelectSession: (sessionId: string) => void | Promise<void>
  scrollIntent?: SessionListScrollIntent | null
  onForkSession?: (sessionId: string) => void | Promise<void>
  onUnforkSession?: (sessionId: string) => void | Promise<void>
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  onTogglePin?: (sessionId: string) => void
  onDragStart: (e: React.DragEvent, sessionId: string) => void
  onSetContextMenu: SessionListVirtualRowProps['onSetContextMenu']
  onSetArchiveTarget: (sessionId: string) => void
  pendingArchiveSessionId?: string | null
  onRetryTrackerRuns?: () => void
  onOpenExternalArchive?: (archive: {
    source: string
    sourceSessionId: string
  }) => void
  onRequestDeleteExternalArchive?: (archive: {
    source: string
    sourceSessionId: string
    title: string
    openedSessionId?: string | null
  }) => void
  externalOpenedSessionIds?: ReadonlySet<string>
  forkingSessionId: string | null
  t: (key: string, opts?: Record<string, unknown>) => string
}

export function useSessionSwitcherListModel(input: UseSessionSwitcherListModelInput) {
  const {
    sortedSessions,
    pinnedSessionIds,
    groupLabels,
    collapsedGroups,
    extraTrackerRunSessions,
    trackerRunCount,
    trackerRunsLoading,
    trackerRunsError,
    spaceNameById,
    spaceSectionKeyById,
    spaceSectionOrder,
    spaceLastActivityById,
    workspaceListSortMode,
    getSessionSpaceId,
    getSessionSpaceLabel,
    listContent,
    externalArchivesBySpaceId,
  } = input

  // 依赖具体字段，而不是整个 input 对象——orchestration 每轮渲染都会 new 一个
  // input，若 deps=[input] 会让 flatListItems 每帧换引用，放大虚拟列表副作用。
  const flatListItems = useMemo<SessionListVirtualItem[]>(() => buildSessionListVirtualItems({
    sortedSessions,
    pinnedSessionIds,
    groupLabels,
    collapsedGroups,
    extraTrackerRunSessions,
    trackerRunCount,
    trackerRunsLoading,
    trackerRunsError,
    spaceNameById,
    spaceSectionKeyById,
    spaceSectionOrder,
    spaceLastActivityById,
    workspaceListSortMode,
    getSessionSpaceId,
    getSessionSpaceLabel,
    listContent,
    externalArchivesBySpaceId,
  }), [
    sortedSessions,
    pinnedSessionIds,
    groupLabels,
    collapsedGroups,
    extraTrackerRunSessions,
    trackerRunCount,
    trackerRunsLoading,
    trackerRunsError,
    spaceNameById,
    spaceSectionKeyById,
    spaceSectionOrder,
    spaceLastActivityById,
    workspaceListSortMode,
    getSessionSpaceId,
    getSessionSpaceLabel,
    listContent,
    externalArchivesBySpaceId,
  ])

  const listVirtualizer = useSessionListVirtualizer({
    flatListItems,
    scopeKey: input.scopeKey,
    variant: input.variant,
    currentSessionId: input.currentSessionId,
    scrollIntent: input.scrollIntent,
    spaceNameById: input.spaceNameById,
  })

  const sessionRowActionOpacity = 'transition-opacity opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100'
  const isTrackerRunsOnly = input.variant === 'list' && input.listContent === 'trackerRuns'
  const linkedWorktreeBySessionId = useSessionLinkedWorktreeIndicators(input.sortedSessions)

  // ：memo 稳定引用，避免可见行 React.memo 因每轮新 props 对象失效
  const virtualRowProps = useMemo<Omit<SessionListVirtualRowProps, 'item'>>(() => ({
    currentSessionId: input.currentSessionId,
    forkingSessionId: input.forkingSessionId,
    pinnedSessionIds: input.pinnedSessionIds,
    sessionRowActionOpacity,
    linkedWorktreeBySessionId,
    scopeKey: input.scopeKey,
    highlightedSpaceId: input.draftHighlightedSpaceId,
    alreadyOnNewTaskLabel: input.alreadyOnNewTaskLabel,
    spaceSectionTitle: input.spaceSectionTitle,
    spaceSectionTitleByKey: input.spaceSectionTitleByKey,
    createSpaceActionBySectionKey: input.createSpaceActionBySectionKey,
    showWorkspaceSortControlBySectionKey: input.showWorkspaceSortControlBySectionKey,
    showWorkspaceSortControl: input.showWorkspaceSortControl,
    workspaceListSortMode: input.workspaceListSortMode,
    setWorkspaceListSortMode: input.setWorkspaceListSortMode,
    createSpaceAction: input.createSpaceAction,
    resolveSpaceDeviceStatus: input.resolveSpaceDeviceStatus,
    isSpaceAlreadyOnNewTask: input.isSpaceAlreadyOnNewTask,
    onCreateSessionInSpace: input.onCreateSessionInSpace,
    canCreateSessionInSpace: input.canCreateSessionInSpace,
    onOpenSpaceSettings: input.onOpenSpaceSettings,
    onSelectSession: input.onSelectSession,
    onForkSession: input.onForkSession,
    onUnforkSession: input.onUnforkSession,
    onDeleteSession: input.onDeleteSession,
    onTogglePin: input.onTogglePin,
    onDragStart: input.onDragStart,
    onSetContextMenu: input.onSetContextMenu,
    onSetArchiveTarget: input.onSetArchiveTarget,
    pendingArchiveSessionId: input.pendingArchiveSessionId,
    onToggleGroupCollapse: input.toggleGroupCollapse,
    onRetryTrackerRuns: input.onRetryTrackerRuns,
    onOpenExternalArchive: input.onOpenExternalArchive,
    onRequestDeleteExternalArchive: input.onRequestDeleteExternalArchive,
    externalOpenedSessionIds: input.externalOpenedSessionIds,
    t: input.t,
  }), [
    input.currentSessionId,
    input.forkingSessionId,
    input.pinnedSessionIds,
    sessionRowActionOpacity,
    linkedWorktreeBySessionId,
    input.scopeKey,
    input.draftHighlightedSpaceId,
    input.alreadyOnNewTaskLabel,
    input.spaceSectionTitle,
    input.spaceSectionTitleByKey,
    input.createSpaceActionBySectionKey,
    input.showWorkspaceSortControlBySectionKey,
    input.showWorkspaceSortControl,
    input.workspaceListSortMode,
    input.setWorkspaceListSortMode,
    input.createSpaceAction,
    input.resolveSpaceDeviceStatus,
    input.isSpaceAlreadyOnNewTask,
    input.onCreateSessionInSpace,
    input.canCreateSessionInSpace,
    input.onOpenSpaceSettings,
    input.onSelectSession,
    input.onForkSession,
    input.onUnforkSession,
    input.onDeleteSession,
    input.onTogglePin,
    input.onDragStart,
    input.onSetContextMenu,
    input.onSetArchiveTarget,
    input.pendingArchiveSessionId,
    input.toggleGroupCollapse,
    input.onRetryTrackerRuns,
    input.onOpenExternalArchive,
    input.onRequestDeleteExternalArchive,
    input.externalOpenedSessionIds,
    input.t,
  ])

  return {
    flatListItems,
    listVirtualizer,
    isTrackerRunsOnly,
    virtualRowProps,
    sessionRowActionOpacity,
  }
}

export function createSessionTabLabelGetter(
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  return (session: ChatSession) => {
    const title = session.title || t('panel.newChat', { defaultValue: '新任务' })
    return title.length > 14 ? `${title.slice(0, 14)}…` : title
  }
}

export function useSessionGroupLabels(t: (key: string, opts?: Record<string, unknown>) => string) {
  return useMemo<Record<GroupKey, string>>(() => ({
    pinned: t('sessionList.groupPinned', { defaultValue: '置顶' }),
    trackerRuns: t('sessionList.groupTrackerRuns', { defaultValue: '自动化任务执行记录' }),
    today: t('sessionList.groupToday', { defaultValue: '今天' }),
    yesterday: t('sessionList.groupYesterday', { defaultValue: '昨天' }),
    recent7d: t('sessionList.groupRecent', { defaultValue: '最近 7 天' }),
    recent30d: t('sessionList.groupRecent30d', { defaultValue: '最近 30 天' }),
    older: t('sessionList.groupOlder', { defaultValue: '更早' }),
  }), [t])
}

export function useSessionSpaceLabelGetter(
  spaceNameById: Record<string, string> | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  return useCallback((targetSpaceId: string) => {
    if (targetSpaceId === '__unknown__') {
      return t('sessionList.groupUnknownSpace', { defaultValue: '未关联 Space' })
    }
    return spaceNameById?.[targetSpaceId]
      ?? t('sessionList.groupSpaceFallback', {
        defaultValue: '工作空间 {{id}}',
        id: targetSpaceId.slice(0, 6),
      })
  }, [spaceNameById, t])
}
