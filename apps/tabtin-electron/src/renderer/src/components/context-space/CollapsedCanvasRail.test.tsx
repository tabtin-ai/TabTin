import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CollapsedCanvasRail } from './CollapsedCanvasRail'

const mocks = vi.hoisted(() => ({
  state: {
    visibleItems: [] as Array<Record<string, unknown>>,
    activeTabKey: null as string | null,
    spaceId: 'space-1',
    tabScopeKey: 'space-1',
  },
  actions: {
    onSelectItem: vi.fn(),
    onOpenAppHome: vi.fn(),
    onSelectHome: vi.fn(),
    createHandlers: {} as Record<string, () => void>,
  },
  appEntries: [] as Array<Record<string, unknown>>,
  pinnedAppIds: [] as string[],
  unpinApp: vi.fn(),
  openResourceTab: vi.fn(),
  canvasRail: {
    iconOnly: false,
  },
  sharedAccessBySessionId: {} as Record<string, { shareId: string; sessionId: string }>,
  spaceStore: {
    spaces: [] as Array<Record<string, unknown>>,
    agentCache: {} as Record<string, { id: string; working_dir?: string; working_dir_type?: string }>,
    selectedAgent: null as { id: string; working_dir?: string; working_dir_type?: string } | null,
  },
  addSpaceFolder: vi.fn(() => ({ folderId: 'space-1::folder', isNew: false })),
  findFolderByPathForSpace: vi.fn(() => null as string | null),
  resolveSessionCodeRoot: vi.fn(
    (_sessionId: string | null, opts?: { spaceWorkingDir?: string | null }) =>
      opts?.spaceWorkingDir ?? null,
  ),
  sessionBindings: {} as Record<string, { revision: number; rootPath: string }>,
  currentSessionIdBySpaceId: {} as Record<string, string | null>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; app?: string }) => {
      const template = opts?.defaultValue ?? key
      if (opts?.app != null) return template.replace(/\{\{app\}\}/g, opts.app)
      return template
    },
  }),
}))

vi.mock('./SpaceContextAreaContext', () => ({
  useSpaceContextState: () => mocks.state,
  useSpaceContextActions: () => mocks.actions,
}))

vi.mock('./desktopAppsModel', () => ({
  useDesktopAppEntries: () => mocks.appEntries,
  usePinnedDesktopAppIds: () => ({
    pinnedAppIds: mocks.pinnedAppIds,
    unpinApp: mocks.unpinApp,
  }),
  DESKTOP_RAIL_EXCLUDED_APP_IDS: new Set<string>(),
}))

vi.mock('./desktopTabHandler', () => ({
  DESKTOP_TAB_TYPE: 'desktop_home',
  DESKTOP_TAB_KEY: 'desktop_home:current',
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: typeof mocks.spaceStore) => unknown) => selector(mocks.spaceStore),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: mocks.openResourceTab,
    }),
  },
}))

vi.mock('./folder/useFolderStore', () => ({
  useFolderContextStore: {
    getState: () => ({
      addSpaceFolder: mocks.addSpaceFolder,
      findFolderByPathForSpace: mocks.findFolderByPathForSpace,
    }),
  },
}))

vi.mock('@components/layout/sidebarTypeEmoji', () => ({
  TabTypeEmoji: ({ appIdOrType }: { appIdOrType: string }) => (
    <span data-testid={`emoji-${appIdOrType}`} />
  ),
  SidebarTypeEmoji: ({ appIdOrType }: { appIdOrType: string }) => (
    <span data-testid={`emoji-${appIdOrType}`} />
  ),
}))

vi.mock('@components/layout/CanvasRailPortalContext', () => ({
  useCanvasRailPortal: () => ({
    enabled: true,
    target: null,
    expandCanvas: vi.fn(),
    iconOnly: mocks.canvasRail.iconOnly,
  }),
}))

