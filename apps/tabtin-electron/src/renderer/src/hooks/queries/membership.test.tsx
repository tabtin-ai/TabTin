import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

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

vi.mock('./billing', () => ({
  billingKeys: { all: ['billing'] },
}))

vi.mock('./memberBudget', () => ({
  memberBudgetKeys: { all: ['memberBudget'] },
}))

vi.mock('./storage', () => ({
  storageKeys: { all: ['storage'] },
}))

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('membership queries', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockGetOrganizationWallet.mockResolvedValue({
      organization_id: 'wt-1',
      credits: 5000,
      credits_precise: '5000.0000',
      credits_frozen: 0,
      credits_frozen_precise: '0.0000',
      available_credits: 5000,
      available_credits_precise: '5000.0000',
    })
    mockGetOrganizationSummary.mockResolvedValue({
      llm_month_budget: {
        remaining_credits: '0.0000',
      },
    })

    const { useBillingStore } = await import('@/stores/useBillingStore')
    useBillingStore.getState().setBillingBlocked(true)
  })

  it('syncs wallet query result into the chat billing guard', async () => {
    const { useWalletQuery } = await import('./membership')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    renderHook(() => useWalletQuery('wt-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
      expect(useBillingStore.getState().billingBlocked).toBe(false)
    })
  })

  it('keeps billing blocked when wallet available credits are below send threshold', async () => {
    mockGetOrganizationWallet.mockResolvedValue({
      organization_id: 'wt-1',
      credits: 0,
      credits_precise: '0.0000',
      credits_frozen: 0,
      credits_frozen_precise: '0.0000',
      available_credits: 0,
      available_credits_precise: '0.0000',
    })

    const { useWalletQuery } = await import('./membership')
    const { useBillingStore } = await import('@/stores/useBillingStore')
    useBillingStore.getState().setBillingBlocked(false)

    renderHook(() => useWalletQuery('wt-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
      expect(useBillingStore.getState().billingBlocked).toBe(true)
    })
  })

  it('allows chat when wallet is empty but included LLM quota remains', async () => {
    mockGetOrganizationWallet.mockResolvedValue({
      organization_id: 'wt-1',
      credits: 0,
      credits_precise: '0.0000',
      credits_frozen: 0,
      credits_frozen_precise: '0.0000',
      available_credits: 0,
      available_credits_precise: '0.0000',
    })
    mockGetOrganizationSummary.mockResolvedValue({
      llm_month_budget: {
        remaining_credits: '100.0000',
      },
    })

    const { useWalletQuery } = await import('./membership')
    const { useBillingStore } = await import('@/stores/useBillingStore')
    useBillingStore.getState().setBillingBlocked(true)

    renderHook(() => useWalletQuery('wt-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
      expect(mockGetOrganizationSummary).toHaveBeenCalledWith('wt-1', { days: 1 })
      expect(useBillingStore.getState().billingBlocked).toBe(false)
    })
  })

  it('ignores wallet results for a different organization', async () => {
    mockGetOrganizationWallet.mockResolvedValue({
      organization_id: 'wt-other',
      credits: 5000,
      credits_precise: '5000.0000',
      credits_frozen: 0,
      credits_frozen_precise: '0.0000',
      available_credits: 5000,
      available_credits_precise: '5000.0000',
    })

    const { useWalletQuery } = await import('./membership')
    const { useBillingStore } = await import('@/stores/useBillingStore')

    renderHook(() => useWalletQuery('wt-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(mockGetOrganizationWallet).toHaveBeenCalledWith('wt-1')
      expect(useBillingStore.getState().billingBlocked).toBe(true)
    })
  })
})
