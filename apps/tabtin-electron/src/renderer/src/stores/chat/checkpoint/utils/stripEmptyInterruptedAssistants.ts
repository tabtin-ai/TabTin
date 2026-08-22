/**
 * ：全量回退截断写出前，剥掉「无实质输出 + 已中断」的空 assistant 壳。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import { isEmptyInterruptedAssistantShell } from '../../messages/utils/emptyInterruptedAssistant'

/** 从 keep 前缀去掉空 interrupted assistant（不改动 user / 有实质的 assistant）。 */
export function stripEmptyInterruptedAssistants(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.filter((message) => !isEmptyInterruptedAssistantShell(message))
}
