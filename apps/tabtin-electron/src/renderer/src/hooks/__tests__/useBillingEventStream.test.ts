import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const {
  mockUseGatewayTopic,
  mockGetOrganizationWallet,
  mockGetOrganizationSummary,
  mockGetLowBalanceConfig,
  mockGetMyUsage,
  mockOpenSettings,
  mockToast,
  mockSystemNotification,
  mockClearBalanceBillingErrors,
  capturedGatewayOptions,
} = vi.hoisted(() => {
  const capturedGatewayOptions: Array<{
    onEvent?: (envelope: Record<string, unknown>) => void
    onReconnected?: () => void
  }> = []
  return {
    mockUseGatewayTopic: vi.fn((options: {
      onEvent?: (envelope: Record<string, unknown>) => void
      onReconnected?: () => void
    }) => {
      capturedGatewayOptions.push(options)
      return { status: 'connected' }
    }),
    mockGetOrganizationWallet: vi.fn(),
    mockGetOrganizationSummary: vi.fn(),
    mockGetLowBalanceConfig: vi.fn(),
    mockGetMyUsage: vi.fn(),
    mockOpenSettings: vi.fn(),
    mockToast: vi.fn(),
    mockSystemNotification: vi.fn(),
    mockClearBalanceBillingErrors: vi.fn(),
    capturedGatewayOptions,
  }
})

vi.mock('../useGatewayTopic', () => ({
  useGatewayTopic: mockUseGatewayTopic,
}))

vi.mock('@tabtin/ws-gateway-client', () => ({
  BillingEvents: {
    AUTO_RENEW_FAILED: 'billing.auto_renew_failed',
    BALANCE_LOW: 'billing.balance_low',
    BILLING_BLOCKED: 'billing.billing_blocked',
    BILLING_UNBLOCKED: 'billing.billing_unblocked',
    BUDGET_CRITICAL: 'billing.budget_critical',
    BUDGET_RESOLVED: 'billing.budget_resolved',
    BUDGET_WARNING: 'billing.budget_warning',
    CREDITS_RECHARGED: 'billing.credits_recharged',
    CASH_RECHARGED: 'billing.cash_recharged',
    DEGRADATION_ALERT: 'billing.degradation_alert',
    INVOICE_COLLECTION_FAILED: 'billing.invoice_collection_failed',
    INVOICE_COLLECTION_SUCCEEDED: 'billing.invoice_collection_succeeded',
    INVOICE_REFUNDED: 'billing.invoice_refunded',
    MEMBER_BUDGET_EXHAUSTED: 'billing.member_budget_exhausted',
    MEMBER_BUDGET_POLICY_CHANGED: 'billing.member_budget_policy_changed',
    MEMBER_BUDGET_RESOLVED: 'billing.member_budget_resolved',
    MEMBER_BUDGET_WARNING: 'billing.member_budget_warning',
    MEMBERSHIP_ACTIVATED: 'billing.membership_activated',
    MEMBERSHIP_DOWNGRADED_OVERLIMIT: 'billing.membership_downgraded_overlimit',
    MEMBERSHIP_EXPIRED: 'billing.membership_expired',
    MEMBERSHIP_EXPIRING: 'billing.membership_expiring',
    MEMBERSHIP_RENEWAL_CANCELLED: 'billing.membership_renewal_cancelled',
    PLATFORM_REFUND_COMPLETED: 'billing.platform_refund_completed',
    PLATFORM_REFUND_FAILED: 'billing.platform_refund_failed',
    QUOTA_EXHAUSTED: 'billing.quota_exhausted',
    REFUND_PARTIAL_FAILURE: 'billing.refund_partial_failure',
    STORAGE_AUTO_RENEW_FAILED: 'billing.storage_auto_renew_failed',
    STORAGE_CRITICAL: 'billing.storage_critical',
    STORAGE_PACKAGE_EXPIRING: 'billing.storage_package_expiring',
    STORAGE_RESOLVED: 'billing.storage_resolved',
    STORAGE_WARNING: 'billing.storage_warning',
    USAGE_AGGREGATED: 'billing.usage_aggregated',
  },
}))

