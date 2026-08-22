/**
 * Context snapshot slice — applyCrawlspaceContextSnapshot,
 * setCrawlspaceViewMeta, ensureCrawlspaceContextCache.
 *
 * Manages the merging of main-process context snapshots into
 * the renderer-side cache, and seed synchronization for restart recovery.
 */

import i18n from '@/i18n'
import type {
  CrawlspaceViewInfo,
  CrawlspaceViewMetaUpdates,
  CrawlspacePersistedViewSeed,
  CrawlspaceContextCache,
} from '../types'
import {
  applyViewMetaUpdatesToCache,
  applyViewMetaUpdatesToSeeds,
  canReuseFaviconForUrl,
} from '../viewMetaUpdates'

// ---------------------------------------------------------------------------
// SnapshotInput — shape of the main-process context snapshot
// ---------------------------------------------------------------------------

export type SnapshotInput = {
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
    openIntentHints?: CrawlspacePersistedViewSeed['openIntentHints']
    resourceSummary?: {
      total: number
      byCategory: Partial<Record<string, number>>
      byCaptureStatus?: Partial<Record<string, number>>
    }
    createdAt?: number
    updatedAt?: number
  }>
}

function hasOwn<T extends object, K extends PropertyKey>(
  object: T,
  key: K,
): object is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(object, key)
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export function applyCacheSnapshot(
  crawlspaceId: string,
  snapshot: SnapshotInput,
  cacheViews: CrawlspaceViewInfo[],
  seedMap: Map<string, CrawlspacePersistedViewSeed>,
  closedViewIds?: ReadonlySet<string>,
  deferredViewIds?: ReadonlySet<string>,
): CrawlspaceContextCache {
  const currentMap = new Map(cacheViews.map(view => [view.viewId, view]))
  const newTabTitle = i18n.t('context:label.newTab')
  const untitledTab = i18n.t('context:label.untitledTab')
  const isDefaultTitle = (title?: string): boolean =>
    !title || title === newTabTitle || title === untitledTab
  const visibleSnapshotViews = closedViewIds && closedViewIds.size > 0
    ? snapshot.views.filter(view => !closedViewIds.has(view.viewId))
    : snapshot.views

  const nextViewList: CrawlspaceViewInfo[] = visibleSnapshotViews.map(view => {
    const existing = currentMap.get(view.viewId)
    const seed = seedMap.get(view.viewId)

    // # renderer-driven 字段抖动保护（url / title / isPreview）
    //
    // 用户场景：renderer 立即写 store（如地址栏导航 setCrawlspaceViewMeta /
    // useCrawlSpacePreview.ensurePreview），主进程随后追上发 snapshot。如果
    // snapshot 中对应字段还是旧值（webContents 事件未 catch up），不能让 cache
    // 倒退——renderer 的最新写入是用户当前看到的事实。
    //
    // 历史：之前由 mergeViews 在 adapter 层做"双向择优"（snapshot 是主权但
    // store 在某些条件下 prefer），Wave 3.1 把订阅提到 store 层后这层防御
    // 必须下沉到 applyCacheSnapshot 才能不破契约。
    const storeUrl = typeof existing?.url === 'string' ? existing.url : ''
    const shouldPreferStoreUrl =
      storeUrl !== '' &&
      storeUrl !== 'about:blank' &&
      storeUrl !== view.url
    const resolvedUrl = shouldPreferStoreUrl
      ? storeUrl
      : (view.url || storeUrl || seed?.url || 'about:blank')

    const storeTitle = typeof existing?.title === 'string' ? existing.title : ''
    const shouldPreferStoreTitle =
      storeTitle !== '' &&
      storeTitle !== view.title &&
      !isDefaultTitle(storeTitle)
    const resolvedTitle = shouldPreferStoreTitle
      ? storeTitle
      : (!isDefaultTitle(view.title)
          ? view.title!
          : (storeTitle || view.title || seed?.title || newTabTitle))
    const existingFavicon = canReuseFaviconForUrl(existing?.url, resolvedUrl)
      ? existing?.favicon
      : undefined
    const seedFavicon = canReuseFaviconForUrl(seed?.url, resolvedUrl)
      ? seed?.favicon
      : undefined
    const existingOpenIntentHints = existing?.url === resolvedUrl
      ? existing?.openIntentHints
      : undefined
    const seedOpenIntentHints = seed?.url === resolvedUrl
      ? seed?.openIntentHints
      : undefined

    return {
      viewId: view.viewId,
      title: resolvedTitle,
      url: resolvedUrl,
      favicon: view.favicon ?? existingFavicon ?? seedFavicon,
      runId: view.runId ?? existing?.runId ?? seed?.runId,
      createdAt: existing?.createdAt ?? seed?.createdAt ?? view.createdAt ?? view.updatedAt ?? Date.now(),
      kind: existing?.kind || seed?.kind || 'workspace-view',
      crawlspaceId,
      // isPreview 是 renderer 主权字段（preview 切换不走 IPC 通知主进程，
      // 见 useCrawlSpacePreview）。cache 已有 boolean 时优先 cache，避免
      // 主进程默认 false 把 renderer 的 true 覆盖回去。
      isPreview: typeof existing?.isPreview === 'boolean'
        ? existing.isPreview
        : (view.isPreview ?? seed?.isPreview ?? false),
      isClosing: Boolean(view.isClosing),
      isLoading: view.isLoading ?? existing?.isLoading ?? false,
      themeColor: hasOwn(view, 'themeColor')
        ? view.themeColor
        : existing?.themeColor,
      hasError: view.hasError ?? false,
      errorDescription: view.errorDescription ?? undefined,
      resourceSummary: view.resourceSummary ?? existing?.resourceSummary,
      openIntentHints: view.openIntentHints ?? existingOpenIntentHints ?? seedOpenIntentHints,
      updatedAt: view.updatedAt ?? existing?.updatedAt,
    }
  })

  // 🆕 Deferred views (renderer-side placeholders not yet realized in main process)
  // are absent from the main-process snapshot. Without explicit handling
  // applyCacheSnapshot would drop them. We re-attach the deferred views from
  // the existing cache so they survive snapshot rebuild.
  if (deferredViewIds && deferredViewIds.size > 0) {
    const includedViewIds = new Set(nextViewList.map(view => view.viewId))
    for (const cacheView of cacheViews) {
      if (!deferredViewIds.has(cacheView.viewId)) continue
      if (includedViewIds.has(cacheView.viewId)) continue
      if (closedViewIds && closedViewIds.has(cacheView.viewId)) continue
      nextViewList.push(cacheView)
    }
  }

  const nextActiveViewId = snapshot.activeViewId && nextViewList.some(view => view.viewId === snapshot.activeViewId)
    ? snapshot.activeViewId
    : (nextViewList.find(view => !view.isClosing)?.viewId ?? null)

  return {
    activeViewId: nextActiveViewId,
    viewList: nextViewList,
  }
}

