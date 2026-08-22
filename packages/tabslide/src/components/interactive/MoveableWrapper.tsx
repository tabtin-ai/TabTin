import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import Moveable from 'react-moveable'
import type {
  OnDrag, OnDragEnd, OnDragGroup, OnDragGroupEnd,
  OnResize, OnResizeEnd, OnResizeGroup, OnResizeGroupEnd,
  OnRotate, OnRotateEnd, OnRotateGroup, OnRotateGroupEnd,
  OnClick,
} from 'react-moveable'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import { buildFlipTransform } from '../../utils/geometry'
import { buildLineResizeUpdates } from '../../utils/line-geometry'
import { useT } from '../../i18n'
import { ZIndex } from '@tabtin/app-shell'
import type { PPTElement } from '../../types/slides'

interface MoveableWrapperProps {
  zoom: number
  viewportRef: React.RefObject<HTMLDivElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
}

/**
 * MoveableWrapper — react-moveable 集成
 *
 * 渲染在 viewport 内部（和元素共享 transform: scale 空间）。
 * Moveable 自动检测 viewport 的 CSS transform 并正确处理坐标转换。
 * zoom={1/zoom} 让控件（手柄、边框）在屏幕上保持固定视觉大小。
 *
 * 支持：
 * - 拖拽、缩放、旋转
 * - 智能对齐参考线（Snappable — 吸附到其他元素的边/中心）
 * - 网格吸附（snapGridWidth/Height）
 * - 画布边界吸附（horizontalGuidelines/verticalGuidelines）
 */
