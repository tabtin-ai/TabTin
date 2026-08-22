/** @store-category session */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { withPersistSafety, createMigratingStorage } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { logger } from '@/utils/logger'
import { registerResetAction } from './sessionResetRegistry'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { createCrawlspaceLifecycleActions } from './crawlTab/crawlspaceLifecycleSlice'
import { createContextSnapshotActions } from './crawlTab/slices/contextSnapshotSlice'
import { createPreviewActions } from './crawlTab/slices/previewSlice'
import { createSeedActions } from './crawlTab/slices/seedSlice'
import { createTabsActions } from './crawlTab/slices/tabsSlice'
import { createConfigActions } from './crawlTab/slices/configSlice'
import { configureCrawlspaceContextSubscription } from './crawlTab/crawlspaceContextSubscriptionRegistry'
import { installCrawlspaceHotSubscriptionSyncer } from './crawlTab/crawlspaceHotSubscriptionSyncer'
import { setCloseWorkspaceHandler } from '@tabtin/crawlspace-core'

// Re-export types for backward compatibility
export type { CrawlTabKind, CrawlspaceConfig, CrawlspaceViewInfo, CrawlTab, CrawlTabMetadata, CrawlspacePreviewState, CrawlspacePersistedViewSeed, CloseCrawlspaceViewResult } from './crawlTab/types'
export { readPersistedSeedsFromStorage } from './crawlTab/hydration'
import type { CrawlspaceConfig, CrawlspaceViewInfo, CrawlspaceViewMetaUpdates, CrawlTab, CrawlTabMetadata, CrawlTabKind, CrawlspacePreviewState, CrawlspacePersistedViewSeed, CrawlspaceContextCache, CloseCrawlspaceViewResult } from './crawlTab/types'
import {
  normalizeTabs,
  normalizePersistedViews,
  deriveColdStartFlags,
  deriveConfigFromTabs,
  buildCacheFromSeeds,
} from './crawlTab/hydration'

interface CrawlTabState {
  tabs: CrawlTab[]
  crawlspacePreviewStates: Record<string, CrawlspacePreviewState>
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>
  /**
   * Deferred (placeholder) view IDs per crawlspace — see contextSnapshotSlice
   * for design rationale. Renderer-only state, not persisted.
   */
  crawlspaceDeferredViewIdsByCS: Record<string, Set<string>>
  crawlspacePersistedViews: Record<string, CrawlspacePersistedViewSeed[]>
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  _coldStartPendingByCS: Record<string, boolean>
  _recentlyClosedViewIds: Set<string>

  // Tabs slice
  createTab: (url: string, name?: string, options?: {
    temporary?: boolean
    autoClose?: boolean
    id?: string
    skipAutoSelect?: boolean
    runId?: string
    kind?: CrawlTabKind
    legacy?: boolean
    metadata?: CrawlTabMetadata
  }) => CrawlTab
  createWorkspace: (
    config: Omit<CrawlspaceConfig, 'crawlspaceId' | 'partition'> & {
      partition?: string
      crawlspaceId?: string
      sessionName?: string
    },
  ) => CrawlTab
  getSpaceCrawlspace: (spaceId: string) => CrawlTab | null
  getScopedCrawlspace: (scopeKey: string) => CrawlTab | null
  rehomeScopedCrawlspace: (fromScopeKey: string, toScopeKey: string) => string | null
  getNamedCrawlspace: (spaceId: string, sessionName: string) => CrawlTab | null
  getSpaceSessionList: (spaceId: string) => Array<{ sessionName: string; crawlspaceId: string }>
  ensureSpaceCrawlspace: (spaceId: string, options?: { title?: string }) => CrawlTab
  ensureScopedCrawlspace: (spaceId: string, scopeKey: string, options?: { title?: string }) => CrawlTab
  ensureNamedCrawlspace: (spaceId: string, sessionName: string, options?: { title?: string; sessionColor?: string }) => CrawlTab
  updateTab: (tabId: string, updates: Partial<CrawlTab>) => void
  clearAll: () => void
  createTemporaryTab: (url: string, name?: string) => CrawlTab
  closeTemporaryTabs: () => void

