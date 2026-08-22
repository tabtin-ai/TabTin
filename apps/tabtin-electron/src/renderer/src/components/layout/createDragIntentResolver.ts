import type { CanvasTabKey, CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type {
  DropSide,
  DropIntent,
  SqueezeIntent,
  PaneRect,
  PaneDragPayload,
  CreateGroupBlockReason,
  TabDropEvaluation,
} from './canvas-drag-types'
import {
  getEdgeThreshold,
  getNearestSide,
  getDirectionFromOutside,
  isPointInRect,
  isPointInExpandedRect,
  getDistanceToRect,
  getEdgePaneByPosition,
  getEdgePanesBySide,
  getCrossAxisEdge,
  findAdjacentPane,
} from './canvas-drag-geometry'

interface DragIntentDeps {
  getCachedRects: () => {
    paneRects: PaneRect[]
    contentRect: DOMRect | null
    dragRootRect: DOMRect | null
  }
  resolveGroupRect: (groupId: string) => DOMRect | null
  latestState: () => {
    spaceGroups: CanvasLayoutGroup[]
    shouldShowCanvasGroup: boolean
  }
  dragTabKeyRef: { readonly current: CanvasTabKey | null }
  panePayloadRef: { readonly current: PaneDragPayload | null }
  getCreateGroupBlockReason: (draggedTabKey: CanvasTabKey | null) => CreateGroupBlockReason | null
}

export function createDragIntentResolver(deps: DragIntentDeps) {
  const { getCachedRects, resolveGroupRect, latestState, dragTabKeyRef, panePayloadRef, getCreateGroupBlockReason } = deps

  const resolveSqueezeIntent = (x: number, y: number): SqueezeIntent | null => {
    const { spaceGroups: groups, shouldShowCanvasGroup: showCanvas } = latestState()
    const cached = getCachedRects()
    const paneRects = cached.paneRects
    const contentRect = cached.contentRect
    const dragRootRect = cached.dragRootRect
    if (!contentRect || !dragRootRect) return null
    if (!isPointInRect(dragRootRect, x, y)) return null

    const isInsideContent = isPointInRect(contentRect, x, y)

    /**
     * 检查是否需要多 pane 挤压
     * 如果指针靠近 pane 的交界处（0-10% 区域），同时挤压相邻的两个 pane
     */
    const checkMultiPaneSqueeze = (hitPane: PaneRect, side: DropSide): SqueezeIntent | null => {
      const edgePanes = getEdgePanesBySide(paneRects, side)
      if (edgePanes.length <= 1) {
        return { kind: 'pane', paneId: hitPane.paneId, side }
      }

      const crossAxisEdge = getCrossAxisEdge(hitPane.rect, side, x, y)
      if (!crossAxisEdge) {
        return { kind: 'pane', paneId: hitPane.paneId, side }
      }

      const adjacentPane = findAdjacentPane(hitPane, edgePanes, crossAxisEdge)
      if (!adjacentPane) {
        return { kind: 'pane', paneId: hitPane.paneId, side }
      }

      return {
        kind: 'multi-pane',
        paneIds: [hitPane.paneId, adjacentPane.paneId],
        side
      }
    }

    if (showCanvas && paneRects.length > 0) {
      if (isInsideContent) {
        let paneHit: PaneRect | null = null
        let bestDistance = Infinity
        paneRects.forEach(item => {
          const threshold = getEdgeThreshold(item.rect)
          if (!isPointInExpandedRect(item.rect, x, y, threshold)) return
          const distance = getDistanceToRect(item.rect, x, y)
          if (distance < bestDistance) {
            bestDistance = distance
            paneHit = item
          }
        })
        if (!paneHit) return null
        const hit = paneHit as PaneRect
        const group = groups.find(item => item.id === hit.groupId)
        const pane = group?.panes.find(item => item.id === hit.paneId)
        if (!group || !pane) return null
        const { side, distance } = getNearestSide(hit.rect, x, y)
        const threshold = getEdgeThreshold(hit.rect)
        if (distance > threshold) return null

        return checkMultiPaneSqueeze(hit, side)
      }

      const forcedSide = getDirectionFromOutside(contentRect, x, y)
      const edgePane = getEdgePaneByPosition(paneRects, forcedSide, x, y)
      if (!edgePane) return null

      return checkMultiPaneSqueeze(edgePane, forcedSide)
    }

    if (!showCanvas) {
      const side = getDirectionFromOutside(contentRect, x, y)
      return { kind: 'content', side }
    }

    return null
  }

  const resolveTabEvaluation = (
    x: number,
    y: number,
    options?: { ignoreCreateGroupEligibility?: boolean },
  ): TabDropEvaluation => {
    const { spaceGroups: groups, shouldShowCanvasGroup: showCanvas } = latestState()
    const cached = getCachedRects()
    const paneRects = cached.paneRects
    const contentRect = cached.contentRect
    const dragRootRect = cached.dragRootRect

    if (!contentRect || !dragRootRect) {
      return { intent: null, blockReason: 'unavailable' }
    }
    if (!isPointInRect(dragRootRect, x, y)) {
      return { intent: null, blockReason: 'outside' }
    }

    const isInsideContent = isPointInRect(contentRect, x, y)

    if (showCanvas && paneRects.length > 0) {
      let paneHit: PaneRect | null = null
      let forcedSide: DropSide | null = null

      if (isInsideContent) {
        let bestDistance = Infinity
        paneRects.forEach(item => {
          const threshold = getEdgeThreshold(item.rect)
          if (!isPointInExpandedRect(item.rect, x, y, threshold)) return
          const distance = getDistanceToRect(item.rect, x, y)
          if (distance < bestDistance) {
            bestDistance = distance
            paneHit = item
          }
        })
      } else {
        forcedSide = getDirectionFromOutside(contentRect, x, y)
        paneHit = getEdgePaneByPosition(paneRects, forcedSide, x, y)
      }

      if (paneHit) {
        const hit = paneHit as PaneRect
        const group = groups.find(item => item.id === hit.groupId)
        const pane = group?.panes.find(item => item.id === hit.paneId)
        if (!group || !pane) {
          return { intent: null, blockReason: 'unavailable' }
        }

        const draggedTabKey = dragTabKeyRef.current
        if (
          draggedTabKey &&
          group.panes.some(item => item.content?.tabKey === draggedTabKey)
        ) {
          return { intent: null, blockReason: 'duplicate' }
        }

        const side = forcedSide ?? getNearestSide(hit.rect, x, y).side
        const distance = isInsideContent ? getNearestSide(hit.rect, x, y).distance : 0

        if (!pane.content) {
          return {
            intent: {
              kind: 'assign' as const,
              groupId: group.id,
              paneId: pane.id,
              rect: hit.rect,
            },
            blockReason: null,
          }
        }
        if (group.panes.length >= 3) {
          return { intent: null, blockReason: 'group-full' }
        }
        const threshold = getEdgeThreshold(hit.rect)
        if (distance <= threshold) {
          return {
            intent: {
              kind: 'split' as const,
              groupId: group.id,
              paneId: pane.id,
              side,
              rect: hit.rect,
            },
            blockReason: null,
          }
        }
        return { intent: null, blockReason: 'move-to-edge' }
      }
      return { intent: null, blockReason: 'move-to-edge' }
    }

    if (!showCanvas) {
      const side = getDirectionFromOutside(contentRect, x, y)
      const intent = {
        kind: 'create-group' as const,
        side,
        rect: contentRect
      }
      if (options?.ignoreCreateGroupEligibility) {
        return { intent, blockReason: null }
      }
      const blockReason = getCreateGroupBlockReason(dragTabKeyRef.current)
      if (blockReason) return { intent: null, blockReason }
      return { intent, blockReason: null }
    }

    return { intent: null, blockReason: 'unavailable' }
  }

  const resolveTabIntent = (
    x: number,
    y: number,
    options?: { ignoreCreateGroupEligibility?: boolean },
  ): DropIntent | null => {
    return resolveTabEvaluation(x, y, options).intent
  }

  const resolvePaneIntent = (x: number, y: number): DropIntent | null => {
    const payload = panePayloadRef.current
    if (!payload) return null

    const groupRect = resolveGroupRect(payload.groupId)
    if (groupRect) {
      const outerThreshold = getEdgeThreshold(groupRect)
      if (isPointInExpandedRect(groupRect, x, y, outerThreshold)) {
      const { side, distance } = getNearestSide(groupRect, x, y)
        if (distance <= outerThreshold) {
          return {
            kind: 'dock' as const,
            groupId: payload.groupId,
            paneId: payload.paneId,
            side,
            rect: groupRect
          }
        }
      }
    }

    const cached = getCachedRects()
    const paneRects = cached.paneRects
    let paneHit: PaneRect | null = null
    let bestDistance = Infinity
    paneRects.forEach(item => {
      const threshold = getEdgeThreshold(item.rect)
      if (!isPointInExpandedRect(item.rect, x, y, threshold)) return
      const distance = getDistanceToRect(item.rect, x, y)
      if (distance < bestDistance) {
        bestDistance = distance
        paneHit = item
      }
    })
    if (!paneHit) return null
    const hit = paneHit as PaneRect
    if (hit.paneId === payload.paneId) return null
    const { side, distance } = getNearestSide(hit.rect, x, y)
    if (distance > getEdgeThreshold(hit.rect)) return null
    return {
      kind: 'move' as const,
      groupId: hit.groupId,
      sourcePaneId: payload.paneId,
      targetPaneId: hit.paneId,
      side,
      rect: hit.rect
    }
  }

  return { resolveSqueezeIntent, resolveTabEvaluation, resolveTabIntent, resolvePaneIntent }
}
