import type { PPTElement } from '../types/slides'
import { getLineSelectionRect } from './line-geometry'

export interface HitRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 获取元素的轴对齐包围盒（AABB），考虑旋转。
 * 旋转后的矩形 AABB 比原始矩形更大。
 */
export function getElementRect(el: PPTElement): HitRect {
  if (el.type === 'line') {
    return getLineSelectionRect(el)
  }
  const { x, y, width, height } = el
  const rotate = el.rotate || 0
  if (rotate === 0) return { x, y, width, height }

  // 计算旋转后的 AABB：将四个角绕中心旋转，取最小/最大 x/y
  const cx = x + width / 2
  const cy = y + height / 2
  const rad = (rotate * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  // 四个角相对中心的偏移
  const hw = width / 2
  const hh = height / 2
  const corners = [
    [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh],
  ]

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [dx, dy] of corners) {
    const rx = cx + dx * cos - dy * sin
    const ry = cy + dx * sin + dy * cos
    if (rx < minX) minX = rx
    if (ry < minY) minY = ry
    if (rx > maxX) maxX = rx
    if (ry > maxY) maxY = ry
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function rectsIntersect(a: HitRect, b: HitRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

export type BoxSelectionResult =
  | { type: 'select'; ids: string[] }
  | { type: 'clear' }
  | { type: 'noop' }

interface BoxSelectionParams {
  elements: PPTElement[]
  /** 已转换到画布坐标系的框选矩形 */
  selectionInCanvas: HitRect
  prevSelectedIds: string[]
  /** Shift 追加模式 */
  appendMode: boolean
}

/**
 * 纯函数：根据框选矩形计算下一步选择结果。
 *
 * - 锁定 / 隐藏元素不参与命中
 * - 组合元素：只有全部成员都被框选时才整组选中（PPTist 的做法）
 * - 追加模式用 XOR：已选中的命中项取消、新命中项加入
 */
export function computeBoxSelectionResult({
  elements,
  selectionInCanvas,
  prevSelectedIds,
  appendMode,
}: BoxSelectionParams): BoxSelectionResult {
  const hitIds: string[] = []
  const groupHits = new Map<string, string[]>() // groupId → hitElementIds

  for (const el of elements) {
    if (el.locked) continue
    if (el.visible === false) continue

    const elRect = getElementRect(el)
    if (rectsIntersect(selectionInCanvas, elRect)) {
      if (el.groupId) {
        const arr = groupHits.get(el.groupId) || []
        arr.push(el.id)
        groupHits.set(el.groupId, arr)
      } else {
        hitIds.push(el.id)
      }
    }
  }

  // 组合元素：只有全部成员都被框选时才选中（PPTist 的做法）
  for (const [groupId, memberIds] of groupHits) {
    const allGroupMembers = elements.filter((e) => e.groupId === groupId)
    if (memberIds.length === allGroupMembers.length) {
      hitIds.push(...memberIds)
    }
  }

  if (hitIds.length > 0) {
    if (appendMode) {
      const prev = prevSelectedIds
      const hitSet = new Set(hitIds)
      const kept = prev.filter((id) => !hitSet.has(id))
      const added = hitIds.filter((id) => !new Set(prev).has(id))
      return { type: 'select', ids: [...kept, ...added] }
    }
    return { type: 'select', ids: hitIds }
  }

  // 没选中任何东西 & 非追加模式：清空选择
  if (!appendMode) return { type: 'clear' }
  return { type: 'noop' }
}
