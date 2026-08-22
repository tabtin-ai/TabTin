/**
 * 空的已中断 assistant 壳的统一判定。
 *
 * 产品语义：中止事件可以被持久化用于恢复/审计，但如果 assistant 没有正文
 * 或 tool 输出，它不应该在聊天时间线上占一条空消息。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import { isAssistantInterruptedMessage } from './assistantInterrupt'

function isSubstantialBlockType(type: string | undefined): boolean {
  if (!type) return false
  return type === 'tool_call'
    || type === 'tool_use'
    || type === 'tool_result'
    || type === 'server_tool_use'
    || type === 'mcp_tool_use'
    || type === 'mcp_tool_result'
    || type === 'tabtin_rich_content'
    || type === 'rich_content'
    || type.endsWith('_tool_result')
}

function blockHasSubstance(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const typed = block as { type?: string; text?: string; block?: unknown }
  if (typed.block) return blockHasSubstance(typed.block)
  if (isSubstantialBlockType(typed.type)) return true
  if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim().length > 0) {
    return true
  }
  return false
}

/** 助手消息是否已有实质输出（可见正文 / tool）。 */
export function assistantMessageHasSubstance(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  if (typeof message.content === 'string' && message.content.trim().length > 0) {
    return true
  }
  const persistedBlocks = message.content_blocks_json
  if (Array.isArray(persistedBlocks) && persistedBlocks.some(blockHasSubstance)) return true
  const liveBlocks = message.blocks
  return Array.isArray(liveBlocks) && liveBlocks.some(blockHasSubstance)
}

/**
 * ：承载终态错误卡的空壳不可按「中断空壳」隐藏（否则账单/LLM 失败会空白）。
 * 用户 ABORT（error_class=ABORT / 仅 interrupted）仍可隐藏。
 */
function carriesVisibleTerminalError(
  message: ChatMessage,
  metadata?: Record<string, unknown> | null,
): boolean {
  const meta = metadata ?? (message.metadata as Record<string, unknown> | null | undefined)
  const errorInfo = message.error_info_json
  const infoClass = typeof errorInfo?.error_class === 'string' ? errorInfo.error_class : ''
  const metaClass = typeof meta?.errorClass === 'string'
    ? meta.errorClass
    : typeof meta?.error_class === 'string'
      ? meta.error_class
      : ''
  const errorClass = infoClass || metaClass
  if (errorClass && errorClass !== 'ABORT') return true
  if (meta?.isErrorMessage === true && errorClass !== 'ABORT') return true
  return false
}

export function isEmptyInterruptedAssistantShell(
  message: ChatMessage,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (message.role !== 'assistant') return false
  if (assistantMessageHasSubstance(message)) return false
  if (carriesVisibleTerminalError(message, metadata)) return false
  return isAssistantInterruptedMessage(message, metadata)
}
