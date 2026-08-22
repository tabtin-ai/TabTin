import React, { useCallback, useRef, useEffect, useState } from 'react'
import { useSlideStore } from '../store/slide'
import { useSelectionBox } from '../hooks/useSelectionBox'
import SlideRenderer from './SlideRenderer'
import MoveableWrapper from './interactive/MoveableWrapper'
import ContextMenu, { INITIAL_CTX } from './ContextMenu'
import type { ContextMenuState } from './ContextMenu'
import { shouldAppendSelection } from '../utils/modifier'
import { calculateFitZoom, ptToPx } from '../utils/geometry'
import { keymapManager, KeyboardPriority } from '../utils/keymap-manager'
import * as theme from '../theme'
import { useT } from '../i18n'
import { ZoomControls } from './ZoomControls'
import { useImageDrop } from '../hooks/useImageDrop'
import { ZIndex } from '@tabtin/app-shell'
import { SlidePresenceOverlay, type SlideRemotePeer } from './SlidePresenceOverlay'

interface CanvasProps {
  onViewportResize?: (size: { width: number; height: number }) => void
  showZoomControls?: boolean
  onUploadImage?: (file: File) => Promise<string>
  onImageError?: (type: 'validation' | 'upload' | 'load', message: string) => void
  /** CC-014: 远端协作者 Presence 数据 */
  remotePeers?: SlideRemotePeer[]
}

/**
 * 主编辑画布
 *
 * DOM 结构：
 * containerRef（overflow: hidden，事件层）
 *   └── viewportWrapper（居中 + pan）
 *         └── viewport（transform: scale(zoom), transformOrigin: top left）
 *               ├── SlideRenderer（元素内容）
 *               └── MoveableWrapper（操作控件，和元素共享 transform 空间）
 */
