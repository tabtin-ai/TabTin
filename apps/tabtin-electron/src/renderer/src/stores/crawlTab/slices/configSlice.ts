/**
 * Config slice — ensureCrawlspaceConfig, getCrawlspaceConfig,
 * getCrawlspaceViews, getActiveCrawlspaceViewId, ensureCrawlspaceContextCache,
 * setCrawlspaceViewMeta, purgeCrawlspaceData.
 *
 * Extracted from useCrawlTabStore.ts for single-responsibility.
 */

import { getAgentWorkspaceDefaults, getWorkspaceDefaults } from '../../../crawlspace/workspace-defaults'
import { logger } from '@/utils/logger'
import { getPartitionForSpaceSync } from '../../browserEnvSnapshot'
import type {
  CrawlTab,
  CrawlspaceConfig,
  CrawlspaceViewInfo,
  CrawlspaceViewMetaUpdates,
  CrawlspaceContextCache,
  CrawlspacePersistedViewSeed,
} from '../types'
import {
  applyViewMetaUpdatesToCache,
  applyViewMetaUpdatesToSeeds,
} from '../viewMetaUpdates'
import {
  ensureCrawlspaceContextSubscription,
  releaseCrawlspaceContextSubscription,
} from '../crawlspaceContextSubscriptionRegistry'

const EMPTY_CRAWLSPACE_VIEWS: CrawlspaceViewInfo[] = []

export interface ConfigStore {
  tabs: CrawlTab[]
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>
  crawlspaceDeferredViewIdsByCS: Record<string, Set<string>>
  crawlspacePersistedViews: Record<string, CrawlspacePersistedViewSeed[]>
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  _coldStartPendingByCS: Record<string, boolean>
}

type GetFn = () => ConfigStore
type SetFn = (
  partial: Partial<ConfigStore> | ((state: ConfigStore) => Partial<ConfigStore>),
) => void

