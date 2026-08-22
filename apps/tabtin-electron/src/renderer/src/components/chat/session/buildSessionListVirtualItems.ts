import type { ChatSession } from '@tabtin/chat-client'
import type { WorkspaceListSortMode } from '@/utils/workspace-list-sort'
import type { GroupKey } from '@/utils/chat-session-sort'
import {
  appendPinnedSection,
  appendSpaceGroupedSection,
  appendTimeGroupedSection,
  appendTrackerSection,
} from './sessionListVirtualItemSections'
import {
  buildForkChildrenIndex,
  forkCollapseKey,
  type ForkChildrenIndex,
} from './nestForkSessions'
import type {
  CollapsibleGroupKey,
  ExternalArchiveListItem,
  PushSessionFn,
  SessionListVirtualItem,
} from './sessionListVirtualItemTypes'

export type {
  CollapsibleGroupKey,
  ExternalArchiveListItem,
  PushSessionFn,
  SessionListVirtualItem,
} from './sessionListVirtualItemTypes'

export function buildSessionListVirtualItems(params: {
  sortedSessions: ChatSession[]
  pinnedSessionIds?: Set<string>
  groupLabels: Record<GroupKey, string>
  collapsedGroups: Set<CollapsibleGroupKey>
  extraTrackerRunSessions?: ChatSession[]
  trackerRunCount?: number | null
  trackerRunsLoading?: boolean
  trackerRunsError?: string | null
  spaceNameById?: Record<string, string>
  spaceSectionKeyById?: Record<string, string>
  spaceSectionOrder?: string[]
  spaceLastActivityById?: Record<string, string | null | undefined>
  workspaceListSortMode: WorkspaceListSortMode
  getSessionSpaceId: (session: ChatSession) => string
  getSessionSpaceLabel: (targetSpaceId: string) => string
  listContent: 'all' | 'sessions' | 'trackerRuns'
  /** 按工作空间归组的外部档案（不进普通会话 store） */
  externalArchivesBySpaceId?: Record<string, ExternalArchiveListItem[]>
}): SessionListVirtualItem[] {
  const items: SessionListVirtualItem[] = []
  const renderedSessionIds = new Set<string>()
  const forkIndex = buildForkChildrenIndex([
    ...params.sortedSessions,
    ...(params.extraTrackerRunSessions ?? []),
  ])

  const pushSession = createPushSessionWithForkChildren({
    items,
    renderedSessionIds,
    forkIndex,
    collapsedGroups: params.collapsedGroups,
  })

  appendPinnedSection({
    items,
    pushSession,
    forkIndex,
    sortedSessions: params.sortedSessions,
    pinnedSessionIds: params.pinnedSessionIds,
    groupLabels: params.groupLabels,
    collapsedGroups: params.collapsedGroups,
    listContent: params.listContent,
  })
  appendTrackerSection({
    items,
    pushSession,
    forkIndex,
    sortedSessions: params.sortedSessions,
    extraTrackerRunSessions: params.extraTrackerRunSessions,
    trackerRunCount: params.trackerRunCount,
    trackerRunsLoading: params.trackerRunsLoading,
    trackerRunsError: params.trackerRunsError,
    groupLabels: params.groupLabels,
    collapsedGroups: params.collapsedGroups,
    listContent: params.listContent,
  })

  if (params.listContent === 'trackerRuns') {
    return items
  }

  if (params.spaceNameById) {
    appendSpaceGroupedSection({
      items,
      pushSession,
      forkIndex,
      sortedSessions: params.sortedSessions,
      pinnedSessionIds: params.pinnedSessionIds,
      spaceNameById: params.spaceNameById,
      spaceSectionKeyById: params.spaceSectionKeyById,
      spaceSectionOrder: params.spaceSectionOrder,
      spaceLastActivityById: params.spaceLastActivityById,
      workspaceListSortMode: params.workspaceListSortMode,
      getSessionSpaceId: params.getSessionSpaceId,
      getSessionSpaceLabel: params.getSessionSpaceLabel,
      collapsedGroups: params.collapsedGroups,
      externalArchivesBySpaceId: params.externalArchivesBySpaceId,
    })
  } else {
    appendTimeGroupedSection({
      items,
      pushSession,
      forkIndex,
      sortedSessions: params.sortedSessions,
      pinnedSessionIds: params.pinnedSessionIds,
      groupLabels: params.groupLabels,
      collapsedGroups: params.collapsedGroups,
    })
  }

  return items
}

function createPushSessionWithForkChildren(params: {
  items: SessionListVirtualItem[]
  renderedSessionIds: Set<string>
  forkIndex: ForkChildrenIndex
  collapsedGroups: Set<CollapsibleGroupKey>
}): PushSessionFn {
  const { items, renderedSessionIds, forkIndex, collapsedGroups } = params

  const pushOne = (session: ChatSession, nested: boolean | undefined, forkDepth: number) => {
    if (renderedSessionIds.has(session.id)) return
    renderedSessionIds.add(session.id)

    // 索引已扁平：仅列表根带 children；子行不再挂孙级
    const children = forkDepth === 0
      ? (forkIndex.childrenByParentId.get(session.id) ?? [])
      : []
    const childCount = children.length
    const collapsed = childCount > 0 && collapsedGroups.has(forkCollapseKey(session.id))

    const item: Extract<SessionListVirtualItem, { type: 'session' }> = {
      type: 'session',
      session,
    }
    if (nested) item.nested = true
    if (forkDepth > 0) item.forkDepth = forkDepth
    if (childCount > 0) item.forkBranch = { collapsed, childCount }
    items.push(item)

    if (collapsed) return
    for (const child of children) {
      pushOne(child, nested, 1)
    }
  }

  return (session: ChatSession, nested?: boolean) => {
    // 子会话只应作为父会话推入后的挂载结果出现，忽略误当作根推入
    if (forkIndex.nestedChildIds.has(session.id)) return
    pushOne(session, nested, 0)
  }
}
