import { beforeEach, describe, expect, it, vi } from 'vitest'

const listCollectionsMock = vi.fn()
const listOrganizationCollectionsMock = vi.fn()
const deleteCollectionMock = vi.fn()
const moveItemsToCollectionMock = vi.fn()
const moveItemsToOrganizationCollectionMock = vi.fn()
const trashContextResourceMock = vi.fn()
const archiveContextItemMock = vi.fn()
const getResourcesMock = vi.fn()
const loadResourcesMock = vi.fn()

vi.mock('../../services/spaceApi', () => ({
  SpaceApiService: {
    listCollections: listCollectionsMock,
    listOrganizationCollections: listOrganizationCollectionsMock,
    deleteCollection: deleteCollectionMock,
    moveItemsToCollection: moveItemsToCollectionMock,
    moveItemsToOrganizationCollection: moveItemsToOrganizationCollectionMock,
    trashContextResource: trashContextResourceMock,
    archiveContextItem: archiveContextItemMock,
  },
}))

vi.mock('../useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: () => ({
      getResources: getResourcesMock,
      load: loadResourcesMock,
    }),
  },
}))

vi.mock('../useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      spaces: [{ id: 'space-1', organization_id: 'org-fallback' }],
    }),
  },
}))

function makeFolder(overrides: Partial<{
  id: string
  name: string
  item_count: number
  children: ReturnType<typeof makeFolder>[]
}> = {}) {
  return {
    id: overrides.id ?? 'folder-1',
    name: overrides.name ?? 'Folder',
    parent_id: null as string | null,
    icon: 'folder',
    color: '',
    order: 0,
    is_expanded: true,
    item_count: overrides.item_count ?? 0,
    children: overrides.children ?? [],
  }
}

describe('useCollections.deleteCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    listCollectionsMock.mockResolvedValue({ collections: [], total: 0 })
    listOrganizationCollectionsMock.mockResolvedValue({ collections: [], total: 0 })
    deleteCollectionMock.mockResolvedValue(undefined)
    moveItemsToCollectionMock.mockResolvedValue({ updated: 1 })
    moveItemsToOrganizationCollectionMock.mockResolvedValue({ updated: 1 })
    trashContextResourceMock.mockResolvedValue(true)
    archiveContextItemMock.mockResolvedValue(undefined)
    loadResourcesMock.mockResolvedValue(undefined)
  })

  it('moves cached resources under the deleted collection tree to trash before reloading', async () => {
    const { useCollections } = await import('../useCollections')
    const resourceInParent = {
      id: 'ctx-parent',
      item_type: 'tabdata',
      title: 'Table in parent',
      preview: '',
      resource_id: 'table-parent',
      space_id: 'space-1',
      metadata: {},
      is_archived: false,
      collection_id: 'collection-parent',
      updated_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    }
    const resourceInChild = {
      ...resourceInParent,
      id: 'ctx-child',
      resource_id: 'table-child',
      collection_id: 'collection-child',
    }
    const rootResource = {
      ...resourceInParent,
      id: 'ctx-root',
      resource_id: 'table-root',
      collection_id: null,
    }

    useCollections.setState({
      currentSpaceId: 'space-1',
      collections: [
        {
          id: 'collection-parent',
          name: 'Parent',
          parent_id: null,
          icon: 'folder',
          color: '',
          order: 0,
          is_expanded: true,
          item_count: 1,
          children: [
            {
              id: 'collection-child',
              name: 'Child',
              parent_id: 'collection-parent',
              icon: 'folder',
              color: '',
              order: 0,
              is_expanded: true,
              item_count: 1,
              children: [],
            },
          ],
        },
      ],
      isLoading: false,
      error: null,
      collectionsBySpaceId: {
        'space-1': [
          {
            id: 'collection-parent',
            name: 'Parent',
            parent_id: null,
            icon: 'folder',
            color: '',
            order: 0,
            is_expanded: true,
            item_count: 1,
            children: [
              {
                id: 'collection-child',
                name: 'Child',
                parent_id: 'collection-parent',
                icon: 'folder',
                color: '',
                order: 0,
                is_expanded: true,
                item_count: 1,
                children: [],
              },
            ],
          },
        ],
      },
      loadingBySpaceId: {},
      errorBySpaceId: {},
    })
    getResourcesMock.mockReturnValue([resourceInParent, resourceInChild, rootResource])

    await useCollections.getState().deleteCollection('collection-parent')

    expect(deleteCollectionMock).toHaveBeenCalledWith('collection-parent')
    expect(trashContextResourceMock).toHaveBeenCalledTimes(2)
    // ：缺 organization_id 时从 Space 回填，避免 file/tabfiles silent archive
    expect(trashContextResourceMock).toHaveBeenCalledWith({
      ...resourceInParent,
      organization_id: 'org-fallback',
    })
    expect(trashContextResourceMock).toHaveBeenCalledWith({
      ...resourceInChild,
      organization_id: 'org-fallback',
    })
    expect(trashContextResourceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ctx-root' }),
    )
    expect(loadResourcesMock).toHaveBeenCalledWith('space-1', true)
  })
})

