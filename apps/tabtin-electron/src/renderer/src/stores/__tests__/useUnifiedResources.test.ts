import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceContextItem } from '../../services/spaceApi'

const mockCloseResourceTabEverywhere = vi.fn()
const mockCloseCanvasTabEverywhere = vi.fn()
const mockSyncOpenResourceTabTitle = vi.fn()
const mockSyncOpenResourceTabIcon = vi.fn()
const mockSpaces = [
  { id: 'space-1', organization_id: 'ws-1' },
  { id: 'space-2', organization_id: 'ws-1' },
]

const { mockRecordResourceAccess, listKnowledgeTree } = vi.hoisted(() => ({
  mockRecordResourceAccess: vi.fn(),
  listKnowledgeTree: vi.fn(),
}))

vi.mock('../../services/spaceApi', () => ({
  SpaceApiService: {
    listContextItems: vi.fn(),
    listKnowledgeTree: (...args: unknown[]) => listKnowledgeTree(...args),
    recordResourceAccess: (...args: unknown[]) => mockRecordResourceAccess(...args),
  },
}))

vi.mock('../useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ spaces: mockSpaces }),
  },
}))

vi.mock('../useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      closeResourceTabEverywhere: mockCloseResourceTabEverywhere,
      syncOpenResourceTabTitle: mockSyncOpenResourceTabTitle,
      syncOpenResourceTabIcon: mockSyncOpenResourceTabIcon,
    }),
  },
}))

vi.mock('../useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: {
    getState: () => ({
      closeTabEverywhere: mockCloseCanvasTabEverywhere,
    }),
  },
}))

let useUnifiedResources: typeof import('../useUnifiedResources').useUnifiedResources
let onResourceEvent: typeof import('../useUnifiedResources').onResourceEvent
let healUnsyncedContextItems: typeof import('../useUnifiedResources').healUnsyncedContextItems
let recordContextItemAccess: typeof import('../useUnifiedResources').recordContextItemAccess
let recordResourceAccessByResourceId: typeof import('../useUnifiedResources').recordResourceAccessByResourceId
let useKnowledgeTree: typeof import('../useKnowledgeTree').useKnowledgeTree
let listContextItemsMock: ReturnType<typeof vi.fn>

function makeResource(overrides: Partial<SpaceContextItem> = {}): SpaceContextItem {
  return {
    id: 'ctx-1',
    item_type: 'tabdoc',
    title: '旧标题',
    preview: '',
    resource_id: 'doc-1',
    space_id: 'space-1',
    metadata: {},
    is_archived: false,
    updated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as SpaceContextItem
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()

  const { SpaceApiService } = await import('../../services/spaceApi')
  listContextItemsMock = vi.mocked(SpaceApiService.listContextItems)
  const mod = await import('../useUnifiedResources')
  useUnifiedResources = mod.useUnifiedResources
  onResourceEvent = mod.onResourceEvent
  healUnsyncedContextItems = mod.healUnsyncedContextItems
  recordContextItemAccess = mod.recordContextItemAccess
  recordResourceAccessByResourceId = mod.recordResourceAccessByResourceId
  useKnowledgeTree = (await import('../useKnowledgeTree')).useKnowledgeTree
  mockRecordResourceAccess.mockReset()
  mockRecordResourceAccess.mockResolvedValue(true)
  listKnowledgeTree.mockReset()

  useUnifiedResources.setState({
    currentSpaceId: 'space-1',
    resources: [],
    isLoading: false,
    error: null,
    resourcesBySpaceId: {},
    loadingBySpaceId: {},
    errorBySpaceId: {},
    bucketMetaByCacheKey: {},
  })
  useKnowledgeTree.setState({
    treesByOrganizationId: {},
    loadingByOrganizationId: {},
    loadingChildrenByNode: {},
    errorByOrganizationId: {},
  })
  mockCloseResourceTabEverywhere.mockClear()
  mockCloseCanvasTabEverywhere.mockClear()
  mockSyncOpenResourceTabTitle.mockClear()
  mockSyncOpenResourceTabIcon.mockClear()
})

