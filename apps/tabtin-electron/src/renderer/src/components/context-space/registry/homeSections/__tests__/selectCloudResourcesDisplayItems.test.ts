import { describe, expect, it } from 'vitest'
import type { SpaceContextItem } from '@/services/spaceApi'
import {
  selectCloudResourcesDisplayItems,
  type CloudResourcesListPresentation,
  type CloudResourcesListTypeFilter,
} from '../selectCloudResourcesDisplayItems'

function item(partial: Partial<SpaceContextItem> & Pick<SpaceContextItem, 'id' | 'item_type'>): SpaceContextItem {
  return {
    space_id: 'space-1',
    title: partial.id,
    resource_id: partial.resource_id ?? partial.id,
    collection_id: null,
    parent_id: null,
    is_archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  } as SpaceContextItem
}

function matchesTypeFilter(
  itemType: string | null | undefined,
  filter: CloudResourcesListTypeFilter,
  _presentation: CloudResourcesListPresentation,
): boolean {
  if (filter === 'all') return true
  return itemType === filter
}

function select(opts: {
  presentation: CloudResourcesListPresentation
  activeTypeFilter?: CloudResourcesListTypeFilter
  browseFolderId?: string | null
  allCloudItems: SpaceContextItem[]
  sharedCloudItems?: SpaceContextItem[]
  showShared?: boolean
  isRecentBrowse?: boolean
  currentUserId?: string
}) {
  return selectCloudResourcesDisplayItems({
    presentation: opts.presentation,
    activeTypeFilter: opts.activeTypeFilter ?? 'all',
    browseFolderId: opts.browseFolderId ?? null,
    allCloudItems: opts.allCloudItems,
    sharedCloudItems: opts.sharedCloudItems ?? [],
    showShared: opts.showShared ?? false,
    isRecentBrowse: opts.isRecentBrowse ?? false,
    matchesTypeFilter,
    isForeignSharedItem: candidate => Boolean(
      (candidate.metadata as { foreignShared?: boolean } | undefined)?.foreignShared,
    ),
    isCloudResource: (itemType) => itemType === 'tabdoc' || itemType === 'tabdata',
    isOwnedItem: candidate => {
      if (!opts.currentUserId) return true
      return String(candidate.owner_id ?? candidate.owner?.id ?? candidate.created_by?.id ?? '')
        === opts.currentUserId
    },
  })
}

describe('#7755 selectCloudResourcesDisplayItems', () => {
  const nestedDoc = item({ id: 'doc-nested', item_type: 'tabdoc', collection_id: 'folder-1' })
  const rootTable = item({ id: 'table-root', item_type: 'tabdata', collection_id: null })
  const nestedTable = item({ id: 'table-nested', item_type: 'tabdata', collection_id: 'folder-1' })

  it('cloud-docs-domain: 全部包含文件夹内资源，且不少于单类型筛选', () => {
    const allItems = [nestedDoc, rootTable, nestedTable]

    const all = select({
      presentation: 'cloud-docs-domain',
      activeTypeFilter: 'all',
      allCloudItems: allItems,
    })
    const docs = select({
      presentation: 'cloud-docs-domain',
      activeTypeFilter: 'tabdoc',
      allCloudItems: allItems,
    })
    const tables = select({
      presentation: 'cloud-docs-domain',
      activeTypeFilter: 'tabdata',
      allCloudItems: allItems,
    })

    expect(all.map(i => i.id).sort()).toEqual(['doc-nested', 'table-nested', 'table-root'])
    expect(docs.map(i => i.id)).toEqual(['doc-nested'])
    expect(tables.map(i => i.id).sort()).toEqual(['table-nested', 'table-root'])
    expect(all.length).toBeGreaterThanOrEqual(docs.length)
    expect(all.length).toBeGreaterThanOrEqual(tables.length)
    expect(all.length).toBe(docs.length + tables.length)
  })

  it('cloud drive default: 全部仍按当前 Collection 层级裁切', () => {
    const allItems = [nestedDoc, rootTable, nestedTable]

    const rootAll = select({
      presentation: 'default',
      activeTypeFilter: 'all',
      browseFolderId: null,
      allCloudItems: allItems,
    })
    const folderAll = select({
      presentation: 'default',
      activeTypeFilter: 'all',
      browseFolderId: 'folder-1',
      allCloudItems: allItems,
    })
    const flatDocs = select({
      presentation: 'default',
      activeTypeFilter: 'tabdoc',
      browseFolderId: null,
      allCloudItems: allItems,
    })

    expect(rootAll.map(i => i.id)).toEqual(['table-root'])
    expect(folderAll.map(i => i.id).sort()).toEqual(['doc-nested', 'table-nested'])
    // 云盘单类型仍扁平（跨文件夹查找），可多于「全部」根层——产品既有口径
    expect(flatDocs.map(i => i.id)).toEqual(['doc-nested'])
    expect(flatDocs.length).toBeGreaterThan(rootAll.filter(i => i.item_type === 'tabdoc').length)
  })

  it('places shared resources in the recipient folder', () => {
    const shared = item({
      id: 'shared:doc:shared-doc',
      item_type: 'tabdoc',
      resource_id: 'shared-doc',
      collection_id: 'folder-1',
    })
    expect(select({
      presentation: 'default',
      browseFolderId: null,
      allCloudItems: [],
      sharedCloudItems: [shared],
    })).toEqual([])
    expect(select({
      presentation: 'default',
      browseFolderId: 'folder-1',
      allCloudItems: [],
      sharedCloudItems: [shared],
    })).toEqual([shared])
  })

  it('cloud drive prefers the shared projection when inventory contains the same resource', () => {
    const inventoryCopy = item({
      id: 'context-item-1',
      item_type: 'tabdoc',
      resource_id: 'shared-doc',
      collection_id: null,
      can_move: false,
    })
    const shared = item({
      id: 'shared:doc:shared-doc',
      item_type: 'tabdoc',
      resource_id: 'shared-doc',
      collection_id: 'folder-1',
      can_move: true,
      metadata: { foreignShared: true },
    })

    expect(select({
      presentation: 'default',
      browseFolderId: null,
      allCloudItems: [inventoryCopy],
      sharedCloudItems: [shared],
    })).toEqual([])
    expect(select({
      presentation: 'default',
      browseFolderId: 'folder-1',
      allCloudItems: [inventoryCopy],
      sharedCloudItems: [shared],
    })).toEqual([shared])
  })

  it('#11281 keeps cloud-docs all/recent owned-only while shared remains discoverable', () => {
    const owned = item({
      id: 'owned-doc-item',
      item_type: 'tabdoc',
      resource_id: 'owned-doc',
      owner_id: 'current-user',
      last_visited_at: '2026-08-20T10:00:00Z',
    })
    const foreignInventory = item({
      id: 'foreign-doc-item',
      item_type: 'tabdoc',
      resource_id: 'foreign-doc',
      owner_id: 'other-user',
      last_visited_at: '2026-08-20T11:00:00Z',
    })
    const foreignShared = item({
      id: 'shared:doc:foreign-doc',
      item_type: 'tabdoc',
      resource_id: 'foreign-doc',
      owner_id: 'other-user',
      metadata: { foreignShared: true },
    })

    const common = {
      presentation: 'cloud-docs-domain' as const,
      allCloudItems: [owned, foreignInventory],
      sharedCloudItems: [foreignShared],
      currentUserId: 'current-user',
    }

    expect(select(common)).toEqual([owned])
    expect(select({ ...common, isRecentBrowse: true })).toEqual([owned])
    expect(select({ ...common, showShared: true })).toEqual([foreignShared])
  })
})
