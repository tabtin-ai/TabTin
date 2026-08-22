import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateViewMetadata: vi.fn(),
  getTabByView: vi.fn(),
  updateViewMeta: vi.fn(),
}))

vi.mock('../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({
    getTabByView: mocks.getTabByView,
    updateViewMetadata: mocks.updateViewMetadata,
  }),
}))

vi.mock('./CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({
    updateViewMeta: mocks.updateViewMeta,
  }),
}))

import { syncWorkspaceViewMetadata } from './view-metadata-sync'

describe('syncWorkspaceViewMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('会同时同步 WorkspaceTabManager 和 CrawlspaceContextHub', () => {
    mocks.getTabByView.mockReturnValue('cs-1')

    syncWorkspaceViewMetadata({
      viewId: 'view-1',
      title: 'New title',
      url: 'https://example.com',
      favicon: 'favicon.ico',
      runId: 'run-1',
      themeColor: '#123456',
    })

    expect(mocks.updateViewMetadata).toHaveBeenCalledWith('view-1', {
      title: 'New title',
      url: 'https://example.com',
      favicon: 'favicon.ico',
      runId: 'run-1',
    })
    expect(mocks.updateViewMeta).toHaveBeenCalledWith('cs-1', 'view-1', {
      title: 'New title',
      url: 'https://example.com',
      favicon: 'favicon.ico',
      runId: 'run-1',
      themeColor: '#123456',
    })
  })

  it('支持显式清空 themeColor 和 favicon', () => {
    mocks.getTabByView.mockReturnValue('cs-2')

    syncWorkspaceViewMetadata({
      viewId: 'view-2',
      favicon: null,
      themeColor: null,
    })

    expect(mocks.updateViewMetadata).toHaveBeenCalledWith('view-2', {
      favicon: undefined,
    })
    expect(mocks.updateViewMeta).toHaveBeenCalledWith('cs-2', 'view-2', {
      favicon: null,
      themeColor: null,
    })
  })
})
