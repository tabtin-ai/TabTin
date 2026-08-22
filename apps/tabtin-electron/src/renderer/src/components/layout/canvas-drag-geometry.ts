import type { CanvasTabKey } from '@stores/useCanvasLayoutStore'
import type { DropSide, PaneRect, DropIntent, PaneDragPayload } from './canvas-drag-types'
import { EDGE_ENTER_MIN, EDGE_ENTER_MAX, EDGE_EXIT_PADDING } from './canvas-drag-types'

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const isDebugBoundsEnabled = () =>
  typeof window !== 'undefined' && Boolean(window.__TABTIN_DEBUG_DRAG_BOUNDS__)

export const rectToBox = (rect: DOMRect) => ({
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height
})

export const serializeRect = (rect: DOMRect | null) => (rect ? rectToBox(rect) : null)

export const serializeDropIntent = (intent: DropIntent | null) => {
  if (!intent) return null
  return { ...intent, rect: rectToBox(intent.rect) }
}

export const getEdgeThreshold = (rect: DOMRect) =>
  clamp(Math.min(rect.width, rect.height) / 4, EDGE_ENTER_MIN, EDGE_ENTER_MAX)

export const getExitThreshold = (rect: DOMRect) => getEdgeThreshold(rect) + EDGE_EXIT_PADDING

export const getNearestSide = (rect: DOMRect, x: number, y: number) => {
  const left = Math.abs(x - rect.left)
  const right = Math.abs(rect.right - x)
  const top = Math.abs(y - rect.top)
  const bottom = Math.abs(rect.bottom - y)
  const min = Math.min(left, right, top, bottom)
  const side: DropSide =
    min === left ? 'left' : min === right ? 'right' : min === top ? 'top' : 'bottom'
  return { side, distance: min }
}

/**
 * 获取指针相对于矩形的方向（用于指针在矩形外部的情况）
 * 只考虑主要方向，避免在边缘角落时判断错误
 */
export const getDirectionFromOutside = (rect: DOMRect, x: number, y: number): DropSide => {
  const isInside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

  if (isInside) {
    // 如果在内部，使用标准的最近边判断
    return getNearestSide(rect, x, y).side
  }

  // 在外部时，根据位置确定主要方向
  const centerX = (rect.left + rect.right) / 2
  const centerY = (rect.top + rect.bottom) / 2
  const dx = x - centerX
  const dy = y - centerY

  // 使用绝对值较大的方向作为主方向
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < 0 ? 'left' : 'right'
  } else {
    return dy < 0 ? 'top' : 'bottom'
  }
}

export const isPointInRect = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

export const isPointInExpandedRect = (rect: DOMRect, x: number, y: number, margin: number) =>
  x >= rect.left - margin &&
  x <= rect.right + margin &&
  y >= rect.top - margin &&
  y <= rect.bottom + margin

export const getDistanceToRect = (rect: DOMRect, x: number, y: number) => {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
  return Math.max(dx, dy)
}

/**
 * 根据指针位置选择边缘上最合适的 pane
 * 当同一边缘有多个 pane 时，根据指针的 Y（左右边缘）或 X（上下边缘）坐标选择
 */
export const getEdgePaneByPosition = (paneRects: PaneRect[], side: DropSide, x: number, y: number): PaneRect | null => {
  // 获取该边缘的所有 pane
  const edgePanes = getEdgePanesBySide(paneRects, side)
  if (edgePanes.length === 0) return null
  if (edgePanes.length === 1) return edgePanes[0]

  // 多个 pane 在同一边缘，根据指针位置选择
  for (const pane of edgePanes) {
    if (side === 'left' || side === 'right') {
      // 水平边缘：检查 Y 坐标是否在 pane 范围内
      if (y >= pane.rect.top && y <= pane.rect.bottom) {
        return pane
      }
    } else {
      // 垂直边缘：检查 X 坐标是否在 pane 范围内
      if (x >= pane.rect.left && x <= pane.rect.right) {
        return pane
      }
    }
  }

  // 如果指针不在任何 pane 的范围内，选择最近的
  let bestPane = edgePanes[0]
  let bestDistance = Infinity
  for (const pane of edgePanes) {
    let distance: number
    if (side === 'left' || side === 'right') {
      // 计算 Y 方向的距离
      if (y < pane.rect.top) distance = pane.rect.top - y
      else if (y > pane.rect.bottom) distance = y - pane.rect.bottom
      else distance = 0
    } else {
      // 计算 X 方向的距离
      if (x < pane.rect.left) distance = pane.rect.left - x
      else if (x > pane.rect.right) distance = x - pane.rect.right
      else distance = 0
    }
    if (distance < bestDistance) {
      bestDistance = distance
      bestPane = pane
    }
  }
  return bestPane
}

