import { describe, expect, it, vi } from 'vitest'

vi.mock('../webcontents/ViewStateRegistry', () => ({
  getViewStateRegistry: () => ({
    on: vi.fn(),
    off: vi.fn(),
  }),
}))

vi.mock('../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({
    getTabByView: vi.fn(),
    unregisterView: vi.fn(),
  }),
}))

vi.mock('../view-factory', () => ({
  getViewFactory: () => null,
}))

vi.mock('./CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({
    unregisterView: vi.fn(),
    setViewError: vi.fn(),
    setViewLoading: vi.fn(),
  }),
}))

import { buildBridgeViewMetaSyncInput } from './CrawlspaceContextBridge'
import type { ViewState } from '../webcontents/ViewStateRegistry'

function makeViewState(overrides?: Partial<ViewState>): ViewState {
  return {
    id: 'view-1',
    url: 'https://www.baidu.com',
    status: 'loaded',
    title: 'Baidu',
    favicon: 'https://www.baidu.com/favicon.ico',
    mode: 'preview',
    owner: 'shared',
    lastLoadTime: 0,
    lastAccessTime: 0,
    loadHistory: [],
    reusable: true,
    inUse: false,
    metadata: {
      createdBy: 'test',
      createdAt: 0,
      crawlspaceId: 'cs-1',
    },
    ...overrides,
  }
}

describe('buildBridgeViewMetaSyncInput', () => {
  it('URL 更新不会夹带旧 favicon', () => {
    const input = buildBridgeViewMetaSyncInput(
      'view-1',
      'cs-1',
      makeViewState({ url: 'https://www.xiaohongshu.com/explore' }),
      { url: 'https://www.xiaohongshu.com/explore' },
    )

    expect(input).toEqual({
      viewId: 'view-1',
      crawlspaceId: 'cs-1',
      url: 'https://www.xiaohongshu.com/explore',
    })
  })

  it('favicon 更新为 undefined 时会传递显式清空语义', () => {
    const input = buildBridgeViewMetaSyncInput(
      'view-1',
      'cs-1',
      makeViewState({ favicon: undefined }),
      { favicon: undefined },
    )

    expect(input).toEqual({
      viewId: 'view-1',
      crawlspaceId: 'cs-1',
      favicon: null,
    })
  })
})
