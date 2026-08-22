import { describe, expect, it } from 'vitest'
import { reconcileWorkbenchRestore } from '../reconcileWorkbenchRestore'
import { markResourceMembershipPending } from '../resourceMembershipPending'
import type { WorkbenchRestoreInput } from '../types'
import type { ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import type { CanvasLayoutGroup, CanvasTabKey } from '@stores/useCanvasLayoutStore'
import type { CrawlspacePersistedViewSeed, CrawlspaceViewInfo } from '@stores/useCrawlTabStore'

const item = (tabKey: string, title?: string, meta?: Record<string, unknown>): ContextItemRecord => {
  const [type, id] = tabKey.split(':')
  return {
    tabKey,
    type,
    id,
    ...(title ? { title } : {}),
    ...(meta ? { meta } : {}),
  }
}

const browserSeed = (viewId: string, overrides: Partial<CrawlspacePersistedViewSeed> = {}): CrawlspacePersistedViewSeed => ({
  viewId,
  title: overrides.title ?? 'seed tab',
  url: overrides.url ?? 'https://example.com',
  createdAt: overrides.createdAt ?? 1,
  isActive: overrides.isActive,
  lastAccessedAt: overrides.lastAccessedAt,
})

const browserView = (viewId: string, overrides: Partial<CrawlspaceViewInfo> = {}): CrawlspaceViewInfo => ({
  viewId,
  title: overrides.title ?? 'live tab',
  url: overrides.url ?? 'about:blank',
  createdAt: overrides.createdAt ?? 1,
  updatedAt: overrides.updatedAt ?? 1,
  isClosing: overrides.isClosing,
})

const group = (
  panes: Array<{ id: string; tabKey: CanvasTabKey | null }>,
  overrides: Partial<CanvasLayoutGroup> = {},
): CanvasLayoutGroup => ({
  id: overrides.id ?? 'group-1',
  spaceId: overrides.spaceId ?? 'space-1',
  anchorTabKey: overrides.anchorTabKey ?? panes.find(pane => pane.tabKey)?.tabKey ?? 'tabweb:anchor',
  panes: panes.map(pane => ({
    id: pane.id,
    content: pane.tabKey ? { tabKey: pane.tabKey } : null,
  })),
  layout: overrides.layout ?? (panes.length <= 1
    ? { type: 'leaf', paneId: panes[0]?.id ?? 'pane-1' }
    : {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: panes.map(pane => ({ type: 'leaf' as const, paneId: pane.id })),
        sizes: panes.map(() => 1 / panes.length),
      }),
  activePaneId: overrides.activePaneId ?? panes[0]?.id ?? null,
  createdAt: overrides.createdAt ?? 1,
  updatedAt: overrides.updatedAt ?? 1,
})

const baseInput = (overrides: Partial<WorkbenchRestoreInput> = {}): WorkbenchRestoreInput => ({
  spaceId: 'space-1',
  crawlspaceId: 'crawl-1',
  tabOrder: [],
  itemsByTabKey: {},
  activeKey: null,
  displayKey: null,
  lastActiveSurface: 'real_tab',
  canvasGroups: [],
  browser: {
    items: [],
    viewList: [],
    activeViewId: null,
    persistedSeeds: [],
    recentlyClosedViewIds: new Set<string>(),
    coldStartPending: false,
  },
  table: {
    items: [],
    isLoading: false,
    hasError: false,
  },
  terminal: {
    items: [],
    sessionIds: [],
    splitSubPaneSessionIds: new Set<string>(),
    hydrated: true,
  },
  apps: {
    ready: true,
    isAppEnabled: () => true,
    getAppId: type => type,
    requireResourceMembership: () => false,
  },
  resourceMembership: {
    byType: {},
    loaded: false,
  },
  readiness: {
    contextTabsHydrated: true,
    canvasLayoutHydrated: true,
    crawlTabsHydrated: true,
    terminalSessionsHydrated: true,
    browserColdStartPending: false,
  },
  ...overrides,
})

describe('reconcileWorkbenchRestore', () => {
  it('active 为空时使用 browser active seed 恢复 baidu', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabweb:baidu'],
      browser: {
        ...baseInput().browser,
        activeViewId: 'baidu',
        persistedSeeds: [browserSeed('baidu', { title: '百度一下，你就知道', url: 'https://www.baidu.com', isActive: true })],
      },
    }))

    expect(decision.contextPatch.activeKey).toBe('tabweb:baidu')
    expect(decision.desiredActiveViewId).toBe('baidu')
    expect(decision.statusByTabKey['tabweb:baidu'].kind).toBe('recoverable')
    expect(decision.contextPatch.items['tabweb:baidu'].title).toBe('百度一下，你就知道')
  })

  it('有效 table active 不被 browser seed 抢焦点', () => {
    const table = item('tabdata:t1', '表格')
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabdata:t1', 'tabweb:baidu'],
      itemsByTabKey: { 'tabdata:t1': table },
      activeKey: 'tabdata:t1',
      table: { items: [table], isLoading: false, hasError: false },
      browser: {
        ...baseInput().browser,
        activeViewId: 'baidu',
        persistedSeeds: [browserSeed('baidu', { isActive: true })],
      },
    }))

    expect(decision.contextPatch.activeKey).toBe('tabdata:t1')
    expect(decision.desiredActiveViewId).toBeNull()
    expect(decision.trace.activeReason).toBe('persisted_active')
  })

  it('退出前停留在 desktop surface 时恢复虚拟桌面 active', () => {
    const baidu = item('tabweb:baidu')
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabweb:baidu'],
      itemsByTabKey: { 'tabweb:baidu': baidu },
      activeKey: null,
      displayKey: null,
      lastActiveSurface: 'desktop',
      browser: {
        ...baseInput().browser,
        items: [baidu],
        viewList: [browserView('baidu')],
      },
    }))

    expect(decision.contextPatch.activeKey).toBeNull()
    expect(decision.activeSurface).toBe('desktop')
    expect(decision.trace.activeReason).toBe('last_surface_desktop')
  })

  it('真实 tab 关光且 lastSurface=real_tab 时保持 home，不误激活虚拟桌面', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: [],
      itemsByTabKey: {},
      activeKey: null,
      displayKey: null,
      lastActiveSurface: 'real_tab',
    }))

    expect(decision.contextPatch.activeKey).toBeNull()
    expect(decision.activeSurface).toBe('real_tab')
    expect(decision.trace.activeReason).toBe('no_real_tab')
  })

  it('lastSurface=desktop 但 store 里有 valid activeKey 时优先保留 activeKey（修复 React  死循环）', () => {
    // 防回归：当虚拟 lastSurface 与 store.activeKey=valid 不一致时，
    // 说明被外部 setter（useTabSync.fallback / 其它意外路径）覆盖过。
    // 之前 reconcile 强制清空 activeKey → effect 又把 lastSurface 改回 real_tab
    // → 下次 reconcile 又选回 valid tab → effect 又改 surface → 死循环。
    // 修复后 reconcile 尊重 store.activeKey，让 effect 自然把 lastSurface 同步到 real_tab。
    const baidu = item('tabweb:baidu')
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabweb:baidu'],
      itemsByTabKey: { 'tabweb:baidu': baidu },
      activeKey: 'tabweb:baidu',
      displayKey: 'tabweb:baidu',
      lastActiveSurface: 'desktop',
      browser: {
        ...baseInput().browser,
        items: [baidu],
        viewList: [browserView('baidu')],
      },
    }))

    expect(decision.contextPatch.activeKey).toBe('tabweb:baidu')
    expect(decision.activeSurface).toBe('real_tab')
    expect(decision.trace.activeReason).toBe('persisted_active')
  })

  it('真实空白新标签只要有 seed/cache 就不清理', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabweb:blank'],
      browser: {
        ...baseInput().browser,
        activeViewId: 'blank',
        persistedSeeds: [browserSeed('blank', { title: '新标签', url: 'about:blank', isActive: true })],
      },
    }))

    expect(decision.statusByTabKey['tabweb:blank'].kind).toBe('recoverable')
    expect(decision.contextPatch.tabOrder).toEqual(['tabweb:blank'])
    expect(decision.contextPatch.activeKey).toBe('tabweb:blank')
  })

  it('无 seed/live/cache 的 browser 幽灵 pane 会被清理，空 pane 保留', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabweb:baidu'],
      itemsByTabKey: { 'tabweb:baidu': item('tabweb:baidu') },
      canvasGroups: [group([
        { id: 'p-stale', tabKey: 'tabweb:ghost' },
        { id: 'p-empty', tabKey: null },
      ], { activePaneId: 'p-stale', anchorTabKey: 'tabweb:ghost' })],
      browser: {
        ...baseInput().browser,
        items: [item('tabweb:baidu')],
        viewList: [browserView('baidu')],
      },
    }))

    expect(decision.statusByTabKey['tabweb:ghost'].kind).toBe('stale')
    expect(decision.trace.prunedPaneIds).toEqual(['p-stale'])
    expect(decision.canvasPatch.groups).toHaveLength(1)
    expect(decision.canvasPatch.groups[0].panes.map(pane => pane.id)).toEqual(['p-empty'])
    expect(decision.canvasPatch.groups[0].activePaneId).toBe('p-empty')
    expect(decision.canvasPatch.groups[0].anchorTabKey).toBe('tabweb:baidu')
  })

  it('table source loading/error 时 tabdata 是 unknown，不清理', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabdata:t1'],
      activeKey: 'tabdata:t1',
      itemsByTabKey: { 'tabdata:t1': item('tabdata:t1') },
      table: { items: [], isLoading: true, hasError: false },
    }))

    expect(decision.statusByTabKey['tabdata:t1'].kind).toBe('unknown')
    expect(decision.contextPatch.tabOrder).toEqual(['tabdata:t1'])
    expect(decision.contextPatch.activeKey).toBe('tabdata:t1')
  })

  it('app disabled 时标签 suspended 并保留持久状态', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabdoc:d1'],
      activeKey: 'tabdoc:d1',
      itemsByTabKey: { 'tabdoc:d1': item('tabdoc:d1') },
      apps: {
        ready: true,
        getAppId: type => type,
        isAppEnabled: appId => appId !== 'tabdoc',
        requireResourceMembership: () => false,
      },
    }))

    expect(decision.statusByTabKey['tabdoc:d1'].kind).toBe('suspended')
    expect(decision.contextPatch.tabOrder).toEqual(['tabdoc:d1'])
    expect(decision.contextPatch.items['tabdoc:d1']).toBeTruthy()
  })

  it('terminal 未 hydrated 保留 unknown，split sub-pane 不进入顶部标签', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['terminal:root', 'terminal:child'],
      itemsByTabKey: {
        'terminal:root': item('terminal:root'),
        'terminal:child': item('terminal:child'),
      },
      terminal: {
        items: [item('terminal:root')],
        sessionIds: ['root'],
        splitSubPaneSessionIds: new Set(['child']),
        hydrated: true,
      },
    }))

    expect(decision.statusByTabKey['terminal:child'].kind).toBe('stale')
    expect(decision.contextPatch.tabOrder).toEqual(['terminal:root'])

    const pending = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['terminal:root'],
      itemsByTabKey: { 'terminal:root': item('terminal:root') },
      terminal: {
        items: [],
        sessionIds: [],
        splitSubPaneSessionIds: new Set(),
        hydrated: false,
      },
      readiness: {
        ...baseInput().readiness,
        terminalSessionsHydrated: false,
      },
    }))
    expect(pending.statusByTabKey['terminal:root'].kind).toBe('unknown')
    expect(pending.contextPatch.tabOrder).toEqual(['terminal:root'])
  })

  it('recently closed browser view 不被旧 seed 复活', () => {
    const decision = reconcileWorkbenchRestore(baseInput({
      tabOrder: ['tabweb:baidu'],
      browser: {
        ...baseInput().browser,
        activeViewId: 'baidu',
        persistedSeeds: [browserSeed('baidu', { isActive: true })],
        recentlyClosedViewIds: new Set(['baidu']),
      },
    }))

    expect(decision.statusByTabKey['tabweb:baidu'].kind).toBe('stale')
    expect(decision.contextPatch.tabOrder).toEqual([])
    expect(decision.contextPatch.activeKey).toBeNull()
  })

  describe('资源类 tab 的 membership 校验（W2 修复 #3：死链 tab 自清）', () => {
    it('tabdata 资源已删（membership.loaded=true 且无该 id）→ stale 自清', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['tabdata:deleted-table-id'],
        activeKey: 'tabdata:deleted-table-id',
        itemsByTabKey: { 'tabdata:deleted-table-id': item('tabdata:deleted-table-id') },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdata',
        },
        resourceMembership: {
          byType: { tabdata: new Set(['some-other-table']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdata:deleted-table-id'].kind).toBe('stale')
      expect(decision.statusByTabKey['tabdata:deleted-table-id'].reason).toBe('table_resource_missing')
      expect(decision.contextPatch.tabOrder).toEqual([])
      expect(decision.contextPatch.activeKey).toBeNull()
    })

    it('tabdata 资源还存在 → 保留为 valid', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['tabdata:t1'],
        activeKey: 'tabdata:t1',
        itemsByTabKey: { 'tabdata:t1': item('tabdata:t1') },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdata',
        },
        resourceMembership: {
          byType: { tabdata: new Set(['t1', 't2']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdata:t1'].kind).toBe('valid')
      expect(decision.contextPatch.tabOrder).toEqual(['tabdata:t1'])
      expect(decision.contextPatch.activeKey).toBe('tabdata:t1')
    })

    it('资源列表还在加载（loaded=false）→ 保守维持 unknown，不清理', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['tabdata:t1'],
        activeKey: 'tabdata:t1',
        itemsByTabKey: { 'tabdata:t1': item('tabdata:t1') },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdata',
        },
        resourceMembership: {
          byType: {},
          loaded: false,
        },
      }))

      expect(decision.statusByTabKey['tabdata:t1'].kind).toBe('unknown')
      expect(decision.statusByTabKey['tabdata:t1'].reason).toBe('table_resource_loading')
      expect(decision.contextPatch.tabOrder).toEqual(['tabdata:t1'])
    })

    it('刚创建的 tabdata 还没进入资源索引时，不被旧浏览器 activeView 抢焦点', () => {
      const nowMs = 1_000_000
      const table = item('tabdata:new-table', '未命名表格', markResourceMembershipPending(undefined, nowMs))
      const browser = item('tabweb:old-browser')
      const decision = reconcileWorkbenchRestore(baseInput({
        nowMs,
        tabOrder: ['tabweb:old-browser', 'tabdata:new-table'],
        activeKey: 'tabdata:new-table',
        itemsByTabKey: {
          'tabweb:old-browser': browser,
          'tabdata:new-table': table,
        },
        table: { items: [table], isLoading: false, hasError: false },
        browser: {
          ...baseInput().browser,
          items: [browser],
          viewList: [browserView('old-browser')],
          activeViewId: 'old-browser',
        },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdata',
        },
        resourceMembership: {
          byType: { tabdata: new Set(['some-other-table']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdata:new-table'].kind).toBe('unknown')
      expect(decision.statusByTabKey['tabdata:new-table'].reason).toBe('table_resource_membership_pending')
      expect(decision.contextPatch.activeKey).toBe('tabdata:new-table')
      expect(decision.desiredActiveViewId).toBeNull()
      expect(decision.trace.activeReason).toBe('persisted_active')
    })

    it('刚创建的 tabdoc 还没进入资源索引时，不被旧浏览器 activeView 抢焦点', () => {
      const nowMs = 1_000_000
      const doc = item('tabdoc:new-doc', '未命名文档', markResourceMembershipPending({ focusTitle: true }, nowMs))
      const browser = item('tabweb:old-browser')
      const decision = reconcileWorkbenchRestore(baseInput({
        nowMs,
        tabOrder: ['tabweb:old-browser', 'tabdoc:new-doc'],
        activeKey: 'tabdoc:new-doc',
        itemsByTabKey: {
          'tabweb:old-browser': browser,
          'tabdoc:new-doc': doc,
        },
        browser: {
          ...baseInput().browser,
          items: [browser],
          viewList: [browserView('old-browser')],
          activeViewId: 'old-browser',
        },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdoc',
        },
        resourceMembership: {
          byType: { tabdoc: new Set(['some-other-doc']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdoc:new-doc'].kind).toBe('unknown')
      expect(decision.statusByTabKey['tabdoc:new-doc'].reason).toBe('resource_membership_pending')
      expect(decision.contextPatch.activeKey).toBe('tabdoc:new-doc')
      expect(decision.desiredActiveViewId).toBeNull()
      expect(decision.contextPatch.items['tabdoc:new-doc'].meta?.focusTitle).toBe(true)
    })

    // ：打开已有文档（非创建）在索引滞后时也必须打 pending，否则会打回表格首页
    it('刚打开的已有 tabdoc 索引暂缺时，不得把 activeKey 打回 apphome:tabdata', () => {
      const nowMs = 1_000_000
      const doc = item(
        'tabdoc:9d4193b7-65df-47f9-a725-bdfa55cf325e',
        '未命名文档',
        markResourceMembershipPending({ spaceId: 'space-1' }, nowMs),
      )
      const tableHome = item('apphome:tabdata', '表格')
      const decision = reconcileWorkbenchRestore(baseInput({
        nowMs,
        tabOrder: ['apphome:tabdata', 'tabdoc:9d4193b7-65df-47f9-a725-bdfa55cf325e'],
        activeKey: 'tabdoc:9d4193b7-65df-47f9-a725-bdfa55cf325e',
        itemsByTabKey: {
          'apphome:tabdata': tableHome,
          'tabdoc:9d4193b7-65df-47f9-a725-bdfa55cf325e': doc,
        },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdoc',
        },
        resourceMembership: {
          byType: { tabdoc: new Set(['some-other-doc']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdoc:9d4193b7-65df-47f9-a725-bdfa55cf325e'].kind).toBe('unknown')
      expect(decision.statusByTabKey['tabdoc:9d4193b7-65df-47f9-a725-bdfa55cf325e'].reason).toBe(
        'resource_membership_pending',
      )
      expect(decision.contextPatch.activeKey).toBe('tabdoc:9d4193b7-65df-47f9-a725-bdfa55cf325e')
      expect(decision.trace.activeReason).toBe('persisted_active')
    })

    it('打开已有 tabdoc 未打 pending 且索引缺失时，仍会 stale 并回退 activeKey（对照）', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['apphome:tabdata', 'tabdoc:missing-doc'],
        activeKey: 'tabdoc:missing-doc',
        itemsByTabKey: {
          'apphome:tabdata': item('apphome:tabdata', '表格'),
          'tabdoc:missing-doc': item('tabdoc:missing-doc', '未命名文档'),
        },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdoc',
        },
        resourceMembership: {
          byType: { tabdoc: new Set(['some-other-doc']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdoc:missing-doc'].kind).toBe('stale')
      expect(decision.statusByTabKey['tabdoc:missing-doc'].reason).toBe('resource_missing')
      expect(decision.contextPatch.activeKey).toBe('apphome:tabdata')
    })

    it('pending 标记过期后，资源索引仍缺失的 tabdata 继续 stale 自清', () => {
      const pendingSinceMs = 1_000_000
      const table = item('tabdata:expired-table', '过期表格', markResourceMembershipPending(undefined, pendingSinceMs))
      const decision = reconcileWorkbenchRestore(baseInput({
        nowMs: pendingSinceMs + 61_000,
        tabOrder: ['tabdata:expired-table'],
        activeKey: 'tabdata:expired-table',
        itemsByTabKey: { 'tabdata:expired-table': table },
        table: { items: [table], isLoading: false, hasError: false },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdata',
        },
        resourceMembership: {
          byType: { tabdata: new Set(['some-other-table']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdata:expired-table'].kind).toBe('stale')
      expect(decision.statusByTabKey['tabdata:expired-table'].reason).toBe('table_resource_missing')
      expect(decision.contextPatch.tabOrder).toEqual([])
      expect(decision.contextPatch.activeKey).toBeNull()
    })

    // ：打开很久后切/建视图会写 meta.viewId 并续期 pending，索引瞬时缺失时不得打回多维表首页
    it('切视图续期 pending 后，索引暂缺的 tabdata 不得把 activeKey 打回 apphome:tabdata', () => {
      const nowMs = 1_000_000
      const table = item(
        'tabdata:a93713a6-92f8-4a1a-952c-7edb35e78517',
        '复现表',
        markResourceMembershipPending(
          { spaceId: 'space-1', viewId: '54988045-73a4-4365-89a3-61519ca6b68c' },
          nowMs,
        ),
      )
      const tableHome = item('apphome:tabdata', '多维表')
      const decision = reconcileWorkbenchRestore(baseInput({
        nowMs,
        tabOrder: ['apphome:tabdata', 'tabdata:a93713a6-92f8-4a1a-952c-7edb35e78517'],
        activeKey: 'tabdata:a93713a6-92f8-4a1a-952c-7edb35e78517',
        itemsByTabKey: {
          'apphome:tabdata': tableHome,
          'tabdata:a93713a6-92f8-4a1a-952c-7edb35e78517': table,
        },
        table: { items: [table], isLoading: false, hasError: false },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdata',
        },
        resourceMembership: {
          byType: { tabdata: new Set(['some-other-table']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdata:a93713a6-92f8-4a1a-952c-7edb35e78517'].kind).toBe('unknown')
      expect(decision.statusByTabKey['tabdata:a93713a6-92f8-4a1a-952c-7edb35e78517'].reason).toBe(
        'table_resource_membership_pending',
      )
      expect(decision.contextPatch.activeKey).toBe('tabdata:a93713a6-92f8-4a1a-952c-7edb35e78517')
      expect(decision.trace.activeReason).toBe('persisted_active')
    })

    it('tabdoc 资源已删 → 走通用 persisted_item 分支的 stale', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['tabdoc:d1'],
        activeKey: 'tabdoc:d1',
        itemsByTabKey: { 'tabdoc:d1': item('tabdoc:d1') },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdoc',
        },
        resourceMembership: {
          byType: { tabdoc: new Set(['d2']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdoc:d1'].kind).toBe('stale')
      expect(decision.statusByTabKey['tabdoc:d1'].reason).toBe('resource_missing')
      expect(decision.contextPatch.tabOrder).toEqual([])
    })

    it('handler 不要求 membership 校验时（如 tabcode）保持原有 valid 行为', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['tabcode:/Users/foo/bar'],
        activeKey: 'tabcode:/Users/foo/bar',
        itemsByTabKey: { 'tabcode:/Users/foo/bar': item('tabcode:/Users/foo/bar') },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: () => false,
        },
        resourceMembership: { byType: {}, loaded: true },
      }))

      expect(decision.statusByTabKey['tabcode:/Users/foo/bar'].kind).toBe('valid')
    })

    // ：isolated scope coordinator 对 tabdoc 关闭 membership 自清后，索引缺失也不得 prune / 踢 active
    it('requireResourceMembership(tabdoc)=false 时索引缺失仍保留 tabdoc active（对称 ）', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['apphome:tabdata', 'tabdoc:d1'],
        activeKey: 'tabdoc:d1',
        itemsByTabKey: {
          'apphome:tabdata': item('apphome:tabdata', '表格'),
          'tabdoc:d1': item('tabdoc:d1', '分享文档'),
        },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          // 模拟 coordinator：isolated scope 对 tabdoc 返回 false
          requireResourceMembership: type => type === 'tabdoc' ? false : type === 'tabdata',
        },
        resourceMembership: {
          byType: { tabdoc: new Set(['other-doc']), tabdata: new Set() },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdoc:d1'].kind).toBe('valid')
      expect(decision.contextPatch.tabOrder).toContain('tabdoc:d1')
      expect(decision.contextPatch.activeKey).toBe('tabdoc:d1')
      expect(decision.trace.activeReason).toBe('persisted_active')
    })

    it('active 失效回退时优先真实 tab，不抢先落到 apphome', () => {
      const decision = reconcileWorkbenchRestore(baseInput({
        tabOrder: ['apphome:tabdata', 'tabdoc:keep', 'tabdoc:gone'],
        activeKey: 'tabdoc:gone',
        itemsByTabKey: {
          'apphome:tabdata': item('apphome:tabdata', '表格'),
          'tabdoc:keep': item('tabdoc:keep', '仍在'),
          'tabdoc:gone': item('tabdoc:gone', '已删'),
        },
        apps: {
          ready: true,
          isAppEnabled: () => true,
          getAppId: type => type,
          requireResourceMembership: type => type === 'tabdoc',
        },
        resourceMembership: {
          byType: { tabdoc: new Set(['keep']) },
          loaded: true,
        },
      }))

      expect(decision.statusByTabKey['tabdoc:gone'].kind).toBe('stale')
      expect(decision.contextPatch.activeKey).toBe('tabdoc:keep')
      expect(decision.trace.activeReason).toBe('first_restorable_tab')
    })
  })
})
