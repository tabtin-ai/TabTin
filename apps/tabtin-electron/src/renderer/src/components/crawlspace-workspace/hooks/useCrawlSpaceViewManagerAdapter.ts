/**
 * Electron Store Adapter for useViewManager
 *
 * 适配 useCrawlTabStore 到 useViewManager 的 storeAdapter 接口。
 *
 * # 设计（Wave 3.1 后）
 *
 * 主进程 crawlspace context 的订阅集中由 store 持有（见
 * `crawlspaceContextSubscriptionRegistry`）。Adapter 不再 subscribe IPC，
 * 也不再持有 snapshot 镜像 ref——所有数据从 store cache 读取。
 *
 * 用户体感：高频切换 hot Space 时切回零延迟、零闪烁——hidden 期间 store
 * 持续接收主进程推送，切回的第一帧组件读到的就是最新状态，无需 IPC
 * round-trip。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useCrawlTabStore, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import type { CrawlspaceViewMetaUpdates } from '@stores/crawlTab/types'
import { seedManager } from '@stores/seed-manager'
import type { ViewInfo, ViewId } from '@tabtin/crawlspace-core'
import { crawlViewClient } from '../../../crawlspace/electron/crawl-view-client'
import { crawlspaceViewClient } from '../../../crawlspace/electron/crawlspace-view-client'
import { crawlspaceContextClient } from '../../../crawlspace/electron/crawlspace-context-client'
import type { RendererCrawlspaceViewMetaUpdates } from '@shared/types/crawlspace'
import type { OpenIntentHints } from '@shared/open-intent'
import { getCrawlspaceConfig } from '@/crawlspace/registry'
import { useBrowserPrefsStore } from '@stores/useBrowserPrefsStore'
import i18n from '@/i18n'

/**
 * 将 CrawlspaceViewInfo 转换为 ViewInfo
 */
function toViewInfo(wsView: CrawlspaceViewInfo): ViewInfo {
  return {
    viewId: wsView.viewId,
    url: wsView.url,
    title: wsView.title,
    favicon: wsView.favicon,
    runId: wsView.runId,
    createdAt: wsView.createdAt,
    kind: wsView.kind,
    crawlspaceId: wsView.crawlspaceId,
    isPreview: wsView.isPreview,
    isClosing: Boolean(wsView.isClosing),
    themeColor: wsView.themeColor,
    isLoading: wsView.isLoading,
  }
}

export function toCrawlspaceViewMetaUpdates(update: Partial<ViewInfo>): CrawlspaceViewMetaUpdates | null {
  const payload: CrawlspaceViewMetaUpdates = {}
  if ('title' in update) payload.title = update.title
  if ('url' in update) payload.url = update.url
  if ('favicon' in update) payload.favicon = update.favicon
  if ('runId' in update) payload.runId = update.runId
  if ('isPreview' in update) payload.isPreview = update.isPreview
  if ('kind' in update) payload.kind = update.kind as CrawlspaceViewInfo['kind']
  if ('crawlspaceId' in update) payload.crawlspaceId = update.crawlspaceId
  if ('themeColor' in update) payload.themeColor = update.themeColor
  if ('isLoading' in update) payload.isLoading = update.isLoading
  return Object.keys(payload).length > 0 ? payload : null
}

export function toRemoteCrawlspaceViewMetaUpdates(
  update: Partial<ViewInfo>,
): RendererCrawlspaceViewMetaUpdates | null {
  const payload: RendererCrawlspaceViewMetaUpdates = {}
  if (typeof update.runId === 'string') payload.runId = update.runId
  if ('isPreview' in update) payload.isPreview = update.isPreview
  return Object.keys(payload).length > 0 ? payload : null
}

/**
 * 基于 Crawlspace Context 的 Store Adapter（主进程状态优先）
 *
 * 数据来源：`useCrawlTabStore.crawlspaceContextCache`，由 store 层订阅
 * 主进程 snapshot 持续更新（见 `crawlspaceContextSubscriptionRegistry`）。
 * Adapter 只负责把 store 的 cache 翻译成 useViewManager 需要的形态，
 * 并在 cache 变化时通知 view manager。
 */
