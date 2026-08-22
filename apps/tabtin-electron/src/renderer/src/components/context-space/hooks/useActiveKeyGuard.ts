import { useMemo } from 'react'
import { contextRegistry, type ContextItem, type ContextItemType } from '../registry'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'

interface ActiveKeyGuardParams {
  spaceId: string
  tabScopeKey?: string
  activeTabKey: string | null
  groupedTabKeys: Set<string>
  tabOrder: string[]
  isAppEnabled: (appId?: string) => boolean
}

interface ActiveKeyGuardResult {
  safeActiveTabKey: string | null
  activeTabType: string
  activeTableId: string | null
  activeTabMeta: { type: string; id: string } | null
  isActiveAppEnabled: boolean
  activeTabInOrder: boolean
  isActiveTabData: boolean
}

/**
 * 纯计算 hook：根据当前 activeTabKey 判断其是否仍然有效，
 * 产出 safeActiveTabKey（无效时为 null）以及激活标签的派生元信息。
 *
 * 不包含任何 effect —— 守卫副作用（自动切换/回退）在 useTabSync 中统一处理。
 */
export function useActiveKeyGuard({
  spaceId,
  tabScopeKey,
  activeTabKey,
  groupedTabKeys,
  tabOrder,
  isAppEnabled,
}: ActiveKeyGuardParams): ActiveKeyGuardResult {
  const storageKey = tabScopeKey ?? spaceId
  const recentlyClosedViewIds = useCrawlTabStore(state => state._recentlyClosedViewIds)

  const activeTabMeta = useMemo(() => {
    if (!activeTabKey) return null
    return contextRegistry.parseTabKey(activeTabKey)
  }, [activeTabKey])

  const activePersistedItem = useSpaceContextTabsStore(state =>
    activeTabKey ? state.itemsBySpace[storageKey]?.[activeTabKey] ?? null : null
  )

  const activeTabAppId = useMemo(() => {
    if (!activeTabMeta?.type) return undefined
    if (activeTabMeta.type === 'apphome') {
      const metaAppId = activePersistedItem?.meta?.appId
      return typeof metaAppId === 'string' ? metaAppId : activeTabMeta.id
    }
    return contextRegistry.getAppId(activeTabMeta.type as ContextItem['type'])
  }, [activePersistedItem?.meta, activeTabMeta])

  const isActiveAppEnabled = isAppEnabled(activeTabAppId)
  const activeTabType = isActiveAppEnabled ? (activeTabMeta?.type ?? 'home') : 'home'
  const isActiveTabData = Boolean(
    activeTabMeta && contextRegistry.getAppMeta(activeTabMeta.type as ContextItemType)?.idField === 'current_table_id'
  )
  const activeTableId = isActiveAppEnabled && isActiveTabData ? activeTabMeta!.id : null

  const isActiveRecentlyClosed = Boolean(
    activeTabMeta?.type === 'tabweb' && recentlyClosedViewIds.has(activeTabMeta.id)
  )
  const activeTabInOrder = Boolean(activeTabKey && tabOrder.includes(activeTabKey))

  const shouldKeepActiveKey = Boolean(
    activeTabKey &&
    (groupedTabKeys.has(activeTabKey) || !isActiveTabData || activeTabInOrder)
  ) && isActiveAppEnabled && !isActiveRecentlyClosed
  const safeActiveTabKey = shouldKeepActiveKey ? activeTabKey : null

  return {
    safeActiveTabKey,
    activeTabType,
    activeTableId,
    activeTabMeta,
    isActiveAppEnabled,
    activeTabInOrder,
    isActiveTabData,
  }
}
