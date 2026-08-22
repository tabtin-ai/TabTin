/**
 * 托盘常驻的决策纯函数。
 *
 * 独立成模块是为了单测：main-window 的 close 钩子和 tray 控制器都依赖
 * 「当前平台 + 用户设置」这一个判定，抽出来避免两处各写一份平台分支。
 */

export interface AppSettingsSnapshot {
  theme?: 'light' | 'dark' | 'system'
  language?: string
  autoStart?: boolean
  minimizeToTray?: boolean
  trayHideHintShown?: boolean
}

export interface ResolvedAppSettings {
  minimizeToTray: boolean
  autoStart: boolean
}

/**
 * 补默认值：minimizeToTray 默认开（产品口径：关闭主窗口后继续后台运行），
 * autoStart 默认关。
 */
export function resolveAppSettings(settings: AppSettingsSnapshot | undefined): ResolvedAppSettings {
  return {
    minimizeToTray: settings?.minimizeToTray !== false,
    autoStart: settings?.autoStart === true,
  }
}

/**
 * 托盘/菜单栏常驻是否生效：Windows 和 macOS 默认启用，Linux 暂不做托盘。
 */
export function isTrayModeEnabled(
  platform: NodeJS.Platform,
  settings: AppSettingsSnapshot | undefined,
): boolean {
  return (platform === 'win32' || platform === 'darwin') &&
    resolveAppSettings(settings).minimizeToTray
}

/**
 * 点 X（close 事件）时是否应改为隐藏窗口。
 * 真退出路径（isQuitting=true，如托盘菜单「退出」/ 系统关机）永远放行销毁。
 */
export function shouldHideToTrayOnClose(input: {
  platform: NodeJS.Platform
  settings: AppSettingsSnapshot | undefined
  isQuitting: boolean
}): boolean {
  if (input.isQuitting) return false
  return isTrayModeEnabled(input.platform, input.settings)
}

/**
 * 点黄色最小化按钮（或 ⌘M）时是否改为 hide，与点 X 一致保活 renderer 会话。
 * 仅 macOS：Windows 仍走任务栏最小化，关闭才收进托盘。
 */
export function shouldHideToTrayOnMinimize(input: {
  platform: NodeJS.Platform
  settings: AppSettingsSnapshot | undefined
}): boolean {
  return input.platform === 'darwin' &&
    isTrayModeEnabled(input.platform, input.settings)
}

/**
 * 是否用 Tray.setContextMenu 绑定右键菜单。
 *
 * macOS 上一旦 setContextMenu，系统会吞掉左键只弹菜单且不发 click，
 * 左键唤窗必须改用 right-click + popUpContextMenu。
 * Windows / Linux：setContextMenu 只管右键，左键 click 可单独唤窗。
 */
export function shouldUseTraySetContextMenu(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}

/**
 * 托盘图标物理像素边长（逻辑 20pt × scale）。
 * 调用方若直接拿去 resize 而不写 scaleFactor，Retina 上会显大——优先走 tray-icon.ts。
 */
export function resolveTrayIconEdgePx(
  _platform: NodeJS.Platform,
  scaleFactor = 1,
): number {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0
    ? Math.min(3, Math.max(1, Math.round(scaleFactor)))
    : 1
  return 20 * scale
}
