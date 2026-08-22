import type { ChatSession } from '@tabtin/chat-client'
import {
  groupSessionsByTime,
  isTrackerRunSession,
  getSessionActivityTs,
  sortSessionsByActivity,
  type GroupKey,
} from '@/utils/chat-session-sort'
import {
  compareWorkspaceListOrder,
  type WorkspaceListSortMode,
} from '@/utils/workspace-list-sort'
import type {
  CollapsibleGroupKey,
  ExternalArchiveListItem,
  PushSessionFn,
  SessionListVirtualItem,
} from './sessionListVirtualItemTypes'
import { shouldShowTrackerSection } from './shouldShowTrackerSection'
import {
  countForkTreeSessions,
  filterForkListRoots,
  type ForkChildrenIndex,
} from './nestForkSessions'

const dedupeSessionsById = (sessions: ChatSession[]): ChatSession[] => {
  const seen = new Set<string>()
  const result: ChatSession[] = []
  for (const session of sessions) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    result.push(session)
  }
  return result
}

export function appendPinnedSection(params: {
  items: SessionListVirtualItem[]
  pushSession: PushSessionFn
  forkIndex: ForkChildrenIndex
  sortedSessions: ChatSession[]
  pinnedSessionIds?: Set<string>
  groupLabels: Record<GroupKey, string>
  collapsedGroups: Set<CollapsibleGroupKey>
  listContent: 'all' | 'sessions' | 'trackerRuns'
}): void {
  if (params.listContent === 'trackerRuns') return
  const pinnedIds = params.pinnedSessionIds ?? new Set<string>()
  if (pinnedIds.size === 0) return
  // 子会话跟父走：父置顶则子随父出现；仅子置顶且父未置顶时仍挂在父下，不单独进置顶区
  const pinnedSessions = filterForkListRoots(
    params.sortedSessions.filter(s => pinnedIds.has(s.id)),
    params.forkIndex.nestedChildIds,
  )
  if (pinnedSessions.length === 0) return
  const collapsed = params.collapsedGroups.has('pinned')
  params.items.push({
    type: 'header',
    key: 'pinned',
    label: params.groupLabels.pinned,
    count: countForkTreeSessions(pinnedSessions, params.forkIndex.childrenByParentId),
    collapsed,
  })
  if (!collapsed) {
    for (const session of pinnedSessions) {
      params.pushSession(session)
    }
  }
}

export function appendTrackerSection(params: {
  items: SessionListVirtualItem[]
  pushSession: PushSessionFn
  forkIndex: ForkChildrenIndex
  sortedSessions: ChatSession[]
  extraTrackerRunSessions?: ChatSession[]
  trackerRunCount?: number | null
  trackerRunsLoading?: boolean
  trackerRunsError?: string | null
  groupLabels: Record<GroupKey, string>
  collapsedGroups: Set<CollapsibleGroupKey>
  listContent: 'all' | 'sessions' | 'trackerRuns'
}): void {
  if (params.listContent === 'sessions') return
  const unpinnedSessions = params.sortedSessions
  const inSessionsTrackerRuns = unpinnedSessions.filter(isTrackerRunSession)
  const extraTrackerArr = params.extraTrackerRunSessions ? dedupeSessionsById(params.extraTrackerRunSessions) : []
  const trackerRunSessions = extraTrackerArr.length > 0 || inSessionsTrackerRuns.length > 0
    ? dedupeSessionsById([...inSessionsTrackerRuns, ...extraTrackerArr])
    : []
  const trackerRoots = filterForkListRoots(trackerRunSessions, params.forkIndex.nestedChildIds)
  const trackerHeaderCount: number | null =
    typeof params.trackerRunCount === 'number'
      ? params.trackerRunCount
      : (trackerRoots.length > 0
        ? countForkTreeSessions(trackerRoots, params.forkIndex.childrenByParentId)
        : null)
  if (!shouldShowTrackerSection(params)) return

  const collapsed = params.collapsedGroups.has('trackerRuns')
  params.items.push({
    type: 'header',
    key: 'trackerRuns',
    label: params.groupLabels.trackerRuns,
    count: trackerHeaderCount,
    collapsed,
  })
  if (collapsed) return
  if (params.trackerRunsLoading) {
    params.items.push({ type: 'tracker_loading' })
    return
  }
  if (params.trackerRunsError) {
    params.items.push({ type: 'tracker_error', message: params.trackerRunsError })
    return
  }
  for (const session of trackerRoots) {
    params.pushSession(session)
  }
}

