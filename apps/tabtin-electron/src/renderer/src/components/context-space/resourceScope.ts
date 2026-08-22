import type { ResourceScope } from '@stores/useSpaceViewPrefsStore'

type TableVisibilityCarrier = {
  visibility?: string | null
} | null | undefined

type TabdataResourceVisibilityCarrier = {
  item_type?: string | null
  metadata?: Record<string, unknown> | null
} | null | undefined

export const ORGANIZATION_SCOPE_SUPPORTED_ASSET_TABS = new Set([
  'all',
  'tabdata',
  'tabdoc',
  'tabslide',
  'tabsite',
  'tabtracker',
])

export const ORGANIZATION_SCOPE_SUPPORTED_RESOURCE_TYPES = new Set([
  'tabdata',
  'tabdoc',
  'tabslide',
  'tabsite',
  'tabtracker',
])

/**
 * TabData 对用户不可见的表类型。
 * 约定：统一资源项里的 tabdata 可见性来自 metadata.visibility，
 * 若缺失则按“普通用户可见”处理，由调用方决定是否需要额外兜底。
 */
export function isNonUserVisibleTabdataVisibility(visibility: string | null | undefined): boolean {
  return visibility === 'system' || visibility === 'hidden'
}

export function isUserVisibleTabdataTable(table: TableVisibilityCarrier): boolean {
  const visibility = typeof table?.visibility === 'string' ? table.visibility : null
  return !isNonUserVisibleTabdataVisibility(visibility)
}

export function getTabdataResourceVisibility(item: TabdataResourceVisibilityCarrier): string | null {
  if (!item || item.item_type !== 'tabdata') return null
  const visibility = item.metadata?.visibility
  return typeof visibility === 'string' ? visibility : null
}

export function isUserVisibleTabdataResourceItem(item: TabdataResourceVisibilityCarrier): boolean {
  if (!item || item.item_type !== 'tabdata') return true
  return !isNonUserVisibleTabdataVisibility(getTabdataResourceVisibility(item))
}

export function supportsOrganizationScopeForAssetTab(
  assetTab: string | null | undefined,
  mode: 'full' | 'recent' = 'full',
): boolean {
  if (mode !== 'full' || !assetTab) return false
  return ORGANIZATION_SCOPE_SUPPORTED_ASSET_TABS.has(assetTab)
}

export function supportsOrganizationScopeForResourceType(resourceType: string | null | undefined): boolean {
  if (!resourceType) return false
  return ORGANIZATION_SCOPE_SUPPORTED_RESOURCE_TYPES.has(resourceType)
}

export function getEffectiveScopeForAssetTab(
  requestedScope: ResourceScope,
  assetTab: string | null | undefined,
  mode: 'full' | 'recent' = 'full',
): ResourceScope {
  if (requestedScope !== 'organization') return 'space'
  return supportsOrganizationScopeForAssetTab(assetTab, mode) ? 'organization' : 'space'
}

const ORGANIZATION_SCOPE_SUPPORTED_TYPE_FILTERS = new Set([
  'all',
  ...ORGANIZATION_SCOPE_SUPPORTED_RESOURCE_TYPES,
])

export function supportsOrganizationScopeForTypeFilter(
  typeFilter: string | null | undefined,
  mode: 'full' | 'recent' = 'full',
): boolean {
  if (mode !== 'full' || !typeFilter) return false
  return ORGANIZATION_SCOPE_SUPPORTED_TYPE_FILTERS.has(typeFilter)
}

export function getEffectiveScopeForTypeFilter(
  requestedScope: ResourceScope,
  typeFilter: string | null | undefined,
  mode: 'full' | 'recent' = 'full',
): ResourceScope {
  if (requestedScope !== 'organization') return 'space'
  return supportsOrganizationScopeForTypeFilter(typeFilter, mode) ? 'organization' : 'space'
}

export function getEffectiveScopeForResourceType(
  requestedScope: ResourceScope,
  resourceType: string | null | undefined,
): ResourceScope {
  if (requestedScope !== 'organization') return 'space'
  return supportsOrganizationScopeForResourceType(resourceType) ? 'organization' : 'space'
}

export function isCrossSpaceScopedItem(
  effectiveScope: ResourceScope,
  currentSpaceId: string,
  itemSpaceId: string | null | undefined,
): boolean {
  return effectiveScope === 'organization' && Boolean(itemSpaceId) && itemSpaceId !== currentSpaceId
}

type ResourceLoader = (spaceId: string, force?: boolean, scope?: ResourceScope) => Promise<void>

export async function reloadResourceBucketsForScope(
  loadResources: ResourceLoader,
  spaceId: string,
  effectiveScope: ResourceScope,
): Promise<void> {
  if (effectiveScope === 'organization') {
    await Promise.all([
      loadResources(spaceId, true, 'organization'),
      loadResources(spaceId, true, 'space'),
    ])
    return
  }
  await loadResources(spaceId, true, 'space')
}

export async function reloadResourceBucketsForType(
  loadResources: ResourceLoader,
  spaceId: string,
  requestedScope: ResourceScope,
  resourceType: string | null | undefined,
): Promise<void> {
  const effectiveScope = getEffectiveScopeForResourceType(requestedScope, resourceType)
  await reloadResourceBucketsForScope(loadResources, spaceId, effectiveScope)
}
