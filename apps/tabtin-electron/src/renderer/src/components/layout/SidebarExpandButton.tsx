import React from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useUIStore } from '@stores/useUIStore'
import { cn } from '@utils/cn'
import {
  ACTIVITY_RAIL_ICON_SIZE,
  ACTIVITY_RAIL_ICON_STROKE,
  ACTIVITY_RAIL_ITEM,
  ACTIVITY_RAIL_ITEM_INACTIVE,
  TOPBAR_CHROME_ACTION,
  TOPBAR_CHROME_ICON_SIZE,
  TOPBAR_CHROME_ICON_STROKE,
} from './sidebarUi'

/**
 * 全局侧栏开关。展开/折叠入口在 ShellTopBar 组织切换按钮左侧（折叠态与展开态同一位置）。
 *
 * `marginLeft`：可选左侧安全区（px），按需避让系统窗口控件；默认 0。
 */
export function SidebarExpandButton({
  action = 'expand',
  marginLeft = 0,
  size = 'default',
  className,
  'data-testid': dataTestId,
}: {
  action?: 'expand' | 'collapse'
  marginLeft?: number
  /** 窄栏中与主导航统一为 40px 命中面（总栏宽 56px）。 */
  size?: 'default' | 'rail'
  className?: string
  'data-testid'?: string
}) {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const isCollapseAction = action === 'collapse'
  const label = isCollapseAction ? '折叠侧边栏' : '展开侧边栏'

  return (
    <button
      type="button"
      onClick={toggleSidebar}
      title={label}
      aria-label={label}
      data-testid={dataTestId}
      style={marginLeft ? { marginLeft } : undefined}
      className={cn(
        'app-region-no-drag shrink-0 transition-colors',
        size === 'rail'
          ? cn(ACTIVITY_RAIL_ITEM, ACTIVITY_RAIL_ITEM_INACTIVE)
          : cn(TOPBAR_CHROME_ACTION, 'no-drag text-muted-foreground/60 hover:text-foreground'),
        className,
      )}
    >
      {isCollapseAction
        ? (
          <PanelLeftClose
            size={size === 'rail' ? ACTIVITY_RAIL_ICON_SIZE : TOPBAR_CHROME_ICON_SIZE}
            strokeWidth={size === 'rail' ? ACTIVITY_RAIL_ICON_STROKE : TOPBAR_CHROME_ICON_STROKE}
            className="shrink-0"
            aria-hidden
          />
        )
        : (
          <PanelLeftOpen
            size={size === 'rail' ? ACTIVITY_RAIL_ICON_SIZE : TOPBAR_CHROME_ICON_SIZE}
            strokeWidth={size === 'rail' ? ACTIVITY_RAIL_ICON_STROKE : TOPBAR_CHROME_ICON_STROKE}
            className="shrink-0"
            aria-hidden
          />
        )}
    </button>
  )
}
