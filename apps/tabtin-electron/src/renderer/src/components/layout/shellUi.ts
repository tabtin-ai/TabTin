/**
 * shellUi — Shell 级玻璃面视觉 token（全局唯一真源）
 *
 * 与 globals.css 中的 `.shell-canvas` / `.surface-glass*` 组件类配套。
 * Sidebar、主画布、聊天辅列等浮动卡片应复用此处常量，避免散落 magic class。
 */

import {
  SHELL_TOP_BAR_HEIGHT,
  SHELL_TOP_BAR_MAC_IDENTITY_GAP,
  SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_HEIGHT,
  SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_Y,
} from '../../../../shared/shell-top-bar-layout'

/** 根画布：暖中性底 + Primary/Secondary 双氛围光斑（见 globals.css `.shell-canvas::before`） */
export const SHELL_CANVAS_CLASS = 'shell-canvas'

/** 标准玻璃卡片 — composer、底栏等（暖色 --glass-bg） */
export const SURFACE_GLASS = 'surface-glass'

/** 侧栏实色底（浅色 #f9f9f9 / 深色 #141414，见 globals.css .surface-sidebar-glass） */
export const SURFACE_SIDEBAR_GLASS = 'surface-sidebar-glass'

/** 略实一点的玻璃 — 底栏、输入区、嵌套 footer */
export const SURFACE_GLASS_STRONG = 'surface-glass-strong'

/** 画布主卡片 — 无边框、无阴影的通透主工作区背景 */
export const SURFACE_CANVAS_CARD = 'surface-canvas-card'

/**
 * 圆角随量级反向分级（design-system §12），档位 4 / 12 / 20：
 * 巨型结构面最方（4px），大容器次之（12px），中型浮层最圆（20px）——拉开层级区分度。
 */

/** 统一卡片布局 + 玻璃面（Shell 分栏主/辅位列 — 巨型结构面 4px） */
export const SHELL_GLASS_CARD_CLASS =
  'relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden rounded-[4px] surface-glass'

export const SHELL_GLASS_SECONDARY_CARD_CLASS =
  'relative h-full min-h-0 min-w-0 flex-shrink-0 overflow-hidden rounded-[4px] surface-glass'

/** 页面背景轨道 — 侧栏 / 对话区直接落在 shell canvas 上，不再画独立边框或卡片 */
export const SHELL_PLAIN_RAIL_CLASS =
  'relative h-full min-h-0 min-w-0 overflow-hidden bg-transparent'

/** 对话模式画布折叠时右侧 CollapsedCanvasRail 固定宽度（与展开画布辅位分列对齐）。 */
export const SHELL_COLLAPSED_CANVAS_RAIL_WIDTH = 248
export const SHELL_COLLAPSED_CANVAS_RAIL_ICON_WIDTH = 40

/**
 * ActivityRail 常驻窄栏固定宽度：56px（40px 命中面 + 两侧各 8px）。
 * 红绿灯避让由 ShellTopBar 横轴承担，窄栏不必拉到 traffic-light 右缘对齐。
 */
export const SHELL_ACTIVITY_RAIL_WIDTH = 56

export {
  SHELL_TOP_BAR_HEIGHT,
  SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_HEIGHT,
  SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_Y,
  SHELL_TOP_BAR_MAC_IDENTITY_GAP,
}

/** 第二列侧栏内容顶距：ShellTopBar 已在列外，仅为右上角 chrome 操作条留空。 */
export const SHELL_SIDEBAR_PANEL_TOP_CLASS = 'pt-2'

/** ActivityRail 头像顶距 — 与第二列「新任务」首行上边距对齐（同 SHELL_SIDEBAR_PANEL_TOP_CLASS）。 */
export const ACTIVITY_RAIL_TOP_CLASS = SHELL_SIDEBAR_PANEL_TOP_CLASS

/** 任务顶栏 / 画布 ContextTabs 行高 — 与 ContextTabs `min-h-12` 对齐，保证分列底边齐平。 */
export const SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS = 'h-12 min-h-12'

/** 主画布轨道 — 画布作为主区域卡片，使用无边框卡片背景与通透玻璃感 */
export const SHELL_CANVAS_CARD_CLASS =
  'relative h-full min-h-0 min-w-0 overflow-hidden rounded-[12px] surface-canvas-card'

/** 独立面板（ContentArea card 模式等 — 巨型结构面 4px） */
export const SHELL_GLASS_PANEL_CLASS = 'relative h-full w-full flex flex-col overflow-hidden min-w-0 rounded-[4px] surface-glass'

/** Sidebar 内嵌底栏（profile / 团队切换 — 大容器 12px） */
export const SHELL_GLASS_FOOTER_CLASS =
  'mx-1.5 mb-1.5 shrink-0 overflow-hidden rounded-[12px] bg-transparent'

/** 浮动 composer / Command-bar 风格输入容器（大容器 12px） */
export const SHELL_GLASS_COMPOSER_CLASS =
  'relative rounded-[12px] surface-glass-strong transition-[box-shadow,background-color] duration-200'
