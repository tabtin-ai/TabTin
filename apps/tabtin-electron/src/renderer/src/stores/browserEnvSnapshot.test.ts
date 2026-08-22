/**
 * BrowserEnv renderer 镜像快照单测。
 *
 * 覆盖契约：
 *   1. mirror 未启动 → `getPartitionForSpaceSync` 返回默认 env partition
 *   2. mirror 启动并加载完成 → 返回正确绑定 partition / 默认 env partition
 *   3. listener 在镜像变更时被通知
 *   4. `refreshFromIpc` 失败时设置 `lastError` + 仍通知 listener
 *   5. 启动期失败 + 5s retry 成功 → 镜像就绪
 *   6. orphan binding 触发 `console.warn`（去重：同一 envId 只 warn 一次）
 *   7. `browser-env:changed` 事件触发 mirror 全量刷新
 *   8. `getPartitionStatus` 三态语义（ready / isExplicit）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_ENV_PARTITION,
  __getBrowserEnvSnapshotForTests,
  __resetBrowserEnvSnapshotForTests,
  ensureBrowserEnvSnapshotStarted,
  getPartitionForSpaceSync,
  getPartitionStatus,
  getOrganizationBrowserPartition,
  isMirrorReady,
  notifyOrganizationResolverChanged,
  setOrganizationIdResolver,
  subscribeBrowserEnvSnapshot,
} from './browserEnvSnapshot'

interface MockEnv {
  id: string
  name: string
  partition_key: string
  is_default: boolean
  binding_count: number
  explicit_binding_count: number
  using_space_count: number
  created_at: string
  updated_at: string
}

interface MockBinding {
  space_id: string
  environment_id: string
  is_explicit: boolean
}

interface MockListResult {
  success: true
  environments: MockEnv[]
  bindings: MockBinding[]
}

function makeEnv(id: string, partition_key: string, isDefault = false): MockEnv {
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

function installBrowserEnvMock(opts: {
  /** 顺序消费的 list() 响应；每次 list 调用消耗一个,用尽后保持最后一个。 */
  listResults?: Array<MockListResult | { success: false; error?: string }>
  /** list 同时抛错(覆盖 listResults)。 */
  listThrows?: Error[]
  /** 完全没有 IPC API(模拟 preload 未注入)。 */
  unavailable?: boolean
}) {
  const listResults = opts.listResults ?? []
  const listThrows = opts.listThrows ?? []
  let listCallCount = 0
  let changeHandler: ((payload: any) => void) | null = null

  const listFn = vi.fn().mockImplementation(async () => {
    const idx = listCallCount++
    if (idx < listThrows.length && listThrows[idx]) {
      throw listThrows[idx]
    }
    if (listResults.length === 0) {
      return { success: true, environments: [], bindings: [] }
    }
    return listResults[Math.min(idx, listResults.length - 1)]
  })

  const onChangedFn = vi.fn().mockImplementation((cb: any) => {
    changeHandler = cb
    return () => {
      changeHandler = null
    }
  })

  if (opts.unavailable) {
    ;(globalThis as any).window = { tabtin: {} }
  } else {
    ;(globalThis as any).window = {
      tabtin: { browserEnv: { list: listFn, onChanged: onChangedFn } },
    }
  }

  return {
    list: listFn,
    onChanged: onChangedFn,
    fireChange: (payload: { reason: string; spaceId?: string }) => changeHandler?.(payload),
    getListCallCount: () => listCallCount,
  }
}

