import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  findLastRealUserMessage,
  findRegenerateSourceMessage,
  hasRegularUserTurn,
} from '@stores/chat/presentation/messageBubble/regenerateSourceMessage'

function buildMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  messageKind?: string,
  metadata?: Record<string, unknown>,
): ChatMessage {
  return {
    id,
    role,
    content,
    text_summary: content,
    created_at: '2026-07-03T00:00:00.000Z',
    ...(messageKind ? { message_kind: messageKind } : {}),
    ...(metadata ? { metadata } : {}),
  } as ChatMessage
}

describe('findRegenerateSourceMessage', () => {
  it('重新生成时跳过 environment_context，选择前一条真实用户消息', () => {
    const realUser = buildMessage('user-1', 'user', '你好')
    const contextUser = buildMessage(
      'ctx-1',
      'user',
      '<context type="environment">hidden</context>',
      'environment_context',
    )
    const assistant = buildMessage('assistant-1', 'assistant', '回复')

    expect(findRegenerateSourceMessage([realUser, contextUser, assistant], assistant.id)).toBe(realUser)
  })

  it('没有真实用户消息时返回 null', () => {
    const contextUser = buildMessage(
      'ctx-1',
      'user',
      '<context type="environment">hidden</context>',
      'environment_context',
    )
    const assistant = buildMessage('assistant-1', 'assistant', '回复')

    expect(findRegenerateSourceMessage([contextUser, assistant], assistant.id)).toBeNull()
  })
})

describe('hasRegularUserTurn', () => {
  it('空正文的真人用户轮也算有过用户轮', () => {
    const attachmentOnly = buildMessage('user-1', 'user', '')
    expect(hasRegularUserTurn([attachmentOnly])).toBe(true)
    expect(findLastRealUserMessage([attachmentOnly])).toBeNull()
  })

  it('只有 push-notification 不算有过用户轮', () => {
    const push = buildMessage('push-1', 'user', 'done', undefined, {
      triggered_by: 'push-notification',
    })
    expect(hasRegularUserTurn([push])).toBe(false)
  })
})

describe('findLastRealUserMessage', () => {
  it('错误卡重试时跳过 environment_context，选择前一条真实用户消息', () => {
    const realUser = buildMessage('user-1', 'user', '帮我查一下热门 AI 项目')
    const contextUser = buildMessage(
      'ctx-1',
      'user',
      '<context type="environment">hidden</context>\n<relevant_skills>hidden</relevant_skills>',
      'environment_context',
    )
    const assistantError = buildMessage('assistant-1', 'assistant', '网络连接异常')

    expect(findLastRealUserMessage([realUser, contextUser, assistantError])).toBe(realUser)
  })

  it('错误卡重试时跳过缺少 message_kind 的 legacy environment wrapper', () => {
    const realUser = buildMessage('user-1', 'user', '继续')
    const legacyContext = buildMessage(
      'ctx-1',
      'user',
      '<context type="environment">\ncurrent_datetime: 2026\n</context>',
    )

    expect(findLastRealUserMessage([realUser, legacyContext])).toBe(realUser)
  })

  it('不会把 referenced context 当作 environment 注入跳过', () => {
    const referencedContext = buildMessage(
      'user-1',
      'user',
      '<context type="referenced" stale_after_turn="x">\n文档内容\n</context>\n请总结',
    )

    expect(findLastRealUserMessage([referencedContext])).toBe(referencedContext)
  })

  it('没有真实用户消息时返回 null', () => {
    const contextUser = buildMessage(
      'ctx-1',
      'user',
      '<context type="environment">hidden</context>',
      'environment_context',
    )

    expect(findLastRealUserMessage([contextUser])).toBeNull()
  })

  it('额度墙重试跳过 push-notification，回到真正的用户输入', () => {
    const realUser = buildMessage('user-1', 'user', '打开小红书笔记')
    const pushUser = buildMessage(
      'push-1',
      'user',
      '3 background commands completed while you were doing other work:\n\n<task-notification>',
      'llm',
      { triggered_by: 'push-notification' },
    )
    const assistantError = buildMessage('assistant-1', 'assistant', '已达消费上限')

    expect(findLastRealUserMessage([realUser, pushUser, assistantError])).toBe(realUser)
  })

  it('重新生成时跳过 push-notification 源消息', () => {
    const realUser = buildMessage('user-1', 'user', '继续分析')
    const pushUser = buildMessage(
      'push-1',
      'user',
      'A background command completed…',
      'llm',
      { triggered_by: 'push-notification' },
    )
    const assistant = buildMessage('assistant-1', 'assistant', '好的')

    expect(
      findRegenerateSourceMessage([realUser, pushUser, assistant], assistant.id),
    ).toBe(realUser)
  })
})
