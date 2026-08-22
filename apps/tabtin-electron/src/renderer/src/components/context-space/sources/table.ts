import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { useSpaceTables } from '@components/context-space/hooks/useSpaceTables'
import { contextRegistry } from '@components/context-space/registry/instance'
import type { TableContextSourceResult } from './types'
import i18n from '@/i18n'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { tableStore } from '@/stores/useTableStore'

type UseTableContextSourceOptions = {
  spaceId?: string
  tabScopeKey?: string
  tabOrder: string[]
}

export const useTableContextSource = ({
  spaceId: spaceIdProp,
  tabScopeKey,
  tabOrder
}: UseTableContextSourceOptions): TableContextSourceResult => {
  const spaceId = spaceIdProp ?? ''
  const storageKey = tabScopeKey || spaceId
  // ：表格挂 Organization，默认按组织作用域加载
  const { spaceTables, isLoading, error, createTable, createTableInSpace, resolvedOrganizationId } = useSpaceTables(
    spaceId,
    undefined,
    'organization',
  )
  const persistedItems = useSpaceContextTabsStore(
    state => (storageKey ? state.itemsBySpace[storageKey] : undefined) ?? EMPTY_PERSISTED_ITEMS,
  )
  const globalTables = useStore(tableStore, state => state.tables)

  const tableTitleMap = useMemo(() => {
    const map = new Map<string, string>()
    spaceTables.forEach(table => {
      map.set(table.id, table.name || i18n.t('label.untitledTable', { ns: 'context' }))
    })
    return map
  }, [spaceTables])

  const openTableIds = useMemo(() => {
    const seen = new Set<string>()
    return tabOrder
      .map(key => contextRegistry.parseTabKey(key))
      .filter((parsed): parsed is { type: string; id: string } => Boolean(parsed?.type && parsed?.id))
      .filter(parsed => parsed.type === 'tabdata')
      .map(parsed => parsed.id)
      .filter(id => {
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
  }, [tabOrder])

  const items = useMemo(() => {
    const untitled = i18n.t('label.untitledTable', { ns: 'context' })
    return openTableIds.map(tableId => {
      const tabKey = contextRegistry.buildTabKey('tabdata', tableId)
      const fromSpace = tableTitleMap.get(tableId)
      const fromGlobal = globalTables.find(table => table.id === tableId)?.name?.trim()
      const fromPersisted = persistedItems[tabKey]?.title?.trim()
      const title = (fromSpace && fromSpace !== untitled ? fromSpace : '')
        || fromGlobal
        || fromPersisted
        || untitled
      return {
        type: 'tabdata' as const,
        id: tableId,
        tabKey,
        title,
      }
    })
  }, [globalTables, openTableIds, persistedItems, tableTitleMap])

  useEffect(() => {
    traceTabRestore('tableSource:state', {
      spaceId,
      tabOrder,
      openTableIds,
      itemKeys: items.map(item => item.tabKey),
      tableIds: spaceTables.map(table => table.id),
      isLoading,
      hasError: Boolean(error),
    })
  }, [error, isLoading, items, openTableIds, spaceId, spaceTables, tabOrder])

  return {
    tables: spaceTables,
    items,
    openTableIds,
    isLoading,
    error,
    createTable,
    createTableInSpace,
    selectedOrganizationId: resolvedOrganizationId
  }
}

const EMPTY_PERSISTED_ITEMS: Record<string, { title?: string }> = {}
