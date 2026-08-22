/**
 * useWebviewDisplay — flag=webview 时的显示驱动 hook
 *
 * 与 useViewDisplay 的关系：**顶部分流、结构对齐**。EmbeddedCrawlView 在
 * flag=webview 时把 useViewDisplay 置于 managedExternally（不发
 * crawl-view:show / setViewBounds IPC），由本 hook 驱动 WebviewManager：
 *
 *   - 主 effect：仅 isActive 决定 show / hide（throttle）。webview 已在 DOM
 *     合成层（稳定层 z=10），App 弹窗在 z-modal=50，**不再**因 overlayCount
 *     把页面藏掉——那是 WCV 原生层盖不住 DOM 时的绕行，搬过来等于根治失效。
 *   - overlayCount > 0 时只开鼠标穿透：Electron <webview> guest 偶发仍会吞
 *     被遮罩盖住区域的点击，穿透让事件落回宿主弹窗/backdrop。
 *   - bounds 只作"容器已有有效尺寸"的门槛信号，实际几何由 WebviewManager
 *     测量 slot rect（CSS px）
 *   - 几何跟随：WebviewManager.syncTo + 与 useViewDisplay 相同的布局事件
 *   - 卸载：hide（与 useViewDisplay 的 isClosing 检查同口径）
 *
 * flag=wcv 时本 hook 完全惰性（enabled=false，所有 effect 空跑），
 * 对现状路径零影响。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import {
  beginCrawlViewMousePassthrough,
  endCrawlViewMousePassthrough,
} from '@/crawlspace/crawl-view-mouse-passthrough-depth'
import { CRAWL_VIEW_LAYOUT_CHANGE_EVENT, getElementViewBounds } from '@/utils/crawl-view-bounds'
import { createIPCErrorHandler } from '../utils/ipc-error-handler'
import { getWebviewManager } from '../../../crawlspace/webview-manager/WebviewManager'

const handleError = createIPCErrorHandler('WebviewDisplay')

type Bounds = { x: number; y: number; width: number; height: number }

export type WebviewDisplayOptions = {
  /** flag=webview 且非 managedExternally 时为 true；false 时全部 effect 空跑 */
  enabled: boolean
  tabId: string
  containerRef: React.RefObject<HTMLDivElement | null>
  showViewRef: React.MutableRefObject<((targetUrl?: string, boundsOverride?: Bounds) => void) | null>
  hostView: { hide?: (viewId: string) => Promise<unknown> } | undefined
  isActive: boolean
  overlayCount: number
  crawlspaceId?: string
}

export function useWebviewDisplay({
  enabled,
  tabId,
  containerRef,
  showViewRef,
  hostView,
  isActive,
  overlayCount,
  crawlspaceId,
}: WebviewDisplayOptions): void {
  const pendingShowRef = useRef(false)
  /** overlayCount 跨 0 边界时持有/释放穿透引用计数，避免与拖拽穿透互相提前关闭 */
  const overlayPassthroughHeldRef = useRef(false)

  const releaseOverlayPassthrough = useCallback(() => {
    if (!overlayPassthroughHeldRef.current) return
    endCrawlViewMousePassthrough()
    overlayPassthroughHeldRef.current = false
  }, [])

  const syncOverlayPassthrough = useCallback((shouldHold: boolean) => {
    if (shouldHold === overlayPassthroughHeldRef.current) return
    if (shouldHold) {
      beginCrawlViewMousePassthrough()
      overlayPassthroughHeldRef.current = true
    } else {
      endCrawlViewMousePassthrough()
      overlayPassthroughHeldRef.current = false
    }
  }, [])

  const tryShowWithFreshBounds = useCallback((): boolean => {
    const bounds = getElementViewBounds(containerRef.current)
    if (!bounds) {
      pendingShowRef.current = true
      return false
    }
    pendingShowRef.current = false
    showViewRef.current?.(undefined, bounds)
    if (containerRef.current) {
      getWebviewManager().syncTo(tabId, containerRef.current)
    }
    return true
  }, [containerRef, showViewRef, tabId])

  // ── 主 effect：仅 isActive 决定 show/hide；overlay 只穿透、不藏页 ──
  useEffect(() => {
    if (!enabled) {
      releaseOverlayPassthrough()
      return
    }

    if (!isActive) {
      pendingShowRef.current = false
      releaseOverlayPassthrough()
      hostView?.hide?.(tabId).catch(handleError('hide'))
      return
    }

    // 页面保持可见；浮层打开时只穿透鼠标，让弹窗/backdrop 收到点击
    syncOverlayPassthrough(overlayCount > 0)

    if (!containerRef.current) return

    tryShowWithFreshBounds()

    // 容器尺寸变化：show 仍 pending 时重试；否则交给 manager 重新测量
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (pendingShowRef.current) {
            tryShowWithFreshBounds()
            return
          }
          getWebviewManager().requestSync(tabId)
        })
      : null
    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    return () => {
      resizeObserver?.disconnect()
    }
  }, [
    enabled,
    isActive,
    overlayCount,
    tabId,
    containerRef,
    hostView,
    tryShowWithFreshBounds,
    releaseOverlayPassthrough,
    syncOverlayPassthrough,
  ])

  // ── 布局事件触发点：对齐 useViewDisplay（浮层打开时仍跟几何，不因 overlay 停） ──
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const handleLayoutChange = (event: Event): void => {
      const detail = (event as CustomEvent).detail as { viewId?: string } | undefined
      if (detail?.viewId && detail.viewId !== tabId) return
      if (!isActive) return
      window.requestAnimationFrame(() => {
        if (pendingShowRef.current) {
          tryShowWithFreshBounds()
          return
        }
        getWebviewManager().requestSync(tabId)
      })
    }
    window.addEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)
    window.addEventListener('crawl-view-slot-change', handleLayoutChange)
    return () => {
      window.removeEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)
      window.removeEventListener('crawl-view-slot-change', handleLayoutChange)
    }
  }, [enabled, isActive, tabId, tryShowWithFreshBounds])

  // ── 卸载：hide + 释放 overlay 穿透（与 useViewDisplay 的 isClosing 检查同口径） ──
  useEffect(() => {
    if (!enabled) return
    const currentTabId = tabId
    return () => {
      releaseOverlayPassthrough()
      Promise.resolve().then(() => {
        const store = useCrawlTabStore.getState()
        const cache = crawlspaceId ? store.crawlspaceContextCache[crawlspaceId] : null
        const isClosing = cache?.viewList?.some(view => view.viewId === currentTabId && view.isClosing)
        if (isClosing) return
        hostView?.hide?.(currentTabId).catch(handleError('hide'))
      })
    }
  }, [enabled, crawlspaceId, tabId, hostView, releaseOverlayPassthrough])
}
