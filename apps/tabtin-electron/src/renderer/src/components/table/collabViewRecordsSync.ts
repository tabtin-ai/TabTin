import type { ViewStore } from '@tabtin/table-core'

/** 离线 REST 或服务端限定查询参数（搜索/日历范围/看板分组分页等）。 */
export const hasServerScopedRecordsQuery = (
  query: ViewStore['recordsQuery'],
): boolean => {
  if (typeof query.search === 'string' && query.search.trim().length > 0) return true
  if (typeof query.date_range === 'string' && query.date_range.trim().length > 0) return true
  if (typeof query.search_field_ids === 'string' && query.search_field_ids.trim().length > 0) {
    return true
  }
  if (Array.isArray(query.search_field_ids) && query.search_field_ids.length > 0) return true
  if (typeof query.search_hide_not_match_rows === 'boolean') return true
  if (typeof query.per_group_limit === 'number' && query.per_group_limit > 0) return true
  if (query.group_offsets && Object.keys(query.group_offsets).length > 0) return true
  return false
}

/**
 * 协作首次同步完成且 Y.Doc 快照完整（非 truncated）时，视图记录由客户端投影驱动。
 * SYNCING 期间 Y.Doc 可能还是空的，不能用它覆盖已经渲染的 REST 记录。
 * search / date_range / per_group_limit / group_offsets 在投影层处理，不再关闭投影。
 *
 * 第三参暂可选：日历 / 看板 / 画廊 / 闪卡仍按两参调用。
 * 省略时视为未完成首次同步，不接管投影。调用点补齐后应改回必填。
 */
export const shouldProjectViewRecordsFromCollabYdoc = (
  isCollabRuntime: boolean,
  isTruncated: boolean,
  hasCompletedInitialSync?: boolean,
): boolean => isCollabRuntime && !isTruncated && Boolean(hasCompletedInitialSync)

/**
 * 是否应走 REST fetchViewRecords（离线降级或 truncated 超大表兜底）。
 */
export const shouldUseRestRecordsQuery = (
  isCollabRuntime: boolean,
  isTruncated: boolean,
): boolean => !isCollabRuntime || isTruncated

export const shouldFetchConfirmedRuntimeViewRecords = ({
  isCollabRuntime,
  isTruncated,
  currentViewId,
  lastLoadedRestViewIds,
  isAwaitingRestConfirmation,
}: {
  isCollabRuntime: boolean
  isTruncated: boolean
  currentViewId: string | null
  lastLoadedRestViewIds: readonly string[]
  isAwaitingRestConfirmation: boolean
}): boolean => Boolean(
  isCollabRuntime
  && isTruncated
  && currentViewId
  && isAwaitingRestConfirmation
  && lastLoadedRestViewIds.includes(currentViewId)
)

export const collabYdocRecordsMissingFromStore = (
  ydocRecords: { records?: Array<{ id?: string | number }> } | null | undefined,
  storeRecords: { records?: Array<{ id?: string | number }> } | null | undefined,
): boolean => {
  const storeIds = new Set(
    (storeRecords?.records ?? []).map(record => String(record.id)),
  )
  return (ydocRecords?.records ?? []).some(
    record => !storeIds.has(String(record.id)),
  )
}

type ViewRecordsMetadata =
  | {
      groups?: { nodes?: unknown } | null
      sub_records?: { tree_data?: unknown } | null
    }
  | null
  | undefined

/**
 * Y.Doc 投影含分组/层级 metadata，但 store 当前值（多为 REST 覆盖后）丢失了它。
 *
 * 协作在线态分组树/子记录树由前端在 Y.Doc 快照上计算（collabViewRuntime），
 * 若某条 REST 路径把 currentViewRecords 覆盖成不含 metadata.groups.nodes /
 * sub_records.tree_data 的快照，grid 会落到「平铺」分支——即用户感知的「分层回退」。
 * 用于在投影仍具备分组/层级时把 store 重新指回投影。
 */
export const collabProjectionMetadataDropped = (
  ydocRecords: { metadata?: ViewRecordsMetadata } | null | undefined,
  storeRecords: { metadata?: ViewRecordsMetadata } | null | undefined,
): boolean => {
  const ydocMeta = ydocRecords?.metadata
  const storeMeta = storeRecords?.metadata
  const ydocHasGroups = Boolean(ydocMeta?.groups?.nodes)
  const storeHasGroups = Boolean(storeMeta?.groups?.nodes)
  const ydocHasTree = Boolean(ydocMeta?.sub_records?.tree_data)
  const storeHasTree = Boolean(storeMeta?.sub_records?.tree_data)
  return (ydocHasGroups && !storeHasGroups) || (ydocHasTree && !storeHasTree)
}
