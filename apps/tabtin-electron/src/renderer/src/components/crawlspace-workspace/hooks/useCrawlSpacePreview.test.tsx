import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const {
  mockCreateView,
  mockSetActiveView,
  mockUpdateViewMeta,
  mockSetCrawlspaceViewMeta,
  mockSavePreviewState,
  mockGetPreviewState,
} = vi.hoisted(() => ({
  mockCreateView: vi.fn(),
  mockSetActiveView: vi.fn().mockResolvedValue({ success: true }),
  mockUpdateViewMeta: vi.fn().mockResolvedValue({ success: true }),
  mockSetCrawlspaceViewMeta: vi.fn(),
  mockSavePreviewState: vi.fn(),
  mockGetPreviewState: vi.fn(),
}))

vi.mock('@stores/useCrawlTabStore', () => {
  const useCrawlTabStore = ((selector: (state: any) => unknown) =>
    selector({
      saveCrawlspacePreviewState: mockSavePreviewState,
      getCrawlspacePreviewState: mockGetPreviewState,
    })) as any

  useCrawlTabStore.getState = () => ({
    setCrawlspaceViewMeta: mockSetCrawlspaceViewMeta,
  })

  return { useCrawlTabStore }
})

vi.mock('@/crawlspace/electron/crawlspace-view-client', () => ({
  crawlspaceViewClient: {
    createView: mockCreateView,
  },
}))

vi.mock('@/crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: {
    setActiveView: mockSetActiveView,
    updateViewMeta: mockUpdateViewMeta,
  },
}))

vi.mock('@/crawlspace/registry', () => ({
  getCrawlspaceConfig: () => ({
    profile: 'organization',
    partition: 'tabtin:crawlspace:cs-1',
  }),
}))

describe('useWorkspacePreview', () => {
  it('创建 preview view 时不再重复回写 isPreview=true，但清理时仍会同步 false', async () => {
    mockGetPreviewState.mockReturnValue(null)
    mockCreateView.mockResolvedValue({
      success: true,
      viewId: 'view-preview-1',
    })

    const { useWorkspacePreview } = await import('./useCrawlSpacePreview')
    const { result } = renderHook(() =>
      useWorkspacePreview({
        crawlspaceId: 'cs-1',
        isActive: true,
      }),
    )

    await act(async () => {
      await result.current.ensurePreview('example.com')
    })

    expect(mockCreateView).toHaveBeenCalledWith(expect.objectContaining({
      crawlspaceId: 'cs-1',
      isPreview: true,
    }))
    expect(mockSetActiveView).toHaveBeenCalledWith('cs-1', 'view-preview-1')
    expect(mockSetCrawlspaceViewMeta).toHaveBeenCalledWith('cs-1', 'view-preview-1', { isPreview: true })
    expect(mockUpdateViewMeta).not.toHaveBeenCalledWith('cs-1', 'view-preview-1', { isPreview: true })

    act(() => {
      result.current.clearPreview()
    })

    expect(mockUpdateViewMeta).toHaveBeenCalledWith('cs-1', 'view-preview-1', { isPreview: false })
  })
})
