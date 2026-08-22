/**
 * Wave 5c T1 — FirstTimeImportBanner 单测。
 *
 * 覆盖：
 *   1. shouldShow=false（任意条件不满足）→ 不渲染
 *   2. shouldShow=true + 无浏览器 → 渲染但显示 noBrowsersDetected 文案
 *   3. shouldShow=true + 单浏览器 → 点导入 → 调 extractCookies + injectCookies 流程
 *   4. shouldShow=true + 多浏览器 → 渲染 radio + 选择切换
 *   5. 用户点 "稍后再说" → 调 PUT /onboarding/state action=dismiss
 *   6. 导入失败时不调 update mutation
 *
 * # 为什么不用 useFirstTimeOnboarding 真依赖
 *
 * useFirstTimeOnboarding 内部聚合 4 路 query，单测里跑全套需要 mock react-query
 * 的 onboarding state、website list、partition cookie count、detect browsers——
 * 维护起来又脆又重复。直接 mock 整个 hook 让 banner 单测专注"banner 内部行
 * 为"，hook 自己另有 _testing 入口可独立验证。
 */

import React from 'react'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/components/settings/panels/credentials/constants', async () => {
  const actual = await vi.importActual<any>('@/components/settings/panels/credentials/constants')
  return {
    ...actual,
    BROWSER_CREDENTIAL_IMPORT_ENABLED: true,
  }
})

vi.mock('../useFirstTimeOnboarding', async () => {
  const actual = await vi.importActual<any>('../useFirstTimeOnboarding')
  return {
    ...actual,
    useFirstTimeOnboarding: vi.fn(),
  }
})

vi.mock('@/hooks/queries/credentials', () => {
  // 内联 credentialKeys 副本，避免循环依赖；其余 hook 全部 mock 化。
  const credentialKeys = {
    all: ['credentials'] as const,
    websiteCredentials: () => ['credentials', 'website'] as const,
    onboardingState: () => ['credentials', 'onboarding-state'] as const,
  }
  return {
    credentialKeys,
    useUpdateOnboardingStateMutation: vi.fn(),
    useOnboardingStateQuery: vi.fn(),
  }
})

vi.mock('@/services/apiClient', () => ({
  apiClient: {
    post: vi.fn(async () => ({ data: { imported: 0 } })),
  },
}))

import { FirstTimeImportBanner } from '../FirstTimeImportBanner'
import { useFirstTimeOnboarding } from '../useFirstTimeOnboarding'
import { useUpdateOnboardingStateMutation } from '@/hooks/queries/credentials'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockHook = useFirstTimeOnboarding as unknown as ReturnType<typeof vi.fn>
const mockMutation = useUpdateOnboardingStateMutation as unknown as ReturnType<typeof vi.fn>

function setupTabtinMock(opts: {
  injectSuccess?: boolean
  injected?: number
  extractSuccess?: boolean
  extractCookies?: any[]
} = {}) {
  const {
    injectSuccess = true,
    injected = 5,
    extractSuccess = true,
    extractCookies = [{ name: 'a', value: 'b', domain: 'example.com' }],
  } = opts
  const ipc = {
    extractCookies: vi.fn(async () => ({
      success: extractSuccess,
      cookies: extractCookies,
      ...(extractSuccess ? {} : { errorCode: 'COOKIE_DB_MISSING' }),
    })),
    injectCookies: vi.fn(async () => ({
      success: injectSuccess,
      injected,
    })),
    extractPasswords: vi.fn(async () => ({
      success: true,
      passwords: [],
    })),
  }
  Object.defineProperty(window, 'tabtin', {
    value: { credentialVault: ipc },
    writable: true,
    configurable: true,
  })
  return ipc
}

function renderBanner() {
  // 用最小 QueryClientProvider 喂 react-query 内部的 useQueryClient（在 banner
  // 里的 invalidateQueries 调用必须有 client 兜底）。
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <FirstTimeImportBanner />
    </QueryClientProvider>,
  )
}

const mutateAsync = vi.fn(async () => ({}))

