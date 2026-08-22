import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isBillingBlockedByAvailableCredits,
  MIN_SENDABLE_BALANCE,
  syncBillingBlockedFromWallet,
} from '../billingGuardSync'

const { mockGetOrganizationWallet, mockGetOrganizationSummary } = vi.hoisted(() => ({
  mockGetOrganizationWallet: vi.fn(),
  mockGetOrganizationSummary: vi.fn(),
}))

vi.mock('@/services/membershipApi', () => ({
  MembershipApiService: {
    getOrganizationWallet: mockGetOrganizationWallet,
  },
}))

vi.mock('@/services/billingApi', () => ({
  OrganizationBillingApiService: {
    getOrganizationSummary: mockGetOrganizationSummary,
  },
}))

const mockClearBalanceBillingErrors = vi.hoisted(() => vi.fn())

vi.mock('../clearBalanceBillingChatErrors', () => ({
  clearBalanceBillingErrorsInChatStore: mockClearBalanceBillingErrors,
}))

describe('billingGuardSync', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { useBillingStore } = await import('@/stores/useBillingStore')
    useBillingStore.getState().setBillingBlocked(true)
  })

  it('余额充足时解除 billingBlocked', async () => {
    mockGetOrganizationWallet.mockResolvedValue({ available_credits_precise: '5000.0000' })
    mockGetOrganizationSummary.mockResolvedValue({ llm_month_budget: { remaining_credits: '0.0000' } })
    const { useBillingStore } = await import('@/stores/useBillingStore')

    syncBillingBlockedFromWallet('wt-1')
    await vi.waitFor(() => {
      expect(useBillingStore.getState().billingBlocked).toBe(false)
    })
    expect(mockClearBalanceBillingErrors).toHaveBeenCalled()
  })

  it('summary 查询失败但钱包余额充足时仍解除 billingBlocked', async () => {
    mockGetOrganizationWallet.mockResolvedValue({ available_credits_precise: '5000.0000' })
    mockGetOrganizationSummary.mockRejectedValue(new Error('summary failed'))
    const { useBillingStore } = await import('@/stores/useBillingStore')

    syncBillingBlockedFromWallet('wt-1')
    await vi.waitFor(() => {
      expect(useBillingStore.getState().billingBlocked).toBe(false)
    })
  })

  it('isCurrent 返回 false 时不更新 store', async () => {
    mockGetOrganizationWallet.mockResolvedValue({ available_credits_precise: '5000.0000' })
    mockGetOrganizationSummary.mockResolvedValue({ llm_month_budget: { remaining_credits: '0.0000' } })
    const { useBillingStore } = await import('@/stores/useBillingStore')

    syncBillingBlockedFromWallet('wt-1', () => false)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(useBillingStore.getState().billingBlocked).toBe(true)
  })

  it('isBillingBlockedByAvailableCredits 与 MIN_SENDABLE_BALANCE 对齐', () => {
    expect(MIN_SENDABLE_BALANCE).toBe(0.01)
    expect(isBillingBlockedByAvailableCredits('0.0100')).toBe(false)
    expect(isBillingBlockedByAvailableCredits('0.0099')).toBe(true)
    expect(isBillingBlockedByAvailableCredits('0.0000', '100.0000')).toBe(false)
    expect(isBillingBlockedByAvailableCredits(undefined)).toBe(true)
  })
})
