import type { ContextItem } from './registry/types'
import { DESKTOP_TAB_TYPE } from './desktopTabHandler'

export interface WorkbenchTabBarModelOptions {
  visibleItems: ContextItem[]
  sidebarMode: 'desktop' | 'conversations'
  isImConversationScope: boolean
  isSharedSessionScope?: boolean
  activeTabType: ContextItem['type']
  /** 任务会话隔离 scope（conversation:*）才允许「关工作台 = 对话聚焦」 */
  canCollapseHomeToChatFocus?: boolean
}

export function buildWorkbenchTabBarModel({
  visibleItems,
  sidebarMode: _sidebarMode,
  isImConversationScope,
  isSharedSessionScope = false,
  activeTabType,
  canCollapseHomeToChatFocus = false,
}: WorkbenchTabBarModelOptions) {
  const items = visibleItems.filter(
    item => item.type !== DESKTOP_TAB_TYPE,
  )
  // 工作台本身是固定标签（桌面模式 / 普通对话模式）；IM 会话不钉，避免挤占消息主路径。
  // 「更多应用」是独立的 apphome:desktop-apps 标签，不得与工作台共用文案或顶替首页。
  const showHome = !isImConversationScope && !isSharedSessionScope
  // 只剩工作台时允许关闭：语义等同切到对话聚焦，桌面/IM 不适用。
  const homeClosable = showHome && items.length === 0 && canCollapseHomeToChatFocus

  return {
    items,
    showHome,
    homeClosable,
    isHomeActive: activeTabType === 'home'
      || activeTabType === DESKTOP_TAB_TYPE,
    shouldRender: showHome || items.length > 0,
  }
}