export function createConfigActions(get: GetFn, set: SetFn) {
  return {
    ensureCrawlspaceConfig: (crawlspaceId: string): CrawlspaceConfig | null => {
      const state = get()
      const existing = state.crawlspaceConfigById[crawlspaceId]
      if (existing) return existing

      const workspaceTab = state.tabs.find(tab => tab.kind === 'workspace' && tab.id === crawlspaceId)
      const metaConfig = workspaceTab?.metadata?.crawlspaceConfig

      const resolveDefaults = (pluginId?: string) => {
        if (pluginId) {
          const pluginDefaults = getWorkspaceDefaults(pluginId)
          if (pluginDefaults) return pluginDefaults
          if (globalThis.__TABTIN_DEBUG_TAB_SWITCH__) {
            console.warn('[CrawlTabStore] Plugin default config not found, using Agent defaults:', { crawlspaceId, pluginId })
          }
        }
        return getAgentWorkspaceDefaults()
      }

      const defaults = resolveDefaults(metaConfig?.pluginId)
      const cfgSpaceId = metaConfig?.spaceId ?? metaConfig?.projectId
      const fallbackConfig: CrawlspaceConfig = {
        crawlspaceId,
        spaceId: cfgSpaceId,
        pluginId: metaConfig?.pluginId,
        pluginConfig: metaConfig?.pluginConfig,
        uiConfig: metaConfig?.uiConfig ?? defaults.uiConfig,
        profile: metaConfig?.profile ?? defaults.profile,
        // 历史兼容兜底：metadata 无 partition 时通过 BES 镜像按 spaceId 解析；
        // 镜像未就绪时返回默认 env partition，加载完成后由 tabsSlice 的
        // snapshot listener 统一升级。
        partition: metaConfig?.partition || getPartitionForSpaceSync(cfgSpaceId),
        runPrefix: metaConfig?.runPrefix ?? defaults.runPrefix
      }

      set((prev) => {
        const nextConfigs = {
          ...prev.crawlspaceConfigById,
          [crawlspaceId]: fallbackConfig
        }
        let nextTabs = prev.tabs
        if (workspaceTab) {
          const existingConfig = workspaceTab.metadata?.crawlspaceConfig
          const shouldPatchTab = !existingConfig || !existingConfig.profile || !existingConfig.partition
          if (shouldPatchTab) {
            nextTabs = prev.tabs.map(tab => {
              if (tab.id !== crawlspaceId || tab.kind !== 'workspace') return tab
              return {
                ...tab,
                metadata: {
                  ...tab.metadata,
                  crawlspaceConfig: fallbackConfig
                }
              }
            })
          }
        }
        return {
          crawlspaceConfigById: nextConfigs,
          tabs: nextTabs
        }
      })

      return fallbackConfig
    },

    getCrawlspaceConfig: (crawlspaceId: string): CrawlspaceConfig | null => {
      return get().crawlspaceConfigById[crawlspaceId] || null
    },

    getCrawlspaceViews: (crawlspaceId: string): CrawlspaceViewInfo[] => {
      const cache = get().crawlspaceContextCache[crawlspaceId]
      if (!cache) return EMPTY_CRAWLSPACE_VIEWS
      return cache.viewList
    },

    getActiveCrawlspaceViewId: (crawlspaceId: string): string | null => {
      const cache = get().crawlspaceContextCache[crawlspaceId]
      if (!cache) return null
      return cache.activeViewId
    },

    ensureCrawlspaceContextCache: (crawlspaceId: string) => {
      const cache = get().crawlspaceContextCache[crawlspaceId]
      if (!cache) {
        set((state) => ({
          crawlspaceContextCache: {
            ...state.crawlspaceContextCache,
            [crawlspaceId]: { activeViewId: null, viewList: [] }
          }
        }))
      }
      // 🆕 Wave 3.1: 业务实体进入"应当显示"状态时立即建立订阅。
      // 幂等——已订阅的 crawlspaceId 直接返回；切换 Space hidden 不再
      // 取消订阅，store 持续接收主进程 snapshot 推送。
      ensureCrawlspaceContextSubscription(crawlspaceId)
    },

    setCrawlspaceViewMeta: (
      crawlspaceId: string,
      viewId: string,
      updates: CrawlspaceViewMetaUpdates
    ) => {
      set((state) => {
        const cache = state.crawlspaceContextCache[crawlspaceId]
        const seeds = state.crawlspacePersistedViews[crawlspaceId]
        const nextCache = applyViewMetaUpdatesToCache(cache, viewId, updates)
        const nextSeeds = applyViewMetaUpdatesToSeeds(seeds, viewId, updates)
        if (nextCache === cache && nextSeeds === seeds) return {}
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

    purgeCrawlspaceData: (crawlspaceId: string) => {
      // 🆕 Wave 3.1: 业务实体被销毁时同步释放订阅；deferred IDs 也清掉。
      releaseCrawlspaceContextSubscription(crawlspaceId)
      set(state => {
        const nextTabs = state.tabs.filter(t => t.id !== crawlspaceId)
        const { [crawlspaceId]: _p, ...nextPersisted } = state.crawlspacePersistedViews
        const { [crawlspaceId]: _c, ...nextConfig } = state.crawlspaceConfigById
        const { [crawlspaceId]: _cs, ...nextColdStart } = state._coldStartPendingByCS
        const { [crawlspaceId]: _cache, ...nextCache } = state.crawlspaceContextCache
        const { [crawlspaceId]: _deferred, ...nextDeferred } = state.crawlspaceDeferredViewIdsByCS
        return {
          tabs: nextTabs,
          crawlspacePersistedViews: nextPersisted,
          crawlspaceConfigById: nextConfig,
          _coldStartPendingByCS: nextColdStart,
          crawlspaceContextCache: nextCache,
          crawlspaceDeferredViewIdsByCS: nextDeferred,
        }
      })
      logger.debug('[CrawlTabStore] purgeCrawlspaceData:', crawlspaceId)
    },
  }
}
