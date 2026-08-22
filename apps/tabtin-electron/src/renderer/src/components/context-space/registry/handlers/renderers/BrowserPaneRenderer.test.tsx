import React from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPaneRenderer } from './BrowserPaneRenderer'

const {
  mockQuoteBrowserSelectionToChat,
  mockGetCrawlTabState,
  mockActivateBrowserView,
  mockRetryBrowserViewActivation,
  mockActivationState,
} = vi.hoisted(() => ({
  mockQuoteBrowserSelectionToChat: vi.fn(),
  mockGetCrawlTabState: vi.fn(),
  mockActivateBrowserView: vi.fn(),
  mockRetryBrowserViewActivation: vi.fn(),
  mockActivationState: vi.fn(() => ({ phase: 'idle' as const })),
}))

vi.mock('@components/crawl/portal/CrawlViewPortalHost', () => ({
  CrawlViewPortalHost: ({ viewId, className }: { viewId: string; className?: string }) => (
    <div data-testid="crawl-view-host" data-view-id={viewId} className={className} />
  ),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: Object.assign(
    (selector: (state: ReturnType<typeof mockGetCrawlTabState>) => unknown) => selector(mockGetCrawlTabState()),
    { getState: mockGetCrawlTabState },
  ),
}))

vi.mock('@/services/browserViewActivation', () => ({
  activateBrowserView: mockActivateBrowserView,
  retryBrowserViewActivation: mockRetryBrowserViewActivation,
  useBrowserViewActivationState: mockActivationState,
}))

vi.mock('./BrowserViewRecoveryPanel', () => ({
  BrowserViewRecoveryPanel: ({
    state,
    onRetry,
  }: {
    state: { phase: string }
    onRetry: () => void
  }) => (
    <div data-testid="browser-recovery" data-phase={state.phase}>
      <button type="button" onClick={onRetry}>retry</button>
    </div>
  ),
}))

vi.mock('@components/context-space/hooks/quoteBrowserSelectionToChat', () => ({
  quoteBrowserSelectionToChat: mockQuoteBrowserSelectionToChat,
}))

describe('BrowserPaneRenderer context menu integration', () => {
  let listener: ((payload: { viewId: string; selectionText: string }) => void) | null
  let unsubscribe: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockActivationState.mockReturnValue({ phase: 'idle' })
    listener = null
    unsubscribe = vi.fn()
    ;(window as unknown as {
      tabtin: {
        contextMenu: {
          setLocale: ReturnType<typeof vi.fn>
          onAddToContextRequest: (callback: (payload: { viewId: string; selectionText: string }) => void) => ReturnType<typeof vi.fn>
        }
      }
    }).tabtin = {
      contextMenu: {
        setLocale: vi.fn(),
        onAddToContextRequest: (callback) => {
          listener = callback
          return unsubscribe
        },
      },
    }
    mockGetCrawlTabState.mockReturnValue({
      crawlspaceDeferredViewIdsByCS: {},
      crawlspaceContextCache: {
        'cs-1': {
          viewList: [{
            viewId: 'view-1',
            title: 'Example',
            url: 'https://example.com/',
            favicon: 'https://example.com/favicon.ico',
            isPreview: false,
            crawlspaceId: 'cs-1',
          }],
        },
      },
    })
  })

  it('adds only the matching browser view to chat context', () => {
    const { unmount } = render(<BrowserPaneRenderer crawlspaceId="cs-1" viewId="view-1" isGroupActive />)

    act(() => {
      listener?.({ viewId: 'view-other', selectionText: 'Selected text' })
    })
    expect(mockQuoteBrowserSelectionToChat).not.toHaveBeenCalled()

    act(() => {
      listener?.({ viewId: 'view-1', selectionText: 'Selected text' })
    })
    expect(mockQuoteBrowserSelectionToChat).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Selected text',
        url: 'https://example.com/',
        viewId: 'view-1',
        title: 'Example',
        favicon: 'https://example.com/favicon.ico',
        crawlspaceId: 'cs-1',
      }),
    )

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('ignores empty selection payloads', () => {
    render(<BrowserPaneRenderer crawlspaceId="cs-1" viewId="view-1" isGroupActive />)

    act(() => {
      listener?.({ viewId: 'view-1', selectionText: '   ' })
    })

    expect(mockQuoteBrowserSelectionToChat).not.toHaveBeenCalled()
  })

  it('passes canvas card radius classes to the portal host', () => {
    const { getByTestId } = render(<BrowserPaneRenderer crawlspaceId="cs-1" viewId="view-1" isGroupActive />)

    expect(getByTestId('crawl-view-host').className).toContain('overflow-hidden')
    expect(getByTestId('crawl-view-host').className).toContain('rounded-[12px]')
  })

  it('活动 pane 遇到 deferred 标签时显示恢复态并触发统一激活', () => {
    mockGetCrawlTabState.mockReturnValue({
      crawlspaceDeferredViewIdsByCS: { 'cs-1': new Set(['view-1']) },
      crawlspaceContextCache: { 'cs-1': { viewList: [] } },
    })

    const { getByTestId } = render(
      <BrowserPaneRenderer
        crawlspaceId="cs-1"
        viewId="view-1"
        isGroupActive
        isPaneActive
      />,
    )

    expect(getByTestId('browser-recovery').getAttribute('data-phase')).toBe('restoring')
    expect(mockActivateBrowserView).toHaveBeenCalledWith('cs-1', 'view-1')
  })

  it('恢复失败时保留失败面板并允许重试', () => {
    mockActivationState.mockReturnValue({ phase: 'failed', code: 'create_failed' })
    mockGetCrawlTabState.mockReturnValue({
      crawlspaceDeferredViewIdsByCS: { 'cs-1': new Set(['view-1']) },
      crawlspaceContextCache: { 'cs-1': { viewList: [] } },
    })

    const { getByRole, getByTestId } = render(
      <BrowserPaneRenderer
        crawlspaceId="cs-1"
        viewId="view-1"
        isGroupActive
        isPaneActive
      />,
    )

    expect(getByTestId('browser-recovery').getAttribute('data-phase')).toBe('failed')
    getByRole('button', { name: 'retry' }).click()
    expect(mockRetryBrowserViewActivation).toHaveBeenCalledWith('cs-1', 'view-1')
  })
})
