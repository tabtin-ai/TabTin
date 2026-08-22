/**
 * Wave 5c T1 — useFirstTimeOnboarding 触发条件单测。
 *
 * 覆盖：
 *   1. dismissed_at 已写 → shouldShow=false（reason='dismissed'）
 *   2. browser_import_completed_at 已写 → shouldShow=false（reason='completed'）
 *   3. websiteCount > 0 → shouldShow=false（reason='has-credentials'）
 *   4. cookieCount > 0 → shouldShow=false（reason='has-cookies'）
 *   5. 全部空白 → shouldShow=true
 *   6. enabled=false → 短路（不发起任何 query）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// 先 hoist mock 实例
const hoisted = vi.hoisted(() => ({
  useOnboardingStateQuery: vi.fn(),
  useDetectBrowsers: vi.fn(),
  apiGet: vi.fn(),
  ipcGetPartitionCookies: vi.fn(),
}))

vi.mock('@/hooks/queries/credentials', async () => {
  const actual = await vi.importActual<any>('@/hooks/queries/credentials')
  return {
    ...actual,
    useOnboardingStateQuery: (opts?: any) => hoisted.useOnboardingStateQuery(opts),
  }
})

vi.mock('@/components/settings/panels/credentials/useDetectBrowsers', () => ({
  useDetectBrowsers: () => hoisted.useDetectBrowsers(),
}))

vi.mock('@/services/apiClient', () => ({
  apiClient: {
    get: (...args: any[]) => hoisted.apiGet(...args),
  },
}))

import { useFirstTimeOnboarding } from '../useFirstTimeOnboarding'

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  })
  // eslint-disable-next-line react/display-name
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

beforeEach(() => {
  hoisted.useDetectBrowsers.mockReturnValue({
    browsers: [
      {
        name: 'chrome',
        displayName: 'Chrome',
        installed: true,
        profiles: [{ name: 'Default', path: '/p', isDefault: true }],
      },
    ],
    detecting: false,
    refresh: vi.fn(),
  })
  // 默认 IPC：无 cookie
  ;(window as any).tabtin = {
    credentialVault: {
      getPartitionCookies: (...args: any[]) =>
        hoisted.ipcGetPartitionCookies(...args),
    },
  }
  hoisted.ipcGetPartitionCookies.mockResolvedValue({
    success: true,
    summary: { totalCount: 0 },
  })
  hoisted.apiGet.mockResolvedValue({ data: [] })
})

describe('useFirstTimeOnboarding', () => {
  it('dismissed_at 已写 → reason=dismissed', async () => {
    hoisted.useOnboardingStateQuery.mockReturnValue({
      data: {
        onboarding_dismissed_at: '2026-04-26T00:00:00Z',
        browser_import_completed_at: null,
        browser_import_source: '',
      },
      isLoading: false,
    })
    const { result } = renderHook(() => useFirstTimeOnboarding(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => {
      expect(result.current.reason).toBe('dismissed')
      expect(result.current.shouldShow).toBe(false)
    })
  })

  it('completed_at 已写 → reason=completed', async () => {
    hoisted.useOnboardingStateQuery.mockReturnValue({
      data: {
        onboarding_dismissed_at: null,
        browser_import_completed_at: '2026-04-26T00:00:00Z',
        browser_import_source: 'chrome',
      },
      isLoading: false,
    })
    const { result } = renderHook(() => useFirstTimeOnboarding(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => {
      expect(result.current.reason).toBe('completed')
    })
  })

  it('websiteCount > 0 → reason=has-credentials', async () => {
    hoisted.useOnboardingStateQuery.mockReturnValue({
      data: {
        onboarding_dismissed_at: null,
        browser_import_completed_at: null,
        browser_import_source: '',
      },
      isLoading: false,
    })
    hoisted.apiGet.mockResolvedValue({
      data: [{ id: 'w1', url: 'https://github.com' }],
    })
    const { result } = renderHook(() => useFirstTimeOnboarding(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => {
      expect(result.current.reason).toBe('has-credentials')
      expect(result.current.shouldShow).toBe(false)
    })
  })

  it('cookieCount > 0 → reason=has-cookies', async () => {
    hoisted.useOnboardingStateQuery.mockReturnValue({
      data: {
        onboarding_dismissed_at: null,
        browser_import_completed_at: null,
        browser_import_source: '',
      },
      isLoading: false,
    })
    hoisted.apiGet.mockResolvedValue({ data: [] })
    hoisted.ipcGetPartitionCookies.mockResolvedValue({
      success: true,
      summary: { totalCount: 12 },
    })
    const { result } = renderHook(() => useFirstTimeOnboarding(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => {
      expect(result.current.reason).toBe('has-cookies')
      expect(result.current.shouldShow).toBe(false)
    })
  })

  it('全部空白 → shouldShow=true（reason=show）', async () => {
    hoisted.useOnboardingStateQuery.mockReturnValue({
      data: {
        onboarding_dismissed_at: null,
        browser_import_completed_at: null,
        browser_import_source: '',
      },
      isLoading: false,
    })
    hoisted.apiGet.mockResolvedValue({ data: [] })
    hoisted.ipcGetPartitionCookies.mockResolvedValue({
      success: true,
      summary: { totalCount: 0 },
    })
    const { result } = renderHook(() => useFirstTimeOnboarding(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => {
      expect(result.current.reason).toBe('show')
      expect(result.current.shouldShow).toBe(true)
    })
  })

  it('enabled=false → shouldShow=false 且 reason=loading（短路）', async () => {
    hoisted.useOnboardingStateQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
    })
    const { result } = renderHook(() => useFirstTimeOnboarding({ enabled: false }), {
      wrapper: makeWrapper(),
    })
    expect(result.current.shouldShow).toBe(false)
    expect(result.current.reason).toBe('loading')
  })

  it('【视角 1 P1-5 自修】cookie IPC 失败 → shouldShow=false（保守不展示，避免覆盖现有 session）', async () => {
    hoisted.useOnboardingStateQuery.mockReturnValue({
      data: {
        onboarding_dismissed_at: null,
        browser_import_completed_at: null,
        browser_import_source: '',
      },
      isLoading: false,
    })
    hoisted.apiGet.mockResolvedValue({ data: [] })
    // IPC 永久失败（包括 retry 1 次后仍失败）
    hoisted.ipcGetPartitionCookies.mockRejectedValue(new Error('ipc dead'))
    const { result } = renderHook(() => useFirstTimeOnboarding(), {
      wrapper: makeWrapper(),
    })
    // 等所有 query 状态收敛
    await waitFor(
      () => {
        expect(result.current.shouldShow).toBe(false)
      },
      { timeout: 3000 },
    )
  })
})
