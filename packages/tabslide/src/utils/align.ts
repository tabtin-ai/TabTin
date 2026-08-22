/**
 * 对齐 & 分布工具
 *
 * 参考 PPTist 的三个模块：
 * - useAlignActiveElement.ts：元素间对齐
 * - useAlignElementToCanvas.ts：元素对画布对齐
 * - useUniformDisplayElement.ts：均匀分布
 *
 * 我们统一为纯函数，不依赖 store，通过返回更新指令让调用方执行。
 *
 * 关键设计：
 * - 所有函数返回 { id, x, y }[] 更新列表
 * - 线条元素只更新 x/y（没有 height/rotate）
 * - 组合元素作为整体处理
 */

import type { PPTElement } from '../types/slides'
import { getLineAbsoluteBounds } from './line-geometry'

interface PositionUpdate {
  id: string
  x: number
  y: number
}

// ── 元素矩形 ──

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface RectInfo extends Rect {
  /** rect.x/y 相对元素 origin 的偏移（普通元素为 0，线条可能为负） */
  offsetX: number
  offsetY: number
}

interface UnitMember {
  el: PPTElement
  rect: RectInfo
}

interface MovableUnit {
  members: UnitMember[]
  bounds: Rect
  firstIndex: number
}

function getRectInfo(el: PPTElement): RectInfo {
  if (el.type === 'line') {
    const bounds = getLineAbsoluteBounds(el)
    const renderedWidth = typeof el.width === 'number' && Number.isFinite(el.width)
      ? Math.max(el.width, 1)
      : 1
    const renderedHeight = typeof el.height === 'number' && Number.isFinite(el.height)
      ? Math.max(el.height, 1)
      : 1
    return {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, renderedWidth),
      height: Math.max(bounds.height, renderedHeight),
      offsetX: bounds.minX,
      offsetY: bounds.minY,
    }
  }
  return {
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    offsetX: 0,
    offsetY: 0,
  }
}

function toPositionUpdate(
  el: PPTElement,
  rect: RectInfo,
  nextRectX: number,
  nextRectY: number,
): PositionUpdate {
  return {
    id: el.id,
    x: nextRectX - rect.offsetX,
    y: nextRectY - rect.offsetY,
  }
}

function moveUnit(unit: MovableUnit, nextUnitX: number, nextUnitY: number): PositionUpdate[] {
  const deltaX = nextUnitX - unit.bounds.x
  const deltaY = nextUnitY - unit.bounds.y
  return unit.members.map(({ el, rect }) =>
    toPositionUpdate(el, rect, rect.x + deltaX, rect.y + deltaY))
}

function buildMovableUnits(elements: PPTElement[]): MovableUnit[] {
  const units: MovableUnit[] = []
  const grouped = new Map<string, { members: Array<UnitMember & { index: number }>; hasLocked: boolean; firstIndex: number }>()

  elements.forEach((el, index) => {
    const rect = getRectInfo(el)
    if (!el.groupId) {
      if (el.locked) return
      units.push({
        members: [{ el, rect }],
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        firstIndex: index,
      })
      return
    }

    const current = grouped.get(el.groupId)
    if (!current) {
      grouped.set(el.groupId, {
        members: [{ el, rect, index }],
        hasLocked: !!el.locked,
        firstIndex: index,
      })
      return
    }
    current.members.push({ el, rect, index })
    current.hasLocked = current.hasLocked || !!el.locked
    if (index < current.firstIndex) current.firstIndex = index
  })

  for (const entry of grouped.values()) {
    if (entry.hasLocked) continue
    const rects = entry.members.map((member) => member.rect)
    const bounds = getSelectionBounds(rects)
    if (!bounds) continue
    units.push({
      members: entry.members.map(({ el, rect }) => ({ el, rect })),
      bounds,
      firstIndex: entry.firstIndex,
    })
  }

  return units.sort((a, b) => a.firstIndex - b.firstIndex)
}

function getSelectionBounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.width))
  const maxY = Math.max(...rects.map((r) => r.y + r.height))
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  元素间对齐（多选 ≥2 时可用）                                ║
// ╚══════════════════════════════════════════════════════════════╝

/** 左对齐 — 所有元素左边缘对齐到最左边的元素 */
export function alignLeft(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 2) return []
  const minX = Math.min(...units.map((unit) => unit.bounds.x))
  return units.flatMap((unit) => moveUnit(unit, minX, unit.bounds.y))
}

/** 右对齐 — 所有元素右边缘对齐到最右边的元素 */
export function alignRight(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 2) return []
  const maxRight = Math.max(...units.map((unit) => unit.bounds.x + unit.bounds.width))
  return units.flatMap((unit) => moveUnit(unit, maxRight - unit.bounds.width, unit.bounds.y))
}

