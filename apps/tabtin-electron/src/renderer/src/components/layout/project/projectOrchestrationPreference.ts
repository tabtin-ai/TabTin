const PROJECT_ORCHESTRATION_COLLAPSED_KEY = 'tabtin.project-orchestration-collapsed'

function preferenceKey(userId: string): string {
  return `${PROJECT_ORCHESTRATION_COLLAPSED_KEY}:${userId || 'anonymous'}`
}

/** Project 的 AI 编排入口默认收起；偏好只在当前用户的本地客户端保存。 */
export function readProjectOrchestrationCollapsed(userId: string): boolean {
  try {
    return localStorage.getItem(preferenceKey(userId)) !== 'false'
  } catch {
    return true
  }
}

export function writeProjectOrchestrationCollapsed(userId: string, collapsed: boolean): void {
  try {
    localStorage.setItem(preferenceKey(userId), String(collapsed))
  } catch {
    // 本地存储不可用时保留本次会话状态，下一次仍回到安全的默认折叠态。
  }
}
