/**
 * AppChatSync — 主窗口专属的窗口级同步协调
 *
 * 独立组件，避免 space/organization 状态变化触发 App 重渲染。
 * 主窗专属、永远存活，负责挂"必须在主窗永远在线"的窗口级同步逻辑
 * （团队切换与 IM 私信窗口的双向同步）。
 */
import { useOrganizationSync } from '@/hooks/useOrganizationSync'

export function AppChatSync() {
  // 主窗口侧：团队切换与私信窗口双向同步
  useOrganizationSync()

  return null
}
