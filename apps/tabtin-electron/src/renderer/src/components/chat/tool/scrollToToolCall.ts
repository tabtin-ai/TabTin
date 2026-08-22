/**
 * scrollToToolCall — 主对话流锚定 ToolUseBlock 的通用机制（PRD §4.15 / 决策 2=A）
 *
 * 跨场景复用：subagent_session Pane「在对话中定位」、canvas 行点击跳到原位、
 * 错误提示锚定到对应工具调用 etc.
 *
 * 实现思路：
 *   1. 反查 (sessionId, messageId)：扫 useChatStore.messagesBySessionId 找包含此
 *      `tool_use.id` 的 message
 *   2. 切到对应 chat session（与当前 active 不同时）
 *   3. 写入 scrollTargetMessageId + scrollTargetHighlight=true，MessageList 现有
 *      effect 会 scrollToIndex + 1.5s 高亮 pulse（PRD 3.5）
 *
 * 不耦合 subagent：未来 canvas、错误提示、@提及 anchor 等都可用同一入口。
 */

import { resolveSessionScopeId } from '@tabtin/app-shell'
import { useChatStore } from '@/stores/chat/useChatStore'
import { logger } from '@/utils/logger'
import { readMessageBlocks } from '../blocks/messageContentBlocks'

type ToolUseLike = { type?: string; id?: string }

/**
 * 反查包含指定 tool_use.id 的 (sessionId, messageId)。
 *
 * 走统一读入口 readMessageBlocks（只读 message.blocks；历史由 hydrate 灌入， / ）。
 *
 * 返回 null 表示找不到——可能 tool_call_id 写在 server_tool_use / mcp_tool_use
 * 类型上（schema 一致），也可能消息还没回放完成。调用方应 best-effort，找不到
 * 时给 toast 提示用户「定位失败」即可。
 */
export function findMessageIdByToolCallId(toolCallId: string): { sessionId: string; messageId: string } | null {
  const state = useChatStore.getState()
  for (const [sessionId, messages] of Object.entries(state.messagesBySessionId)) {
    if (!messages) continue
    for (const msg of messages) {
      for (const block of readMessageBlocks(msg)) {
        const tool = block as ToolUseLike
        if (
          (tool.type === 'tool_use' || tool.type === 'server_tool_use' || tool.type === 'mcp_tool_use')
          && tool.id === toolCallId
        ) {
          return { sessionId, messageId: msg.id }
        }
      }
    }
  }
  return null
}

export interface ScrollToToolCallOptions {
  /** 找不到时回调（用于上层 toast 提示） */
  onMissing?: (toolCallId: string) => void
}

/**
 * 跳到主对话流中某个工具调用对应的卡片 / 块。
 *
 * - 找到 message：切到对应 chat session（如有跨）→ scrollToMessage（含 1.5s 高亮 pulse）
 * - 找不到：调 `onMissing` 回调，调用方决定如何提示用户
 */
export function scrollToToolCall(toolCallId: string, options: ScrollToToolCallOptions = {}): void {
  if (!toolCallId) return
  const located = findMessageIdByToolCallId(toolCallId)
  if (!located) {
    logger.debug('[scrollToToolCall] tool_use.id not found', { toolCallId })
    options.onMissing?.(toolCallId)
    return
  }
  const { sessionId, messageId } = located
  const store = useChatStore.getState()
  if (store.currentSessionId !== sessionId) {
    // 跨 session 跳转——通过当前 Space 的 setCurrentSessionForSpace 触发切换
    const session = store.getSessionById(sessionId)
    const scopeId = resolveSessionScopeId(session)
    if (scopeId) {
      store.setCurrentSessionForSpace(scopeId, sessionId)
    }
  }
  // scrollToMessage 自带 1.5s 高亮 pulse（MessageList highlightedMessageId 实现）
  store.scrollToMessage(sessionId, messageId)
}
