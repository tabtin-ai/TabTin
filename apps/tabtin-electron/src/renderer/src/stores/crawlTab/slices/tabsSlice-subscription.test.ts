/**
 * tabsSlice · createWorkspace 触发 context 订阅行为锁定。
 *
 * 设计动机（Wave 3.1 二轮复核）：
 * 历史上 `createWorkspace` 写空 cache 不订阅，依赖 `CrawlspaceWorkspace` 挂载
 * 时 `ensureCrawlspaceContextCache` 触发 ensure 订阅。但 `ContextSpaceToolHandler.ts`
 * 的 list_context_space + `resource-monitor.buildViewTitleById` 是仅 cache
 * 路径（无 IPC 兜底），用户 createWorkspace 后立即调 Agent 工具或资源监控，
 * 会读到空数据。
 *
 * 修复：createWorkspace 同步触发 ensureCrawlspaceContextSubscription——创建
 * 即订阅，不依赖 CrawlspaceWorkspace 挂载。本测试锁定该契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  default: {
    t: vi.fn((key: string) => key),
  },
}))

vi.mock('../../../crawlspace/workspace-defaults', () => ({
  getAgentWorkspaceDefaults: () => ({
    profile: 'background-task',
    runPrefix: 'agent',
    uiConfig: { defaultTitle: 'Agent Workspace' },
  }),
  getWorkspaceDefaults: () => ({
    profile: 'default',
    runPrefix: 'user',
    uiConfig: { defaultTitle: 'User Workspace' },
  }),
}))

const mockEnsureSubscription = vi.fn()
const mockReleaseAllSubscriptions = vi.fn()
vi.mock('../crawlspaceContextSubscriptionRegistry', () => ({
  ensureCrawlspaceContextSubscription: (csId: string) => mockEnsureSubscription(csId),
  releaseAllCrawlspaceContextSubscriptions: () => mockReleaseAllSubscriptions(),
}))

import { createTabsActions, __resetSpacePartitionCacheForTests } from './tabsSlice'
import { __resetBrowserEnvSnapshotForTests } from '../../browserEnvSnapshot'
import type {
  CrawlTab,
  CrawlspaceConfig,
  CrawlspacePreviewState,
  CrawlspaceContextCache,
  CrawlspacePersistedViewSeed,
} from '../types'

interface StoreState {
  tabs: CrawlTab[]
  crawlspacePreviewStates: Record<string, CrawlspacePreviewState>
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>
  crawlspaceDeferredViewIdsByCS: Record<string, Set<string>>
  crawlspacePersistedViews: Record<string, CrawlspacePersistedViewSeed[]>
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  _coldStartPendingByCS: Record<string, boolean>
  _recentlyClosedViewIds: Set<string>
  deleteTab: (id: string) => void
}

function createTestStore() {
  let state: StoreState = {
    tabs: [],
    crawlspacePreviewStates: {},
    crawlspaceContextCache: {},
    crawlspaceDeferredViewIdsByCS: {},
    crawlspacePersistedViews: {},
    crawlspaceConfigById: {},
    _coldStartPendingByCS: {},
    _recentlyClosedViewIds: new Set<string>(),
    deleteTab: vi.fn(),
  }
  const get = () => state as any
  const set = (partialOrFn: any) => {
    const patch = typeof partialOrFn === 'function' ? partialOrFn(state) : partialOrFn
    state = { ...state, ...patch }
  }
  const actions = createTabsActions(get, set as any)
  return { state: () => state, actions }
}

describe('tabsSlice · createWorkspace context 订阅触发（Wave 3.1 二轮复核）', () => {
  beforeEach(() => {
    __resetSpacePartitionCacheForTests()
    __resetBrowserEnvSnapshotForTests()
    mockEnsureSubscription.mockClear()
    mockReleaseAllSubscriptions.mockClear()
    delete (globalThis as any).window
    vi.restoreAllMocks()
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  it('createWorkspace 同步触发 ensureCrawlspaceContextSubscription（用 csId 调用）', () => {
    // 验证：避免"已 createWorkspace 但 CrawlspaceWorkspace 还未挂载"期间，
    // 仅 cache 路径（ContextSpaceToolHandler / resource-monitor）读到空数据。
    const { actions } = createTestStore()

    const tab = actions.createWorkspace({
      spaceId: 'space-A',
      profile: 'background-task',
      crawlspaceId: 'cs-test-1',
    })

    expect(tab.id).toBe('cs-test-1')
    expect(mockEnsureSubscription).toHaveBeenCalledTimes(1)
    expect(mockEnsureSubscription).toHaveBeenCalledWith('cs-test-1')
  })

  it('ensure 调用必须在 cache 已写入之后（避免 listener 撞 race）', () => {
    // 关键时序：set 写空 cache → ensureCrawlspaceContextSubscription。
    // 本测试用 mockEnsureSubscription 内 introspect state 验证。
    const { actions, state } = createTestStore()

    let cacheAtEnsureTime: CrawlspaceContextCache | undefined
    mockEnsureSubscription.mockImplementation((csId: string) => {
      cacheAtEnsureTime = state().crawlspaceContextCache[csId]
    })

    actions.createWorkspace({
      spaceId: 'space-B',
      profile: 'background-task',
      crawlspaceId: 'cs-test-2',
    })

    expect(cacheAtEnsureTime).toEqual({ activeViewId: null, viewList: [] })
  })

  it('多次 createWorkspace 各自触发 ensure（不同 csId 互不干扰）', () => {
    const { actions } = createTestStore()

    actions.createWorkspace({
      spaceId: 'space-1',
      profile: 'background-task',
      crawlspaceId: 'cs-a',
    })
    actions.createWorkspace({
      spaceId: 'space-2',
      profile: 'background-task',
      crawlspaceId: 'cs-b',
    })

    expect(mockEnsureSubscription).toHaveBeenCalledTimes(2)
    expect(mockEnsureSubscription).toHaveBeenNthCalledWith(1, 'cs-a')
    expect(mockEnsureSubscription).toHaveBeenNthCalledWith(2, 'cs-b')
  })

  it('clearAll 调用 releaseAllCrawlspaceContextSubscriptions（已有契约保留）', () => {
    const { actions } = createTestStore()

    actions.createWorkspace({
      spaceId: 'space-C',
      profile: 'background-task',
      crawlspaceId: 'cs-test-3',
    })
    expect(mockEnsureSubscription).toHaveBeenCalledTimes(1)
    expect(mockReleaseAllSubscriptions).not.toHaveBeenCalled()

    actions.clearAll()
    expect(mockReleaseAllSubscriptions).toHaveBeenCalledTimes(1)
  })
})
