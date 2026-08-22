import { useCallback, useEffect, useRef } from 'react'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { createLogger } from '@/utils/logger'
import { CRAWL_VIEW_LAYOUT_CHANGE_EVENT, getElementViewBounds, getRendererZoomFactor } from '@/utils/crawl-view-bounds'
import { createIPCErrorHandler } from '../utils/ipc-error-handler'

const handleError = createIPCErrorHandler('EmbeddedCrawlView')
const log = createLogger('CrawlBounds')

const isCrawlBoundsDebugEnabled = (): boolean => {
  if (typeof globalThis !== 'undefined' && globalThis.__TABTIN_DEBUG_CRAWL_BOUNDS__) return true
  try {
    return window.localStorage?.getItem('debug:crawl-bounds') === '1'
  } catch {
    return false
  }
}

type Bounds = { x: number; y: number; width: number; height: number }
type UpdateViewBounds = (force?: boolean) => void
type ElementSnapshot = {
  x: number
  y: number
  width: number
  height: number
  clientWidth: number
  clientHeight: number
  connected: boolean
  display?: string
  visibility?: string
}

function snapshotElement(element: Element | null): ElementSnapshot | null {
  if (!element || !(element instanceof HTMLElement)) return null
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    connected: element.isConnected,
    display: style.display,
    visibility: style.visibility,
  }
}

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 把高频回调合并到「每帧至多一次」：在一帧内多次触发只排程一个 rAF，
 * 帧到来时执行最新一次。相比固定毫秒节流，跟随节奏与屏幕刷新对齐
 * （≈16ms@60Hz 而非固定 75ms），且最后一次触发一定会落地（无 trailing 丢帧）。
 */
function createRafThrottle(fn: () => void): { invoke: () => void; cancel: () => void } {
  let rafId: number | null = null
  const invoke = () => {
    if (rafId != null) return
    rafId = window.requestAnimationFrame(() => {
      rafId = null
      fn()
    })
  }
  const cancel = () => {
    if (rafId != null) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
  }
  return { invoke, cancel }
}

export type ViewDisplayOptions = {
  tabId: string
  containerRef: React.RefObject<HTMLDivElement | null>
  showViewRef: React.MutableRefObject<((targetUrl?: string, boundsOverride?: Bounds) => void) | null>
  updateViewBoundsRef: React.MutableRefObject<UpdateViewBounds | null>
  hostView: { hide?: (viewId: string) => Promise<any> } | undefined
  managedExternally: boolean
  isActive: boolean
  allowMultiple: boolean
  overlayCount: number
  crawlspaceId?: string
}

