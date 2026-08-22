/**
 * 分享页只读表格：是否用协作快照覆盖 REST records。
 *
 * 协作连接中 / Collab 宕机时，ydoc 可能已创建且 isRealtime=true，
 * 但 recordsSnapshot 仍为空。若此时覆盖 REST，页面会显示「暂无数据」。
 */
export function shouldPreferCollabShareRecords(input: {
  isRealtime: boolean
  recordsSnapshotSize: number
  rowOrderLength: number
}): boolean {
  if (!input.isRealtime) return false
  // 空快照不覆盖 REST；真·空表时 REST 本身也是 0 行，表现一致
  if (input.recordsSnapshotSize === 0 && input.rowOrderLength === 0) return false
  return true
}
