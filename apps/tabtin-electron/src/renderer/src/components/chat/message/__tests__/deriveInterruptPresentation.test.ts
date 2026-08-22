/**
 * ：历史恢复后消息级「已中断」徽标须认 stop_reason / error_info_json。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  deriveInterruptPresentation,
  isAssistantInterruptedMessage,
} from '@stores/chat/presentation/messageBubble/messageBubblePresentationDerivers'

const t = (key: string) => key

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'ai-1',
    role: 'assistant',
    content: '半截回复',
    created_at: '2026-07-25T00:00:00.000Z',
    ...overrides,
  } as ChatMessage
}

describe('isAssistantInterruptedMessage / deriveInterruptPresentation', () => {
  it('stop_reason=aborted（历史恢复）→ interrupted', () => {
    const message = msg({ stop_reason: 'aborted', intent: null })
    expect(isAssistantInterruptedMessage(message)).toBe(true)
    expect(deriveInterruptPresentation({
      message,
      metadata: null,
      t,
      locale: 'zh-CN',
    }).isInterrupted).toBe(true)
  })

  it('error_info_json.category=aborted → interrupted', () => {
    expect(isAssistantInterruptedMessage(msg({
      stop_reason: 'error',
      error_info_json: { category: 'aborted', aborted: true },
    }))).toBe(true)
  })

  it('内存 intent=interrupted 仍兼容', () => {
    expect(isAssistantInterruptedMessage(msg({ intent: 'interrupted' }))).toBe(true)
  })

  it('正常 end_turn → 非 interrupted', () => {
    expect(isAssistantInterruptedMessage(msg({ stop_reason: 'end_turn' }))).toBe(false)
  })

  it('旧 metadata.aborted 仍兼容', () => {
    expect(isAssistantInterruptedMessage(
      msg({ stop_reason: null }),
      { aborted: true, errorClass: 'ABORT' },
    )).toBe(true)
  })
})