export function useViewDisplay({
  tabId,
  containerRef,
  showViewRef,
  updateViewBoundsRef,
  hostView,
  managedExternally,
  isActive,
  allowMultiple,
  overlayCount,
  crawlspaceId,
}: ViewDisplayOptions) {
  const lastBoundsRef = useRef<Bounds | null>(null)
  const pendingShowRef = useRef(false)
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingShowCountRef = useRef(0)
  const lastInvalidDiagnosticRef = useRef<string | null>(null)

  const getSafeBounds = useCallback((): Bounds | null => {
    return getElementViewBounds(containerRef.current)
  }, [containerRef])

  const isSameBounds = useCallback((prev: Bounds | null, next: Bounds): boolean => {
    if (!prev) return false
    return prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height
  }, [])

  const readLayoutDiagnostic = useCallback(() => {
    const container = containerRef.current
    const slot = container?.closest('[data-crawl-view-slot]') ?? null
    const panel = container?.closest('[data-panel]') ?? null
    const group = container?.closest('[data-group]') ?? null
    return {
      window: typeof window === 'undefined'
        ? null
        : {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            zoomFactor: getRendererZoomFactor(),
          },
      container: snapshotElement(container),
      slot: snapshotElement(slot),
      panel: snapshotElement(panel),
      group: snapshotElement(group),
    }
  }, [containerRef])

  const tryShowWithFreshBounds = useCallback(() => {
    const bounds = getSafeBounds()
    if (!bounds) {
      const nextPendingCount = pendingShowCountRef.current + 1
      const diagnostic = readLayoutDiagnostic()
      const signature = JSON.stringify(diagnostic)
      if (isCrawlBoundsDebugEnabled() && lastInvalidDiagnosticRef.current !== signature) {
        log.warn(
          `renderer 无有效 bounds，进入 pending ${stringifyForLog({
            tabId,
            isActive,
            overlayCount,
            pendingCount: nextPendingCount,
            diagnostic,
          })}`,
        )
        lastInvalidDiagnosticRef.current = signature
      }
      pendingShowRef.current = true
      pendingShowCountRef.current = nextPendingCount
      return false
    }

    pendingShowRef.current = false
    if (isCrawlBoundsDebugEnabled() && lastInvalidDiagnosticRef.current) {
      log.info(
        `renderer 恢复有效 bounds ${stringifyForLog({
          tabId,
          bounds,
          pendingCount: pendingShowCountRef.current,
          diagnostic: readLayoutDiagnostic(),
        })}`,
      )
      lastInvalidDiagnosticRef.current = null
    }
    if (showTimerRef.current) clearTimeout(showTimerRef.current)
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null
      showViewRef.current?.(undefined, bounds)
    }, 0)
    return true
  }, [getSafeBounds, isActive, overlayCount, readLayoutDiagnostic, showViewRef, tabId])

  useEffect(() => {
    if (managedExternally) return

    // 网页标签残留 bug 修复（2026-05-10）：
    // 之前把 `if (!containerRef.current) return` 放在 effect 入口当总闸，
    // 但 hide 分支只需 tabId（IPC 调用），不依赖 DOM 容器。Wave 2c 把 SpaceWorkbench-
    // Host / EmbeddedCrawlView 改成 React 19.2 `<Activity>` 后，containerRef 挂在
    // 自身 `<Activity>` 内部的 div 上，叠加 React.lazy + Suspense 边界，effect 重跑
    // 时偶发命中 React "ref not attached during effects" 边界，
    // ref 短暂为 null → hide IPC 被吞 → 主进程 WebContentsView 一直挂在主窗口
    // 内容层之上，盖住其他 context tab 的 React DOM。修复：hide 分支无条件执行，
    // 只对 show 分支保留 ref 守卫（show 必须从 ref 读 bounds）。
    if (!isActive || overlayCount > 0) {
      pendingShowRef.current = false
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current)
        showTimerRef.current = null
      }
      hostView?.hide?.(tabId).catch(handleError('hide'))
      return
    }

    if (!containerRef.current) return

    const scheduleShow = () => {
      if (!containerRef.current) return
      tryShowWithFreshBounds()
    }

    const resize = () => {
      if (overlayCount > 0) return
      updateViewBoundsRef.current?.(true)
    }

    scheduleShow()

    // rAF 驱动跟随：窗口 resize 与容器尺寸变化都合并到每帧一次，
    // 让原生 WebContentsView 的 bounds 紧跟拖拽，而非滞后固定节流窗口。
    const rafResize = createRafThrottle(resize)
    window.addEventListener('resize', rafResize.invoke)

    const rafObserverSync = createRafThrottle(() => {
      if (pendingShowRef.current) scheduleShow()
      resize()
    })
    const resizeObserver = new ResizeObserver(rafObserverSync.invoke)
    resizeObserver.observe(containerRef.current)

    return () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current)
        showTimerRef.current = null
      }
      pendingShowCountRef.current = 0
      rafResize.cancel()
      rafObserverSync.cancel()
      window.removeEventListener('resize', rafResize.invoke)
      resizeObserver.disconnect()
    }
  }, [allowMultiple, isActive, managedExternally, overlayCount, tabId, containerRef, hostView, showViewRef, tryShowWithFreshBounds, updateViewBoundsRef])

  useEffect(() => {
    if (managedExternally) return
    const handleLayoutChange = () => {
      if (!isActive || overlayCount > 0) return
      window.requestAnimationFrame(() => {
        if (pendingShowRef.current) {
          if (tryShowWithFreshBounds()) return
          return
        }
        updateViewBoundsRef.current?.(true)
      })
    }
    window.addEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)
    return () => { window.removeEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange) }
  }, [isActive, managedExternally, overlayCount, tryShowWithFreshBounds, updateViewBoundsRef])

  useEffect(() => {
    if (managedExternally || typeof window === 'undefined') return
    const handleSlotChange = (event: Event) => {
      const detail = (event as CustomEvent).detail as { viewId?: string } | undefined
      if (detail?.viewId && detail.viewId !== tabId) return
      if (!isActive || overlayCount > 0) return
      window.requestAnimationFrame(() => {
        if (pendingShowRef.current) {
          if (tryShowWithFreshBounds()) return
          return
        }
        updateViewBoundsRef.current?.(true)
      })
    }
    window.addEventListener('crawl-view-slot-change', handleSlotChange)
    return () => { window.removeEventListener('crawl-view-slot-change', handleSlotChange) }
  }, [isActive, managedExternally, overlayCount, tabId, tryShowWithFreshBounds, updateViewBoundsRef])

  useEffect(() => {
    if (managedExternally) return
    const currentTabId = tabId
    return () => {
      Promise.resolve().then(() => {
        const store = useCrawlTabStore.getState()
        const cache = crawlspaceId ? store.crawlspaceContextCache[crawlspaceId] : null
        const isClosing = cache?.viewList?.some(view => view.viewId === currentTabId && view.isClosing)
        if (isClosing) return
        hostView?.hide?.(currentTabId).catch(handleError('hide'))
      })
    }
  }, [crawlspaceId, tabId, hostView, managedExternally])

  return {
    getSafeBounds,
    isSameBounds,
    lastBoundsRef,
    pendingShowRef,
  }
}
