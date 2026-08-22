import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  default: {
    t: vi.fn(() => 'New Tab'),
  },
}))

import {
  applyCacheSnapshot,
  createContextSnapshotActions,
  syncSeedsFromSnapshot,
  type ContextSnapshotStore,
  type SnapshotInput,
} from './contextSnapshotSlice'

describe('contextSnapshotSlice', () => {
  it('忽略 recentlyClosed 的迟到快照 view，并切换到仍可见的 active view', () => {
    const snapshot: SnapshotInput = {
      activeViewId: 'view-closed',
      views: [
        { viewId: 'view-closed', title: 'Closed tab', url: 'https://closed.example' },
        { viewId: 'view-open', title: 'Open tab', url: 'https://open.example' },
      ],
    }

    const result = applyCacheSnapshot(
      'cs-1',
      snapshot,
      [],
      new Map(),
      new Set(['view-closed']),
    )

    expect(result.viewList.map(view => view.viewId)).toEqual(['view-open'])
    expect(result.activeViewId).toBe('view-open')
  })

  it('applyCrawlspaceContextSnapshot 不应把已关闭 view 重新写回 cache 和 seeds', () => {
    let state: ContextSnapshotStore = {
      crawlspaceContextCache: {
        'cs-1': {
          activeViewId: 'view-open',
          viewList: [
            {
              viewId: 'view-open',
              title: 'Open tab',
              url: 'https://open.example',
              createdAt: 1,
              kind: 'workspace-view',
              crawlspaceId: 'cs-1',
              isPreview: false,
              isClosing: false,
            },
          ],
        },
      },
      crawlspaceDeferredViewIdsByCS: {},
      crawlspacePersistedViews: {
        'cs-1': [
          {
            viewId: 'view-open',
            title: 'Open tab',
            url: 'https://open.example',
            createdAt: 1,
            kind: 'workspace-view',
            crawlspaceId: 'cs-1',
            isPreview: false,
            isActive: true,
            lastAccessedAt: 1,
          },
          {
            viewId: 'view-closed',
            title: 'Closed tab',
            url: 'https://closed.example',
            createdAt: 2,
            kind: 'workspace-view',
            crawlspaceId: 'cs-1',
            isPreview: false,
            isActive: false,
            lastAccessedAt: 2,
          },
        ],
      },
      _coldStartPendingByCS: {},
      _recentlyClosedViewIds: new Set(['view-closed']),
    }

    const setState = (
      partial:
      | Partial<ContextSnapshotStore>
      | ((prev: ContextSnapshotStore) => Partial<ContextSnapshotStore>),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...patch }
    }

    const actions = createContextSnapshotActions(() => state, setState)

    actions.applyCrawlspaceContextSnapshot('cs-1', {
      activeViewId: 'view-closed',
      views: [
        { viewId: 'view-closed', title: 'Closed tab', url: 'https://closed.example' },
        { viewId: 'view-open', title: 'Open tab', url: 'https://open.example' },
      ],
    })

    expect(state.crawlspaceContextCache['cs-1']?.viewList.map(view => view.viewId)).toEqual(['view-open'])
    expect(state.crawlspaceContextCache['cs-1']?.activeViewId).toBe('view-open')
    expect(state.crawlspacePersistedViews['cs-1']?.map(view => view.viewId)).toEqual(['view-open'])
  })

  it('正常退出逐个销毁 View 时保留全部 seed，不把系统清理误判为用户关标签', () => {
    const now = Date.now()
    const cacheViews = [
      {
        viewId: 'view-a',
        title: 'A',
        url: 'https://a.example',
        createdAt: now - 2,
        kind: 'workspace-view' as const,
        crawlspaceId: 'cs-1',
        isPreview: false,
        isClosing: false,
      },
      {
        viewId: 'view-b',
        title: 'B',
        url: 'https://b.example',
        createdAt: now - 1,
        kind: 'workspace-view' as const,
        crawlspaceId: 'cs-1',
        isPreview: false,
        isClosing: false,
      },
    ]
    const seeds = cacheViews.map((view, index) => ({
      ...view,
      isActive: index === 1,
      position: index,
      lastAccessedAt: now,
    }))
    const remainingViews = [cacheViews[1]!]

    const result = syncSeedsFromSnapshot(
      'cs-1',
      { activeViewId: 'view-b', views: remainingViews },
      remainingViews,
      cacheViews,
      seeds,
      new Map(seeds.map(seed => [seed.viewId, seed])),
      false,
      new Set(),
    )

    expect(result.map(seed => seed.viewId)).toEqual(['view-a', 'view-b'])
    expect(result.find(seed => seed.viewId === 'view-b')?.isActive).toBe(true)
  })

  it('applyCacheSnapshot 在 snapshot 显式清空 themeColor 时不应回退到旧值', () => {
    const snapshot: SnapshotInput = {
      activeViewId: 'view-1',
      views: [
        {
          viewId: 'view-1',
          title: 'Dark page',
          url: 'https://dark.example',
          themeColor: undefined,
        },
      ],
    }

    const result = applyCacheSnapshot(
      'cs-1',
      snapshot,
      [
        {
          viewId: 'view-1',
          title: 'Dark page',
          url: 'https://dark.example',
          themeColor: '#111111',
          createdAt: 1,
          kind: 'workspace-view',
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ],
      new Map(),
    )

    expect(result.viewList[0]?.themeColor).toBeUndefined()
  })

  it('applyCacheSnapshot 保留 deferred 占位符 views（不在 snapshot 中但被 mark 为 deferred）', () => {
    // Wave 3.1: 主进程 snapshot 不包含 renderer-only deferred 占位符，
    // applyCacheSnapshot 应基于 deferredViewIds 把它们从 cache 中保留过来。
    const cacheViews = [
      {
        viewId: 'view-real',
        title: 'Realized tab',
        url: 'https://real.example',
        createdAt: 1,
        kind: 'workspace-view' as const,
        crawlspaceId: 'cs-1',
        isPreview: false,
        isClosing: false,
      },
      {
        viewId: 'view-deferred',
        title: 'Deferred placeholder',
        url: 'https://deferred.example',
        createdAt: 2,
        kind: 'workspace-view' as const,
        crawlspaceId: 'cs-1',
        isPreview: false,
        isClosing: false,
      },
    ]

    const snapshot: SnapshotInput = {
      activeViewId: 'view-real',
      views: [
        // 主进程只知道 view-real；view-deferred 不在 snapshot 中
        { viewId: 'view-real', title: 'Realized tab', url: 'https://real.example' },
      ],
    }

    const result = applyCacheSnapshot(
      'cs-1',
      snapshot,
      cacheViews,
      new Map(),
      undefined,
      new Set(['view-deferred']),
    )

    const ids = result.viewList.map(v => v.viewId)
    expect(ids).toContain('view-real')
    expect(ids).toContain('view-deferred')
    expect(result.activeViewId).toBe('view-real')
  })

  it('applyCacheSnapshot 不保留 deferred views（如果该 viewId 同时在 closedViewIds 中）', () => {
    // 防御：被关闭的 view 优先级高于 deferred 标记，不应被复活。
    const cacheViews = [
      {
        viewId: 'view-closing',
        title: 'Closing tab',
        url: 'https://closing.example',
        createdAt: 1,
        kind: 'workspace-view' as const,
        crawlspaceId: 'cs-1',
        isPreview: false,
        isClosing: false,
      },
    ]

    const snapshot: SnapshotInput = { activeViewId: null, views: [] }

    const result = applyCacheSnapshot(
      'cs-1',
      snapshot,
      cacheViews,
      new Map(),
      new Set(['view-closing']),
      new Set(['view-closing']),
    )

    expect(result.viewList).toHaveLength(0)
  })

  describe('renderer-driven 字段抖动保护（Wave 3.1）', () => {
    it('cache 中已有新 url（renderer 写入），snapshot 中是旧 url 时应保留 cache', () => {
      // 用户场景：renderer 已 setCrawlspaceViewMeta(url='https://new.example')，
      // 主进程 webContents 还在 navigate 中，snapshot.url 仍是旧值。
      // cache 不应倒退——renderer 的最新写入是用户当前看到的事实。
      const cacheViews = [
        {
          viewId: 'view-1',
          title: 'Same title',
          url: 'https://new.example',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          { viewId: 'view-1', title: 'Same title', url: 'https://old.example' },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.url).toBe('https://new.example')
    })

    it('cache 中是 about:blank 时应优先 snapshot 的真实 url', () => {
      // 防御：about:blank 不算 renderer 主权写入，应被 snapshot 覆盖。
      const cacheViews = [
        {
          viewId: 'view-1',
          title: 'New Tab',
          url: 'about:blank',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          { viewId: 'view-1', title: 'Loaded', url: 'https://real.example' },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.url).toBe('https://real.example')
    })

    it('cache 中已有用户改过的 title（非默认），snapshot 中是默认值时应保留 cache', () => {
      const cacheViews = [
        {
          viewId: 'view-1',
          title: '用户编辑的标题',
          url: 'https://example.com',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          { viewId: 'view-1', title: 'New Tab', url: 'https://example.com' },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.title).toBe('用户编辑的标题')
    })

    it('cache 中 isPreview=true（renderer 主权），snapshot 中是 false 时应保留 cache', () => {
      // 用户场景：useCrawlSpacePreview.ensurePreview 写入 isPreview=true 但
      // 不通知主进程。下一次 snapshot 推送 isPreview=false（主进程默认值），
      // 不应覆盖 cache。
      const cacheViews = [
        {
          viewId: 'view-1',
          title: 'Preview tab',
          url: 'https://preview.example',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: true,
          isClosing: false,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          { viewId: 'view-1', title: 'Preview tab', url: 'https://preview.example', isPreview: false },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.isPreview).toBe(true)
    })
  })

  describe('主进程主权字段 snapshot 优先（Wave 3.1，mergeViews 行为反转契约）', () => {
    // 历史：旧 mergeViews 在 adapter 层做"双向择优"，store 视为更近期事实，
    // 整体 store 优先。Wave 3.1 把合并下沉到 applyCacheSnapshot 后，url/title/
    // isPreview 之外的字段统一改为 snapshot 优先（主进程主权）。这一组测试
    // 锁定该契约，防止后续重构误把方向反过来。
    it('favicon 字段 snapshot 优先：snapshot 提供新值时 cache 旧值被覆盖', () => {
      const cacheViews = [
        {
          viewId: 'view-1',
          title: 'Tab',
          url: 'https://example.com',
          favicon: 'data:image/png;base64,oldicon',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          {
            viewId: 'view-1',
            title: 'Tab',
            url: 'https://example.com',
            favicon: 'data:image/png;base64,newicon',
          },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.favicon).toBe('data:image/png;base64,newicon')
    })

    it('favicon 字段 snapshot 缺失时回退到 cache（避免清空已知 favicon）', () => {
      const cacheViews = [
        {
          viewId: 'view-1',
          title: 'Tab',
          url: 'https://example.com',
          favicon: 'data:image/png;base64,oldicon',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          { viewId: 'view-1', title: 'Tab', url: 'https://example.com' },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.favicon).toBe('data:image/png;base64,oldicon')
    })

    it('favicon 字段 snapshot 缺失且 url 已换页时不回退到 seed 旧图标', () => {
      const seedMap = new Map([
        [
          'view-1',
          {
            viewId: 'view-1',
            title: 'Baidu',
            url: 'https://www.baidu.com',
            favicon: 'data:image/png;base64,baidu',
            createdAt: 1,
          },
        ],
      ])

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          {
            viewId: 'view-1',
            title: '小红书',
            url: 'https://www.xiaohongshu.com/explore',
          },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, [], seedMap)

      expect(result.viewList[0]?.url).toBe('https://www.xiaohongshu.com/explore')
      expect(result.viewList[0]?.favicon).toBeUndefined()
    })

    it('syncSeedsFromSnapshot 在 url 已换页且无新 favicon 时不保留旧 seed favicon', () => {
      const previousSeeds = [
        {
          viewId: 'view-1',
          title: 'Baidu',
          url: 'https://www.baidu.com',
          favicon: 'data:image/png;base64,baidu',
          createdAt: 1,
        },
      ]
      const nextViewList = [
        {
          viewId: 'view-1',
          title: '小红书',
          url: 'https://www.xiaohongshu.com/explore',
          createdAt: 2,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ]

      const result = syncSeedsFromSnapshot(
        'cs-1',
        { activeViewId: 'view-1', views: nextViewList },
        nextViewList,
        nextViewList,
        previousSeeds,
        new Map(previousSeeds.map(seed => [seed.viewId, seed])),
        false,
      )

      expect(result[0]?.url).toBe('https://www.xiaohongshu.com/explore')
      expect(result[0]?.favicon).toBeUndefined()
    })

    it('isLoading 字段 snapshot 优先（确认非 renderer 主权）', () => {
      const cacheViews = [
        {
          viewId: 'view-1',
          title: 'Tab',
          url: 'https://example.com',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
          isLoading: true,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          { viewId: 'view-1', title: 'Tab', url: 'https://example.com', isLoading: false },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.isLoading).toBe(false)
    })

    it('runId 字段 snapshot 优先（标记当前抖动行为，IPC 同步期间罕见但理论存在）', () => {
      // 当前 runId 处理 `view.runId ?? existing?.runId ?? seed?.runId`
      // 是 snapshot 优先回退到 cache。本测试锁定行为；如未来 runId 也需
      // renderer 主权（如同 isPreview），需明确升级该字段处理。
      const cacheViews = [
        {
          viewId: 'view-1',
          title: 'Tab',
          url: 'https://example.com',
          runId: 'old-run',
          createdAt: 1,
          kind: 'workspace-view' as const,
          crawlspaceId: 'cs-1',
          isPreview: false,
          isClosing: false,
        },
      ]

      const snapshot: SnapshotInput = {
        activeViewId: 'view-1',
        views: [
          { viewId: 'view-1', title: 'Tab', url: 'https://example.com', runId: 'new-run' },
        ],
      }

      const result = applyCacheSnapshot('cs-1', snapshot, cacheViews, new Map())

      expect(result.viewList[0]?.runId).toBe('new-run')
    })
  })

  it('markCrawlspaceViewDeferred / unmarkCrawlspaceViewDeferred 维护 deferred IDs', () => {
    let state: ContextSnapshotStore = {
      crawlspaceContextCache: {},
      crawlspaceDeferredViewIdsByCS: {},
      crawlspacePersistedViews: {},
      _coldStartPendingByCS: {},
      _recentlyClosedViewIds: new Set(),
    }

    const setState = (
      partial:
      | Partial<ContextSnapshotStore>
      | ((prev: ContextSnapshotStore) => Partial<ContextSnapshotStore>),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...patch }
    }

    const actions = createContextSnapshotActions(() => state, setState)

    actions.markCrawlspaceViewDeferred('cs-1', 'view-a')
    actions.markCrawlspaceViewDeferred('cs-1', 'view-b')
    expect(state.crawlspaceDeferredViewIdsByCS['cs-1']).toEqual(new Set(['view-a', 'view-b']))

    // 重复 mark 同 viewId 不变化引用（幂等）
    const before = state.crawlspaceDeferredViewIdsByCS['cs-1']
    actions.markCrawlspaceViewDeferred('cs-1', 'view-a')
    expect(state.crawlspaceDeferredViewIdsByCS['cs-1']).toBe(before)

    actions.unmarkCrawlspaceViewDeferred('cs-1', 'view-a')
    expect(state.crawlspaceDeferredViewIdsByCS['cs-1']).toEqual(new Set(['view-b']))

    // 全部 unmark 后清空 entry（不留空 Set）
    actions.unmarkCrawlspaceViewDeferred('cs-1', 'view-b')
    expect(state.crawlspaceDeferredViewIdsByCS['cs-1']).toBeUndefined()
  })
})
