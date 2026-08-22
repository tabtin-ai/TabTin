import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopSidebarPanel } from './DesktopSidebarPanel'
import type { ContextItem } from './registry/types'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'

const desktopItem: ContextItem = {
  type: 'desktop_home',
  id: 'current',
  tabKey: 'desktop_home:current',
  title: '桌面',
}

const browserItem: ContextItem = {
  type: 'tabweb',
  id: 'view-1',
  tabKey: 'tabweb:view-1',
  title: 'Example',
}

const docItem: ContextItem = {
  type: 'tabdoc',
  id: 'doc-1',
  tabKey: 'tabdoc:doc-1',
  title: 'Doc',
}

const tableItem: ContextItem = {
  type: 'tabdata',
  id: 'table-1',
  tabKey: 'tabdata:table-1',
  title: 'Table',
}

const skillAppHomeItem: ContextItem = {
  type: 'apphome',
  id: 'skill',
  tabKey: 'apphome:skill',
  title: 'Skill',
  meta: { appId: 'skill', displayLabel: 'Skill' },
}

const regularAppHomeItem: ContextItem = {
  type: 'apphome',
  id: 'tabdoc',
  tabKey: 'apphome:tabdoc',
  title: '文档',
  meta: { appId: 'tabdoc' },
}

const boundDirectoryAppHomeItem: ContextItem = {
  type: 'apphome',
  id: 'orchestration-space-office',
  tabKey: 'apphome:orchestration-space-office',
  title: 'default-space-office-preview-cases',
  meta: {
    appId: 'orchestration',
    targetSpaceId: 'space-office',
    spaceId: 'space-office',
  },
}

const mockCreateWebTab = vi.fn()
const mockCreateTerminal = vi.fn()
const mockCloseItem = vi.fn()
const mockRestoreGroup = vi.fn()
const mockOpenResourceTab = vi.fn()
const mockSetActiveKey = vi.fn()
const mockCreateGroup = vi.fn()
const mockAssignPaneContent = vi.fn()
const mockSplitPaneWithContent = vi.fn()
const mockClosePane = vi.fn()
const mockSetActivePane = vi.fn()

const group: CanvasLayoutGroup = {
  id: 'group-1',
  spaceId: 'desktop:wt-1:user-1',
  anchorTabKey: 'tabweb:view-1',
  panes: [
    { id: 'pane-1', content: { tabKey: 'tabweb:view-1' } },
    { id: 'pane-2', content: { tabKey: 'tabdoc:doc-1' } },
  ],
  layout: {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [
      { type: 'leaf', paneId: 'pane-1' },
      { type: 'leaf', paneId: 'pane-2' },
    ],
    sizes: [0.5, 0.5],
  },
  activePaneId: 'pane-1',
  createdAt: 1,
  updatedAt: 1,
}

let mockState = {
  visibleItems: [desktopItem, browserItem],
  tabLookupItems: [desktopItem, browserItem],
  canvasGroups: [] as CanvasLayoutGroup[],
  activeTabKey: 'desktop_home:current',
  tabScopeKey: 'desktop:wt-1:user-1',
  spaceId: 'space-1',
  creatingAppIds: new Set<string>(),
}

const mockSpaceApps = [
  {
    id: 'tabdata',
    name: 'tabdata',
    icon: '',
    can_create: false,
    searchable: false,
    enabled: true,
    order: 0,
    surface: 'collaborative',
    distribution: 'builtin',
  },
  {
    id: 'market-app',
    name: 'market-app',
    icon: '',
    can_create: false,
    searchable: false,
    enabled: true,
    order: 0,
    surface: 'collaborative',
    distribution: 'marketplace',
  },
]

function createDataTransfer() {
  const data = new Map<string, string>()
  return {
    types: [] as string[],
    effectAllowed: '',
    setData(type: string, value: string) {
      if (!data.has(type)) this.types.push(type)
      data.set(type, value)
    },
    getData(type: string) {
      return data.get(type) ?? ''
    },
  }
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; app?: string }) =>
      (options?.defaultValue ?? _key).replace('{{app}}', options?.app ?? ''),
  }),
}))

vi.mock('@stores/useSpaceApps', () => ({
  useSpaceApps: (selector: (state: { appsBySpace: Record<string, typeof mockSpaceApps> }) => unknown) =>
    selector({ appsBySpace: { 'space-1': mockSpaceApps } }),
}))

