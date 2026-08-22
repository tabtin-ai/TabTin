import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const {
  mockSetCrawlspaceViewMeta,
  mockUpdateViewMeta,
  mockSetDisplayKey,
} = vi.hoisted(() => ({
  mockSetCrawlspaceViewMeta: vi.fn(),
  mockUpdateViewMeta: vi.fn().mockResolvedValue({ success: true }),
  mockSetDisplayKey: vi.fn(),
}))

vi.mock('@stores/useCrawlTabStore', () => {
  type TestCrawlConfig = {
    crawlspaceId: string
    browserScopeKey?: string
    spaceId: string
    profile: string
    partition: string
  }
  type TestCrawlStoreState = {
    crawlspaceConfigById: Record<string, TestCrawlConfig>
  }
  type TestCrawlStoreHook = {
    <T>(selector: (state: TestCrawlStoreState) => T): T
    getState: () => { setCrawlspaceViewMeta: typeof mockSetCrawlspaceViewMeta }
  }
  const useCrawlTabStore = ((selector) =>
    selector({
      crawlspaceConfigById: {
        'cs-1': {
          crawlspaceId: 'cs-1',
          spaceId: 'space-1',
          profile: 'organization',
          partition: 'tabtin:crawlspace:cs-1',
        },
        'cs-desktop': {
          crawlspaceId: 'cs-desktop',
          browserScopeKey: 'desktop:organization:wt-1:user:u-1',
          spaceId: 'space-1',
          profile: 'organization',
          partition: 'tabtin:crawlspace:cs-desktop',
        },
      },
    })) as TestCrawlStoreHook

  useCrawlTabStore.getState = () => ({
    setCrawlspaceViewMeta: mockSetCrawlspaceViewMeta,
  })

  return { useCrawlTabStore }
})

vi.mock('@stores/useSpaceContextTabsStore', () => {
  type TestContextTabsState = {
    setDisplayKey: typeof mockSetDisplayKey
    activeKeyBySpace: Record<string, string>
  }
  type TestContextTabsHook = {
    <T>(selector: (state: TestContextTabsState) => T): T
    getState: () => TestContextTabsState
  }
  const state = {
    setDisplayKey: mockSetDisplayKey,
    activeKeyBySpace: {
      'space-1': 'tabweb:wrong-space-view',
      'desktop:organization:wt-1:user:u-1': 'tabweb:view-desktop',
    },
  }
  const useSpaceContextTabsStore = ((selector) =>
    selector(state)) as TestContextTabsHook
  useSpaceContextTabsStore.getState = () => state
  return { useSpaceContextTabsStore }
})

vi.mock('@/crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: {
    updateViewMeta: mockUpdateViewMeta,
  },
}))

describe('useWorkspaceContext', () => {
  it('桌面 browser carrier 使用 browserScopeKey 判断 active，而不是 execution spaceId', async () => {
    const { useWorkspaceContext } = await import('./useWorkspaceContext')

    const { result } = renderHook(() =>
      useWorkspaceContext({
        tab: {
          id: 'view-desktop',
          name: 'Desktop Tab',
          url: 'about:blank',
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {
            crawlspaceId: 'cs-desktop',
            profile: 'organization',
            partition: 'tabtin:crawlspace:cs-desktop',
          },
        },
      }),
    )

    expect(result.current.spaceId).toBe('space-1')
    expect(result.current.browserScopeKey).toBe('desktop:organization:wt-1:user:u-1')
    expect(result.current.getActiveKeyNow()).toBe('tabweb:view-desktop')
  })

  it('updateLocation 只更新本地 crawlspace store，权威快照交由主进程事件链收敛', async () => {
    const { useWorkspaceContext } = await import('./useWorkspaceContext')

    const { result } = renderHook(() =>
      useWorkspaceContext({
        tab: {
          id: 'view-1',
          name: 'Tab 1',
          url: 'https://old.example',
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {
            crawlspaceId: 'cs-1',
            profile: 'organization',
            partition: 'tabtin:crawlspace:cs-1',
          },
        },
      }),
    )

    act(() => {
      result.current.updateLocation({
        title: 'New title',
        url: 'https://new.example',
        themeColor: undefined,
      })
    })

    expect(mockSetCrawlspaceViewMeta).toHaveBeenCalledWith('cs-1', 'view-1', {
      title: 'New title',
      url: 'https://new.example',
      themeColor: undefined,
    })
    expect(mockUpdateViewMeta).not.toHaveBeenCalled()
  })
})
