import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopAppsPane } from './DesktopAppsPane'

const mockCreateWebTab = vi.fn()
const mockOpenAppHome = vi.fn()
const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; app?: string; count?: number }) =>
      (options?.defaultValue ?? _key)
        .replace('{{app}}', options?.app ?? '')
        .replace('{{count}}', String(options?.count ?? '')),
  }),
}))

vi.mock('./SpaceContextAreaContext', () => ({
  useSpaceContextState: () => ({ spaceId: 'space-1' }),
  useSpaceContextActions: () => ({
    createHandlers: {
      tabweb: mockCreateWebTab,
    },
    onOpenAppHome: mockOpenAppHome,
  }),
}))

  // 分类分组走保障清单；卡片标签只看 distribution（内置 / 应用市场）。
vi.mock('@stores/useSpaceApps', () => ({
  useSpaceApps: (selector: (state: { appsBySpace: Record<string, Array<{ id: string; surface: string; distribution?: string }>> }) => unknown) =>
    selector({
      appsBySpace: {
        'space-1': [
          { id: 'tabweb', surface: 'builtin', distribution: 'builtin' },
          { id: 'terminal', surface: 'builtin', distribution: 'builtin' },
          { id: 'tabdata', surface: 'collaborative', distribution: 'builtin' },
          { id: 'tabdoc', surface: 'collaborative', distribution: 'builtin' },
          { id: 'tabtracker', surface: 'collaborative', distribution: 'builtin' },
        ],
      },
    }),
}))

vi.mock('@components/ui', async () => {
  const actual = await vi.importActual<typeof import('@components/ui')>('@components/ui')
  return {
    ...actual,
    toast: mockToast,
  }
})

vi.mock('./registry/instance', () => ({
  homeSectionRegistry: {
    has: (appId: string) => ['tabdata', 'tabdoc', 'tabtracker'].includes(appId),
    get: vi.fn(),
  },
}))

vi.mock('./registry', () => ({
  contextRegistry: {
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
        type: 'tabdata',
        appId: 'tabdata',
        appEntryMode: 'resources',
        displayLabel: '表格',
        displayEmoji: '📊',
      },
      {
        type: 'tabdoc',
        appId: 'tabdoc',
        appEntryMode: 'resources',
        displayLabel: '文档',
        displayEmoji: '📄',
      },
      {
        type: 'tabtracker',
        appId: 'tabtracker',
        appEntryMode: 'resources',
        displayLabel: '追踪',
        displayEmoji: '📌',
      },
    ],
    getHandlerByAppId: (appId: string) => {
      const byId: Record<string, { appEntryMode: 'create' | 'resources' | 'panel' }> = {
        tabweb: { appEntryMode: 'create' },
        terminal: { appEntryMode: 'create' },
        tabdata: { appEntryMode: 'resources' },
        tabdoc: { appEntryMode: 'resources' },
        tabtracker: { appEntryMode: 'resources' },
      }
      return byId[appId] ?? null
    },
  },
}))

