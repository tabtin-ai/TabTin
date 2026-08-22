import React, { Activity, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Globe } from 'lucide-react'
import { type CrawlTab, useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useBookmarkStore } from '@stores/useBookmarkStore'
import { useUIStore } from '@stores/useUIStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useDownloadStore } from '@stores/useDownloadStore'
import { useBrowsingHistoryStore } from '@stores/useBrowsingHistoryStore'
import { useBrowserPrefsStore } from '@stores/useBrowserPrefsStore'
import { normalizeBrowserAddressInput } from '@/utils/browserAddressInput'
import { CrawlspaceToolbar } from '@tabtin/crawlspace-core'
import { toast } from '@components/ui'
import { electronCrawlspaceHost } from '../../crawlspace/host/electron-crawlspace-host'
import { reportCrawlViewError } from '../../crawlspace/utils/reportCrawlViewError'
import { cancelBrowserAnnotationToChat, captureBrowserViewportToChat, quoteBrowserSelectionToChat, startBrowserAnnotationToChat } from '@components/context-space/hooks/quoteBrowserSelectionToChat'
import { contextRegistry } from '@components/context-space/registry'
import { useTranslation } from 'react-i18next'
import { resolvePageLoadErrorCopy } from './page-load-error-copy'
import { createIPCErrorHandler } from './utils/ipc-error-handler'
import { handleCrawlViewShowResponse } from './utils/showResponseHandler'
import { useNavigationEvents } from './hooks/useNavigationEvents'
import { createLogger } from '@/utils/logger'
import { getRendererZoomFactor } from '@/utils/crawl-view-bounds'
import { getBrowserContainerMode } from '@/utils/browserContainerMode'
import { createWebviewHostView } from '../../crawlspace/webview-manager/webviewHostView'
import { useViewDisplay } from './hooks/useViewDisplay'
import { useWebviewDisplay } from './hooks/useWebviewDisplay'
import { useWorkspaceContext } from './hooks/useWorkspaceContext'
import { createNavigationActions } from './hooks/useEmbeddedNavigation'
import { BrowserResourceCenter } from './BrowserResourceCenter'
import { TinsSidePanel } from './TinsSidePanel'
import { AddressBarSuggestions } from './AddressBarSuggestions'
import {
  getBrowserSidePanelPortalStyle,
  getBrowserSidePanelPositionClassName,
  shouldHideWebviewForAddressSuggestions,
  shouldHideWebviewForSidePanel,
  type RectLike,
} from './browserSidePanelLayout'
import { BrowserToolbarActionsMenu } from './BrowserToolbarActionsMenu'
import { BrowserToolbarWideActions } from './BrowserToolbarWideActions'
import { useTinsStore } from '@stores/useTinsStore'
import { TINS_UI_ENABLED } from '@/utils/featureFlags'
import { useScopedEventListener, useScopedResizeObserver } from '@hooks/spaceActivity'
import { openBrowserHomeInSpace } from '@/services/openBrowserHomeInSpace'
import i18n from '@/i18n'
import { AgentBrowserLockOverlay } from './AgentBrowserLockOverlay'

type Bounds = { x: number; y: number; width: number; height: number }
type UpdateViewBounds = (force?: boolean) => void

const handleError = createIPCErrorHandler('EmbeddedCrawlView')
const boundsLog = createLogger('CrawlBounds')
const RESOURCE_PANEL_DEFAULT_WIDTH_PX = 380
const RESOURCE_PANEL_MIN_WIDTH_PX = 320
const BROWSER_VIEW_MIN_WIDTH_BEFORE_RESOURCE_WIDE_PX = 360
const RESOURCE_PANEL_RESIZE_HANDLE_WIDTH_PX = 8
const RESOURCE_VIEW_MODE_TOGGLE_WIDTH_PX = 5
const RESOURCE_VIEW_MODE_TOGGLE_HEIGHT_PX = 96
const RESOURCE_VIEW_MODE_TRIANGLE_WIDTH_PX = 5
const RESOURCE_VIEW_MODE_TRIANGLE_HALF_HEIGHT_PX = 4

const toBoundsSignature = (bounds: Bounds, extra?: string): string =>
  `${bounds.x},${bounds.y},${bounds.width},${bounds.height}${extra ? `:${extra}` : ''}`

const clampResourcePanelWidth = (width: number): number =>
  Math.max(width, RESOURCE_PANEL_MIN_WIDTH_PX)

const getResourceViewModeTriangleStyle = (viewMode: 'narrow' | 'wide'): React.CSSProperties => {
  const baseStyle: React.CSSProperties = {
    width: 0,
    height: 0,
    borderTop: `${RESOURCE_VIEW_MODE_TRIANGLE_HALF_HEIGHT_PX}px solid transparent`,
    borderBottom: `${RESOURCE_VIEW_MODE_TRIANGLE_HALF_HEIGHT_PX}px solid transparent`,
  }
  return viewMode === 'wide'
    ? { ...baseStyle, borderLeft: `${RESOURCE_VIEW_MODE_TRIANGLE_WIDTH_PX}px solid currentColor` }
    : { ...baseStyle, borderRight: `${RESOURCE_VIEW_MODE_TRIANGLE_WIDTH_PX}px solid currentColor` }
}

const stringifyForBoundsLog = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const isCrawlBoundsDebugEnabled = (): boolean => {
  if (typeof globalThis !== 'undefined' && globalThis.__TABTIN_DEBUG_CRAWL_BOUNDS__) return true
  try {
    return window.localStorage?.getItem('debug:crawl-bounds') === '1'
  } catch {
    return false
  }
}

const logCrawlBoundsProbe = (message: string, payload: Record<string, unknown>): void => {
  if (!isCrawlBoundsDebugEnabled()) return
  console.info(`[CrawlBoundsProbe] ${message}`, payload)
}

const snapshotElementRect = (element: Element | null) => {
  if (!element || !(element instanceof HTMLElement)) return null
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    connected: element.isConnected,
  }
}

interface EmbeddedCrawlViewProps {
  tab: CrawlTab
  isActive?: boolean
  managedExternally?: boolean
  allowMultiple?: boolean
  onInteraction?: () => void
}