const Canvas: React.FC<CanvasProps> = ({
  onViewportResize,
  showZoomControls = true,
  onUploadImage,
  onImageError,
  remotePeers,
}) => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const currentPageIndex = useSlideStore((s) => s.currentPageIndex)
  const zoom = useSlideStore((s) => s.zoom)
  const panX = useSlideStore((s) => s.panX)
  const panY = useSlideStore((s) => s.panY)
  const setZoom = useSlideStore((s) => s.setZoom)
  const setPan = useSlideStore((s) => s.setPan)
  const addPage = useSlideStore((s) => s.addPage)
  const editorConfig = useSlideStore((s) => s.editorConfig)
  const clearSelection = useSlideStore((s) => s.clearSelection)
  const selectElement = useSlideStore((s) => s.selectElement)
  const editingElementId = useSlideStore((s) => s.editingElementId)
  const setEditing = useSlideStore((s) => s.setEditing)

  const containerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const { isDragOver } = useImageDrop(containerRef, { onUploadImage, onError: onImageError })
  const isPanningRef = useRef(false)
  const isSpaceHeldRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0, px: 0, py: 0 })
  const lastFittedPresentationIdRef = useRef<string | null>(null)
  const userZoomedRef = useRef(false)
  /** 空格拖拽模式：'grab' 按住空格待拖、'grabbing' 正在拖拽、null 正常模式 */
  const [grabMode, setGrabMode] = useState<'grab' | 'grabbing' | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(INITIAL_CTX)

  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const enterGrabMode = useCallback(() => setGrabMode('grab'), [])
  const exitGrabMode = useCallback(() => setGrabMode(null), [])

  const page = presentation?.pages[currentPageIndex]
  const canvasWidth = presentation?.canvasWidth || 1280
  const canvasHeight = presentation?.canvasHeight || 720

  const wrapperWidth = canvasWidth * zoom
  const wrapperHeight = canvasHeight * zoom
  const gridSize = Number.isFinite(editorConfig.gridSize) && editorConfig.gridSize > 0
    ? Math.round(editorConfig.gridSize)
    : 10

  const fitToContainer = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    setZoom(calculateFitZoom(rect.width, rect.height, canvasWidth, canvasHeight))
    setPan(0, 0)
  }, [canvasWidth, canvasHeight, setZoom, setPan])

  useEffect(() => {
    if (!presentation) return
    const pid = presentation.id
    if (pid && pid === lastFittedPresentationIdRef.current) return
    requestAnimationFrame(() => {
      fitToContainer()
      lastFittedPresentationIdRef.current = pid
    })
  }, [presentation, fitToContainer])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const emitViewportResize = () => {
      if (!onViewportResize) return
      const rect = el.getBoundingClientRect()
      onViewportResize({ width: rect.width, height: rect.height })
    }

    emitViewportResize()

    const observer = new ResizeObserver(() => {
      emitViewportResize()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onViewportResize])

  // 原生 wheel 事件（Ctrl/Cmd + 滚轮缩放）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        userZoomedRef.current = true
        const raw = -e.deltaY
        const normalized =
          Math.sign(raw) * Math.min(Math.abs(raw) * 0.001, 0.05)
        setZoom(zoomRef.current + normalized)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoom])

  // 键盘快捷键：仅处理空格拖拽画布。
  // 图层 / 删除 / 复制等全部由 useKeyboard 统一处理，此处不再重复注册。
  // 通过 KeymapManager 以 CANVAS 优先级注册，比 GLOBAL 低。
  useEffect(() => {
    const unregister = keymapManager.register(KeyboardPriority.CANVAS, (e) => {
      if (e.code === 'Space' && !e.repeat && !isSpaceHeldRef.current) {
        const active = document.activeElement as HTMLElement | null
        const activeTag = active?.tagName
        if (active && (active.isContentEditable || activeTag === 'INPUT' || activeTag === 'TEXTAREA')) return
        e.preventDefault()
        isSpaceHeldRef.current = true
        enterGrabMode()
        return true
      }
    })
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpaceHeldRef.current = false
        isPanningRef.current = false
        exitGrabMode()
      }
    }
    window.addEventListener('keyup', onKeyUp)
    return () => {
      unregister()
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const { selectionRect, startSelection, updateSelection, endSelection } =
    useSelectionBox(zoom, panX, panY)

  // ── 遮罩层平移事件（空格拖拽 / 中键拖拽） ──
  const handlePanStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      isPanningRef.current = true
      panStartRef.current = { x: e.clientX, y: e.clientY, px: panX, py: panY }
      setGrabMode('grabbing')
    },
    [panX, panY],
  )

  const handlePanMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanningRef.current) return
      setPan(
        panStartRef.current.px + (e.clientX - panStartRef.current.x),
        panStartRef.current.py + (e.clientY - panStartRef.current.y),
      )
    },
    [setPan],
  )

  const handlePanEnd = useCallback(() => {
    if (!isPanningRef.current) return
    isPanningRef.current = false
    setGrabMode(isSpaceHeldRef.current ? 'grab' : null)
  }, [])

  // ── 普通模式容器事件 ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 中键拖拽 → 平移画布（不经过遮罩层）
      if (e.button === 1) {
        e.preventDefault()
        isPanningRef.current = true
        panStartRef.current = { x: e.clientX, y: e.clientY, px: panX, py: panY }
      } else if (e.button === 0) {
        const target = e.target as HTMLElement
        // 画布内 UI（缩放控件、右键菜单等）不参与空白点击/框选逻辑
        if (target.closest('[data-canvas-ui="true"]')) return

        if (
          !target.closest('[data-element-id]') &&
          !target.closest('.moveable-control-box')
        ) {
          // 非追加模式下，点击任意空白区域（含幻灯片外工作区）都应清空选择
          if (!shouldAppendSelection(e.nativeEvent)) {
            clearSelection()
            setEditing(null)
          }
          startSelection(e, viewportRef.current)
        }
      }
    },
    [panX, panY, clearSelection, setEditing, startSelection],
  )

  const handleMouseDownCapture = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !page) return
      const target = e.target as HTMLElement
      if (target.closest('[data-canvas-ui="true"]') || target.closest('.moveable-control-box')) return
      const viewport = viewportRef.current
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()
      const canvasX = (e.clientX - rect.left) / zoom
      const canvasY = (e.clientY - rect.top) / zoom

      const distanceToSegment = (
        px: number,
        py: number,
        ax: number,
        ay: number,
        bx: number,
        by: number,
      ): number => {
        const dx = bx - ax
        const dy = by - ay
        const lenSq = dx * dx + dy * dy
        if (lenSq <= 1e-9) return Math.hypot(px - ax, py - ay)
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
      }

      let best: { id: string; distance: number } | null = null
      for (const el of page.elements) {
        if (el.type !== 'line' || el.visible === false) continue
        const points: Array<[number, number]> = [
          [el.x + el.start[0], el.y + el.start[1]],
        ]
        if (el.broken) points.push([el.x + el.broken[0], el.y + el.broken[1]])
        if (el.broken2) {
          points.push([el.x + el.broken2[0], el.y + el.broken2[1]])
          points.push([
            el.x + (el.start[0] + el.end[0]) / 2,
            el.y + (el.broken2[1] + el.end[1]) / 2,
          ])
        }
        if (el.curve) points.push([el.x + el.curve[0], el.y + el.curve[1]])
        if (el.cubic) {
          points.push([el.x + el.cubic[0][0], el.y + el.cubic[0][1]])
          points.push([el.x + el.cubic[1][0], el.y + el.cubic[1][1]])
        }
        points.push([el.x + el.end[0], el.y + el.end[1]])

        let distance = Number.POSITIVE_INFINITY
        for (let i = 0; i < points.length - 1; i += 1) {
          const a = points[i]
          const b = points[i + 1]
          if (!a || !b) continue
          distance = Math.min(distance, distanceToSegment(canvasX, canvasY, a[0], a[1], b[0], b[1]))
        }

        const threshold = Math.max(6 / zoom, ptToPx(el.lineWidth || 2) / 2 + 4 / zoom)
        if (distance <= threshold && (!best || distance < best.distance)) {
          best = { id: el.id, distance }
        }
      }

      if (!best) return
      e.preventDefault()
      e.stopPropagation()
      selectElement(best.id, shouldAppendSelection(e.nativeEvent))
    },
    [page, selectElement, viewportRef, zoom],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanningRef.current) {
        setPan(
          panStartRef.current.px + (e.clientX - panStartRef.current.x),
          panStartRef.current.py + (e.clientY - panStartRef.current.y),
        )
      }
      updateSelection(e)
    },
    [setPan, updateSelection],
  )

  const handleMouseUp = useCallback(() => {
    if (isPanningRef.current) {
      isPanningRef.current = false
    }
    endSelection()
  }, [endSelection])

  const handleStartEdit = useCallback(
    (id: string) => setEditing(id),
    [setEditing],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // 如果右键点击的是某个元素且不在选区中，先选中它
    const target = e.target as HTMLElement
    const elWrap = target.closest?.('[data-element-id]') as HTMLElement | null
    if (elWrap) {
      const id = elWrap.getAttribute('data-element-id')
      if (id) {
        const store = useSlideStore.getState()
        if (!store.selectedElementIds.includes(id)) {
          store.selectElement(id)
        }
      }
    }
    setCtxMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [])

  const closeCtxMenu = useCallback(() => setCtxMenu(INITIAL_CTX), [])

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        background: theme.bgWorkspace,
      }}
      onMouseDownCapture={page ? handleMouseDownCapture : undefined}
      onMouseDown={page ? handleMouseDown : undefined}
      onMouseMove={page ? handleMouseMove : undefined}
      onMouseUp={page ? handleMouseUp : undefined}
      onMouseLeave={page ? handleMouseUp : undefined}
      onContextMenu={page ? handleContextMenu : undefined}
    >
      {!page ? (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: theme.textTertiary,
            fontSize: 14,
          }}
        >
          <span>{translate('canvas.noData')}</span>
          <button
            onClick={() => addPage(-1)}
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusMd,
              background: theme.bgSurface,
              color: theme.textSecondary,
              fontSize: 12,
              padding: '6px 10px',
              cursor: 'pointer',
            }}
          >
            {translate('page.addFirst')}
          </button>
        </div>
      ) : (
        <>
          {/* viewport-wrapper：居中 + pan */}
          <div
            style={{
              position: 'absolute',
              width: wrapperWidth,
              height: wrapperHeight,
              left: '50%',
              top: '50%',
              marginLeft: -wrapperWidth / 2 + panX,
              marginTop: -wrapperHeight / 2 + panY,
            }}
          >
            {/* viewport：transform: scale(zoom) */}
            <div
              ref={viewportRef}
              style={{
                position: 'relative',
                width: canvasWidth,
                height: canvasHeight,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
            >
              <SlideRenderer
                page={page}
                theme={presentation?.theme}
                canvasWidth={canvasWidth}
                canvasHeight={canvasHeight}
                showGrid={editorConfig.showGrid}
                gridSize={gridSize}
                editingElementId={editingElementId}
                onStartEdit={handleStartEdit}
              />

              {/* 远端协作者选区 overlay（与元素共享 transform 空间） */}
              {remotePeers && remotePeers.length > 0 && page && (
                <SlidePresenceOverlay
                  peers={remotePeers}
                  currentPageId={page.id}
                  elements={page.elements ?? []}
                />
              )}

              {/* Moveable 在 viewport 内部 — 和元素共享同一 transform 空间 */}
              <MoveableWrapper
                zoom={zoom}
                viewportRef={viewportRef}
                containerRef={containerRef}
              />
            </div>
          </div>

          {/* 空格拖拽遮罩：覆盖整个画布区域拦截所有鼠标事件，阻止 MoveableWrapper 拖拽元素 */}
          {grabMode && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: ZIndex.global,
                cursor: grabMode === 'grabbing' ? 'grabbing' : 'grab',
              }}
              onMouseDown={handlePanStart}
              onMouseMove={handlePanMove}
              onMouseUp={handlePanEnd}
              onMouseLeave={handlePanEnd}
            />
          )}

          {/* 框选矩形 */}
          {selectionRect && (
            <div
              style={{
                position: 'fixed',
                left: selectionRect.x,
                top: selectionRect.y,
                width: selectionRect.width,
                height: selectionRect.height,
                border: `1px solid ${theme.accentMedium}`,
                background: theme.accentBg,
                pointerEvents: 'none',
                zIndex: ZIndex.global,
              }}
            />
          )}

          {/* 图片拖放 overlay */}
          {isDragOver && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: ZIndex.global,
                background: 'rgba(59, 130, 246, 0.08)',
                border: '2px dashed rgba(59, 130, 246, 0.4)',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <span style={{
                fontSize: 14,
                color: 'rgba(59, 130, 246, 0.8)',
                fontWeight: 500,
                background: 'rgba(255,255,255,0.9)',
                padding: '8px 16px',
                borderRadius: 6,
              }}>
                {translate('canvas.dropImage')}
              </span>
            </div>
          )}

          {/* 缩放控件 */}
          {showZoomControls && (
            <ZoomControls
              zoom={zoom}
              onZoomChange={setZoom}
              onFit={fitToContainer}
              t={translate}
            />
          )}

          {/* 右键菜单 */}
          <ContextMenu state={ctxMenu} onClose={closeCtxMenu} />
        </>
      )}
    </div>
  )
}

export default Canvas