/** 上对齐 */
export function alignTop(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 2) return []
  const minY = Math.min(...units.map((unit) => unit.bounds.y))
  return units.flatMap((unit) => moveUnit(unit, unit.bounds.x, minY))
}

/** 下对齐 */
export function alignBottom(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 2) return []
  const maxBottom = Math.max(...units.map((unit) => unit.bounds.y + unit.bounds.height))
  return units.flatMap((unit) => moveUnit(unit, unit.bounds.x, maxBottom - unit.bounds.height))
}

/** 水平居中对齐 */
export function alignHorizontalCenter(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 2) return []
  const bounds = getSelectionBounds(units.map((unit) => ({
    x: unit.bounds.x,
    y: unit.bounds.y,
    width: unit.bounds.width,
    height: unit.bounds.height,
  })))
  if (!bounds) return []
  const centerX = bounds.x + bounds.width / 2
  return units.flatMap((unit) =>
    moveUnit(unit, centerX - unit.bounds.width / 2, unit.bounds.y))
}

/** 垂直居中对齐 */
export function alignVerticalCenter(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 2) return []
  const bounds = getSelectionBounds(units.map((unit) => ({
    x: unit.bounds.x,
    y: unit.bounds.y,
    width: unit.bounds.width,
    height: unit.bounds.height,
  })))
  if (!bounds) return []
  const centerY = bounds.y + bounds.height / 2
  return units.flatMap((unit) =>
    moveUnit(unit, unit.bounds.x, centerY - unit.bounds.height / 2))
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  元素对画布对齐（单选/多选都可用）                            ║
// ╚══════════════════════════════════════════════════════════════╝

/** 居中到画布 */
export function alignToCanvasCenter(
  elements: PPTElement[],
  canvasWidth: number,
  canvasHeight: number,
): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length === 0) return []
  if (units.length === 1) {
    const one = units[0]!
    return moveUnit(
      one,
      (canvasWidth - one.bounds.width) / 2,
      (canvasHeight - one.bounds.height) / 2,
    )
  }
  const bounds = getSelectionBounds(units.map((unit) => ({
    x: unit.bounds.x,
    y: unit.bounds.y,
    width: unit.bounds.width,
    height: unit.bounds.height,
  })))
  if (!bounds) return []
  const deltaX = (canvasWidth / 2) - (bounds.x + bounds.width / 2)
  const deltaY = (canvasHeight / 2) - (bounds.y + bounds.height / 2)
  return units.flatMap((unit) =>
    moveUnit(unit, unit.bounds.x + deltaX, unit.bounds.y + deltaY))
}

/** 水平居中到画布 */
export function alignToCanvasHCenter(
  elements: PPTElement[],
  canvasWidth: number,
): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length === 0) return []
  if (units.length === 1) {
    const one = units[0]!
    return moveUnit(one, (canvasWidth - one.bounds.width) / 2, one.bounds.y)
  }
  const bounds = getSelectionBounds(units.map((unit) => ({
    x: unit.bounds.x,
    y: unit.bounds.y,
    width: unit.bounds.width,
    height: unit.bounds.height,
  })))
  if (!bounds) return []
  const deltaX = (canvasWidth / 2) - (bounds.x + bounds.width / 2)
  return units.flatMap((unit) =>
    moveUnit(unit, unit.bounds.x + deltaX, unit.bounds.y))
}

/** 垂直居中到画布 */
export function alignToCanvasVCenter(
  elements: PPTElement[],
  canvasHeight: number,
): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length === 0) return []
  if (units.length === 1) {
    const one = units[0]!
    return moveUnit(one, one.bounds.x, (canvasHeight - one.bounds.height) / 2)
  }
  const bounds = getSelectionBounds(units.map((unit) => ({
    x: unit.bounds.x,
    y: unit.bounds.y,
    width: unit.bounds.width,
    height: unit.bounds.height,
  })))
  if (!bounds) return []
  const deltaY = (canvasHeight / 2) - (bounds.y + bounds.height / 2)
  return units.flatMap((unit) =>
    moveUnit(unit, unit.bounds.x, unit.bounds.y + deltaY))
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  均匀分布（≥3 时可用）                                       ║
// ╚══════════════════════════════════════════════════════════════╝

/**
 * 水平均匀分布
 *
 * PPTist 的算法：
 * 1. 计算所有元素的最左和最右边界
 * 2. 计算总间距 = (最右 - 最左) - 所有元素宽度之和
 * 3. 间距 = 总间距 / (count - 1)
 * 4. 按 x 排序后依次放置
 */
