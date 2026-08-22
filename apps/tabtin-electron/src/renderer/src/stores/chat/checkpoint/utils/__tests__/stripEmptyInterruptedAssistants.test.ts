import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { isEmptyInterruptedAssistantShell } from '../../../messages/utils/emptyInterruptedAssistant'
import { stripEmptyInterruptedAssistants } from '../stripEmptyInterruptedAssistants'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return {
    content: '',
    created_at: '2026-08-04T00:00:00.000Z',
    ...partial,
  } as ChatMessage
}

describe('#9066 stripEmptyInterruptedAssistants', () => {
  it('识别空 interrupted assistant 壳', () => {
    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a1',
      role: 'assistant',
      intent: 'interrupted',
    }))).toBe(true)

    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a2',
      role: 'assistant',
      stop_reason: 'aborted',
      content: '   ',
    }))).toBe(true)
  })

  it('有正文或 tool 块的 interrupted 不算空壳', () => {
    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a1',
      role: 'assistant',
      intent: 'interrupted',
      content: '已输出一半',
    }))).toBe(false)

    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a2',
      role: 'assistant',
      intent: 'interrupted',
      content_blocks_json: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }],
    }))).toBe(false)

    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a3',
      role: 'assistant',
      intent: 'interrupted',
      content_blocks_json: [{ type: 'tool_call', tool_name: 'grep', output: 'match' }],
    }))).toBe(false)

    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a4',
      role: 'assistant',
      intent: 'interrupted',
      blocks: [{
        block_id: 'b1',
        index: 0,
        finalized: true,
        block: { type: 'server_tool_use', id: 'srv-1', name: 'web_search' },
      }],
    }))).toBe(false)
  })

  it('#9341 承载账单/终态错误的空壳不按 interrupted 隐藏', () => {
    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a-billing',
      role: 'assistant',
      stop_reason: 'aborted',
      content: '',
      error_info_json: {
        error_class: 'LLM_BILLING_ERROR',
        category: 'organization_insufficient_credits',
        error_message: '点券已用完',
      },
    }))).toBe(false)

    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a-meta',
      role: 'assistant',
      stop_reason: 'aborted',
      content: '',
      metadata: {
        isErrorMessage: true,
        errorClass: 'LLM_BILLING_ERROR',
      },
    }))).toBe(false)
  })

  it('#9341 纯 ABORT 空壳仍隐藏', () => {
    expect(isEmptyInterruptedAssistantShell(msg({
      id: 'a-abort',
      role: 'assistant',
      stop_reason: 'aborted',
      content: '',
      error_info_json: { error_class: 'ABORT', aborted: true },
    }))).toBe(true)
  })

  it('从 keep 前缀剥掉空壳，保留 user 与有实质 assistant', () => {
    const kept = stripEmptyInterruptedAssistants([
      msg({ id: 'u1', role: 'user', content: 'hello' }),
      msg({ id: 'a-empty', role: 'assistant', intent: 'interrupted' }),
      msg({ id: 'a-ok', role: 'assistant', intent: 'interrupted', content: '部分回复' }),
      msg({ id: 'u2', role: 'user', content: 'next' }),
    ])

    expect(kept.map((m) => m.id)).toEqual(['u1', 'a-ok', 'u2'])
  })
})