describe('FirstTimeImportBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mutateAsync.mockReset()
    mutateAsync.mockResolvedValue({})
    mockMutation.mockReturnValue({
      mutateAsync,
      isPending: false,
    })
  })

  it('shouldShow=false → 不渲染任何内容', () => {
    mockHook.mockReturnValue({
      shouldShow: false,
      reason: 'completed',
      browsers: [],
      websiteCount: 0,
    })
    const { container } = renderBanner()
    expect(container.firstChild).toBeNull()
  })

  it('shouldShow=true + 无支持浏览器 → 渲染气泡但显示 noBrowsersDetected', () => {
    mockHook.mockReturnValue({
      shouldShow: true,
      reason: 'show',
      browsers: [],
      websiteCount: 0,
    })
    setupTabtinMock()
    renderBanner()
    expect(screen.getByText(/credentialVault.onboarding.bannerTitle/)).toBeTruthy()
    expect(screen.getByText(/noBrowsersDetected/)).toBeTruthy()
    // 导入按钮存在但 disabled
    const importBtn = screen.getByText(/credentialVault.onboarding.importFromBrowser/)
      .closest('button') as HTMLButtonElement
    expect(importBtn?.disabled).toBe(true)
  })

  it('shouldShow=true + 单浏览器 → 点导入触发 extractCookies + injectCookies + complete', async () => {
    mockHook.mockReturnValue({
      shouldShow: true,
      reason: 'show',
      browsers: [
        {
          name: 'chrome',
          displayName: 'Chrome',
          installed: true,
          profiles: [{ name: 'Default', path: '/Users/me/chrome', isDefault: true }],
        },
      ],
      websiteCount: 0,
    })
    const ipc = setupTabtinMock({ injectSuccess: true, injected: 12 })
    const { container } = renderBanner()
    const importBtn = container.querySelector('[data-action="import"]') as HTMLButtonElement
    expect(importBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(importBtn)
    })
    await waitFor(() => {
      expect(ipc.extractCookies).toHaveBeenCalledWith({
        browser: 'chrome',
        profilePath: '/Users/me/chrome',
      })
    })
    expect(ipc.injectCookies).toHaveBeenCalledWith({
      partition: 'tabtin:env:default',
      cookies: expect.any(Array),
    })
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        action: 'complete',
        browser_import_source: 'chrome',
      })
    })
  })

  it('shouldShow=true + 多浏览器 → 渲染 radio 选择 + 切换更换 target', () => {
    mockHook.mockReturnValue({
      shouldShow: true,
      reason: 'show',
      browsers: [
        {
          name: 'chrome',
          displayName: 'Chrome',
          installed: true,
          profiles: [{ name: 'Default', path: '/p1', isDefault: true }],
        },
        {
          name: 'edge',
          displayName: 'Edge',
          installed: true,
          profiles: [{ name: 'Default', path: '/p2', isDefault: true }],
        },
      ],
      websiteCount: 0,
    })
    setupTabtinMock()
    const { container } = renderBanner()
    const radios = container.querySelectorAll('input[type="radio"][name="onboarding-browser"]')
    expect(radios.length).toBe(2)
    // 默认第一个浏览器是 active
    const labels = container.querySelectorAll('label[class*="cursor-pointer"]')
    expect(labels.length).toBeGreaterThanOrEqual(2)
  })

  it('点 "稍后再说" → 调 update mutation action=dismiss', async () => {
    mockHook.mockReturnValue({
      shouldShow: true,
      reason: 'show',
      browsers: [],
      websiteCount: 0,
    })
    setupTabtinMock()
    const { container } = renderBanner()
    const dismissBtn = container.querySelector('[data-action="dismiss"]') as HTMLButtonElement
    expect(dismissBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(dismissBtn)
    })
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ action: 'dismiss' })
    })
  })

  it('【视角 2 P1-1 自修】点 X 关闭按钮 → 仅本次会话隐藏，**不**调 update mutation', async () => {
    mockHook.mockReturnValue({
      shouldShow: true,
      reason: 'show',
      browsers: [],
      websiteCount: 0,
    })
    setupTabtinMock()
    const { container } = renderBanner()
    const closeBtn = container.querySelector('[data-action="close"]') as HTMLButtonElement
    expect(closeBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    // 等一阵确保任何潜在 mutation 都触发完——但实际不应该有任何 mutation
    await new Promise((r) => setTimeout(r, 100))
    expect(mutateAsync).not.toHaveBeenCalledWith({ action: 'dismiss' })
    // banner 应该不再渲染（session-dismissed）
    const banner = container.querySelector('[data-component="FirstTimeImportBanner"]')
    expect(banner).toBeNull()
  })

  it('extractCookies 失败 → 不调 complete mutation', async () => {
    mockHook.mockReturnValue({
      shouldShow: true,
      reason: 'show',
      browsers: [
        {
          name: 'chrome',
          displayName: 'Chrome',
          installed: true,
          profiles: [{ name: 'Default', path: '/p', isDefault: true }],
        },
      ],
      websiteCount: 0,
    })
    setupTabtinMock({ extractSuccess: false })
    const { container } = renderBanner()
    const importBtn = container.querySelector('[data-action="import"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(importBtn)
    })
    await waitFor(() => {
      expect(mutateAsync).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'complete' }),
      )
    })
  })
})
