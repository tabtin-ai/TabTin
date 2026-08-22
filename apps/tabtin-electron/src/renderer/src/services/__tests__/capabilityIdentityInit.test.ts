import { beforeEach, describe, expect, it, vi } from 'vitest'

const clearAllActiveRunBindings = vi.fn()
const clearAllSupersededRuns = vi.fn()
const resetHostTurnPush = vi.fn()
const registerResetAction = vi.fn()
const onOrganizationSelected = vi.fn((cb: () => void) => {
  ;(onOrganizationSelected as unknown as { _cb?: () => void })._cb = cb
  return () => undefined
})

vi.mock('@/stores/chat/execution/activeRunBinding', () => ({
  clearAllActiveRunBindings: (...args: unknown[]) => clearAllActiveRunBindings(...args),
}))
vi.mock('@/stores/chat/stream/handlers/supersededRuns', () => ({
  clearAllSupersededRuns: (...args: unknown[]) => clearAllSupersededRuns(...args),
}))
vi.mock('@tabtin/app-shell', () => ({
  onOrganizationSelected: (...args: unknown[]) =>
    (onOrganizationSelected as (...a: unknown[]) => unknown)(...args),
  resetHostTurnPush: (...args: unknown[]) => resetHostTurnPush(...args),
}))
vi.mock('@/stores/sessionResetRegistry', () => ({
  registerResetAction: (...args: unknown[]) => registerResetAction(...args),
}))

describe('capabilityIdentityInit ', () => {
  beforeEach(() => {
    vi.resetModules()
    clearAllActiveRunBindings.mockClear()
    clearAllSupersededRuns.mockClear()
    resetHostTurnPush.mockClear()
    registerResetAction.mockClear()
    onOrganizationSelected.mockClear()
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      agentEngine: {
        initCapabilityIdentity: vi.fn().mockResolvedValue({ success: true, rewarmed: true }),
      },
    }
  })

  it('initCapabilityIdentity 清渲染侧并调 IPC', async () => {
    const mod = await import('../capabilityIdentityInit')
    await mod.initCapabilityIdentity('organization-switch', { organizationId: 'org-b' })
    expect(clearAllActiveRunBindings).toHaveBeenCalled()
    expect(clearAllSupersededRuns).toHaveBeenCalled()
    expect(resetHostTurnPush).toHaveBeenCalled()
    expect(window.tabtin?.agentEngine?.initCapabilityIdentity).toHaveBeenCalledWith({
      reason: 'organization-switch',
      organizationId: 'org-b',
    })
  })

  it('wire 挂接登出 reset 与切组织；同 org 再 emit 跳过', async () => {
    const mod = await import('../capabilityIdentityInit')
    mod.__resetCapabilityIdentityLifecycleForTest()
    mod.wireCapabilityIdentityLifecycle()
    expect(registerResetAction).toHaveBeenCalledWith(
      'capability-identity',
      'reset',
      expect.any(Function),
    )
    expect(onOrganizationSelected).toHaveBeenCalled()
    const orgCb = (onOrganizationSelected as unknown as {
      _cb?: (organizationId: string) => void
    })._cb
    expect(orgCb).toBeTypeOf('function')
    await orgCb?.('org-a')
    await orgCb?.('org-a')
    expect(window.tabtin?.agentEngine?.initCapabilityIdentity).toHaveBeenCalledTimes(1)
    expect(window.tabtin?.agentEngine?.initCapabilityIdentity).toHaveBeenCalledWith({
      reason: 'organization-switch',
      organizationId: 'org-a',
    })
  })
})
