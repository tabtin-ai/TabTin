/**
 * Seed / cold-start slice — markColdStartComplete, ensureViewSeed,
 * getPersistedCrawlspaceViews.
 *
 * Manages the restart-recovery seed data and cold-start flags.
 */

import type { CrawlspacePersistedViewSeed } from '../types'

const MAX_SEEDS_PER_CRAWLSPACE = 20

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface SeedStore {
  _coldStartPendingByCS: Record<string, boolean>
  crawlspacePersistedViews: Record<string, CrawlspacePersistedViewSeed[]>
  _recentlyClosedViewIds: Set<string>
}

type GetFn = () => SeedStore
type SetFn = (
  partial:
    | Partial<SeedStore>
    | ((state: SeedStore) => Partial<SeedStore>),
) => void

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSeedActions(get: GetFn, set: SetFn) {
  return {
    markColdStartComplete: (crawlspaceId: string) => {
      set(state => {
        const next = { ...state._coldStartPendingByCS }
        delete next[crawlspaceId]

        // 清理 _recentlyClosedViewIds：移除已不在任何 seed 列表中的条目
        let nextClosedIds = state._recentlyClosedViewIds
        if (nextClosedIds.size > 0) {
          const allSeedViewIds = new Set<string>()
          for (const seeds of Object.values(state.crawlspacePersistedViews)) {
            for (const s of seeds) allSeedViewIds.add(s.viewId)
          }
          const pruned = new Set<string>()
          for (const id of nextClosedIds) {
            if (allSeedViewIds.has(id)) pruned.add(id)
          }
          if (pruned.size !== nextClosedIds.size) {
            nextClosedIds = pruned
          }
        }

        if (globalThis.__TABTIN_DEBUG_TAB_SWITCH__) {
          console.log('%c[CrawlTabStore] markColdStartComplete', 'color: #4CAF50; font-weight: bold', {
            crawlspaceId,
            remainingColdStarts: Object.keys(next),
            closedIdsPruned: state._recentlyClosedViewIds.size - nextClosedIds.size,
          })
        }
        return {
          _coldStartPendingByCS: next,
          _recentlyClosedViewIds: nextClosedIds,
        }
      })
    },

    ensureViewSeed: (
      crawlspaceId: string,
      seed: Partial<CrawlspacePersistedViewSeed> & { viewId: string; url: string },
    ) => {
      set(state => {
        const existing = state.crawlspacePersistedViews[crawlspaceId] || []
        const current = existing.find(s => s.viewId === seed.viewId)
        if (current) {
          // 种子已存在只补缺字段：view 事件回调可能先落了一条不带恢复
          // metadata 的种子，打开链路随后补上安全/预览判断所需 metadata。
          const patch: Partial<CrawlspacePersistedViewSeed> = {}
          if (seed.localPreviewRoot && !current.localPreviewRoot) {
            patch.localPreviewRoot = seed.localPreviewRoot
          }
          if (
            seed.openIntentHints &&
            !current.openIntentHints &&
            current.url === seed.url
          ) {
            patch.openIntentHints = seed.openIntentHints
          }
          if (Object.keys(patch).length > 0) {
            return {
              crawlspacePersistedViews: {
                ...state.crawlspacePersistedViews,
                [crawlspaceId]: existing.map(s =>
                  s.viewId === seed.viewId ? { ...s, ...patch } : s,
                ),
              },
            }
          }
          return state as any
        }
        const newSeed: CrawlspacePersistedViewSeed = {
          viewId: seed.viewId,
          title: seed.title || '',
          url: seed.url,
          favicon: seed.favicon,
          runId: seed.runId,
          kind: seed.kind || 'workspace-view',
          crawlspaceId,
          isPreview: seed.isPreview ?? false,
          isActive: seed.isActive ?? false,
          createdAt: seed.createdAt ?? Date.now(),
          position: seed.position,
          lastAccessedAt: Date.now(),
          localPreviewRoot: seed.localPreviewRoot,
          openIntentHints: seed.openIntentHints,
        }
        let seeds = [...existing, newSeed]
        if (seeds.length > MAX_SEEDS_PER_CRAWLSPACE) {
          const activeId = seeds.find(s => s.isActive)?.viewId
          seeds.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
          const evictable = seeds.filter(s => s.viewId !== activeId && s.viewId !== seed.viewId)
          const excess = seeds.length - MAX_SEEDS_PER_CRAWLSPACE
          const toRemove = new Set(evictable.slice(0, excess).map(s => s.viewId))
          seeds = seeds.filter(s => !toRemove.has(s.viewId))
        }
        return {
          crawlspacePersistedViews: {
            ...state.crawlspacePersistedViews,
            [crawlspaceId]: seeds,
          },
        }
      })
    },

    getPersistedCrawlspaceViews: (crawlspaceId: string): CrawlspacePersistedViewSeed[] => {
      return get().crawlspacePersistedViews[crawlspaceId] || []
    },
  }
}
