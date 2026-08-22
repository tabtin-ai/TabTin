/**
 * ShellTopBar —— QQ 式顶部外框（全平台实体标题栏行）。
 *
 * 职责：
 *   1. 给 frameless 窗口一条**实体**顶栏：mac 左侧让位红绿灯；win/linux 右侧
 *      独立 no-drag 槽承载自绘窗口控件（：不可再用整行 drag + padding 让位，
 *      否则 Electron 会把右上角留白当成拖拽区吞掉点击）。
 *   2. 左侧内容区可拖拽（行内交互控件 no-drag）。
 *   3. 左侧：侧栏展开/折叠 + 当前组织切换；居中全局搜索入口；用户头像在 ActivityRail 顶部。
 *
 * 未登录：只渲染拖拽行与红绿灯让位，不渲染组织区。
 */

import React from 'react'
import { cn } from '@utils/cn'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { useUIStore } from '@stores/useUIStore'
import {
  WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH,
  WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH,
} from '@components/platform/drag-region'
import { WindowControls } from '@components/platform/window-controls'
import { TopBarOrganizationSwitcher } from './OrganizationProfileButton'
import { SidebarExpandButton } from './SidebarExpandButton'
import { ShellTopBarGlobalSearchTrigger } from './ShellTopBarGlobalSearchTrigger'
import { NetworkConnectionIndicator } from '@components/chat/notice/NetworkConnectionIndicator'
import { ResourceMonitorSidebarIndicator } from '@components/resource-monitor/ResourceMonitorSidebarIndicator'
import { SHELL_TOP_BAR_HEIGHT, SHELL_TOP_BAR_MAC_IDENTITY_GAP } from './shellUi'

interface ShellTopBarProps {
  isMac: boolean
  isWindowFullScreen: boolean
}

export const ShellTopBar: React.FC<ShellTopBarProps> = ({
  isMac,
  isWindowFullScreen,
}) => {
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const sidebarCollapsed = useUIStore(state => state.sidebarCollapsed)
  const macTrafficLightInset = isMac && !isWindowFullScreen
  const leftInset = macTrafficLightInset
    ? WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH + SHELL_TOP_BAR_MAC_IDENTITY_GAP
    : 12

  return (
    <div
      className="relative flex w-full shrink-0 select-none"
      style={{ height: SHELL_TOP_BAR_HEIGHT }}
      data-testid="shell-top-bar"
    >
      <div
        className={cn(
          'app-region-drag relative flex min-w-0 flex-1 items-center',
        )}
        style={{
          paddingLeft: leftInset,
          paddingRight: isMac ? 12 : 0,
        }}
        data-testid="shell-top-bar-drag"
      >
        {isAuthenticated ? (
          <div className="no-drag flex min-w-0 items-center gap-1">
            <SidebarExpandButton
              action={sidebarCollapsed ? 'expand' : 'collapse'}
              data-testid={sidebarCollapsed ? 'shell-top-bar-sidebar-expand' : 'shell-top-bar-sidebar-collapse'}
            />
            <TopBarOrganizationSwitcher />
          </div>
        ) : null}
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 z-[1] w-full max-w-[min(100%,420px)] -translate-x-1/2 -translate-y-1/2 px-4"
          data-testid="shell-top-bar-global-search-slot"
        >
          <ShellTopBarGlobalSearchTrigger />
        </div>
        <div className="min-w-0 flex-1" />
        {isAuthenticated ? (
        <div className="no-drag relative z-[2] flex shrink-0 items-center gap-1">
          <NetworkConnectionIndicator placement="topbar" />
          <ResourceMonitorSidebarIndicator placement="topbar" />
        </div>
        ) : null}
      </div>
      {!isMac ? (
        <div
          className="app-region-no-drag relative z-sticky flex h-full shrink-0 items-center justify-end px-1"
          style={{ width: WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH }}
          data-testid="shell-top-bar-window-controls"
        >
          <WindowControls />
        </div>
      ) : null}
    </div>
  )
}

ShellTopBar.displayName = 'ShellTopBar'