  // Lifecycle slice
  deleteTab: (tabId: string) => void
  closeCrawlspace: (
    crawlspaceId: string,
    reason?: string,
    options?: { reason?: string }
  ) => Promise<void>
  closeCrawlspaceView: (crawlspaceId: string, viewId: string) => Promise<CloseCrawlspaceViewResult>

  // Preview slice
  saveCrawlspacePreviewState: (crawlspaceId: string, state: Partial<CrawlspacePreviewState>) => void
  getCrawlspacePreviewState: (crawlspaceId: string) => CrawlspacePreviewState | null
  clearCrawlspacePreviewState: (crawlspaceId: string) => void
  clearAllCrawlspacePreviewStates: () => void

  // Context snapshot slice
  applyCrawlspaceContextSnapshot: (
    crawlspaceId: string,
    snapshot: {
      activeViewId?: string | null
      views: Array<{
        viewId: string
        title?: string
        url?: string
        favicon?: string
        runId?: string
        isClosing?: boolean
        isPreview?: boolean
        themeColor?: string
        isLoading?: boolean
        hasError?: boolean
        errorDescription?: string
        resourceSummary?: {
          total: number
          byCategory: Partial<Record<string, number>>
          byCaptureStatus?: Partial<Record<string, number>>
        }
        createdAt?: number
        updatedAt?: number
      }>
    }
  ) => void
  setCrawlspaceViewMeta: (
    crawlspaceId: string,
    viewId: string,
    updates: CrawlspaceViewMetaUpdates
  ) => void
  markCrawlspaceViewDeferred: (crawlspaceId: string, viewId: string) => void
  unmarkCrawlspaceViewDeferred: (crawlspaceId: string, viewId: string) => void

  // Config slice
  ensureCrawlspaceContextCache: (crawlspaceId: string) => void
  ensureCrawlspaceConfig: (crawlspaceId: string) => CrawlspaceConfig | null
  getCrawlspaceConfig: (crawlspaceId: string) => CrawlspaceConfig | null
  getCrawlspaceViews: (crawlspaceId: string) => CrawlspaceViewInfo[]
  getActiveCrawlspaceViewId: (crawlspaceId: string) => string | null
  purgeCrawlspaceData: (crawlspaceId: string) => void

  // Seed slice
  getPersistedCrawlspaceViews: (crawlspaceId: string) => CrawlspacePersistedViewSeed[]
  markColdStartComplete: (crawlspaceId: string) => void
  ensureViewSeed: (crawlspaceId: string, seed: Partial<CrawlspacePersistedViewSeed> & { viewId: string; url: string }) => void
}

type CrawlTabPersistState = Pick<
  CrawlTabState,
  'tabs' | 'crawlspacePersistedViews' | 'crawlspaceConfigById'
>

const STORE_VERSION = 1

function partializeState(state: CrawlTabState): CrawlTabPersistState {
  return {
    tabs: state.tabs.filter(tab => !tab.temporary),
    crawlspacePersistedViews: state.crawlspacePersistedViews,
    crawlspaceConfigById: state.crawlspaceConfigById,
  }
}

function summarizeCrawlPersistState(state: Partial<CrawlTabPersistState>) {
  const tabs = Array.isArray(state.tabs) ? state.tabs : []
  const seedsByCrawlspace = state.crawlspacePersistedViews ?? {}
  const configsById = state.crawlspaceConfigById ?? {}
  return {
    tabs: tabs.map(tab => ({
      id: tab.id,
      kind: tab.kind,
      name: tab.name,
      spaceId: tab.metadata?.spaceId ?? (tab as { spaceId?: string }).spaceId ?? null,
      crawlspaceId: tab.metadata?.crawlspaceId ?? (tab as { crawlspaceId?: string }).crawlspaceId ?? null,
    })),
    configs: Object.entries(configsById).map(([crawlspaceId, config]) => ({
      crawlspaceId,
      spaceId: config.spaceId ?? (config as { projectId?: string }).projectId ?? null,
      pluginId: config.pluginId,
      profile: config.profile,
    })),
    seeds: Object.entries(seedsByCrawlspace).map(([crawlspaceId, seeds]) => ({
      crawlspaceId,
      count: seeds.length,
      activeViewId: seeds.find(seed => seed.isActive)?.viewId ?? null,
      views: seeds.map(seed => ({
        viewId: seed.viewId,
        url: seed.url,
        title: seed.title ?? null,
        isActive: Boolean(seed.isActive),
        lastAccessedAt: (seed as { lastAccessedAt?: number }).lastAccessedAt ?? null,
      })),
    })),
  }
}