describe('onResourceEvent', () => {
  it('resource_updated 会同步已打开 tab 的标题', () => {
    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdata',
      resource_id: 'table-1',
      title: '新表名',
      space_id: 'space-1',
    })

    expect(mockSyncOpenResourceTabTitle).toHaveBeenCalledWith({
      type: 'tabdata',
      id: 'table-1',
      title: '新表名',
      spaceId: 'space-1',
    })
  })

  it('resource_updated 会同步已打开 tab 的 icon', () => {
    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      space_id: 'space-1',
      metadata: { icon: '📋' },
    })

    expect(mockSyncOpenResourceTabIcon).toHaveBeenCalledWith({
      type: 'tabdoc',
      id: 'doc-1',
      icon: '📋',
      spaceId: 'space-1',
    })
  })

  it('resource_updated 支持将 icon 清空', () => {
    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      space_id: 'space-1',
      metadata: { icon: '' },
    })

    expect(mockSyncOpenResourceTabIcon).toHaveBeenCalledWith({
      type: 'tabdoc',
      id: 'doc-1',
      icon: '',
      spaceId: 'space-1',
    })
  })

  it('resource_updated 支持将资源标题同步为空字符串', () => {
    const resource = makeResource({
      resource_id: 'doc-1',
      title: '旧标题',
    })
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [resource],
      resourcesBySpaceId: {
        'space-1': [resource],
      },
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      title: '',
      space_id: 'space-1',
      updated_at: '2026-01-01T00:00:01Z',
    })

    expect(useUnifiedResources.getState().resources[0]?.title).toBe('')
    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']?.[0]?.title).toBe('')
    expect(mockSyncOpenResourceTabTitle).toHaveBeenCalledWith({
      type: 'tabdoc',
      id: 'doc-1',
      title: '',
      spaceId: 'space-1',
    })
  })

  it('支持使用 spaceId 过滤资源事件', () => {
    const listener = vi.fn()
    const unsubscribe = onResourceEvent('tabmemo', listener, { spaceId: 'space-1' })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabmemo',
      resource_id: 'memo-1',
      space_id: 'space-1',
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabmemo',
      resource_id: 'memo-2',
      space_id: 'space-2',
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      resource_id: 'memo-1',
      space_id: 'space-1',
    }))

    unsubscribe()
  })

  it('非当前 Space 的事件也会分发给外部监听器，但不会污染当前资源缓存', () => {
    const listener = vi.fn()
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [
        {
          id: 'ctx-1',
          item_type: 'tabmemo',
          title: 'Memo 1',
          preview: '',
          resource_id: 'memo-1',
          space_id: 'space-1',
          metadata: {},
          is_archived: false,
          updated_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    })
    const unsubscribe = onResourceEvent('tabmemo', listener, { spaceId: 'space-2' })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabmemo',
      resource_id: 'memo-2',
      space_id: 'space-2',
      title: 'Memo 2',
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      resource_id: 'memo-2',
      space_id: 'space-2',
    }))
    expect(useUnifiedResources.getState().resources).toEqual([
      expect.objectContaining({
        resource_id: 'memo-1',
        space_id: 'space-1',
      }),
    ])

    unsubscribe()
  })

  it('使用 spaceId 过滤不同资源类型的事件', () => {
    const listener = vi.fn()
    const unsubscribe = onResourceEvent('tabtracker', listener, { spaceId: 'space-1' })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_created',
      resource_type: 'tabtracker',
      resource_id: 'goal-1',
      space_id: 'space-1',
      title: 'Goal 1',
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      resource_id: 'goal-1',
      space_id: 'space-1',
    }))

    unsubscribe()
  })
})