export const EmbeddedCrawlView: React.FC<EmbeddedCrawlViewProps> = ({
  tab,
  isActive = true,
  managedExternally = false,
  allowMultiple = false,
  onInteraction
}) => {
  const { t } = useTranslation('crawl')
  //  顶部分流：flag=webview 时 hostView 换成 webview 容器适配器
  // （只覆盖 show/hide/setViewBounds/destroy 四个容器操作，其余透传 WCV 版；
  // goBack/reload/zoom 等主进程 WebContents 路径两种容器通用）。
  // flag 是进程级常量（env → additionalArguments），运行期不变。
  const isWebviewContainer = getBrowserContainerMode() === 'webview'
  // 双容器契约（browserSidePanelLayout）：webview 下浮层用 DOM z-index 盖住
  // 真实网页即可；wcv 下原生视图恒定悬浮在 DOM 之上，浮层打开时必须显式降级隐藏。
  const browserContainerModeForLayout: 'webview' | 'wcv' = isWebviewContainer ? 'webview' : 'wcv'
  const hostView = useMemo(
    () => (isWebviewContainer && electronCrawlspaceHost.view
      ? createWebviewHostView(electronCrawlspaceHost.view)
      : electronCrawlspaceHost.view),
    [isWebviewContainer],
  )
  const overlayCount = useUIStore(state => state.overlayCount)
  const searchEngine = useBrowserPrefsStore(state => state.searchEngine)
  const paneRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const contentAreaRef = useRef<HTMLDivElement>(null)
  const [contentAreaRect, setContentAreaRect] = useState<RectLike | null>(null)
  const resourcePanelResizeCleanupRef = useRef<((resetPreview?: boolean) => void) | null>(null)
  const resourcePanelShouldAutoWideRef = useRef(false)
  const [activeSidePanel, setActiveSidePanel] = useState<'resource' | 'tins' | null>(null)
  const [resourcePanelViewMode, setResourcePanelViewMode] = useState<'narrow' | 'wide'>('narrow')
  const [resourcePanelWidth, setResourcePanelWidth] = useState(RESOURCE_PANEL_DEFAULT_WIDTH_PX)
  const [resourcePanelResizeHandleHover, setResourcePanelResizeHandleHover] = useState(false)
  const [resourcePanelViewToggleHover, setResourcePanelViewToggleHover] = useState(false)
  const [resourcePanelAutoWidePreview, setResourcePanelAutoWidePreview] = useState(false)
  const [resourcePanelAutoWidePreviewWidth, setResourcePanelAutoWidePreviewWidth] = useState(0)
  const resourcePanelOpen = activeSidePanel === 'resource'
  const tinsPanelOpen = activeSidePanel === 'tins'
  // 提前声明（原在地址栏建议 state 块内）：下方 viewDisplayActive 的 wcv 降级判定
  // （shouldHideWebviewForAddressSuggestions）需要在声明处就读到这两个值。
  const [suggestionsVisible, setSuggestionsVisible] = useState(false)
  const [addressBarActive, setAddressBarActive] = useState(false)

  const tinsActivationStates = useTinsStore((s) => s.activationStates)
  const tinsActiveCount = tinsActivationStates.filter((s) => s.isActive).length

  // ── 工作空间 Context ──
  const {
    crawlspaceId,
    spaceId,
    browserScopeKey,
    setDisplayKey,
    getActiveKeyNow,
    resolveWorkspaceContext,
    buildViewOptions,
    updateLocation,
  } = useWorkspaceContext({ tab, allowMultiple })

  const resourceSummary = useCrawlTabStore(state => {
    if (!crawlspaceId) return undefined
    return state.crawlspaceContextCache[crawlspaceId]?.viewList.find(view => view.viewId === tab.id)?.resourceSummary
  })
  const viewErrorDescription = useCrawlTabStore(state => {
    if (!crawlspaceId) return undefined
    return state.crawlspaceContextCache[crawlspaceId]?.viewList.find(view => view.viewId === tab.id)?.errorDescription
  })
  const viewHasError = useCrawlTabStore(state => {
    if (!crawlspaceId) return false
    return Boolean(state.crawlspaceContextCache[crawlspaceId]?.viewList.find(view => view.viewId === tab.id)?.hasError)
  })

  const touchView = useCallback((reason: string) => {
    hostView?.touch?.(tab.id, reason).catch(handleError('touch'))
  }, [hostView, tab.id])

  // ── Navigation Events ──
  const {
    navigationState,
    hasLoadedOnce,
    addressBarStatus,
    setAddressBarStatus,
    setAddressBarMessage,
    addressBarMessage,
    toolbarMessage, setToolbarMessage,
  } = useNavigationEvents({
    tabId: tab.id,
    hostView,
    managedExternally,
    isActive,
    updateLocation,
    touchView,
    t,
  })

  // 页面加载失败时隐藏 native WebContentsView，让内容区 React 错误页可见；
  // 工具栏仍保留，用户可后退 / 改地址 / 刷新。
  // hasError 来自 CrawlspaceContext（主进程 did-fail-load 写入），比本地
  // addressBarStatus 更稳——后者曾被同轮 navigation:state 竞态清掉。
  const pageLoadFailed = addressBarStatus === 'error' || viewHasError
  const pageLoadErrorSource =
    addressBarMessage || toolbarMessage || viewErrorDescription || null
  const pageLoadErrorCopy = resolvePageLoadErrorCopy({
    errorDescription: viewErrorDescription || addressBarMessage || toolbarMessage,
    fallbackMessage: pageLoadErrorSource,
    t: (key) => t(key),
  })
  // 侧栏 / 地址栏建议对网页容器的降级：webview 下 helper 恒返回 false（DOM
  // z-index 天然盖住，永不隐藏）；wcv 下侧栏打开或建议可见时必须隐藏原生视图
  // （见 browserSidePanelLayout 顶部注释）。resourcePanelAutoWidePreview（拖拽预览）
  // 期间 activeSidePanel 必为 'resource'，已被下面第一个判定覆盖，无需单列。
  const sidePanelDegradesWebview = shouldHideWebviewForSidePanel({
    panel: activeSidePanel,
    resourceViewMode: resourcePanelViewMode,
    containerMode: browserContainerModeForLayout,
  })
  const addressSuggestionsDegradeWebview = shouldHideWebviewForAddressSuggestions({
    visible: addressBarActive && suggestionsVisible,
    containerMode: browserContainerModeForLayout,
  })
  const viewDisplayActive = isActive
    && !pageLoadFailed
    && !sidePanelDegradesWebview
    && !addressSuggestionsDegradeWebview

  // ── Show/Hide Refs ──
  const showViewRef = useRef<((targetUrl?: string, boundsOverride?: Bounds) => void) | null>(null)
  const updateViewBoundsRef = useRef<UpdateViewBounds | null>(null)
  const lastShowBoundsSignatureRef = useRef<string | null>(null)
  const lastSetBoundsSignatureRef = useRef<string | null>(null)

  const readBoundsDiagnostic = useCallback(() => {
    const container = containerRef.current
    const slot = container?.closest('[data-crawl-view-slot]') ?? null
    const panel = container?.closest('[data-panel]') ?? null
    return {
      window: typeof window === 'undefined'
        ? null
        : {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            zoomFactor: getRendererZoomFactor(),
          },
      container: snapshotElementRect(container),
      slot: snapshotElementRect(slot),
      panel: snapshotElementRect(panel),
    }
  }, [])

  // ── View Display ──
  // : flag=webview 时把 WCV 显示 hook 置于 managedExternally——它的全部
  // effect（show/hide IPC、bounds 观察）都会空跑，等价于"这个 hook 不管显示"；
  // 显示驱动改由下方 useWebviewDisplay 承担。flag=wcv 时传入原值，行为不变。
  const { getSafeBounds, isSameBounds, lastBoundsRef } = useViewDisplay({
    tabId: tab.id,
    containerRef,
    showViewRef,
    updateViewBoundsRef,
    hostView,
    managedExternally: managedExternally || isWebviewContainer,
    isActive: viewDisplayActive,
    allowMultiple,
    overlayCount,
    crawlspaceId,
  })

  // : flag=webview 的显示驱动（flag=wcv 时 enabled=false 全部空跑）
  useWebviewDisplay({
    enabled: isWebviewContainer && !managedExternally,
    tabId: tab.id,
    containerRef,
    showViewRef,
    hostView,
    isActive: viewDisplayActive,
    overlayCount,
    crawlspaceId,
  })

  // showViewRef: 每次渲染更新闭包
  showViewRef.current = (targetUrl?: string, boundsOverride?: Bounds) => {
    if (managedExternally || !isActive || pageLoadFailed || !containerRef.current) return
    const bounds = getSafeBounds()
    const resolvedBounds = boundsOverride ?? bounds
    if (!resolvedBounds) return

    const { crawlspaceId: resolvedCrawlspaceId, profile, partition, runId } = resolveWorkspaceContext()
    const kind = resolvedCrawlspaceId ? 'workspace-view' : 'normal-view'
    const showSignature = toBoundsSignature(resolvedBounds, targetUrl ?? tab.url)
    if (isCrawlBoundsDebugEnabled() && lastShowBoundsSignatureRef.current !== showSignature) {
      boundsLog.info(
        `renderer 请求 show WebContentsView ${stringifyForBoundsLog({
          viewId: tab.id,
          url: targetUrl ?? tab.url,
          bounds: resolvedBounds,
          crawlspaceId: resolvedCrawlspaceId ?? null,
          kind,
          isActive,
          allowMultiple,
          diagnostic: readBoundsDiagnostic(),
        })}`,
      )
      lastShowBoundsSignatureRef.current = showSignature
    }
    if (globalThis.__TABTIN_DEBUG_VIEW_RELOAD__) {
      console.info('[DebugViewReload] renderer.show', {
        viewId: tab.id, requestedUrl: targetUrl ?? tab.url,
        tabUrl: tab.url, isActive, allowMultiple, managedExternally,
        crawlspaceId: resolvedCrawlspaceId ?? null, kind
      })
    }
    try {
      const viewOptions = buildViewOptions(resolvedCrawlspaceId, profile, partition)
      if (!viewOptions) {
        throw reportCrawlViewError({
          action: 'crawlView.show', message: t('embedded.errors.missingProfile'),
          viewId: tab.id, crawlspaceId: resolvedCrawlspaceId || undefined, profile, partition, kind
        })
      }
      if (!hostView?.show) {
        throw reportCrawlViewError({
          action: 'crawlView.show', message: t('embedded.errors.showUnavailable'),
          viewId: tab.id, crawlspaceId: resolvedCrawlspaceId || undefined, profile, partition, kind
        })
      }
      hostView.show(tab.id, targetUrl ?? tab.url, resolvedBounds, runId, viewOptions)
        .then((response) => {
          handleCrawlViewShowResponse(response as Parameters<typeof handleCrawlViewShowResponse>[0], {
            onSuccess: () => {
              lastBoundsRef.current = resolvedBounds
              touchView('show')
              if (spaceId) {
                const desiredKey = contextRegistry.buildTabKey('tabweb', tab.id)
                if (getActiveKeyNow() === desiredKey) {
                  setDisplayKey(browserScopeKey ?? spaceId, desiredKey)
                }
              }
            },
            // Wave 3 收尾 L-W3-6：deferred / skipped 语义是"未重建,只是放过这一次",
            // 不调 touchView / setDisplayKey，避免污染 view 的 lastAccessTime /
            // 资源使用统计。后续收敛靠 partition-rebuild-released 广播或用户驱动
            // 的下一轮 show（切 tab / resize / reload）。
            onDeferredOrSkipped: (kind, reason) => {
              if (isCrawlBoundsDebugEnabled()) {
                boundsLog.info(
                  `crawlView.show ${kind} → 跳过 touch/setDisplayKey 副作用 ${stringifyForBoundsLog({
                    viewId: tab.id,
                    kind,
                    reason,
                    crawlspaceId: resolvedCrawlspaceId ?? null,
                  })}`,
                )
              }
            },
            // Wave 3 Y1: partition 重建失败路径（destroy 失败 / show 失败）
            // renderer 没 toast 提示就只剩空白 + 红条根因再现。这里弹一条
            // 错误 toast 让用户知道发生了什么 + 给一个可执行建议（关闭重开）。
            onPartitionRebuildFailure: (detail) => {
              toast.error(
                t('embedded.errors.partitionRebuildFailed', { detail }),
                { duration: 8000 },
              )
            },
            onOtherFailure: (errorMsg) => {
              reportCrawlViewError({
                action: 'crawlView.show', message: t('embedded.errors.showFailed'),
                viewId: tab.id, crawlspaceId: resolvedCrawlspaceId || undefined, profile, partition, kind,
                error: new Error(errorMsg),
              })
            },
          })
        })
        .catch((error) => {
          reportCrawlViewError({
            action: 'crawlView.show', message: t('embedded.errors.showFailed'),
            viewId: tab.id, crawlspaceId: resolvedCrawlspaceId || undefined, profile, partition, kind, error
          })
        })
    } catch (error) {
      reportCrawlViewError({
        action: 'crawlView.show', message: t('embedded.errors.showPrecheckFailed'),
        viewId: tab.id, crawlspaceId: resolvedCrawlspaceId || undefined, profile, partition, kind, error
      })
    }
  }

  // ── Partition 变化驱动重建 ──
  //
  // 用户改 Space → BrowserEnvironment 绑定后,tabsSlice listener 会升级
  // store 中的 crawlspaceConfig.partition,触发 React re-render → CrawlViewPortalLayer
  // 用新 partition 重建 `tab` prop。但 useViewDisplay 的主 effect 不依赖
  // partition,默认情况下不会再次调用 showViewRef.current,主进程的 view 因此
  // 焊死在旧 partition(L-W2-4 / Wave 3 收尾)。
  //
  // 这条 effect 监听 partition 变化:
  //   - mount 时记录初值,不触发(useViewDisplay 的初次 show 已覆盖)
  //   - 后续每次 partition 字面量改变 → 强制调一次 showViewRef.current()
  //   - 主进程 ipc-handlers 检测到 partition 不一致 → destroy 旧 view +
  //     用新 partition 重建 + 广播 `crawl-view:partition-rebuilt` 弹 toast
  //
  // 收敛说明:
  //   - 主进程返回 `deferred: 'run-in-progress'` (B1):view 焊死在旧 partition
  //     直到 run 结束 + 用户后续操作（切 tab / resize / reload）触发新一轮
  //     show。Wave 3 不订阅 onRunEnded(避免改 RunSessionManager API);
  //     dogfood 期可接受"用户驱动收敛"。
  //   - 主进程返回 `skipped: 'rebuild-in-flight'` (B2 上半):依赖
  //     `crawl-view:partition-rebuild-released` 广播触发再 show。
  //   - 主进程在锁释放时无条件 broadcast `partition-rebuild-released`,
  //     EmbeddedCrawlView 的另一个 effect 监听该广播完成最终收敛。
  const lastObservedPartitionRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (managedExternally || !isActive) return
    const partition = tab.metadata?.partition
    if (!partition) return
    if (lastObservedPartitionRef.current === undefined) {
      // 初次记录,主 effect 已经做了 show
      lastObservedPartitionRef.current = partition
      return
    }
    if (lastObservedPartitionRef.current === partition) return
    lastObservedPartitionRef.current = partition
    // 等本次渲染落定后再调,确保 showViewRef.current 已用新闭包(含新 partition)更新
    Promise.resolve().then(() => {
      showViewRef.current?.()
    })
  }, [tab.metadata?.partition, managedExternally, isActive])

  // ── B2 收敛：监听主进程 partition 重建锁释放事件 ──
  //
  // 用户连续切 env A→B→C 时主进程只串行处理一次 (A→B)，第二次 show 撞锁
  // 返回 skipped。锁释放时主进程广播 actualPartition（实际重建到的 partition），
  // renderer 比对**当前**（最新）store partition：
  //   - 一致 → 已收敛，无需操作（用户没在重建期间再改）
  //   - 不一致 → 用户在重建期间又改了 env，主动再发一次 show 触发新一轮
  //
  // 用 ref 持有最新 partition 避免 effect 闭包陈旧；effect 只挂载/卸载一次（依
  // tab.id），ref 跟随 React render 同步更新即可读到最新值。
  const tabPartitionRef = useRef<string | undefined>(undefined)
  tabPartitionRef.current = tab.metadata?.partition
  useEffect(() => {
    if (managedExternally || !isActive) return
    const onReleased = window.tabtin?.crawlView?.onPartitionRebuildReleased
    if (typeof onReleased !== 'function') return
    const unsub = onReleased(({ tabId, actualPartition }) => {
      if (tabId !== tab.id) return
      const currentPartition = tabPartitionRef.current
      if (!currentPartition) return
      if (currentPartition === actualPartition) return  // 已经一致
      // 不一致 → 主动再触发一次 show，主进程会用最新 partition 重建
      Promise.resolve().then(() => {
        showViewRef.current?.()
      })
    })
    return () => {
      try { unsub() } catch { /* ignore */ }
    }
  }, [tab.id, managedExternally, isActive])

  updateViewBoundsRef.current = (force = false) => {
    if (managedExternally || !isActive) {
      logCrawlBoundsProbe('skip setViewBounds inactive', {
        viewId: tab.id,
        force,
        managedExternally,
        isActive,
        diagnostic: readBoundsDiagnostic(),
      })
      return
    }
    const bounds = getSafeBounds()
    if (!bounds) {
      logCrawlBoundsProbe('skip setViewBounds no-bounds', {
        viewId: tab.id,
        force,
        diagnostic: readBoundsDiagnostic(),
      })
      return
    }
    if (!force && isSameBounds(lastBoundsRef.current, bounds)) {
      logCrawlBoundsProbe('skip setViewBounds same-bounds', {
        viewId: tab.id,
        force,
        bounds,
        previousSynced: lastBoundsRef.current,
        diagnostic: readBoundsDiagnostic(),
      })
      return
    }
    if (!hostView?.setViewBounds) {
      logCrawlBoundsProbe('skip setViewBounds unavailable', {
        viewId: tab.id,
        force,
        bounds,
        diagnostic: readBoundsDiagnostic(),
      })
      return
    }
    const setSignature = toBoundsSignature(bounds)
    if (isCrawlBoundsDebugEnabled() && lastSetBoundsSignatureRef.current !== setSignature) {
      boundsLog.info(
        `renderer 请求 setViewBounds ${stringifyForBoundsLog({
          viewId: tab.id,
          bounds,
          force,
          crawlspaceId: crawlspaceId ?? null,
          isActive,
          overlayCount,
          diagnostic: readBoundsDiagnostic(),
        })}`,
      )
      lastSetBoundsSignatureRef.current = setSignature
    }
    hostView.setViewBounds(tab.id, bounds)
      .then((response) => {
        const applied = (response as { applied?: Bounds } | undefined)?.applied
        logCrawlBoundsProbe('setViewBounds applied', {
          viewId: tab.id,
          force,
          requested: bounds,
          response,
          previousSynced: lastBoundsRef.current,
          diagnostic: readBoundsDiagnostic(),
        })
        lastBoundsRef.current = applied ?? bounds
        touchView('setBounds')
      })
      .catch((error) => {
        logCrawlBoundsProbe('setViewBounds failed', {
          viewId: tab.id,
          force,
          requested: bounds,
          previousSynced: lastBoundsRef.current,
          diagnostic: readBoundsDiagnostic(),
          error,
        })
        handleError('setViewBounds')(error)
      })
  }

  // ── Navigation Actions ──
  const resolvedCurrentUrl = (navigationState.url || tab.url || '').trim()

  const navActions = useMemo(
    () => createNavigationActions({
      tabId: tab.id,
      tabUrl: tab.url,
      hostView,
      containerRef,
      updateViewBoundsRef,
      overlayCount,
      t,
      resolveWorkspaceContext,
      buildViewOptions,
      updateLocation,
      stateSetter: {
        setAddressBarStatus,
        setAddressBarMessage,
        setToolbarMessage,
        navigationState,
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.id, tab.url, hostView, overlayCount, t, resolveWorkspaceContext, buildViewOptions, updateLocation]
  )
  const autocompleteAddressInput = useCallback(
    (value: string) => normalizeBrowserAddressInput(value, searchEngine),
    [searchEngine],
  )

  const handleInteraction = useCallback(() => { onInteraction?.() }, [onInteraction])

  // ── Downloads & browsing history (global crawlView event listeners) ──
  const downloadActiveCount = useDownloadStore(state => state.activeCount)
  const downloadInitialize = useDownloadStore(state => state.initialize)
  const browsingHistoryInitialize = useBrowsingHistoryStore(state => state.initialize)

  useEffect(() => { downloadInitialize() }, [downloadInitialize])
  useEffect(() => { browsingHistoryInitialize() }, [browsingHistoryInitialize])
  const prevIsActiveRef = useRef(isActive)
  useEffect(() => {
    const wasActive = prevIsActiveRef.current
    prevIsActiveRef.current = isActive

    if (!isActive) {
      setActiveSidePanel(null)
    } else if (!wasActive) {
      // Tab 刚被激活，同步当前页面上下文给 TinManager
      const url = navigationState.url || tab.url || ''
      if (url) {
        window.tabtin?.tins?.syncPageContext?.({
          url,
          title: navigationState.title ?? '',
        })
      }
    }
  }, [isActive, navigationState.url, navigationState.title, tab.url])

  // 覆盖模式下侧栏是绝对定位浮层，开合不再改变 containerRef 的几何尺寸，
  // 因此只需在 isActive 变化时兜底 sync 一次；不必再依赖 activeSidePanel /
  // resourcePanelViewMode（它们不影响 container 宽高）。
  useEffect(() => {
    if (!isActive) return
    const rafId = window.requestAnimationFrame(() => {
      updateViewBoundsRef.current?.()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [isActive])

  const handleToggleResources = useCallback(() => {
    setActiveSidePanel(current => current === 'resource' ? null : 'resource')
  }, [])

  const handleToggleTins = useCallback(() => {
    if (!TINS_UI_ENABLED) return
    setActiveSidePanel(current => current === 'tins' ? null : 'tins')
  }, [])

  const handleToggleResourcePanelViewMode = useCallback(() => {
    setResourcePanelViewMode(current => {
      if (current === 'wide') {
        setResourcePanelWidth(RESOURCE_PANEL_DEFAULT_WIDTH_PX)
        return 'narrow'
      }
      return 'wide'
    })
  }, [])

  const handleResourcePanelResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resourcePanelOpen || resourcePanelViewMode !== 'narrow') return
    const contentRect = contentAreaRef.current?.getBoundingClientRect()
    if (!contentRect) return
    const contentRight = contentRect.right
    const contentWidth = contentRect.width

    event.preventDefault()
    event.stopPropagation()
    resourcePanelResizeCleanupRef.current?.()

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    let cleanedUp = false
    function resetAutoWidePreview() {
      resourcePanelShouldAutoWideRef.current = false
      setResourcePanelAutoWidePreview(false)
      setResourcePanelAutoWidePreviewWidth(0)
    }

    function cleanupResize(resetPreview = true) {
      if (cleanedUp) return
      cleanedUp = true
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('blur', handlePointerCancel)
      if (resourcePanelResizeCleanupRef.current === cleanupResize) {
        resourcePanelResizeCleanupRef.current = null
      }
      if (resetPreview) {
        resetAutoWidePreview()
      }
    }

    // 覆盖模式下 aside 是绝对定位浮层，不挤压 containerRef 宽度——拖拽窄栏
    // 期间不再调 hostView.hide / updateViewBoundsRef 去收缩或重算网页几何。
    // wcv 下的真实隐藏已经由 viewDisplayActive → shouldHideWebviewForSidePanel
    // 统一收口（侧栏打开即隐藏，不区分窄/宽/拖拽中），无需在此散落 hide 调用。
    function syncWidthFromPointer(clientX: number) {
      const requestedWidth = clampResourcePanelWidth(contentRight - clientX)
      const remainingBrowserWidth = contentWidth - requestedWidth
      const shouldAutoWide = remainingBrowserWidth < BROWSER_VIEW_MIN_WIDTH_BEFORE_RESOURCE_WIDE_PX

      resourcePanelShouldAutoWideRef.current = shouldAutoWide
      setResourcePanelAutoWidePreview(shouldAutoWide)
      setResourcePanelAutoWidePreviewWidth(Math.max(0, remainingBrowserWidth))
      setResourcePanelWidth(requestedWidth)
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      syncWidthFromPointer(moveEvent.clientX)
    }

    function handlePointerUp() {
      const shouldAutoWide = resourcePanelShouldAutoWideRef.current
      cleanupResize()
      if (shouldAutoWide) {
        setResourcePanelViewMode('wide')
      }
      updateViewBoundsRef.current?.(true)
    }

    function handlePointerCancel() {
      cleanupResize()
      updateViewBoundsRef.current?.(true)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('blur', handlePointerCancel)
    resourcePanelResizeCleanupRef.current = cleanupResize
    syncWidthFromPointer(event.clientX)
  }, [resourcePanelOpen, resourcePanelViewMode])

  useEffect(() => {
    if (isActive && resourcePanelOpen && resourcePanelViewMode === 'narrow') return
    resourcePanelResizeCleanupRef.current?.()
  }, [isActive, resourcePanelOpen, resourcePanelViewMode])

  useEffect(() => {
    if (resourcePanelOpen && resourcePanelViewMode === 'narrow') return
    setResourcePanelResizeHandleHover(false)
    setResourcePanelViewToggleHover(false)
  }, [resourcePanelOpen, resourcePanelViewMode])

  useEffect(() => {
    return () => {
      resourcePanelResizeCleanupRef.current?.(false)
    }
  }, [])

  const handleCloseSidePanel = useCallback(() => {
    setActiveSidePanel(null)
  }, [])

  const handleOpenDownloads = useCallback(() => {
    const tabsState = useSpaceContextTabsStore.getState()
    const scopeKey = spaceId
      ? resolveForegroundTabScopeKey(spaceId)
      : Object.keys(tabsState.activeKeyBySpace)[0]
        || Object.keys(tabsState.tabOrderBySpace)[0]
        || Object.keys(tabsState.itemsBySpace)[0]

    if (!scopeKey) {
      toast({ title: t('downloads.noSpace', '请先打开一个组织'), variant: 'destructive' })
      return
    }
    useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
      type: 'tindownloads',
      id: 'downloads',
      title: t('downloads.title', '下载管理'),
    })
  }, [spaceId, t])

  /**
   * 工具栏「主页」：打开主页页签。
   * - 已配置自定义主页 URL → 新开网页标签并导航到该地址
   * - 主页为「新标签页」（空）→ 打开浏览器起始页（搜索 / 书签 / 设置，见图一）
   */
  const handleOpenHome = useCallback(() => {
    const tabsState = useSpaceContextTabsStore.getState()
    const scopeKey = browserScopeKey
      || (spaceId ? resolveForegroundTabScopeKey(spaceId) : null)
      || Object.keys(tabsState.activeKeyBySpace)[0]
      || Object.keys(tabsState.tabOrderBySpace)[0]
      || Object.keys(tabsState.itemsBySpace)[0]

    if (!scopeKey || !spaceId) {
      toast({ title: t('downloads.noSpace', '请先打开一个组织'), variant: 'destructive' })
      return
    }

    void openBrowserHomeInSpace(spaceId, { tabScopeKey: scopeKey }).then((result) => {
      if (!result.ok) {
        toast({
          title: i18n.t('error.createWebTabFailed', { ns: 'context' }),
          description: result.error,
          variant: 'destructive',
        })
      }
    })
  }, [browserScopeKey, spaceId, t])

  // ── Bookmark ──
  const currentUrlForBookmark = resolvedCurrentUrl
  const isCurrentBookmarked = useBookmarkStore(s =>
    currentUrlForBookmark && currentUrlForBookmark !== 'about:blank'
      ? s.isBookmarked(currentUrlForBookmark)
      : false,
  )
  const handleToggleBookmark = useCallback(() => {
    if (!currentUrlForBookmark || currentUrlForBookmark === 'about:blank') return
    useBookmarkStore.getState().toggleBookmark(
      currentUrlForBookmark,
      navigationState.title || currentUrlForBookmark,
      undefined,
    )
  }, [currentUrlForBookmark, navigationState.title])

  useEffect(() => {
    const unsubscribe = window.tabtin?.contextMenu?.onAddToContextRequest?.(({ viewId, selectionText }) => {
      if (viewId !== tab.id) return
      const url = navigationState.url || tab.url || ''
      if (!url || url === 'about:blank') return
      void quoteBrowserSelectionToChat({
        text: selectionText,
        url,
        viewId: tab.id,
        title: navigationState.title || url,
        t: (key, defaultValue) => t(key, defaultValue),
      })
    })
    return unsubscribe
  }, [tab.id, tab.url, navigationState.url, navigationState.title, t])

  // ── Address Bar Suggestions ──
  // suggestionsVisible / addressBarActive 已提前声明在组件顶部（供 viewDisplayActive 用）
  const [suggestionsQuery, setSuggestionsQuery] = useState('')
  const [addressBarCommit, setAddressBarCommit] = useState<{ url: string; version: number } | null>(null)
  const [addressBarBlurVersion, setAddressBarBlurVersion] = useState(0)
  const [browserAnnotationPicking, setBrowserAnnotationPicking] = useState(false)
  const [browserScreenshotPicking, setBrowserScreenshotPicking] = useState(false)
  const suggestionsBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolbarWrapperRef = useRef<HTMLDivElement | null>(null)
  const [toolbarWrapperEl, setToolbarWrapperEl] = useState<HTMLDivElement | null>(null)
  const setToolbarWrapperNode = useCallback((node: HTMLDivElement | null) => {
    toolbarWrapperRef.current = node
    setToolbarWrapperEl(node)
  }, [])

  const forceSyncViewBoundsBurst = useCallback(() => {
    updateViewBoundsRef.current?.(true)
    requestAnimationFrame(() => {
      updateViewBoundsRef.current?.(true)
      setTimeout(() => updateViewBoundsRef.current?.(true), 50)
      setTimeout(() => updateViewBoundsRef.current?.(true), 150)
    })
  }, [])

  const requestAddressBarBlur = useCallback(() => {
    if (suggestionsBlurTimerRef.current) {
      clearTimeout(suggestionsBlurTimerRef.current)
      suggestionsBlurTimerRef.current = null
    }
    setAddressBarActive(false)
    setSuggestionsVisible(false)
    setSuggestionsQuery('')
    setAddressBarBlurVersion(prev => prev + 1)
    forceSyncViewBoundsBurst()
  }, [forceSyncViewBoundsBurst])

  const handleUrlInputFocus = useCallback(() => {
    if (suggestionsBlurTimerRef.current) {
      clearTimeout(suggestionsBlurTimerRef.current)
      suggestionsBlurTimerRef.current = null
    }
    setAddressBarActive(true)
    setSuggestionsVisible(true)
    setSuggestionsQuery(resolvedCurrentUrl || '')
  }, [resolvedCurrentUrl])

  const handleUrlInputBlur = useCallback(() => {
    suggestionsBlurTimerRef.current = setTimeout(() => {
      setSuggestionsVisible(false)
      setSuggestionsQuery('')
      setAddressBarActive(false)
      forceSyncViewBoundsBurst()
    }, 200)
  }, [forceSyncViewBoundsBurst])

  const handleUrlInputChange = useCallback((value: string) => {
    if (suggestionsBlurTimerRef.current) {
      clearTimeout(suggestionsBlurTimerRef.current)
      suggestionsBlurTimerRef.current = null
    }
    setAddressBarActive(true)
    setSuggestionsVisible(true)
    setSuggestionsQuery(value)
  }, [])

  const handleSuggestionSelect = useCallback((url: string) => {
    setAddressBarCommit(prev => ({ url, version: (prev?.version ?? 0) + 1 }))
    setAddressBarActive(false)
    setSuggestionsVisible(false)
    setSuggestionsQuery(url)
    forceSyncViewBoundsBurst()
    navActions.handleNavigate(url)
  }, [forceSyncViewBoundsBurst, navActions])

  const handleStartBrowserAnnotation = useCallback(async (includeScreenshot = false) => {
    const url = navigationState.url || tab.url || ''
    if (!url || url === 'about:blank') {
      toast({ title: t('quoteSelection.captureFailed', '无法截取网页注释'), variant: 'destructive' })
      return
    }
    if (includeScreenshot) {
      setBrowserScreenshotPicking(true)
    } else {
      setBrowserAnnotationPicking(true)
    }
    try {
      await startBrowserAnnotationToChat({
        url,
        viewId: tab.id,
        title: navigationState.title || url,
        includeScreenshot,
        t: (key, defaultValue) => t(key, defaultValue),
      })
    } finally {
      if (includeScreenshot) {
        setBrowserScreenshotPicking(false)
      } else {
        setBrowserAnnotationPicking(false)
      }
    }
  }, [navigationState.title, navigationState.url, tab.id, tab.url, t])

  const handleCaptureBrowserViewport = useCallback(async () => {
    const url = navigationState.url || tab.url || ''
    if (!url || url === 'about:blank') {
      toast({ title: t('quoteSelection.captureFailed', '无法截取网页注释'), variant: 'destructive' })
      return
    }
    setBrowserScreenshotPicking(true)
    try {
      await captureBrowserViewportToChat({
        url,
        viewId: tab.id,
        title: navigationState.title || url,
        t: (key, defaultValue) => t(key, defaultValue),
      })
    } finally {
      setBrowserScreenshotPicking(false)
    }
  }, [navigationState.title, navigationState.url, tab.id, tab.url, t])

  const handleCancelBrowserAnnotation = useCallback(async () => {
    const cancelled = await cancelBrowserAnnotationToChat(tab.id)
    if (!cancelled) return
    setBrowserAnnotationPicking(false)
    setBrowserScreenshotPicking(false)
  }, [tab.id])

  useScopedEventListener<KeyboardEvent>(
    typeof window !== 'undefined' ? window : null,
    'keydown',
    (event) => {
      if (!browserAnnotationPicking) return
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      void handleCancelBrowserAnnotation()
    },
    { enabled: browserAnnotationPicking, capture: true, scope: 'foreground' },
  )

  const resolvedToolbarThemeColor = typeof tab.metadata?.toolbarColor === 'string'
    ? tab.metadata.toolbarColor
    : undefined

  useLayoutEffect(() => {
    updateViewBoundsRef.current?.(true)
  }, [addressBarCommit?.version, addressBarBlurVersion])

  useScopedResizeObserver(toolbarWrapperEl, () => {
    updateViewBoundsRef.current?.(true)
    requestAnimationFrame(() => { updateViewBoundsRef.current?.(true) })
  }, { enabled: isActive })

  // 侧栏 / 拖拽预览 portal 到 body：几何跟随 content 区（盖住 WebviewManager 稳定层）
  useLayoutEffect(() => {
    if (!isActive || (!activeSidePanel && !resourcePanelAutoWidePreview)) {
      setContentAreaRect(null)
      return
    }
    const sync = () => {
      const el = contentAreaRef.current
      if (!el) {
        setContentAreaRect(null)
        return
      }
      const rect = el.getBoundingClientRect()
      setContentAreaRect({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      })
    }
    sync()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    if (contentAreaRef.current) ro?.observe(contentAreaRef.current)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [
    isActive,
    activeSidePanel,
    resourcePanelAutoWidePreview,
    resourcePanelViewMode,
    resourcePanelWidth,
  ])

  const isBrowserOverlayTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) return false
    if (toolbarWrapperRef.current?.contains(target)) return true
    if (target instanceof Element) {
      if (target.closest('[data-testid="address-bar-suggestions"]')) return true
      if (target.closest('[data-testid="browser-resource-side-panel"]')) return true
      if (target.closest('[data-browser-side-panel="tins"]')) return true
    }
    return false
  }, [])

  useEffect(() => {
    if (!isActive) {
      requestAddressBarBlur()
      return
    }
    forceSyncViewBoundsBurst()
  }, [forceSyncViewBoundsBurst, isActive, requestAddressBarBlur])

  // Wave 2c：用 React 19.2 `<Activity>` 替换原先的 `hidden` className —— 同
  // crawlspace 内多 tab 切换时，非 active tab 的整棵 return 子树 effect 自动
  // cleanup，而不只是 DOM `display:none` 让 effect 继续 zombie 跑。
  //
  // ## 为什么 EmbeddedCrawlView 必须自己包 Activity（不能靠上层）
  //
  // EmbeddedCrawlView 的 React 父级是 CrawlViewPortalLayer（在 ContentArea-
  // PortalHost 下，与 SpaceWorkbenchHost 是**兄弟子树**），**不在** Space-
  // WorkbenchHost 的 Activity 子树内——hot Space 切走时 SpaceWorkbenchHost
  // 的 Activity hidden 沿 React 树**覆盖不到**这里。所以本组件必须自己包
  // 独立 Activity；切换路径是：Space 切走 → CrawlspaceWorkspace 子树 cleanup
  // → CrawlViewPortalHost unregister slot → CrawlViewPortalLayer 重算 slot-
  // Targets → 给本组件传入 isActive=false → 本组件内 Activity hidden →
  // return 子树 effect cleanup。
  //
  // ## Activity 仅覆盖 return 子树——顶层 hooks **不在** Activity 控制内
  //
  // 顶层 hooks（`useViewDisplay`、`useNavigationEvents` 等）**在 return 之前**调用，position
  // 上**在 Activity 包装外**——它们的 effect 不被 Activity hidden 触发的
  // cleanup 所覆盖，而是依然由 props.isActive 这个值变化驱动 cleanup/setup。
  //
  // 因此组件内部所有 `if (!isActive) return` / `if (managedExternally || !
  // isActive) return` 之类的 isActive 守卫**不是冗余防御**——它们是顶层
  // hook 控制 BrowserView 主进程资源（hide/show IPC、bounds 更新、navigation
  // event listener）的**主路径**。删守卫 = 主进程资源泄漏。
  //
  // BrowserView 由主进程持有，`useViewDisplay` 的 hide IPC 跟 React 调度链
  // 独立——isActive 从 true 变 false 时 useViewDisplay 主 effect 重跑进入
  // !isActive 分支 → 调主进程 hide（不销毁）；下次 isActive=true 时 effect
  // 重跑触发 show 重显。这条路径完全在 Activity 包装之外完成。
  return (
    <>
    <Activity mode={isActive ? 'visible' : 'hidden'}>
      <div
        ref={paneRef}
        className="w-full h-full min-h-0 flex flex-col bg-transparent"
        onPointerDownCapture={(event) => {
          handleInteraction()
          if (!isBrowserOverlayTarget(event.target)) {
            requestAddressBarBlur()
          }
        }}
        onFocusCapture={(event) => {
          handleInteraction()
          if (!isBrowserOverlayTarget(event.target)) {
            requestAddressBarBlur()
          }
        }}
        onKeyDownCapture={handleInteraction}
      >
      <div ref={setToolbarWrapperNode} className="relative flex-shrink-0">
        <CrawlspaceToolbar
          onNavigate={navActions.handleNavigate}
          onBack={navActions.handleGoBack}
          onForward={navActions.handleGoForward}
          onRefresh={navActions.handleReload}
          onHome={handleOpenHome}
          onStop={navActions.handleStop}
          canGoBack={navigationState.canGoBack}
          canGoForward={navigationState.canGoForward}
          isLoading={navigationState.isLoading}
          currentUrl={resolvedCurrentUrl}
          isSecure={resolvedCurrentUrl.startsWith('https://')}
          autocompleteUrl={autocompleteAddressInput}
          themeColor={resolvedToolbarThemeColor}
          onLayoutChange={() => updateViewBoundsRef.current?.(true)}
          downloadCount={downloadActiveCount}
          onOpenDownloads={handleOpenDownloads}
          resourceCount={resourceSummary?.total ?? 0}
          resourcePanelOpen={resourcePanelOpen}
          onToggleResources={handleToggleResources}
          tinsActiveCount={tinsActiveCount}
          tinsPanelOpen={tinsPanelOpen}
          onToggleTins={TINS_UI_ENABLED ? handleToggleTins : undefined}
          hostActive={isActive}
          actions={
            <BrowserToolbarWideActions
              viewId={tab.id}
              browserAnnotationPicking={browserAnnotationPicking}
              browserScreenshotPicking={browserScreenshotPicking}
              currentUrlForBookmark={currentUrlForBookmark}
              isCurrentBookmarked={isCurrentBookmarked}
              onToggleAnnotation={() => {
                void (browserAnnotationPicking
                  ? handleCancelBrowserAnnotation()
                  : handleStartBrowserAnnotation(false))
              }}
              onCaptureScreenshot={() => {
                void handleCaptureBrowserViewport()
              }}
              onToggleBookmark={handleToggleBookmark}
            />
          }
          actionsMenu={
            <BrowserToolbarActionsMenu
              viewId={tab.id}
              browserAnnotationPicking={browserAnnotationPicking}
              browserScreenshotPicking={browserScreenshotPicking}
              currentUrlForBookmark={currentUrlForBookmark}
              isCurrentBookmarked={isCurrentBookmarked}
              onToggleAnnotation={() => {
                void (browserAnnotationPicking
                  ? handleCancelBrowserAnnotation()
                  : handleStartBrowserAnnotation(false))
              }}
              onCaptureScreenshot={() => {
                void handleCaptureBrowserViewport()
              }}
              onToggleBookmark={handleToggleBookmark}
            />
          }
          onUrlInputFocus={handleUrlInputFocus}
          onUrlInputBlur={handleUrlInputBlur}
          onUrlInputChange={handleUrlInputChange}
          externalCommittedUrl={addressBarCommit?.url}
          externalCommitVersion={addressBarCommit?.version}
          externalBlurVersion={addressBarBlurVersion}
        />
        <AddressBarSuggestions
          query={suggestionsQuery}
          onSelect={handleSuggestionSelect}
          visible={isActive && addressBarActive && suggestionsVisible}
          anchorRef={toolbarWrapperRef}
        />
      </div>

      {toolbarMessage && !pageLoadFailed && (
        <div className="px-4 py-1 text-body text-destructive bg-destructive/10 border-b border-destructive/20 no-drag">
          {toolbarMessage}
        </div>
      )}

      <div
        ref={contentAreaRef}
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        <div
          ref={containerRef}
          //  flag=webview：guest 表面在系统层独立收真实鼠标（宿主 document
          // 收不到，见 crawl-view-mouse-passthrough-depth.ts），mx-0.5 时表面右缘
          // 与 Shell 分隔条手柄（w-1，贴卡片内边缘）重叠 2px，手柄实际可抓区只剩
          // ~2px（伸向卡外的命中外扩被卡片 overflow-hidden 裁掉）——光标闪动、
          // 拖不动。多让 2px 使表面完全退出手柄竖带，恢复 4px 全宽可抓。
          // 2026-07-17 hitmap 实测：webview 右缘 998 vs 手柄 996~1000。
          // flag=wcv 保持 mx-0.5 原样。
          //
          // 侧栏改为绝对定位浮层覆盖（browserSidePanelLayout）后，本容器永远
          // 占满 content 全宽——不再因宽视图 resourcePanelWide 加 `hidden`。
          // wcv 下真正的隐藏改由 viewDisplayActive（shouldHideWebviewForSidePanel /
          // shouldHideWebviewForAddressSuggestions）驱动 hostView.hide，
          // webview 下浮层用 z-index 盖住即可，容器 DOM 本身永不消失。
          className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${isWebviewContainer ? 'mx-1' : 'mx-0.5'}`}
        >
          {pageLoadFailed ? (
            <div
              className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background px-6 text-body text-muted-foreground"
              data-testid="browser-page-load-error"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                <svg className="h-5 w-5 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <p className="text-body font-medium text-foreground">{pageLoadErrorCopy.title}</p>
              <p className="max-w-[300px] text-center text-body">
                {pageLoadErrorCopy.message}
              </p>
              <button
                type="button"
                className="mt-2 rounded-md border border-border bg-background px-4 py-2 text-body transition-colors hover:bg-muted"
                onClick={() => { void navActions.handleReload() }}
              >
                {t('workspace.reload')}
              </button>
            </div>
          ) : !hasLoadedOnce ? (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Globe className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p className="text-body">{t('embedded.loading')}</p>
              </div>
            </div>
          ) : null}
        </div>

        {isActive &&
          resourcePanelAutoWidePreview &&
          contentAreaRect &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              className="pointer-events-none fixed z-modal flex items-center justify-center border-2 border-primary/60 bg-primary/15 px-3 text-center text-body font-medium text-primary shadow-inner backdrop-blur-sm"
              style={{
                top: contentAreaRect.top,
                left: contentAreaRect.left,
                width: resourcePanelAutoWidePreviewWidth,
                height: contentAreaRect.height,
              }}
              data-testid="browser-resource-auto-wide-preview"
            >
              {t('resourceCenter.autoWidePreview', '松开后切换到宽视图')}
            </div>,
            document.body,
          )}

        {isActive &&
          activeSidePanel &&
          contentAreaRect &&
          typeof document !== 'undefined' &&
          createPortal(
            <aside
              // portal 到 body + fixed/z-modal，才能盖过 WebviewManager 稳定层（z=10）
              className={getBrowserSidePanelPositionClassName({
                panel: activeSidePanel,
                resourceViewMode: resourcePanelViewMode,
              })}
              style={getBrowserSidePanelPortalStyle({
                contentRect: contentAreaRect,
                panel: activeSidePanel,
                resourceViewMode: resourcePanelViewMode,
                resourcePanelWidth,
              })}
              data-testid={activeSidePanel === 'resource' ? 'browser-resource-side-panel' : undefined}
              data-browser-side-panel={activeSidePanel}
            >
              {activeSidePanel === 'resource' && resourcePanelViewMode === 'narrow' && (
                <div
                  className={`absolute inset-y-0 left-0 z-sticky cursor-col-resize ${
                    resourcePanelResizeHandleHover && !resourcePanelViewToggleHover
                      ? 'bg-primary/20'
                      : 'bg-transparent'
                  }`}
                  style={{ width: RESOURCE_PANEL_RESIZE_HANDLE_WIDTH_PX }}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('resourceCenter.resizeHandle', 'Resize resource center')}
                  title={t('resourceCenter.resizeHandle', 'Resize resource center')}
                  onPointerEnter={() => setResourcePanelResizeHandleHover(true)}
                  onPointerLeave={() => {
                    setResourcePanelResizeHandleHover(false)
                    setResourcePanelViewToggleHover(false)
                  }}
                  onMouseEnter={() => setResourcePanelResizeHandleHover(true)}
                  onMouseLeave={() => {
                    setResourcePanelResizeHandleHover(false)
                    setResourcePanelViewToggleHover(false)
                  }}
                  onPointerDown={handleResourcePanelResizeStart}
                  data-testid="browser-resource-resize-handle"
                >
                  <button
                    type="button"
                    className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-r bg-muted/60 text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                    style={{
                      width: RESOURCE_VIEW_MODE_TOGGLE_WIDTH_PX,
                      height: RESOURCE_VIEW_MODE_TOGGLE_HEIGHT_PX,
                    }}
                    onPointerEnter={() => setResourcePanelViewToggleHover(true)}
                    onPointerLeave={() => setResourcePanelViewToggleHover(false)}
                    onMouseEnter={() => setResourcePanelViewToggleHover(true)}
                    onMouseLeave={() => setResourcePanelViewToggleHover(false)}
                    onMouseOver={(event) => {
                      event.stopPropagation()
                      setResourcePanelViewToggleHover(true)
                    }}
                    onMouseOut={(event) => {
                      event.stopPropagation()
                      setResourcePanelViewToggleHover(false)
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      handleToggleResourcePanelViewMode()
                    }}
                    title={t('resourceCenter.actions.switchToWideView', 'Switch to wide view')}
                    aria-label={t('resourceCenter.actions.switchToWideView', 'Switch to wide view')}
                    data-testid="browser-resource-view-mode-toggle"
                  >
                    <span
                      aria-hidden="true"
                      style={getResourceViewModeTriangleStyle(resourcePanelViewMode)}
                    />
                  </button>
                </div>
              )}
              {activeSidePanel === 'resource' && resourcePanelViewMode === 'wide' && (
                <button
                  type="button"
                  className="absolute left-0 top-1/2 z-sticky flex -translate-y-1/2 items-center justify-center rounded-r bg-muted/60 text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                  style={{
                    width: RESOURCE_VIEW_MODE_TOGGLE_WIDTH_PX,
                    height: RESOURCE_VIEW_MODE_TOGGLE_HEIGHT_PX,
                  }}
                  onClick={handleToggleResourcePanelViewMode}
                  title={t('resourceCenter.actions.switchToNarrowView', 'Switch to narrow view')}
                  aria-label={t('resourceCenter.actions.switchToNarrowView', 'Switch to narrow view')}
                  data-testid="browser-resource-view-mode-toggle"
                >
                  <span
                    aria-hidden="true"
                    style={getResourceViewModeTriangleStyle(resourcePanelViewMode)}
                  />
                </button>
              )}
              {activeSidePanel === 'resource' ? (
                <BrowserResourceCenter
                  viewId={tab.id}
                  open={resourcePanelOpen}
                  onClose={handleCloseSidePanel}
                  summary={resourceSummary}
                />
              ) : (
                <TinsSidePanel
                  open={tinsPanelOpen}
                  onClose={handleCloseSidePanel}
                  spaceId={spaceId ?? undefined}
                />
              )}
            </aside>,
            document.body,
          )}
      </div>
      </div>
    </Activity>
    {/* 锁膜必须在 Activity 外：切走标签时 Activity 会把面板收成 0×0 并拆掉 effect，膜量到空尺寸就再也出不来。 */}
    <AgentBrowserLockOverlay paneRef={paneRef} viewId={tab.id} isActive={isActive} spaceId={spaceId ?? null} />
    </>
  )
}