describe('browserEnvSnapshot', () => {
  beforeEach(() => {
    __resetBrowserEnvSnapshotForTests()
    delete (globalThis as any).window
    vi.useRealTimers()
  })

  afterEach(() => {
    __resetBrowserEnvSnapshotForTests()
    delete (globalThis as any).window
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('镜像未启动 → getPartitionForSpaceSync 返回默认 env partition', () => {
    // 不安装 window.tabtin —— 镜像懒启动时拿不到 IPC,但仍立即返回默认 partition
    expect(getPartitionForSpaceSync('space-A')).toBe(DEFAULT_ENV_PARTITION)
    expect(getPartitionForSpaceSync(null)).toBe(DEFAULT_ENV_PARTITION)
    expect(getPartitionForSpaceSync(undefined)).toBe(DEFAULT_ENV_PARTITION)
    expect(getPartitionForSpaceSync('')).toBe(DEFAULT_ENV_PARTITION)
  })

  it('镜像启动后 → 返回绑定 partition / 默认 env partition', async () => {
    installBrowserEnvMock({
      listResults: [
        {
          success: true,
          environments: [
            makeEnv('default', 'tabtin:env:default', true),
            makeEnv('personal', 'tabtin:env:personal'),
          ],
          bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
        },
      ],
    })

    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))

    expect(getPartitionForSpaceSync('space-A')).toBe('tabtin:env:personal')
    // 没绑定的 Space 走默认 env
    expect(getPartitionForSpaceSync('space-B')).toBe(DEFAULT_ENV_PARTITION)
    expect(isMirrorReady()).toBe(true)
  })

  it('listener 在镜像变更时被通知', async () => {
    const env = installBrowserEnvMock({
      listResults: [
        {
          success: true,
          environments: [makeEnv('default', 'tabtin:env:default', true)],
          bindings: [],
        },
        {
          success: true,
          environments: [
            makeEnv('default', 'tabtin:env:default', true),
            makeEnv('work', 'tabtin:env:work'),
          ],
          bindings: [{ space_id: 'space-A', environment_id: 'work', is_explicit: true }],
        },
      ],
    })

    const listener = vi.fn()
    subscribeBrowserEnvSnapshot(listener)
    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getPartitionForSpaceSync('space-A')).toBe(DEFAULT_ENV_PARTITION)

    env.fireChange({ reason: 'bound', spaceId: 'space-A' })
    await new Promise((r) => setTimeout(r, 0))

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getPartitionForSpaceSync('space-A')).toBe('tabtin:env:work')
  })

  it('refreshFromIpc 失败时 lastError 被设置 + listener 仍被通知', async () => {
    installBrowserEnvMock({
      listThrows: [new Error('ipc crashed')],
    })

    const listener = vi.fn()
    subscribeBrowserEnvSnapshot(listener)
    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))

    expect(listener).toHaveBeenCalledTimes(1)
    const snap = __getBrowserEnvSnapshotForTests()
    expect(snap.ready).toBe(false)
    expect(snap.lastError).toBe('ipc crashed')
    // 失败后调用方仍能拿到默认 partition,不阻塞
    expect(getPartitionForSpaceSync('space-A')).toBe(DEFAULT_ENV_PARTITION)
  })

  it('list 返回 success:false 时设置 lastError + 通知 listener', async () => {
    installBrowserEnvMock({
      listResults: [{ success: false, error: 'BACKEND_DOWN' }],
    })

    const listener = vi.fn()
    subscribeBrowserEnvSnapshot(listener)
    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))

    expect(listener).toHaveBeenCalledTimes(1)
    const snap = __getBrowserEnvSnapshotForTests()
    expect(snap.ready).toBe(false)
    expect(snap.lastError).toBe('BACKEND_DOWN')
  })

  it('启动期失败 → 5s retry 成功后镜像就绪', async () => {
    vi.useFakeTimers()
    installBrowserEnvMock({
      listThrows: [new Error('first call fails')],
      listResults: [
        // listThrows[0] 处理第 1 次 list
        // 第 2 次起读 listResults
        {
          success: true,
          environments: [
            makeEnv('default', 'tabtin:env:default', true),
            makeEnv('shared', 'tabtin:env:shared'),
          ],
          bindings: [{ space_id: 'space-A', environment_id: 'shared', is_explicit: true }],
        },
      ],
    })

    ensureBrowserEnvSnapshotStarted()
    // 等首次 IPC 抛错完成
    await vi.advanceTimersByTimeAsync(0)
    expect(__getBrowserEnvSnapshotForTests().ready).toBe(false)
    expect(__getBrowserEnvSnapshotForTests().lastError).toBe('first call fails')

    // 推进 5s 触发 retry
    await vi.advanceTimersByTimeAsync(5_000)
    // retry 内部 await 完成
    await vi.advanceTimersByTimeAsync(0)

    expect(__getBrowserEnvSnapshotForTests().ready).toBe(true)
    expect(__getBrowserEnvSnapshotForTests().lastError).toBeNull()
    expect(getPartitionForSpaceSync('space-A')).toBe('tabtin:env:shared')
  })

  it('orphan binding 触发 console.warn,同一 environment_id 只 warn 一次', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const env = installBrowserEnvMock({
      listResults: [
        {
          success: true,
          environments: [makeEnv('default', 'tabtin:env:default', true)],
          // 两条 binding 指向同一个不存在的 env 'ghost'
          bindings: [
            { space_id: 'space-A', environment_id: 'ghost', is_explicit: true },
            { space_id: 'space-B', environment_id: 'ghost', is_explicit: true },
          ],
        },
        // 二次 refresh 仍包含同一个 ghost binding,不应重复 warn
        {
          success: true,
          environments: [makeEnv('default', 'tabtin:env:default', true)],
          bindings: [
            { space_id: 'space-A', environment_id: 'ghost', is_explicit: true },
          ],
        },
      ],
    })

    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))

    const orphanWarnings = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('orphan binding'),
    )
    expect(orphanWarnings.length).toBe(1)
    expect(orphanWarnings[0][1]).toMatchObject({ environment_id: 'ghost' })

    // 二次 refresh —— 同一 ghost env_id 不应再 warn
    env.fireChange({ reason: 'manual-refresh' })
    await new Promise((r) => setTimeout(r, 0))

    const orphanWarningsAfter = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('orphan binding'),
    )
    expect(orphanWarningsAfter.length).toBe(1)

    // 两个空 binding 都被丢弃 —— space-A / space-B 都拿默认 env partition
    expect(getPartitionForSpaceSync('space-A')).toBe(DEFAULT_ENV_PARTITION)
    expect(getPartitionForSpaceSync('space-B')).toBe(DEFAULT_ENV_PARTITION)
  })

  it('browser-env:changed 事件触发 mirror 全量刷新', async () => {
    const env = installBrowserEnvMock({
      listResults: [
        {
          success: true,
          environments: [makeEnv('default', 'tabtin:env:default', true)],
          bindings: [],
        },
      ],
    })

    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))
    expect(env.list).toHaveBeenCalledTimes(1)

    env.fireChange({ reason: 'created', environmentId: 'foo' })
    await new Promise((r) => setTimeout(r, 0))
    expect(env.list).toHaveBeenCalledTimes(2)

    env.fireChange({ reason: 'manual-refresh' })
    await new Promise((r) => setTimeout(r, 0))
    expect(env.list).toHaveBeenCalledTimes(3)
  })

  it('getPartitionStatus 三态语义：ready / isExplicit', async () => {
    // 阶段 1: install mock + 启动镜像，但 list() 是异步的，同步立即查时
    // ready 仍是 false（list promise 未 resolve）
    installBrowserEnvMock({
      listResults: [
        {
          success: true,
          environments: [
            makeEnv('default', 'tabtin:env:default', true),
            makeEnv('personal', 'tabtin:env:personal'),
          ],
          bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
        },
      ],
    })
    ensureBrowserEnvSnapshotStarted()

    // list promise 尚未 resolve → ready=false 是镜像启动期 fallback 行为
    let status = getPartitionStatus('space-A')
    expect(status).toEqual({
      partition: DEFAULT_ENV_PARTITION,
      ready: false,
      isExplicit: false,
    })

    // 阶段 2: 等 list 完成
    await new Promise((r) => setTimeout(r, 0))

    // 已就绪 + 显式绑定
    status = getPartitionStatus('space-A')
    expect(status).toEqual({
      partition: 'tabtin:env:personal',
      ready: true,
      isExplicit: true,
    })

    // 已就绪 + 无绑定 → fallback default + isExplicit=false
    status = getPartitionStatus('space-unbound')
    expect(status).toEqual({
      partition: DEFAULT_ENV_PARTITION,
      ready: true,
      isExplicit: false,
    })

    // 已就绪 + 空 spaceId → 默认 + 不算显式
    status = getPartitionStatus(null)
    expect(status).toEqual({
      partition: DEFAULT_ENV_PARTITION,
      ready: true,
      isExplicit: false,
    })
  })

  it('IPC 不可用（preload 未注入）→ 设置 lastError + scheduleRetry', async () => {
    vi.useFakeTimers()
    // 不设置 window.tabtin.browserEnv
    ;(globalThis as any).window = { tabtin: {} }

    const listener = vi.fn()
    subscribeBrowserEnvSnapshot(listener)
    ensureBrowserEnvSnapshotStarted()
    await vi.advanceTimersByTimeAsync(0)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(__getBrowserEnvSnapshotForTests().lastError).toBe('browser-env IPC unavailable')

    // 5s 后 retry —— 这次注入正常 IPC
    installBrowserEnvMock({
      listResults: [
        {
          success: true,
          environments: [makeEnv('default', 'tabtin:env:default', true)],
          bindings: [],
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(__getBrowserEnvSnapshotForTests().ready).toBe(true)
    expect(__getBrowserEnvSnapshotForTests().lastError).toBeNull()
  })

  describe('Organization 级浏览器 partition（边界改造 Phase 3a）', () => {
    it('注入 organization 解析器后，无显式绑定的 Space 走 organization 共享罐', async () => {
      installBrowserEnvMock({
        listResults: [
          {
            success: true,
            environments: [makeEnv('default', 'tabtin:env:default', true)],
            bindings: [],
          },
        ],
      })
      setOrganizationIdResolver(() => 'wt-acme')
      ensureBrowserEnvSnapshotStarted()
      await new Promise((r) => setTimeout(r, 0))

      expect(getOrganizationBrowserPartition()).toBe('tabtin:organization:wt-acme:browser')
      expect(getPartitionForSpaceSync('space-unbound')).toBe('tabtin:organization:wt-acme:browser')
      expect(getPartitionForSpaceSync(null)).toBe('tabtin:organization:wt-acme:browser')

      const status = getPartitionStatus('space-unbound')
      expect(status.partition).toBe('tabtin:organization:wt-acme:browser')
      // 走 organization 共享罐 ≠ 显式独立 env 绑定
      expect(status.isExplicit).toBe(false)
    })

    it('显式 env 绑定优先于 organization 罐', async () => {
      installBrowserEnvMock({
        listResults: [
          {
            success: true,
            environments: [
              makeEnv('default', 'tabtin:env:default', true),
              makeEnv('personal', 'tabtin:env:personal'),
            ],
            bindings: [{ space_id: 'space-A', environment_id: 'personal', is_explicit: true }],
          },
        ],
      })
      setOrganizationIdResolver(() => 'wt-acme')
      ensureBrowserEnvSnapshotStarted()
      await new Promise((r) => setTimeout(r, 0))

      // 绑定的 Space 仍用独立 env，未绑定的走 organization 罐
      expect(getPartitionForSpaceSync('space-A')).toBe('tabtin:env:personal')
      expect(getPartitionForSpaceSync('space-B')).toBe('tabtin:organization:wt-acme:browser')
    })

    it('解析器返回空 / 抛错 → 回落默认 env partition', () => {
      setOrganizationIdResolver(() => null)
      expect(getOrganizationBrowserPartition()).toBe(DEFAULT_ENV_PARTITION)

      setOrganizationIdResolver(() => {
        throw new Error('boom')
      })
      expect(getOrganizationBrowserPartition()).toBe(DEFAULT_ENV_PARTITION)
      expect(getPartitionForSpaceSync('space-X')).toBe(DEFAULT_ENV_PARTITION)
    })

    it('未注入解析器（默认）→ 维持默认 env partition 行为', () => {
      expect(getOrganizationBrowserPartition()).toBe(DEFAULT_ENV_PARTITION)
      expect(getPartitionForSpaceSync('space-Y')).toBe(DEFAULT_ENV_PARTITION)
    })

    it('notifyOrganizationResolverChanged 同步触发 subscribeBrowserEnvSnapshot 订阅者（review P1 升级通道）', () => {
      const listener = vi.fn()
      subscribeBrowserEnvSnapshot(listener)
      expect(listener).not.toHaveBeenCalled()
      notifyOrganizationResolverChanged()
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
})
