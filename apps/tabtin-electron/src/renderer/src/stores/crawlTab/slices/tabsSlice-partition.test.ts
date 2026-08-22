/**
 * tabsSlice partition 解析单测（本地化退役 Wave 2 之后）。
 *
 * 覆盖的核心场景：
 *   1. 启动期镜像未就绪 → `createWorkspace` fallback 到默认 env partition
 *   2. 镜像加载完成（`onChanged` 触发）→ workspace partition 升级到正确的
 *      绑定 env partition
 *   3. 显式 `config.partition` 优先于镜像查询
 *   4. 无 spaceId 且无显式 partition → throw（防止永久无 session 隔离）
 *   5. `clearAll` 清状态后 listener 重新装好（用户切账号路径）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { createTabsActions, __resetSpacePartitionCacheForTests } from './tabsSlice'
import {
  __resetBrowserEnvSnapshotForTests,
  buildSessionPartition,
  notifyOrganizationResolverChanged,
  setOrganizationIdResolver,
  DEFAULT_ENV_PARTITION,
} from '../../browserEnvSnapshot'
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
  state = { ...state, ...actions }
  return { state: () => state, actions, get, set }
}

interface MockListResult {
  success: true
  environments: Array<{
    id: string
    name: string
    partition_key: string
    is_default: boolean
    binding_count: number
    explicit_binding_count: number
    using_space_count: number
    created_at: string
    updated_at: string
  }>
  bindings: Array<{ space_id: string; environment_id: string; is_explicit: boolean }>
}

/**
 * 安装 mock window.tabtin.browserEnv —— `list()` 返回快照，`onChanged` 模拟主进程
 * 广播。返回 `fireChange` 用于测试主动触发 onChanged。
 */
function installBrowserEnvMock(initialSnapshot: MockListResult | null) {
  let currentSnapshot = initialSnapshot
  const listFn = vi.fn().mockImplementation(
    () => Promise.resolve(currentSnapshot ?? { success: true, environments: [], bindings: [] }),
  )
  let changeHandler: ((payload: any) => void) | null = null
  const onChangedFn = vi.fn().mockImplementation((cb: any) => {
    changeHandler = cb
    return () => {
      changeHandler = null
    }
  })
  ;(globalThis as any).window = {
    tabtin: { browserEnv: { list: listFn, onChanged: onChangedFn } },
  }
  return {
    list: listFn,
    onChanged: onChangedFn,
    setSnapshot: (next: MockListResult | null) => {
      currentSnapshot = next
    },
    fireChange: (payload: { reason: string; spaceId?: string }) => changeHandler?.(payload),
  }
}

function makeEnv(id: string, partition_key: string, isDefault = false) {
  return {
    id,
    name: id,
    partition_key,
    is_default: isDefault,
    binding_count: 0,
    explicit_binding_count: 0,
    using_space_count: 0,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
  }
}

