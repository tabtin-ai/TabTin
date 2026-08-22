import { WELCOME_COMPOSER_LAYOUT } from '../registry/chatDesignTokens'

/**
 * 欢迎组保持既有视觉中心；内容增高时向上移动，触及安全线后钳住顶部。
 * 返回 CSS max()，让百分比基于真实聊天画布而不是浏览器窗口。
 */
export function resolveWelcomeComposerTop(composerHeight: number): string {
  const measuredHeight = Number.isFinite(composerHeight)
    ? Math.max(0, composerHeight)
    : 0

  return `max(${WELCOME_COMPOSER_LAYOUT.safeInsetPx}px, calc(50% - ${WELCOME_COMPOSER_LAYOUT.centerOffsetPx}px - ${measuredHeight / 2}px))`
}

export function resolveNewTaskWelcomeVisible(input: {
  currentSessionId: string | null
  currentSessionMessageCount: number | null | undefined
  localMessageCount: number
  isDraftSession: boolean
  isLoading: boolean
}): boolean {
  // ：首发乐观气泡已写入时必须立刻退出欢迎态（即使 draft 旗标尚未清掉）
  if (input.localMessageCount > 0) return false
  if (input.isDraftSession) return true
  if (!input.currentSessionId || input.isLoading) return false
  return input.currentSessionMessageCount === 0
}

/**
 * 欢迎模块入口仅属于空白新任务。普通会话即使未打开 App，也不能保留隐藏的可聚焦按钮。
 */
export function resolveWelcomeSuggestionBarVisible(input: {
  isNewTaskWelcome: boolean
  hasOpenApp: boolean
}): boolean {
  return input.isNewTaskWelcome && !input.hasOpenApp
}

/**
 * Workspace 底栏切换门槛：仅待发送消息 / 新任务草稿可开。
 * 正式会话保持只读（ /  Workspace 部分不变）。
 */
export function resolveCanSwitchDraftWorkspace(input: {
  isTeamDraftSpace: boolean
  isDraftSession: boolean
  currentSessionId: string | null | undefined
  draftSessionPhase: string | null | undefined
}): boolean {
  if (input.isTeamDraftSpace) return false
  const draftMessageOpen =
    input.draftSessionPhase === 'open' || input.draftSessionPhase === 'sending'
  return (
    draftMessageOpen
    || input.isDraftSession
    || !input.currentSessionId
  )
}

/**
 * Agent 身份切换门槛：个人 Workspace 正式会话也可换。
 * 团队 Space 仍锁死（执行归属不由单会话改）。
 */
export function resolveCanChangeAgent(input: {
  isTeamDraftSpace: boolean
}): boolean {
  return !input.isTeamDraftSpace
}