// 🆕 Wave 3.1: applier 注入紧跟 create() —— 任何 ensureCrawlspaceContextCache
// 调用前 applier 必须就绪。结构契约：本节点（create + configure）之间禁止
// 插入任何会触发 ensureCrawlspaceContextCache 的 module-level side effect，
// 否则 listener 收到的 snapshot 将因 applier=null 被静默丢弃。
// （beforeunload / registerResetAction 在 store 末尾才挂——属于"调用方驱动"
// 而非"模块加载即触发"，无影响。）
export const useCrawlTabStore = create<CrawlTabState>()(
  persist<CrawlTabState, [], [], CrawlTabPersistState>(
    (set, get) => ({
      tabs: [],
      crawlspacePreviewStates: {},
      crawlspaceContextCache: {},
      crawlspaceDeferredViewIdsByCS: {},
      crawlspacePersistedViews: {},
      crawlspaceConfigById: {},
      _coldStartPendingByCS: {},
      _recentlyClosedViewIds: new Set<string>(),

      // Tabs slice
      ...createTabsActions(get, set as any),

      // Lifecycle slice (deleteTab, closeCrawlspace, closeCrawlspaceView)
      ...createCrawlspaceLifecycleActions(get, set as any),

      // Preview slice
      ...createPreviewActions(get, set as any),

      // Context snapshot slice
      ...createContextSnapshotActions(get, set as any),

      // Config slice
      ...createConfigActions(get, set as any),

      // Seed slice
      ...createSeedActions(get, set as any),
    }),
    withPersistSafety<CrawlTabState, CrawlTabPersistState>({
      name: PERSIST_KEYS.crawlTabs,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-crawl-tabs'])),
      partialize: (state) => {
        const result = partializeState(state)
        const totalSeeds = Object.values(result.crawlspacePersistedViews).reduce((sum, arr) => sum + arr.length, 0)
        traceTabRestore('crawlTabs:partialize', summarizeCrawlPersistState(result))
        if (globalThis.__lastPartializeSeeds !== totalSeeds) {
          const detail = Object.entries(result.crawlspacePersistedViews).map(([k, v]) => `${k.slice(-8)}:${v.length}`).join(',')
          logger.debug(`[CrawlTabStore] partialize | totalSeeds:${totalSeeds} [${detail}]`)
          globalThis.__lastPartializeSeeds = totalSeeds
        }
        return result
      },
      version: STORE_VERSION,
      migrate: (persisted: unknown, _version: number): CrawlTabPersistState => persisted as CrawlTabPersistState,
      merge: (persisted: unknown, currentState: CrawlTabState): CrawlTabState => {
        const persistedState = (persisted || {}) as Partial<CrawlTabState>
        const rawTabs = Array.isArray(persistedState.tabs) ? persistedState.tabs : []

        const normalizedTabs = normalizeTabs(rawTabs)
        const workspaceTabs = normalizedTabs.filter(tab => tab.kind === 'workspace')
        const rawPersisted = persistedState.crawlspacePersistedViews || {}
        traceTabRestore('crawlTabs:merge:start', summarizeCrawlPersistState({
          tabs: rawTabs as CrawlTab[],
          crawlspacePersistedViews: rawPersisted as Record<string, CrawlspacePersistedViewSeed[]>,
          crawlspaceConfigById: persistedState.crawlspaceConfigById as Record<string, CrawlspaceConfig> | undefined,
        }))

        const nextPersisted = normalizePersistedViews(rawPersisted as Record<string, any[]>)
        const nextColdStart = deriveColdStartFlags(nextPersisted)
        const nextConfigsById = deriveConfigFromTabs(workspaceTabs)
        const nextCache = buildCacheFromSeeds(nextPersisted)

        const seedSummary = Object.entries(nextPersisted).map(([k, v]) => `${k.slice(-8)}:${v.length}`).join(',')
        const cacheSummary = Object.entries(nextCache).map(([k, v]) => `${k.slice(-8)}:${v.viewList.length}`).join(',')
        const coldSummary = Object.keys(nextColdStart).map(k => k.slice(-8)).join(',')
        logger.debug(`[CrawlTabStore] merge() | tabs:${normalizedTabs.length} ws:${workspaceTabs.length} seeds=[${seedSummary}] cache=[${cacheSummary}] coldStart=[${coldSummary}]`)
        traceTabRestore('crawlTabs:merge:normalized', {
          ...summarizeCrawlPersistState({
            tabs: normalizedTabs,
            crawlspacePersistedViews: nextPersisted,
            crawlspaceConfigById: nextConfigsById,
          }),
          cache: Object.entries(nextCache).map(([crawlspaceId, cache]) => ({
            crawlspaceId,
            activeViewId: cache.activeViewId ?? null,
            viewIds: cache.viewList.map(view => view.viewId),
          })),
          coldStartCrawlspaces: Object.keys(nextColdStart),
        })

        return {
          ...currentState,
          tabs: normalizedTabs,
          crawlspacePersistedViews: nextPersisted,
          crawlspaceConfigById: nextConfigsById,
          crawlspaceContextCache: nextCache,
          _coldStartPendingByCS: nextColdStart,
        }
      }
    })
  )
)