export function useCrawlspaceContextAdapter(crawlspaceId: string) {
  const listenersRef = useRef<Set<() => void>>(new Set())

  const notify = useCallback(() => {
    listenersRef.current.forEach(listener => listener())
  }, [])

  // 触发 store 层订阅（幂等）。store 内部会立即拉一份 snapshot 写入 cache，
  // 后续随主进程推送同步更新——此 effect 不取消订阅，订阅由 store 在
  // closeCrawlspace / purgeCrawlspaceData 时统一释放。
  useEffect(() => {
    useCrawlTabStore.getState().ensureCrawlspaceContextCache(crawlspaceId)
  }, [crawlspaceId])

  // 监听 store cache + deferred IDs 变化，通知 view manager 重读。
  // 用 zustand 的 subscribe(全 state) 简单 diff 两个相关字段，避免引入
  // subscribeWithSelector middleware 改动 store 全局结构。
  useEffect(() => {
    const unsubscribe = useCrawlTabStore.subscribe((state, prevState) => {
      const cache = state.crawlspaceContextCache[crawlspaceId]
      const prevCache = prevState.crawlspaceContextCache[crawlspaceId]
      const deferred = state.crawlspaceDeferredViewIdsByCS[crawlspaceId]
      const prevDeferred = prevState.crawlspaceDeferredViewIdsByCS[crawlspaceId]
      if (cache !== prevCache || deferred !== prevDeferred) {
        if (globalThis.__TABTIN_DEBUG_VIEW_RELOAD__ && cache !== prevCache) {
          const viewList = cache?.viewList ?? []
          console.info('[DebugViewReload] renderer.cache', {
            crawlspaceId,
            views: viewList.map(view => ({
              id: view.viewId,
              url: view.url || '',
              title: view.title || ''
            })),
          })
        }
        notify()
      }
    })
    return unsubscribe
  }, [crawlspaceId, notify])

  const adapter = useMemo(() => ({
    isContextDriven: true,
    getViews: () => {
      const store = useCrawlTabStore.getState()
      const storeViews = store.getCrawlspaceViews(crawlspaceId)
      const deferredIds = store.crawlspaceDeferredViewIdsByCS[crawlspaceId]
      // 标签生命周期状态注入（deferred=休眠 / loading=加载中 / error=错误）。
      // 优先级：deferred > error > loading > undefined。
      // 数据源：store cache（hasError/isLoading 由 applyCrawlspaceContextSnapshot 写入）。
      return storeViews.map(view => {
        const base = toViewInfo(view)
        let status: ViewInfo['status']
        if (deferredIds && deferredIds.has(view.viewId)) {
          status = 'deferred'
        } else if (view.hasError) {
          status = 'error'
        } else if (view.isLoading) {
          status = 'loading'
        }
        return status ? { ...base, status } : base
      })
    },

    getActiveViewId: () => {
      return useCrawlTabStore.getState().getActiveCrawlspaceViewId(crawlspaceId)
    },

    addView: (_view: ViewInfo) => {
      // Crawlspace 视图列表由主进程 Context 同步，renderer 不直接写入
    },

    removeView: (_viewId: ViewId) => {
      // Crawlspace 视图列表由主进程 Context 同步，renderer 不直接写入
    },

    setActiveViewId: (viewId: ViewId | null) => {
      void crawlspaceContextClient.setActiveView(crawlspaceId, viewId)
    },

    updateView: (viewId: ViewId, update: Partial<ViewInfo>) => {
      const store = useCrawlTabStore.getState()
      const payload = toCrawlspaceViewMetaUpdates(update)
      const remotePayload = toRemoteCrawlspaceViewMetaUpdates(update)
      if (!payload) {
        return
      }
      store.setCrawlspaceViewMeta(crawlspaceId, viewId, payload)
      if (remotePayload) {
        void crawlspaceContextClient.updateViewMeta(crawlspaceId, viewId, remotePayload)
      }
    },

    subscribe: (callback: () => void) => {
      listenersRef.current.add(callback)
      return () => {
        listenersRef.current.delete(callback)
      }
    }
  }), [crawlspaceId])

  return adapter
}

/**
 * 创建 useViewManager 的 IPC Adapter
 */
