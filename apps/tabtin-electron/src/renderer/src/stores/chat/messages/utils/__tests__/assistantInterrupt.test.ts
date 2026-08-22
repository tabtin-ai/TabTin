import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { isAssistantInterruptedMessage } from '../assistantInterrupt'

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    created_at: '2026-08-04T00:00:00.000Z',
    ...partial,
  } as ChatMessage
}

describe('isAssistantInterruptedMessage', () => {
  it('认 intent / stop_reason / error_info / metadata', () => {
    expect(isAssistantInterruptedMessage(msg({ intent: 'interrupted' }))).toBe(true)
    expect(isAssistantInterruptedMessage(msg({ stop_reason: 'aborted' }))).toBe(true)
    expect(isAssistantInterruptedMessage(msg({
      error_info_json: { error_class: 'ABORT' },
    }))).toBe(true)
    expect(isAssistantInterruptedMessage(
      msg({}),
      { aborted: true },
    )).toBe(true)
  })

  it('正常结束不算中断', () => {
    expect(isAssistantInterruptedMessage(msg({ stop_reason: 'end_turn' }))).toBe(false)
  })
})