describe('resource_created', () => {
  it('使用 WS 事件里的 collection_id 创建乐观资源，避免合集内新建时先显示到根目录', () => {
    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_created',
      resource_type: 'tabdoc',
      resource_id: 'doc-in-folder',
      space_id: 'space-1',
      title: '合集内文档',
      collection_id: 'collection-1',
      context_item_id: 'ctx-from-ws',
    })

    expect(useUnifiedResources.getState().resources).toEqual([
      expect.objectContaining({
        id: 'ctx-from-ws',
        resource_id: 'doc-in-folder',
        collection_id: 'collection-1',
      }),
    ])
    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
      expect.objectContaining({
        id: 'ctx-from-ws',
        resource_id: 'doc-in-folder',
        collection_id: 'collection-1',
      }),
    ])
  })

  it('缺少 context_item_id 时仍插入空 id，并继续 schedule reload', () => {
    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_created',
      resource_type: 'tabdoc',
      resource_id: 'doc-empty-id',
      space_id: 'space-1',
      title: '临时文档',
      collection_id: null,
    })

    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
      expect.objectContaining({
        id: '',
        resource_id: 'doc-empty-id',
      }),
    ])
  })

  it('resource_updated 用 context_item_id 回填空 id 乐观项', () => {
    useUnifiedResources.setState({
      resourcesBySpaceId: {
        'space-1': [
          makeResource({
            id: '',
            resource_id: 'doc-empty-id',
            title: '临时文档',
          }),
        ],
      },
      resources: [
        makeResource({
          id: '',
          resource_id: 'doc-empty-id',
          title: '临时文档',
        }),
      ],
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-empty-id',
      space_id: 'space-1',
      title: '已同步文档',
      context_item_id: 'ctx-backfilled',
      updated_at: '2026-07-23T00:00:00Z',
    })

    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
      expect.objectContaining({
        id: 'ctx-backfilled',
        resource_id: 'doc-empty-id',
        title: '已同步文档',
      }),
    ])
  })

  it('healUnsyncedContextItems 对空 id bucket 强制 reload', async () => {
    listContextItemsMock.mockResolvedValue({
      items: [makeResource({ id: 'ctx-healed', resource_id: 'doc-empty-id', title: '已回填' })],
      total: 1,
      page: 1,
      page_size: 500,
    } as any)

    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [],
      resourcesBySpaceId: {
        'space-1:organization': [
          makeResource({ id: '', resource_id: 'doc-empty-id', title: '临时' }),
        ],
      },
      bucketMetaByCacheKey: {
        'space-1:organization': {
          cacheKey: 'space-1:organization',
          scope: 'organization',
          spaceId: 'space-1',
          organizationId: 'ws-1',
        },
      },
      loadingBySpaceId: {},
      errorBySpaceId: {},
    })

    const buckets = healUnsyncedContextItems('space-1')
    expect(buckets).toBe(1)
    await Promise.resolve()
    await Promise.resolve()

    expect(listContextItemsMock).toHaveBeenCalled()
  })

  it('缺 bucketMeta 时仍会 schedule reload，避免空 id 乐观项长期滞留 ', async () => {
    vi.useFakeTimers()
    try {
      const synced = makeResource({
        id: 'ctx-synced',
        resource_id: 'doc-in-folder',
        collection_id: 'collection-1',
        title: '合集内文档',
      })
      listContextItemsMock.mockResolvedValue({
        items: [synced],
        total: 1,
        page: 1,
        page_size: 500,
      } as any)

      // 模拟 WS 先写入 space bucket、尚未经 load() 写入 bucketMeta
      useUnifiedResources.setState({
        currentSpaceId: 'space-1',
        resources: [],
        isLoading: false,
        error: null,
        resourcesBySpaceId: {
          'space-1': [
            makeResource({
              id: '',
              resource_id: 'doc-in-folder',
              collection_id: 'collection-1',
              title: '合集内文档',
            }),
          ],
        },
        loadingBySpaceId: {},
        errorBySpaceId: {},
        bucketMetaByCacheKey: {},
      })

      useUnifiedResources.getState().handleWsEvent({
        type: 'resource_created',
        resource_type: 'tabdoc',
        resource_id: 'doc-other',
        space_id: 'space-1',
        title: '另一文档',
        collection_id: null,
      })

      await vi.advanceTimersByTimeAsync(600)
      await Promise.resolve()

      expect(listContextItemsMock).toHaveBeenCalledWith('space-1', expect.objectContaining({
        is_archived: false,
        page: 1,
        page_size: 500,
      }))
      expect(listContextItemsMock.mock.calls[0]?.[1]).not.toHaveProperty('scope', 'organization')
      expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
        expect.objectContaining({ id: 'ctx-synced', resource_id: 'doc-in-folder' }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('collection_deleted structural event', () => {
  it('立即从资源缓存移除被删除合集树下的资源，避免短暂显示到根目录', () => {
    vi.useFakeTimers()
    try {
      const inParent = makeResource({
        id: 'ctx-parent',
        resource_id: 'doc-parent',
        collection_id: 'collection-parent',
      })
      const inChild = makeResource({
        id: 'ctx-child',
        resource_id: 'doc-child',
        collection_id: 'collection-child',
      })
      const root = makeResource({
        id: 'ctx-root',
        resource_id: 'doc-root',
        collection_id: null,
      })
      useUnifiedResources.setState({
        currentSpaceId: 'space-1',
        resources: [inParent, inChild, root],
        isLoading: false,
        error: null,
        resourcesBySpaceId: {
          'space-1': [inParent, inChild, root],
          'space-1:organization': [inParent, inChild, root],
        },
        loadingBySpaceId: {},
        errorBySpaceId: {},
        bucketMetaByCacheKey: {
          'space-1:organization': {
            cacheKey: 'space-1:organization',
            scope: 'organization',
            spaceId: 'space-1',
            organizationId: 'ws-1',
          },
        },
      })

      useUnifiedResources.getState().handleStructuralEvent({
        type: 'collection_deleted',
        space_id: 'space-1',
        organization_id: 'ws-1',
        collection_id: 'collection-parent',
        collection_ids: ['collection-parent', 'collection-child'],
      })

      expect(useUnifiedResources.getState().resources).toEqual([
        expect.objectContaining({ resource_id: 'doc-root' }),
      ])
      expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
        expect.objectContaining({ resource_id: 'doc-root' }),
      ])
      expect(useUnifiedResources.getState().resourcesBySpaceId['space-1:organization']).toEqual([
        expect.objectContaining({ resource_id: 'doc-root' }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resource_updated', () => {
  it('优先使用服务端 updated_at 更新资源桶', () => {
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [
        {
          id: 'ctx-1',
          item_type: 'tabdoc',
          title: '旧标题',
          preview: '',
          resource_id: 'doc-1',
          space_id: 'space-1',
          metadata: {},
          is_archived: false,
          updated_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
      resourcesBySpaceId: {
        'space-1': [
          {
            id: 'ctx-1',
            item_type: 'tabdoc',
            title: '旧标题',
            preview: '',
            resource_id: 'doc-1',
            space_id: 'space-1',
            metadata: {},
            is_archived: false,
            updated_at: '2026-01-01T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      space_id: 'space-1',
      title: '新标题',
      updated_at: '2026-06-08T07:00:00Z',
    })

    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
      expect.objectContaining({
        title: '新标题',
        updated_at: '2026-06-08T07:00:00Z',
      }),
    ])
    expect(useUnifiedResources.getState().resources).toEqual([
      expect.objectContaining({
        title: '新标题',
        updated_at: '2026-06-08T07:00:00Z',
      }),
    ])
  })

  it('忽略旧的 updated_at 事件，避免资源桶标题和时间回滚', () => {
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [
        {
          id: 'ctx-1',
          item_type: 'tabdoc',
          title: '新标题',
          preview: '',
          resource_id: 'doc-1',
          space_id: 'space-1',
          metadata: { icon: 'new-icon' },
          is_archived: false,
          updated_at: '2026-06-08T07:01:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
      resourcesBySpaceId: {
        'space-1': [
          {
            id: 'ctx-1',
            item_type: 'tabdoc',
            title: '新标题',
            preview: '',
            resource_id: 'doc-1',
            space_id: 'space-1',
            metadata: { icon: 'new-icon' },
            is_archived: false,
            updated_at: '2026-06-08T07:01:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      space_id: 'space-1',
      title: '旧标题',
      metadata: { icon: 'old-icon' },
      updated_at: '2026-06-08T07:00:00Z',
    })

    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
      expect.objectContaining({
        title: '新标题',
        metadata: { icon: 'new-icon' },
        updated_at: '2026-06-08T07:01:00Z',
      }),
    ])
    expect(useUnifiedResources.getState().resources).toEqual([
      expect.objectContaining({
        title: '新标题',
        metadata: { icon: 'new-icon' },
        updated_at: '2026-06-08T07:01:00Z',
      }),
    ])
  })

  it('同时更新已缓存的 space 与 organization bucket，避免资源列表等刷新', () => {
    const doc1 = makeResource()
    const doc2 = makeResource({
      id: 'ctx-2',
      title: '其他文档',
      resource_id: 'doc-2',
      space_id: 'space-2',
    })

    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [doc1],
      isLoading: false,
      error: null,
      resourcesBySpaceId: {
        'space-1': [doc1],
        'space-1:organization': [doc1, doc2],
      },
      bucketMetaByCacheKey: {
        'space-1:organization': {
          cacheKey: 'space-1:organization',
          scope: 'organization',
          spaceId: 'space-1',
          organizationId: 'ws-1',
        },
      },
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      space_id: 'space-1',
      title: '新标题',
      updated_at: '2026-06-08T07:00:00Z',
    })

    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']).toEqual([
      expect.objectContaining({
        resource_id: 'doc-1',
        title: '新标题',
        updated_at: '2026-06-08T07:00:00Z',
      }),
    ])
    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1:organization']).toEqual([
      expect.objectContaining({
        resource_id: 'doc-1',
        title: '新标题',
        updated_at: '2026-06-08T07:00:00Z',
      }),
      expect.objectContaining({
        resource_id: 'doc-2',
        title: '其他文档',
      }),
    ])
    expect(useUnifiedResources.getState().resources).toEqual([
      expect.objectContaining({
        resource_id: 'doc-1',
        title: '新标题',
      }),
    ])
  })

  it('事件来自非当前 Space 时也会立即更新已缓存的 organization bucket', () => {
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [],
      isLoading: false,
      error: null,
      resourcesBySpaceId: {
        'space-1:organization': [
          makeResource({
            id: 'ctx-2',
            title: '旧跨空间标题',
            resource_id: 'doc-2',
            space_id: 'space-2',
          }),
        ],
      },
      bucketMetaByCacheKey: {
        'space-1:organization': {
          cacheKey: 'space-1:organization',
          scope: 'organization',
          spaceId: 'space-1',
          organizationId: 'ws-1',
        },
      },
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-2',
      space_id: 'space-2',
      organization_id: 'ws-1',
      title: '新跨空间标题',
      updated_at: '2026-06-08T07:00:00Z',
    })

    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1:organization']).toEqual([
      expect.objectContaining({
        resource_id: 'doc-2',
        title: '新跨空间标题',
        updated_at: '2026-06-08T07:00:00Z',
      }),
    ])
    expect(useUnifiedResources.getState().resources).toEqual([])
  })
})

