/**
 * useTabKeyResolution — 从 SpaceContextContainer 提取的标签键解析与排序逻辑
 *
 * 负责：
 * 1. currentTabKeySet：基于多数据源、冷启动保护、persistOnly 策略计算当前可见的标签键集合
 * 2. currentTabKeys：按 tabOrder 排序的键数组
 * 3. contextItemByTabKey：将所有键解析为完整的 ContextItem（含标题三级查找）
 */
import { useCallback, useMemo } from 'react'
import { useStore } from 'zustand'
import { contextRegistry, type ContextItem, type ContextTabKey } from '../registry'
import { getResourceCacheKey, useUnifiedResources } from '@/stores/useUnifiedResources'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { tableStore } from '@/stores/useTableStore'
import { useTranslation } from 'react-i18next'

interface TabKeyResolutionParams {
  spaceId: string
  tabScopeKey?: string
  crawlspaceId?: string | null
  tabOrder: string[]
  isIsolatedScope?: boolean
  contextItemKeys: ContextTabKey[]
  contextItems: ContextItem[]
  groupedTabKeys: Set<string>
  safeActiveTabKey: string | null
  browserSourceReady: boolean
  coldStartPending: boolean
  closingViewIdSet: Set<string>
  recentlyClosedViewIds: Set<string>
  splitSubPaneSessionIds: Set<string>
  isAppEnabled: (appId?: string) => boolean
  viewInfoById: Map<string, unknown>
}

interface TabKeyResolutionResult {
  currentTabKeySet: Set<ContextTabKey>
  currentTabKeys: ContextTabKey[]
  contextItemByTabKey: Map<string, ContextItem>
}