describe('tabsSlice · partition 解析（Wave 2 本地化退役）', () => {
  beforeEach(() => {
    __resetSpacePartitionCacheForTests()
    __resetBrowserEnvSnapshotForTests()
    delete (globalThis as any).window
    vi.restoreAllMocks()
  })

  it('启动期镜像未就绪 → createWorkspace fallback 到默认 env partition', () => {
    // 不安装 window.tabtin → 镜像无 IPC 可调
    const { actions, state } = createTestStore()

    const tab = actions.createWorkspace({
      spaceId: 'space-A',
      profile: 'background-task',
    })

    expect(state().crawlspaceConfigById[tab.id].partition).toBe(DEFAULT_ENV_PARTITION)
  })

  it('镜像就绪后再创建 workspace → 同步拿到绑定 env partition', async () => {
    installBrowserEnvMock({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })

    const { actions, state } = createTestStore()
    // 镜像首次拉取是异步的 —— 等一帧让 list() promise 完成
    await new Promise((r) => setTimeout(r, 0))

    const tab = actions.createWorkspace({
      spaceId: 'space-A',
      profile: 'background-task',
    })
    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:env:personal')
  })

  it('启动期已创建的 workspace 在镜像加载完成后被升级到绑定 env partition', async () => {
    const env = installBrowserEnvMock(null) // 首次 list 返回空
    const { actions, state } = createTestStore()

    // 镜像未就绪时创建 workspace —— partition 落到默认 env
    const tab = actions.createWorkspace({
      spaceId: 'space-A',
      profile: 'background-task',
    })
    expect(state().crawlspaceConfigById[tab.id].partition).toBe(DEFAULT_ENV_PARTITION)

    // 镜像加载到新快照（space-A 显式绑定到 personal）
    env.setSnapshot({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })
    env.fireChange({ reason: 'manual-refresh' })
    await new Promise((r) => setTimeout(r, 0))

    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:env:personal')
    const wsTab = state().tabs.find((t) => t.id === tab.id)
    expect(wsTab?.metadata?.crawlspaceConfig?.partition).toBe('tabtin:env:personal')
  })

  it('review P1：organization 就绪后 notifyOrganizationResolverChanged 升级占位 tabtin:env:default → organization 罐', () => {
    installBrowserEnvMock(null) // 镜像空、无显式绑定
    const { actions, state } = createTestStore()

    // organization 未就绪（未设解析器）时创建 → 占位默认 env partition
    const tab = actions.createWorkspace({ spaceId: 'space-A', profile: 'background-task' })
    expect(state().crawlspaceConfigById[tab.id].partition).toBe(DEFAULT_ENV_PARTITION)

    // organization 就绪：注入解析器 + 补一次通知 → listener 同步把占位升级到 organization 罐
    setOrganizationIdResolver(() => 'wt-acme')
    notifyOrganizationResolverChanged()

    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:organization:wt-acme:browser')
    const wsTab = state().tabs.find((t) => t.id === tab.id)
    expect(wsTab?.metadata?.crawlspaceConfig?.partition).toBe('tabtin:organization:wt-acme:browser')
  })

  it('review P1 边界：已是 organization 罐的 view 不被 notifyOrganizationResolverChanged 迁移（切 organization 迁移属 ）', () => {
    installBrowserEnvMock(null)
    setOrganizationIdResolver(() => 'wt-acme')
    const { actions, state } = createTestStore()

    // 直接落 organization 罐
    const tab = actions.createWorkspace({ spaceId: 'space-A', profile: 'background-task' })
    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:organization:wt-acme:browser')

    // 切到另一个 organization 并补通知 —— 升级 gate 只认 tabtin:env:*，organization 罐不被迁移
    setOrganizationIdResolver(() => 'wt-other')
    notifyOrganizationResolverChanged()

    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:organization:wt-acme:browser')
  })

  it('用户改绑定 (onChanged) → 已打开 workspace 的 partition 自动升级', async () => {
    const env = installBrowserEnvMock({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })
    const { actions, state } = createTestStore()
    await new Promise((r) => setTimeout(r, 0))

    const tab = actions.createWorkspace({ spaceId: 'space-A', profile: 'background-task' })
    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:env:personal')

    // 用户改绑定：space-A 改绑到 shared
    env.setSnapshot({
      success: true,
      environments: [
        makeEnv('default', 'tabtin:env:default', true),
        makeEnv('personal', 'tabtin:env:personal'),
        makeEnv('shared', 'tabtin:env:shared'),
      ],
      bindings: [{ space_id: 'space-A', environment_id: 'shared', is_explicit: true }],
    })
    env.fireChange({ reason: 'bound', spaceId: 'space-A' })
    await new Promise((r) => setTimeout(r, 0))

    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:env:shared')
  })

  it('显式 config.partition 优先于镜像查询', async () => {
    installBrowserEnvMock({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })
    const { actions, state } = createTestStore()
    await new Promise((r) => setTimeout(r, 0))

    const tab = actions.createWorkspace({
      spaceId: 'space-A',
      partition: 'tabtin:env:explicit',
      profile: 'background-task',
    })
    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:env:explicit')
  })

  it('legacy `tabtin:crawlspace:*` partition 不被识别为 env 系列 → 不会被偷偷升级', async () => {
    const env = installBrowserEnvMock({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })
    const { actions, state } = createTestStore()
    await new Promise((r) => setTimeout(r, 0))

    const legacyTab = actions.createWorkspace({
      spaceId: 'space-A',
      partition: 'tabtin:crawlspace:space-A',
      crawlspaceId: 'cs-legacy',
      profile: 'background-task',
    })
    // 触发一次 onChanged，确保 listener 跑过
    env.fireChange({ reason: 'manual-refresh' })
    await new Promise((r) => setTimeout(r, 0))

    expect(state().crawlspaceConfigById[legacyTab.id].partition).toBe('tabtin:crawlspace:space-A')
  })

  it('BR-29：命名 session（sessionName）→ 独立隔离 partition，绝不落 env partition', async () => {
    // 即便 space-A 显式绑定到 personal env，命名 session 也不能用 env partition。
    installBrowserEnvMock({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })
    const { actions, state } = createTestStore()
    await new Promise((r) => setTimeout(r, 0))

    const tab = actions.createWorkspace({
      spaceId: 'space-A',
      sessionName: 'cookie-test',
      crawlspaceId: 'cs-session-spaceA-cookie-test',
      profile: 'background-task',
    })
    const partition = state().crawlspaceConfigById[tab.id].partition
    expect(partition).toBe(buildSessionPartition('cs-session-spaceA-cookie-test'))
    expect(partition).not.toBe(DEFAULT_ENV_PARTITION)
    expect(partition).not.toBe('tabtin:env:personal')
  })

  it('BR-29：命名 session 的 partition 不被镜像升级 listener 偷偷换回 env partition', async () => {
    const env = installBrowserEnvMock({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })
    const { actions, state } = createTestStore()
    await new Promise((r) => setTimeout(r, 0))

    const tab = actions.createWorkspace({
      spaceId: 'space-A',
      sessionName: 'cookie-test',
      crawlspaceId: 'cs-session-spaceA-cookie-test',
      profile: 'background-task',
    })
    const expectedPartition = buildSessionPartition('cs-session-spaceA-cookie-test')
    expect(state().crawlspaceConfigById[tab.id].partition).toBe(expectedPartition)

    // 用户改绑定触发 onChanged —— session partition 必须岿然不动（非 env 前缀）。
    env.setSnapshot({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('shared', 'tabtin:env:shared')],
      bindings: [{ space_id: 'space-A', environment_id: 'shared', is_explicit: true }],
    })
    env.fireChange({ reason: 'bound', spaceId: 'space-A' })
    await new Promise((r) => setTimeout(r, 0))

    expect(state().crawlspaceConfigById[tab.id].partition).toBe(expectedPartition)
    const wsTab = state().tabs.find((t) => t.id === tab.id)
    expect(wsTab?.metadata?.crawlspaceConfig?.partition).toBe(expectedPartition)
  })

  it('无 spaceId 且无显式 partition → throw（硬守不可达路径）', () => {
    installBrowserEnvMock(null)
    const { actions } = createTestStore()
    expect(() => {
      actions.createWorkspace({
        profile: 'background-task',
      } as any)
    }).toThrow(/createWorkspaceMissingSpaceOrPartition/)
  })

  it('无 spaceId 但有显式 partition → 正常创建', () => {
    installBrowserEnvMock(null)
    const { actions, state } = createTestStore()

    const tab = actions.createWorkspace({
      profile: 'background-task',
      partition: 'tabtin:env:explicit-anonymous',
    } as any)
    expect(state().crawlspaceConfigById[tab.id].partition).toBe('tabtin:env:explicit-anonymous')
  })

  it('Phase3b：同 Space 的不同 browser scope 使用不同 crawlspace carrier，但共享 organization cookie', () => {
    installBrowserEnvMock(null)
    setOrganizationIdResolver(() => 'wt-acme')
    const { actions, state } = createTestStore()

    const desktop = actions.ensureScopedCrawlspace(
      'space-A',
      'desktop:organization:wt-acme:user:u-1',
      { title: 'Desktop' },
    )
    const conversation = actions.ensureScopedCrawlspace(
      'space-A',
      'conversation:session-1',
      { title: 'Conversation' },
    )

    expect(desktop.id).not.toBe(conversation.id)
    expect(desktop.metadata?.crawlspaceConfig?.browserScopeKey).toBe('desktop:organization:wt-acme:user:u-1')
    expect(conversation.metadata?.crawlspaceConfig?.browserScopeKey).toBe('conversation:session-1')
    expect(state().crawlspaceConfigById[desktop.id].spaceId).toBe('space-A')
    expect(state().crawlspaceConfigById[conversation.id].spaceId).toBe('space-A')
    expect(state().crawlspaceConfigById[desktop.id].partition).toBe('tabtin:organization:wt-acme:browser')
    expect(state().crawlspaceConfigById[conversation.id].partition).toBe('tabtin:organization:wt-acme:browser')
    expect(actions.ensureScopedCrawlspace('space-A', 'conversation:session-1').id).toBe(conversation.id)
  })

  it('clearAll 清状态后 listener 重装 —— 后续 onChanged 仍能升级 partition', async () => {
    const env = installBrowserEnvMock({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true)],
      bindings: [],
    })
    const { actions, state } = createTestStore()
    await new Promise((r) => setTimeout(r, 0))

    actions.createWorkspace({ spaceId: 'space-A', profile: 'background-task' })

    actions.clearAll()
    expect(state().tabs).toHaveLength(0)

    // clearAll 后再创建一个 workspace，配上 personal env 绑定，确认 listener 升级路径仍工作
    const tab2 = actions.createWorkspace({ spaceId: 'space-A', profile: 'background-task', crawlspaceId: 'cs-new' })
    expect(state().crawlspaceConfigById[tab2.id].partition).toBe(DEFAULT_ENV_PARTITION)

    env.setSnapshot({
      success: true,
      environments: [makeEnv('default', 'tabtin:env:default', true), makeEnv('personal', 'tabtin:env:personal')],
      bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
    })
    env.fireChange({ reason: 'bound', spaceId: 'space-A' })
    await new Promise((r) => setTimeout(r, 0))

    expect(state().crawlspaceConfigById[tab2.id].partition).toBe('tabtin:env:personal')
  })

  it('把 draft crawlspace 原样改绑到正式 conversation scope', () => {
    const { actions, state } = createTestStore()
    const tab = actions.createWorkspace({
      crawlspaceId: 'cs-draft',
      spaceId: 'space-1',
      browserScopeKey: 'conversation:draft:space-1',
      profile: 'background-task',
    })

    expect(actions.rehomeScopedCrawlspace(
      'conversation:draft:space-1',
      'conversation:session-1',
    )).toBe(tab.id)
    expect(state().crawlspaceConfigById[tab.id].browserScopeKey).toBe('conversation:session-1')
    expect(state().tabs.find(item => item.id === tab.id)?.metadata?.crawlspaceConfig?.browserScopeKey)
      .toBe('conversation:session-1')
    expect(actions.getScopedCrawlspace('conversation:draft:space-1')).toBeNull()
    expect(actions.getScopedCrawlspace('conversation:session-1')?.id).toBe(tab.id)
  })

  it('target scope 已有不同 crawlspace 时不覆盖任何 Browser 归属', () => {
    const { actions, state } = createTestStore()
    actions.createWorkspace({ crawlspaceId: 'cs-draft', spaceId: 'space-1', browserScopeKey: 'conversation:draft:space-1', profile: 'background-task' })
    actions.createWorkspace({ crawlspaceId: 'cs-target', spaceId: 'space-1', browserScopeKey: 'conversation:session-1', profile: 'background-task' })

    expect(actions.rehomeScopedCrawlspace('conversation:draft:space-1', 'conversation:session-1')).toBeNull()
    expect(state().crawlspaceConfigById['cs-draft'].browserScopeKey).toBe('conversation:draft:space-1')
  })
})
