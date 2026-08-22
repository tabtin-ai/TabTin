import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetWebContents,
  mockRefreshResourceInterception,
  mockHandleBlockedPreviewLoad,
  mockGetMainWindow,
} = vi.hoisted(() => ({
  mockGetWebContents: vi.fn(),
  mockRefreshResourceInterception: vi.fn(),
  mockHandleBlockedPreviewLoad: vi.fn(() => true),
  mockGetMainWindow: vi.fn(() => ({ id: 1 })),
}))

// : content-ops 已改走 getWebContents（容器无关），mock 面同步收窄
vi.mock('../../view-factory', () => ({
  getViewFactory: () => ({
    getWebContents: mockGetWebContents,
    refreshResourceInterception: mockRefreshResourceInterception,
  }),
}))

vi.mock('../../webcontents/ViewStateRegistry', () => ({
  waitForViewState: vi.fn(),
  getViewStateRegistry: vi.fn(),
}))

vi.mock('../../window-manager', () => ({
  getMainWindow: mockGetMainWindow,
}))

vi.mock('../../blocked-preview-load', () => ({
  handleBlockedPreviewLoad: mockHandleBlockedPreviewLoad,
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { loadUrl } from '../content-ops'

describe('content-ops loadUrl timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetWebContents.mockReset()
    mockRefreshResourceInterception.mockReset()
    mockHandleBlockedPreviewLoad.mockClear()
    mockGetMainWindow.mockClear()
  })

  it('times out webContents.loadURL itself and stops navigation', async () => {
    const stop = vi.fn()
    mockGetWebContents.mockReturnValue({
      isDestroyed: () => false,
      getURL: () => 'https://example.com/loading',
      stop,
      loadURL: vi.fn(() => new Promise(() => {})),
    })

    const result = await loadUrl('tab-timeout', 'https://example.com', { timeout: 5 })

    expect(result.success).toBe(false)
    expect(result.status).toBe('timeout')
    expect(result.error).toContain('loadURL timeout')
    expect(stop).toHaveBeenCalled()
  })

  it('forceBrowser=true keeps Agent/crawl loading previewable URLs in BrowserView', async () => {
    const loadURL = vi.fn(() => Promise.resolve())
    mockGetWebContents.mockReturnValue({
      isDestroyed: () => false,
      getURL: () => 'https://cdn.example.com/report.xlsx',
      stop: vi.fn(),
      loadURL,
    })

    const result = await loadUrl('tab-agent', 'https://cdn.example.com/report.xlsx', {
      waitUntil: 'load',
      forceBrowser: true,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('loaded')
    expect(loadURL).toHaveBeenCalledWith('https://cdn.example.com/report.xlsx')
  })

  it('forceBrowser=false returns PREVIEW_REQUIRED for previewable URLs', async () => {
    const loadURL = vi.fn(() => Promise.resolve())
    mockGetWebContents.mockReturnValue({
      isDestroyed: () => false,
      getURL: () => 'https://cdn.example.com/report.xlsx',
      stop: vi.fn(),
      loadURL,
    })

    const result = await loadUrl('tab-user', 'https://cdn.example.com/report.xlsx', {
      waitUntil: 'load',
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('PREVIEW_REQUIRED')
    expect(result.intent).toMatchObject({ kind: 'preview', previewKind: 'xlsx' })
    expect(loadURL).not.toHaveBeenCalled()
    expect(mockHandleBlockedPreviewLoad).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://cdn.example.com/report.xlsx',
        source: 'content-ops.loadUrl',
        mainWindow: { id: 1 },
      }),
    )
  })
})