const MoveableWrapper: React.FC<MoveableWrapperProps> = ({
  zoom,
  viewportRef,
  containerRef,
}) => {
  const translate = useT()
  const selectedIds = useSlideStore((s) => s.selectedElementIds)
  const updateElement = useSlideStore((s) => s.updateElement)
  const updateElements = useSlideStore((s) => s.updateElements)
  const isEditing = useSlideStore((s) => s.isEditing)
  const setEditing = useSlideStore((s) => s.setEditing)
  const presentation = useSlideStore((s) => s.presentation)
  const currentPageIndex = useSlideStore((s) => s.currentPageIndex)
  const editorConfig = useSlideStore((s) => s.editorConfig)

  const moveableRef = useRef<Moveable>(null)
  const [targets, setTargets] = useState<HTMLElement[]>([])

  const canvasWidth = presentation?.canvasWidth || 1280
  const canvasHeight = presentation?.canvasHeight || 720
  const snapEnabled = editorConfig.snapToGrid || editorConfig.snapToGuides
  const rawGridSize = Number(editorConfig.gridSize)
  const gridSize = Number.isFinite(rawGridSize) && rawGridSize > 0 ? rawGridSize : 10
  const rawSnapThreshold = Number(editorConfig.snapThreshold)
  const snapThreshold = Number.isFinite(rawSnapThreshold) && rawSnapThreshold >= 0
    ? rawSnapThreshold
    : 5

  const currentPageElements = presentation?.pages[currentPageIndex]?.elements

  const selectedGeometryKey = useMemo(() => {
    if (!currentPageElements || selectedIds.length === 0) return ''
    const byId = new Map(currentPageElements.map((el) => [el.id, el]))
    return selectedIds
      .map((id) => {
        const el = byId.get(id)
        if (!el) return `${id}:missing`
        const base = `${id}:${el.x}:${el.y}:${el.width}:${el.type === 'line' ? el.height : (el as Exclude<PPTElement, { type: 'line' }>).height}:${'rotate' in el ? (el.rotate || 0) : 0}:${el.flipH ? 1 : 0}:${el.flipV ? 1 : 0}`
        if (el.type !== 'line') return base
        return `${base}:${el.lineWidth}:${el.start[0]}:${el.start[1]}:${el.end[0]}:${el.end[1]}:${el.broken?.[0] ?? ''}:${el.broken?.[1] ?? ''}:${el.broken2?.[0] ?? ''}:${el.broken2?.[1] ?? ''}:${el.curve?.[0] ?? ''}:${el.curve?.[1] ?? ''}:${el.cubic?.[0]?.[0] ?? ''}:${el.cubic?.[0]?.[1] ?? ''}:${el.cubic?.[1]?.[0] ?? ''}:${el.cubic?.[1]?.[1] ?? ''}`
      })
      .join('|')
  }, [currentPageElements, selectedIds])

  const snapCandidatesKey = useMemo(() => {
    if (!currentPageElements) return ''
    return currentPageElements
      .map((el) => `${el.id}:${el.visible === false ? 0 : 1}`)
      .join('|')
  }, [currentPageElements])

  // C5-03: 精确依赖 — 只在锁定状态实际变化时触发 targets 重建，
  // 而非依赖 presentation 整体（任何元素拖拽都会产生新 Immer 引用）
  const currentPageLockedKey = useMemo(() => {
    if (!currentPageElements) return ''
    return currentPageElements
      .filter((e) => e.locked)
      .map((e) => e.id)
      .sort()
      .join(',')
  }, [currentPageElements])

  // 选中变化 → 更新 targets（排除锁定元素，使未锁定元素仍可操作）
  // C2-02: 添加 cancelled 标记 + cancelAnimationFrame 清理，
  // 防止快速切换选中时旧 RAF 回调覆盖最新 state
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || selectedIds.length === 0) {
      setTargets([])
      return
    }
    const lockedSet = new Set(currentPageLockedKey ? currentPageLockedKey.split(',') : [])
    let cancelled = false
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return
      const els = selectedIds
        .filter((id) => !lockedSet.has(id))
        .map((id) => vp.querySelector(`[data-element-id="${id}"]`) as HTMLElement)
        .filter(Boolean)
      setTargets(els)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [selectedIds, viewportRef, currentPageIndex, currentPageLockedKey])

  // 仅在选中元素几何变化（或 zoom / 页面切换）时刷新 Moveable 控件位置
  useEffect(() => {
    moveableRef.current?.updateRect()
  }, [selectedGeometryKey, currentPageIndex, zoom])

  const elementById = useMemo(() => {
    if (!currentPageElements) return new Map<string, PPTElement>()
    return new Map(currentPageElements.map((el) => [el.id, el]))
  }, [currentPageElements])

  const findElement = useCallback(
    (target: HTMLElement | SVGElement | null): PPTElement | null => {
      if (!target) return null
      const el = (target as HTMLElement).closest?.('[data-element-id]') as HTMLElement | null
      const id = el?.getAttribute('data-element-id')
      if (!id) return null
      return elementById.get(id) ?? null
    },
    [elementById],
  )

  // 智能参考线：收集当前页面所有未选中元素作为 snap 目标
  const elementSnapTargets = useMemo(() => {
    if (!editorConfig.snapToGuides) return []
    const vp = viewportRef.current
    if (!vp) return []
    if (!currentPageElements) return []
    const selectedSet = new Set(selectedIds)
    return currentPageElements
      .filter((e) => !selectedSet.has(e.id) && e.visible !== false)
      .map((e) => vp.querySelector(`[data-element-id="${e.id}"]`) as HTMLElement)
      .filter(Boolean)
  }, [snapCandidatesKey, currentPageElements, selectedIds, editorConfig.snapToGuides, viewportRef])

  // 画布边缘 + 中心参考线（仅在启用 guides 时生效）
  const hGuidelines = useMemo(
    () => (editorConfig.snapToGuides ? [0, canvasHeight / 2, canvasHeight] : []),
    [canvasHeight, editorConfig.snapToGuides],
  )
  const vGuidelines = useMemo(
    () => (editorConfig.snapToGuides ? [0, canvasWidth / 2, canvasWidth] : []),
    [canvasWidth, editorConfig.snapToGuides],
  )

  // 计算当前选中元素是否需要保持宽高比
  // 单选：对应元素有 fixedRatio 时锁定比例
  // 多选：所有选中元素都有 fixedRatio 时也锁定比例（与 PowerPoint/Keynote 一致）
  const shouldKeepRatio = useMemo(() => {
    const page = presentation?.pages[currentPageIndex]
    if (!page || selectedIds.length === 0) return false

    const isFixedRatio = (el: PPTElement): boolean => {
      if (el.type === 'image' && el.fixedRatio) return true
      if (el.type === 'shape' && el.fixedRatio) return true
      if (el.type === 'latex' && el.fixedRatio) return true
      return false
    }

    const selectedElements = selectedIds
      .map((id) => page.elements.find((e) => e.id === id))
      .filter(Boolean) as PPTElement[]
    if (selectedElements.length === 0) return false

    return selectedElements.every(isFixedRatio)
  }, [selectedIds, presentation, currentPageIndex])


  // C2-03: 预建 flipPrefixById Map，避免 onRotate/onRotateGroup 每帧调用
  // findElement（含 DOM closest() 遍历），改为 O(1) Map 查找
  const flipPrefixById = useMemo(() => {
    const map = new Map<string, string>()
    if (!currentPageElements) return map
    for (const el of currentPageElements) {
      map.set(el.id, buildFlipTransform(el as { flipH?: boolean; flipV?: boolean }))
    }
    return map
  }, [currentPageElements])

  const hasValueChanged = useCallback((current: unknown, next: unknown): boolean => {
    if (typeof current === 'number' && typeof next === 'number') {
      return Math.abs(current - next) > 0.0005
    }
    if (Array.isArray(current) && Array.isArray(next)) {
      if (current.length !== next.length) return true
      for (let i = 0; i < current.length; i += 1) {
        if (hasValueChanged(current[i], next[i])) return true
      }
      return false
    }
    return current !== next
  }, [])

  const hasElementUpdateChanged = useCallback(
    (element: PPTElement, updates: Partial<PPTElement>): boolean => {
      const record = element as unknown as Record<string, unknown>
      const entries = Object.entries(updates as Record<string, unknown>)
      return entries.some(([key, nextVal]) => hasValueChanged(record[key], nextVal))
    },
    [hasValueChanged],
  )

  const pushHistorySnapshot = useCallback(() => {
    const latestPresentation = useSlideStore.getState().presentation
    if (!latestPresentation) return
    useHistoryStore.getState().pushSnapshot(latestPresentation.pages)
  }, [])

  const lockedCount = useMemo(() => {
    const page = presentation?.pages[currentPageIndex]
    if (!page || selectedIds.length === 0) return 0
    const selectedSet = new Set(selectedIds)
    return page.elements.filter((e) => selectedSet.has(e.id) && e.locked).length
  }, [selectedIds, presentation, currentPageIndex])

  if (isEditing || targets.length === 0) return null

  return (
    <>
    {lockedCount > 0 && targets.length > 0 && (() => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity
      for (const t of targets) {
        const x = parseFloat(t.style.left) || 0
        const y = parseFloat(t.style.top) || 0
        const w = parseFloat(t.style.width) || t.offsetWidth
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x + w > maxX) maxX = x + w
      }
      const centerX = (minX + maxX) / 2
      const indicatorScale = 1 / zoom
      return (
      <div
        style={{
          position: 'absolute',
          top: minY - 28 / zoom,
          left: centerX,
          transform: `translateX(-50%) scale(${indicatorScale})`,
          transformOrigin: 'center bottom',
          background: 'rgba(0,0,0,0.75)',
          color: '#fff',
          fontSize: 11,
          padding: '3px 8px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: ZIndex.floating,
        }}
      >
        {translate('moveable.partialLocked')}
      </div>
      )
    })()}
    <Moveable
      ref={moveableRef}
      target={targets.length === 1 ? targets[0] : targets}

      // 在 viewport 内部 — 不设 rootContainer，让 Moveable 自动检测 transform
      // zoom 补偿：控件在屏幕上保持固定大小（viewport 的 scale 会缩小控件）
      zoom={1 / zoom}

      draggable
      resizable
      rotatable

      // ── 智能对齐参考线 (Snappable) ──
      snappable={snapEnabled}
      snapThreshold={snapThreshold}
      // 吸附到其他元素
      elementGuidelines={elementSnapTargets}
      // 画布边缘/中心参考线
      horizontalGuidelines={hGuidelines}
      verticalGuidelines={vGuidelines}
      // 吸附方向
      snapDirections={{ top: true, bottom: true, left: true, right: true, center: true, middle: true }}
      elementSnapDirections={{ top: true, bottom: true, left: true, right: true, center: true, middle: true }}
      isDisplaySnapDigit={false}
      // 网格吸附
      snapGridWidth={editorConfig.snapToGrid ? gridSize : 0}
      snapGridHeight={editorConfig.snapToGrid ? gridSize : 0}

      // ── 单元素拖拽 ──
      onDrag={(e: OnDrag) => {
        e.target.style.left = `${e.left}px`
        e.target.style.top = `${e.top}px`
      }}
      onDragEnd={(e: OnDragEnd) => {
        if (!e.lastEvent) return
        const pptEl = findElement(e.target)
        if (!pptEl) return
        const updates: Partial<PPTElement> = {
          x: e.lastEvent.left,
          y: e.lastEvent.top,
        }
        if (!hasElementUpdateChanged(pptEl, updates)) return
        pushHistorySnapshot()
        updateElement(pptEl.id, updates)
      }}

      // ── 多选拖拽 ──
      onDragGroup={(e: OnDragGroup) => {
        e.events.forEach((ev) => {
          ev.target.style.left = `${ev.left}px`
          ev.target.style.top = `${ev.top}px`
        })
      }}
      onDragGroupEnd={(e: OnDragGroupEnd) => {
        const batchUpdates: Array<{ id: string; updates: Partial<PPTElement> }> = []
        e.events.forEach((ev) => {
          if (!ev.lastEvent) return
          const pptEl = findElement(ev.target)
          if (!pptEl) return
          const updates: Partial<PPTElement> = {
            x: ev.lastEvent.left,
            y: ev.lastEvent.top,
          }
          if (!hasElementUpdateChanged(pptEl, updates)) return
          batchUpdates.push({ id: pptEl.id, updates })
        })
        if (batchUpdates.length === 0) return
        pushHistorySnapshot()
        updateElements(batchUpdates)
      }}

      // ── 单元素缩放 ──
      onResize={(e: OnResize) => {
        e.target.style.width = `${e.width}px`
        e.target.style.height = `${e.height}px`
        e.target.style.left = `${e.drag.left}px`
        e.target.style.top = `${e.drag.top}px`
      }}
      onResizeEnd={(e: OnResizeEnd) => {
        if (!e.lastEvent) return
        const pptEl = findElement(e.target)
        if (!pptEl) return
        if (pptEl.type === 'line') {
          const updates = buildLineResizeUpdates(
            pptEl,
            e.lastEvent.drag.left,
            e.lastEvent.drag.top,
            e.lastEvent.width,
            e.lastEvent.height,
          )
          if (!hasElementUpdateChanged(pptEl, updates)) return
          pushHistorySnapshot()
          updateElement(
            pptEl.id,
            updates,
          )
          return
        }
        const updates: Partial<PPTElement> = {
          x: e.lastEvent.drag.left,
          y: e.lastEvent.drag.top,
          width: e.lastEvent.width,
          height: e.lastEvent.height,
        }
        if (!hasElementUpdateChanged(pptEl, updates)) return
        pushHistorySnapshot()
        updateElement(pptEl.id, updates)
      }}

      // ── 多选缩放 ──
      onResizeGroup={(e: OnResizeGroup) => {
        e.events.forEach((ev) => {
          ev.target.style.width = `${ev.width}px`
          ev.target.style.height = `${ev.height}px`
          ev.target.style.left = `${ev.drag.left}px`
          ev.target.style.top = `${ev.drag.top}px`
        })
      }}
      onResizeGroupEnd={(e: OnResizeGroupEnd) => {
        const batchUpdates: Array<{ id: string; updates: Partial<PPTElement> }> = []
        e.events.forEach((ev) => {
          if (!ev.lastEvent) return
          const pptEl = findElement(ev.target)
          if (!pptEl) return
          if (pptEl.type === 'line') {
            const updates = buildLineResizeUpdates(
              pptEl,
              ev.lastEvent.drag.left,
              ev.lastEvent.drag.top,
              ev.lastEvent.width,
              ev.lastEvent.height,
            )
            if (!hasElementUpdateChanged(pptEl, updates)) return
            batchUpdates.push({ id: pptEl.id, updates })
            return
          }
          const updates: Partial<PPTElement> = {
            x: ev.lastEvent.drag.left,
            y: ev.lastEvent.drag.top,
            width: ev.lastEvent.width,
            height: ev.lastEvent.height,
          }
          if (!hasElementUpdateChanged(pptEl, updates)) return
          batchUpdates.push({ id: pptEl.id, updates })
        })
        if (batchUpdates.length === 0) return
        pushHistorySnapshot()
        updateElements(batchUpdates)
      }}

      // ── 单元素旋转 ──
      // C2-03: 用 flipPrefixById Map 替代每帧 findElement + DOM closest()
      onRotate={(e: OnRotate) => {
        const id = (e.target as HTMLElement).getAttribute('data-element-id') ?? ''
        const flipPrefix = flipPrefixById.get(id) ?? ''
        if (e.drag) {
          e.target.style.left = `${e.drag.left}px`
          e.target.style.top = `${e.drag.top}px`
        }
        e.target.style.transform = `${flipPrefix}rotate(${e.rotate}deg)`
      }}
      onRotateEnd={(e: OnRotateEnd) => {
        if (!e.lastEvent) return
        const pptEl = findElement(e.target)
        if (!pptEl) return
        const updates: Partial<PPTElement> = {
          rotate: e.lastEvent.rotate,
        } as Partial<PPTElement>
        if (e.lastEvent.drag) {
          updates.x = e.lastEvent.drag.left
          updates.y = e.lastEvent.drag.top
        }
        if (!hasElementUpdateChanged(pptEl, updates)) return
        pushHistorySnapshot()
        updateElement(pptEl.id, updates)
      }}

      // ── 多选旋转 ──
      // C2-03: 用 flipPrefixById Map 替代每帧 findElement + DOM closest()
      onRotateGroup={(e: OnRotateGroup) => {
        e.events.forEach((ev) => {
          const id = (ev.target as HTMLElement).getAttribute('data-element-id') ?? ''
          const flipPrefix = flipPrefixById.get(id) ?? ''
          if (ev.drag) {
            ev.target.style.left = `${ev.drag.left}px`
            ev.target.style.top = `${ev.drag.top}px`
          }
          ev.target.style.transform = `${flipPrefix}rotate(${ev.rotate}deg)`
        })
      }}
      onRotateGroupEnd={(e: OnRotateGroupEnd) => {
        const batchUpdates: Array<{ id: string; updates: Partial<PPTElement> }> = []
        e.events.forEach((ev) => {
          if (!ev.lastEvent) return
          const pptEl = findElement(ev.target)
          if (!pptEl) return
          const updates: Partial<PPTElement> = {
            rotate: ev.lastEvent.rotate,
          } as Partial<PPTElement>
          if (ev.lastEvent.drag) {
            updates.x = ev.lastEvent.drag.left
            updates.y = ev.lastEvent.drag.top
          }
          if (!hasElementUpdateChanged(pptEl, updates)) return
          batchUpdates.push({ id: pptEl.id, updates })
        })
        if (batchUpdates.length === 0) return
        pushHistorySnapshot()
        updateElements(batchUpdates)
      }}

      onClick={(e: OnClick) => {
        if (e.isDouble) {
          const pptEl = findElement(e.inputTarget as HTMLElement)
          if (!pptEl || pptEl.locked) return
          if (pptEl.type === 'text' || pptEl.type === 'table' || pptEl.type === 'image' || (pptEl.type === 'shape' && pptEl.text)) {
            setEditing(pptEl.id)
          }
        }
      }}

      // ── 外观 & 行为 ──
      edge={false}
      keepRatio={shouldKeepRatio}
      throttleDrag={0}
      throttleResize={0}
      throttleRotate={0}
      renderDirections={['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']}
      rotationPosition={'top'}
      origin={false}
      useResizeObserver
    />
    </>
  )
}

export default MoveableWrapper
