import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionPopover } from '../MentionPopover'

const {
  mockSearchOrganization,
  mockSearchSpace,
  mockListContextItems,
  mockOrganizationState,
  mockTableState,
  mockSpaceContextTabsState,
  mockCrawlTabState,
  mockGetHandler,
  mockBuildContextAttachment,
} = vi.hoisted(() => ({
  mockSearchOrganization: vi.fn(),
  mockSearchSpace: vi.fn(),
  mockListContextItems: vi.fn(),
  mockOrganizationState: {
    selectedOrganization: { id: 'organization-1' } as { id: string } | null,
  },
  mockTableState: {
    fields: [] as Array<{ id: string; name: string }>,
    selectedTable: null as { id: string } | null,
  },
  mockSpaceContextTabsState: {
    activeKeyBySpace: {} as Record<string, string | null>,
    displayKeyBySpace: {} as Record<string, string | null>,
    tabOrderBySpace: {} as Record<string, string[]>,
    itemsBySpace: {} as Record<string, Record<string, { type: string; id: string; title?: string; meta?: Record<string, unknown> }>>,
  },
  mockCrawlTabState: {
    spaceCrawlspaces: {} as Record<string, { id: string }>,
    activeViewByCrawlspace: {} as Record<string, string | null>,
    viewsByCrawlspace: {} as Record<string, Array<{
      viewId: string
      title: string
      url: string
      favicon?: string
      isClosing?: boolean
      createdAt: number
    }>>,
  },
  mockGetHandler: vi.fn((_: string): undefined | { attachToChat?: unknown; displayLabel?: string } => undefined),
  mockBuildContextAttachment: vi.fn((_: { type: string; id: string }): null | { refType: string; resourceId: string; label: string; meta?: Record<string, unknown> } => null),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOptions?: unknown) => {
      if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions
      if (
        defaultValueOrOptions
        && typeof defaultValueOrOptions === 'object'
        && 'defaultValue' in defaultValueOrOptions
        && typeof (defaultValueOrOptions as { defaultValue?: unknown }).defaultValue === 'string'
      ) {
        return (defaultValueOrOptions as { defaultValue: string }).defaultValue
      }
      return key
    },
  }),
}))

vi.mock('@tabtin/app-shell', () => ({
  ZIndex: { global: 1 },
  cn: (...inputs: Array<string | false | null | undefined>) => inputs.filter(Boolean).join(' '),
  registerResetAction: () => () => {},
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: Object.assign(
    () => ({}),
    {
      getState: () => mockSpaceContextTabsState,
    },
  ),
}))

vi.mock('@/stores/useCrawlTabStore', () => ({
  useCrawlTabStore: Object.assign(
    () => ({}),
    {
      getState: () => ({
        getSpaceCrawlspace: (spaceId: string) => mockCrawlTabState.spaceCrawlspaces[spaceId] ?? null,
        getActiveCrawlspaceViewId: (crawlspaceId: string) => mockCrawlTabState.activeViewByCrawlspace[crawlspaceId] ?? null,
        getCrawlspaceViews: (crawlspaceId: string) => mockCrawlTabState.viewsByCrawlspace[crawlspaceId] ?? [],
      }),
    },
  ),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  EmptyState: ({ title, className }: { title?: string; className?: string }) => (
    <div className={className}>{title}</div>
  ),
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  useOverlayContainer: () => null,
}))

vi.mock('@components/context-space/registry', () => {
  const MockIcon = ({ className }: { className?: string }) => <svg data-testid="mock-icon" className={className} />
  return {
    contextRegistry: {
      getMentionCategories: () => [
        { key: 'tabdata', label: 'TabData', icon: MockIcon, type: 'tabdata', color: 'text-info bg-info/10' },
        { key: 'tabdoc', label: 'TabDoc', icon: MockIcon, type: 'tabdoc', color: 'text-info bg-info/10' },
      ],
      normalizeMentionType: (type: string) => {
        if (type === 'tabdata') return 'table'
        if (type === 'tabdoc') return 'document'
        return type
      },
      getHandler: (type: string) => mockGetHandler(type),
      buildContextAttachment: (item: { type: string; id: string }) => mockBuildContextAttachment(item),
      parseTabKey: (tabKey: string) => {
        const index = tabKey.indexOf(':')
        if (index <= 0 || index === tabKey.length - 1) return null
        return { type: tabKey.slice(0, index), id: tabKey.slice(index + 1) }
      },
    },
  }
})

vi.mock('@/services/spaceApi', () => ({
  SpaceApiService: {
    searchOrganization: mockSearchOrganization,
    searchSpace: mockSearchSpace,
    listContextItems: mockListContextItems,
  },
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof mockOrganizationState) => unknown) => selector(mockOrganizationState),
}))

vi.mock('@/stores/useTableStore', () => ({
  useTableStore: (selector: (state: typeof mockTableState) => unknown) => selector(mockTableState),
}))

