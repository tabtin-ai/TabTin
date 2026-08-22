/** Shell 全局侧栏宽度约束（useUIStore.sidebarWidth 与 Space 工作台分栏共用数值）。 */

export const SIDEBAR_LAYOUT_MIN_WIDTH = 160
export const SIDEBAR_LAYOUT_MAX_WIDTH = 480
export const SIDEBAR_LAYOUT_DEFAULT_V8 = 192
export const SIDEBAR_LAYOUT_DEFAULT_V10 = 224
export const SIDEBAR_LAYOUT_DEFAULT_V11 = 256
export const SIDEBAR_LAYOUT_DEFAULT_WIDTH = 288

export const SIDEBAR_LAYOUT_HISTORICAL_DEFAULTS = new Set<number>([
  SIDEBAR_LAYOUT_DEFAULT_V8,
  SIDEBAR_LAYOUT_DEFAULT_V10,
  SIDEBAR_LAYOUT_DEFAULT_V11,
])

export function clampSidebarLayoutWidth(width: unknown): number {
  const raw = typeof width === 'number' && Number.isFinite(width) ? width : SIDEBAR_LAYOUT_DEFAULT_WIDTH
  return Math.max(
    SIDEBAR_LAYOUT_MIN_WIDTH,
    Math.min(SIDEBAR_LAYOUT_MAX_WIDTH, Math.round(raw)),
  )
}
