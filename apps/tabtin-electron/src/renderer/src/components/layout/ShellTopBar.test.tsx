import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { toggleSidebar, setGlobalSearchOpen } = vi.hoisted(() => ({
  toggleSidebar: vi.fn(),
  setGlobalSearchOpen: vi.fn(),
}))

let sidebarCollapsed = false

vi.mock('@stores/useAuthStore', () => ({
  selectIsAuthenticated: (state: { isAuthenticated: boolean }) => state.isAuthenticated,
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: (selector: (state: {
    sidebarCollapsed: boolean
    toggleSidebar: typeof toggleSidebar
    setGlobalSearchOpen: typeof setGlobalSearchOpen
  }) => unknown) =>
    selector({ sidebarCollapsed, toggleSidebar, setGlobalSearchOpen }),
}))

vi.mock('./OrganizationProfileButton', () => ({
  TopBarOrganizationSwitcher: () => <span data-testid="org-switcher">org</span>,
}))

vi.mock('@/utils/featureFlags', () => ({
  GLOBAL_SEARCH_UI_ENABLED: true,
}))

vi.mock('@components/chat/notice/NetworkConnectionIndicator', () => ({
  NetworkConnectionIndicator: ({ placement }: { placement?: string }) => (
    <button type="button" data-testid="shell-top-bar-network-indicator" data-placement={placement}>
      net
    </button>
  ),
}))

vi.mock('@components/resource-monitor/ResourceMonitorSidebarIndicator', () => ({
  ResourceMonitorSidebarIndicator: ({ placement }: { placement?: string }) => (
    <button type="button" data-testid="shell-top-bar-performance-monitor" data-placement={placement}>
      perf
    </button>
  ),
}))

vi.mock('@components/platform/window-controls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}))

import { WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH } from '@components/platform/drag-region'
import { ShellTopBar } from './ShellTopBar'

describe('ShellTopBar', () => {
  it('侧栏展开时在顶栏组织切换左侧提供折叠入口', () => {
    sidebarCollapsed = false
    render(<ShellTopBar isMac={false} isWindowFullScreen={false} />)

    expect(screen.getByTestId('org-switcher')).toBeTruthy()
    const collapse = screen.getByTestId('shell-top-bar-sidebar-collapse')
    fireEvent.click(collapse)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('侧栏折叠时在顶栏组织切换左侧提供展开入口', () => {
    sidebarCollapsed = true
    toggleSidebar.mockClear()
    render(<ShellTopBar isMac={false} isWindowFullScreen={false} />)

    const expand = screen.getByTestId('shell-top-bar-sidebar-expand')
    fireEvent.click(expand)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('顶栏居中提供全局搜索入口', () => {
    setGlobalSearchOpen.mockClear()
    render(<ShellTopBar isMac={false} isWindowFullScreen={false} />)

    expect(screen.getByTestId('shell-top-bar-global-search-slot')).toBeTruthy()
    fireEvent.click(screen.getByTestId('shell-top-bar-global-search'))
    expect(setGlobalSearchOpen).toHaveBeenCalledWith(true)
  })

  it('顶栏右侧提供网络连接与性能监控入口', () => {
    render(<ShellTopBar isMac={false} isWindowFullScreen={false} />)

    const network = screen.getByTestId('shell-top-bar-network-indicator')
    expect(network.getAttribute('data-placement')).toBe('topbar')

    const trigger = screen.getByTestId('shell-top-bar-performance-monitor')
    expect(trigger).toBeTruthy()
    expect(trigger.getAttribute('data-placement')).toBe('topbar')
  })

  it('Windows 顶栏将窗口控件放在独立 no-drag 槽，避免整行 drag 吞点击', () => {
    render(<ShellTopBar isMac={false} isWindowFullScreen={false} />)

    const drag = screen.getByTestId('shell-top-bar-drag')
    const controlsSlot = screen.getByTestId('shell-top-bar-window-controls')

    expect(drag.className).toContain('app-region-drag')
    expect(controlsSlot.className).toContain('app-region-no-drag')
    // 与左侧 chrome 共中线；勿用 items-stretch 让窗口控件贴顶
    expect(controlsSlot.className).toContain('items-center')
    expect(controlsSlot.getAttribute('style')).toContain(
      `width: ${WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH}px`,
    )
    expect(screen.getByTestId('window-controls')).toBeTruthy()
  })

  it('macOS 顶栏不渲染自绘窗口控件槽', () => {
    render(<ShellTopBar isMac isWindowFullScreen={false} />)

    expect(screen.queryByTestId('shell-top-bar-window-controls')).toBeNull()
    expect(screen.queryByTestId('window-controls')).toBeNull()
  })
})
