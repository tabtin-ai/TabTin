import type { ChatMessage } from '@tabtin/chat-client'
import {
  isLlmAssistantSegment,
  isRegularUserMessage,
} from '../turn/turnTransparency'

/**
 * 一个 run 是否为其所属用户轮的收尾（决定 footer / diff / checkpoint 是否落在本
 * run 气泡）。#7441：peer 扫描跳过非 llm 后，若后面还有 llm 段则本 run 非收尾
 * （不论 agent_run_id——同用户轮内多个 daemon run 只在最后一段显示尾巴）。
 */
export function isRunLastInTurn(messages: readonly ChatMessage[], lastIndex: number): boolean {
  for (let k = lastIndex + 1; k < messages.length; k++) {
    const m = messages[k]
    if (isRegularUserMessage(m)) return true
    if (isLlmAssistantSegment(m)) return false
  }
  return true
}