describe('resource_archived / resource_trashed / resource_deleted', () => {
  const seedResource = () => {
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [
        {
          id: 'ctx-1',
          item_type: 'tabdoc',
          title: 'My Doc',
          preview: '',
          resource_id: 'doc-1',
          space_id: 'space-1',
          metadata: {},
          is_archived: false,
          updated_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    })
  }

  for (const eventType of ['resource_archived', 'resource_trashed', 'resource_deleted'] as const) {
    it(`${eventType} 时移除资源并清理所有 scope 中的对应标签`, () => {
      seedResource()

      useUnifiedResources.getState().handleWsEvent({
        type: eventType,
        resource_type: 'tabdoc',
        resource_id: 'doc-1',
        space_id: 'space-1',
      })

      expect(useUnifiedResources.getState().resources).toEqual([])
      expect(mockCloseResourceTabEverywhere).toHaveBeenCalledTimes(1)
      expect(mockCloseCanvasTabEverywhere).toHaveBeenCalledWith('tabdoc:doc-1')
      expect(mockCloseResourceTabEverywhere).toHaveBeenCalledWith('tabdoc', 'doc-1')
    })
  }

  it('resource_access_revoked 移除列表项但保留已打开标签', () => {
    seedResource()

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_access_revoked',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      space_id: 'space-1',
    })

    expect(useUnifiedResources.getState().resources).toEqual([])
    expect(mockCloseCanvasTabEverywhere).not.toHaveBeenCalled()
    expect(mockCloseResourceTabEverywhere).not.toHaveBeenCalled()
  })

  it('#7437 resource_trashed 立即从 organization bucket 移除，不等待延迟 reload', () => {
    const orgItem = makeResource({
      id: 'ctx-org-1',
      resource_id: 'doc-org-1',
      title: 'Org Doc',
    })
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [orgItem],
      resourcesBySpaceId: {
        'space-1': [orgItem],
        'space-1:organization': [orgItem],
        'space-2:organization': [orgItem],
      },
      bucketMetaByCacheKey: {
        'space-1': {
          cacheKey: 'space-1',
          scope: 'space',
          spaceId: 'space-1',
          organizationId: 'ws-1',
        },
        'space-1:organization': {
          cacheKey: 'space-1:organization',
          scope: 'organization',
          spaceId: 'space-1',
          organizationId: 'ws-1',
        },
        'space-2:organization': {
          cacheKey: 'space-2:organization',
          scope: 'organization',
          spaceId: 'space-2',
          organizationId: 'ws-1',
        },
      },
      isLoading: false,
      error: null,
    })

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_trashed',
      resource_type: 'tabdoc',
      resource_id: 'doc-org-1',
      space_id: 'space-1',
      organization_id: 'ws-1',
    })

    const state = useUnifiedResources.getState()
    expect(state.resourcesBySpaceId['space-1']).toEqual([])
    expect(state.resourcesBySpaceId['space-1:organization']).toEqual([])
    expect(state.resourcesBySpaceId['space-2:organization']).toEqual([])
  })

  it('#7437 无知识树监听器挂载时 trash 仍收敛缓存，之后 loadTree 不命中幽灵节点', async () => {
    // 模拟：曾打开过云文档（树已缓存），随后切到对话/任务，CloudDocs 卸载，无 onResourceEvent 订阅
    useKnowledgeTree.setState({
      treesByOrganizationId: {
        'ws-1': {
          organization_id: 'ws-1',
          folder_scope: 'none',
          orphan_policy: 'promote_to_root',
          roots: [{
            id: 'item-table',
            node_type: 'tabdata',
            resource_id: 'bac8f685-7dc1-490c-b6a7-2f0cbdaba6be',
            context_item_id: 'item-table',
            title: '荷塘表格',
            child_count: 0,
            children: [],
            order: 0,
            is_pinned: false,
            updated_at: null,
            collection_id: null,
            parent_node_id: null,
            parent_node_type: null,
            icon: null,
          }],
          stats: { folder_count: 0, doc_count: 0, table_count: 1, orphan_count: 0 },
          warnings: [],
        },
      },
    })

    // 故意不注册 onResourceEvent —— 覆盖「云文档面板未挂载」
    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_trashed',
      resource_type: 'tabdata',
      resource_id: 'bac8f685-7dc1-490c-b6a7-2f0cbdaba6be',
      space_id: 'space-1',
      organization_id: 'ws-1',
    })

    const rootsAfterTrash = useKnowledgeTree.getState().treesByOrganizationId['ws-1']?.roots ?? []
    expect(rootsAfterTrash).toHaveLength(0)

    // 再进云文档：loadTree 无 force 命中缓存，也不应再出现已 trash 节点
    const cached = await useKnowledgeTree.getState().loadTree('ws-1')
    expect(listKnowledgeTree).not.toHaveBeenCalled()
    expect(cached?.roots ?? []).toHaveLength(0)
    expect(
      (cached?.roots ?? []).some(
        node => node.resource_id === 'bac8f685-7dc1-490c-b6a7-2f0cbdaba6be',
      ),
    ).toBe(false)
  })

  it('#7437 无知识树监听器挂载时 restore 后进入云文档会 force reload，恢复节点不继续缺失', async () => {
    const restoredTree = {
      organization_id: 'ws-1',
      folder_scope: 'none' as const,
      orphan_policy: 'promote_to_root' as const,
      roots: [{
        id: 'item-table',
        node_type: 'tabdata' as const,
        resource_id: 'bac8f685-7dc1-490c-b6a7-2f0cbdaba6be',
        context_item_id: 'item-table',
        title: '荷塘表格',
        child_count: 0,
        children: [],
        order: 0,
        is_pinned: false,
        updated_at: null,
        collection_id: null,
        parent_node_id: null,
        parent_node_type: null,
        icon: null,
      }],
      stats: { folder_count: 0, doc_count: 0, table_count: 1, orphan_count: 0 },
      warnings: [],
    }
    useKnowledgeTree.setState({
      treesByOrganizationId: {
        'ws-1': { ...restoredTree, roots: [] },
      },
    })
    listKnowledgeTree.mockResolvedValueOnce(restoredTree)

    // 故意不注册 onResourceEvent：模拟资源在回收站恢复时云文档面板未挂载
    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_restored',
      resource_type: 'tabdata',
      resource_id: 'bac8f685-7dc1-490c-b6a7-2f0cbdaba6be',
      space_id: 'space-1',
      organization_id: 'ws-1',
    })

    // 面板未挂载时不主动请求；进入云文档的 mount effect 会 force reload 对账。
    expect(listKnowledgeTree).not.toHaveBeenCalled()
    await useKnowledgeTree.getState().loadTree('ws-1', { force: true })
    expect(useKnowledgeTree.getState().treesByOrganizationId['ws-1']?.roots).toHaveLength(1)
    expect(listKnowledgeTree).toHaveBeenCalledWith('ws-1', {
      item_types: 'tabdoc,tabdata',
      depth: 4,
      owned_only: true,
    })
  })

  it('非当前 Space 的删除事件也会清理对应标签', () => {
    seedResource()

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_trashed',
      resource_type: 'tabdoc',
      resource_id: 'doc-2',
      space_id: 'space-2',
    })

    expect(useUnifiedResources.getState().resources).toHaveLength(1)
    expect(mockCloseCanvasTabEverywhere).toHaveBeenCalledWith('tabdoc:doc-2')
    expect(mockCloseResourceTabEverywhere).toHaveBeenCalledWith('tabdoc', 'doc-2')
  })
})