vi.mock('@/stores/chat/session/sessionAccessStore', () => ({
  useSessionAccessStore: (selector: (state: { bySessionId: typeof mocks.sharedAccessBySessionId }) => unknown) => (
    selector({ bySessionId: mocks.sharedAccessBySessionId })
  ),
}))

vi.mock('./registry', () => ({
  contextRegistry: {
    getTabLabel: (item: { title?: string }) => item.title ?? 'tab',
    getTabIcon: () => null,
    buildTabKey: (type: string, id: string) => `${type}:${id}`,
  },
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: {
    currentSessionIdBySpaceId: Record<string, string | null>
  }) => unknown) => selector({
    currentSessionIdBySpaceId: mocks.currentSessionIdBySpaceId,
  }),
}))

vi.mock('@/stores/chat/utils/resolveSessionCodeRoot', () => ({
  resolveSessionCodeRoot: (...args: unknown[]) =>
    mocks.resolveSessionCodeRoot(...(args as [string | null, { spaceWorkingDir?: string | null }?])),
}))

vi.mock('@stores/useSessionBoundCodeRootStore', () => ({
  useSessionBoundCodeRootStore: (
    selector: (state: {
      bindingsBySessionId: Record<string, { revision: number; rootPath: string }>
    }) => unknown,
  ) => selector({ bindingsBySessionId: mocks.sessionBindings }),
}))

vi.mock('./code-workspace/CodeWorkspaceRailCard', () => ({
  CodeWorkspaceRailCard: () => <div data-testid="code-workspace-rail-card-stub" />,
}))

