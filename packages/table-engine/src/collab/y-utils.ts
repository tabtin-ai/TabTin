/**
 * Y.js 有序 ID 工具函数（客户端版）
 *
 * rowOrderMap 是兼容旧客户端的 scalar 投影；新协作排序真相存放在每条 record 的
 * ``__position_id``。本文件只处理 legacy map，不会在纯读取时整表改写。
 *
 * ⚠️ position 不是数字：不要对它做任何数值运算（曾经 `pos + 间距` / `a-b` 把字符串
 *    "a0" 拼成 "a01000"、比较成 NaN，导致排序退化为按 id 字典序、拖拽排序完全失效）。
 */

import * as Y from 'yjs'
import { generateNKeysBetween } from 'fractional-indexing'
import {
  allocateRecordPositions,
  compareRecordPositions,
  type PositionableRecord,
} from './record-position'

export type RowOrderInsertContext = {
  anchor_record_id?: string
  position?: 'before' | 'after' | 'end'
}

function compareOrderPosition(
  a: [string, number | string],
  b: [string, number | string],
): number {
  const pa = a[1]
  const pb = b[1]
  const ta = typeof pa
  const tb = typeof pb
  if (ta === 'number' && tb === 'number') {
    const positionCompare = pa < pb ? -1 : pa > pb ? 1 : 0
    return positionCompare || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  }
  if (ta === 'string' && tb === 'string') {
    return pa < pb ? -1 : pa > pb ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  }
  return ta === 'number' ? -1 : 1
}

/**
 * 从 Y.Map 中读取按 position 排序的 ID 列表。
 * position 相同时按 key 字典序稳定排序，保证确定性。
 *
 * 泛型兼容同质 ``Y.Map<string>``（行序 fractional index）与 ``Y.Map<number>``
 * （视图序数值索引）——两者都用同一套 ``<`` 比较，无类型分支。
 */
export function getOrderedIds<T extends number | string>(ymap: Y.Map<T>): string[] {
  const entries: [string, T][] = []
  ymap.forEach((pos, id) => entries.push([id, pos]))
  entries.sort(compareOrderPosition)
  return entries.map(([id]) => id)
}

function positionableRows(
  ymap: Y.Map<string | number>,
  excludedIds: ReadonlySet<string> = new Set(),
): PositionableRecord[] {
  const records: PositionableRecord[] = []
  ymap.forEach((legacyPosition, recordId) => {
    if (!excludedIds.has(recordId)) {
      records.push({ recordId, legacyPosition, legacyMapPosition: legacyPosition })
    }
  })
  return records.sort(compareRecordPositions)
}

/**
 * 将有序 ID 列表写入 Y.Map（fractional index 字符串）。
 * 清除 map 中不在 ids 里的旧 key，然后整体重排。
 *
 * ⚠️ 本函数会重写所有行的 position，仅适用于初始化、快照恢复、reconcile 等
 *    非并发场景。并发拖拽排序请使用 moveRowInOrder / moveRowsInOrder，
 *    它们只更新被移动行的 position，利用 Y.Map LWW 语义避免互相覆盖。
 */
export function setOrderedIds(ymap: Y.Map<string>, ids: string[]): void {
  const doc = ymap.doc
  const apply = () => {
    const idSet = new Set(ids)
    const keysToDelete: string[] = []
    ymap.forEach((_, key) => {
      if (!idSet.has(key)) keysToDelete.push(key)
    })
    for (const key of keysToDelete) ymap.delete(key)
    const positions = ids.length > 0 ? generateNKeysBetween(null, null, ids.length) : []
    for (let i = 0; i < ids.length; i++) {
      ymap.set(ids[i], positions[i])
    }
  }
  if (doc) {
    doc.transact(apply)
  } else {
    apply()
  }
}

/**
 * 计算「追加到末尾」的 legacy scalar 投影，用于旧客户端 rowOrderMap，
 * 使其排在当前所有行之后。map 为空时返回起始 key。
 */
export function appendRowOrderKey(ymap: Y.Map<string>): string
export function appendRowOrderKey(ymap: Y.Map<string | number>): string | number
export function appendRowOrderKey(ymap: Y.Map<any>): string | number {
  const records = positionableRows(ymap)
  const allocation = allocateRecordPositions(records, ['__legacy_projection__'], records.length)
    .allocations.find(item => item.recordId === '__legacy_projection__')
  if (!allocation) throw new Error('Unable to allocate legacy row order projection')
  return allocation.legacyPosition
}

