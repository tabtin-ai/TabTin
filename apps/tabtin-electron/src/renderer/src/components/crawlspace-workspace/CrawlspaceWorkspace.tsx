/**
 * CrawlspaceWorkspace - 统一抓取工作区容器
 *
 * 🔔 核心设计：
 * - 这是一个统一的 Crawlspace 容器组件
 * - 根据 crawlspaceConfig.pluginId 选择对应插件（可选）
 * - 内部统一使用 CrawlspaceShell
 *
 * 🏗️ 架构说明：
 * - 核心责任：为不同业务模式配置和注入插件到 CrawlspaceShell
 * - 业务逻辑全部委托给对应的 Plugin
 *
 * 📚 支持插件：根据 pluginId 动态加载
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CrawlspaceShell } from '@tabtin/crawlspace-core'
import type { ViewInfo } from '@tabtin/crawlspace-core'
import { createElectronIpcAdapter, useCrawlspaceContextAdapter } from './hooks/useCrawlSpaceViewManagerAdapter'
import { createWorkspaceRunGuard } from './workspaceRunGuard'
import { useAuthStore } from '@stores/useAuthStore'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { seedManager } from '@stores/seed-manager'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { contextRegistry } from '@components/context-space/registry'
import { useCanvasLayoutStore, type CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { CrawlViewPortalHost } from '../crawl/portal/CrawlViewPortalHost'
import type { CrawlspaceConfig } from '@stores/useCrawlTabStore'
import { isValidUrl } from '@tabtin/crawlspace-core'
import { useBrowserPrefsStore } from '@stores/useBrowserPrefsStore'
import { useTranslation } from 'react-i18next'
import { electronCrawlspaceHost } from '../../crawlspace/host/electron-crawlspace-host'
import {
  crawlspaceContextClient,
  type CrawlspaceViewSnapshot,
} from '../../crawlspace/electron/crawlspace-context-client'
import { startLayoutResizeTelemetry, trackLayoutTelemetry } from '@utils/layout/telemetry'
import { addClosedViewId } from '@stores/crawlTab/crawlspaceLifecycleSlice'
import { createLogger } from '@/utils/logger'
import { normalizeBrowserAddressInput } from '@/utils/browserAddressInput'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { DRAG_TYPE_TAB_META, DRAG_TYPE_TAB_REORDER } from '@/utils/split-coordinator'
import {
  activateBrowserView,
  cancelBrowserViewActivation,
  retryBrowserViewActivation,
  useBrowserViewActivationIntent,
  useBrowserViewActivationState,
} from '@/services/browserViewActivation'
import { BrowserViewRecoveryPanel } from '@components/context-space/registry/handlers/renderers/BrowserViewRecoveryPanel'
import { reconcileBrowserRestorePlaceholders } from './browserRestorePlaceholders'

const log = createLogger('CrawlWorkspace')

export interface CrawlspaceWorkspaceProps {
  crawlspaceId: string
  crawlspaceConfig: CrawlspaceConfig
  tabScopeKey?: string | null
  isActive?: boolean
}

const EMPTY_CANVAS_GROUPS: CanvasLayoutGroup[] = []

/**
 * 外层 wrapper：仅校验 config 完整性 → 挂 inner。本地化退役 Wave 2 之后
 * 主进程 BES 永远立即可用，partition 字段在 createWorkspace 时就解析为
 * 真实值，不再有 pending 占位 / 蒙层等待。
 */
export const CrawlspaceWorkspace: React.FC<CrawlspaceWorkspaceProps> = (props) => {
  const { t } = useTranslation('crawl')
  const { crawlspaceConfig } = props

  if (!crawlspaceConfig || !crawlspaceConfig.profile || !crawlspaceConfig.partition) {
    return (
      <div className="h-full w-full flex items-center justify-center text-body text-muted-foreground">
        {t('workspace.configMissing')}
      </div>
    )
  }

  return <CrawlspaceWorkspaceInner {...props} />
}

