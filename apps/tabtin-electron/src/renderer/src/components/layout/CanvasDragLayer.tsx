import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@utils/cn'
import { useCanvasLayoutStore, type CanvasTabKey } from '@stores/useCanvasLayoutStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  beginCrawlViewMousePassthrough,
  endCrawlViewMousePassthrough,
} from '../../crawlspace/crawl-view-mouse-passthrough-depth'
import { toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import {
  CRAWL_VIEW_LAYOUT_CHANGE_EVENT,
  dispatchCrawlViewLayoutChange,
} from '@/utils/crawl-view-bounds'
import { createLogger } from '@/utils/logger'
import { useScopedEventListener } from '@/hooks/spaceActivity'

import {
  CANVAS_DROP_ACTIVATION_INSET,
  EDGE_SQUEEZE_SIZE,
  type DragType,
  type PaneDragPayload,
  type DropIntent,
  type SqueezeIntent,
  type DebugRect,
  type DebugPoint,
  type CreateGroupBlockReason,
  type TabDropBlockReason,
  type CanvasDragLayerProps,
} from './canvas-drag-types'

import {
  isDebugBoundsEnabled,
  rectToBox,
  serializeRect,
  serializeDropIntent,
  isSameDropIntent,
  isIntentSticky,
  isCanvasTabKey,
  findGroupForTabKey,
  resolvePanePayloadFromDOM,
} from './canvas-drag-geometry'

import {
  DRAG_TYPE_TAB_META,
  DRAG_TYPE_TAB_REORDER,
  DRAG_TYPE_PANE_DRAG,
} from '@/utils/split-coordinator'

import { useCanvasDragRects } from './useCanvasDragRects'
import { createDragIntentResolver } from './createDragIntentResolver'
import { useCanvasSqueezeManager } from './useCanvasSqueezeManager'

const log = createLogger('CanvasDragLayer')

function isInsideCanvasDropZone(rect: DOMRect | null, x: number, y: number): boolean {
  if (!rect) return false
  const inset = CANVAS_DROP_ACTIVATION_INSET
  return (
    x >= rect.left + inset &&
    x <= rect.right - inset &&
    y >= rect.top + inset &&
    y <= rect.bottom - inset
  )
}

function resolveSqueezeIntent(intent: DropIntent | null): SqueezeIntent | null {
  if (!intent || intent.kind === 'assign') return null
  if (intent.kind === 'create-group') {
    return { kind: 'content', side: intent.side }
  }
  if (intent.kind === 'dock') {
    return { kind: 'group', groupId: intent.groupId, side: intent.side }
  }
  if (intent.kind === 'move') {
    return { kind: 'pane', paneId: intent.targetPaneId, side: intent.side }
  }
  return { kind: 'pane', paneId: intent.paneId, side: intent.side }
}

type DropIndicator = {
  type: 'assign' | 'split'
  key: string
  style: React.CSSProperties
}

/**
 * 蓝色预览严格绘制在 DOM 挤压后腾出的固定间隙中。
 * 坐标来自 dragstart 冻结的 rect，不读取动画中的 DOM。
 */
export function getCanvasDropIndicator(intent: DropIntent | null): DropIndicator | null {
  if (!intent) return null

  if (intent.kind === 'assign') {
    const rect = intent.rect
    return {
      type: 'assign',
      key: `assign:${intent.groupId}:${intent.paneId}`,
      style: {
        left: rect.left + 4,
        top: rect.top + 4,
        width: Math.max(0, rect.width - 8),
        height: Math.max(0, rect.height - 8),
      },
    }
  }

  const rect = intent.rect
  const side = intent.side
  const axisSize = side === 'left' || side === 'right' ? rect.width : rect.height
  const squeezeSize = Math.min(EDGE_SQUEEZE_SIZE, axisSize)
  const inset = Math.min(3, squeezeSize / 2)
  const thickness = Math.max(0, squeezeSize - inset * 2)
  const crossWidth = Math.max(0, rect.width - inset * 2)
  const crossHeight = Math.max(0, rect.height - inset * 2)

  let indicatorRect: React.CSSProperties
  switch (side) {
    case 'left':
      indicatorRect = {
        left: rect.left + inset,
        top: rect.top + inset,
        width: thickness,
        height: crossHeight,
      }
      break
    case 'right':
      indicatorRect = {
        left: rect.right - squeezeSize + inset,
        top: rect.top + inset,
        width: thickness,
        height: crossHeight,
      }
      break
    case 'top':
      indicatorRect = {
        left: rect.left + inset,
        top: rect.top + inset,
        width: crossWidth,
        height: thickness,
      }
      break
    case 'bottom':
    default:
      indicatorRect = {
        left: rect.left + inset,
        top: rect.bottom - squeezeSize + inset,
        width: crossWidth,
        height: thickness,
      }
      break
  }

  return {
    type: 'split',
    key: `${intent.kind}:${intent.side}:${
      'paneId' in intent ? intent.paneId : 'content'
    }`,
    style: indicatorRect,
  }
}

export const CanvasDragLayer: React.FC<CanvasDragLayerProps> = ({
  spaceId,
  contentRootRef,
  activeTabKey,
  isHomeActive,
  spaceGroups,
  shouldShowCanvasGroup,
  buildContentFromActiveTab,
  buildContentFromDrag
}) => {
  const { t } = useTranslation('context')
  const assignPaneContent = useCanvasLayoutStore(state => state.assignPaneContent)
  const splitPaneWithContent = useCanvasLayoutStore(state => state.splitPaneWithContent)
  const movePane = useCanvasLayoutStore(state => state.movePane)
  const dockPaneToOuter = useCanvasLayoutStore(state => state.dockPaneToOuter)
  const createGroup = useCanvasLayoutStore(state => state.createGroup)
  const setActiveKey = useSpaceContextTabsStore(state => state.setActiveKey)

  const [dropIntent, setDropIntent] = useState<DropIntent | null>(null)
  const [dropBlockReason, setDropBlockReason] = useState<TabDropBlockReason | null>(null)
  const [debugRects, setDebugRects] = useState<DebugRect[]>([])
  const [debugPoint, setDebugPoint] = useState<DebugPoint | null>(null)
  const debugActiveRef = useRef(false)
  const debugSnapshotRef = useRef<Record<string, unknown> | null>(null)
  const dropIntentRef = useRef<DropIntent | null>(null)
  const dragTypeRef = useRef<DragType | null>(null)
  const dragTabKeyRef = useRef<CanvasTabKey | null>(null)
  const dragMetaRawRef = useRef<string | null>(null)
  const dragPlainTextRef = useRef<string | null>(null)
  const draggingRef = useRef(false)
  const panePayloadRef = useRef<PaneDragPayload | null>(null)

  const latestStateRef = useRef({
    spaceGroups,
    isHomeActive,
    activeTabKey,
    shouldShowCanvasGroup,
    buildContentFromActiveTab,
    buildContentFromDrag
  })

  const emitPaneDragEnd = () => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('canvas-pane-drag-end'))
  }

  const resolveDraggedTabKey = (event: DragEvent): CanvasTabKey | null => {
    if (!event.dataTransfer) return null
    const raw =
      event.dataTransfer.getData(DRAG_TYPE_TAB_REORDER) ||
      event.dataTransfer.getData('text/plain') ||
      dragPlainTextRef.current
    if (!raw || !isCanvasTabKey(raw)) return null
    return raw
  }

  const getDropBlockDescription = (reason: TabDropBlockReason): string => {
    if (reason === 'home') {
      return t('canvas.createGroupBlockedHome')
    }
    if (reason === 'self') {
      return t('canvas.createGroupBlockedSelf')
    }
    if (reason === 'grouped') {
      return t('canvas.createGroupBlockedGrouped')
    }
    if (reason === 'group-full') {
      return t('canvas.dropBlockedGroupFull')
    }
    if (reason === 'duplicate') {
      return t('canvas.dropBlockedDuplicate')
    }
    if (reason === 'move-to-edge') {
      return t('canvas.dropMoveToEdge')
    }
    if (reason === 'outside') return ''
    return t('canvas.createGroupBlockedUnavailable')
  }

  const showDropBlockedToast = (reason: TabDropBlockReason) => {
    if (reason === 'outside') return
    toast({
      title: t('canvas.createGroupBlockedTitle'),
      description: getDropBlockDescription(reason),
    })
  }

  const getCreateGroupBlockReason = (draggedTabKey: CanvasTabKey | null): CreateGroupBlockReason | null => {
    const { activeTabKey: currentActiveKey, isHomeActive: currentHomeActive, spaceGroups: groups } = latestStateRef.current
    if (!currentActiveKey || currentHomeActive) return 'home'
    if (draggedTabKey && currentActiveKey === draggedTabKey) return 'self'
    if (findGroupForTabKey(groups, currentActiveKey)) return 'grouped'
    const baseContent = latestStateRef.current.buildContentFromActiveTab()
    if (!baseContent) return 'unavailable'
    return null
  }

  const syncIgnoreMouseEvents = (enabled: boolean) => {
    if (draggingRef.current === enabled) return
    draggingRef.current = enabled
    if (enabled) {
      beginCrawlViewMousePassthrough()
    } else {
      endCrawlViewMousePassthrough()
    }
  }

  const {
    beginDragRectSession,
    endDragRectSession,
    getCachedRects,
    resolveGroupRect,
    invalidateCache,
  } = useCanvasDragRects(contentRootRef)

  const { updateSqueezeEffect, cleanupSqueeze } = useCanvasSqueezeManager({
    contentRootRef,
    latestActiveTabKey: () => latestStateRef.current.activeTabKey,
    emitLayoutChange: () => dispatchCrawlViewLayoutChange('canvas-drag-squeeze'),
  })

  const resetDragSession = () => {
    dragTypeRef.current = null
    dragTabKeyRef.current = null
    dragMetaRawRef.current = null
    dragPlainTextRef.current = null
    panePayloadRef.current = null
    cleanupSqueeze()
    endDragRectSession()
    setDropIntent(null)
    setDropBlockReason(null)
    setDebugRects([])
    setDebugPoint(null)
    debugActiveRef.current = false
    syncIgnoreMouseEvents(false)
    emitPaneDragEnd()
  }

  const { resolveTabEvaluation, resolvePaneIntent } = createDragIntentResolver({
    getCachedRects,
    resolveGroupRect,
    latestState: () => ({
      spaceGroups: latestStateRef.current.spaceGroups,
      shouldShowCanvasGroup: latestStateRef.current.shouldShowCanvasGroup,
    }),
    dragTabKeyRef,
    panePayloadRef,
    getCreateGroupBlockReason,
  })

  useEffect(() => {
    latestStateRef.current = {
      spaceGroups,
      isHomeActive,
      activeTabKey,
      shouldShowCanvasGroup,
      buildContentFromActiveTab,
      buildContentFromDrag
    }
  }, [activeTabKey, buildContentFromActiveTab, buildContentFromDrag, isHomeActive, spaceGroups, shouldShowCanvasGroup])

  useEffect(() => {
    dropIntentRef.current = dropIntent
  }, [dropIntent])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__TABTIN_DRAG_DEBUG_SNAPSHOT__ = () => debugSnapshotRef.current
      window.__TABTIN_DRAG_DEBUG_PRINT__ = () => {
        const payload = debugSnapshotRef.current
        const text = payload ? JSON.stringify(payload, null, 2) : ''
        console.info('[DragDebug] snapshot:', text)
        window.__TABTIN_DRAG_DEBUG_TEXT__ = text
        return text
      }
      window.__TABTIN_DRAG_DEBUG_COPY__ = async () => {
        const payload = debugSnapshotRef.current
        const text = payload ? JSON.stringify(payload, null, 2) : ''
        window.__TABTIN_DRAG_DEBUG_TEXT__ = text
        try {
          await navigator.clipboard.writeText(text)
          console.info('[DragDebug] snapshot copied to clipboard')
        } catch (error) {
          console.warn('[DragDebug] copy failed', error)
          console.info('[DragDebug] fallback: use __TABTIN_DRAG_DEBUG_TEXT__')
        }
      }
    }
    return () => {
      resetDragSession()
      if (typeof window !== 'undefined') {
        delete window.__TABTIN_DRAG_DEBUG_SNAPSHOT__
        delete window.__TABTIN_DRAG_DEBUG_COPY__
        delete window.__TABTIN_DRAG_DEBUG_PRINT__
        delete window.__TABTIN_DRAG_DEBUG_TEXT__
      }
    }
    // 调试桥只跟随当前前台 Space 的 effect 生命周期；拖拽状态都从 ref 清理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

    const finalizeDrag = () => {
      resetDragSession()
    }

    const clearDropFeedback = () => {
      dropIntentRef.current = null
      updateSqueezeEffect(null)
      setDropIntent(null)
      setDropBlockReason(null)
      setDebugRects([])
      setDebugPoint(null)
      debugActiveRef.current = false
    }

    const handleDragStart = (event: DragEvent) => {
      if (!event.dataTransfer) return
      const types = Array.from(event.dataTransfer.types)
      const isTab = types.includes(DRAG_TYPE_TAB_META)
      const isPane = types.includes(DRAG_TYPE_PANE_DRAG)

      if (!isTab && !isPane) return

      dragTypeRef.current = isPane ? 'pane' : 'tab'
      if (isTab) {
        dragMetaRawRef.current = event.dataTransfer.getData(DRAG_TYPE_TAB_META) || null
        dragPlainTextRef.current =
          event.dataTransfer.getData(DRAG_TYPE_TAB_REORDER) ||
          event.dataTransfer.getData('text/plain') ||
          null
        dragTabKeyRef.current = resolveDraggedTabKey(event)
      } else {
        dragTabKeyRef.current = null
      }
      if (isPane) {
        const payload = resolvePanePayloadFromDOM(event.target)
        if (payload) {
          panePayloadRef.current = payload
        } else {
          // Fallback if DOM resolution fails (unlikely for internal drag)
          try {
            const raw = event.dataTransfer.getData(DRAG_TYPE_PANE_DRAG)
            panePayloadRef.current = raw ? (JSON.parse(raw) as PaneDragPayload) : null
          } catch {
            panePayloadRef.current = null
          }
        }
      }
      syncIgnoreMouseEvents(true)
      beginDragRectSession()
    }

    const handleDragEnd = () => {
      finalizeDrag()
    }

    const handleDragOver = (event: DragEvent) => {
      let currentType = dragTypeRef.current
      if (!currentType) {
        // If we missed dragstart (e.g. external drag?), try to detect type
        if (!event.dataTransfer) return
        const types = Array.from(event.dataTransfer.types)
        const isTab = types.includes(DRAG_TYPE_TAB_META)
        const isPane = types.includes(DRAG_TYPE_PANE_DRAG)
        if (!isTab && !isPane) return
        currentType = isPane ? 'pane' : 'tab'
        dragTypeRef.current = currentType
        if (isTab) {
          dragMetaRawRef.current = event.dataTransfer.getData(DRAG_TYPE_TAB_META) || null
          dragPlainTextRef.current =
            event.dataTransfer.getData(DRAG_TYPE_TAB_REORDER) ||
            event.dataTransfer.getData('text/plain') ||
            null
        }
        syncIgnoreMouseEvents(true)
        beginDragRectSession()
      }
      if (currentType === 'tab' && !dragTabKeyRef.current) {
        const key = resolveDraggedTabKey(event)
        if (key) {
          dragTabKeyRef.current = key
        }
      }

      const x = event.clientX
      const y = event.clientY
      const cachedRects = getCachedRects()
      const contentRect = cachedRects.contentRect

      // 标签条与画布是互斥 drop zone。只有指针真正进入内容根节点后，
      // Canvas 才 preventDefault；标签条区域继续由 useTabReorder 处理。
      if (!isInsideCanvasDropZone(contentRect, x, y)) {
        clearDropFeedback()
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const tabEvaluation = currentType === 'tab'
        ? resolveTabEvaluation(x, y)
        : null
      const rawIntent = tabEvaluation?.intent ?? (
        currentType === 'pane' ? resolvePaneIntent(x, y) : null
      )

      const previousIntent = dropIntentRef.current
      const shouldHoldPrevious = previousIntent ? isIntentSticky(previousIntent, x, y) : false
      const isSame = previousIntent && rawIntent ? isSameDropIntent(previousIntent, rawIntent) : false

      const stableIntent = shouldHoldPrevious && previousIntent && (!rawIntent || !isSame)
        ? previousIntent
        : rawIntent
      const blockReason = stableIntent ? null : tabEvaluation?.blockReason ?? null

      // 调试边界可视化（仅在开启调试开关时）
      const debugEnabled = isDebugBoundsEnabled()
      if (debugEnabled) {
        const debugEntries: DebugRect[] = []
        const addRect = (rect: DOMRect | null, label: string, color: string, dashed = false) => {
          if (!rect) return
          debugEntries.push({
            id: `${label}-${debugEntries.length}`,
            label,
            color,
            rect: rectToBox(rect),
            dashed
          })
        }

        addRect(cachedRects.dragRootRect, 'drag-root', '#22c55e', true)
        addRect(contentRect, 'content-root', '#06b6d4', true)
        addRect(rawIntent?.rect ?? null, `raw:${rawIntent?.kind ?? 'none'}`, '#94a3b8', true)
        addRect(stableIntent?.rect ?? null, `intent:${stableIntent?.kind ?? 'none'}`, '#a855f7', true)

        setDebugRects(debugEntries)
        setDebugPoint({ x, y })
        debugActiveRef.current = true
        const snapshot = {
          time: Date.now(),
          point: { x, y },
          dragRootRect: serializeRect(cachedRects.dragRootRect),
          contentRect: serializeRect(contentRect),
          rawIntent: serializeDropIntent(rawIntent),
          intent: serializeDropIntent(stableIntent),
          blockReason,
          debugRects: debugEntries
        }
        debugSnapshotRef.current = snapshot
        if (typeof window !== 'undefined') {
          window.__TABTIN_DRAG_DEBUG_LAST__ = snapshot
          window.__TABTIN_DRAG_DEBUG_TEXT__ = JSON.stringify(snapshot, null, 2)
        }
      } else if (debugActiveRef.current) {
        setDebugRects([])
        setDebugPoint(null)
        debugActiveRef.current = false
        if (typeof window !== 'undefined') {
          window.__TABTIN_DRAG_DEBUG_TEXT__ = ''
        }
      }

      // 恢复旧版“内容让位”的真实挤压反馈；判定层仍只使用 dragstart 冻结的
      // content / group / pane rect，所以动画中的 DOM 不会反向影响落点或提示位置。
      dropIntentRef.current = stableIntent
      updateSqueezeEffect(resolveSqueezeIntent(stableIntent))
      setDropIntent(stableIntent)
      setDropBlockReason(blockReason)
    }

    const handleDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return
      let currentType = dragTypeRef.current
      if (!currentType) {
        const types = Array.from(event.dataTransfer.types)
        const isTab = types.includes(DRAG_TYPE_TAB_META)
        const isPane = types.includes(DRAG_TYPE_PANE_DRAG)
        if (!isTab && !isPane) return
        currentType = isPane ? 'pane' : 'tab'
        dragTypeRef.current = currentType
      }

      const contentRect = getCachedRects().contentRect
      if (!isInsideCanvasDropZone(contentRect, event.clientX, event.clientY)) {
        // Canvas 之外不拦截：顶部标签条继续完成排序。
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const tabEvaluation = currentType === 'tab'
        ? resolveTabEvaluation(event.clientX, event.clientY)
        : null
      const intent = dropIntentRef.current ?? tabEvaluation?.intent ?? (
        currentType === 'pane'
          ? resolvePaneIntent(event.clientX, event.clientY)
          : null
      )

      if (!intent) {
        const reason = tabEvaluation?.blockReason ?? 'unavailable'
        if (currentType === 'tab') {
          showDropBlockedToast(reason)
          log.warn('drop rejected before mutation', {
            spaceId,
            reason,
            draggedTabKey: dragTabKeyRef.current,
          })
        }
        finalizeDrag()
        return
      }

      if (currentType === 'tab') {
        const tabKey =
          event.dataTransfer.getData(DRAG_TYPE_TAB_REORDER) ||
          event.dataTransfer.getData('text/plain') ||
          dragPlainTextRef.current
        const metaRaw =
          event.dataTransfer.getData(DRAG_TYPE_TAB_META) ||
          dragMetaRawRef.current
        if (!tabKey || !metaRaw || !isCanvasTabKey(tabKey)) {
          showDropBlockedToast('unavailable')
          log.warn('drop rejected: missing cached tab payload', {
            spaceId,
            hasTabKey: Boolean(tabKey),
            hasMeta: Boolean(metaRaw),
          })
          finalizeDrag()
          return
        }
        const draggedTabKey = (resolveDraggedTabKey(event) ?? tabKey) as CanvasTabKey
        const content = latestStateRef.current.buildContentFromDrag(draggedTabKey, metaRaw)
        if (!content) {
          showDropBlockedToast('unavailable')
          log.warn('drop rejected: registry could not build pane content', {
            spaceId,
            draggedTabKey,
          })
          finalizeDrag()
          return
        }
        if (intent.kind === 'assign') {
          const group = latestStateRef.current.spaceGroups.find(item => item.id === intent.groupId)
          const pane = group?.panes.find(item => item.id === intent.paneId)
          if (pane?.content?.tabKey === draggedTabKey) {
            showDropBlockedToast('duplicate')
            finalizeDrag()
            return
          }
        }

        if (intent.kind === 'assign') {
          assignPaneContent(spaceId, intent.groupId, intent.paneId, content)
          setActiveKey(spaceId, draggedTabKey)
        }
        if (intent.kind === 'split') {
          const direction = intent.side === 'top' || intent.side === 'bottom' ? 'vertical' : 'horizontal'
          const didSplit = splitPaneWithContent(
            spaceId,
            intent.groupId,
            intent.paneId,
            direction,
            intent.side,
            content,
          )
          if (!didSplit) {
            showDropBlockedToast('unavailable')
            log.warn('drop mutation rejected by store', {
              spaceId,
              intent: serializeDropIntent(intent),
              draggedTabKey,
            })
            finalizeDrag()
            return
          }
          setActiveKey(spaceId, draggedTabKey)
        }
        if (intent.kind === 'create-group') {
          const blockReason = getCreateGroupBlockReason(draggedTabKey)
          if (blockReason) {
            showDropBlockedToast(blockReason)
            finalizeDrag()
            return
          }
          const { activeTabKey } = latestStateRef.current
          const baseContent = latestStateRef.current.buildContentFromActiveTab()
          if (!activeTabKey || !baseContent) {
            showDropBlockedToast('unavailable')
            finalizeDrag()
            return
          }
          const direction = intent.side === 'top' || intent.side === 'bottom' ? 'vertical' : 'horizontal'
          const group = createGroup(spaceId, activeTabKey, baseContent, direction, intent.side)
          const emptyPane = group.panes.find(pane => pane.content === null)
          if (emptyPane) {
            assignPaneContent(spaceId, group.id, emptyPane.id, content)
            setActiveKey(spaceId, draggedTabKey)
          }
        }
      }

      if (currentType === 'pane') {
        if (intent.kind === 'move') {
          movePane(spaceId, intent.groupId, intent.sourcePaneId, intent.targetPaneId, intent.side)
        }
        if (intent.kind === 'dock') {
          dockPaneToOuter(spaceId, intent.groupId, intent.paneId, intent.side)
        }
      }

      finalizeDrag()
    }

    const handleLayoutChange = () => {
      invalidateCache()
    }

  const windowTarget = typeof window === 'undefined' ? null : window
  useScopedEventListener<DragEvent>(windowTarget, 'dragstart', handleDragStart)
  useScopedEventListener<DragEvent>(windowTarget, 'dragend', handleDragEnd, { capture: true })
  useScopedEventListener<DragEvent>(windowTarget, 'dragover', handleDragOver, {
    capture: true,
    passive: false,
  })
  useScopedEventListener<DragEvent>(windowTarget, 'drop', handleDrop, { capture: true })
  useScopedEventListener(windowTarget, CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)

  const getIntentFeedbackText = (intent: DropIntent): string => {
    if (intent.kind === 'assign') return t('canvas.dropAssignHint')
    const direction = t(`canvas.direction.${intent.side}`)
    if (intent.kind === 'create-group') {
      return t('canvas.dropCreateHint', { direction })
    }
    if (intent.kind === 'dock') {
      return t('canvas.dropDockHint', { direction })
    }
    if (intent.kind === 'move') {
      return t('canvas.dropMoveHint', { direction })
    }
    return t('canvas.dropSplitHint', { direction })
  }

  // 预览基于 dragstart 时冻结的 rect 直接计算，不依赖任何被变形后的内容 DOM。
  const indicatorStyle = useMemo(() => getCanvasDropIndicator(dropIntent), [dropIntent])

  const feedbackRootRect = dropIntent?.rect ?? (
    dropBlockReason ? getCachedRects().contentRect : null
  )
  const feedbackText = dropIntent
    ? getIntentFeedbackText(dropIntent)
    : dropBlockReason
      ? getDropBlockDescription(dropBlockReason)
      : ''
  const hasOverlayContent = Boolean(
    indicatorStyle ||
    dropBlockReason ||
    debugRects.length > 0 ||
    debugPoint,
  )
  if (!hasOverlayContent) return null

  const overlay = (
    <div className="pointer-events-none fixed inset-0 z-modal">
      {indicatorStyle && indicatorStyle.type === 'assign' && (
        <div
          key={indicatorStyle.key}
          data-canvas-drop-indicator="assign"
          className={cn(
            'absolute box-border rounded-lg border-2 border-accent/80 bg-accent/10 shadow-sm',
            'animate-in fade-in zoom-in-95 duration-100',
          )}
          style={indicatorStyle.style}
        />
      )}
      {indicatorStyle && indicatorStyle.type === 'split' && (
        <div
          key={indicatorStyle.key}
          data-canvas-drop-indicator="split"
          className={cn(
            'absolute box-border rounded-md border border-accent/75 bg-accent/25 shadow-sm',
            'animate-in fade-in duration-150',
          )}
          style={indicatorStyle.style}
        />
      )}
      {dropBlockReason === 'move-to-edge' && feedbackRootRect && (
        <div
          className="absolute rounded-xl border-2 border-dashed border-accent/45"
          style={{
            left: feedbackRootRect.left + 12,
            top: feedbackRootRect.top + 12,
            width: Math.max(0, feedbackRootRect.width - 24),
            height: Math.max(0, feedbackRootRect.height - 24),
          }}
        />
      )}
      {feedbackText && feedbackRootRect && (
        <div
          className={cn(
            'absolute -translate-x-1/2 rounded-full border px-3 py-1.5',
            'text-caption font-medium shadow-lg backdrop-blur-md',
            dropBlockReason && dropBlockReason !== 'move-to-edge'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-accent/40 bg-background/90 text-foreground',
          )}
          style={{
            left: feedbackRootRect.left + feedbackRootRect.width / 2,
            top: feedbackRootRect.top + 16,
          }}
        >
          {feedbackText}
        </div>
      )}
      {debugRects.map(item => (
        <div
          key={item.id}
          className="absolute"
          style={{
            left: item.rect.left,
            top: item.rect.top,
            width: item.rect.width,
            height: item.rect.height,
            border: `1px ${item.dashed ? 'dashed' : 'solid'} ${item.color}`,
            backgroundColor: `${item.color}22`,
            boxSizing: 'border-box'
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 2,
              top: 2,
              fontSize: 10,
              lineHeight: '12px',
              color: item.color,
              background: 'rgba(0,0,0,0.55)',
              padding: '1px 4px',
              borderRadius: 2
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
      {debugPoint && (
        <div
          className="absolute"
          style={{
            left: debugPoint.x - 3,
            top: debugPoint.y - 3,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#f43f5e',
            boxShadow: '0 0 0 1px #ffffff'
          }}
        />
      )}
    </div>
  )

  if (typeof document === 'undefined' || !document.body) {
    return overlay
  }

  return createPortal(overlay, document.body)
}

CanvasDragLayer.displayName = 'CanvasDragLayer'
