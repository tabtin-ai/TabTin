/**
 * 助手消息「已中断」判定（UI 徽标与回退 strip 共用）。
 *
 * W3：新消息走 `stop_reason` / `error_info_json`；`intent==='interrupted'`
 * 与 metadata 兼容内存 abort 与老历史。
 */
import type { ChatMessage } from '@tabtin/chat-client'

export function isAssistantInterruptedMessage(
  message: ChatMessage,
  metadata?: Record<string, unknown> | null,
): boolean {
  const errorInfo = message.error_info_json
  const meta = metadata ?? (message.metadata as Record<string, unknown> | null | undefined)
  return message.intent === 'interrupted'
    || message.stop_reason === 'aborted'
    || errorInfo?.category === 'aborted'
    || errorInfo?.error_class === 'ABORT'
    || errorInfo?.aborted === true
    || meta?.aborted === true
    || meta?.errorClass === 'ABORT'
}