function makeContextItem(overrides: Record<string, unknown>) {
  return {
    id: 'item-1',
    item_type: 'tabdata',
    title: 'Visible Table',
    resource_id: 'table-1',
    space_id: 'space-1',
    space_name: 'Current Space',
    metadata: {},
    ...overrides,
  }
}

describe('MentionPopover', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    // 重置 open_tabs 相关 mock
    mockSpaceContextTabsState.activeKeyBySpace = {}
    mockSpaceContextTabsState.displayKeyBySpace = {}
    mockSpaceContextTabsState.tabOrderBySpace = {}
    mockSpaceContextTabsState.itemsBySpace = {}
    mockCrawlTabState.spaceCrawlspaces = {}
    mockCrawlTabState.activeViewByCrawlspace = {}
    mockCrawlTabState.viewsByCrawlspace = {}
    mockGetHandler.mockReset()
    mockBuildContextAttachment.mockReset()
    mockGetHandler.mockReturnValue(undefined)
    mockBuildContextAttachment.mockReturnValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('搜索模式会过滤 hidden/system 的 tabdata，但保留普通表和其他资源', async () => {
    mockSearchOrganization.mockResolvedValue({
      items: [
        makeContextItem({ title: 'Visible Table', metadata: { visibility: 'normal' } }),
        makeContextItem({ id: 'item-2', title: 'System Table', resource_id: 'table-2', metadata: { visibility: 'system' } }),
        makeContextItem({ id: 'item-3', title: 'Hidden Table', resource_id: 'table-3', metadata: { visibility: 'hidden' } }),
        makeContextItem({ id: 'item-4', item_type: 'tabdoc', title: 'Visible Doc', resource_id: 'doc-1', metadata: { visibility: 'hidden' } }),
      ],
      total: 4,
      page: 1,
      page_size: 15,
    })

    render(
      <MentionPopover
        open
        query="table"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        spaceId="space-1"
        spaceName="Current Space"
      />,
    )

    await waitFor(() => {
      expect(mockSearchOrganization).toHaveBeenCalledWith('organization-1', { q: 'table', page_size: 15 })
    }, { timeout: 1500 })

    await waitFor(() => {
      expect(screen.queryByText('Visible Table')).not.toBeNull()
      expect(screen.queryByText('Visible Doc')).not.toBeNull()
    }, { timeout: 1500 })

    expect(screen.queryByText('System Table')).toBeNull()
    expect(screen.queryByText('Hidden Table')).toBeNull()
  })

  it('分类模式在 TabData 二级列表中同样过滤 hidden/system 的表', async () => {
    mockListContextItems.mockResolvedValue({
      items: [
        makeContextItem({ title: 'Visible Category Table', metadata: { visibility: 'normal' } }),
        makeContextItem({ id: 'item-2', title: 'System Category Table', resource_id: 'table-2', metadata: { visibility: 'system' } }),
        makeContextItem({ id: 'item-3', title: 'Hidden Category Table', resource_id: 'table-3', metadata: { visibility: 'hidden' } }),
      ],
      total: 3,
      page: 1,
      page_size: 30,
    })

    render(
      <MentionPopover
        open
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        spaceId="space-1"
        spaceName="Current Space"
      />,
    )

    fireEvent.click(screen.getByText('TabData'))

    await waitFor(() => {
      expect(mockListContextItems).toHaveBeenCalledWith('space-1', {
        item_type: 'tabdata',
        page_size: 30,
        scope: 'organization',
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Visible Category Table')).not.toBeNull()
    })

    expect(screen.queryByText('System Category Table')).toBeNull()
    expect(screen.queryByText('Hidden Category Table')).toBeNull()
  })

  describe('「打开的标签」分类', () => {
    function setupCurrentWebView() {
      mockSpaceContextTabsState.displayKeyBySpace = {
        'space-1': 'tabweb:view-1',
      }
      mockCrawlTabState.spaceCrawlspaces = {
        'space-1': { id: 'crawlspace-1' },
      }
      mockCrawlTabState.activeViewByCrawlspace = {
        'crawlspace-1': 'view-1',
      }
      mockCrawlTabState.viewsByCrawlspace = {
        'crawlspace-1': [{
          viewId: 'view-1',
          title: 'Example Page',
          url: 'https://example.com/path',
          favicon: 'https://example.com/favicon.ico',
          createdAt: 1,
        }],
      }
    }

    /**
     * 用 mock 模拟当前 space 已打开的 3 个 tab：
     *   - tabdata:tab-1 (Sales) → buildContextAttachment 返回 ref（应展示）
     *   - tabweb:tab-2 (Google) → buildContextAttachment 返回 ref（应展示）
     *   - tabmail:tab-3 (Inbox) → buildContextAttachment 返回 null（应过滤）
     *
     * `buildOpenTabMentionItems` 的过滤路径有两处：handler 缺 attachToChat
     * 走第一道（getHandler?.attachToChat），buildContextAttachment 返回 null
     * 走第二道。这里用第二道（更接近"页面还没加载完，url 暂未拿到"的真实场景）。
     */
    function setupThreeOpenTabs() {
      mockSpaceContextTabsState.tabOrderBySpace = {
        'space-1': ['tabdata:tab-1', 'tabweb:tab-2', 'tabmail:tab-3'],
      }
      mockSpaceContextTabsState.itemsBySpace = {
        'space-1': {
          'tabdata:tab-1': { type: 'tabdata', id: 'tab-1', title: 'Sales' },
          'tabweb:tab-2': { type: 'tabweb', id: 'tab-2', title: 'Google' },
          'tabmail:tab-3': { type: 'tabmail', id: 'tab-3', title: 'Inbox' },
        },
      }

      // 三个 type 都声明了 attachToChat（能进 buildContextAttachment 这一关）
      mockGetHandler.mockImplementation((type: string) => {
        return { attachToChat: { refType: 'placeholder' }, displayLabel: type }
      })

      mockBuildContextAttachment.mockImplementation((item: { type: string; id: string }) => {
        if (item.type === 'tabdata' && item.id === 'tab-1') {
          return { refType: 'table', resourceId: 'tbl-1', label: 'Sales' }
        }
        if (item.type === 'tabweb' && item.id === 'tab-2') {
          return {
            refType: 'webpage',
            resourceId: 'https://google.com',
            label: 'Google',
            meta: { pageTitle: 'Google' },
          }
        }
        return null
      })
    }

    it('一级菜单会展示当前 Space 正在看的网页，即使它未写入 context tabs items', () => {
      setupCurrentWebView()
      const onSelect = vi.fn()

      render(
        <MentionPopover
          open
          query=""
          onSelect={onSelect}
          onClose={vi.fn()}
          spaceId="space-1"
          spaceName="Current Space"
        />,
      )

      expect(screen.queryByText('Example Page')).not.toBeNull()

      fireEvent.click(screen.getByText('Example Page'))

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
        type: 'webpage',
        resourceId: 'https://example.com/path',
        tabType: 'tabweb',
        label: 'Example Page',
        spaceId: 'space-1',
        meta: expect.objectContaining({
          pageTitle: 'Example Page',
          viewId: 'view-1',
        }),
      }))
    })

    it('当前展示的不是网页时，不把 crawlspace active view 当成当前网页展示', () => {
      setupCurrentWebView()
      mockSpaceContextTabsState.displayKeyBySpace = {
        'space-1': 'home',
      }

      render(
        <MentionPopover
          open
          query=""
          onSelect={vi.fn()}
          onClose={vi.fn()}
          spaceId="space-1"
          spaceName="Current Space"
        />,
      )

      expect(screen.queryByText('Example Page')).toBeNull()
    })

    it('打开的标签分类会把当前网页置顶，并按 resourceId 去重', () => {
      setupCurrentWebView()
      mockSpaceContextTabsState.tabOrderBySpace = {
        'space-1': ['tabweb:view-1'],
      }
      mockSpaceContextTabsState.itemsBySpace = {
        'space-1': {
          'tabweb:view-1': { type: 'tabweb', id: 'view-1', title: 'Example Page' },
        },
      }
      mockGetHandler.mockReturnValue({ attachToChat: { refType: 'webpage' }, displayLabel: 'Browser' })
      mockBuildContextAttachment.mockReturnValue({
        refType: 'webpage',
        resourceId: 'https://example.com/path',
        label: 'Example Page',
        meta: { pageTitle: 'Example Page' },
      })

      render(
        <MentionPopover
          open
          query=""
          onSelect={vi.fn()}
          onClose={vi.fn()}
          spaceId="space-1"
          spaceName="Current Space"
        />,
      )

      fireEvent.click(screen.getByText('打开的标签'))

      expect(screen.getAllByText('Example Page')).toHaveLength(1)
    })

    it('点击「打开的标签」分类只展示 buildContextAttachment 返回 ref 的 2 个 tab，第三个被过滤', () => {
      setupThreeOpenTabs()

      render(
        <MentionPopover
          open
          query=""
          onSelect={vi.fn()}
          onClose={vi.fn()}
          spaceId="space-1"
          spaceName="Current Space"
        />,
      )

      fireEvent.click(screen.getByText('打开的标签'))

      expect(screen.queryByText('Sales')).not.toBeNull()
      expect(screen.queryByText('Google')).not.toBeNull()
      // 第三个（tabmail）buildContextAttachment 返回 null，应被过滤
      expect(screen.queryByText('Inbox')).toBeNull()
    })

    it('选中第一个 tab 后 onSelect 收到带 tabType / type / resourceId 的 MentionItem', () => {
      setupThreeOpenTabs()
      const onSelect = vi.fn()

      render(
        <MentionPopover
          open
          query=""
          onSelect={onSelect}
          onClose={vi.fn()}
          spaceId="space-1"
          spaceName="Current Space"
        />,
      )

      fireEvent.click(screen.getByText('打开的标签'))
      fireEvent.click(screen.getByText('Sales'))

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
        type: 'table',
        resourceId: 'tbl-1',
        tabType: 'tabdata',
        label: 'Sales',
        spaceId: 'space-1',
      }))
    })
  })
})