export function createElectronIpcAdapter(
  crawlspaceId: string,
  spaceId?: string,
  adapterOptions?: { onCreateViewFailure?: (message: string) => void },
) {
  return {
    createView: async (
      viewId: ViewId,
      url: string,
      runId?: string,
      title?: string,
      sessionMode?: string,
      options?: {
        allowPrivateHostNavigation?: boolean
        localPreviewRoot?: string
        openIntentHints?: OpenIntentHints
      },
    ): Promise<boolean> => {
      try {
        const store = useCrawlTabStore.getState()
        const crawlspaceConfig = getCrawlspaceConfig(crawlspaceId) as
          | { profile?: string; partition?: string; spaceId?: string }
          | undefined
        if (!crawlspaceConfig?.profile || !crawlspaceConfig?.partition) {
          console.warn('[ElectronIpcAdapter] ⚠️ 缺少 crawlspace 配置，跳过创建 View')
          adapterOptions?.onCreateViewFailure?.('缺少浏览器工作区配置，无法创建 View')
          return false
        }

        const resolvedSpaceId = spaceId || crawlspaceConfig.spaceId

        const activeProxy = useBrowserPrefsStore.getState().proxyList.find(p => p.enabled)
        const proxyPayload = activeProxy
          ? { server: activeProxy.server, username: activeProxy.username, password: activeProxy.password }
          : undefined

        const result = await crawlspaceViewClient.createView({
          crawlspaceId,
          viewId,
          url,
          title,
          runId,
          spaceId: resolvedSpaceId,
          kind: 'workspace-view',
          profile: crawlspaceConfig.profile,
          partition: crawlspaceConfig.partition,
          sessionMode,
          proxy: proxyPayload,
          allowPrivateHostNavigation: options?.allowPrivateHostNavigation,
          localPreviewRoot: options?.localPreviewRoot,
          openIntentHints: options?.openIntentHints,
        })

        // 兼容两套 IPC 失败形状：
        // - legacy `{ success:false, error:string }`（crawlspace:createView 业务失败）
        // - Wave0 envelope `{ ok:false, error:{ message } }`（如 UNAUTHORIZED）
        const envelopeFailed = result && typeof result === 'object' && 'ok' in result && (result as { ok?: boolean }).ok === false
        const legacyFailed = result == null || (result as { success?: boolean }).success === false
        if (envelopeFailed || legacyFailed) {
          const rawError = (result as { error?: unknown } | null)?.error
          const message =
            typeof rawError === 'string' && rawError.trim()
              ? rawError.trim()
              : rawError && typeof rawError === 'object' && typeof (rawError as { message?: unknown }).message === 'string'
                ? String((rawError as { message: string }).message)
                : '创建 View 失败'
          console.warn('[ElectronIpcAdapter] 创建 View 失败:', message)
          adapterOptions?.onCreateViewFailure?.(message)
          return false
        }

        const syncFallbackSnapshot = () => {
          const cache = store.crawlspaceContextCache[crawlspaceId]
          const persistedActiveViewId =
            seedManager.getActiveSeedViewId(crawlspaceId)
          const currentActiveViewId = cache?.activeViewId || persistedActiveViewId
          const now = Date.now()
          const existingViews = (cache?.viewList || [])
            .filter(view => !view.isClosing && view.viewId !== viewId)
            .map(view => ({
              viewId: view.viewId,
              title: view.title,
              url: view.url,
              favicon: view.favicon,
              runId: view.runId,
              isClosing: false,
              isPreview: view.isPreview,
              createdAt: view.createdAt,
              updatedAt: now
            }))
          const newTabTitle = i18n.t('context:label.newTab')
          store.applyCrawlspaceContextSnapshot(crawlspaceId, {
            activeViewId: currentActiveViewId || viewId,
            views: [
              ...existingViews,
              {
                viewId,
                title: title || newTabTitle,
                url,
                runId,
                isClosing: false,
                isPreview: false,
                createdAt: now,
                updatedAt: now
              }
            ]
          })
        }

        // 主进程创建成功后拉 Context 快照；若快照尚不含本 view（注册竞态），
        // 绝不能用过期 snapshot 覆盖——否则 activate 会 missing_metadata。
        try {
          const snapshot = await crawlspaceContextClient.getContext(crawlspaceId)
          const views = snapshot && !Array.isArray(snapshot) ? snapshot.views : null
          const hasNewView = Array.isArray(views) && views.some(view => view.viewId === viewId)
          if (hasNewView && snapshot && !Array.isArray(snapshot)) {
            store.applyCrawlspaceContextSnapshot(crawlspaceId, snapshot)
          } else {
            syncFallbackSnapshot()
          }
        } catch (error) {
          console.warn('[ElectronIpcAdapter] 拉取 Crawlspace Context 失败（忽略）:', error)
          syncFallbackSnapshot()
        }

        return true
      } catch (error) {
        console.error('[ElectronIpcAdapter] 创建 View 失败:', error)
        adapterOptions?.onCreateViewFailure?.(error instanceof Error ? error.message : String(error))
        return false
      }
    },

    destroyView: async (viewId: ViewId): Promise<void> => {
      try {
        const store = useCrawlTabStore.getState()
        // closeCrawlspaceView 是 store action，返 `{ok, code?, message?}`。
        // destroyView 业务上是 fail-soft——失败仅 log（不阻塞 view-manager 关闭），保留语义。
        const closeRes = await store.closeCrawlspaceView(crawlspaceId, viewId)
        if (!closeRes.ok) {
          console.warn('[ElectronIpcAdapter] 销毁 View 失败（返回失败结果）:', {
            crawlspaceId,
            viewId,
            code: closeRes.code,
            message: closeRes.message,
          })
        }
      } catch (error) {
        // fail-soft: destroyView 失败不重试，只 log——上层 view-manager 会按预期标记关闭
        console.warn('[ElectronIpcAdapter] 销毁 View 失败（忽略）:', error)
      }
    },

    switchView: async (viewId: ViewId): Promise<void> => {
      void crawlspaceContextClient.setActiveView(crawlspaceId, viewId)
    },

    // 🆕 View 事件订阅（title/favicon/url/loading 等）
    onEvent: (callback: (event: any) => void) => {
      return crawlViewClient.onEvent(callback)
    },
  }
}
