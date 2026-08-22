/**
 * 云文档侧栏不在 SpaceContextAreaProvider 内，需独立接 createHandlers，
 * 且 navigation / tab 打开必须落在 cloud-docs scope。
 */
import { useCallback, useMemo } from 'react'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceApps } from '@stores/useSpaceApps'
import { useSpaceContextTabsStore, EMPTY_CONTEXT_ITEMS, EMPTY_TAB_ORDER } from '@stores/useSpaceContextTabsStore'
import {
  useCreateHandlers,
  type CreateResourceHandler,
  type CreateResourceOptions,
} from '@components/context-space/hooks/useCreateHandlers'
import { useSpaceContextNavigation } from '@components/context-space/hooks/useSpaceContextNavigation'
import { useTableContextSource } from '@components/context-space/sources'
import { resolveCloudDocsHostSpaceId } from './cloud-docs/cloudDocsHostSpace'

export function useCloudDocsSidebarCreateHandlers(input: {
  organizationId: string
  tabScopeKey: string
  resourceHostSpaceId?: string | null
}): {
  createHandlers: Record<string, CreateResourceHandler>
  onCreateResource: (appId: string, options?: CreateResourceOptions) => void
} {
  const { organizationId, tabScopeKey, resourceHostSpaceId = null } = input
  const storeOrganizationId = useOrganizationStore(state => state.getEffectiveOrganizationId())
  const spaces = useSpaceStore(state => state.spaces)
  const effectiveHostSpaceId = resolveCloudDocsHostSpaceId({
    organizationId,
    resourceHostSpaceId,
    spaces,
    storeOrganizationId,
  }) ?? ''
  const hostSpace = useSpaceStore(state => (
    effectiveHostSpaceId
      ? state.spaces.find(item => item.id === effectiveHostSpaceId) ?? null
      : null
  ))
  const tabOrder = useSpaceContextTabsStore(state => state.tabOrderBySpace[tabScopeKey] ?? EMPTY_TAB_ORDER)
  const tableSource = useTableContextSource({
    spaceId: effectiveHostSpaceId,
    tabScopeKey,
    tabOrder,
  })
  const spaceAppsData = useSpaceApps(state => state.appsBySpace[effectiveHostSpaceId])

  const isAppEnabled = useCallback((appId?: string) => {
    if (!appId) return true
    if (!spaceAppsData) return true
    return spaceAppsData.find(app => app.id === appId)?.enabled ?? true
  }, [spaceAppsData])

  const {
    openTable,
    openDocument,
    openSlide,
    openSite,
    createWebTab,
    openEmbeddedWebApp,
  } = useSpaceContextNavigation({
    spaceId: effectiveHostSpaceId,
    tabScopeKey,
    spaceName: hostSpace?.name,
    tables: tableSource.tables,
  })

  const { createHandlers } = useCreateHandlers({
    spaceId: effectiveHostSpaceId,
    spaceOrganizationId: organizationId,
    isAppEnabled,
    tableSource: {
      selectedOrganizationId: organizationId,
      createTable: tableSource.createTable,
    },
    terminalSource: {
      createSession: () => ({ tabKey: 'terminal:sidebar-create-stub' }),
    },
    navigation: {
      openTable,
      openDocument,
      openSlide,
      openSite,
      createWebTab,
      openEmbeddedWebApp,
    },
  })

  const onCreateResource = useCallback((appId: string, options?: CreateResourceOptions) => {
    createHandlers[appId]?.(options)
  }, [createHandlers])

  return useMemo(
    () => ({ createHandlers, onCreateResource }),
    [createHandlers, onCreateResource],
  )
}
