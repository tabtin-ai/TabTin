import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiRequestMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
}))

vi.mock('@/services/apiBase', async () => {
  const actual = await vi.importActual<typeof import('@/services/apiBase')>('@/services/apiBase')
  return {
    ...actual,
    apiRequest: apiRequestMock,
  }
})

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'https://api.test' },
  API_ENDPOINTS: {
    MEMBERSHIP: {
      TIERS: '/membership/tiers',
      ORGANIZATION_MEMBERSHIP: (organizationId: string) =>
        `/membership/organizations/${organizationId}/membership`,
      ORGANIZATION_SUBSCRIPTION_OVERVIEW: (organizationId: string) =>
        `/membership/organizations/${organizationId}/overview`,
      ORGANIZATION_SUBSCRIPTION_PLANS: (organizationId: string) =>
        `/membership/organizations/${organizationId}/plans`,
      ORGANIZATION_PURCHASE: (organizationId: string) =>
        `/membership/organizations/${organizationId}/purchase`,
      ORGANIZATION_PURCHASE_PREVIEW: (organizationId: string) =>
        `/membership/organizations/${organizationId}/purchase/preview`,
      ORGANIZATION_UPGRADE_PREVIEW: (organizationId: string) =>
        `/membership/organizations/${organizationId}/upgrade-preview`,
      ORGANIZATION_UPGRADE: (organizationId: string) =>
        `/membership/organizations/${organizationId}/upgrade`,
      ORGANIZATION_ACTIVE_UPGRADE_ORDER: (organizationId: string) =>
        `/membership/organizations/${organizationId}/upgrade-orders/active`,
      ORGANIZATION_UPGRADE_ORDER: (organizationId: string, orderId: string) =>
        `/membership/organizations/${organizationId}/upgrade-orders/${orderId}`,
      ORGANIZATION_UPGRADE_ORDER_WALLET_PAY: (organizationId: string, orderId: string) =>
        `/membership/organizations/${organizationId}/upgrade-orders/${orderId}/wallet-pay`,
      ORGANIZATION_AUTO_RENEW: (organizationId: string) =>
        `/membership/organizations/${organizationId}/membership/auto-renew`,
    },
    WALLET: {
      PACKAGES: '/wallet/packages',
      RECHARGE: '/wallet/recharge',
      TRANSACTIONS: '/wallet/transactions',
      ORGANIZATION_WALLET: (organizationId: string) =>
        `/wallet/organizations/${organizationId}/wallet`,
      ORGANIZATION_CASH_WALLET: (organizationId: string) =>
        `/wallet/organizations/${organizationId}/cash-wallet`,
      ORGANIZATION_CASH_WALLET_RECHARGE: (organizationId: string) =>
        `/wallet/organizations/${organizationId}/cash-wallet/recharge`,
      ORGANIZATION_CASH_TRANSACTIONS: (organizationId: string) =>
        `/wallet/organizations/${organizationId}/cash-transactions`,
      ORGANIZATION_TRANSACTIONS: (organizationId: string) =>
        `/wallet/organizations/${organizationId}/transactions`,
      ORGANIZATION_TRANSACTIONS_EXPORT: (organizationId: string) =>
        `/wallet/organizations/${organizationId}/transactions/export`,
      ORGANIZATION_DISPUTES: (organizationId: string) =>
        `/wallet/organizations/${organizationId}/disputes`,
    },
    BILLING_ORGANIZATION: {
      ADDON_PACKAGES: '/billing/organizations/addon-packages',
      ADDON_PACKAGE_PURCHASE: (organizationId: string) =>
        `/billing/organizations/${organizationId}/addon-packages/purchase`,
    },
  },
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
}))

