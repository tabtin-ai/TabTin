/**
 * 坐标模式枚举（规范 § 3.5.2 占位 · 模块四落地）。
 *
 * v1 默认 `absolute_pixel`（与现有 `DesktopExecutorService.toScreenCoords`
 * 行为一致）。模块四引入 `normalized_0_100` 后，Retina 高 DPI 屏幕上避免
 * "scaleFactor 推算失败导致点歪"。
 */
export type DesktopCoordinateMode = 'absolute_pixel' | 'normalized_0_100'

/** 默认坐标模式（v1）。模块四落地后由 Space / Agent 配置决定切换时机。 */
export const DEFAULT_DESKTOP_COORDINATE_MODE: DesktopCoordinateMode = 'absolute_pixel'
