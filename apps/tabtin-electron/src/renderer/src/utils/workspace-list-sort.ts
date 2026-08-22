/**
 * 侧栏 Workspace 列表排序口径。
 * - name：按名称固定，不随点击/活跃漂移
 * - activity：按最近活跃（优先组内会话活跃，缺省回退 Space.last_activity_at）
 */

export type WorkspaceListSortMode = 'name' | 'activity'

export const DEFAULT_WORKSPACE_LIST_SORT_MODE: WorkspaceListSortMode = 'name'

export interface WorkspaceListSortInput {
  id: string
  name: string
  lastActivityAt?: string | null
  /** 组内最新会话活跃时间（毫秒）；任务侧栏 activity 排序优先使用 */
  sessionActivityTs?: number
}

function activityTs(item: WorkspaceListSortInput): number {
  if (Number.isFinite(item.sessionActivityTs) && (item.sessionActivityTs ?? 0) > 0) {
    return item.sessionActivityTs ?? 0
  }
  const fromSpace = item.lastActivityAt ? Date.parse(item.lastActivityAt) : Number.NaN
  if (Number.isFinite(fromSpace)) return fromSpace
  return 0
}

export function compareWorkspaceListOrder(
  left: WorkspaceListSortInput,
  right: WorkspaceListSortInput,
  mode: WorkspaceListSortMode,
): number {
  if (mode === 'activity') {
    const leftTs = activityTs(left)
    const rightTs = activityTs(right)
    if (leftTs !== rightTs) return rightTs - leftTs
  }
  const nameCmp = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  if (nameCmp !== 0) return nameCmp
  return left.id.localeCompare(right.id)
}
