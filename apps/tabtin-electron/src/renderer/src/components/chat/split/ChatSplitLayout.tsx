/**
 * ChatSplitLayout - Recursive split-pane renderer for chat.
 *
 * Renders the LayoutNode tree with resize handles between panes.
 * Each leaf delegates to `renderPane(paneId)` supplied by the parent.
 */

import React, { useRef, useCallback, useEffect } from 'react'
import { cn } from '@utils/cn'
import type { LayoutNode } from '@/utils/split-layout'
import { normalizeSizes } from '@/utils/split-layout'
import { LayoutGroup, LayoutPanel, LayoutSeparator } from '@components/layout/resizable-v4'
import { startLayoutResizeTelemetry, trackLayoutTelemetry } from '@utils/layout/telemetry'

interface ChatSplitLayoutProps {
  layout: LayoutNode
  activePaneId: string | null
  renderPane: (paneId: string) => React.ReactNode
  onSetSplitSizes: (splitPath: number[], sizes: number[]) => void
  className?: string
}

const DEFAULT_MIN_RATIO = 0.2
const MAX_TOTAL_MIN_RATIO = 0.6

const getPaneMinRatio = (siblingCount: number): number =>
  Math.min(DEFAULT_MIN_RATIO, MAX_TOTAL_MIN_RATIO / Math.max(1, siblingCount))

const getStableKey = (child: LayoutNode, index: number): string =>
  child.type === 'leaf' ? child.paneId : child.id

const getPathKey = (path: number[]): string =>
  path.length > 0 ? path.join('.') : 'root'

const getPanelId = (path: number[], child: LayoutNode, index: number): string => {
  const childKey = child.type === 'leaf' ? child.paneId : child.id
  const pathKey = path.length > 0 ? path.join('-') : 'root'
  return `chat-split-${pathKey}-${index}-${childKey}`.replace(/[^a-zA-Z0-9_-]/g, '-')
}

const getLayoutPayloadType = (layoutData: unknown): string => {
  if (Array.isArray(layoutData)) return 'array'
  if (layoutData === null) return 'null'
  return typeof layoutData
}

const resolveLayoutSizes = (
  layoutData: unknown,
  panelIds: string[],
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
  return normalizeSizes(ratioSizes, panelIds.length)
}

interface ActiveResizeSession {
  path: number[]
  pathKey: string
  splitIndex: number
  orientation: 'horizontal' | 'vertical'
  session: ReturnType<typeof startLayoutResizeTelemetry>
}