/**
 * 获取在指定边缘的所有 pane（用于判断多 pane 挤压）
 * 例如：获取所有在右边缘的 pane
 */
export const getEdgePanesBySide = (paneRects: PaneRect[], side: DropSide): PaneRect[] => {
  if (paneRects.length === 0) return []

  // 先找到边缘位置
  let edgeValue = side === 'left' || side === 'top' ? Infinity : -Infinity
  for (const pane of paneRects) {
    if (side === 'left') edgeValue = Math.min(edgeValue, pane.rect.left)
    if (side === 'right') edgeValue = Math.max(edgeValue, pane.rect.right)
    if (side === 'top') edgeValue = Math.min(edgeValue, pane.rect.top)
    if (side === 'bottom') edgeValue = Math.max(edgeValue, pane.rect.bottom)
  }

  // 收集所有在该边缘的 pane（允许小误差）
  const tolerance = 2
  return paneRects.filter(pane => {
    if (side === 'left') return Math.abs(pane.rect.left - edgeValue) <= tolerance
    if (side === 'right') return Math.abs(pane.rect.right - edgeValue) <= tolerance
    if (side === 'top') return Math.abs(pane.rect.top - edgeValue) <= tolerance
    if (side === 'bottom') return Math.abs(pane.rect.bottom - edgeValue) <= tolerance
    return false
  })
}

/**
 * 判断指针是否在 pane 的交界区域（0-10%）
 * 用于决定是否触发多 pane 挤压
 *
 * @param paneRect - pane 的矩形
 * @param side - 挤压方向（决定交叉轴）
 * @param x - 指针 X 坐标
 * @param y - 指针 Y 坐标
 * @returns 'top' | 'bottom' | 'left' | 'right' | null - 靠近哪个交叉边缘，null 表示在中间区域
 */
export const getCrossAxisEdge = (
  paneRect: DOMRect,
  side: DropSide,
  x: number,
  y: number
): 'top' | 'bottom' | 'left' | 'right' | null => {
  const EDGE_RATIO = 0.10 // 10% 区域触发共同挤压

  if (side === 'left' || side === 'right') {
    // 水平挤压时，检查 Y 坐标是否靠近上下边缘
    const height = paneRect.height

    // 将 Y 坐标限制在 pane 的范围内（处理指针在外部的情况）
    const clampedY = Math.max(paneRect.top, Math.min(paneRect.bottom, y))
    const relY = clampedY - paneRect.top

    const topThreshold = height * EDGE_RATIO
    const bottomThreshold = height * (1 - EDGE_RATIO)

    if (relY <= topThreshold) return 'top'
    if (relY >= bottomThreshold) return 'bottom'
    return null
  } else {
    // 垂直挤压时，检查 X 坐标是否靠近左右边缘
    const width = paneRect.width

    // 将 X 坐标限制在 pane 的范围内（处理指针在外部的情况）
    const clampedX = Math.max(paneRect.left, Math.min(paneRect.right, x))
    const relX = clampedX - paneRect.left

    const leftThreshold = width * EDGE_RATIO
    const rightThreshold = width * (1 - EDGE_RATIO)

    if (relX <= leftThreshold) return 'left'
    if (relX >= rightThreshold) return 'right'
    return null
  }
}

/**
 * 查找相邻的 pane（用于多 pane 挤压）
 *
 * @param targetPane - 当前 pane
 * @param edgePanes - 同一边缘的所有 pane
 * @param crossAxisEdge - 交叉轴方向（'top' 表示找上方的相邻 pane）
 * @returns 相邻的 pane，如果没有则返回 null
 */