describe('CollapsedCanvasRail', () => {
  beforeEach(() => {
    mocks.state.visibleItems = []
    mocks.state.activeTabKey = null
    mocks.state.spaceId = 'space-1'
    mocks.state.tabScopeKey = 'space-1'
    mocks.actions.onSelectItem.mockClear()
    mocks.actions.onOpenAppHome.mockClear()
    mocks.actions.onSelectHome.mockClear()
    mocks.actions.createHandlers = {}
    mocks.appEntries = []
    mocks.pinnedAppIds = []
    mocks.unpinApp.mockClear()
    mocks.openResourceTab.mockClear()
    mocks.canvasRail.iconOnly = false
    mocks.sharedAccessBySessionId = {}
    mocks.spaceStore.spaces = []
    mocks.spaceStore.agentCache = {}
    mocks.spaceStore.selectedAgent = null
    mocks.addSpaceFolder.mockClear()
    mocks.findFolderByPathForSpace.mockReset()
    mocks.findFolderByPathForSpace.mockReturnValue(null)
    mocks.resolveSessionCodeRoot.mockClear()
    mocks.resolveSessionCodeRoot.mockImplementation(
      (_sessionId: string | null, opts?: { spaceWorkingDir?: string | null }) =>
        opts?.spaceWorkingDir ?? null,
    )
    mocks.sessionBindings = {}
    mocks.currentSessionIdBySpaceId = {}
  })

  it('列出打开的标签（含普通 apphome），排除桌面虚拟标签；点标签先展开画布再激活', () => {
    const docItem = { tabKey: 'tabdoc:1', type: 'tabdoc', title: '设计稿' }
    const apphomeItem = { tabKey: 'apphome:tabdoc', type: 'apphome', title: '文档主页' }
    mocks.state.visibleItems = [
      docItem,
      apphomeItem,
      { tabKey: 'desktop_home:current', type: 'desktop_home', title: '桌面' },
    ]
    const expandCanvas = vi.fn()

    render(<CollapsedCanvasRail expandCanvas={expandCanvas} />)

    // 普通 apphome 要显示；桌面虚拟标签不进打开标签（工作台只走底部入口）
    expect(screen.getByText('文档主页')).toBeTruthy()
    expect(screen.queryByText('桌面')).toBeNull()
    expect(screen.getAllByText('工作台')).toHaveLength(1)

    fireEvent.click(screen.getByText('文档主页'))
    expect(expandCanvas).toHaveBeenCalledTimes(1)
    expect(mocks.actions.onSelectItem).toHaveBeenCalledWith(apphomeItem)

    fireEvent.click(screen.getByText('设计稿'))
    expect(expandCanvas).toHaveBeenCalledTimes(2)
    expect(mocks.actions.onSelectItem).toHaveBeenCalledWith(docItem)
  })

  it('文字态长标签行宽受栏宽约束，列表禁止横向滚动', async () => {
    const longTitle = '这是一个非常非常非常非常非常非常非常非常长的文档标题用于压测收起栏'
    mocks.state.visibleItems = [
      { tabKey: 'tabdoc:long', type: 'tabdoc', title: longTitle },
    ]

    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)

    const tabButton = screen.getByRole('button', { name: longTitle })
    expect(tabButton.className).toContain('w-[calc(100%-0.75rem)]')
    expect(tabButton.className).toContain('min-w-0')
    expect(tabButton.className).toContain('overflow-hidden')
    expect(tabButton.querySelector('.truncate')).toBeTruthy()

    const tabList = tabButton.parentElement
    expect(tabList?.className).toContain('overflow-x-hidden')
    expect(tabList?.className).toContain('min-w-0')

    fireEvent.pointerMove(tabButton, { pointerType: 'mouse' })
    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toBe(longTitle)
    })
  })

  it('IM 会话桌面展示会话资产，点击云盘后在当前会话标签组打开', () => {
    mocks.state.tabScopeKey = 'im:conversation-1'
    const expandCanvas = vi.fn()

    render(<CollapsedCanvasRail expandCanvas={expandCanvas} />)

    expect(screen.getByText('会话资产')).toBeTruthy()
    expect(screen.getByText('云盘')).toBeTruthy()
    expect(screen.getByText('文件')).toBeTruthy()
    fireEvent.click(screen.getByText('云盘'))

    expect(expandCanvas).toHaveBeenCalledTimes(1)
    expect(mocks.openResourceTab).toHaveBeenCalledWith('im:conversation-1', expect.objectContaining({
      type: 'imassets',
      id: 'document:conversation-1',
      title: '云盘',
    }))
  })

  it('IM 会话桌面不展示任务快捷入口（云盘/多维表/文档/工作台）', () => {
    mocks.state.tabScopeKey = 'im:conversation-1'
    mocks.appEntries = [
      { id: 'cloud-resources', label: '云盘', icon: null, mode: 'home', groupId: 'collaborative' },
      { id: 'tabdata', label: '多维表', icon: null, mode: 'home', groupId: 'collaborative' },
      { id: 'tabdoc', label: '文档', icon: null, mode: 'home', groupId: 'collaborative' },
    ]
    mocks.pinnedAppIds = ['cloud-resources', 'tabdata', 'tabdoc']

    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)

    expect(screen.queryByText('快捷入口')).toBeNull()
    expect(screen.queryByRole('button', { name: '工作台' })).toBeNull()
    expect(screen.queryByText('多维表')).toBeNull()
    expect(screen.queryByText('文档')).toBeNull()
    // 会话资产里的「云盘」仍在；任务置顶那条「云盘」不应再出现第二份。
    expect(screen.getAllByText('云盘')).toHaveLength(1)
    expect(screen.getByText('会话资产')).toBeTruthy()
  })

  it('置顶应用入口点击先展开画布，home 模式走 onOpenAppHome', () => {
    mocks.appEntries = [
      { id: 'tabdoc', label: '云文档', icon: null, mode: 'home', groupId: 'collaborative' },
      { id: 'tabweb', label: '浏览器', icon: null, mode: 'home', groupId: 'local' },
    ]
    mocks.pinnedAppIds = ['tabweb']
    const expandCanvas = vi.fn()

    render(<CollapsedCanvasRail expandCanvas={expandCanvas} />)

    fireEvent.click(screen.getByText('浏览器'))

    expect(expandCanvas).toHaveBeenCalledTimes(1)
    expect(mocks.actions.onOpenAppHome).toHaveBeenCalledWith('tabweb')
  })

  it('窄栏时应用入口只保留居中图标热区，并通过名称保持可识别', () => {
    mocks.canvasRail.iconOnly = true
    mocks.appEntries = [
      { id: 'tabweb', label: '浏览器', icon: <span data-testid="emoji-tabweb" />, mode: 'home', groupId: 'local' },
    ]
    mocks.pinnedAppIds = ['tabweb']

    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)

    expect(screen.queryByText('工作台')).toBeNull()
    expect(screen.queryByText('浏览器')).toBeNull()
    const appButton = screen.getByRole('button', { name: '浏览器' })
    expect(appButton.className).toContain('justify-center')
    expect(screen.getByTestId('emoji-tabweb')).toBeTruthy()
  })

  it('没有打开的标签时显示空态提示', () => {
    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)
    expect(screen.getByText('打开文档、网页或终端后会显示在这里')).toBeTruthy()
  })

  it('共享会话只展示当前授权响应打开的产物和链接，并隐藏工作台与快捷入口', () => {
    mocks.state.tabScopeKey = 'conversation:session-1'
    mocks.sharedAccessBySessionId = {
      'session-1': {
      shareId: 'share-1',
      sessionId: 'session-1',
      },
    }
    mocks.appEntries = [
      { id: 'tabdoc', label: '文档', icon: null, mode: 'home', groupId: 'collaborative' },
    ]
    mocks.pinnedAppIds = ['tabdoc']
    mocks.state.visibleItems = [
      {
        tabKey: 'shared_session_file:file-1',
        type: 'shared_session_file',
        title: '共享结果.pdf',
      },
      {
        tabKey: 'tabweb:web-1',
        type: 'tabweb',
        title: '响应链接',
      },
    ]

    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)

    expect(screen.getByText('共享结果.pdf')).toBeTruthy()
    expect(screen.getByText('响应链接')).toBeTruthy()
    expect(screen.queryByText('快捷入口')).toBeNull()
    expect(screen.queryByText('工作台')).toBeNull()
  })

  it('工作台入口展开画布并走 onSelectHome，不误开置顶应用', () => {
    mocks.appEntries = [
      { id: 'tabdoc', label: '文档', icon: null, mode: 'home', groupId: 'collaborative' },
    ]
    mocks.pinnedAppIds = ['tabdoc']
    const expandCanvas = vi.fn()

    render(<CollapsedCanvasRail expandCanvas={expandCanvas} />)
    fireEvent.click(screen.getByRole('button', { name: '工作台' }))

    expect(expandCanvas).toHaveBeenCalledTimes(1)
    expect(mocks.actions.onSelectHome).toHaveBeenCalledTimes(1)
    expect(mocks.actions.onOpenAppHome).not.toHaveBeenCalled()
  })

  it('置顶快捷可取消置顶', () => {
    mocks.appEntries = [
      { id: 'tabdoc', label: '文档', icon: null, mode: 'home', groupId: 'collaborative' },
    ]
    mocks.pinnedAppIds = ['tabdoc']

    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('取消置顶 文档'))
    expect(mocks.unpinApp).toHaveBeenCalledWith('tabdoc')
  })

  it('目录入口常驻首位、工作台垫底；mixed 类型点击打开 tabfolder', () => {
    mocks.spaceStore.spaces = [{
      id: 'space-1',
      name: '默认工作空间',
      type: 'workspace',
      working_dir: 'C:\\Users\\me\\TabTin\\默认工作空间-2',
      working_dir_type: 'mixed',
      execution_agent_id: 'agent-1',
    }]
    mocks.appEntries = [
      { id: 'tabdoc', label: '文档', icon: null, mode: 'home', groupId: 'collaborative' },
    ]
    mocks.pinnedAppIds = ['tabdoc']
    const expandCanvas = vi.fn()

    render(<CollapsedCanvasRail expandCanvas={expandCanvas} />)

    expect(screen.queryByText('执行环境')).toBeNull()
    expect(screen.getByText('目录')).toBeTruthy()
    expect(screen.queryByText('默认工作空间-2')).toBeNull()
    const workbench = screen.getByText('工作台')
    const executionRoot = screen.getByText('目录')
    const pinnedDoc = screen.getByText('文档')
    expect(executionRoot.compareDocumentPosition(pinnedDoc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pinnedDoc.compareDocumentPosition(workbench) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const executionButton = screen.getByRole('button', { name: '目录' })
    expect(executionButton.getAttribute('title')).toBe('C:\\Users\\me\\TabTin\\默认工作空间-2')

    fireEvent.click(executionButton)
    expect(expandCanvas).toHaveBeenCalledTimes(1)
    expect(mocks.openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
      type: 'tabfolder',
      meta: expect.objectContaining({ preferredView: 'folder' }),
    }))
  })

  it('code 类型展示 IDE 并打开 tabcode', () => {
    mocks.spaceStore.spaces = [{
      id: 'space-1',
      type: 'workspace',
      working_dir: '/Users/me/code/repo',
      working_dir_type: 'code',
      agent_id: 'agent-1',
    }]
    const expandCanvas = vi.fn()

    render(<CollapsedCanvasRail expandCanvas={expandCanvas} />)

    expect(screen.getByText('IDE')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'IDE' }))
    expect(mocks.openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
      type: 'tabcode',
      meta: expect.objectContaining({
        preferredView: 'code',
        path: '/Users/me/code/repo',
      }),
    }))
  })

  it('IDE 入口优先使用会话绑定代码根', () => {
    mocks.spaceStore.spaces = [{
      id: 'space-1',
      type: 'workspace',
      working_dir: '/Users/me/code/repo',
      working_dir_type: 'code',
      agent_id: 'agent-1',
    }]
    mocks.currentSessionIdBySpaceId = { 'space-1': 'session-bound' }
    mocks.sessionBindings = {
      'session-bound': { revision: 2, rootPath: '/Users/me/code/wt' },
    }
    mocks.resolveSessionCodeRoot.mockReturnValue('/Users/me/code/wt')
    const expandCanvas = vi.fn()

    render(<CollapsedCanvasRail expandCanvas={expandCanvas} />)
    fireEvent.click(screen.getByRole('button', { name: 'IDE' }))

    expect(mocks.resolveSessionCodeRoot).toHaveBeenCalledWith(
      'session-bound',
      expect.objectContaining({ spaceWorkingDir: '/Users/me/code/repo' }),
    )
    expect(mocks.openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
      type: 'tabcode',
      meta: expect.objectContaining({ path: '/Users/me/code/wt' }),
    }))
  })

  it('无 Space.working_dir 时回退 Agent.working_dir，默认展示目录入口', () => {
    mocks.spaceStore.spaces = [{
      id: 'space-1',
      name: '',
      type: 'workspace',
      working_dir: '',
      agent_id: 'agent-1',
    }]
    mocks.spaceStore.agentCache = {
      'agent-1': { id: 'agent-1', working_dir: '/Users/me/code/repo' },
    }

    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)

    expect(screen.getByText('目录')).toBeTruthy()
    expect(screen.getByText('工作台')).toBeTruthy()
  })

  it('未绑定目录时不显示执行根入口', () => {
    mocks.appEntries = [
      { id: 'tabdoc', label: '文档', icon: null, mode: 'home', groupId: 'collaborative' },
    ]
    mocks.pinnedAppIds = ['tabdoc']

    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)

    expect(screen.queryByText('执行环境')).toBeNull()
    expect(screen.getByText('工作台')).toBeTruthy()
  })

  it('没有绑定目录和置顶应用时仍保留任务工作台入口', () => {
    render(<CollapsedCanvasRail expandCanvas={vi.fn()} />)

    expect(screen.queryByText('执行环境')).toBeNull()
    expect(screen.getByRole('button', { name: '工作台' })).toBeTruthy()
  })
})
