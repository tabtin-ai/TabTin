/**
 * CR-018 回归测试：registerForCreate 中 Organization 注册失败时
 * 应补偿回滚 RunSession，防止幽灵条目残留。
 */

import { describe, it, expect, vi } from 'vitest'
import { ViewRegistrationCoordinator } from '../ViewRegistrationCoordinator'
import type { RegistrationContext } from '../ViewRegistrationCoordinator'
import type { ViewEntry } from '../../types'

function makeState(id = 'v-test'): ViewEntry {
  return {
    id,
    view: {} as any,
    profile: 'user-tab',
    config: {
      id,
      profile: 'user-tab',
      runId: 'run-1',
      metadata: { crawlspaceId: 'cs-1' },
    } as any,
    createdAt: Date.now(),
    attachedToMainWindow: false,
    tabNotified: false,
    registrations: {},
  }
}

function makeContext(overrides?: Partial<RegistrationContext>): RegistrationContext {
  return {
    registerRunSession: vi.fn().mockResolvedValue(undefined),
    registerWorkspace: vi.fn().mockResolvedValue(undefined),
    registerCdpManager: vi.fn().mockResolvedValue(undefined),
    registerResourceManager: vi.fn().mockResolvedValue(undefined),
    registerResourceDetection: vi.fn(),
    unregisterRunSession: vi.fn(),
    unregisterWorkspace: vi.fn(),
    unregisterViewStateRegistry: vi.fn(),
    unregisterCdpManager: vi.fn().mockResolvedValue(undefined),
    unregisterResourceManager: vi.fn().mockResolvedValue(undefined),
    unregisterResourceDetection: vi.fn(),
    unregisterViewPageRegistry: vi.fn(),
    reconcileState: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    ...overrides,
  }
}

describe('CR-018: registerForCreate 补偿回滚', () => {
  it('Organization 注册失败时应回滚 RunSession', async () => {
    const ctx = makeContext({
      registerWorkspace: vi.fn().mockRejectedValue(new Error('workspace 注册失败')),
    })
    const coordinator = new ViewRegistrationCoordinator(ctx)
    const state = makeState()

    await expect(coordinator.registerForCreate(state)).rejects.toThrow('workspace 注册失败')

    expect(ctx.registerRunSession).toHaveBeenCalledOnce()
    expect(ctx.unregisterRunSession).toHaveBeenCalledWith(state)
  })

  it('RunSession 和 Organization 都成功时不触发回滚', async () => {
    const ctx = makeContext()
    const coordinator = new ViewRegistrationCoordinator(ctx)
    const state = makeState()

    await coordinator.registerForCreate(state)

    expect(ctx.registerRunSession).toHaveBeenCalledOnce()
    expect(ctx.registerWorkspace).toHaveBeenCalledOnce()
    expect(ctx.unregisterRunSession).not.toHaveBeenCalled()
  })

  it('RunSession 回滚自身失败时仍抛出原始错误', async () => {
    const ctx = makeContext({
      registerWorkspace: vi.fn().mockRejectedValue(new Error('workspace 失败')),
      unregisterRunSession: vi.fn().mockImplementation(() => {
        throw new Error('回滚也失败了')
      }),
    })
    const coordinator = new ViewRegistrationCoordinator(ctx)
    const state = makeState()

    await expect(coordinator.registerForCreate(state)).rejects.toThrow('workspace 失败')

    expect(ctx.unregisterRunSession).toHaveBeenCalledWith(state)
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining('RunSession 补偿回滚失败'),
      expect.objectContaining({ id: state.id }),
    )
  })

  it('RunSession 注册失败时不调用 Organization 注册', async () => {
    const ctx = makeContext({
      registerRunSession: vi.fn().mockRejectedValue(new Error('RunSession 失败')),
    })
    const coordinator = new ViewRegistrationCoordinator(ctx)
    const state = makeState()

    await expect(coordinator.registerForCreate(state)).rejects.toThrow('RunSession 失败')

    expect(ctx.registerWorkspace).not.toHaveBeenCalled()
    expect(ctx.unregisterRunSession).not.toHaveBeenCalled()
  })
})
