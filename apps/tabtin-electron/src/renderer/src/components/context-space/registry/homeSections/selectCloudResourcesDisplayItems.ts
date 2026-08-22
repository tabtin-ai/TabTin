/**
 * 云盘 / 云文档主区列表展示项选择（纯函数，供 UI 与单测共用）。
 *
 * ：云文档域「全部」不得再按 Collection 文件夹层级裁切，否则单类型扁平筛选
 * 会出现「文档/表格数量 > 全部」；侧栏知识树也不走 Collection，口径应对齐为扁平清单。
 */
import type { SpaceContextItem } from '@/services/spaceApi'

export type CloudResourcesListPresentation = 'default' | 'cloud-docs-domain'
export type CloudResourcesListTypeFilter =
  | 'all'
  | 'tabdata'
  | 'tabdoc'
  | 'tabslide'
  | 'tabfiles'

export interface SelectCloudResourcesDisplayItemsInput {
  presentation: CloudResourcesListPresentation
  activeTypeFilter: CloudResourcesListTypeFilter
  browseFolderId: string | null
  allCloudItems: SpaceContextItem[]
  sharedCloudItems: SpaceContextItem[]
  hiddenSharedResourceIds?: ReadonlySet<string>
  showShared: boolean
  isRecentBrowse: boolean
  matchesTypeFilter: (
    itemType: string | null | undefined,
    filter: CloudResourcesListTypeFilter,
    presentation: CloudResourcesListPresentation,
  ) => boolean
  isForeignSharedItem: (item: SpaceContextItem) => boolean
  isOwnedItem: (item: SpaceContextItem) => boolean
  isCloudResource: (
    itemType: string | null | undefined,
    presentation: CloudResourcesListPresentation,
  ) => boolean
}

function dedupePreferForeignShared(
  items: SpaceContextItem[],
  isForeignSharedItem: (item: SpaceContextItem) => boolean,
): SpaceContextItem[] {
  const seenResourceIds = new Set<string>()
  const preferred = [...items].sort((a, b) => {
    const af = isForeignSharedItem(a) ? 1 : 0
    const bf = isForeignSharedItem(b) ? 1 : 0
    return bf - af
  })
  return preferred.filter(item => {
    const key = item.resource_id || item.id
    if (!key) return true
    if (seenResourceIds.has(key)) return false
    seenResourceIds.add(key)
    return true
  })
}

function mergeTypedWithShared(
  typed: SpaceContextItem[],
  sharedCloudItems: SpaceContextItem[],
  activeTypeFilter: CloudResourcesListTypeFilter,
  presentation: CloudResourcesListPresentation,
  matchesTypeFilter: SelectCloudResourcesDisplayItemsInput['matchesTypeFilter'],
): SpaceContextItem[] {
  const sharedTyped = sharedCloudItems.filter(
    i => matchesTypeFilter(i.item_type, activeTypeFilter, presentation),
  )
  // “全部/类型筛选”是资源库存视图：本人资源和收到的分享资源都要保留。
  // 分享资源必须保留 foreignShared 元数据，右键菜单才能提供“从云盘移除”。
  const sharedIds = new Set(sharedTyped.map(item => item.resource_id).filter(Boolean))
  return [
    ...typed.filter(item => !item.resource_id || !sharedIds.has(item.resource_id)),
    ...sharedTyped,
  ]
}

/**
 * 选择当前应展示的资源行。
 * - 云文档域：全部 / 最近仅展示本人资源；单类型均为扁平清单（忽略 collection_id）
 * - 云盘 default：「全部」按当前 Collection 文件夹层级；单类型仍扁平（跨文件夹查找）
 */
export function selectCloudResourcesDisplayItems(
  input: SelectCloudResourcesDisplayItemsInput,
): SpaceContextItem[] {
  const {
    presentation,
    activeTypeFilter,
    browseFolderId,
    allCloudItems,
    sharedCloudItems,
    hiddenSharedResourceIds,
    showShared,
    isRecentBrowse,
    matchesTypeFilter,
    isForeignSharedItem,
    isOwnedItem,
    isCloudResource,
  } = input

  const visibleAllCloudItems = hiddenSharedResourceIds
    ? allCloudItems.filter(item => !item.resource_id || !Array.from(hiddenSharedResourceIds).some(key => key.endsWith(`:${item.resource_id}`)))
    : allCloudItems
  const scopedAllCloudItems = presentation === 'cloud-docs-domain'
    ? visibleAllCloudItems.filter(isOwnedItem)
    : visibleAllCloudItems

  if (isRecentBrowse) {
    const pool = (presentation === 'cloud-docs-domain'
      ? scopedAllCloudItems
      : [...scopedAllCloudItems, ...sharedCloudItems]
    ).filter(item =>
      isCloudResource(item.item_type, presentation)
      && item.item_type !== 'tabfolder'
      && matchesTypeFilter(item.item_type, activeTypeFilter, presentation)
      && item.last_visited_at,
    )
    return dedupePreferForeignShared(pool, isForeignSharedItem).sort((a, b) => {
      const av = new Date(a.last_visited_at ?? 0).getTime()
      const bv = new Date(b.last_visited_at ?? 0).getTime()
      return bv - av
    })
  }

  if (showShared) {
    return sharedCloudItems.filter(i =>
      matchesTypeFilter(i.item_type, activeTypeFilter, presentation),
    )
  }

  // ：云文档域与侧栏知识树一致，不按 Collection 裁切「全部」
  const useFlatInventory =
    presentation === 'cloud-docs-domain' || activeTypeFilter !== 'all'

  let merged: SpaceContextItem[]
  if (useFlatInventory) {
    const typed = scopedAllCloudItems.filter(i =>
      matchesTypeFilter(i.item_type, activeTypeFilter, presentation),
    )
    merged = presentation === 'cloud-docs-domain'
      ? typed
      : mergeTypedWithShared(
          typed,
          sharedCloudItems,
          activeTypeFilter,
          presentation,
          matchesTypeFilter,
        )
  } else {
    // 云盘「全部」：当前文件夹层级；分享项使用接收者自己的 placement。
    const sharedIds = new Set(sharedCloudItems.map(item => item.resource_id).filter(Boolean))
    const inFolder = visibleAllCloudItems.filter(item => {
      const cid = item.collection_id ?? null
      return !item.resource_id || !sharedIds.has(item.resource_id)
        ? (browseFolderId === null ? cid === null : cid === browseFolderId)
        : false
    })
    const sharedInFolder = sharedCloudItems.filter(i => {
      const cid = i.collection_id ?? null
      return cid === browseFolderId
    })
    merged = [...inFolder, ...sharedInFolder]
  }

  // 同一资源同时出现在组织库存和分享投影时只保留分享投影，确保右键
  // 操作携带 foreignShared 身份；不同资源则全部保留。
  return dedupePreferForeignShared(merged, isForeignSharedItem)
}