describe('organization pagination and invalidation', () => {
  it('organization scope 会自动翻页拉全，避免静默截断前 500 条', async () => {
    listContextItemsMock
      .mockResolvedValueOnce({
        items: Array.from({ length: 500 }, (_, index) => ({
          id: `ctx-${index + 1}`,
          item_type: 'tabdoc',
          title: `Doc ${index + 1}`,
          preview: '',
          resource_id: `doc-${index + 1}`,
          space_id: index % 2 === 0 ? 'space-1' : 'space-2',
          metadata: {},
          is_archived: false,
          updated_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        })),
        total: 650,
        page: 1,
        page_size: 500,
      } as any)
      .mockResolvedValueOnce({
        items: Array.from({ length: 150 }, (_, index) => ({
          id: `ctx-${index + 501}`,
          item_type: 'tabdoc',
          title: `Doc ${index + 501}`,
          preview: '',
          resource_id: `doc-${index + 501}`,
          space_id: index % 2 === 0 ? 'space-1' : 'space-2',
          metadata: {},
          is_archived: false,
          updated_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        })),
        total: 650,
        page: 2,
        page_size: 500,
      } as any)

    await useUnifiedResources.getState().load('space-1', true, 'organization')

    const state = useUnifiedResources.getState()
    expect(listContextItemsMock).toHaveBeenCalledTimes(2)
    expect(listContextItemsMock).toHaveBeenNthCalledWith(1, 'space-1', expect.objectContaining({
      scope: 'organization',
      page: 1,
      page_size: 500,
    }))
    expect(listContextItemsMock).toHaveBeenNthCalledWith(2, 'space-1', expect.objectContaining({
      scope: 'organization',
      page: 2,
      page_size: 500,
    }))
    expect(state.resourcesBySpaceId['space-1:organization']).toHaveLength(650)
  })

  it('结构事件会失效同一 organization 下所有已缓存聚合 bucket', () => {
    vi.useFakeTimers()
    try {
      useUnifiedResources.setState({
        currentSpaceId: 'space-1',
        resources: [],
        isLoading: false,
        error: null,
        resourcesBySpaceId: {
          'space-1:organization': [],
          'space-2:organization': [],
        },
        loadingBySpaceId: {},
        errorBySpaceId: {},
        bucketMetaByCacheKey: {
          'space-1:organization': {
            cacheKey: 'space-1:organization',
            scope: 'organization',
            spaceId: 'space-1',
            organizationId: 'ws-1',
          },
          'space-2:organization': {
            cacheKey: 'space-2:organization',
            scope: 'organization',
            spaceId: 'space-2',
            organizationId: 'ws-1',
          },
        },
      })

      listContextItemsMock.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        page_size: 500,
      } as any)

      useUnifiedResources.getState().handleStructuralEvent({
        type: 'items_moved',
        space_id: 'space-2',
        organization_id: 'ws-1',
      })

      vi.advanceTimersByTime(600)

      expect(listContextItemsMock).toHaveBeenCalledTimes(2)
      expect(listContextItemsMock).toHaveBeenCalledWith('space-1', expect.objectContaining({
        scope: 'organization',
        page: 1,
        page_size: 500,
      }))
      expect(listContextItemsMock).toHaveBeenCalledWith('space-2', expect.objectContaining({
        scope: 'organization',
        page: 1,
        page_size: 500,
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('space/organization bucket 共存时，legacy 当前 Space 投影始终镜像 space bucket，但仍可命中 organization-only 资源', async () => {
    listContextItemsMock
      .mockResolvedValueOnce({
        items: [
          {
            id: 'ctx-space-1',
            item_type: 'tabdoc',
            title: 'Space Doc',
            preview: '',
            resource_id: 'doc-space',
            space_id: 'space-1',
            metadata: {},
            is_archived: false,
            updated_at: '2026-01-01T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
        page: 1,
        page_size: 500,
      } as any)
      .mockResolvedValueOnce({
        items: [
          {
            id: 'ctx-space-1',
            item_type: 'tabdoc',
            title: 'Space Doc',
            preview: '',
            resource_id: 'doc-space',
            space_id: 'space-1',
            metadata: {},
            is_archived: false,
            updated_at: '2026-01-01T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'ctx-space-2',
            item_type: 'tabdoc',
            title: 'Organization Doc',
            preview: '',
            resource_id: 'doc-organization',
            space_id: 'space-2',
            metadata: {},
            is_archived: false,
            updated_at: '2026-01-01T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 2,
        page: 1,
        page_size: 500,
      } as any)

    await useUnifiedResources.getState().load('space-1', true, 'space')
    await useUnifiedResources.getState().load('space-1', true, 'organization')

    const state = useUnifiedResources.getState()
    expect(state.resourcesBySpaceId['space-1']).toHaveLength(1)
    expect(state.resourcesBySpaceId['space-1:organization']).toHaveLength(2)
    expect(state.resources).toEqual([
      expect.objectContaining({
        resource_id: 'doc-space',
        space_id: 'space-1',
      }),
    ])
    expect(state.getByResourceId('doc-organization', 'space-1')).toEqual(
      expect.objectContaining({
        resource_id: 'doc-organization',
        space_id: 'space-2',
      }),
    )
  })

  it('丢弃过期的并发 load 响应，避免旧请求覆盖新数据', async () => {
    let resolveStale: ((value: unknown) => void) | null = null
    let resolveFresh: ((value: unknown) => void) | null = null

    listContextItemsMock
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveStale = resolve
      }))
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFresh = resolve
      }))

    const stalePromise = useUnifiedResources.getState().load('space-1', true, 'organization')
    const freshPromise = useUnifiedResources.getState().load('space-1', true, 'organization')

    resolveFresh?.({
      items: [makeResource({
        id: 'ctx-fresh',
        title: 'Fresh',
        resource_id: 'doc-fresh',
        collection_id: 'folder-1',
      })],
      total: 1,
      page: 1,
      page_size: 500,
    })
    await freshPromise

    resolveStale?.({
      items: [],
      total: 0,
      page: 1,
      page_size: 500,
    })
    await stalePromise

    const bucket = useUnifiedResources.getState().resourcesBySpaceId['space-1:organization']
    expect(bucket).toHaveLength(1)
    expect(bucket[0]).toEqual(expect.objectContaining({
      resource_id: 'doc-fresh',
      collection_id: 'folder-1',
    }))
  })
})

describe('touchLastVisitedAt / recordContextItemAccess ', () => {
  it('patches last_visited_at across space and organization buckets', () => {
    const resource = makeResource({
      id: 'ctx-visit-1',
      last_visited_at: null,
    })
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [resource],
      resourcesBySpaceId: {
        'space-1': [resource],
        'space-1:organization': [resource],
      },
    })

    useUnifiedResources.getState().touchLastVisitedAt('ctx-visit-1', '2026-07-24T04:00:00.000Z')

    const state = useUnifiedResources.getState()
    expect(state.resourcesBySpaceId['space-1']?.[0]?.last_visited_at).toBe('2026-07-24T04:00:00.000Z')
    expect(state.resourcesBySpaceId['space-1:organization']?.[0]?.last_visited_at).toBe('2026-07-24T04:00:00.000Z')
    expect(state.resources[0]?.last_visited_at).toBe('2026-07-24T04:00:00.000Z')
  })

  it('records access, optimistically touches cache, and skips synthetic shared ids', () => {
    const resource = makeResource({ id: 'ctx-visit-2', last_visited_at: null })
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [resource],
      resourcesBySpaceId: { 'space-1': [resource] },
    })

    recordContextItemAccess('ctx-visit-2')
    expect(mockRecordResourceAccess).toHaveBeenCalledWith('ctx-visit-2')
    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']?.[0]?.last_visited_at).toBeTruthy()

    mockRecordResourceAccess.mockClear()
    recordContextItemAccess('shared:doc:doc-1')
    recordContextItemAccess('local:tmp')
    recordContextItemAccess('')
    expect(mockRecordResourceAccess).not.toHaveBeenCalled()
  })
})

