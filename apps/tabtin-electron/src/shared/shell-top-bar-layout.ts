/**
 * ShellTopBar + macOS 红绿灯几何 —— main / renderer 共享真源。
 * trafficLightPosition 必须与 SHELL_TOP_BAR_HEIGHT 同步，否则头像行与原生控件视觉错位。
 *
 * 行高 49：与 macOS 红绿灯视觉中线对齐的实证值（40 时 chrome 偏上）。
 */
export const SHELL_TOP_BAR_HEIGHT = 49

export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_HEIGHT = 12

export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_X = 24

/** `(SHELL_TOP_BAR_HEIGHT - capsuleHeight) / 2` —— 与顶栏 items-center 共中线 */
export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_Y = Math.round(
  (SHELL_TOP_BAR_HEIGHT - SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_HEIGHT) / 2,
)

/** 红绿灯保留区右缘 → 身份区（头像 + 昵称）水平间距。 */
export const SHELL_TOP_BAR_MAC_IDENTITY_GAP = 12

export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_POSITION = {
  x: SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_X,
  y: SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_Y,
} as const
