/**
 * 云盘资源拖拽诊断 — 解释 canDrag=false 的原因，并去重打日志。
 *
 * Windows 偶现「拖不动」时诊断包常零条 dragStart 日志：draggable=false 时浏览器
 * 根本不派发 dragstart。本模块在 pointerdown 时补盲区，区分 empty_id / local_id /
 * foreign_shared / deleting / batch_mode。
 */
import { createLogger } from '@/utils/logger'
import { isMovableContextItemId } from './useCollectionDnD'

const log = createLogger('ResourceDragDiag')

export type ResourceDragBlockReason =
  | 'empty_id'
  | 'local_id'
  | 'foreign_shared'
  | 'deleting'
  | 'batch_mode'
  | null

const loggedKeys = new Set<string>()

export function getResourceDragBlockReason(
  item: { id?: string | null },
  options?: {
    foreignShared?: boolean
    deleting?: boolean
    batchMode?: boolean
  },
): ResourceDragBlockReason {
  if (options?.deleting) return 'deleting'
  if (options?.batchMode) return 'batch_mode'
  if (options?.foreignShared) return 'foreign_shared'
  const id = item.id ?? ''
  if (!id) return 'empty_id'
  if (id.startsWith('local:')) return 'local_id'
  if (!isMovableContextItemId(id)) return 'empty_id'
  return null
}

export function logResourceDragBlocked(
  item: { id?: string | null; resource_id?: string | null; collection_id?: string | null },
  reason: ResourceDragBlockReason,
  extra?: Record<string, unknown>,
): void {
  if (!reason) return
  const key = `${item.resource_id || item.id || '(unknown)'}:${reason}`
  if (loggedKeys.has(key)) return
  loggedKeys.add(key)
  log.warn('drag blocked before dragstart (draggable=false)', {
    reason,
    itemId: item.id || '(empty)',
    resource_id: item.resource_id ?? null,
    collection_id: item.collection_id ?? null,
    ...extra,
  })
}

/** 测试用：清空去重集合 */
export function resetResourceDragDiagForTests(): void {
  loggedKeys.clear()
}