export function useTabKeyResolution({
  spaceId,
  tabScopeKey,
  crawlspaceId,
  tabOrder,
  isIsolatedScope = false,
  contextItemKeys,
  contextItems,
  groupedTabKeys,
  safeActiveTabKey,
  browserSourceReady,
  coldStartPending,
  closingViewIdSet,
  recentlyClosedViewIds,
  splitSubPaneSessionIds,
  isAppEnabled,
  viewInfoById,
}: TabKeyResolutionParams): TabKeyResolutionResult {
  const storageKey = tabScopeKey ?? spaceId
  const { t } = useTranslation('context')
  const getResourceById = useUnifiedResources(state => state.getByResourceId)
  const spaceBucketKey = getResourceCacheKey(spaceId, 'space') ?? spaceId
  const organizationBucketKey = getResourceCacheKey(spaceId, 'organization')
  const spaceBucketResources = useUnifiedResources(state => state.resourcesBySpaceId[spaceBucketKey])
  const organizationBucketResources = useUnifiedResources(
    state => (organizationBucketKey ? state.resourcesBySpaceId[organizationBucketKey] : undefined),
  )
  const persistedItemsBySpace = useSpaceContextTabsStore(
    state => state.itemsBySpace[storageKey] || EMPTY_PERSISTED_ITEMS
  )
  const globalTables = useStore(tableStore, state => state.tables)
  const resolveAppIdForTab = useCallback((tabKey: string, type: ContextItem['type'], fallbackId: string) => {
    if (type === 'apphome') {
      const metaAppId = persistedItemsBySpace[tabKey]?.meta?.appId
      return typeof metaAppId === 'string' ? metaAppId : fallbackId
    }
    return contextRegistry.getAppId(type)
  }, [persistedItemsBySpace])

  // ── Phase 1: currentTabKeySet ──
  const currentTabKeySet = useMemo(() => {
    const keys = new Set<ContextTabKey>()
    const explicitKeySet = new Set<string>(tabOrder)
    if (safeActiveTabKey) explicitKeySet.add(safeActiveTabKey)
    groupedTabKeys.forEach(tabKey => explicitKeySet.add(tabKey))
    const shouldSkip = (tabKey: string) => {
      const parsed = contextRegistry.parseTabKey(tabKey)
      if (parsed?.type === 'terminal' && splitSubPaneSessionIds.has(parsed.id)) return true
      if (parsed?.type === 'tabweb' && (closingViewIdSet.has(parsed.id) || recentlyClosedViewIds.has(parsed.id))) return true
      if (parsed?.type) {
        const appId = resolveAppIdForTab(tabKey, parsed.type as ContextItem['type'], parsed.id)
        if (!isAppEnabled(appId)) return true
      }
      return false
    }
    contextItemKeys.forEach(key => {
      if (isIsolatedScope && !explicitKeySet.has(key)) return
      if (!shouldSkip(key)) keys.add(key)
    })
    groupedTabKeys.forEach(tabKey => { if (!shouldSkip(tabKey)) keys.add(tabKey as ContextTabKey) })
    if (safeActiveTabKey && !shouldSkip(safeActiveTabKey)) keys.add(safeActiveTabKey as ContextTabKey)

    if ((!browserSourceReady || coldStartPending) && crawlspaceId) {
      tabOrder.forEach(key => {
        const parsed = contextRegistry.parseTabKey(key)
        if (parsed?.type === 'tabweb' && !shouldSkip(key)) keys.add(key as ContextTabKey)
      })
    }

    const persistOnlyPrefixes = contextRegistry.getPersistedOnlyPrefixes()
    const liveSourcesStillCold = contextItemKeys.length === 0
    tabOrder.forEach(key => {
      if (keys.has(key as ContextTabKey)) return
      if (shouldSkip(key)) return
      if (!(key in persistedItemsBySpace)) return
      if (persistedItemsBySpace[key]?.meta?.discarded) {
        keys.add(key as ContextTabKey)
        return
      }
      const isPersistOnly = persistOnlyPrefixes.some(p => key.startsWith(p))
      if (!isPersistOnly && !liveSourcesStillCold) return
      keys.add(key as ContextTabKey)
    })

    return keys
  }, [browserSourceReady, coldStartPending, closingViewIdSet, contextItemKeys, crawlspaceId, groupedTabKeys, isAppEnabled, isIsolatedScope, persistedItemsBySpace, recentlyClosedViewIds, resolveAppIdForTab, safeActiveTabKey, splitSubPaneSessionIds, tabOrder])

  // ── Phase 2: currentTabKeys (ordered) ──
  const currentTabKeys = useMemo<ContextTabKey[]>(() => {
    const result: ContextTabKey[] = []
    const seen = new Set<ContextTabKey>()
    tabOrder.forEach(key => {
      const typedKey = key as ContextTabKey
      if (!currentTabKeySet.has(typedKey) || seen.has(typedKey)) return
      seen.add(typedKey)
      result.push(typedKey)
    })
    const missing = Array.from(currentTabKeySet).filter(key => !seen.has(key))
    missing.sort()
    missing.forEach(key => { seen.add(key); result.push(key) })
    return result
  }, [currentTabKeySet, tabOrder])

  // ── Phase 3: contextItemByTabKey ──
  const contextItemByTabKey = useMemo(() => {
    const map = new Map<string, ContextItem>()
    const resolveResourceTitle = (tabKey: string, resourceId: string, defaultTitle: string) => {
      const resource = getResourceById(resourceId, spaceId)
      const resourceTitle = typeof resource?.title === 'string' ? resource.title.trim() : ''
      if (resourceTitle) return resourceTitle
      const parsed = contextRegistry.parseTabKey(tabKey)
      if (parsed?.type === 'tabdata') {
        const tableName = globalTables.find(table => table.id === resourceId)?.name?.trim()
        if (tableName) return tableName
      }
      const persistedTitle = typeof persistedItemsBySpace[tabKey]?.title === 'string'
        ? persistedItemsBySpace[tabKey].title?.trim()
        : ''
      if (persistedTitle) return persistedTitle
      return defaultTitle
    }

    // 资源型 source（如 tabdata）自带的 title 取自各自 store（space 作用域 miss 时回退硬编码），
    // 共享表不在 spaceTables 里也会落到「未命名表格」。标题优先级：unified 桶 > 全局 table 详情 > 持久化 tab > source 默认。
    contextItems.forEach(item => {
      const title = resolveResourceTitle(item.tabKey, item.id, item.title ?? '')
      map.set(item.tabKey, title !== item.title ? { ...item, title } : item)
    })
    currentTabKeys.forEach(tabKey => {
      if (map.has(tabKey)) return
      const parsed = contextRegistry.parseTabKey(tabKey)
      if (!parsed) return
      const appId = resolveAppIdForTab(tabKey, parsed.type as ContextItem['type'], parsed.id)
      if (!isAppEnabled(appId)) return
      const handler = contextRegistry.getHandler(parsed.type as ContextItem['type'])
      if (handler?.resolveTabItem) {
        const resolved = handler.resolveTabItem(parsed.id, {
          spaceId,
          tabKey: tabKey as ContextTabKey,
          persistedItem: persistedItemsBySpace[tabKey] ?? null,
          crawlspaceId,
        })
        if (resolved) { map.set(tabKey, resolved); return }
      }
      const stubItem: ContextItem = { type: parsed.type as ContextItem['type'], id: parsed.id, tabKey: tabKey as ContextTabKey }
      const defaultTitle = handler?.getTabLabel?.(stubItem) ?? parsed.id
      const persisted = persistedItemsBySpace[tabKey]
      map.set(tabKey, {
        type: parsed.type as ContextItem['type'],
        id: parsed.id,
        tabKey: tabKey as ContextTabKey,
        title: resolveResourceTitle(tabKey, parsed.id, defaultTitle),
        meta: { spaceId, ...(persisted?.meta ?? {}) },
        ...(persisted?.originTabKey ? { originTabKey: persisted.originTabKey } : undefined),
      })
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextItems, crawlspaceId, currentTabKeys, getResourceById, globalTables, isAppEnabled, persistedItemsBySpace, spaceId, viewInfoById, t, spaceBucketResources, organizationBucketResources])

  return { currentTabKeySet, currentTabKeys, contextItemByTabKey }
}

const EMPTY_PERSISTED_ITEMS: Record<string, { title?: string; meta?: Record<string, unknown> }> = {}