vi.mock('@/services/membershipApi', () => ({
  MembershipApiService: {
    getOrganizationWallet: mockGetOrganizationWallet,
  },
}))

vi.mock('@/services/billingApi', () => ({
  OrganizationBillingApiService: {
    getOrganizationSummary: mockGetOrganizationSummary,
    getLowBalanceConfig: mockGetLowBalanceConfig,
  },
}))

vi.mock('@/services/memberBudgetApi', () => ({
  MemberBudgetApiService: {
    getMyUsage: mockGetMyUsage,
  },
}))

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    billingBlocked: mockSystemNotification,
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
  ToastAction: () => null,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'user-1' } }),
  },
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({ currentUserRole: 'owner' }),
  },
}))

vi.mock('@/hooks/useCanManageOrganization', () => ({
  canManageOrganization: () => true,
}))

vi.mock('@/stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({ openSettings: mockOpenSettings }),
  },
}))

vi.mock('@/lib/clearBalanceBillingChatErrors', () => ({
  clearBalanceBillingErrorsInChatStore: mockClearBalanceBillingErrors,
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const projectedPresentation = {
  owner: 'notification_projection',
  projected: true,
  source_event_id: 'billing:test:event-1',
}


describe('useBillingEventStream', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    capturedGatewayOptions.length = 0
    sessionStorage.clear()
    mockGetOrganizationWallet.mockResolvedValue({ available_credits_precise: '5000.0000' })
    mockGetOrganizationSummary.mockResolvedValue({ llm_month_budget: null })
    mockGetLowBalanceConfig.mockResolvedValue({
      organization_id: 'wt-1',
      warning_credits: '50',
      critical_credits: '10',
      email_enabled: true,
    })
    mockGetMyUsage.mockResolvedValue(null)

    const { useBillingStore } = await import('@/stores/useBillingStore')
    useBillingStore.getState().setBillingBlocked(true)
    useBillingStore.getState().setMemberLimitReached(false)
    useBillingStore.getState().clearBudgetAlert()
  })

  it('启动订阅时用钱包真实余额解除陈旧 billing 阻断', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')
    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
      expect(useBillingStore.getState().billingBlocked).toBe(false)
    })
  })

  it('cash_recharged 不弹 toast，只触发 billing:refresh（提醒走铃铛）', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const refreshSpy = vi.fn()
    window.addEventListener('billing:refresh', refreshSpy)

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type: 'billing.cash_recharged',
        payload: {
          event_type: 'cash_recharged',
          organization_id: 'wt-1',
          amount_cny: '128.50',
          order_id: 'OPS-CASH-1',
        },
      })
    })

    expect(mockToast).not.toHaveBeenCalled()
    expect(refreshSpy).toHaveBeenCalled()
    window.removeEventListener('billing:refresh', refreshSpy)
  })

  it('credits_recharged 清低余额 toast、消对话余额不足卡并派发通知刷新', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')
    const { NOTIFICATION_REFRESH_EVENT } = await import('../queries/notification')
    const refreshSpy = vi.fn()
    window.addEventListener(NOTIFICATION_REFRESH_EVENT, refreshSpy)

    sessionStorage.setItem('tabtin:balance_low_toast:wt-1:warning', '1')
    sessionStorage.setItem('tabtin:balance_low_toast:wt-1:critical', '1')
    useBillingStore.getState().setBillingBlocked(true)

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type: 'billing.credits_recharged',
        payload: {
          event_type: 'credits_recharged',
          organization_id: 'wt-1',
          amount: '1000',
        },
      })
    })

    expect(useBillingStore.getState().billingBlocked).toBe(false)
    expect(sessionStorage.getItem('tabtin:balance_low_toast:wt-1:warning')).toBeNull()
    expect(sessionStorage.getItem('tabtin:balance_low_toast:wt-1:critical')).toBeNull()
    expect(mockClearBalanceBillingErrors).toHaveBeenCalled()
    expect(refreshSpy).toHaveBeenCalled()
    expect((refreshSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
      organizationId: 'wt-1',
      reason: 'credits_recharged',
    })
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'common:billing.creditsRecharged' }),
    )
    window.removeEventListener(NOTIFICATION_REFRESH_EVENT, refreshSpy)
  })

  it('团队预算告警软下线后不再 toast / 通知 / 挂 banner', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    useBillingStore.getState().setBudgetAlert({
      level: 'critical',
      usagePercent: 144,
      budgetLimit: 100,
    })

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type: 'billing.budget_critical',
        payload: {
          usage_percent: 144,
          budget_limit: 100,
          blocking: true,
          wallet_paygo_available: false,
        },
      })
    })

    expect(mockSystemNotification).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
    expect(useBillingStore.getState().budgetAlert).toBeNull()
  })

  it('启动同步清掉残留预算 banner，且不再按套餐额度重挂', async () => {
    mockGetOrganizationWallet.mockResolvedValue({ available_credits_precise: '0.0000' })
    mockGetOrganizationSummary.mockResolvedValue({
      policy: { llm_billing_mode: 'quota_only' },
      llm_month_budget: {
        consumed_credits: '144.0000',
        included_credits: '100.0000',
        remaining_credits: '0.0000',
      },
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    useBillingStore.getState().setBudgetAlert({
      level: 'critical',
      usagePercent: 144,
      budgetLimit: 100,
    })

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
      expect(useBillingStore.getState().budgetAlert).toBeNull()
    })
  })

  it('billingBlocked 粘滞时重连同步钱包和套餐额度并自动复位', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    mockGetOrganizationWallet.mockClear()
    useBillingStore.getState().setBillingBlocked(true)

    act(() => {
      capturedGatewayOptions.at(-1)?.onReconnected?.()
      vi.advanceTimersByTime(0)
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
    expect(useBillingStore.getState().billingBlocked).toBe(false)
  })

  it('启动订阅时清掉陈旧 memberLimitReached，再用 my-usage 正常结果保持解除', async () => {
    mockGetMyUsage.mockResolvedValue({
      organization_id: 'wt-1',
      user_id: 'user-1',
      role: 'editor',
      cycle_month: '2026-07-01',
      today: '2026-07-17',
      monthly_used: '3',
      daily_used: '1',
      monthly_limit: '10',
      daily_limit: null,
      max_model_tier: 'enterprise',
      policy_source: 'personal',
      is_exempt: false,
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    useBillingStore.getState().setMemberLimitReached(true, 'member_monthly_limit')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    await waitFor(() => {
      expect(mockGetMyUsage).toHaveBeenCalledWith('wt-1')
      expect(useBillingStore.getState().memberLimitReached).toBe(false)
    })
  })

  it('my-usage 确认成员月度超限时会重新置回 memberLimitReached', async () => {
    mockGetMyUsage.mockResolvedValue({
      organization_id: 'wt-1',
      user_id: 'user-1',
      role: 'editor',
      cycle_month: '2026-07-01',
      today: '2026-07-17',
      monthly_used: '10',
      daily_used: '1',
      monthly_limit: '10',
      daily_limit: null,
      max_model_tier: 'enterprise',
      policy_source: 'personal',
      is_exempt: false,
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    await waitFor(() => {
      expect(useBillingStore.getState().memberLimitReached).toBe(true)
      expect(useBillingStore.getState().memberLimitReason).toBe('member_monthly_limit')
    })
  })

  it('organization 切换后忽略旧钱包请求的晚返回', async () => {
    const walletRequests = new Map<string, ReturnType<typeof createDeferred<{ available_credits_precise: string }>>>()
    mockGetOrganizationWallet.mockImplementation((organizationId: string) => {
      const deferred = createDeferred<{ available_credits_precise: string }>()
      walletRequests.set(organizationId, deferred)
      return deferred.promise
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    const { rerender } = renderHook(
      ({ organizationId }) => useBillingEventStream({ organizationId, enabled: true }),
      { initialProps: { organizationId: 'wt-old' } },
    )

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-old')
    })

    rerender({ organizationId: 'wt-new' })

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-new')
    })

    walletRequests.get('wt-new')?.resolve({ available_credits_precise: '5000.0000' })

    await waitFor(() => {
      expect(useBillingStore.getState().billingBlocked).toBe(false)
    })

    walletRequests.get('wt-old')?.resolve({ available_credits_precise: '0.0000' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(useBillingStore.getState().billingBlocked).toBe(false)
  })

  it('organization 切换后清掉旧 memberLimitReached，新组织 my-usage 失败也不继承旧阻断', async () => {
    mockGetMyUsage.mockImplementation((organizationId: string) => {
      if (organizationId === 'wt-new') return Promise.reject(new Error('network failed'))
      return Promise.resolve({
        organization_id: organizationId,
        user_id: 'user-1',
        role: 'editor',
        cycle_month: '2026-07-01',
        today: '2026-07-17',
        monthly_used: '10',
        daily_used: '0',
        monthly_limit: '10',
        daily_limit: null,
        max_model_tier: 'enterprise',
        policy_source: 'personal',
        is_exempt: false,
      })
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    const { rerender } = renderHook(
      ({ organizationId }) => useBillingEventStream({ organizationId, enabled: true }),
      { initialProps: { organizationId: 'wt-old' } },
    )

    await waitFor(() => {
      expect(useBillingStore.getState().memberLimitReached).toBe(true)
    })

    rerender({ organizationId: 'wt-new' })

    await waitFor(() => {
      expect(mockGetMyUsage).toHaveBeenCalledWith('wt-new')
      expect(useBillingStore.getState().memberLimitReached).toBe(false)
    })
  })

  it('billing.balance_low 只刷新账户状态，不弹应用内 toast', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
    })
    mockToast.mockClear()

    const opts = capturedGatewayOptions.at(-1)
    act(() => {
      opts?.onEvent?.({
        type: 'billing.balance_low',
        payload: {
          source: 'agent_conversation',
          level: 'warning',
          current_balance: 30,
          threshold: 50,
        },
      })
    })
    expect(mockToast).not.toHaveBeenCalled()

    act(() => {
      opts?.onEvent?.({
        type: 'billing.balance_low',
        payload: {
          source: 'agent_conversation',
          level: 'warning',
          current_balance: 25,
          threshold: 50,
        },
      })
    })
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('进入主界面时即使余额低于预警阈值，也不主动弹出提示', async () => {
    mockGetOrganizationWallet.mockResolvedValue({ available_credits_precise: '30.0000' })
    mockGetOrganizationSummary.mockResolvedValue({ llm_month_budget: null })
    mockGetLowBalanceConfig.mockResolvedValue({
      organization_id: 'wt-1',
      warning_credits: '50',
      critical_credits: '10',
      email_enabled: true,
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
    })
    expect(mockGetLowBalanceConfig).not.toHaveBeenCalled()
    expect(mockToast.mock.calls.some((call) => call[0]?.title === 'common:billing.balanceLow')).toBe(false)
  })

  it('新建组织钱包为 0 但仍有月度套餐剩余时不弹余额严重不足', async () => {
    mockGetOrganizationWallet.mockResolvedValue({ available_credits_precise: '0.0000' })
    mockGetOrganizationSummary.mockResolvedValue({
      llm_month_budget: {
        included_credits: 100,
        used_credits: 0,
        remaining_credits: 100,
      },
    })
    mockGetLowBalanceConfig.mockResolvedValue({
      organization_id: 'wt-new',
      warning_credits: '50',
      critical_credits: '10',
      email_enabled: true,
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-new', enabled: true }))

    await waitFor(() => {
      expect(mockGetOrganizationSummary).toHaveBeenCalled()
    })
    expect(mockGetLowBalanceConfig).not.toHaveBeenCalled()
    expect(mockToast.mock.calls.some((call) => call[0]?.title === 'common:billing.balanceLow')).toBe(false)
    expect(mockToast.mock.calls.some((call) => call[0]?.title === 'common:billing.balanceCritical')).toBe(false)
  })

  it('非 Agent 对话来源的低余额事件不弹 toast', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
    })
    mockToast.mockClear()

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type: 'billing.balance_low',
        payload: {
          source: 'threshold_recheck',
          level: 'warning',
          current_balance: 30,
          threshold: 50,
        },
      })
    })

    expect(mockToast).not.toHaveBeenCalled()
  })

  it('单次调用点券不足不暂停组织，也不叠加全局 toast', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    act(() => {
      useBillingStore.getState().setBillingBlocked(false)
    })
    mockToast.mockClear()
    mockSystemNotification.mockClear()

    const opts = capturedGatewayOptions.at(-1)
    act(() => {
      opts?.onEvent?.({
        type: 'billing.billing_blocked',
        payload: {
          error_code: 'ORGANIZATION_INSUFFICIENT_CREDITS',
          block_type: 'request_insufficient_credits',
        },
      })
    })

    expect(mockToast).not.toHaveBeenCalled()
    expect(mockSystemNotification).not.toHaveBeenCalled()
    expect(useBillingStore.getState().billingBlocked).toBe(false)
  })

  it('组织 Guard 只在进入阻断态时弹一次', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    act(() => useBillingStore.getState().setBillingBlocked(false))
    mockToast.mockClear()
    mockSystemNotification.mockClear()

    const opts = capturedGatewayOptions.at(-1)
    const event = {
      type: 'billing.billing_blocked',
      payload: {
        reason: 'billing_guard_anomaly',
        error_code: 'BILLING_BLOCKED',
        block_type: 'organization_billing_guard',
      },
    }

    act(() => {
      opts?.onEvent?.(event)
    })
    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(useBillingStore.getState().billingBlocked).toBe(true)

    act(() => {
      opts?.onEvent?.(event)
    })
    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(useBillingStore.getState().billingBlocked).toBe(true)
  })

  it('月度套餐额度耗尽只刷新数据，不再弹打断式 toast', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const onRefresh = vi.fn()

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    window.addEventListener('billing:refresh', onRefresh)
    mockToast.mockClear()

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type: 'billing.quota_exhausted',
        payload: { cycle_month: '2026-07-01' },
      })
    })

    expect(mockToast).not.toHaveBeenCalled()
    expect(onRefresh).toHaveBeenCalledTimes(1)
    window.removeEventListener('billing:refresh', onRefresh)
  })

  it('兼容旧版 billing_blocked 事件并区分请求不足与组织 Guard', async () => {
    const { isOrganizationBillingGuard } = await import('../useBillingEventStream')

    expect(isOrganizationBillingGuard({
      reason: 'organization_insufficient_credits',
    })).toBe(false)
    expect(isOrganizationBillingGuard({
      reason: '检测到连续扣款异常',
    })).toBe(true)
  })

  it('organization 切换后忽略旧 member budget resolved 事件触发的晚返回', async () => {
    const oldUsage = createDeferred<{
      policy_source: string
      monthly_used: string
      monthly_limit: string
      daily_used: string
      daily_limit: string | null
    }>()
    mockGetMyUsage.mockImplementation((organizationId: string) => {
      if (organizationId === 'wt-old') return oldUsage.promise
      return Promise.resolve(null)
    })

    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    const { rerender } = renderHook(
      ({ organizationId }) => useBillingEventStream({ organizationId, enabled: true }),
      { initialProps: { organizationId: 'wt-old' } },
    )

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-old')
    })

    const usageCallsBeforeEvent = mockGetMyUsage.mock.calls.length
    const oldOptions = capturedGatewayOptions[capturedGatewayOptions.length - 1]
    oldOptions.onEvent?.({
      type: 'billing.member_budget_resolved',
      payload: { scope: 'organization' },
    })

    await waitFor(() => {
      expect(mockGetMyUsage.mock.calls.length).toBeGreaterThan(usageCallsBeforeEvent)
    })
    expect(mockGetMyUsage).toHaveBeenLastCalledWith('wt-old')

    rerender({ organizationId: 'wt-new' })

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-new')
    })

    oldUsage.resolve({
      policy_source: 'policy',
      monthly_used: '10',
      monthly_limit: '10',
      daily_used: '0',
      daily_limit: null,
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(useBillingStore.getState().memberLimitReached).toBe(false)
  })

  it.each([
    ['billing.billing_blocked', { block_type: 'organization_billing_guard', reason: '组织计费已暂停' }],
    ['billing.degradation_alert', { meter_key: 'llm' }],
    ['billing.platform_refund_failed', { refund_no: 'RF-1' }],
    ['billing.refund_partial_failure', { invoice_no: 'INV-1' }],
    ['billing.invoice_collection_failed', { invoice_id: 'invoice-1' }],
    ['billing.credits_recharged', { amount: '1000' }],
    ['billing.membership_expiring', { days_left: 3 }],
    ['billing.membership_expired', {}],
    ['billing.auto_renew_failed', { reason: 'insufficient_balance' }],
    ['billing.membership_downgraded_overlimit', { exceeded_count: 2 }],
    ['billing.storage_warning', { usage_percent: 85 }],
    ['billing.storage_critical', { usage_percent: 98 }],
    ['billing.storage_package_expiring', { days_remaining: 3 }],
    ['billing.storage_auto_renew_failed', { reason: 'insufficient_balance' }],
    ['billing.member_budget_warning', { user_id: 'user-1', usage_percent: 85 }],
    ['billing.member_budget_exhausted', { user_id: 'user-1', budget_type: 'monthly' }],
  ])('权威投影成功时 Group A %s 不再重复 toast', async (type, payload) => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    act(() => useBillingStore.getState().setBillingBlocked(false))
    mockToast.mockClear()

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type,
        payload: { organization_id: 'wt-1', ...payload },
        presentation: projectedPresentation,
      })
    })

    expect(mockToast).not.toHaveBeenCalled()
  })

  it.each([
    ['无 marker', undefined],
    ['projected=false', { ...projectedPresentation, projected: false }],
    ['owner 不符', { ...projectedPresentation, owner: 'billing_stream' }],
    ['source_event_id 为空', { ...projectedPresentation, source_event_id: '' }],
  ])('%s 时 Group A 保持旧 toast 降级', async (_name, presentation) => {
    const { useBillingEventStream } = await import('../useBillingEventStream')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    mockToast.mockClear()

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type: 'billing.degradation_alert',
        payload: { organization_id: 'wt-1', meter_key: 'llm' },
        ...(presentation ? { presentation } : {}),
      })
    })

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'common:billing.degradationAlert' }),
    )
  })

  it.each([
    ['billing.billing_unblocked', {}],
    ['billing.membership_activated', {}],
    ['billing.membership_renewal_cancelled', {}],
    ['billing.storage_resolved', {}],
    ['billing.member_budget_resolved', { scope: 'personal', user_id: 'user-1' }],
  ])('Group B %s 即使带权威 marker 也保持原 Toast', async (type, payload) => {
    const { useBillingEventStream } = await import('../useBillingEventStream')

    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    mockToast.mockClear()

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type,
        payload: { organization_id: 'wt-1', ...payload },
        presentation: projectedPresentation,
      })
    })

    expect(mockToast).toHaveBeenCalledTimes(1)
  })

  it('权威投影仅压 Toast，billing/wallet/member budget/chat error 状态与刷新仍继续', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const { useBillingStore } = await import('@/stores/useBillingStore')
    const { NOTIFICATION_REFRESH_EVENT } = await import('../queries/notification')
    const refreshSpy = vi.fn()
    const notificationRefreshSpy = vi.fn()
    window.addEventListener('billing:refresh', refreshSpy)
    window.addEventListener(NOTIFICATION_REFRESH_EVENT, notificationRefreshSpy)

    sessionStorage.setItem('tabtin:balance_low_toast:wt-1:warning', '1')
    sessionStorage.setItem('tabtin:balance_low_toast:wt-1:critical', '1')
    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    act(() => useBillingStore.getState().setBillingBlocked(false))
    refreshSpy.mockClear()
    mockToast.mockClear()

    const dispatchProjected = (type: string, payload: Record<string, unknown>) => {
      act(() => {
        capturedGatewayOptions.at(-1)?.onEvent?.({
          type,
          payload: { organization_id: 'wt-1', ...payload },
          presentation: projectedPresentation,
        })
      })
    }

    dispatchProjected('billing.billing_blocked', {
      block_type: 'organization_billing_guard',
      reason: '组织计费已暂停',
    })
    expect(useBillingStore.getState().billingBlocked).toBe(true)

    dispatchProjected('billing.credits_recharged', { amount: '1000' })
    expect(useBillingStore.getState().billingBlocked).toBe(false)
    expect(sessionStorage.getItem('tabtin:balance_low_toast:wt-1:warning')).toBeNull()
    expect(sessionStorage.getItem('tabtin:balance_low_toast:wt-1:critical')).toBeNull()
    expect(mockClearBalanceBillingErrors).toHaveBeenCalled()
    expect(notificationRefreshSpy).toHaveBeenCalled()

    dispatchProjected('billing.member_budget_exhausted', {
      user_id: 'user-1',
      budget_type: 'daily',
    })
    expect(useBillingStore.getState().memberLimitReached).toBe(true)
    expect(useBillingStore.getState().memberLimitReason).toBe('member_daily_limit')
    expect(refreshSpy).toHaveBeenCalledTimes(3)
    expect(mockToast).not.toHaveBeenCalled()

    window.removeEventListener('billing:refresh', refreshSpy)
    window.removeEventListener(NOTIFICATION_REFRESH_EVENT, notificationRefreshSpy)
  })

  it.each([
    'billing.membership_expiring',
    'billing.storage_warning',
    'billing.platform_refund_failed',
    'billing.invoice_collection_failed',
  ])('权威投影时 %s 仍派发 billing:refresh', async (type) => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const refreshSpy = vi.fn()
    window.addEventListener('billing:refresh', refreshSpy)
    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    refreshSpy.mockClear()

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        type,
        payload: { organization_id: 'wt-1', invoice_id: `invoice-${type}` },
        presentation: projectedPresentation,
      })
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    window.removeEventListener('billing:refresh', refreshSpy)
  })

  it('权威投影的 invoice_collection_failed 不占用旧 Toast throttle 槽', async () => {
    const { useBillingEventStream } = await import('../useBillingEventStream')
    const refreshSpy = vi.fn()
    window.addEventListener('billing:refresh', refreshSpy)
    renderHook(() => useBillingEventStream({ organizationId: 'wt-1', enabled: true }))
    refreshSpy.mockClear()
    mockToast.mockClear()

    const event = {
      type: 'billing.invoice_collection_failed',
      payload: { organization_id: 'wt-1', invoice_id: 'invoice-projection-throttle' },
    }
    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.({
        ...event,
        presentation: projectedPresentation,
      })
    })
    expect(mockToast).not.toHaveBeenCalled()

    act(() => {
      capturedGatewayOptions.at(-1)?.onEvent?.(event)
    })
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'common:billing.invoiceCollectionFailed' }),
    )
    expect(refreshSpy).toHaveBeenCalledTimes(2)

    window.removeEventListener('billing:refresh', refreshSpy)
  })
})
