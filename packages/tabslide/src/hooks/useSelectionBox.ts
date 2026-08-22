import { useState, useCallback, useRef, useEffect } from 'react'
import { useSlideStore } from '../store/slide'
import { shouldAppendSelection } from '../utils/modifier'
import { computeBoxSelectionResult } from '../utils/selection-hit-test'

/**
 * 框选（Rubber-band Selection）
 *
 * 参考 PPTist useMouseSelection.ts，核心逻辑：
 * 1. 在画布空白处 mousedown 开始
 * 2. mousemove 绘制半透明蓝色矩形
 * 3. mouseup 时计算哪些元素与选框相交
 * 4. 支持 Shift 追加选择
 *
 * PPTist 的精华点：
 * - 四象限拖拽（向左上方拖也行）
 * - 最小阈值 5px 避免误触
 * - 锁定元素不被框选
 * - 组合元素需全部成员在框内才选中组合
 */

export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

const MIN_THRESHOLD = 5

export function useSelectionBox(zoom: number, _panX: number, _panY: number) {
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null)
  const selectionRectRef = useRef<SelectionRect | null>(null)
  const pendingRectRef = useRef<SelectionRect | null>(null)
  const rafRef = useRef<number | null>(null)
  const isDraggingRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })
  const appendModeRef = useRef(false)
  /** 画布变换层 DOM 的 bounding rect */
  const canvasRectRef = useRef<DOMRect | null>(null)

  const selectElements = useSlideStore.getState().selectElements

  const flushSelectionRect = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const next = pendingRectRef.current
      pendingRectRef.current = null

      const prev = selectionRectRef.current
      const same =
        (prev === null && next === null)
        || (
          prev !== null
          && next !== null
          && prev.x === next.x
          && prev.y === next.y
          && prev.width === next.width
          && prev.height === next.height
        )
      if (same) return

      selectionRectRef.current = next
      setSelectionRect(next)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  /**
   * 开始框选
   *
   * 只在左键 + 点击画布空白处（非元素）时触发。
   * 由 Canvas 在 onMouseDown 中调用。
   */
  const startSelection = useCallback(
    (e: React.MouseEvent, canvasTransformEl: HTMLElement | null) => {
      if (e.button !== 0) return // 仅左键
      isDraggingRef.current = true
      appendModeRef.current = shouldAppendSelection(e.nativeEvent)

      // 记录画布变换层的位置，用于坐标转换
      if (canvasTransformEl) {
        canvasRectRef.current = canvasTransformEl.getBoundingClientRect()
      }

      startRef.current = { x: e.clientX, y: e.clientY }
      pendingRectRef.current = null
      selectionRectRef.current = null
      setSelectionRect((prev) => (prev ? null : prev))
    },
    [],
  )

  /**
   * 更新框选区域
   */
  const updateSelection = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingRef.current) return

      const dx = e.clientX - startRef.current.x
      const dy = e.clientY - startRef.current.y

      // 最小阈值，避免点击误触为框选
      if (Math.abs(dx) < MIN_THRESHOLD && Math.abs(dy) < MIN_THRESHOLD) return

      // 四象限支持：向任意方向拖拽
      const rect: SelectionRect = {
        x: Math.min(e.clientX, startRef.current.x),
        y: Math.min(e.clientY, startRef.current.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      }

      pendingRectRef.current = rect
      flushSelectionRect()
    },
    [flushSelectionRect],
  )

  /**
   * 结束框选，计算选中元素
   */
  const endSelection = useCallback(() => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    const rect = pendingRectRef.current ?? selectionRectRef.current ?? selectionRect
    pendingRectRef.current = null
    if (!rect || rect.width < MIN_THRESHOLD || rect.height < MIN_THRESHOLD) {
      selectionRectRef.current = null
      setSelectionRect((prev) => (prev ? null : prev))
      return
    }

    const page = useSlideStore.getState().currentPage()
    if (!page) {
      selectionRectRef.current = null
      setSelectionRect((prev) => (prev ? null : prev))
      return
    }

    const canvasRect = canvasRectRef.current
    if (!canvasRect) {
      selectionRectRef.current = null
      setSelectionRect((prev) => (prev ? null : prev))
      return
    }

    // 将屏幕坐标转换为画布坐标
    const selectionInCanvas = {
      x: (rect.x - canvasRect.left) / zoom,
      y: (rect.y - canvasRect.top) / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
    }

    const result = computeBoxSelectionResult({
      elements: page.elements,
      selectionInCanvas,
      prevSelectedIds: useSlideStore.getState().selectedElementIds,
      appendMode: appendModeRef.current,
    })
    if (result.type === 'select') {
      selectElements(result.ids)
    } else if (result.type === 'clear') {
      useSlideStore.getState().clearSelection()
    }

    selectionRectRef.current = null
    setSelectionRect((prev) => (prev ? null : prev))
  }, [selectionRect, zoom, selectElements])

  return {
    selectionRect,
    startSelection,
    updateSelection,
    endSelection,
  }
}