export const ChatSplitLayout: React.FC<ChatSplitLayoutProps> = ({
  layout,
  activePaneId,
  renderPane,
  onSetSplitSizes,
  className,
}) => {
  void activePaneId

  const activeResizeRef = useRef<ActiveResizeSession | null>(null)
  const liveLayoutByPathRef = useRef<Record<string, number[]>>({})
  const pointerUpFallbackTimerRef = useRef<number | null>(null)
  const invalidLayoutPayloadReportedRef = useRef<Set<string>>(new Set())

  const clearPointerUpFallbackTimer = useCallback(() => {
    if (pointerUpFallbackTimerRef.current === null) return
    window.clearTimeout(pointerUpFallbackTimerRef.current)
    pointerUpFallbackTimerRef.current = null
  }, [])

  const cancelActiveV4Resize = useCallback((reason: string) => {
    const activeResize = activeResizeRef.current
    if (!activeResize) return
    activeResize.session.cancel({
      splitPath: activeResize.pathKey,
      splitIndex: activeResize.splitIndex,
      orientation: activeResize.orientation,
      reason,
      driver: 'react-resizable-panels-v4',
    })
    activeResizeRef.current = null
  }, [])

  const commitV4Resize = useCallback(
    (path: number[], pathKey: string, nextSizes: number[], source: 'layout_changed' | 'pointer_up_fallback') => {
      const normalized = normalizeSizes(nextSizes, nextSizes.length)
      const activeResize = activeResizeRef.current
      const matchedActive =
        activeResize &&
        activeResize.pathKey === pathKey

      if (matchedActive) {
        activeResize.session.end({
          splitPath: pathKey,
          splitIndex: activeResize.splitIndex,
          finalSizes: normalized,
          source,
          driver: 'react-resizable-panels-v4',
        })
      }

      try {
        onSetSplitSizes(path, normalized)
        if (matchedActive) {
          activeResize.session.persistSuccess({
            splitPath: pathKey,
            source,
            driver: 'react-resizable-panels-v4',
          })
        }
      } catch (error) {
        if (matchedActive) {
          activeResize.session.persistFailed(error, {
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
    [onSetSplitSizes],
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
      'chat-split',
      {
        reason: 'unexpected_layout_payload',
        stage,
        splitPath: pathKey,
        payloadType,
        driver: 'react-resizable-panels-v4',
      },
      {
        level: 'error',
        counterKey: 'chat-split.layout_payload_unexpected',
      },
    )
  }, [])

  const handleV4LayoutChanged = useCallback(
    (
      layoutData: unknown,
      path: number[],
      panelIds: string[],
    ) => {
      const pathKey = getPathKey(path)
      const activeResize = activeResizeRef.current
      const isActiveResizePath = activeResize?.pathKey === pathKey
      const nextSizes = resolveLayoutSizes(layoutData, panelIds)
      if (!nextSizes) {
        reportInvalidLayoutPayload('layout_changed', pathKey, getLayoutPayloadType(layoutData))
        if (isActiveResizePath) {
          clearPointerUpFallbackTimer()
          cancelActiveV4Resize('unexpected_layout_payload')
        }
        return
      }
      liveLayoutByPathRef.current[pathKey] = nextSizes
      if (!isActiveResizePath) return
      clearPointerUpFallbackTimer()
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
        session: startLayoutResizeTelemetry('chat-split', {
          splitPath: pathKey,
          splitIndex,
          orientation: isHorizontal ? 'horizontal' : 'vertical',
          driver: 'react-resizable-panels-v4',
        }),
      }
    },
    [cancelActiveV4Resize, clearPointerUpFallbackTimer],
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
      'chat-split',
      {
        module: 'ChatSplitLayout',
        enabled: true,
        mode: 'enforced_v4',
      },
      {
        counterKey: 'chat-split.feature_flag_checked.enabled',
      },
    )
  }, [])

  useEffect(() => {
    return () => {
      clearPointerUpFallbackTimer()
      cancelActiveV4Resize('component_unmount')
    }
  }, [cancelActiveV4Resize, clearPointerUpFallbackTimer])

  const renderNode = (
    node: LayoutNode,
    path: number[],
    isRoot = false,
  ): React.ReactNode => {
    if (node.type === 'leaf') {
      return renderPane(node.paneId)
    }

    const isHorizontal = node.direction === 'horizontal'
    const pathKey = getPathKey(path)
    const sizes = normalizeSizes(node.sizes, node.children.length)
    const panelIds = node.children.map((child, idx) => getPanelId(path, child, idx))
    const orientation = isHorizontal ? 'horizontal' : 'vertical'
    const minRatio = getPaneMinRatio(node.children.length)

    return (
      <LayoutGroup
        id={`chat-split-group-${pathKey}`}
        orientation={orientation}
        className={cn(
          'h-full w-full',
          isHorizontal ? 'flex-row' : 'flex-col',
          isRoot && className,
        )}
        onLayoutChange={(layoutData: unknown) => {
          const nextSizes = resolveLayoutSizes(layoutData, panelIds)
          if (!nextSizes) {
            reportInvalidLayoutPayload('layout_change', pathKey, getLayoutPayloadType(layoutData))
            return
          }
          liveLayoutByPathRef.current[pathKey] = nextSizes
        }}
        onLayoutChanged={(layoutData: unknown) => {
          handleV4LayoutChanged(layoutData, path, panelIds)
        }}
      >
        {node.children.map((child, idx) => (
          <React.Fragment key={getStableKey(child, idx)}>
            <LayoutPanel
              id={panelIds[idx]}
              defaultSize={`${(sizes[idx] ?? 0) * 100}%`}
                minSize={`${minRatio * 100}%`}
              className="min-w-0 min-h-0 overflow-hidden"
            >
              {renderNode(child, [...path, idx])}
            </LayoutPanel>

            {idx < node.children.length - 1 && (
              <LayoutSeparator
                className={cn(
                  'group/handle',
                  isHorizontal ? '!w-3 cursor-col-resize' : '!h-3 cursor-row-resize',
                  'bg-border/10 hover:bg-border/20 active:bg-border/30 transition-colors',
                )}
                persistentLine
                onPointerDown={() => {
                  handleV4SeparatorPointerDown(path, idx, isHorizontal, sizes)
                }}
                onPointerUp={() => {
                  handleV4SeparatorPointerUp(path, idx, sizes)
                }}
                onPointerCancel={handleV4SeparatorPointerCancel}
              />
            )}
          </React.Fragment>
        ))}
      </LayoutGroup>
    )
  }

  return (
    <div className="h-full w-full">
      {renderNode(layout, [], true)}
    </div>
  )
}