describe('DesktopAppsPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.removeItem('tabtin:desktop-sidebar:pinned-apps:v1')
  })

  it('renders grouped apps as an independent page, including standalone local capabilities', () => {
    render(<DesktopAppsPane />)

    expect(screen.getByText('更多应用')).toBeTruthy()
    expect(screen.getByText('协作应用')).toBeTruthy()
    expect(screen.getByText('单机应用')).toBeTruthy()
    expect(screen.getByText('云盘')).toBeTruthy()
    expect(screen.getByText('浏览器')).toBeTruthy()
    expect(screen.getByText('终端')).toBeTruthy()
    expect(screen.getByText('沉淀方案、资料和交付内容。')).toBeTruthy()
  })

  it('badges apps by distribution only (builtin vs marketplace, no collaborative tag)', () => {
    render(<DesktopAppsPane />)

    const browserCard = screen.getByText('浏览器').closest('[data-testid="desktop-app-card"]')
    expect(browserCard).toBeTruthy()
    const builtinBadge = within(browserCard as HTMLElement).getByText('内置')
    expect(builtinBadge.className).toContain('bg-muted/30')
    expect(builtinBadge.className).toContain('text-muted-foreground/60')

    const docCard = screen.getByText('文档').closest('[data-testid="desktop-app-card"]')
    expect(docCard).toBeTruthy()
    const docBuiltinBadge = within(docCard as HTMLElement).getByText('内置')
    expect(docBuiltinBadge.className).toContain('bg-muted/30')
    expect(within(docCard as HTMLElement).queryByText('协作')).toBeNull()
  })

  it('uses container-aware spacing and card columns for narrow panels', () => {
    render(<DesktopAppsPane />)

    const pageContainer = screen
      .getByRole('heading', { level: 1, name: '更多应用' })
      .closest('div.flex.w-full.flex-col')
    expect(pageContainer?.className).toContain('px-[clamp(16px,5%,32px)]')
    expect(pageContainer?.className).toContain('py-10')
    expect(pageContainer?.className).toContain('w-full')
    expect(pageContainer?.className).not.toContain('max-w-5xl')

    const docCard = screen.getByText('文档').closest('[data-testid="desktop-app-card"]')
    expect(docCard?.parentElement?.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))]')
    const docIconFrame = docCard?.querySelector('img')?.parentElement?.parentElement
    expect(docIconFrame?.className).toContain('h-14')
    expect(docIconFrame?.className).toContain('[&>span]:h-12')
    expect(docIconFrame?.className).not.toContain('bg-foreground')

    const headerIconFrame = screen
      .getByRole('heading', { level: 1, name: '更多应用' })
      .parentElement?.previousElementSibling
    const headerIcon = headerIconFrame?.querySelector('span')
    expect(headerIcon?.className).toContain('h-10')
    expect(headerIconFrame?.className).not.toContain('bg-foreground')
  })

  it('pins and unpins apps from the apps page', () => {
    render(<DesktopAppsPane />)
    // 默认置顶含 tabdoc/tabdata/tabtracker，选用未置顶的浏览器做交互。
    const browserCard = screen.getByText('浏览器').closest('[data-testid="desktop-app-card"]')
    expect(browserCard).toBeTruthy()

    fireEvent.click(within(browserCard as HTMLElement).getByLabelText('置顶到快捷入口'))
    expect(window.localStorage.getItem('tabtin:desktop-sidebar:pinned-apps:v1')).toContain('tabweb')
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已置顶「浏览器」到侧栏快捷入口',
    }))

    fireEvent.click(within(browserCard as HTMLElement).getByLabelText('取消快捷入口'))
    expect(window.localStorage.getItem('tabtin:desktop-sidebar:pinned-apps:v1')).not.toContain('tabweb')
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已从快捷入口移除「浏览器」',
    }))
  })

  it('replaces the oldest pinned app when pinning beyond the sidebar limit', () => {
    // tabtracker 在 DESKTOP_RAIL_EXCLUDED 里读盘会被滤掉，凑满 5 个要用侧栏可见 id。
    window.localStorage.setItem(
      'tabtin:desktop-sidebar:pinned-apps:v1',
      JSON.stringify(['cloud-resources', 'tabdata', 'tabdoc', 'terminal', 'tabweb']),
    )
    render(<DesktopAppsPane />)

    const trackerCard = screen.getByText('追踪').closest('[data-testid="desktop-app-card"]')
    expect(trackerCard).toBeTruthy()
    fireEvent.click(within(trackerCard as HTMLElement).getByLabelText('置顶到快捷入口'))

    const stored = window.localStorage.getItem('tabtin:desktop-sidebar:pinned-apps:v1') ?? ''
    expect(stored).toContain('tabtracker')
    expect(stored).not.toContain('cloud-resources')
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已更新快捷入口',
    }))
  })

  it('syncs pinned state across independent consumers via the shared store', () => {
    // 面板与侧边栏是两个独立组件，各自消费同一个置顶 hook。这里用两个面板实例作为
    // 代理：在实例 A 里置顶，实例 B 必须在没有自身交互的情况下同步反映（回归 issue：
    // 面板置顶后侧边栏不刷新）。
    render(
      <>
        <div data-testid="consumer-a"><DesktopAppsPane /></div>
        <div data-testid="consumer-b"><DesktopAppsPane /></div>
      </>,
    )

    const consumerA = screen.getByTestId('consumer-a')
    const consumerB = screen.getByTestId('consumer-b')

    const browserCardBBefore = within(consumerB).getByText('浏览器').closest('[data-testid="desktop-app-card"]')
    expect(within(browserCardBBefore as HTMLElement).getByLabelText('置顶到快捷入口')).toBeTruthy()

    const browserCardA = within(consumerA).getByText('浏览器').closest('[data-testid="desktop-app-card"]')
    fireEvent.click(within(browserCardA as HTMLElement).getByLabelText('置顶到快捷入口'))

    const browserCardBAfter = within(consumerB).getByText('浏览器').closest('[data-testid="desktop-app-card"]')
    expect(within(browserCardBAfter as HTMLElement).getByLabelText('取消快捷入口')).toBeTruthy()
  })

  it('opens app homes and create-mode apps', () => {
    render(<DesktopAppsPane />)

    const tableCard = screen.getByText('表格').closest('[data-testid="desktop-app-card"]')
    expect(tableCard).toBeTruthy()
    fireEvent.click(within(tableCard as HTMLElement).getByText('打开'))
    expect(mockOpenAppHome).toHaveBeenCalledWith('tabdata')

    const docCard = screen.getByText('文档').closest('[data-testid="desktop-app-card"]')
    expect(docCard).toBeTruthy()
    fireEvent.click(within(docCard as HTMLElement).getByText('打开'))
    expect(mockOpenAppHome).toHaveBeenCalledWith('tabdoc')
    expect(mockCreateWebTab).not.toHaveBeenCalled()
  })
})
