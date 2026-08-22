import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { messageBubblePropsAreEqual } from '../messages/common/messageBubbleMemoCompare'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hello',
    created_at: '2026-07-27T00:00:00Z',
    ...overrides,
  } as ChatMessage
}

describe('messageBubblePropsAreEqual', () => {
  it('壳字段相同 → true（不再因 timeTick 打穿）', () => {
    const message = msg()
    const base = {
      message,
      sessionId: 's1',
      isLastAssistantMsg: false,
      sessionPulseVisible: false,
      isLastInTurn: true,
    }
    expect(messageBubblePropsAreEqual(base, { ...base })).toBe(true)
  })

  it('content 变化 → false', () => {
    const prev = { message: msg({ content: 'a' }), sessionId: 's1' }
    const next = { message: msg({ content: 'b' }), sessionId: 's1' }
    expect(messageBubblePropsAreEqual(prev, next)).toBe(false)
  })

  it('#9341 error_info_json 变化 → false', () => {
    const prev = {
      message: msg({ error_info_json: { error_class: 'LLM_ERROR' } }),
      sessionId: 's1',
    }
    const next = {
      message: msg({
        error_info_json: {
          error_class: 'LLM_BILLING_ERROR',
          category: 'organization_insufficient_credits',
        },
      }),
      sessionId: 's1',
    }
    expect(messageBubblePropsAreEqual(prev, next)).toBe(false)
  })

  it('影响气泡渲染和交互的外部 props 变化 → false', () => {
    const message = msg()
    const base = {
      message,
      sessionId: 's1',
      tabScopeKey: 'conversation:s1',
      onFork: () => {},
      onContextBlockNavigate: () => {},
      onContextBlockContextMenu: () => {},
      userAlign: 'right' as const,
      previewMode: false,
    }
    const changedProps = [
      { tabScopeKey: 'conversation:s2' },
      { onFork: () => {} },
      { onContextBlockNavigate: () => {} },
      { onContextBlockContextMenu: () => {} },
      { userAlign: 'left' as const },
      { previewMode: true },
    ]

    for (const changed of changedProps) {
      expect(messageBubblePropsAreEqual(base, { ...base, ...changed })).toBe(false)
    }
  })
})
