export interface FieldSchemaChangeInfo {
  action: string
  field_ids?: string[]
}

const FIELD_SCHEMA_REFRESH_TOMBSTONE_TTL_MS = 120_000

const pruneExpiredTombstones = (
  tombstones: Map<string, number>,
  now: number,
) => {
  for (const [fieldId, deletedAt] of tombstones) {
    if (now - deletedAt > FIELD_SCHEMA_REFRESH_TOMBSTONE_TTL_MS) {
      tombstones.delete(fieldId)
    }
  }
}

export const markDeletedFieldSchemaTombstone = (
  tombstones: Map<string, number>,
  fieldId: string,
  now = Date.now(),
) => {
  pruneExpiredTombstones(tombstones, now)
  tombstones.set(fieldId, now)
}

/**
 * 仅抑制「本端刚 REST 删除」的 delete_field 回声，避免 loadFields 把列又刷回来。
 * restore_field / create_field / update_field 必须放行——否则 Ctrl+Z 恢复后
 * tombstone 会挡住 schema 刷新，Y.Doc meta 继续缺字段，随后 fields_sync 再回删。
 */
export const shouldSkipFieldSchemaRefreshForRecentLocalDelete = (
  info: FieldSchemaChangeInfo,
  tombstones: Map<string, number>,
  now = Date.now(),
): boolean => {
  pruneExpiredTombstones(tombstones, now)
  if (info.action !== 'delete_field') {
    return false
  }
  const fieldIds = info.field_ids ?? []
  return fieldIds.some(fieldId => tombstones.has(fieldId))
}

/**
 * 字段结构变更后如何刷新视图元数据。
 *
 * - `none`：仅字段定义变化（如选项），不碰 views
 * - `preserve`：刷新视图列表，但不得传 loadViews.resetToViewId；否则会清空
 *   currentViewRecords → 骨架屏 → 卸载 GridToolbar（首次导入 drawer 闪关）
 */
export type FieldSchemaViewRefreshMode = 'none' | 'preserve'

export const planFieldSchemaViewRefresh = (
  action: string,
): FieldSchemaViewRefreshMode => {
  if (action === 'update_field') return 'none'
  return 'preserve'
}

/**
 * ：协作从离线/降级回到 SYNCED 时，应强制 REST 对账 fields/views。
 * CLI/Agent 导入期间若标签未激活，可能错过 schema.changed；上线瞬间补一次。
 */
export const shouldReconcileSchemaOnCollabOnline = (
  wasCollabRuntime: boolean,
  isCollabRuntime: boolean,
): boolean => !wasCollabRuntime && isCollabRuntime

/**
 * ：表标签从 inactive → active 时也应对账。
 * 协作保持 online 但 Activity/订阅错过事件时，靠切回标签补 REST。
 */
export const shouldReconcileSchemaOnTabActivate = (
  wasActive: boolean,
  isActive: boolean,
): boolean => !wasActive && isActive
