import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import {
  useCanvasLayoutStore,
  type CanvasLayoutGroup,
  type CanvasLayoutNode,
  type CanvasPane
} from '@stores/useCanvasLayoutStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useTableStore } from '@stores/useTableStore'
import { GripVertical } from 'lucide-react'
import { useCrawlTabStore, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { CanvasPaneContent as CanvasPaneContentRenderer } from './CanvasPaneContent'
import { contextRegistry } from '@components/context-space/registry'
import { useTranslation } from 'react-i18next'
import { LayoutGroup, LayoutPanel, LayoutSeparator } from './resizable-v4'
import { startLayoutResizeTelemetry, trackLayoutTelemetry } from '@utils/layout/telemetry'
import { dispatchCrawlViewLayoutChange } from '@/utils/crawl-view-bounds'
import { DRAG_TYPE_PANE_DRAG } from '@/utils/split-coordinator'

/**
 * 分屏组布局组件
 *
 * 职责：
 * - 渲染分屏布局树（split / leaf）
 * - 提供分隔条拖拽调整大小
 * - 提供 pane 拖拽手柄（实际拖拽逻辑由 CanvasDragLayer 处理）
 *
 * ⚠️ 注意：拖拽目标检测和 drop 处理由 CanvasDragLayer 统一处理
 */

interface CanvasGroupLayoutProps {
  group: CanvasLayoutGroup
  className?: string
  crawlspaceId?: string | null
  isGroupActive?: boolean
}

type PaneMeta = {
  title: string
  subtitle?: string
}

const EMPTY_VIEW_LIST: CrawlspaceViewInfo[] = []

const getPaneMeta = (
  pane: CanvasPane,
  tableNameMap: Map<string, string>,
  viewTitleMap: Map<string, string>,
  t: (key: string) => string
): PaneMeta => {
  if (!pane.content) {
    return {
      title: t('canvas.emptyTitle'),
      subtitle: t('canvas.emptySubtitle')
    }
  }
  const parsed = contextRegistry.parseTabKey(pane.content.tabKey)
  if (!parsed) {
    return {
      title: t('canvas.paneTitle'),
      subtitle: t('canvas.unknownType')
    }
  }
  if (parsed.type === 'tabweb') {
    return {
      title: viewTitleMap.get(parsed.id) || t('label.newTab'),
      subtitle: t('canvas.browserSplit')
    }
  }
  if (parsed.type === 'tabdata') {
    const tableName = tableNameMap.get(parsed.id) || t('label.untitledTable')
    return {
      title: tableName,
      subtitle: t('canvas.tableSplit')
    }
  }
  return { title: t('canvas.paneTitle'), subtitle: parsed.type }
}

const getPathKey = (path: number[]): string =>
  path.length > 0 ? path.join('.') : 'root'

const getPanelId = (
  groupId: string,
  path: number[],
  child: CanvasLayoutNode,
  index: number,
): string => {
  const childKey = child.type === 'leaf' ? child.paneId : child.id
  const pathKey = path.length > 0 ? path.join('-') : 'root'
  return `canvas-split-${groupId}-${pathKey}-${index}-${childKey}`.replace(/[^a-zA-Z0-9_-]/g, '-')
}

const getLayoutPayloadType = (layoutData: unknown): string => {
  if (Array.isArray(layoutData)) return 'array'
  if (layoutData === null) return 'null'
  return typeof layoutData
}

const resolveLayoutSizes = (
  layoutData: unknown,
  panelIds: string[],
  normalizeFn: (sizes: number[], count: number) => number[],
): number[] | null => {
  if (!layoutData || typeof layoutData !== 'object' || Array.isArray(layoutData)) {
    return null
  }

  const layoutMap = layoutData as Record<string, number>
  const ratioSizes = panelIds.map(panelId => {
    const percent = layoutMap[panelId]
    if (typeof percent !== 'number') return 0
    return percent / 100
  })
  return normalizeFn(ratioSizes, panelIds.length)
}

interface ActiveCanvasResizeSession {
  path: number[]
  pathKey: string
  splitIndex: number
  orientation: 'horizontal' | 'vertical'
  session: ReturnType<typeof startLayoutResizeTelemetry>
}

export const CanvasGroupLayout: React.FC<CanvasGroupLayoutProps> = ({
  group,
  className,
  crawlspaceId,
  isGroupActive = true
}) => {
  const { t, i18n } = useTranslation('context')
  const setActivePane = useCanvasLayoutStore(state => state.setActivePane)
  const setActiveKey = useSpaceContextTabsStore(state => state.setActiveKey)
  const setSplitSizes = useCanvasLayoutStore(state => state.setSplitSizes)
  const tables = useTableStore(state => state.tables)
  const tableNameMap = useMemo(() => {
    const map = new Map<string, string>()
    tables.forEach(table => {
      map.set(table.id, table.name || t('label.untitledTable'))
    })
    return map
  }, [tables, t, i18n.language])
  const viewList = useCrawlTabStore(state =>
    crawlspaceId ? state.crawlspaceContextCache[crawlspaceId]?.viewList || EMPTY_VIEW_LIST : EMPTY_VIEW_LIST
  )
  const viewTitleMap = useMemo(() => {
    const map = new Map<string, string>()
    viewList.forEach(view => {
      map.set(view.viewId, view.title || view.url || t('label.newTab'))
    })
    return map
  }, [viewList, t, i18n.language])

  const minRatio = 0.2
  const paneMap = useMemo(() => {
    const map = new Map<string, CanvasPane>()
    group.panes.forEach(pane => {
      map.set(pane.id, pane)
    })
    return map
  }, [group.panes])

  // ✅ 仅保留拖拽中状态（用于视觉反馈），实际拖拽逻辑由 CanvasDragLayer 处理
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null)
  const activeResizeRef = useRef<ActiveCanvasResizeSession | null>(null)
  const liveLayoutByPathRef = useRef<Record<string, number[]>>({})
  const layoutSyncRafRef = useRef<number | null>(null)
  const pointerUpFallbackTimerRef = useRef<number | null>(null)
  const invalidLayoutPayloadReportedRef = useRef<Set<string>>(new Set())
  const missingLayoutReportedRef = useRef(false)

  // ✅ 清理拖拽状态（与 CanvasDragLayer 同步）
  useEffect(() => {
    const clearDragState = () => {
      setDraggingPaneId(null)
    }
    window.addEventListener('canvas-pane-drag-end', clearDragState)
    window.addEventListener('dragend', clearDragState)
    window.addEventListener('drop', clearDragState)
    window.addEventListener('blur', clearDragState)
    return () => {
      window.removeEventListener('canvas-pane-drag-end', clearDragState)
      window.removeEventListener('dragend', clearDragState)
      window.removeEventListener('drop', clearDragState)
      window.removeEventListener('blur', clearDragState)
    }
  }, [])

  // ✅ 布局变更后通知 WebContentsView 更新 bounds（位置变化但尺寸不变也需要刷新）
  useEffect(() => {
    if (typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => {
      dispatchCrawlViewLayoutChange('canvas-group-layout', {
        spaceId: group.spaceId,
        groupId: group.id,
      })
    })
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [group.id, group.spaceId, group.updatedAt])

  // 分隔条拖拽过程中（onLayoutChange，尚未 commit）主动按帧广播同步事件，
  // 让原生 WebContentsView 实时跟随分屏比例，而不是等松手 commit（updatedAt 变化）才对齐。
  // 复用 AppLayout 的 scheduleShellLayoutSync 模式：一帧至多排程一次 rAF，避免每次回调都 dispatch。
  const scheduleCanvasLayoutSync = useCallback(() => {
    if (typeof window === 'undefined') return
    if (layoutSyncRafRef.current != null) return
    layoutSyncRafRef.current = window.requestAnimationFrame(() => {
      layoutSyncRafRef.current = null
      dispatchCrawlViewLayoutChange('canvas-group-resize', {
        spaceId: group.spaceId,
        groupId: group.id,
      })
    })
  }, [group.id, group.spaceId])

  useEffect(() => {
    return () => {
      if (layoutSyncRafRef.current != null) {
        window.cancelAnimationFrame(layoutSyncRafRef.current)
        layoutSyncRafRef.current = null
      }
    }
  }, [])

  const normalizeSizes = (sizes: number[], count: number) => {
    if (sizes.length === count && sizes.every(size => size > 0)) {
      const total = sizes.reduce((sum, value) => sum + value, 0)
      return total ? sizes.map(value => value / total) : sizes
    }
    const ratio = 1 / Math.max(count, 1)
    return Array.from({ length: count }, () => ratio)
  }

  const clearPointerUpFallbackTimer = useCallback(() => {
    if (pointerUpFallbackTimerRef.current === null) return
    window.clearTimeout(pointerUpFallbackTimerRef.current)
    pointerUpFallbackTimerRef.current = null
  }, [])

  const cancelActiveV4Resize = useCallback((reason: string) => {
    const activeResize = activeResizeRef.current
    if (!activeResize) return
    activeResize.session.cancel({
      groupId: group.id,
      splitPath: activeResize.pathKey,
      splitIndex: activeResize.splitIndex,
      orientation: activeResize.orientation,
      reason,
      driver: 'react-resizable-panels-v4',
    })
    activeResizeRef.current = null
  }, [group.id])

  const commitV4Resize = useCallback(
    (path: number[], pathKey: string, nextSizes: number[], source: 'layout_changed' | 'pointer_up_fallback') => {
      const normalized = normalizeSizes(nextSizes, nextSizes.length)
      const activeResize = activeResizeRef.current
      const matchedActive = activeResize && activeResize.pathKey === pathKey

      if (matchedActive) {
        activeResize.session.end({
          groupId: group.id,
          splitPath: pathKey,
          splitIndex: activeResize.splitIndex,
          finalSizes: normalized,
          source,
          driver: 'react-resizable-panels-v4',
        })
      }

      try {
        setSplitSizes(group.spaceId, group.id, path, normalized)
        if (matchedActive) {
          activeResize.session.persistSuccess({
            groupId: group.id,
            splitPath: pathKey,
            source,
            driver: 'react-resizable-panels-v4',
          })
        }
      } catch (error) {
        if (matchedActive) {
          activeResize.session.persistFailed(error, {
            groupId: group.id,
            splitPath: pathKey,
            source,
            driver: 'react-resizable-panels-v4',
          })
        }
      } finally {
        if (matchedActive) {
          activeResizeRef.current = null
        }
      }
    },
    [group.id, group.spaceId, setSplitSizes],
  )

  const reportInvalidLayoutPayload = useCallback((
    stage: 'layout_change' | 'layout_changed',
    pathKey: string,
    payloadType: string,
  ) => {
    const dedupeKey = `${stage}:${pathKey}:${payloadType}`
    if (invalidLayoutPayloadReportedRef.current.has(dedupeKey)) return
    invalidLayoutPayloadReportedRef.current.add(dedupeKey)
    trackLayoutTelemetry(
      'layout_persist_failed',
      'canvas-split',
      {
        reason: 'unexpected_layout_payload',
        stage,
        groupId: group.id,
        splitPath: pathKey,
        payloadType,
        driver: 'react-resizable-panels-v4',
      },
      {
        level: 'error',
        counterKey: 'canvas-split.layout_payload_unexpected',
      },
    )
  }, [group.id])

  const handleV4LayoutChanged = useCallback(
    (
      layoutData: unknown,
      path: number[],
      panelIds: string[],
    ) => {
      clearPointerUpFallbackTimer()
      const pathKey = getPathKey(path)
      const nextSizes = resolveLayoutSizes(layoutData, panelIds, normalizeSizes)
      if (!nextSizes) {
        reportInvalidLayoutPayload('layout_changed', pathKey, getLayoutPayloadType(layoutData))
        cancelActiveV4Resize('unexpected_layout_payload')
        return
      }
      liveLayoutByPathRef.current[pathKey] = nextSizes
      commitV4Resize(path, pathKey, nextSizes, 'layout_changed')
    },
    [cancelActiveV4Resize, clearPointerUpFallbackTimer, commitV4Resize, reportInvalidLayoutPayload],
  )

  const handleV4SeparatorPointerDown = useCallback(
    (
      path: number[],
      splitIndex: number,
      isHorizontal: boolean,
      currentSizes: number[],
    ) => {
      clearPointerUpFallbackTimer()
      cancelActiveV4Resize('restart')

      const pathKey = getPathKey(path)
      liveLayoutByPathRef.current[pathKey] = currentSizes.slice()
      activeResizeRef.current = {
        path,
        pathKey,
        splitIndex,
        orientation: isHorizontal ? 'horizontal' : 'vertical',
        session: startLayoutResizeTelemetry('canvas-split', {
          groupId: group.id,
          splitPath: pathKey,
          splitIndex,
          orientation: isHorizontal ? 'horizontal' : 'vertical',
          driver: 'react-resizable-panels-v4',
        }),
      }
    },
    [cancelActiveV4Resize, clearPointerUpFallbackTimer, group.id],
  )

  const handleV4SeparatorPointerCancel = useCallback(() => {
    clearPointerUpFallbackTimer()
    cancelActiveV4Resize('pointer_cancel')
  }, [cancelActiveV4Resize, clearPointerUpFallbackTimer])

  const handleV4SeparatorPointerUp = useCallback(
    (path: number[], splitIndex: number, fallbackSizes: number[]) => {
      clearPointerUpFallbackTimer()
      const pathKey = getPathKey(path)

      pointerUpFallbackTimerRef.current = window.setTimeout(() => {
        pointerUpFallbackTimerRef.current = null
        const activeResize = activeResizeRef.current
        if (!activeResize) return
        if (activeResize.pathKey !== pathKey || activeResize.splitIndex !== splitIndex) return

        const latestSizes = liveLayoutByPathRef.current[pathKey] ?? fallbackSizes
        commitV4Resize(path, pathKey, latestSizes, 'pointer_up_fallback')
      }, 0)
    },
    [clearPointerUpFallbackTimer, commitV4Resize],
  )

  useEffect(() => {
    trackLayoutTelemetry(
      'feature_flag_checked',
      'canvas-split',
      {
        module: 'CanvasGroupLayout',
        enabled: true,
        mode: 'enforced_v4',
      },
      {
        counterKey: 'canvas-split.feature_flag_checked.enabled',
      },
    )
  }, [])

  useEffect(() => {
    return () => {
      clearPointerUpFallbackTimer()
      cancelActiveV4Resize('component_unmount')
    }
  }, [cancelActiveV4Resize, clearPointerUpFallbackTimer])

  useEffect(() => {
    if (group.layout) return
    if (missingLayoutReportedRef.current) return
    missingLayoutReportedRef.current = true
    trackLayoutTelemetry(
      'layout_persist_failed',
      'canvas-split',
      {
        reason: 'missing_group_layout',
        groupId: group.id,
        paneCount: group.panes.length,
        driver: 'react-resizable-panels-v4',
      },
      {
        level: 'error',
        counterKey: 'canvas-split.layout_missing',
      },
    )
  }, [group.id, group.layout, group.panes.length])

  const focusPane = (pane: CanvasPane) => {
    setActivePane(group.spaceId, group.id, pane.id)
    if (pane.content?.tabKey) {
      setActiveKey(group.spaceId, pane.content.tabKey)
    }
  }

  const renderLeaf = (paneId: string, isSingleLeaf = false) => {
    const pane = paneMap.get(paneId)
    const fallbackPane: CanvasPane = pane || { id: paneId, content: null }
    const isActive = (group.activePaneId || group.panes[0]?.id) === fallbackPane.id
    const meta = getPaneMeta(fallbackPane, tableNameMap, viewTitleMap, t)
    const isDraggingThis = draggingPaneId === paneId

    return (
      <div
        className="min-w-0 min-h-0 h-full w-full"
        data-canvas-pane-id={fallbackPane.id}
        data-canvas-group-id={group.id}
        onPointerDownCapture={(event) => {
          if (event.button !== 0) return
          focusPane(fallbackPane)
        }}
        onFocusCapture={() => {
          focusPane(fallbackPane)
        }}
      >
        <div
          className={cn(
            'h-full w-full rounded-md overflow-hidden relative group/pane transition-shadow',
            isSingleLeaf
              ? 'border border-transparent'
              : cn(
                  'border',
                  isActive
                    ? isGroupActive
                      ? 'border-accent/60 ring-2 ring-accent/20'
                      : 'border-border/60'
                    : 'border-border/30',
                ),
            fallbackPane.content ? 'bg-background' : 'bg-transparent',
            isDraggingThis && 'shadow-lg ring-2 ring-accent/40'
          )}
        >
          {/* ✅ 拖拽手柄：设置 dataTransfer，实际拖拽逻辑由 CanvasDragLayer 处理 */}
          {fallbackPane.content && (
            <div className="absolute left-2 top-2 z-banner no-drag">
              <button
                className={cn(
                  'h-6 w-6 rounded-md bg-background/80 backdrop-blur-sm',
                  'border border-border/60 shadow-sm',
                  'flex items-center justify-center',
                  'text-muted-foreground hover:text-foreground',
                  'opacity-0 pointer-events-none',
                  'group-hover/pane:opacity-100 group-hover/pane:pointer-events-auto',
                  'group-focus-within/pane:opacity-100 group-focus-within/pane:pointer-events-auto',
                  isDraggingThis && 'opacity-100 pointer-events-auto',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1',
                  'transition-opacity cursor-grab'
                )}
                title={t('canvas.dragHandle')}
                aria-label={t('canvas.dragHandle')}
                data-pane-drag-handle
                draggable
                onMouseDown={(event) => {
                  event.stopPropagation()
                }}
                onDragStart={(event) => {
                  setDraggingPaneId(fallbackPane.id)
                  event.dataTransfer.setData(
                    DRAG_TYPE_PANE_DRAG,
                    JSON.stringify({ paneId: fallbackPane.id, groupId: group.id })
                  )
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => {
                  setDraggingPaneId(null)
                }}
              >
                <GripVertical className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {isDraggingThis && (
            <div className="absolute inset-0 bg-accent/5 pointer-events-none z-sticky" />
          )}
          {!fallbackPane.content ? (
            <div className="h-full w-full flex flex-col items-center justify-center gap-2 text-body text-muted-foreground/80">
              <div className="text-body text-muted-foreground">{meta.title}</div>
              <div className={CANVAS_TEXT_META}>{meta.subtitle}</div>
            </div>
          ) : (
            <CanvasPaneContentRenderer
              key={fallbackPane.id}
              pane={fallbackPane}
              spaceId={group.spaceId}
              isActive={isActive}
              isGroupActive={isGroupActive}
              crawlspaceId={crawlspaceId}
              onPaneInteraction={() => focusPane(fallbackPane)}
            />
          )}
        </div>
      </div>
    )
  }

  const getStableKey = (child: CanvasLayoutNode, index: number): string => {
    if (child.type === 'leaf') {
      return child.paneId
    }
    return child.id
  }

  const renderNodeV4 = (
    node: CanvasLayoutNode,
    path: number[],
    isRoot = false,
  ): React.ReactNode => {
    if (node.type === 'leaf') {
      // isRoot && leaf → 整棵布局树只有一个 pane，弱化外层 split frame（D-W4-4）
      return renderLeaf(node.paneId, isRoot)
    }

    const isHorizontal = node.direction === 'horizontal'
    const pathKey = getPathKey(path)
    const sizes = normalizeSizes(node.sizes, node.children.length)
    const panelIds = node.children.map((child, index) => getPanelId(group.id, path, child, index))
    const orientation = isHorizontal ? 'horizontal' : 'vertical'

    return (
      <LayoutGroup
        id={`canvas-split-group-${group.id}-${pathKey}`}
        orientation={orientation}
        className={cn(
          'h-full w-full',
          isHorizontal ? 'flex-row' : 'flex-col',
          isRoot && 'relative',
          isRoot && className,
        )}
        onLayoutChange={(layoutData: unknown) => {
          const nextSizes = resolveLayoutSizes(layoutData, panelIds, normalizeSizes)
          if (!nextSizes) {
            reportInvalidLayoutPayload('layout_change', pathKey, getLayoutPayloadType(layoutData))
            return
          }
          liveLayoutByPathRef.current[pathKey] = nextSizes
          scheduleCanvasLayoutSync()
        }}
        onLayoutChanged={(layoutData: unknown) => {
          handleV4LayoutChanged(layoutData, path, panelIds)
        }}
      >
        {node.children.map((child, index) => {
          const stableKey = getStableKey(child, index)
          return (
            <React.Fragment key={stableKey}>
              <LayoutPanel
                id={panelIds[index]}
                defaultSize={`${(sizes[index] ?? 0) * 100}%`}
                minSize={`${minRatio * 100}%`}
                className="min-w-0 min-h-0 overflow-hidden"
              >
                {renderNodeV4(child, [...path, index])}
              </LayoutPanel>

              {index < node.children.length - 1 && (
                <LayoutSeparator
                  className={cn(
                    'group/handle',
                    isHorizontal ? '!w-2 cursor-col-resize' : '!h-2 cursor-row-resize',
                  )}
                  onPointerDown={() => {
                    handleV4SeparatorPointerDown(path, index, isHorizontal, sizes)
                  }}
                  onPointerUp={() => {
                    handleV4SeparatorPointerUp(path, index, sizes)
                  }}
                  onPointerCancel={handleV4SeparatorPointerCancel}
                />
              )}
            </React.Fragment>
          )
        })}
      </LayoutGroup>
    )
  }

  if (!group.layout) {
    return (
      <div className="h-full w-full rounded-md border border-destructive/40 bg-destructive/5 p-3 text-body text-destructive">
        Canvas split layout 数据缺失，请刷新后重试。
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      {renderNodeV4(group.layout, [], true)}
    </div>
  )
}