export function appendSpaceGroupedSection(params: {
  items: SessionListVirtualItem[]
  pushSession: PushSessionFn
  forkIndex: ForkChildrenIndex
  sortedSessions: ChatSession[]
  pinnedSessionIds?: Set<string>
  spaceNameById: Record<string, string>
  spaceSectionKeyById?: Record<string, string>
  spaceSectionOrder?: string[]
  spaceLastActivityById?: Record<string, string | null | undefined>
  workspaceListSortMode: WorkspaceListSortMode
  getSessionSpaceId: (session: ChatSession) => string
  getSessionSpaceLabel: (targetSpaceId: string) => string
  collapsedGroups: Set<CollapsibleGroupKey>
  externalArchivesBySpaceId?: Record<string, ExternalArchiveListItem[]>
}): void {
  const pinnedIds = params.pinnedSessionIds ?? new Set<string>()
  const normalSessions = filterForkListRoots(
    params.sortedSessions.filter(s => !pinnedIds.has(s.id) && !isTrackerRunSession(s)),
    params.forkIndex.nestedChildIds,
  )
  const groupedBySpace = new Map<string, ChatSession[]>()
  for (const session of normalSessions) {
    const targetSpaceId = params.getSessionSpaceId(session)
    const group = groupedBySpace.get(targetSpaceId)
    if (group) group.push(session)
    else groupedBySpace.set(targetSpaceId, [session])
  }
  const allSpaceIds = new Set([
    ...Object.keys(params.spaceNameById),
    ...groupedBySpace.keys(),
  ])
  // normalSessions 来自已按活跃时间排好的 sortedSessions，入组时保序；
  // 组间比较只取首条 activity，勿再对每组 sort。
  const spaceGroups = [...allSpaceIds]
    .map((targetSpaceId) => [targetSpaceId, groupedBySpace.get(targetSpaceId) ?? []] as const)
    .sort(([leftSpaceId, leftSessions], [rightSpaceId, rightSessions]) => {
      return compareWorkspaceListOrder(
        {
          id: leftSpaceId,
          name: params.spaceNameById[leftSpaceId] ?? leftSpaceId,
          lastActivityAt: params.spaceLastActivityById?.[leftSpaceId],
          sessionActivityTs: leftSessions[0] ? getSessionActivityTs(leftSessions[0]) : 0,
        },
        {
          id: rightSpaceId,
          name: params.spaceNameById[rightSpaceId] ?? rightSpaceId,
          lastActivityAt: params.spaceLastActivityById?.[rightSpaceId],
          sessionActivityTs: rightSessions[0] ? getSessionActivityTs(rightSessions[0]) : 0,
        },
        params.workspaceListSortMode,
      )
    })

  const appendSpaceGroups = (groups: typeof spaceGroups) => {
    for (const [targetSpaceId, groupSessions] of groups) {
      const groupKey = `space:${targetSpaceId}` as const
      const collapsed = params.collapsedGroups.has(groupKey)
      const archives = params.externalArchivesBySpaceId?.[targetSpaceId] ?? []
      params.items.push({
        type: 'header',
        key: groupKey,
        label: params.getSessionSpaceLabel(targetSpaceId),
        count: countForkTreeSessions(groupSessions, params.forkIndex.childrenByParentId),
        collapsed,
        externalArchiveCount: archives.length,
      })
      if (collapsed) continue
      for (const session of groupSessions) {
        params.pushSession(session, true)
      }
      // 未展开的外部档案：直接挂在该工作空间下（归档图标行），
      // 不再套一层「外部历史」子标题——多工作空间时重复标题易误读成层级错乱。
      for (const archive of archives) {
        params.items.push({
          type: 'external_archive',
          spaceId: targetSpaceId,
          archive,
        })
      }
    }
  }

  if (!params.spaceSectionKeyById) {
    const sectionGroupKey = 'section:default' as const
    const sectionCollapsed = params.collapsedGroups.has(sectionGroupKey)
    params.items.push({
      type: 'space_section_header',
      count: spaceGroups.length,
      collapsed: sectionCollapsed,
    })
    if (!sectionCollapsed) appendSpaceGroups(spaceGroups)
    return
  }

  const fallbackSectionKey = params.spaceSectionOrder?.[0] ?? 'workspace'
  const sectionOrder = [
    ...(params.spaceSectionOrder ?? []),
    ...spaceGroups
      .map(([spaceId]) => params.spaceSectionKeyById?.[spaceId] ?? fallbackSectionKey)
      .filter((key, index, keys) => !params.spaceSectionOrder?.includes(key) && keys.indexOf(key) === index),
  ]
  for (const sectionKey of sectionOrder) {
    const sectionGroups = spaceGroups.filter(([spaceId]) => (
      (params.spaceSectionKeyById?.[spaceId] ?? fallbackSectionKey) === sectionKey
    ))
    if (sectionGroups.length === 0) continue
    const sectionGroupKey = `section:${sectionKey}` as const
    const sectionCollapsed = params.collapsedGroups.has(sectionGroupKey)
    params.items.push({
      type: 'space_section_header',
      sectionKey,
      count: sectionGroups.length,
      collapsed: sectionCollapsed,
    })
    if (!sectionCollapsed) appendSpaceGroups(sectionGroups)
  }
}

export function appendTimeGroupedSection(params: {
  items: SessionListVirtualItem[]
  pushSession: PushSessionFn
  forkIndex: ForkChildrenIndex
  sortedSessions: ChatSession[]
  pinnedSessionIds?: Set<string>
  groupLabels: Record<GroupKey, string>
  collapsedGroups: Set<CollapsibleGroupKey>
}): void {
  const pinnedIds = params.pinnedSessionIds ?? new Set<string>()
  const normalSessions = filterForkListRoots(
    params.sortedSessions.filter(s => !pinnedIds.has(s.id) && !isTrackerRunSession(s)),
    params.forkIndex.nestedChildIds,
  )
  const timeGroups = groupSessionsByTime(normalSessions)
  for (const group of timeGroups) {
    const collapsed = params.collapsedGroups.has(group.key)
    const orderedSessions = sortSessionsByActivity(group.sessions)
    params.items.push({
      type: 'header',
      key: group.key,
      label: params.groupLabels[group.key],
      count: countForkTreeSessions(orderedSessions, params.forkIndex.childrenByParentId),
      collapsed,
    })
    if (!collapsed) {
      for (const session of orderedSessions) {
        params.pushSession(session)
      }
    }
  }
}