vi.mock('./SpaceContextAreaContext', () => ({
  useSpaceContextState: () => mockState,
  useSpaceContextActions: () => ({
    createHandlers: {
      tabweb: mockCreateWebTab,
      terminal: mockCreateTerminal,
    },
    onCloseItem: mockCloseItem,
    onRestoreGroup: mockRestoreGroup,
  }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: Object.assign(
    (selector: (state: { setActiveKey: typeof mockSetActiveKey }) => unknown) =>
      selector({ setActiveKey: mockSetActiveKey }),
    {
      getState: () => ({
        openResourceTab: mockOpenResourceTab,
        setActiveKey: mockSetActiveKey,
      }),
    },
  ),
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: (selector: (state: {
    createGroup: typeof mockCreateGroup
    assignPaneContent: typeof mockAssignPaneContent
    splitPaneWithContent: typeof mockSplitPaneWithContent
    closePane: typeof mockClosePane
    setActivePane: typeof mockSetActivePane
  }) => unknown) => selector({
    createGroup: mockCreateGroup,
    assignPaneContent: mockAssignPaneContent,
    splitPaneWithContent: mockSplitPaneWithContent,
    closePane: mockClosePane,
    setActivePane: mockSetActivePane,
  }),
}))

const mockRenameResourceWithFeedback = vi.fn().mockResolvedValue(undefined)
const mockHandleWsEvent = vi.fn()

vi.mock('@/stores/useUnifiedResources', () => ({
  useUnifiedResources: Object.assign(
    (selector: (state: { handleWsEvent: typeof mockHandleWsEvent }) => unknown) =>
      selector({ handleWsEvent: mockHandleWsEvent }),
    {
      getState: () => ({
        getResources: () => [],
        handleWsEvent: mockHandleWsEvent,
      }),
    },
  ),
}))

vi.mock('./ResourceContextMenu', () => ({
  renameResourceWithFeedback: (...args: unknown[]) => mockRenameResourceWithFeedback(...args),
}))

vi.mock('./registry', () => ({
  contextRegistry: {
    getHandler: (type: string) => ({
      appId: type === 'apphome' ? undefined : type === 'file' ? 'tabfiles' : type,
      closable: type !== 'desktop_home',
      appEntryMode: type === 'skill' ? 'panel' : undefined,
    }),
    getHandlerByAppId: (appId: string) => {
      if (appId === 'skill') {
        return { type: 'skill', appId: 'skill', closable: true, appEntryMode: 'panel' as const }
      }
      if (appId === 'tabdoc') {
        return { type: 'tabdoc', appId: 'tabdoc', closable: true, appEntryMode: 'resources' as const }
      }
      if (appId === 'tabdata') {
        return { type: 'tabdata', appId: 'tabdata', closable: true, appEntryMode: 'resources' as const }
      }
      if (appId === 'tabtracker') {
        return { type: 'tabtracker', appId: 'tabtracker', closable: true, appEntryMode: 'resources' as const }
      }
      if (appId === 'tabfolder') {
        return { type: 'tabfolder', appId: 'tabfolder', closable: true, appEntryMode: 'resources' as const }
      }
      if (appId === 'tabfiles') {
        return { type: 'file', appId: 'tabfiles', closable: true, appEntryMode: 'resources' as const }
      }
      return { type: appId, appId, closable: true, appEntryMode: 'create' as const }
    },
    normalizeBackendType: (type: string) => type,
    getTabLabel: (item: ContextItem) => item.title,
    getTabIcon: (item: ContextItem) =>
      item.type === 'tabweb' ? '🌐'
        : item.type === 'tabdoc' ? '📄'
          : item.type === 'tabdata' ? '📊'
            : item.type === 'apphome' ? '🔧'
              : '🏠',
    getDragPayload: (item: ContextItem) => ({ type: item.type, id: item.id, title: item.title }),
    getAppEntries: () => [
      {
        type: 'tabweb',
        appId: 'tabweb',
        appEntryMode: 'create',
        displayLabel: '浏览器',
        displayEmoji: '🌐',
      },
      {
        type: 'terminal',
        appId: 'terminal',
        appEntryMode: 'create',
        displayLabel: '终端',
        displayEmoji: '💻',
      },
      {
        type: 'tabdoc',
        appId: 'tabdoc',
        appEntryMode: 'resources',
        displayLabel: '文档',
        displayEmoji: '📄',
      },
      {
        type: 'tabdata',
        appId: 'tabdata',
        appEntryMode: 'resources',
        displayLabel: '多维表',
        displayEmoji: '📊',
      },
      {
        type: 'tabfolder',
        appId: 'tabfolder',
        appEntryMode: 'resources',
        displayLabel: '本地目录',
        displayEmoji: '📁',
      },
      {
        type: 'skill',
        appId: 'skill',
        appEntryMode: 'panel',
        displayLabel: 'Skills',
        displayEmoji: '🔧',
        sidebarPanel: true,
      },
      {
        type: 'tabtracker',
        appId: 'tabtracker',
        appEntryMode: 'resources',
        displayLabel: '自动化',
        displayEmoji: '🎯',
      },
      {
        type: 'market-app',
        appId: 'market-app',
        appEntryMode: 'resources',
        displayLabel: '市场应用',
        displayEmoji: '🛒',
      },
    ],
  },
}))

describe('DesktopSidebarPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.removeItem('tabtin:desktop-sidebar:pinned-apps:v1')
    mockState = {
      visibleItems: [desktopItem, browserItem],
      tabLookupItems: [desktopItem, browserItem],
      canvasGroups: [],
      activeTabKey: 'desktop_home:current',
      tabScopeKey: 'desktop:wt-1:user-1',
      spaceId: 'space-1',
    }
    mockCreateGroup.mockReturnValue({
      ...group,
      panes: [
        { id: 'pane-1', content: { tabKey: 'tabdoc:doc-1' } },
        { id: 'pane-empty', content: null },
      ],
      activePaneId: 'pane-1',
    })
  })

  it('renders pinned home and open desktop tabs', () => {
    const onOpenAppHome = vi.fn()
    const onSelectOpenTab = vi.fn()

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={onOpenAppHome}
        onSelectOpenTab={onSelectOpenTab}
      />,
    )

    fireEvent.click(screen.getByText('主页'))
    expect(onSelectOpenTab).toHaveBeenCalledWith(desktopItem)

    fireEvent.click(screen.getByText('Example'))
    expect(onSelectOpenTab).toHaveBeenCalledWith(browserItem)

    fireEvent.click(screen.getByLabelText('关闭标签'))
    expect(mockCloseItem).toHaveBeenCalledWith(browserItem)
  })

  it('opens default pinned apps from the pinned area', () => {
    const onOpenAppHome = vi.fn()

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={onOpenAppHome}
        onSelectOpenTab={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('云盘'))
    expect(onOpenAppHome).toHaveBeenCalledWith('cloud-resources')

    fireEvent.click(screen.getByText('多维表'))
    expect(onOpenAppHome).toHaveBeenCalledWith('tabdata')

    fireEvent.click(screen.getByText('文档'))
    expect(onOpenAppHome).toHaveBeenCalledWith('tabdoc')
  })

  it('renders pinned marketplace apps when spaceApps metadata is available', () => {
    window.localStorage.setItem(
      'tabtin:desktop-sidebar:pinned-apps:v1',
      JSON.stringify(['cloud-resources', 'tabdata', 'tabdoc', 'tabtracker', 'market-app']),
    )

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    expect(screen.getByText('市场应用')).toBeTruthy()
  })

  it('allows pinned apps to be unpinned and opens the apps page', () => {
    const onOpenAppHome = vi.fn()
    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={onOpenAppHome}
        onSelectOpenTab={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText('取消置顶 多维表'))
    expect(screen.queryByText('多维表')).toBeNull()

    fireEvent.click(screen.getByText('更多'))
    expect(onOpenAppHome).toHaveBeenCalledWith('desktop-apps')
  })

  it('does not highlight pinned app when a concrete resource tab is focused', () => {
    mockState = {
      visibleItems: [desktopItem, tableItem],
      tabLookupItems: [desktopItem, tableItem],
      canvasGroups: [],
      activeTabKey: 'tabdata:table-1',
      tabScopeKey: 'desktop:wt-1:user-1',
      spaceId: 'space-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const pinnedTableRow = screen.getByLabelText('取消置顶 多维表').closest('[role="button"]')
    const resourceTableRow = screen.getByText('Table').closest('[role="button"]')

    expect(pinnedTableRow?.className).not.toContain('surface-row-active')
    expect(pinnedTableRow?.querySelector('.opacity-60')).toBeTruthy()
    expect(resourceTableRow?.className).toContain('surface-row-active')
  })

  it('highlights pinned app only when its app home is focused', () => {
    render(
      <DesktopSidebarPanel
        activeAppHomeId="tabdata"
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const pinnedTableRow = screen.getByLabelText('取消置顶 多维表').closest('[role="button"]')
    expect(pinnedTableRow?.className).toContain('surface-row-active')
    expect(pinnedTableRow?.querySelector('.grayscale-0')).toBeTruthy()
  })

  it('mutes inactive app icons instead of rendering them at full color', () => {
    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const tableRow = screen.getByText('多维表').closest('[role="button"]')
    expect(tableRow?.querySelector('.opacity-60')).toBeTruthy()
  })

  it('shows Space-bound directory apphome tabs under local directory tags', () => {
    mockState = {
      visibleItems: [desktopItem, regularAppHomeItem, boundDirectoryAppHomeItem],
      tabLookupItems: [desktopItem, regularAppHomeItem, boundDirectoryAppHomeItem],
      canvasGroups: [],
      activeTabKey: boundDirectoryAppHomeItem.tabKey,
      tabScopeKey: 'desktop:wt-1:user-1',
      spaceId: 'space-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const openTabs = screen.getByTestId('desktop-sidebar-open-tabs')
    // 单标签平铺：不套「本地目录」组头
    expect(within(openTabs).queryByText('本地目录')).toBeNull()
    expect(within(openTabs).getByText('default-space-office-preview-cases')).toBeTruthy()
    // 文档 apphome 仍隐藏；置顶区仍有「文档」
    expect(screen.queryAllByText('文档')).toHaveLength(1)
  })

  it('hides tabtracker list + apphome but keeps detail tabs under 自动化 group', () => {
    const trackerAppHomeItem: ContextItem = {
      type: 'apphome',
      id: 'tabtracker',
      tabKey: 'apphome:tabtracker',
      title: '自动化',
      meta: { appId: 'tabtracker', displayLabel: '自动化', displayEmoji: '🎯' },
    }
    const trackerListItem: ContextItem = {
      type: 'tabtracker',
      id: 'tracker-space-1',
      tabKey: 'tabtracker:tracker-space-1',
      title: '自动化',
      meta: { spaceId: 'space-1' },
    }
    const trackerDetailItem: ContextItem = {
      type: 'tabtracker',
      id: 'task-abc',
      tabKey: 'tabtracker:task-abc',
      title: '测试自动化',
      meta: { spaceId: 'space-1', taskId: 'task-abc' },
    }
    const trackerDetailItem2: ContextItem = {
      type: 'tabtracker',
      id: 'task-def',
      tabKey: 'tabtracker:task-def',
      title: '每日收集AI新闻',
      meta: { spaceId: 'space-1', taskId: 'task-def' },
    }
    mockState = {
      ...mockState,
      visibleItems: [desktopItem, trackerAppHomeItem, trackerListItem, trackerDetailItem, trackerDetailItem2],
      tabLookupItems: [desktopItem, trackerAppHomeItem, trackerListItem, trackerDetailItem, trackerDetailItem2],
      activeTabKey: 'tabtracker:task-abc',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId="tabtracker"
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const openTabs = screen.getByTestId('desktop-sidebar-open-tabs')
    expect(within(openTabs).getByText('测试自动化')).toBeTruthy()
    expect(within(openTabs).getByText('每日收集AI新闻')).toBeTruthy()
    // 多详情时有组头「自动化」；apphome / 列表页同名行都不应再出现
    expect(within(openTabs).getAllByText('自动化')).toHaveLength(1)
  })

  it('keeps 自动化 group header even with a single detail tab', () => {
    const trackerDetailItem: ContextItem = {
      type: 'tabtracker',
      id: 'task-abc',
      tabKey: 'tabtracker:task-abc',
      title: '每日收集AI新闻',
      meta: { spaceId: 'space-1', taskId: 'task-abc' },
    }
    mockState = {
      ...mockState,
      visibleItems: [desktopItem, trackerDetailItem],
      tabLookupItems: [desktopItem, trackerDetailItem],
      activeTabKey: 'tabtracker:task-abc',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const openTabs = screen.getByTestId('desktop-sidebar-open-tabs')
    expect(within(openTabs).getByText('自动化')).toBeTruthy()
    expect(within(openTabs).getByText('每日收集AI新闻')).toBeTruthy()
  })

  // ：panel 类应用（Skill）打开后只有 apphome 标签；若整类滤掉，标签区会空。
  it('#3888 lists panel apphome (Skill) in open tabs, hides resource apphome (文档)', () => {
    mockState = {
      ...mockState,
      visibleItems: [desktopItem, skillAppHomeItem, regularAppHomeItem],
      tabLookupItems: [desktopItem, skillAppHomeItem, regularAppHomeItem],
      activeTabKey: 'apphome:skill',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId="skill"
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    expect(screen.queryByText('打开网页、文档或终端后，会显示在这里。')).toBeNull()
    const openTabs = screen.getByTestId('desktop-sidebar-open-tabs')
    expect(within(openTabs).getByText('Skill')).toBeTruthy()
    expect(within(openTabs).queryByText('Skills')).toBeNull()
    expect(within(openTabs).queryByRole('button', { expanded: true })).toBeNull()
    expect(openTabs.textContent).not.toContain('文档')
  })

  it('keeps app group header when the same app has multiple open tabs', () => {
    const skillExtra: ContextItem = {
      type: 'apphome',
      id: 'skill-extra',
      tabKey: 'apphome:skill-extra',
      title: 'Skill Extra',
      meta: { appId: 'skill', displayLabel: 'Skill Extra' },
    }
    mockState = {
      ...mockState,
      visibleItems: [desktopItem, skillAppHomeItem, skillExtra],
      tabLookupItems: [desktopItem, skillAppHomeItem, skillExtra],
      activeTabKey: 'apphome:skill',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId="skill"
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const openTabs = screen.getByTestId('desktop-sidebar-open-tabs')
    expect(within(openTabs).getByRole('button', { expanded: true }).textContent).toContain('Skill')
    expect(within(openTabs).getByText('Skill Extra')).toBeTruthy()
  })

  it('groups multiple cloud file tabs under 文件 instead of the first filename', () => {
    const firstFile: ContextItem = {
      type: 'file',
      id: 'file-1',
      tabKey: 'file:file-1',
      title: 'readme.markdown',
    }
    const secondFile: ContextItem = {
      type: 'file',
      id: 'file-2',
      tabKey: 'file:file-2',
      title: 'sample.mp4',
    }
    mockState = {
      ...mockState,
      visibleItems: [desktopItem, firstFile, secondFile],
      tabLookupItems: [desktopItem, firstFile, secondFile],
      activeTabKey: firstFile.tabKey,
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const openTabs = screen.getByTestId('desktop-sidebar-open-tabs')
    expect(within(openTabs).getByText('文件')).toBeTruthy()
    expect(within(openTabs).getByText('readme.markdown')).toBeTruthy()
    expect(within(openTabs).getByText('sample.mp4')).toBeTruthy()
    expect(within(openTabs).getAllByText('readme.markdown')).toHaveLength(1)
  })

  it('renders expandable canvas groups and activates panes', () => {
    mockState = {
      visibleItems: [desktopItem],
      tabLookupItems: [desktopItem, browserItem, docItem],
      canvasGroups: [group],
      activeTabKey: 'tabweb:view-1',
      tabScopeKey: 'desktop:wt-1:user-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    expect(screen.getByText('Example')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('展开标签组'))
    fireEvent.click(screen.getAllByText('Doc')[0])

    expect(mockSetActivePane).toHaveBeenCalledWith('desktop:wt-1:user-1', 'group-1', 'pane-2')
    expect(mockSetActiveKey).toHaveBeenCalledWith('desktop:wt-1:user-1', 'tabdoc:doc-1')
  })

  it('creates a group by dragging one sidebar tab onto another', () => {
    mockState = {
      visibleItems: [desktopItem, browserItem, docItem],
      tabLookupItems: [desktopItem, browserItem, docItem],
      canvasGroups: [],
      activeTabKey: 'desktop_home:current',
      tabScopeKey: 'desktop:wt-1:user-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByText('Example'), { dataTransfer })
    fireEvent.drop(screen.getByText('Doc'), { dataTransfer })

    expect(mockCreateGroup).toHaveBeenCalledWith(
      'desktop:wt-1:user-1',
      'tabdoc:doc-1',
      { tabKey: 'tabdoc:doc-1' },
      'horizontal',
      'right',
    )
    expect(mockAssignPaneContent).toHaveBeenCalledWith(
      'desktop:wt-1:user-1',
      'group-1',
      'pane-empty',
      { tabKey: 'tabweb:view-1' },
    )
  })

  it('adds a sidebar tab to an existing group', () => {
    mockState = {
      visibleItems: [desktopItem, tableItem],
      tabLookupItems: [desktopItem, browserItem, docItem, tableItem],
      canvasGroups: [group],
      activeTabKey: 'tabweb:view-1',
      tabScopeKey: 'desktop:wt-1:user-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByText('Table'), { dataTransfer })
    fireEvent.drop(screen.getByText('Example'), { dataTransfer })

    expect(mockSplitPaneWithContent).toHaveBeenCalledWith(
      'desktop:wt-1:user-1',
      'group-1',
      'pane-1',
      'horizontal',
      'right',
      { tabKey: 'tabdata:table-1' },
    )
    expect(mockSetActiveKey).toHaveBeenCalledWith('desktop:wt-1:user-1', 'tabdata:table-1')
  })

  it('restores a whole group and detaches a single pane', () => {
    mockState = {
      visibleItems: [desktopItem],
      tabLookupItems: [desktopItem, browserItem, docItem],
      canvasGroups: [group],
      activeTabKey: 'tabweb:view-1',
      tabScopeKey: 'desktop:wt-1:user-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText('拆回独立标签'))
    expect(mockRestoreGroup).toHaveBeenCalledWith(group)

    fireEvent.click(screen.getByLabelText('展开标签组'))
    fireEvent.click(screen.getAllByLabelText('移出标签组')[0])
    expect(mockClosePane).toHaveBeenCalledWith('desktop:wt-1:user-1', 'group-1', 'pane-1')
    expect(mockSetActiveKey).toHaveBeenCalledWith('desktop:wt-1:user-1', 'tabweb:view-1')
  })

  it('detaches a pane by dragging it out to the sidebar list', () => {
    mockState = {
      visibleItems: [desktopItem],
      tabLookupItems: [desktopItem, browserItem, docItem],
      canvasGroups: [group],
      activeTabKey: 'tabweb:view-1',
      tabScopeKey: 'desktop:wt-1:user-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText('展开标签组'))
    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getAllByText('Example')[1], { dataTransfer })
    fireEvent.drop(screen.getByTestId('desktop-sidebar-open-tabs'), { dataTransfer })

    expect(mockClosePane).toHaveBeenCalledWith('desktop:wt-1:user-1', 'group-1', 'pane-1')
    expect(mockSetActiveKey).toHaveBeenCalledWith('desktop:wt-1:user-1', 'tabweb:view-1')
  })

  it('turns open document tab into rename input on double-click', async () => {
    vi.useFakeTimers()
    try {
      const onSelectOpenTab = vi.fn()
      mockState = {
        visibleItems: [desktopItem, docItem],
        tabLookupItems: [desktopItem, docItem],
        canvasGroups: [],
        activeTabKey: 'tabdoc:doc-1',
        tabScopeKey: 'desktop:wt-1:user-1',
        spaceId: 'space-1',
      }

      render(
        <DesktopSidebarPanel
          activeAppHomeId={null}
          onOpenAppHome={vi.fn()}
          onSelectOpenTab={onSelectOpenTab}
        />,
      )

      const label = screen.getByText('Doc')
      fireEvent.click(label)
      fireEvent.doubleClick(label)
      act(() => {
        vi.advanceTimersByTime(250)
      })

      expect(onSelectOpenTab).not.toHaveBeenCalled()
      const input = screen.getByRole('textbox', { name: '重命名' })
      fireEvent.change(input, { target: { value: '新文档名' } })
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' })
        await Promise.resolve()
      })

      expect(mockRenameResourceWithFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '新文档名',
          item: expect.objectContaining({
            resource_id: 'doc-1',
            item_type: 'tabdoc',
          }),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rename browser tabs via double-click', () => {
    mockState = {
      visibleItems: [desktopItem, browserItem],
      tabLookupItems: [desktopItem, browserItem],
      canvasGroups: [],
      activeTabKey: 'tabweb:view-1',
      tabScopeKey: 'desktop:wt-1:user-1',
      spaceId: 'space-1',
    }

    render(
      <DesktopSidebarPanel
        activeAppHomeId={null}
        onOpenAppHome={vi.fn()}
        onSelectOpenTab={vi.fn()}
      />,
    )

    fireEvent.doubleClick(screen.getByText('Example'))
    expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull()
  })
})