describe('getCollectionChildrenSorted pin order', () => {
  it('puts pinned folders before unpinned siblings ', async () => {
    const { getCollectionChildrenSorted } = await import('../useCollections')
    const folders = [
      {
        id: 'a',
        name: 'A',
        parent_id: null,
        icon: '📁',
        color: '',
        order: 0,
        is_expanded: true,
        is_pinned: false,
        children: [],
        item_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'b',
        name: 'B',
        parent_id: null,
        icon: '📁',
        color: '',
        order: 1,
        is_expanded: true,
        is_pinned: true,
        pinned_at: '2026-07-25T00:00:00Z',
        children: [],
        item_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]

    expect(getCollectionChildrenSorted(folders, null).map(f => f.id)).toEqual(['b', 'a'])
  })
})

describe('useCollections.moveItems item_count refresh ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    listCollectionsMock.mockResolvedValue({ collections: [], total: 0 })
    listOrganizationCollectionsMock.mockResolvedValue({ collections: [], total: 0 })
    moveItemsToCollectionMock.mockResolvedValue({ updated: 1 })
    moveItemsToOrganizationCollectionMock.mockResolvedValue({ updated: 1 })
  })

  it('reloads space collections after moveItems so folder item_count updates', async () => {
    const { useCollections } = await import('../useCollections')
    const before = [makeFolder({ id: 'folder-a', name: 'A', item_count: 0 })]
    const after = [makeFolder({ id: 'folder-a', name: 'A', item_count: 1 })]

    useCollections.setState({
      currentSpaceId: 'space-1',
      collections: before,
      isLoading: false,
      error: null,
      collectionsBySpaceId: { 'space-1': before },
      loadingBySpaceId: {},
      errorBySpaceId: {},
      collectionsByOrganizationId: {},
      loadingByOrganizationId: {},
      errorByOrganizationId: {},
    })
    listCollectionsMock.mockResolvedValue({ collections: after, total: 1 })

    const updated = await useCollections.getState().moveItems('space-1', ['item-1'], 'folder-a')

    expect(updated).toBe(1)
    expect(moveItemsToCollectionMock).toHaveBeenCalledWith('space-1', {
      item_ids: ['item-1'],
      collection_id: 'folder-a',
    })
    expect(listCollectionsMock).toHaveBeenCalledWith('space-1')
    await vi.waitFor(() => {
      expect(useCollections.getState().collectionsBySpaceId['space-1']?.[0]?.item_count).toBe(1)
    })
  })

  it('reloads organization collections after moveItemsOrganization (cloud drive)', async () => {
    const { useCollections } = await import('../useCollections')
    const before = [makeFolder({ id: 'folder-11123', name: '11123', item_count: 0 })]
    const after = [makeFolder({ id: 'folder-11123', name: '11123', item_count: 2 })]

    useCollections.setState({
      currentSpaceId: null,
      collections: [],
      isLoading: false,
      error: null,
      collectionsBySpaceId: {},
      loadingBySpaceId: {},
      errorBySpaceId: {},
      collectionsByOrganizationId: { 'org-1': before },
      loadingByOrganizationId: {},
      errorByOrganizationId: {},
    })
    listOrganizationCollectionsMock.mockResolvedValue({ collections: after, total: 1 })

    const updated = await useCollections.getState().moveItemsOrganization(
      'org-1',
      ['item-1', 'item-2'],
      'folder-11123',
    )

    expect(updated).toBe(1)
    expect(moveItemsToOrganizationCollectionMock).toHaveBeenCalledWith('org-1', {
      item_ids: ['item-1', 'item-2'],
      collection_id: 'folder-11123',
    })
    expect(listOrganizationCollectionsMock).toHaveBeenCalledWith('org-1')
    await vi.waitFor(() => {
      expect(
        useCollections.getState().collectionsByOrganizationId['org-1']?.[0]?.item_count,
      ).toBe(2)
    })
  })

  it('does not reload collections when move is denied (updated=0)', async () => {
    const { useCollections } = await import('../useCollections')
    moveItemsToCollectionMock.mockResolvedValue({ updated: 0 })

    useCollections.setState({
      currentSpaceId: 'space-1',
      collections: [],
      isLoading: false,
      error: null,
      collectionsBySpaceId: { 'space-1': [makeFolder()] },
      loadingBySpaceId: {},
      errorBySpaceId: {},
      collectionsByOrganizationId: {},
      loadingByOrganizationId: {},
      errorByOrganizationId: {},
    })

    await expect(
      useCollections.getState().moveItems('space-1', ['item-1'], 'folder-1'),
    ).rejects.toThrow(/MOVE_DENIED/)
    expect(listCollectionsMock).not.toHaveBeenCalled()
  })

  it('handleWsEvent reloads org bucket even when space_id is also present', async () => {
    const { useCollections } = await import('../useCollections')
    const spaceBefore = [makeFolder({ id: 'space-folder', item_count: 1 })]
    const orgBefore = [makeFolder({ id: 'org-folder', item_count: 1 })]
    const spaceAfter = [makeFolder({ id: 'space-folder', item_count: 2 })]
    const orgAfter = [makeFolder({ id: 'org-folder', item_count: 3 })]

    useCollections.setState({
      currentSpaceId: 'space-1',
      collections: spaceBefore,
      isLoading: false,
      error: null,
      collectionsBySpaceId: { 'space-1': spaceBefore },
      loadingBySpaceId: {},
      errorBySpaceId: {},
      collectionsByOrganizationId: { 'org-1': orgBefore },
      loadingByOrganizationId: {},
      errorByOrganizationId: {},
    })
    listCollectionsMock.mockResolvedValue({ collections: spaceAfter, total: 1 })
    listOrganizationCollectionsMock.mockResolvedValue({ collections: orgAfter, total: 1 })

    useCollections.getState().handleWsEvent({
      type: 'items_moved',
      space_id: 'space-1',
      organization_id: 'org-1',
    })

    await vi.waitFor(() => {
      expect(listCollectionsMock).toHaveBeenCalledWith('space-1')
      expect(listOrganizationCollectionsMock).toHaveBeenCalledWith('org-1')
      expect(useCollections.getState().collectionsBySpaceId['space-1']?.[0]?.item_count).toBe(2)
      expect(useCollections.getState().collectionsByOrganizationId['org-1']?.[0]?.item_count).toBe(3)
    })
  })

  it('loadOrganization skips network when cache nonempty unless force ', async () => {
    const { useCollections } = await import('../useCollections')
    const cached = [makeFolder({ id: 'cached-folder' })]

    useCollections.setState({
      currentSpaceId: null,
      collections: [],
      isLoading: false,
      error: null,
      collectionsBySpaceId: {},
      loadingBySpaceId: {},
      errorBySpaceId: {},
      collectionsByOrganizationId: { 'org-1': cached },
      loadingByOrganizationId: {},
      errorByOrganizationId: {},
    })

    await useCollections.getState().loadOrganization('org-1')
    expect(listOrganizationCollectionsMock).not.toHaveBeenCalled()

    const refreshed = [makeFolder({ id: 'cached-folder' }), makeFolder({ id: 'cli-folder' })]
    listOrganizationCollectionsMock.mockResolvedValue({ collections: refreshed, total: 2 })
    await useCollections.getState().loadOrganization('org-1', true)

    expect(listOrganizationCollectionsMock).toHaveBeenCalledWith('org-1')
    expect(useCollections.getState().collectionsByOrganizationId['org-1']).toHaveLength(2)
  })

  it('handleWsEvent collection_created refreshes org even without prior bucket ', async () => {
    const { useCollections } = await import('../useCollections')
    const created = [makeFolder({ id: 'a7298523-1111-2222-3333-444444444444' })]

    useCollections.setState({
      currentSpaceId: null,
      collections: [],
      isLoading: false,
      error: null,
      collectionsBySpaceId: {},
      loadingBySpaceId: {},
      errorBySpaceId: {},
      collectionsByOrganizationId: {},
      loadingByOrganizationId: {},
      errorByOrganizationId: {},
    })
    listOrganizationCollectionsMock.mockResolvedValue({ collections: created, total: 1 })

    useCollections.getState().handleWsEvent({
      type: 'collection_created',
      organization_id: 'org-1',
      collection_id: 'a7298523-1111-2222-3333-444444444444',
    })

    await vi.waitFor(() => {
      expect(listOrganizationCollectionsMock).toHaveBeenCalledWith('org-1')
      expect(useCollections.getState().collectionsByOrganizationId['org-1']?.[0]?.id).toBe(
        'a7298523-1111-2222-3333-444444444444',
      )
    })
  })
})

describe('useCollections.clearOrganization ', () => {
  it('只清除指定 organization 的文件夹桶', async () => {
    const { useCollections } = await import('../useCollections')
    useCollections.setState({
      collectionsByOrganizationId: {
        'org-a': [makeFolder({ id: 'fa', name: 'A' })],
        'org-b': [makeFolder({ id: 'fb', name: 'B' })],
      },
      loadingByOrganizationId: { 'org-a': false, 'org-b': false },
      errorByOrganizationId: { 'org-a': null, 'org-b': null },
    })

    useCollections.getState().clearOrganization('org-a')

    const state = useCollections.getState()
    expect(state.collectionsByOrganizationId['org-a']).toBeUndefined()
    expect(state.collectionsByOrganizationId['org-b']?.[0]?.id).toBe('fb')
  })
})