describe('recordResourceAccessByResourceId ', () => {
  it('records immediately when context item is already cached by resource_id', () => {
    const resource = makeResource({
      id: 'ctx-create-1',
      resource_id: 'doc-create-1',
      last_visited_at: null,
    })
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [resource],
      resourcesBySpaceId: { 'space-1': [resource] },
    })

    recordResourceAccessByResourceId('doc-create-1', { resourceType: 'tabdoc' })

    expect(mockRecordResourceAccess).toHaveBeenCalledWith('ctx-create-1')
    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']?.[0]?.last_visited_at).toBeTruthy()
  })

  it('waits for resource_created WS then records and optimistically touches cache', () => {
    useUnifiedResources.setState({
      currentSpaceId: 'space-1',
      resources: [],
      resourcesBySpaceId: { 'space-1': [] },
    })

    recordResourceAccessByResourceId('doc-create-pending', { resourceType: 'tabdoc' })
    expect(mockRecordResourceAccess).not.toHaveBeenCalled()

    useUnifiedResources.getState().handleWsEvent({
      type: 'resource_created',
      resource_type: 'tabdoc',
      resource_id: 'doc-create-pending',
      space_id: 'space-1',
      title: '新建文档',
      context_item_id: 'ctx-create-pending',
    })

    expect(mockRecordResourceAccess).toHaveBeenCalledWith('ctx-create-pending')
    expect(useUnifiedResources.getState().resourcesBySpaceId['space-1']?.[0]).toEqual(
      expect.objectContaining({
        id: 'ctx-create-pending',
        resource_id: 'doc-create-pending',
        last_visited_at: expect.any(String),
      }),
    )
  })
})