/**
 * 依据后端同款 order_context 为新行计算 fractional index。
 *
 * 协作在线路径不经过 REST create，因此必须在 Y.Doc 写入时就把新行放到
 * 用户右键的视觉锚点附近；否则后端 persist 只能忠实保存“已追加到末尾”的
 * rowOrderMap。
 */
export function insertRowOrderKey(
  ymap: Y.Map<string>,
  recordId: string,
  context?: RowOrderInsertContext,
): string
export function insertRowOrderKey(
  ymap: Y.Map<string | number>,
  recordId: string,
  context?: RowOrderInsertContext,
): string | number
export function insertRowOrderKey(
  ymap: Y.Map<any>,
  recordId: string,
  context?: RowOrderInsertContext,
): string | number {
  const records = positionableRows(ymap, new Set([recordId]))
  let targetIndex = records.length
  if (context?.position !== 'end' && context?.anchor_record_id) {
    const anchorIndex = records.findIndex(record => record.recordId === context.anchor_record_id)
    if (anchorIndex >= 0) {
      targetIndex = context.position === 'before' ? anchorIndex : anchorIndex + 1
    }
  }
  const allocation = allocateRecordPositions(records, [recordId], targetIndex)
    .allocations.find(item => item.recordId === recordId)
  if (!allocation) throw new Error(`Unable to allocate legacy row order projection for ${recordId}`)
  return allocation.legacyPosition
}

/**
 * 仅更新被移动行的 position，不全量重写。
 * 利用 Y.Map LWW 语义：只有被移动行的 key 被写入，
 * 其他行保持原 position 不变，并发拖拽互不影响。
 *
 * @param ymap       rowOrderMap
 * @param movedId    被拖拽的行 ID
 * @param targetIndex 目标位置索引（在排除 movedId 后的列表中）
 */
export function moveRowInOrder(
  ymap: Y.Map<string | number>,
  movedId: string,
  targetIndex: number,
): void {
  const doc = ymap.doc
  const apply = () => {
    const records = positionableRows(ymap)
    const plan = allocateRecordPositions(records, [movedId], targetIndex)
    const moved = plan.allocations.find(allocation => allocation.recordId === movedId)
    if (moved) ymap.set(movedId, moved.legacyPosition)
  }

  if (doc) {
    doc.transact(apply, 'local')
  } else {
    apply()
  }
}

/**
 * 批量移动多行（如选中 3 行一起拖拽）。
 * 将所有被移动行从排序列表中移除，在目标位置之间生成 n 个 fractional index。
 *
 * @param ymap        rowOrderMap
 * @param movedIds    被拖拽的行 ID 列表（保持拖拽前的相对顺序）
 * @param targetIndex 目标位置索引（在排除 movedIds 后的列表中）
 */
export function moveRowsInOrder(
  ymap: Y.Map<string | number>,
  movedIds: string[],
  targetIndex: number,
): void {
  if (movedIds.length === 0) return
  if (movedIds.length === 1) {
    moveRowInOrder(ymap, movedIds[0], targetIndex)
    return
  }

  const doc = ymap.doc
  const apply = () => {
    const records = positionableRows(ymap)
    const plan = allocateRecordPositions(records, movedIds, targetIndex)
    for (const allocation of plan.allocations) {
      if (!allocation.preserveLegacyProjection) {
        ymap.set(allocation.recordId, allocation.legacyPosition)
      }
    }
  }

  if (doc) {
    doc.transact(apply, 'local')
  } else {
    apply()
  }
}

/**
 * 从 Y.Array<string> 同步内容到 Y.Map（fractional index）。
 * 仅当 Y.Map 为空且 Y.Array 非空时执行（避免覆盖已有数据）。
 * 用于过渡期：旧服务端只写 Y.Array，新客户端据此补齐 Y.Map。
 */
export function syncArrayToMap(arr: Y.Array<string>, map: Y.Map<string>): void {
  if (map.size > 0 || arr.length === 0) return
  const ids = arr.toArray()
  const doc = map.doc
  const apply = () => {
    const positions = ids.length > 0 ? generateNKeysBetween(null, null, ids.length) : []
    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], positions[i])
    }
  }
  if (doc) {
    doc.transact(apply)
  } else {
    apply()
  }
}
