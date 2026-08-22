/**
 * 轮次谓词。
 *
 * 唯一分界：正向 `isRegularUserMessage`（见 semanticMessageCount）。
 * - 用户轮窗口 / 轮次导航 / peer 扫描：只被真实用户消息打断。
 * - 助手气泡：连续 llm+tool_artifact 由 messageRuns 合并；有缺口则就地渲染，
 *   同用户轮续写靠 timeline row 的 `hideAgentBadge`（不跨缺口拼块）。
 *
 * `canHostTurnArtifacts` 只约束产物挂载点，≠ 分轮。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import { isRegularUserMessage } from '@/stores/chat/messages/utils/semanticMessageCount'

export { isRegularUserMessage }

/** tool_artifact：产物气泡，块可并入同 run 的 BlockTimeline。 */
export function isToolArtifactMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && (message.message_kind ?? 'llm') === 'tool_artifact'
}

/** 主 Agent 的 llm 文本/工具输出段。 */
export function isLlmAssistantSegment(message: ChatMessage | null | undefined): boolean {
  if (!message) return false
  if (message.role !== 'assistant') return false
  return (message.message_kind ?? 'llm') === 'llm'
}

/** ：审批 / 追问事实行（UI 整卡隐藏）。 */
export function isHitlInteractionMessage(message: ChatMessage): boolean {
  return (message.message_kind ?? 'llm') === 'hitl_interaction'
}

/**
 * MessageList 找相邻 llm 时跳过：不是真实用户、也不是 llm 锚点。
 * 用于 footer / -mt-3 / hideAgentBadge 的 peer 扫描。
 */
export function shouldSkipInTurnScan(message: ChatMessage | null | undefined): boolean {
  if (!message) return true
  if (isRegularUserMessage(message)) return false
  if (isLlmAssistantSegment(message)) return false
  return true
}

/**
 * 可否作为「本轮产物」挂载点（可见的 assistant 内容）。
 * 仅影响挂载，不影响分轮。
 */
export function canHostTurnArtifacts(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  const kind = message.message_kind ?? 'llm'
  return kind === 'llm' || kind === 'tool_artifact' || kind === 'error_envelope'
}
