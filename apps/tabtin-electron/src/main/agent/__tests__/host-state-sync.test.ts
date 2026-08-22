import { describe, expect, it, vi } from 'vitest'
import { HostTurnStore } from '../../../../../../packages/agent-host/src/policy/index'
import { HostStateSync } from '../host-state-sync'

const context = {
  organizationId: 'o1',
  organizationDetail: { id: 'o1', name: 'Organization' },
  agentDetail: {
    id: 'a1',
    organization_id: 'o1',
    agent_config: { schema_version: 3, security: {} },
    organization_allow_member_yolo: false,
  },
  workspaceDetail: {
    id: 'w1',
    organization_id: 'o1',
    working_dir: '/tmp/w1',
    working_dir_type: 'code',
    approval_grant: 'always_ask' as const,
    device_id: 'device-1',
  },
  runtimeConfig: {
    operationSwitches: {},
    memoryCapability: true,
    enabledApps: [],
  },
}

describe('HostStateSync', () => {
  it('启动、失效通知和重连都由 Host 主动拉取权威状态', async () => {
    const turn = new HostTurnStore()
    let invalidate: ((invalidatesBindings: boolean) => void) | undefined
    let reconnect: (() => void) | undefined
    const fetchSnapshots = vi.fn()
      .mockResolvedValueOnce({ contexts: [context] })
      .mockResolvedValueOnce({ contexts: [{
        ...context,
        agentDetail: { ...context.agentDetail, custom_rules: '更新后规则' },
      }] })
      .mockResolvedValue({ contexts: [context] })
    const afterReconcile = vi.fn()
    const sync = new HostStateSync({
      turnStore: () => turn,
      fetchSnapshots,
      subscribeInvalidation: listener => {
        invalidate = listener
        return vi.fn()
      },
      subscribeReconnect: listener => {
        reconnect = listener
        return vi.fn()
      },
      intervalMs: 60_000,
      afterReconcile,
    })

    sync.start()
    await sync.reconcile()
    expect(fetchSnapshots).toHaveBeenCalledTimes(1)
    expect(afterReconcile).toHaveBeenCalledWith([context])
    expect(turn.canCompose('a1', 'w1')).toBe(true)
    expect(turn.areExecutionBindingsReady()).toBe(true)

    invalidate?.(true)
    expect(turn.areExecutionBindingsReady()).toBe(false)
    await vi.waitFor(() => {
      expect(fetchSnapshots).toHaveBeenCalledTimes(2)
      expect(turn.compose('a1', 'w1')?.profile.customRules).toBe('更新后规则')
    })
    expect(turn.areExecutionBindingsReady()).toBe(true)
    expect(turn.compose('a1', 'w1')?.profile.customRules).toBe('更新后规则')

    reconnect?.()
    expect(turn.areExecutionBindingsReady()).toBe(false)
    await vi.waitFor(() => {
      expect(fetchSnapshots).toHaveBeenCalledTimes(3)
      expect(turn.compose('a1', 'w1')?.profile.customRules).toBeUndefined()
    })
    sync.stop()
  })

  it('并发刷新只发起一次接口请求', async () => {
    let resolveFetch: ((value: { contexts: typeof context[] }) => void) | undefined
    const fetchSnapshots = vi.fn(() => new Promise<{ contexts: typeof context[] }>((resolve) => {
      resolveFetch = resolve
    }))
    const sync = new HostStateSync({
      turnStore: () => new HostTurnStore(),
      fetchSnapshots,
      subscribeInvalidation: () => vi.fn(),
      subscribeReconnect: () => vi.fn(),
    })

    const first = sync.reconcile()
    const second = sync.reconcile()
    expect(first).toBe(second)
    expect(fetchSnapshots).toHaveBeenCalledTimes(1)
    resolveFetch?.({ contexts: [] })
    await expect(first).resolves.toBe(true)
  })

  it('对账失败返回 false 且保留上一份完整状态', async () => {
    const turn = new HostTurnStore()
    turn.replaceSnapshots([context])
    const sync = new HostStateSync({
      turnStore: () => turn,
      fetchSnapshots: vi.fn().mockRejectedValue(new Error('offline')),
      subscribeInvalidation: () => vi.fn(),
      subscribeReconnect: () => vi.fn(),
      logger: { warn: vi.fn() },
    })

    await expect(sync.reconcile()).resolves.toBe(false)
    expect(turn.canCompose('a1', 'w1')).toBe(true)
    expect(turn.areExecutionBindingsReady()).toBe(true)
  })

  it('拉取进行中收到失效通知会在完成后再对账一次', async () => {
    let invalidate: ((invalidatesBindings: boolean) => void) | undefined
    let resolveFirst: ((value: { contexts: typeof context[] }) => void) | undefined
    let resolveSecond: ((value: { contexts: typeof context[] }) => void) | undefined
    const turn = new HostTurnStore()
    const fetchSnapshots = vi.fn()
      .mockImplementationOnce(() => new Promise<{ contexts: typeof context[] }>((resolve) => {
        resolveFirst = resolve
      }))
      .mockImplementationOnce(() => new Promise<{ contexts: typeof context[] }>((resolve) => {
        resolveSecond = resolve
      }))
    const sync = new HostStateSync({
      turnStore: () => turn,
      fetchSnapshots,
      subscribeInvalidation: listener => {
        invalidate = listener
        return vi.fn()
      },
      subscribeReconnect: () => vi.fn(),
    })

    sync.start()
    invalidate?.(true)
    resolveFirst?.({ contexts: [] })

    await vi.waitFor(() => expect(fetchSnapshots).toHaveBeenCalledTimes(2))
    expect(turn.areExecutionBindingsReady()).toBe(false)
    resolveSecond?.({ contexts: [context] })
    await vi.waitFor(() => expect(turn.areExecutionBindingsReady()).toBe(true))
    sync.stop()
  })

  it('注册完成立即对账，不等待周期定时器', async () => {
    let registered: (() => void | Promise<boolean>) | undefined
    const turn = new HostTurnStore()
    const fetchSnapshots = vi.fn()
      .mockRejectedValueOnce(new Error('device not registered'))
      .mockResolvedValueOnce({ contexts: [context] })
    const sync = new HostStateSync({
      turnStore: () => turn,
      fetchSnapshots,
      subscribeInvalidation: () => vi.fn(),
      subscribeReconnect: () => vi.fn(),
      subscribeRegistration: listener => {
        registered = listener
        return vi.fn()
      },
    })

    sync.start()
    await sync.reconcile()
    expect(turn.areExecutionBindingsReady()).toBe(false)
    registered?.()
    await vi.waitFor(() => expect(fetchSnapshots).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(turn.areExecutionBindingsReady()).toBe(true))
    sync.stop()
  })

  it('内容失效只刷新快照，不提前废弃已验证的执行绑定', async () => {
    let invalidate: ((invalidatesBindings: boolean) => void) | undefined
    const turn = new HostTurnStore()
    turn.replaceSnapshots([context])
    const sync = new HostStateSync({
      turnStore: () => turn,
      fetchSnapshots: vi.fn().mockResolvedValue({ contexts: [context] }),
      subscribeInvalidation: listener => {
        invalidate = listener
        return vi.fn()
      },
      subscribeReconnect: () => vi.fn(),
    })

    sync.start()
    await sync.reconcile()
    invalidate?.(false)
    expect(turn.areExecutionBindingsReady()).toBe(true)
    sync.stop()
  })
})