export function distributeHorizontal(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 3) return []
  const sorted = [...units].sort((a, b) => {
    if (a.bounds.x === b.bounds.x) return a.firstIndex - b.firstIndex
    return a.bounds.x - b.bounds.x
  })

  const totalRange = sorted[sorted.length - 1].bounds.x + sorted[sorted.length - 1].bounds.width - sorted[0].bounds.x
  const totalWidths = sorted.reduce((sum, unit) => sum + unit.bounds.width, 0)
  const gap = (totalRange - totalWidths) / (sorted.length - 1)

  let currentX = sorted[0].bounds.x
  const updates: PositionUpdate[] = []

  for (const unit of sorted) {
    updates.push(...moveUnit(unit, currentX, unit.bounds.y))
    currentX += unit.bounds.width + gap
  }

  return updates
}

/**
 * 垂直均匀分布
 */
export function distributeVertical(elements: PPTElement[]): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 3) return []
  const sorted = [...units].sort((a, b) => {
    if (a.bounds.y === b.bounds.y) return a.firstIndex - b.firstIndex
    return a.bounds.y - b.bounds.y
  })

  const totalRange = sorted[sorted.length - 1].bounds.y + sorted[sorted.length - 1].bounds.height - sorted[0].bounds.y
  const totalHeights = sorted.reduce((sum, unit) => sum + unit.bounds.height, 0)
  const gap = (totalRange - totalHeights) / (sorted.length - 1)

  let currentY = sorted[0].bounds.y
  const updates: PositionUpdate[] = []

  for (const unit of sorted) {
    updates.push(...moveUnit(unit, unit.bounds.x, currentY))
    currentY += unit.bounds.height + gap
  }

  return updates
}

export function getMovableAlignUnitCount(elements: PPTElement[]): number {
  return buildMovableUnits(elements).length
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  对齐类型枚举（方便 UI 渲染）                                ║
// ╚══════════════════════════════════════════════════════════════╝

/**
 * Tidy Up — 将元素排列到均匀网格（类似 Figma 的 Tidy Up）。
 * 算法来自 design-engine，此处同步实现避免异步 import 开销。
 */
export function tidyUp(
  elements: PPTElement[],
  options?: { gapX?: number; gapY?: number },
): PositionUpdate[] {
  const units = buildMovableUnits(elements)
  if (units.length < 2) return []

  const gapX = options?.gapX ?? 20
  const gapY = options?.gapY ?? 20

  const maxWidth = Math.max(...units.map(u => u.bounds.width))
  const maxHeight = Math.max(...units.map(u => u.bounds.height))

  const rowStep = maxHeight + gapY
  const sorted = [...units].sort((a, b) => {
    const rowA = Math.round(a.bounds.y / rowStep)
    const rowB = Math.round(b.bounds.y / rowStep)
    if (rowA !== rowB) return rowA - rowB
    return a.bounds.x - b.bounds.x
  })
  const originX = Math.min(...sorted.map(u => u.bounds.x))
  const originY = Math.min(...sorted.map(u => u.bounds.y))

  const totalAvailWidth = Math.max(...sorted.map(u => u.bounds.x + u.bounds.width)) - originX
  const cols = Math.max(1, Math.round(totalAvailWidth / (maxWidth + gapX)))

  const updates: PositionUpdate[] = []
  sorted.forEach((unit, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const targetX = originX + col * (maxWidth + gapX) + (maxWidth - unit.bounds.width) / 2
    const targetY = originY + row * (maxHeight + gapY) + (maxHeight - unit.bounds.height) / 2
    updates.push(...moveUnit(unit, targetX, targetY))
  })

  return updates
}

export type AlignCommand =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'horizontalCenter'
  | 'verticalCenter'
  | 'distributeH'
  | 'distributeV'
  | 'tidyUp'
  | 'canvasCenter'
  | 'canvasHCenter'
  | 'canvasVCenter'

export function executeAlign(
  command: AlignCommand,
  elements: PPTElement[],
  canvasWidth: number,
  canvasHeight: number,
): PositionUpdate[] {
  switch (command) {
    case 'left': return alignLeft(elements)
    case 'right': return alignRight(elements)
    case 'top': return alignTop(elements)
    case 'bottom': return alignBottom(elements)
    case 'horizontalCenter': return alignHorizontalCenter(elements)
    case 'verticalCenter': return alignVerticalCenter(elements)
    case 'distributeH': return distributeHorizontal(elements)
    case 'distributeV': return distributeVertical(elements)
    case 'tidyUp': return tidyUp(elements)
    case 'canvasCenter': return alignToCanvasCenter(elements, canvasWidth, canvasHeight)
    case 'canvasHCenter': return alignToCanvasHCenter(elements, canvasWidth)
    case 'canvasVCenter': return alignToCanvasVCenter(elements, canvasHeight)
  }
}
