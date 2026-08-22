import { getRestrictedShellAllowlist, type AgentModeName } from '@tabtin/agent-modes'

/**
 * ask / plan / study 都是 `tabtin-readonly` 受限模式。
 * 它们可进行浏览器导航与查看，但不能执行页面交互或其他写命令。
 */
export function shouldInjectBrowserNavigationAllowlist(mode: AgentModeName): boolean {
  return getRestrictedShellAllowlist(mode) === 'tabtin-readonly'
}
