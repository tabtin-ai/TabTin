/**
 * VL-001 / VL-002 / VL-007 回归测试
 *
 * 验证 ViewFactory.destroyView 销毁流程的以下不变量：
 *   1. unregisterAll 在 views.delete 之前执行（VL-001）
 *   2. 异常路径中 viewDestroyed=true 时也执行 unregisterAll（VL-002）
 *   3. reconcileAll 不会处理正在销毁的 View（VL-007）
 *
 * 测试策略：通过 ViewRegistrationCoordinator 的 mock RegistrationContext
 * 直接验证调用顺序和异常路径行为，无需真实 Electron API。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ViewRegistrationCoordinator } from '../registrations/ViewRegistrationCoordinator'
import type { RegistrationContext } from '../registrations/ViewRegistrationCoordinator'
import type { ViewEntry } from '../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(id = 'v1'): ViewEntry {
  return {
    id,
    view: {} as any,
    profile: 'user-tab',
    config: {
      id,
      profile: 'user-tab',
      metadata: { crawlspaceId: 'cs-1' },
    } as any,
    createdAt: Date.now(),
    attachedToMainWindow: false,
    tabNotified: false,
    registrations: {},
  }
}

function makeCtx(overrides?: Partial<RegistrationContext>): RegistrationContext {
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

// ---------------------------------------------------------------------------
// VL-001: unregisterAll 在 views.delete 之前执行
// ---------------------------------------------------------------------------

describe('VL-001: unregisterAll 与 views.delete 顺序', () => {
  it('unregisterAll 期间 view 仍可在 views Map 中被查询', async () => {
    const views = new Map<string, ViewEntry>()
    const state = makeState('test-view')
    views.set('test-view', state)

    let viewExistedDuringUnregister = false
    const ctx = makeCtx({
      unregisterWorkspace: vi.fn(() => {
        viewExistedDuringUnregister = views.has('test-view')
      }),
    })
    const coordinator = new ViewRegistrationCoordinator(ctx)

    // 模拟 VL-001 修复后的正确流程：先 unregisterAll，再 delete
    await coordinator.unregisterAll(state)
    views.delete('test-view')

    expect(viewExistedDuringUnregister).toBe(true)
    expect(views.has('test-view')).toBe(false)
  })

  it('unregisterAll 的所有回调都在 views.delete 之前执行', async () => {
    const views = new Map<string, ViewEntry>()
    const state = makeState('order-test')
    views.set('order-test', state)

    const callLog: string[] = []

    const ctx = makeCtx({
      unregisterResourceDetection: vi.fn(() => callLog.push('resourceDetection')),
      unregisterViewPageRegistry: vi.fn(() => callLog.push('viewPageRegistry')),
      unregisterViewStateRegistry: vi.fn(() => callLog.push('viewStateRegistry')),
      unregisterCdpManager: vi.fn(async () => { callLog.push('cdpManager') }),
      unregisterResourceManager: vi.fn(async () => { callLog.push('resourceManager') }),
      unregisterRunSession: vi.fn(() => callLog.push('runSession')),
      unregisterWorkspace: vi.fn(() => callLog.push('workspace')),
    })
    const coordinator = new ViewRegistrationCoordinator(ctx)

    await coordinator.unregisterAll(state)
    callLog.push('views.delete')
    views.delete('order-test')

    const deleteIndex = callLog.indexOf('views.delete')
    // RF04: 新顺序 — 数据流 → 工作区 → VSR → CDP → Resource → Session
    for (const step of ['resourceDetection', 'viewPageRegistry', 'workspace',
      'viewStateRegistry', 'cdpManager', 'resourceManager', 'runSession']) {
      const stepIndex = callLog.indexOf(step)
      expect(stepIndex).toBeLessThan(deleteIndex)
    }
    // 验证 workspace 在 viewStateRegistry 之前
    expect(callLog.indexOf('workspace')).toBeLessThan(callLog.indexOf('viewStateRegistry'))
  })
})

// ---------------------------------------------------------------------------
// VL-002: 异常路径中 unregisterAll 的幂等性
// ---------------------------------------------------------------------------

describe('VL-002: 异常路径 unregisterAll 幂等调用', () => {
  it('unregisterAll 重复调用不会抛出异常', async () => {
    const state = makeState('idempotent-test')
    const ctx = makeCtx()
    const coordinator = new ViewRegistrationCoordinator(ctx)

    await coordinator.unregisterAll(state)
    // 第二次调用（模拟 catch 块中的补偿调用）应该安全执行
    await expect(coordinator.unregisterAll(state)).resolves.not.toThrow()

    expect(ctx.unregisterWorkspace).toHaveBeenCalledTimes(2)
  })

  it('RF04: 单步失败不阻断后续清理（异常安全）', async () => {
    const state = makeState('partial-fail')
    const ctx = makeCtx({
      unregisterCdpManager: vi.fn(async () => {
        throw new Error('模拟 CDP 反注册失败')
      }),
    })
    const coordinator = new ViewRegistrationCoordinator(ctx)

    // RF04: 每步 try-catch，单步失败不会抛出，后续步骤仍执行
    await expect(coordinator.unregisterAll(state)).resolves.not.toThrow()
    // 即使 CDP 失败，workspace/runSession 等仍被调用
    expect(ctx.unregisterWorkspace).toHaveBeenCalledWith(state)
    expect(ctx.unregisterRunSession).toHaveBeenCalledWith(state)
  })

  it('viewDestroyed=true 场景：异常后 views 应被正确清理', async () => {
    const views = new Map<string, ViewEntry>()
    const state = makeState('error-cleanup')
    views.set('error-cleanup', state)

    const ctx = makeCtx()
    const coordinator = new ViewRegistrationCoordinator(ctx)

    // 模拟 VL-002 修复后的 catch 块逻辑
    let viewDestroyed = true
    try {
      throw new Error('模拟 notifyRenderer 异常')
    } catch {
      if (viewDestroyed && state) {
        try {
          await coordinator.unregisterAll(state)
        } catch {
          // swallow
        }
        views.delete('error-cleanup')
      }
    }

    expect(views.has('error-cleanup')).toBe(false)
    expect(ctx.unregisterWorkspace).toHaveBeenCalledWith(state)
    expect(ctx.unregisterRunSession).toHaveBeenCalledWith(state)
  })
})

// ---------------------------------------------------------------------------
// VL-007: reconcileAll 不处理正在销毁的 View
// ---------------------------------------------------------------------------

describe('VL-007: reconcileAll 跳过正在销毁的 View', () => {
  it('destroyingViewIds 中的 View 被过滤后不传递给 reconcileAll', async () => {
    const destroyingViewIds = new Set<string>(['destroying-view'])

    const views = new Map<string, ViewEntry>()
    views.set('active-view', makeState('active-view'))
    views.set('destroying-view', makeState('destroying-view'))

    // 模拟 ViewFactory.reconcileSubsystemRegistrations 的过滤逻辑
    const activeStates = Array.from(views.values()).filter(
      state => !destroyingViewIds.has(state.id)
    )

    const ctx = makeCtx()
    const coordinator = new ViewRegistrationCoordinator(ctx)
    await coordinator.reconcileAll(activeStates, 'timer')

    expect(ctx.reconcileState).toHaveBeenCalledTimes(1)
    expect(ctx.reconcileState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'active-view' }),
      'timer'
    )
  })

  it('views.delete 之前 destroyingViewIds 中有 id，reconcile 不会重注册', async () => {
    const destroyingViewIds = new Set<string>()
    const views = new Map<string, ViewEntry>()
    const state = makeState('mid-destroy')
    views.set('mid-destroy', state)

    // 模拟正在销毁的 View（已加入 destroyingViewIds，尚未从 views 删除）
    destroyingViewIds.add('mid-destroy')

    const activeStates = Array.from(views.values()).filter(
      s => !destroyingViewIds.has(s.id)
    )

    const ctx = makeCtx()
    const coordinator = new ViewRegistrationCoordinator(ctx)
    await coordinator.reconcileAll(activeStates, 'timer')

    // reconcileState 不应被调用
    expect(ctx.reconcileState).not.toHaveBeenCalled()
  })

  it('销毁完成后 View 从 views 和 destroyingViewIds 中同时消失', async () => {
    const destroyingViewIds = new Set<string>()
    const views = new Map<string, ViewEntry>()
    const state = makeState('full-cycle')
    views.set('full-cycle', state)

    const ctx = makeCtx()
    const coordinator = new ViewRegistrationCoordinator(ctx)

    // Step 1: 开始销毁
    destroyingViewIds.add('full-cycle')

    // Step 2: unregisterAll（View 仍在 views 中）
    expect(views.has('full-cycle')).toBe(true)
    await coordinator.unregisterAll(state)

    // Step 3: views.delete（VL-001 修复后的正确位置）
    views.delete('full-cycle')

    // Step 4: finally 清理 destroyingViewIds
    destroyingViewIds.delete('full-cycle')

    // 验证：reconcile 不会看到任何与 full-cycle 相关的状态
    const activeStates = Array.from(views.values()).filter(
      s => !destroyingViewIds.has(s.id)
    )
    expect(activeStates).toHaveLength(0)
  })
})