export const findAdjacentPane = (
  targetPane: PaneRect,
  edgePanes: PaneRect[],
  crossAxisEdge: 'top' | 'bottom' | 'left' | 'right'
): PaneRect | null => {
  const tolerance = 8 // 允许小间隙

  for (const pane of edgePanes) {
    if (pane.paneId === targetPane.paneId) continue

    if (crossAxisEdge === 'top') {
      // 找上方相邻的 pane：它的 bottom 应该接近 targetPane 的 top
      if (Math.abs(pane.rect.bottom - targetPane.rect.top) <= tolerance) {
        return pane
      }
    }
    if (crossAxisEdge === 'bottom') {
      // 找下方相邻的 pane：它的 top 应该接近 targetPane 的 bottom
      if (Math.abs(pane.rect.top - targetPane.rect.bottom) <= tolerance) {
        return pane
      }
    }
    if (crossAxisEdge === 'left') {
      // 找左侧相邻的 pane：它的 right 应该接近 targetPane 的 left
      if (Math.abs(pane.rect.right - targetPane.rect.left) <= tolerance) {
        return pane
      }
    }
    if (crossAxisEdge === 'right') {
      // 找右侧相邻的 pane：它的 left 应该接近 targetPane 的 right
      if (Math.abs(pane.rect.left - targetPane.rect.right) <= tolerance) {
        return pane
      }
    }
  }

  return null
}

export const getDistanceToSide = (rect: DOMRect, x: number, y: number, side: DropSide) => {
  if (side === 'left') return Math.abs(x - rect.left)
  if (side === 'right') return Math.abs(rect.right - x)
  if (side === 'top') return Math.abs(y - rect.top)
  return Math.abs(rect.bottom - y)
}

export const isWithinSideBand = (rect: DOMRect, side: DropSide, x: number, y: number, threshold: number) => {
  if (!isPointInExpandedRect(rect, x, y, threshold)) return false
  return getDistanceToSide(rect, x, y, side) <= threshold
}

export const isSameDropIntent = (a: DropIntent, b: DropIntent) => {
  if (a.kind !== b.kind) return false
  if (a.kind === 'assign' && b.kind === 'assign') {
    return a.groupId === b.groupId && a.paneId === b.paneId
  }
  if (a.kind === 'split' && b.kind === 'split') {
    return a.groupId === b.groupId && a.paneId === b.paneId && a.side === b.side
  }
  if (a.kind === 'move' && b.kind === 'move') {
    return a.groupId === b.groupId && a.sourcePaneId === b.sourcePaneId && a.targetPaneId === b.targetPaneId && a.side === b.side
  }
  if (a.kind === 'dock' && b.kind === 'dock') {
    return a.groupId === b.groupId && a.paneId === b.paneId && a.side === b.side
  }
  if (a.kind === 'create-group' && b.kind === 'create-group') {
    return a.side === b.side
  }
  return false
}

export const isIntentSticky = (intent: DropIntent, x: number, y: number) => {
  const exitThreshold = getExitThreshold(intent.rect)
  if (intent.kind === 'assign') {
    return isPointInExpandedRect(intent.rect, x, y, exitThreshold)
  }
  if (
    intent.kind === 'split' ||
    intent.kind === 'move' ||
    intent.kind === 'dock' ||
    intent.kind === 'create-group'
  ) {
    return isWithinSideBand(intent.rect, intent.side, x, y, exitThreshold)
  }
  return false
}

export const isCanvasTabKey = (tabKey: string): tabKey is CanvasTabKey => {
  const delimiterIndex = tabKey.indexOf(':')
  return delimiterIndex > 0 && delimiterIndex < tabKey.length - 1
}

export { findGroupForTabKey } from '@/stores/canvasLayout/helpers'

/**
 * 从 DOM 元素解析 pane 拖拽 payload
 *
 * ✅ 使用 Element.closest() 支持 SVGElement（如 Lucide 图标）
 */
export const resolvePanePayloadFromDOM = (target: EventTarget | null): PaneDragPayload | null => {
  if (!(target instanceof Element)) return null
  const paneEl = target.closest<HTMLElement>('[data-canvas-pane-id][data-canvas-group-id]')
  if (!paneEl) return null
  const paneId = paneEl.dataset.canvasPaneId
  const groupId = paneEl.dataset.canvasGroupId
  if (!paneId || !groupId) return null
  return { paneId, groupId }
}
