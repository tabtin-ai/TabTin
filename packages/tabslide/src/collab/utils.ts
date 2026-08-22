/**
 * TabSlide 协作工具函数 — Y.Map<string, string> 有序 ID 列表 (Fractional Indexing)
 *
 * 与服务端 apps/collab-live/src/lib/y-utils.ts 保持逻辑一致。
 * key = ID, value = fractional index 字符串，按字典序升序排列。
 * 向后兼容：旧格式使用整数 position（number），新格式使用 fractional index（string）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type * as YType from 'yjs'
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

// 运行时动态引入 Y，避免在 SSR/测试环境中因 yjs 版本不匹配报错
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YMap = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YArray = any

/**
 * 从 Y.Map 中读取按 position 排序的 ID 列表。
 * 向后兼容：支持 number（旧格式）和 string（新 fractional index 格式）混合排序。
 * - 两个 number: 按数值排序
 * - 两个 string: 按字典序排序（fractional index 设计为字典序可比较）
 * - number vs string: number 排在前面（兼容过渡期混合值）
 * position 相同时按 key 字典序稳定排序，保证确定性。
 */
export function getOrderedIds(ymap: YMap): string[] {
  const entries: [string, number | string][] = []
  ymap.forEach((pos: number | string, id: string) => entries.push([id, pos]))
  entries.sort((a, b) => {
    const pa = a[1], pb = b[1]
    const ta = typeof pa, tb = typeof pb
    if (ta === 'number' && tb === 'number') return (pa as number) - (pb as number) || a[0].localeCompare(b[0])
    if (ta === 'string' && tb === 'string') return pa < pb ? -1 : pa > pb ? 1 : a[0].localeCompare(b[0])
    return ta === 'number' ? -1 : 1
  })
  return entries.map(([id]) => id)
}

/**
 * 将有序 ID 列表写入 Y.Map，使用 fractional index 字符串作为 position。
 * 清除 map 中不在 ids 里的旧 key，然后写入 id → fractional index 映射。
 * 整个操作在单个 Y.Doc transaction 内完成以保证原子性。
 */
export function setOrderedIds(ymap: YMap, ids: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (ymap as any).doc
  const apply = () => {
    const idSet = new Set(ids)
    const keysToDelete: string[] = []
    ymap.forEach((_: unknown, key: string) => {
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
 * 单项重排：只更新被移动项的 fractional index，不影响其他项。
 * 并发安全：两个用户同时拖拽不同项目时，各自只写自己的 key，CRDT LWW 不会冲突。
 *
 * @param orderMap Y.Map 排序映射
 * @param itemId   被移动项的 ID
 * @param beforeId 目标位置的前一项 ID（null 表示移动到最前面）
 * @param afterId  目标位置的后一项 ID（null 表示移动到最后面）
 */
export function reorderItem(
  orderMap: YMap,
  itemId: string,
  beforeId: string | null,
  afterId: string | null,
): void {
  let hasLegacy = false
  orderMap.forEach((pos: unknown) => {
    if (typeof pos === 'number') hasLegacy = true
  })
  if (hasLegacy) {
    const ids = getOrderedIds(orderMap)
    const positions = ids.length > 0 ? generateNKeysBetween(null, null, ids.length) : []
    for (let i = 0; i < ids.length; i++) {
      orderMap.set(ids[i], positions[i])
    }
  }

  const beforePos: string | null = beforeId ? (orderMap.get(beforeId) as string) ?? null : null
  const afterPos: string | null = afterId ? (orderMap.get(afterId) as string) ?? null : null
  const newPos = generateKeyBetween(beforePos, afterPos)
  orderMap.set(itemId, newPos)
}

/**
 * 检测是否为单项移动：对比旧序列和新序列，如果只有一个元素改变了位置，
 * 返回该元素的 ID 和在新序列中的邻居信息。
 */
export function detectSingleItemMove(
  oldOrder: string[],
  newOrder: string[],
): { itemId: string; beforeId: string | null; afterId: string | null } | null {
  if (oldOrder.length !== newOrder.length || oldOrder.length === 0) return null

  const oldSet = new Set(oldOrder)
  for (const id of newOrder) {
    if (!oldSet.has(id)) return null
  }

  for (const id of newOrder) {
    const oldWithout = oldOrder.filter(x => x !== id)
    const newWithout = newOrder.filter(x => x !== id)
    if (oldWithout.length === newWithout.length && oldWithout.every((x, i) => x === newWithout[i])) {
      const newIdx = newOrder.indexOf(id)
      return {
        itemId: id,
        beforeId: newIdx > 0 ? newOrder[newIdx - 1] : null,
        afterId: newIdx < newOrder.length - 1 ? newOrder[newIdx + 1] : null,
      }
    }
  }
  return null
}

/**
 * 向后兼容：从 Y.Array<string> 同步内容到 Y.Map（使用 fractional index）。
 * 仅当 Y.Map 为空且 Y.Array 非空时执行同步（避免覆盖已有数据）。
 */
export function syncArrayToMap(arr: YArray, map: YMap): void {
  if (map.size > 0 || arr.length === 0) return
  const ids: string[] = arr.toArray()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (map as any).doc
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

/**
 * 从 Y.Map（优先）或 Y.Array（fallback）读取有序 ID 列表。
 * 当 Y.Map 非空时直接使用 Y.Map；Y.Map 为空时 fallback 到 Y.Array，
 * 并同步将 Y.Array 内容写入 Y.Map（向后兼容迁移）。
 */
export function readOrderedIdsWithFallback(ymap: YMap, yarr: YArray): string[] {
  if (ymap.size > 0) {
    return getOrderedIds(ymap)
  }
  if (yarr.length > 0) {
    syncArrayToMap(yarr, ymap)
    return yarr.toArray() as string[]
  }
  return []
}