describe('clearOrganizationBuckets ', () => {
  it('只剔除指定 organization 的资源桶，保留其它 org', () => {
    const resourceA = makeResource({ id: 'a1' })
    const resourceB = makeResource({ id: 'b1' })
    useUnifiedResources.setState({
      currentSpaceId: 'space-a',
      resources: [resourceA],
      isLoading: false,
      error: null,
      resourcesBySpaceId: {
        'space-a': [resourceA],
        'space-a:organization': [resourceA],
        'space-b': [resourceB],
        'space-b:organization': [resourceB],
      },
      loadingBySpaceId: {},
      errorBySpaceId: {},
      bucketMetaByCacheKey: {
        'space-a': {
          cacheKey: 'space-a',
          scope: 'space',
          spaceId: 'space-a',
          organizationId: 'org-a',
        },
        'space-a:organization': {
          cacheKey: 'space-a:organization',
          scope: 'organization',
          spaceId: 'space-a',
          organizationId: 'org-a',
        },
        'space-b': {
          cacheKey: 'space-b',
          scope: 'space',
          spaceId: 'space-b',
          organizationId: 'org-b',
        },
        'space-b:organization': {
          cacheKey: 'space-b:organization',
          scope: 'organization',
          spaceId: 'space-b',
          organizationId: 'org-b',
        },
      },
    })

    useUnifiedResources.getState().clearOrganizationBuckets('org-a')

    const state = useUnifiedResources.getState()
    expect(state.resourcesBySpaceId['space-a']).toBeUndefined()
    expect(state.resourcesBySpaceId['space-a:organization']).toBeUndefined()
    expect(state.bucketMetaByCacheKey['space-a:organization']).toBeUndefined()
    expect(state.resourcesBySpaceId['space-b:organization']).toEqual([resourceB])
    expect(state.bucketMetaByCacheKey['space-b:organization']?.organizationId).toBe('org-b')
  })
})
