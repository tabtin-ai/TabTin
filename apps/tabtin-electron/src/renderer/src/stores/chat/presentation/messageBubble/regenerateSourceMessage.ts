import type { ChatMessage } from '@tabtin/chat-client'
import {
  isContextInjectionMessage,
  isRegularUserMessage,
} from '@stores/chat/messages/utils/semanticMessageCount'

/**
 * 可重试 / 可作 regenerate 源的「真实用户消息」。
 *
 * - `isRegularUserMessage`：排除 `triggered_by=push-notification`、skill_invoke
 *   等非人发轮（额度墙「重试」不得把 in-turn 后台完成通知当用户输入重发）
 * - `isContextInjectionMessage`：排除 context inject，含缺 message_kind 的
 *   legacy `<context type="environment">` wrapper
 */
function isRealUserTextMessage(message: ChatMessage): boolean {
  return isRegularUserMessage(message)
    && !isContextInjectionMessage(message)
    && typeof message.content === 'string'
    && !!message.content.trim()
}

/** 错误卡续跑门禁：有过真人用户轮即可，不要求正文非空（纯附件也算）。 */
export function hasRegularUserTurn(sessionMessages: readonly ChatMessage[]): boolean {
  return sessionMessages.some((message) => isRegularUserMessage(message))
}

export function findLastRealUserMessage(
  sessionMessages: readonly ChatMessage[],
): ChatMessage | null {
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const candidate = sessionMessages[index]
    if (isRealUserTextMessage(candidate)) {
      return candidate
    }
  }
  return null
}

export function findRegenerateSourceMessage(
  sessionMessages: readonly ChatMessage[],
  assistantMessageId: string,
): ChatMessage | null {
  const currentIndex = sessionMessages.findIndex(item => item.id === assistantMessageId)
  if (currentIndex <= 0) return null
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = sessionMessages[index]
    if (isRealUserTextMessage(candidate)) {
      return candidate
    }
  }
  return null
}
