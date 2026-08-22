import { useRef, type RefObject } from 'react'
import type { PaneRect } from './canvas-drag-types'

const RECT_CACHE_TTL = 100

/**
 * Canvas 拖拽几何只允许从当前 SpaceContextArea 的内容根节点读取。
 *
 * Workbench 会用 React Activity 保留多个 Space 的 DOM。此前这里使用
 * document.querySelector，切过 Space 后可能先命中 display:none 的后台节点，
 * 读到 0×0 rect，导致所有标签都无法生成 create-group intent。
 *
 * 拖拽会话内冻结首帧几何：预览层不能因为内容挤压/动画再次测量而漂移。
 */
export function useCanvasDragRects(contentRootRef: RefObject<HTMLElement | null>) {
  const rectCacheRef = useRef<{
    paneRects: PaneRect[]
    groupRects: Map<string, DOMRect>
    contentRect: DOMRect | null
    dragRootRect: DOMRect | null
    timestamp: number
  } | null>(null)
  const dragSessionActiveRef = useRef(false)

  const resolvePaneRects = (): PaneRect[] => {
    const root = contentRootRef.current
    if (!root) return []
    const panes = Array.from(root.querySelectorAll<HTMLElement>('[data-canvas-pane-id]'))
    const result: PaneRect[] = []
    for (const el of panes) {
      const paneId = el.dataset.canvasPaneId
      const groupId = el.dataset.canvasGroupId
      if (!paneId || !groupId) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      result.push({ paneId, groupId, rect })
    }
    return result
  }

  const resolveContentRect = () => {
    const root = contentRootRef.current
    if (!root) return null
    const rect = root.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return rect
  }

  const resolveGroupRects = () => {
    const result = new Map<string, DOMRect>()
    const root = contentRootRef.current
    if (!root) return result
    root
      .querySelectorAll<HTMLElement>('[data-canvas-group-id]:not([data-canvas-pane-id])')
      .forEach(el => {
        const groupId = el.dataset.canvasGroupId
        if (!groupId || result.has(groupId)) return
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        result.set(groupId, rect)
      })
    return result
  }

  const resolveDragRootRect = () => {
    // 排序区与并排区严格分离：Canvas 只接管内容根节点，不再使用包含标签栏的
    // 全局 shell drag root。
    return resolveContentRect()
  }

  const refreshRectCache = () => {
    rectCacheRef.current = {
      paneRects: resolvePaneRects(),
      groupRects: resolveGroupRects(),
      contentRect: resolveContentRect(),
      dragRootRect: resolveDragRootRect(),
      timestamp: Date.now(),
    }
  }

  const getCachedRects = () => {
    const cache = rectCacheRef.current
    if (dragSessionActiveRef.current && cache) return cache
    if (!cache || Date.now() - cache.timestamp > RECT_CACHE_TTL) {
      refreshRectCache()
      return rectCacheRef.current!
    }
    return cache
  }

  const resolveGroupRect = (groupId: string) => {
    const cached = rectCacheRef.current
    if (dragSessionActiveRef.current && cached) {
      return cached.groupRects.get(groupId) ?? null
    }
    const el = contentRootRef.current?.querySelector<HTMLElement>(
      `[data-canvas-group-id="${groupId}"]`,
    )
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return rect
  }

  const getPaneRect = (paneId: string): DOMRect | null => {
    const paneEl = contentRootRef.current?.querySelector<HTMLElement>(
      `[data-canvas-pane-id="${paneId}"]`,
    )
    if (!paneEl) return null
    return paneEl.getBoundingClientRect()
  }

  const getMergedRectForPanes = (paneIds: string[]): DOMRect | null => {
    if (paneIds.length === 0) return null
    let minLeft = Infinity
    let minTop = Infinity
    let maxRight = -Infinity
    let maxBottom = -Infinity
    for (const paneId of paneIds) {
      const rect = getPaneRect(paneId)
      if (!rect) continue
      minLeft = Math.min(minLeft, rect.left)
      minTop = Math.min(minTop, rect.top)
      maxRight = Math.max(maxRight, rect.right)
      maxBottom = Math.max(maxBottom, rect.bottom)
    }
    if (minLeft === Infinity) return null
    return new DOMRect(minLeft, minTop, maxRight - minLeft, maxBottom - minTop)
  }

  const invalidateCache = () => {
    if (dragSessionActiveRef.current) {
      return
    }
    rectCacheRef.current = null
  }

  const beginDragRectSession = () => {
    dragSessionActiveRef.current = true
    refreshRectCache()
  }

  const endDragRectSession = () => {
    dragSessionActiveRef.current = false
    rectCacheRef.current = null
  }

  return {
    beginDragRectSession,
    endDragRectSession,
    getCachedRects,
    resolveGroupRect,
    invalidateCache,
    getPaneRect,
    getMergedRectForPanes,
  }
}
