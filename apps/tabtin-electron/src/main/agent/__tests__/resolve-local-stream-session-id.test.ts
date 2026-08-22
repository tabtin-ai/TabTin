import { describe, expect, it } from 'vitest'
import {
  isPromptTaskId,
  normalizeChatSessionId,
  resolveLocalStreamSessionId,
} from '../resolve-local-stream-session-id'

describe('resolveLocalStreamSessionId ', () => {
  it('优先 conversationId 并剥 chat-session- 前缀', () => {
    expect(
      resolveLocalStreamSessionId({
        conversationId: 'chat-session-abc-uuid',
        sessionId: 'prompt_deadbeef',
      }),
    ).toBe('abc-uuid')
  })

  it('conversationId 缺失时用非 prompt_* 的 sessionId', () => {
    expect(
      resolveLocalStreamSessionId({
        conversationId: null,
        sessionId: 'sess-uuid',
      }),
    ).toBe('sess-uuid')
  })

  it('两者皆为 prompt_* 时经 resolveBusinessId 反查业务 UUID', () => {
    expect(
      resolveLocalStreamSessionId({
        conversationId: 'prompt_task_1',
        sessionId: 'prompt_task_1',
        resolveBusinessId: (id) => (id === 'prompt_task_1' ? 'chat-session-biz-1' : null),
      }),
    ).toBe('biz-1')
  })

  it('normalize / isPromptTaskId 辅助函数', () => {
    expect(normalizeChatSessionId('chat-session-x')).toBe('x')
    expect(normalizeChatSessionId('x')).toBe('x')
    expect(isPromptTaskId('prompt_abc')).toBe(true)
    expect(isPromptTaskId('abc')).toBe(false)
  })
})
