import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FtsSearchResultItem } from '@tabtin/app-shell'

const {
  mockActivateSpace,
  mockDispatchSelect,
  mockGetSpaceCrawlspace,
  mockResolveForegroundTabScopeKey,
  mockSetCurrentTab,
} = vi.hoisted(() => ({
  mockActivateSpace: vi.fn(() => true),
  mockDispatchSelect: vi.fn(),
  mockGetSpaceCrawlspace: vi.fn(() => ({ id: 'crawl-1' })),
  mockResolveForegroundTabScopeKey: vi.fn(() => 'desktop:organization:wt-1:user:u-1'),
  mockSetCurrentTab: vi.fn(),
}))

vi.mock('@tabtin/app-shell', () => ({
  useSpaceListStore: {
    getState: () => ({
      activateSpace: mockActivateSpace,
    }),
  },
}))

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: {
    normalizeBackendType: (type: string) => type,
    isKnownType: () => true,
    dispatchSelect: mockDispatchSelect,
  },
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: mockResolveForegroundTabScopeKey,
}))

vi.mock('@/services/chatSessionNavigation', () => ({
  enterChatSession: vi.fn(),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
      getSpaceCrawlspace: mockGetSpaceCrawlspace,
    }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedSpace: { id: 'space-1' },
    }),
  },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({
      setCurrentTab: mockSetCurrentTab,
    }),
  },
}))

vi.mock('@stores/useTabDocRevealStore', () => ({
  useTabDocRevealStore: {
    getState: () => ({
      setPendingReveal: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: { id: 'organization-1' },
    }),
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('./tabDocSearchReveal', () => ({
  buildTabDocSearchReveal: () => null,
  firstSearchString: () => '',
  textContainsSearchQuery: () => false,
}))

function makeResourceResult(): FtsSearchResultItem {
  return {
    id: 'search-row-1',
    type: 'resource',
    title: '今天中午吃什么',
    snippet: '螺蛳粉 火鸡面',
    highlight: {},
    creator_type: 'user',
    creator_id: 'user-1',
    creator_name: null,
    creator_avatar: null,
    space_id: 'space-1',
    space_name: '多比',
    session_id: null,
    session_title: null,
    resource_id: 'doc-1',
    score: 1,
    rrf_score: 0,
    created_at: '2026-06-09T02:02:55.509015+00:00',
    metadata: { item_type: 'tabdoc' },
  }
}

describe('navigateSearchResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens resource results in the foreground tab scope, not the legacy space bucket', async () => {
    const { navigateSearchResult } = await import('./searchResultNavigation')

    await navigateSearchResult(makeResourceResult(), { committedQuery: '螺蛳粉' })

    expect(mockActivateSpace).toHaveBeenCalledWith('space-1')
    expect(mockSetCurrentTab).toHaveBeenCalledWith('agent')
    expect(mockResolveForegroundTabScopeKey).toHaveBeenCalledWith('space-1')
    expect(mockGetSpaceCrawlspace).toHaveBeenCalledWith('desktop:organization:wt-1:user:u-1')
    expect(mockDispatchSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tabdoc',
        id: 'doc-1',
        tabKey: 'tabdoc:doc-1',
        title: '今天中午吃什么',
      }),
      expect.objectContaining({
        spaceId: 'space-1',
        tabScopeKey: 'desktop:organization:wt-1:user:u-1',
        crawlspaceId: 'crawl-1',
      }),
    )
  })
})