const CrawlspaceWorkspaceInner: React.FC<CrawlspaceWorkspaceProps> = ({
  crawlspaceId,
  crawlspaceConfig,
  tabScopeKey,
  isActive = true
}) => {
  const layoutResizeSessionRef = useRef<ReturnType<typeof startLayoutResizeTelemetry> | null>(null)
  const user = useAuthStore(state => state.user)
  const searchEngine = useBrowserPrefsStore(state => state.searchEngine)
  const setActiveContextKey = useSpaceContextTabsStore(state => state.setActiveKey)
  const setDisplayContextKey = useSpaceContextTabsStore(state => state.setDisplayKey)
  const spaceId = crawlspaceConfig?.spaceId ?? (crawlspaceConfig as { projectId?: string })?.projectId
  const storageKey = tabScopeKey || spaceId
  const activeContextKey = useSpaceContextTabsStore(state => {
    if (!storageKey) return null
    return state.activeKeyBySpace[storageKey] ?? null
  })
  const displayContextKey = useSpaceContextTabsStore(state => {
    if (!storageKey) return null
    return state.displayKeyBySpace[storageKey] ?? null
  })

  const canvasGroups = useCanvasLayoutStore(state => {
    if (!storageKey) return EMPTY_CANVAS_GROUPS
    return state.spaceGroups[storageKey] || EMPTY_CANVAS_GROUPS
  })
  const canvasManagedViewIds = useMemo(() => {
    const ids = new Set<string>()
    canvasGroups.forEach(group => {
      group.panes.forEach(pane => {
        if (!pane.content) return
        const parsed = contextRegistry.parseTabKey(pane.content.tabKey)
        if (parsed?.type === 'tabweb') {
          ids.add(parsed.id)
        }
      })
    })
    return ids
  }, [canvasGroups])
  const desiredActiveViewId = useMemo(() => {
    if (!activeContextKey) return null
    const parsed = contextRegistry.parseTabKey(activeContextKey)
    if (!parsed || parsed.type !== 'tabweb') return null
    return parsed.id
  }, [activeContextKey])
  const desiredActivationState = useBrowserViewActivationState(crawlspaceId, desiredActiveViewId)
  const pendingActivationViewId = useBrowserViewActivationIntent(crawlspaceId)
  const pendingActivationState = useBrowserViewActivationState(crawlspaceId, pendingActivationViewId)
  const isDesiredViewDeferred = useCrawlTabStore(state =>
    desiredActiveViewId
      ? state.crawlspaceDeferredViewIdsByCS[crawlspaceId]?.has(desiredActiveViewId) ?? false
      : false
  )
  const displayActiveViewId = useMemo(() => {
    if (!displayContextKey) return null
    const parsed = contextRegistry.parseTabKey(displayContextKey)
    if (!parsed || parsed.type !== 'tabweb') return null
    return parsed.id
  }, [displayContextKey])
  const resolvedDisplayActiveViewId = displayActiveViewId ?? desiredActiveViewId
  const isCanvasMode = useMemo(() => {
    if (!desiredActiveViewId) return false
    const tabKey = contextRegistry.buildTabKey('tabweb', desiredActiveViewId)
    return canvasGroups.some(group =>
      group.panes.some(pane => pane.content?.tabKey === tabKey)
    )
  }, [canvasGroups, desiredActiveViewId])
  const workspaceSlotsEnabled = Boolean(isActive && !isCanvasMode)

  useEffect(() => {
    trackLayoutTelemetry(
      'feature_flag_checked',
      'crawlspace',
      {
        module: 'CrawlspaceWorkspace',
        enabled: true,
        mode: 'enforced_v4',
      },
      {
        counterKey: 'crawlspace.feature_flag_checked.enabled',
      },
    )
  }, [])

  useEffect(() => {
    return () => {
      if (!layoutResizeSessionRef.current) return
      layoutResizeSessionRef.current.cancel({ reason: 'component_unmount' })
      layoutResizeSessionRef.current = null
    }
  }, [])

  const handleLayoutResizeStart = useCallback((ratio: number) => {
    if (layoutResizeSessionRef.current) {
      layoutResizeSessionRef.current.cancel({ reason: 'restart' })
    }
    layoutResizeSessionRef.current = startLayoutResizeTelemetry('crawlspace', {
      panel: 'workspace-split',
      startRatio: ratio,
      orientation: 'vertical',
      driver: 'react-resizable-panels-v4',
    })
  }, [])

  const handleLayoutResizeEnd = useCallback((ratio: number) => {
    if (!layoutResizeSessionRef.current) return
    layoutResizeSessionRef.current.end({ finalRatio: ratio })
    layoutResizeSessionRef.current.persistSuccess({ finalRatio: ratio })
    layoutResizeSessionRef.current = null
  }, [])

  const handleLayoutResizeCancel = useCallback((ratio: number) => {
    if (!layoutResizeSessionRef.current) return
    layoutResizeSessionRef.current.cancel({ finalRatio: ratio })
    layoutResizeSessionRef.current = null
  }, [])

  const getViewDragData = useCallback((view: ViewInfo) => {
    const tabKey = contextRegistry.buildTabKey('tabweb', view.viewId)
    return {
      text: tabKey,
      mimeData: {
        [DRAG_TYPE_TAB_REORDER]: tabKey,
        [DRAG_TYPE_TAB_META]: JSON.stringify({
          type: 'tabweb',
          id: view.viewId,
          title: view.title,
          url: view.url,
        }),
      },
      effectAllowed: 'move' as const,
    }
  }, [])

  /**
   * 🔧 缓存 adapters，避免每次渲染都创建新对象
   */
  // 🆕 懒加载占位符状态由 store 持有（crawlspaceDeferredViewIdsByCS）。
  // 历史上这是 component-local ref，Wave 3.1 提到 store 层后跨 mount 持久、
  // 与主进程 snapshot apply 自然共存——applyCacheSnapshot 会保留 store 中的
  // deferred views，避免 snapshot 把它们覆盖掉。
  const storeAdapter = useCrawlspaceContextAdapter(crawlspaceId)
  const ipcAdapter = useMemo(() => createElectronIpcAdapter(crawlspaceId, spaceId), [crawlspaceId, spaceId])
  const processedRequestIdsRef = useRef<Set<string>>(new Set())
  const creatingViewByUrlRef = useRef<Set<string>>(new Set())
  const restoredCrawlspacesRef = useRef<Set<string>>(new Set())

  /**
   * 🔧 构造 pluginProps
   * 将 CrawlspaceConfig 透传给插件，插件按 pluginConfig 决定行为
   */
  const pluginProps = useMemo(() => ({
    crawlspaceId,
    isActive,
    crawlspaceConfig,
    // 透传 metadata 中的参数 (initialUrl, initialSchema, autoSubmit 等)
    ...(crawlspaceConfig.pluginConfig || {})
  }), [crawlspaceConfig.pluginConfig, crawlspaceId, isActive])

  /**
   * Wave 3.2：cleanup 守卫闭包。判断逻辑全部在 `createWorkspaceRunGuard` 里
   * （独立 utility 便于黑盒测试）。这里只做"参数稳定时不重建闭包"的优化。
   */
  const shouldKeepRunOnCleanup = useMemo(
    () => createWorkspaceRunGuard({ spaceId, crawlspaceId }),
    [crawlspaceId, spaceId],
  )

  /**
   * 🆕 懒加载 IPC 适配器：拦截 switchView/destroyView 实现按需创建
   */
  const lazyIpcAdapter = useMemo(() => ({
    ...ipcAdapter,

    switchView: async (viewId: string): Promise<void> => {
      const result = await activateBrowserView(crawlspaceId, viewId, { spaceId })
      if (!result.ok) {
        throw new Error(result.message || `browser activation failed: ${result.code}`)
      }
      if (result.code === 'cancelled' || result.code === 'superseded') {
        throw new Error(`browser activation ${result.code}`)
      }
    },

    destroyView: async (viewId: string): Promise<void> => {
      cancelBrowserViewActivation(crawlspaceId, viewId)
      const isDeferred = useCrawlTabStore.getState()
        .crawlspaceDeferredViewIdsByCS[crawlspaceId]?.has(viewId) ?? false
      if (isDeferred) {
        // 原子更新：一次 setState 同时清 deferred / 注册防护 / 移除 seed
        useCrawlTabStore.setState(prev => {
          const seeds = prev.crawlspacePersistedViews[crawlspaceId] || []
          const filteredSeeds = seeds.filter(s => s.viewId !== viewId)
          const deferredIds = prev.crawlspaceDeferredViewIdsByCS[crawlspaceId]
          let nextDeferredByCS = prev.crawlspaceDeferredViewIdsByCS
          if (deferredIds && deferredIds.has(viewId)) {
            const next = new Set(deferredIds)
            next.delete(viewId)
            if (next.size === 0) {
              const { [crawlspaceId]: _removed, ...rest } = prev.crawlspaceDeferredViewIdsByCS
              nextDeferredByCS = rest
            } else {
              nextDeferredByCS = {
                ...prev.crawlspaceDeferredViewIdsByCS,
                [crawlspaceId]: next,
              }
            }
          }
          return {
            _recentlyClosedViewIds: addClosedViewId(prev._recentlyClosedViewIds, viewId),
            crawlspaceDeferredViewIdsByCS: nextDeferredByCS,
            ...(filteredSeeds.length !== seeds.length ? {
              crawlspacePersistedViews: {
                ...prev.crawlspacePersistedViews,
                [crawlspaceId]: filteredSeeds,
              },
            } : {}),
          }
        })
        const store = useCrawlTabStore.getState()
        const cache = store.crawlspaceContextCache[crawlspaceId]
        if (cache) {
          const remaining = cache.viewList.filter(v => v.viewId !== viewId)
          store.applyCrawlspaceContextSnapshot(crawlspaceId, {
            activeViewId: cache.activeViewId === viewId
              ? (remaining.find(v => !v.isClosing)?.viewId || null)
              : cache.activeViewId,
            views: remaining.map(v => ({
              viewId: v.viewId, title: v.title, url: v.url,
              favicon: v.favicon, runId: v.runId,
              isClosing: v.isClosing, isPreview: v.isPreview,
              createdAt: v.createdAt, updatedAt: Date.now()
            }))
          })
        }
        return
      }
      return ipcAdapter.destroyView(viewId)
    }
  }), [crawlspaceId, ipcAdapter, spaceId])

  // 外层侧栏 / 画布可以先更新用户意图 tabKey。只要目标仍是 deferred，
  // 这里就通过统一服务补建真实 view；失败后保持目标标签并交给恢复面板处理。
  useEffect(() => {
    if (!isActive || !desiredActiveViewId || !isDesiredViewDeferred) return
    if (desiredActivationState.phase !== 'idle') return
    void activateBrowserView(crawlspaceId, desiredActiveViewId, { spaceId })
  }, [
    crawlspaceId,
    desiredActivationState.phase,
    desiredActiveViewId,
    isActive,
    isDesiredViewDeferred,
    spaceId,
  ])

  const closeFailedRestore = useCallback(async (targetViewId: string) => {
    if (!targetViewId || !storageKey || !spaceId) return
    cancelBrowserViewActivation(crawlspaceId, targetViewId)
    const store = useCrawlTabStore.getState()
    const view = store.crawlspaceContextCache[crawlspaceId]?.viewList.find(
      candidate => candidate.viewId === targetViewId,
    )
    const tabKey = contextRegistry.buildTabKey('tabweb', targetViewId)
    const item = {
      type: 'tabweb' as const,
      id: targetViewId,
      tabKey,
      title: view?.title,
      meta: {
        url: view?.url,
        favicon: view?.favicon,
        crawlspaceId,
      },
    }
    const containerCtx = {
      spaceId,
      tabScopeKey: storageKey,
      crawlspaceId,
      closeBrowserView: (targetCrawlspaceId: string, viewId: string) =>
        useCrawlTabStore.getState().closeCrawlspaceView(targetCrawlspaceId, viewId),
    }
    try {
      const allowed = await contextRegistry.dispatchBeforeClose(item, containerCtx)
      if (!allowed) return
      const result = await contextRegistry.dispatchClose(item, containerCtx)
      if (result.needsClose) {
        useSpaceContextTabsStore.getState().closeTab(storageKey, tabKey)
      }
      contextRegistry.dispatchAfterClose(item, containerCtx)
    } catch (error) {
      log.error('关闭恢复失败的浏览器标签时出错', {
        crawlspaceId,
        viewId: targetViewId,
        error,
      })
    }
  }, [crawlspaceId, spaceId, storageKey])

  /**
   * 🆕 渲染单个 View（注入实际的 EmbeddedCrawlView）
   */
  const renderView = useCallback((view: ViewInfo, isViewActive: boolean) => {
    if (view.isClosing) {
      return null
    }
    const pendingRecoveryVisible = Boolean(
      pendingActivationViewId && pendingActivationState.phase !== 'idle'
    )
    const legacyRecoveryVisible = Boolean(
      view.viewId === desiredActiveViewId &&
      (view.status === 'deferred' || desiredActivationState.phase !== 'idle')
    )
    const shouldShowRecovery = isViewActive && (pendingRecoveryVisible || legacyRecoveryVisible)
    if (shouldShowRecovery) {
      const recoveryViewId = pendingRecoveryVisible && pendingActivationViewId
        ? pendingActivationViewId
        : view.viewId
      const sourceState = pendingRecoveryVisible ? pendingActivationState : desiredActivationState
      const visibleState = sourceState.phase === 'idle'
        ? { phase: 'restoring' as const }
        : sourceState
      return (
        <BrowserViewRecoveryPanel
          state={visibleState}
          onRetry={() => {
            void retryBrowserViewActivation(crawlspaceId, recoveryViewId, {
              spaceId,
              ...(storageKey ? {
                selection: {
                  tabScopeKey: storageKey,
                  tabKey: contextRegistry.buildTabKey('tabweb', recoveryViewId),
                },
              } : {}),
            })
          }}
          onClose={() => { void closeFailedRestore(recoveryViewId) }}
        />
      )
    }
    // deferred view 没有主进程 WebContentsView；非活动时不创建 portal slot。
    if (view.status === 'deferred') {
      return null
    }
    // 页面加载失败（status=error）时仍渲染 PortalHost，保留 EmbeddedCrawlView
    // 工具栏（返回/地址栏）。错误页改由 EmbeddedCrawlView 内容区覆盖展示，
    // 避免整容器替换导致用户无法后退或改地址。
    const isCanvasManaged = canvasManagedViewIds.has(view.viewId)
    const isHostActive = Boolean(
      workspaceSlotsEnabled &&
      !isCanvasManaged &&
      resolvedDisplayActiveViewId &&
      view.viewId === resolvedDisplayActiveViewId
    )
    const hostEnabled = workspaceSlotsEnabled && !isCanvasManaged

    return (
      <CrawlViewPortalHost
        viewId={view.viewId}
        isActive={isHostActive}
        priority={0}
        source="workspace"
        enabled={hostEnabled}
        className="h-full w-full"
        data-crawlspace-view-id={view.viewId}
      />
    )
  }, [
    canvasManagedViewIds,
    closeFailedRestore,
    crawlspaceId,
    desiredActivationState,
    desiredActiveViewId,
    pendingActivationState,
    pendingActivationViewId,
    resolvedDisplayActiveViewId,
    spaceId,
    storageKey,
    workspaceSlotsEnabled,
  ])

  useEffect(() => {
    if (!isActive) return
    if (!storageKey) return
    if (!desiredActiveViewId) return
    if (displayActiveViewId) return
    setDisplayContextKey(storageKey, contextRegistry.buildTabKey('tabweb', desiredActiveViewId))
  }, [desiredActiveViewId, displayActiveViewId, isActive, setDisplayContextKey, storageKey])

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return

    const handleCreateViewRequested = async (_event: any, data: {
      crawlspaceId?: string
      url?: string
      title?: string
      requestId?: string
    }) => {
      if (!data || data.crawlspaceId !== crawlspaceId) {
        return
      }

      // ack 主进程
      if (data.requestId) {
        try {
          ipc.send('workspace:create-view:ack', { requestId: data.requestId })
        } catch (err) {
          log.warn('发送 ack 失败:', err)
        }
      }

      // 请求级别防重（上限 200 条，超出时清空最旧的一半）
      if (data.requestId && processedRequestIdsRef.current.has(data.requestId)) {
        return
      }
      if (data.requestId) {
        if (processedRequestIdsRef.current.size >= 200) {
          const ids = Array.from(processedRequestIdsRef.current)
          processedRequestIdsRef.current = new Set(ids.slice(Math.floor(ids.length / 2)))
        }
        processedRequestIdsRef.current.add(data.requestId)
      }

      const rawUrl = (data.url || '').trim()
      const normalizedUrl = normalizeBrowserAddressInput(rawUrl, searchEngine)
      if (!normalizedUrl || !isValidUrl(normalizedUrl)) {
        log.warn('无效 URL，跳过创建:', data.url)
        return
      }

      // Defense-in-depth：主进程 openUrlInWorkspaceTab 已分流，这里再拦一次，
      // 防止历史/竞态 IPC 仍把 xlsx/pdf/image 喂进 tabweb createView。
      const { tryOpenPreviewableDirectUrl } = await import('@/components/chat/preview/assetPreviewResolver')
      if (tryOpenPreviewableDirectUrl(normalizedUrl) || tryOpenPreviewableDirectUrl(rawUrl)) {
        log.info('可预览文件改走 Preview Modal，跳过 tabweb createView:', rawUrl)
        return
      }

      if (creatingViewByUrlRef.current.has(normalizedUrl)) {
        return
      }
      creatingViewByUrlRef.current.add(normalizedUrl)

      try {
        const viewId = `view-${crawlspaceId}-${Date.now()}`
        const created = await ipcAdapter.createView(viewId, normalizedUrl, undefined, data.title)
        if (created) {
          // 🛡️ 崩溃恢复：立即写入种子
          seedManager.ensureSeed(crawlspaceId, { viewId, url: normalizedUrl, title: data.title })
          await ipcAdapter.switchView?.(viewId)
          if (storageKey) {
            setActiveContextKey(storageKey, contextRegistry.buildTabKey('tabweb', viewId))
          }
        }
      } finally {
        creatingViewByUrlRef.current.delete(normalizedUrl)
      }
    }

    const unsub = ipc.on('workspace:create-view-requested', handleCreateViewRequested)
    return () => {
      unsub?.()
    }
  }, [
    crawlspaceConfig?.pluginId,
    ipcAdapter,
    setActiveContextKey,
    crawlspaceId,
    searchEngine,
    spaceId,
    storageKey,
  ])

  useEffect(() => {
    const restoreFlag = import.meta.env.VITE_ALLOW_PERSISTED_VIEW_RESTORE
    const allowRestorePersisted = restoreFlag !== 'false'
    if (!allowRestorePersisted) {
      restoredCrawlspacesRef.current.add(crawlspaceId)
      log.info('已禁用持久化视图恢复（VITE_ALLOW_PERSISTED_VIEW_RESTORE=false）')
      traceTabRestore('browserRestore:disabled', { crawlspaceId, restoreFlag })
      return
    }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    const MAX_RETRIES = 8
    const BASE_DELAY = 300
    const MAX_DELAY = 4000
    const persistApi = (useCrawlTabStore as any).persist

    const scheduleRetry = (reason?: string) => {
      if (cancelled) return
      if (retryTimer) return
      if (attempt >= MAX_RETRIES) {
        log.warn('恢复持久化视图重试已达上限:', {
          crawlspaceId,
          attempt,
          reason
        })
        seedManager.markRestored(crawlspaceId)
        restoredCrawlspacesRef.current.add(crawlspaceId)
        traceTabRestore('browserRestore:retryExhausted', { crawlspaceId, attempt, reason })
        return
      }
      const delay = Math.min(BASE_DELAY * (2 ** attempt), MAX_DELAY)
      traceTabRestore('browserRestore:scheduleRetry', { crawlspaceId, attempt, delay, reason })
      attempt += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        void restorePersistedViews()
      }, delay)
    }

    const normalizeViewUrl = (raw?: string | null) => {
      const trimmed = (raw ?? '').trim()
      if (!trimmed) return 'about:blank'
      if (isValidUrl(trimmed)) return trimmed
      const normalized = normalizeBrowserAddressInput(trimmed, searchEngine)
      return isValidUrl(normalized) ? normalized : 'about:blank'
    }
    const hasMeaningfulUrl = (raw?: string | null) => normalizeViewUrl(raw) !== 'about:blank'

    const readContextTabTrace = () => {
      if (!storageKey) return { spaceId: null, tabScopeKey: null, activeKey: null, displayKey: null, tabOrder: [] }
      const tabsState = useSpaceContextTabsStore.getState()
      return {
        spaceId,
        tabScopeKey: storageKey,
        activeKey: tabsState.activeKeyBySpace[storageKey] ?? null,
        displayKey: tabsState.displayKeyBySpace[storageKey] ?? null,
        tabOrder: tabsState.tabOrderBySpace[storageKey] ?? [],
      }
    }

    const restorePersistedViews = async () => {
      if (restoredCrawlspacesRef.current.has(crawlspaceId)) return
      traceTabRestore('browserRestore:start', {
        crawlspaceId,
        attempt,
        context: readContextTabTrace(),
      })
      // 🌱 通过 seedManager 统一读取种子（双通道：zustand state + localStorage fallback）
      const seedResult = seedManager.getSeedsWithSource(crawlspaceId)
      // 🧹 过滤已过期的种子（7 天未激活），避免恢复无用标签
      const SEED_STALE_MS = 7 * 24 * 60 * 60 * 1000
      const staleThreshold = Date.now() - SEED_STALE_MS
      const persistedSeeds = seedResult.seeds.filter(seed => {
        const lastAccess = (seed as any).lastAccessedAt ?? seed.createdAt ?? 0
        return lastAccess > staleThreshold || seed.isActive
      })
      const store = useCrawlTabStore.getState()
      const cache = store.crawlspaceContextCache[crawlspaceId]
      const cachedViews = persistedSeeds.length > 0 ? persistedSeeds : (cache?.viewList || [])
      traceTabRestore('browserRestore:seeds', {
        crawlspaceId,
        attempt,
        seedSource: seedResult.source,
        storeCount: seedResult.storeCount,
        directCount: seedResult.directCount,
        persistedSeeds: persistedSeeds.map(seed => ({
          viewId: seed.viewId,
          url: seed.url,
          title: seed.title ?? null,
          isActive: Boolean(seed.isActive),
          createdAt: seed.createdAt ?? null,
          lastAccessedAt: (seed as { lastAccessedAt?: number }).lastAccessedAt ?? null,
        })),
        cacheActiveViewId: cache?.activeViewId ?? null,
        cacheViewIds: cache?.viewList.map(view => view.viewId) ?? [],
        context: readContextTabTrace(),
      })

      if (cachedViews.length === 0) {
        const hasHydrated = Boolean(persistApi?.hasHydrated?.())
        log.debug(`无种子 | cs:${crawlspaceId.slice(-8)} hydrated:${hasHydrated}`)
        traceTabRestore('browserRestore:noCachedViews', { crawlspaceId, hasHydrated, attempt })
        if (!hasHydrated) {
          scheduleRetry('wait-hydration')
          return
        }
        restoredCrawlspacesRef.current.add(crawlspaceId)
        return
      }

      log.debug(`restore | cs:${crawlspaceId.slice(-8)} store:${seedResult.storeCount} direct:${seedResult.directCount} src:${seedResult.source} attempt:${attempt}`)

      try {
        const snapshot = await crawlspaceContextClient.getContext(crawlspaceId)
        if (cancelled) return
        if (!snapshot || Array.isArray(snapshot)) {
          log.warn('context缺失, retry', { crawlspaceId })
          traceTabRestore('browserRestore:missingContext', { crawlspaceId, snapshotType: Array.isArray(snapshot) ? 'array' : typeof snapshot })
          scheduleRetry('missing-context')
          return
        }
        const existingIds = new Set<string>()
        snapshot.views.forEach(view => existingIds.add(view.viewId))
        const createTargets = cachedViews
          .filter(view => !existingIds.has(view.viewId))
          .map(view => ({ ...view, url: normalizeViewUrl(view.url) }))

        // 🆕 懒加载恢复：先确定活跃标签，只创建活跃标签的 View，其余注入为占位符。
        // contextTabs.activeKey 是最终 active 来源；browser seed 只在它缺失/不可用时补位。
        const contextTrace = readContextTabTrace()
        const contextActiveViewId = (() => {
          const active = contextTrace.activeKey
          if (!active) return null
          const parsed = contextRegistry.parseTabKey(active)
          return parsed?.type === 'tabweb' ? parsed.id : null
        })()
        const hasContextActiveView = Boolean(
          contextActiveViewId &&
          (
            existingIds.has(contextActiveViewId) ||
            cachedViews.some(view => view.viewId === contextActiveViewId) ||
            createTargets.some(view => view.viewId === contextActiveViewId)
          ),
        )
        const activeSeed =
          (hasContextActiveView
            ? cachedViews.find(view => view.viewId === contextActiveViewId)
            : null) ||
          persistedSeeds.find(view => view.isActive && hasMeaningfulUrl(view.url)) ||
          persistedSeeds.find(view => view.isActive)
        const firstMeaningfulViewId =
          cachedViews.find(view => hasMeaningfulUrl(view.url))?.viewId ||
          createTargets.find(view => hasMeaningfulUrl(view.url))?.viewId
        const resolvedActiveViewId =
          (hasContextActiveView ? contextActiveViewId : null) ||
          activeSeed?.viewId ||
          cache?.activeViewId ||
          firstMeaningfulViewId ||
          createTargets[0]?.viewId

        const activeTarget = resolvedActiveViewId
          ? createTargets.find(v => v.viewId === resolvedActiveViewId)
          : createTargets[0]
        const deferredTargets = createTargets.filter(v => v.viewId !== activeTarget?.viewId)
        traceTabRestore('browserRestore:targets', {
          crawlspaceId,
          existingIds: Array.from(existingIds),
          cachedViewIds: cachedViews.map(view => view.viewId),
          createTargets: createTargets.map(view => ({
            viewId: view.viewId,
            url: view.url,
            title: view.title ?? null,
            isActive: Boolean((view as { isActive?: boolean }).isActive),
          })),
          activeSeedViewId: activeSeed?.viewId ?? null,
          contextActiveViewId: contextActiveViewId ?? null,
          hasContextActiveView,
          firstMeaningfulViewId: firstMeaningfulViewId ?? null,
          cacheActiveViewId: cache?.activeViewId ?? null,
          resolvedActiveViewId: resolvedActiveViewId ?? null,
          activeTargetViewId: activeTarget?.viewId ?? null,
          deferredViewIds: deferredTargets.map(view => view.viewId),
          context: readContextTabTrace(),
        })

        log.debug('lazyRestore', {
          crawlspaceId: crawlspaceId.slice(-8),
          existing: existingIds.size,
          active: activeTarget?.viewId?.slice(-8),
          deferred: deferredTargets.length
        })

        // 活跃标签也走统一激活服务：首次冷启动创建失败时直接进入可见 failed 状态，
        // 不再由 restore loop 静默重试并给用户留下白屏。
        let hasFailure = false
        let activeTargetHandled = false
        if (activeTarget) {
          const activationResult = await activateBrowserView(crawlspaceId, activeTarget.viewId, {
            spaceId,
            fallbackView: activeTarget,
          })
          activeTargetHandled = true
          traceTabRestore('browserRestore:createActiveResult', {
            crawlspaceId,
            viewId: activeTarget.viewId,
            url: activeTarget.url,
            activationResult,
          })
          if (!activationResult.ok) {
            log.warn('创建活跃视图失败:', {
              viewId: activeTarget.viewId,
              code: activationResult.code,
              message: activationResult.message,
            })
            hasFailure = true
          }
        }

        // 将非活跃标签注入为占位符（显示在标签栏但不创建 WebContentsView）
        if (deferredTargets.length > 0 && !hasFailure) {
          // activeTarget 恢复期间用户可能已经从其它入口点开并创建了 B。
          // 用 main 当前快照重新排除 live view，不能继续按 restore 开始时的旧快照
          // 把已存在的 B 标回 deferred，也不能用旧的 A 覆盖当前 activeViewId。
          let latestMainViews: CrawlspaceViewSnapshot[] | null = null
          let latestMainActiveViewId: string | null | undefined
          try {
            const latestSnapshot = await crawlspaceContextClient.getContext(crawlspaceId)
            if (latestSnapshot && !Array.isArray(latestSnapshot)) {
              latestMainViews = latestSnapshot.views
              latestMainActiveViewId = latestSnapshot.activeViewId
            }
          } catch (error) {
            log.warn('注入 deferred 占位前刷新 main 快照失败，沿用 store 当前状态:', error)
          }
          const now = Date.now()
          const latestStore = useCrawlTabStore.getState()
          const currentCache = latestStore.crawlspaceContextCache[crawlspaceId]
          const reconciled = reconcileBrowserRestorePlaceholders({
            deferredTargets,
            latestMainViews,
            latestMainActiveViewId,
            currentCacheViews: currentCache?.viewList ?? [],
            currentCacheActiveViewId: currentCache?.activeViewId,
            resolvedActiveViewId,
            now,
          })
          latestStore.applyCrawlspaceContextSnapshot(crawlspaceId, {
            activeViewId: reconciled.activeViewId,
            views: reconciled.views,
          })
          reconciled.pendingDeferredTargets.forEach(v => {
            latestStore.markCrawlspaceViewDeferred(crawlspaceId, v.viewId)
          })
          traceTabRestore('browserRestore:placeholderSnapshot', {
            crawlspaceId,
            activeViewId: reconciled.activeViewId,
            placeholderViewIds: reconciled.placeholderViews.map(view => view.viewId),
            existingCacheViewIds: reconciled.existingViews.map(view => view.viewId),
          })
        }

        if (resolvedActiveViewId && !hasFailure && !activeTargetHandled) {
          traceTabRestore('browserRestore:switchView', {
            crawlspaceId,
            viewId: resolvedActiveViewId,
            context: readContextTabTrace(),
          })
          await ipcAdapter.switchView(resolvedActiveViewId)
        }
        if (hasFailure) {
          scheduleRetry('create-view-failed')
          return
        }

        log.info('restored', {
          crawlspaceId: crawlspaceId.slice(-8),
          active: activeTarget?.viewId?.slice(-8),
          deferred: deferredTargets.length
        })
        traceTabRestore('browserRestore:done', {
          crawlspaceId,
          resolvedActiveViewId: resolvedActiveViewId ?? null,
          activeTargetViewId: activeTarget?.viewId ?? null,
          deferredViewIds: deferredTargets.map(view => view.viewId),
          context: readContextTabTrace(),
        })

        // 🌱 标记冷启动恢复完成，解除 applyCrawlspaceContextSnapshot 的种子保护
        seedManager.markRestored(crawlspaceId)

        restoredCrawlspacesRef.current.add(crawlspaceId)
      } catch (error) {
        log.warn('恢复持久化视图失败:', error)
        traceTabRestore('browserRestore:error', { crawlspaceId, error: String(error), attempt })
        scheduleRetry('error')
      }
    }

    const unsubscribeHydration = persistApi?.onFinishHydration?.(() => {
      void restorePersistedViews()
    })

    restorePersistedViews()
    return () => {
      cancelled = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      unsubscribeHydration?.()
    }
  }, [crawlspaceId, ipcAdapter, searchEngine, spaceId, storageKey])

  // ────────────────── Find-in-Page ──────────────────
  const [showFindBar, setShowFindBar] = useState(false)
  const [findMatchInfo, setFindMatchInfo] = useState<{ current: number; total: number } | null>(null)
  const findViewIdRef = useRef<string | null>(null)

  const handleFind = useCallback((viewId: string, text: string, options: { forward?: boolean; findNext?: boolean }) => {
    findViewIdRef.current = viewId
    const tabtin = window.tabtin
    tabtin?.crawlView?.findInPage(viewId, text, options)
  }, [])

  const handleStopFind = useCallback((viewId: string) => {
    const tabtin = window.tabtin
    tabtin?.crawlView?.stopFindInPage(viewId, 'clearSelection')
    setFindMatchInfo(null)
    findViewIdRef.current = null
  }, [])

  // Listen for found-in-page results from main process
  useEffect(() => {
    const tabtin = window.tabtin
    if (!tabtin?.crawlView?.onFoundInPage) return
    const unsubscribe = tabtin.crawlView.onFoundInPage((_event: any, data: { viewId: string; activeMatchOrdinal: number; matches: number }) => {
      if (data.viewId === findViewIdRef.current) {
        setFindMatchInfo({ current: data.activeMatchOrdinal, total: data.matches })
      }
    })
    return () => { unsubscribe?.() }
  }, [])

  // Listen for browser:find-toggle custom event from keyboard shortcuts
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { viewId?: string } | undefined
      if (detail?.viewId) {
        findViewIdRef.current = detail.viewId
      }
      setShowFindBar(prev => {
        if (prev) {
          // Closing — stop find
          if (findViewIdRef.current) {
            handleStopFind(findViewIdRef.current)
          }
          return false
        }
        return true
      })
    }
    window.addEventListener('browser:find-toggle', handler)
    return () => { window.removeEventListener('browser:find-toggle', handler) }
  }, [handleStopFind])

  // ────────────────── Zoom ──────────────────
  // Wave 6.2：zoom 处理已提到 module-level `services/browserZoomController.ts`，
  // 由 `useBrowserActions.handleZoomItem` 直接调 `adjustBrowserZoom`。
  // 之前在这里挂的 `window.addEventListener('browser:zoom', ...)` 会随内层
  // Activity 在 canvas mode hidden 时 cleanup，让用户分屏时 Cmd+/Cmd- 失灵。
  const autocompleteAddressInput = useCallback(
    (value: string) => normalizeBrowserAddressInput(value, searchEngine),
    [searchEngine],
  )

  return (
    <CrawlspaceShell
      pluginId={crawlspaceConfig.pluginId}
      crawlspaceId={crawlspaceId}
      runPrefix={crawlspaceConfig.runPrefix}
      userId={user?.id}
      isActive={isActive}
      showToolbar={Boolean(crawlspaceConfig.uiConfig?.showToolbar)}
      showTabs={crawlspaceConfig.uiConfig?.showTabs ?? true}
      destroyViewsOnUnmount={false}
      storeAdapter={storeAdapter}
      ipcAdapter={lazyIpcAdapter}
      isValidUrl={isValidUrl}
      autocompleteUrl={autocompleteAddressInput}
      renderView={renderView}
      host={electronCrawlspaceHost}
      pluginProps={pluginProps}
      onFind={handleFind}
      onStopFind={handleStopFind}
      findMatchInfo={findMatchInfo}
      showFindBar={showFindBar}
      onFindBarToggle={setShowFindBar}
      onLayoutResizeStart={handleLayoutResizeStart}
      onLayoutResizeEnd={handleLayoutResizeEnd}
      onLayoutResizeCancel={handleLayoutResizeCancel}
      accentColor={crawlspaceConfig.sessionColor}
      getViewDragData={getViewDragData}
      shouldKeepRunOnCleanup={shouldKeepRunOnCleanup}
    />
  )
}