const MAX_SEEDS_PER_CRAWLSPACE = 20

export function syncSeedsFromSnapshot(
  crawlspaceId: string,
  snapshot: SnapshotInput,
  nextViewList: CrawlspaceViewInfo[],
  cacheViews: CrawlspaceViewInfo[],
  existingSeeds: CrawlspacePersistedViewSeed[],
  seedMap: Map<string, CrawlspacePersistedViewSeed>,
  isColdStart: boolean,
  closedViewIds?: ReadonlySet<string>,
): CrawlspacePersistedViewSeed[] {
  const activeViewId = snapshot.activeViewId ?? null
  const newTabTitle = i18n.t('context:label.newTab')
  const visibleViews = nextViewList.filter(view =>
    !view.isClosing && !(closedViewIds && closedViewIds.has(view.viewId))
  )
  const visibleIds = new Set(visibleViews.map(view => view.viewId))
  const effectiveSeeds = closedViewIds && closedViewIds.size > 0
    ? existingSeeds.filter(s => !closedViewIds.has(s.viewId))
    : existingSeeds

  if (visibleViews.length === 0 && effectiveSeeds.length > 0) {
    return effectiveSeeds
  }

  const mergedSeedMap = new Map<string, CrawlspacePersistedViewSeed>()

  if (isColdStart) {
    effectiveSeeds.forEach(seed => {
      mergedSeedMap.set(seed.viewId, seed)
    })
  }

  const MAX_FAVICON_SIZE = 10240
  visibleViews.forEach(view => {
    const prev = mergedSeedMap.get(view.viewId) || seedMap.get(view.viewId)
    const positionInBar = nextViewList.findIndex(v => v.viewId === view.viewId)
    const isCurrentlyActive = activeViewId ? activeViewId === view.viewId : false
    const reusablePrevFavicon = canReuseFaviconForUrl(prev?.url, view.url)
      ? prev?.favicon
      : undefined
    const candidateFavicon = view.favicon ?? reusablePrevFavicon
    const safeFavicon = candidateFavicon && candidateFavicon.length <= MAX_FAVICON_SIZE
      ? candidateFavicon
      : (reusablePrevFavicon && reusablePrevFavicon.length <= MAX_FAVICON_SIZE ? reusablePrevFavicon : undefined)
    const prevOpenIntentHints = prev?.url === view.url ? prev?.openIntentHints : undefined
    mergedSeedMap.set(view.viewId, {
      viewId: view.viewId,
      title: view.title || prev?.title || newTabTitle,
      url: view.url || prev?.url || 'about:blank',
      favicon: safeFavicon,
      runId: view.runId ?? prev?.runId,
      kind: view.kind || prev?.kind || 'workspace-view',
      crawlspaceId: view.crawlspaceId || prev?.crawlspaceId || crawlspaceId,
      isPreview: view.isPreview ?? prev?.isPreview ?? false,
      isActive: activeViewId ? isCurrentlyActive : Boolean(prev?.isActive),
      createdAt: view.createdAt || prev?.createdAt || Date.now(),
      position: positionInBar >= 0 ? positionInBar : (prev?.position ?? undefined),
      lastAccessedAt: isCurrentlyActive ? Date.now() : (prev?.lastAccessedAt ?? prev?.createdAt),
      // ：file:// 预览放行根只由打开链路写入，快照重建时必须保留，
      // 否则重启恢复的预览 tab 会被主进程安全门禁拒绝而空白。
      localPreviewRoot: prev?.localPreviewRoot,
      openIntentHints: view.openIntentHints ?? prevOpenIntentHints,
    })
  })

  if (!isColdStart) {
    effectiveSeeds.forEach(seed => {
      if (visibleIds.has(seed.viewId)) return
      // 主进程 snapshot 只表达“此刻仍有 WebContentsView”，不表达用户是否关闭标签。
      // 正常退出 / LRU 回收会逐个销毁 View；如果据 snapshot 缩减同步删除 seed，
      // beforeunload 最终会把标签池覆盖成“只剩最后一个”。用户主动关闭已经由
      // closedViewIds（_recentlyClosedViewIds）提供明确意图，因此其余缺席 View
      // 都保留 seed，供下次启动按需恢复。
      mergedSeedMap.set(seed.viewId, seed)
    })
  }

  const preferredActiveViewId =
    (activeViewId && mergedSeedMap.has(activeViewId) ? activeViewId : null) ||
    effectiveSeeds.find(seed => seed.isActive && mergedSeedMap.has(seed.viewId))?.viewId ||
    null

  const SEED_STALE_MS = 7 * 24 * 60 * 60 * 1000
  const staleThreshold = Date.now() - SEED_STALE_MS
  for (const [id, seed] of mergedSeedMap.entries()) {
    if (id === preferredActiveViewId) continue
    const lastAccess = seed.lastAccessedAt ?? seed.createdAt ?? 0
    if (lastAccess < staleThreshold) {
      mergedSeedMap.delete(id)
    }
  }

  if (mergedSeedMap.size > MAX_SEEDS_PER_CRAWLSPACE) {
    const candidates = Array.from(mergedSeedMap.entries())
      .filter(([id]) => id !== preferredActiveViewId)
      .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
    const excess = mergedSeedMap.size - MAX_SEEDS_PER_CRAWLSPACE
    for (let i = 0; i < excess && i < candidates.length; i++) {
      mergedSeedMap.delete(candidates[i][0])
    }
  }

  return Array.from(mergedSeedMap.values())
    .map(seed => ({
      ...seed,
      isActive: preferredActiveViewId ? seed.viewId === preferredActiveViewId : Boolean(seed.isActive),
    }))
    .sort((a, b) => {
      const posA = a.position ?? Infinity
      const posB = b.position ?? Infinity
      if (posA !== posB) return posA - posB
      return a.createdAt - b.createdAt
    })
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface ContextSnapshotStore {
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>
  crawlspacePersistedViews: Record<string, CrawlspacePersistedViewSeed[]>
  /**
   * 🆕 Deferred (placeholder) view IDs per crawlspace.
   *
   * When the renderer restores tabs lazily, some viewIds are kept in the
   * cache as placeholders without a corresponding main-process BrowserView.
   * These views are absent from main-process snapshots, so we track them
   * here to keep them alive across snapshot apply cycles.
   */
  crawlspaceDeferredViewIdsByCS: Record<string, Set<string>>
  _coldStartPendingByCS: Record<string, boolean>
  _recentlyClosedViewIds: Set<string>
}

type GetFn = () => ContextSnapshotStore
type SetFn = (
  partial:
    | Partial<ContextSnapshotStore>
    | ((state: ContextSnapshotStore) => Partial<ContextSnapshotStore>),
) => void

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const EMPTY_CRAWLSPACE_VIEWS: CrawlspaceViewInfo[] = []

export function createContextSnapshotActions(get: GetFn, set: SetFn) {
  return {
    applyCrawlspaceContextSnapshot: (crawlspaceId: string, snapshot: SnapshotInput) => {
      set((state) => {
        const cacheViews = state.crawlspaceContextCache[crawlspaceId]?.viewList ?? EMPTY_CRAWLSPACE_VIEWS
        const existingSeeds = state.crawlspacePersistedViews[crawlspaceId] || []
        const seedMap = new Map(existingSeeds.map(view => [view.viewId, view]))
        const isColdStart = Boolean(state._coldStartPendingByCS[crawlspaceId])
        const deferredIds = state.crawlspaceDeferredViewIdsByCS[crawlspaceId]

        const nextCache = applyCacheSnapshot(
          crawlspaceId,
          snapshot,
          cacheViews,
          seedMap,
          state._recentlyClosedViewIds,
          deferredIds,
        )
        const nextSeeds = syncSeedsFromSnapshot(
          crawlspaceId, snapshot, nextCache.viewList, cacheViews, existingSeeds, seedMap, isColdStart,
          state._recentlyClosedViewIds,
        )

        if (isColdStart || nextSeeds.length !== existingSeeds.length) {
          console.log(`[CrawlTabStore] snapshot | cs:${crawlspaceId.slice(-8)} views:${snapshot.views.length} seeds:${existingSeeds.length}->${nextSeeds.length} cold:${isColdStart}`)
        }

        return {
          crawlspaceContextCache: {
            ...state.crawlspaceContextCache,
            [crawlspaceId]: nextCache,
          },
          crawlspacePersistedViews: {
            ...state.crawlspacePersistedViews,
            [crawlspaceId]: nextSeeds,
          },
        }
      })
    },

    markCrawlspaceViewDeferred: (crawlspaceId: string, viewId: string) => {
      set((state) => {
        const existing = state.crawlspaceDeferredViewIdsByCS[crawlspaceId]
        if (existing && existing.has(viewId)) return state as any
        const next = new Set(existing ?? [])
        next.add(viewId)
        return {
          crawlspaceDeferredViewIdsByCS: {
            ...state.crawlspaceDeferredViewIdsByCS,
            [crawlspaceId]: next,
          },
        }
      })
    },

    unmarkCrawlspaceViewDeferred: (crawlspaceId: string, viewId: string) => {
      set((state) => {
        const existing = state.crawlspaceDeferredViewIdsByCS[crawlspaceId]
        if (!existing || !existing.has(viewId)) return state as any
        const next = new Set(existing)
        next.delete(viewId)
        if (next.size === 0) {
          const { [crawlspaceId]: _removed, ...rest } = state.crawlspaceDeferredViewIdsByCS
          return { crawlspaceDeferredViewIdsByCS: rest }
        }
        return {
          crawlspaceDeferredViewIdsByCS: {
            ...state.crawlspaceDeferredViewIdsByCS,
            [crawlspaceId]: next,
          },
        }
      })
    },

    setCrawlspaceViewMeta: (
      crawlspaceId: string,
      viewId: string,
      updates: CrawlspaceViewMetaUpdates,
    ) => {
      set((state) => {
        const cache = state.crawlspaceContextCache[crawlspaceId]
        const seeds = state.crawlspacePersistedViews[crawlspaceId]
        const nextCache = applyViewMetaUpdatesToCache(cache, viewId, updates)
        const nextSeeds = applyViewMetaUpdatesToSeeds(seeds, viewId, updates)
        if (nextCache === cache && nextSeeds === seeds) return state as any

        return {
          crawlspaceContextCache:
            nextCache === cache
              ? state.crawlspaceContextCache
              : {
                  ...state.crawlspaceContextCache,
                  [crawlspaceId]: nextCache ?? { activeViewId: null, viewList: [] },
                },
          crawlspacePersistedViews:
            nextSeeds === seeds
              ? state.crawlspacePersistedViews
              : {
                  ...state.crawlspacePersistedViews,
                  [crawlspaceId]: nextSeeds ?? [],
                },
        }
      })
    },

    // ensureCrawlspaceContextCache 由 configSlice 单一持有——见
    // configSlice.ts，那里一并触发 ensureCrawlspaceContextSubscription。
    // 历史上这里有同名重复定义，被 configSlice 的 spread 覆盖；Wave 3.1
    // 清理掉以避免 spread 顺序变更时静默丢失订阅触发。
  }
}
