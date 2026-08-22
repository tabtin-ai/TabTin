import { createContext, useContext } from 'react'

/**
 * 侧栏折叠后，「展开侧栏」按钮悬浮在 shell 左上角（避让 macOS 红绿灯）。
 * 为了让它不压住最左列顶栏的内容（桌面模式=标签栏 / 对话模式=聊天「新话题」栏），
 * 给那一条顶栏的左侧留出一截安全区——只作用在顶栏这一行，主内容区仍占满整宽，
 * 不再像整列 padding 那样在左边留一条全高度空白。
 *
 * 由 AppLayout 统一计算（它才知道侧栏折叠态 + 当前 chatPosition + 平台），
 * 按列下发：哪一列是最左列，哪一列才拿到 inset，另一列恒为 0。
 */
export interface ShellTopBarInset {
  /** 画布列顶栏（ContextTabs）需要的左安全区，单位 px */
  canvas: number
  /** 聊天列顶栏（ChatSessionBar）需要的左安全区，单位 px */
  chat: number
  /** 画布列顶栏需要避让右上角 Windows/Linux 窗口控件的安全区，单位 px */
  canvasRight: number
  /** 聊天列顶栏需要避让右上角 Windows/Linux 窗口控件的安全区，单位 px */
  chatRight: number
}

export const SHELL_TOP_BAR_INSET_NONE: ShellTopBarInset = {
  canvas: 0,
  chat: 0,
  canvasRight: 0,
  chatRight: 0,
}

export const ShellTopBarInsetContext = createContext<ShellTopBarInset>(SHELL_TOP_BAR_INSET_NONE)

export function useShellTopBarInset(): ShellTopBarInset {
  return useContext(ShellTopBarInsetContext)
}
