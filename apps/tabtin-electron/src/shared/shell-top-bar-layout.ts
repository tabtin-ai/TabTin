/**
 * ShellTopBar + macOS 红绿灯几何 —— main / renderer 共享真源。
 * trafficLightPosition 必须与 SHELL_TOP_BAR_HEIGHT 同步，否则头像行与原生控件视觉错位。
 *
 * 行高 49：给 h-8 chrome 上下各留约 8.5px，整行在浅蓝顶栏里垂直居中。
 */
export const SHELL_TOP_BAR_HEIGHT = 49

export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_HEIGHT = 12

export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_X = 24

/**
 * hidden titleBar 会再叠一层原生 inset，Y 要比「(行高-12)/2」更靠上，
 * 才能和顶栏 items-center 的侧栏/组织胶囊共一条水平中线。
 */
export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_NATIVE_INSET_Y = 6

export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_Y = Math.max(
  0,
  Math.round((SHELL_TOP_BAR_HEIGHT - SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_HEIGHT) / 2)
    - SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_NATIVE_INSET_Y,
)

/** 红绿灯保留区右缘 → 身份区（头像 + 昵称）水平间距。 */
export const SHELL_TOP_BAR_MAC_IDENTITY_GAP = 12

export const SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_POSITION = {
  x: SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_X,
  y: SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_Y,
} as const