// 🆕 Wave 3.1: 把 crawlspace context 订阅提升到 store 层。
// 紧跟 create() ——参见上方注释，确保 applier 在任何 ensure 调用前就绪。
configureCrawlspaceContextSubscription((crawlspaceId, snapshot) => {
  useCrawlTabStore.getState().applyCrawlspaceContextSnapshot(crawlspaceId, snapshot)
})

// 🆕 Wave 3.1 复核：hot 集合驱逐时释放对应 cs 的订阅（保留 cache）。
// 与 closeCrawlspace / purgeCrawlspaceData 的释放路径互补——三者均通过
// releaseCrawlspaceContextSubscription，幂等。详见 syncer 内部说明。
installCrawlspaceHotSubscriptionSyncer(
  () => useCrawlTabStore.getState().crawlspaceConfigById,
)

// 🆕 Wave 3.3: 把 close-workspace 事件总线提升到 store 层。
// 紧跟 create() ——确保任何 requestCloseWorkspace 调用都能被路由到 store
// 的 closeCrawlspace。原本 listener 注册在 CrawlspaceShell 的 useEffect，
// Wave 2c 落地后 `<Activity hidden>` 触发 effect cleanup → listener 退订
// → 跨 Space 关闭请求**丢失**。提到 module-level 后跟 React 组件解耦，
// 任何 cs 状态（hot/hidden/cold/已 unmount）都能正确响应。
//
// closeCrawlspace 对未知 / 已删除 cs 是幂等的（views 空、tabs 空、配置空时
// set 都是 noop），所以同一 cs 被多次关闭也安全。
setCloseWorkspaceHandler(async (request) => {
  const reason = request.reason || 'close-workspace-handler'
  await useCrawlTabStore.getState().closeCrawlspace(
    request.crawlspaceId,
    reason,
    { reason },
  )
})

// beforeunload flush
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    try {
      const state = useCrawlTabStore.getState()
      const data = {
        state: partializeState(state),
        version: STORE_VERSION,
      }
      traceTabRestore('crawlTabs:beforeunloadFlush', summarizeCrawlPersistState(data.state))
      localStorage.setItem(PERSIST_KEYS.crawlTabs, JSON.stringify(data))
    } catch {
      // 静默失败
    }
  })
}

registerResetAction('crawl-tab', 'reset', () => useCrawlTabStore.getState().clearAll())