describe('MembershipApiService subscription lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('calls the upgrade preview endpoint with the frozen target tier payload', async () => {
    const { MembershipApiService } = await import('../membershipApi')
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          action: 'upgrade',
          quote_token: 'signed-token',
          payable_amount: '220.00',
          current_value: '46.00',
          target_value: '266.00',
          discount_amount: '46.00',
        },
      },
    })

    const result = await MembershipApiService.previewMembershipUpgrade('org-1', 'tier-enterprise', 'monthly')

    expect(result).toMatchObject({
      action: 'upgrade',
      quote_token: 'signed-token',
      payable_amount: '220.00',
    })
    expect(apiRequestMock).toHaveBeenCalledTimes(1)
    expect(apiRequestMock.mock.calls[0][0]).toMatchObject({
      url: 'https://api.test/membership/organizations/org-1/upgrade-preview',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(apiRequestMock.mock.calls[0][0].body)).toEqual({
      target_tier_id: 'tier-enterprise',
      billing_cycle: 'monthly',
    })
  })

  it('does not create a payment order when requesting an upgrade quote', async () => {
    const { MembershipApiService } = await import('../membershipApi')
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { action: 'upgrade', quote_token: 'token' } },
    })

    await MembershipApiService.previewMembershipUpgrade('org-1', 'tier-team')

    const urls = apiRequestMock.mock.calls.map(call => String(call[0].url))
    expect(urls).toEqual(['https://api.test/membership/organizations/org-1/upgrade-preview'])
    expect(urls.some(url => url.endsWith('/purchase'))).toBe(false)
  })

  it('keeps quote_token out of browser persistent storage', async () => {
    const { MembershipApiService } = await import('../membershipApi')
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { action: 'upgrade', quote_token: 'token-to-display-only' } },
    })

    await MembershipApiService.previewMembershipUpgrade('org-1', 'tier-team')

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('preserves server error code for upgrade quote UI handling', async () => {
    const { MembershipApiError, MembershipApiService } = await import('../membershipApi')
    apiRequestMock.mockResolvedValue({
      status: 400,
      data: {
        success: false,
        code: 'CURRENT_PERIOD_PRICE_SNAPSHOT_MISSING',
        message: 'missing current price snapshot',
      },
    })

    await expect(
      MembershipApiService.previewMembershipUpgrade('org-1', 'tier-team'),
    ).rejects.toMatchObject({
      name: 'MembershipApiError',
      code: 'CURRENT_PERIOD_PRICE_SNAPSHOT_MISSING',
    })
    await expect(
      MembershipApiService.previewMembershipUpgrade('org-1', 'tier-team'),
    ).rejects.toBeInstanceOf(MembershipApiError)
  })

  it('creates an upgrade order with quote token only through PR4 upgrade endpoint', async () => {
    const { MembershipApiService } = await import('../membershipApi')
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { order_id: 'order-1', payable_amount: '220.00' } },
    })

    await MembershipApiService.createMembershipUpgradeOrder({
      organizationId: 'org-1',
      targetTierId: 'tier-enterprise',
      billingCycle: 'monthly',
      quoteToken: 'quote-token',
    })

    expect(apiRequestMock.mock.calls[0][0]).toMatchObject({
      url: 'https://api.test/membership/organizations/org-1/upgrade',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(apiRequestMock.mock.calls[0][0].body)).toEqual({
      target_tier_id: 'tier-enterprise',
      billing_cycle: 'monthly',
      quote_token: 'quote-token',
    })
  })

  it('loads active upgrade order without preview or purchase side effects', async () => {
    const { MembershipApiService } = await import('../membershipApi')
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { order_id: 'order-1', payment_status: 'pending' } },
    })

    await MembershipApiService.getActiveMembershipUpgradeOrder('org-1')

    expect(apiRequestMock).toHaveBeenCalledTimes(1)
    expect(apiRequestMock.mock.calls[0][0]).toMatchObject({
      url: 'https://api.test/membership/organizations/org-1/upgrade-orders/active',
      method: 'GET',
    })
  })

  it('pays upgrade order with organization wallet using an empty body', async () => {
    const { MembershipApiService } = await import('../membershipApi')
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { order_id: 'order-1', payment_status: 'completed' } },
    })

    await MembershipApiService.payMembershipUpgradeOrderWithWallet('org-1', 'order-1')

    expect(apiRequestMock.mock.calls[0][0]).toMatchObject({
      url: 'https://api.test/membership/organizations/org-1/upgrade-orders/order-1/wallet-pay',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  })
})
