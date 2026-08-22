import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { streamingContent } from '../../../execution/streamingContent'
import { resolveComposerStopMode } from '../composerStopDecision'

describe('resolveComposerStopMode', () => {
  afterEach(() => {
    streamingContent.clearAll()
  })

  it('尚无实质输出 → withdraw_and_restore', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '帮我改这段',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '帮我改这段',
      },
    })
    expect(mode).toBe('withdraw_and_restore')
  })

  it('流式正文已出现 → stop_only', () => {
    streamingContent.set('s1', 'assistant-1', '已经开始写了')
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '帮我改这段',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '帮我改这段',
      },
    })
    expect(mode).toBe('stop_only')
  })

  it('工具已启动 → stop_only', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '跑一下',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '跑一下',
      },
      toolEvents: [{
        id: 'tool-1',
        toolName: 'run_terminal',
        phase: 'start',
      } as never],
    })
    expect(mode).toBe('stop_only')
  })

  it('助手气泡已有正文 → stop_only', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '写一段',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '好的，开始写',
          created_at: '2026-07-14T00:00:01.000Z',
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '写一段',
      },
    })
    expect(mode).toBe('stop_only')
  })

  it('无 snapshot 且最近 user 是 push → stop_only，不撤回上一真人轮', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '真问题',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'push-1',
          role: 'user',
          content: '<task-notification>',
          created_at: '2026-07-14T00:00:01.000Z',
          metadata: { triggered_by: 'push-notification' },
        } as ChatMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          created_at: '2026-07-14T00:00:02.000Z',
        } as ChatMessage,
      ],
    })
    expect(mode).toBe('stop_only')
  })

  it('已有非空 thinking → stop_only，保留本轮用户消息边界', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '写一段',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          created_at: '2026-07-14T00:00:01.000Z',
          content_blocks_json: [{ type: 'thinking', thinking: '先想想' }],
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '写一段',
      },
    })
    expect(mode).toBe('stop_only')
  })

  it('早期存档的非空 thinking text → stop_only，保留本轮用户消息边界', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '写一段',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          created_at: '2026-07-14T00:00:01.000Z',
          content_blocks_json: [{ type: 'thinking', text: '先想想' }],
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '写一段',
      },
    })
    expect(mode).toBe('stop_only')
  })

  it('仅有空 thinking 占位壳 → withdraw_and_restore', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '写一段',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          created_at: '2026-07-14T00:00:01.000Z',
          content_blocks_json: [{ type: 'thinking', thinking: '' }],
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '写一段',
      },
    })
    expect(mode).toBe('withdraw_and_restore')
  })

  it('已有 live wrapper thinking → stop_only', () => {
    const mode = resolveComposerStopMode({
      sessionId: 's1',
      messages: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '写一段',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          created_at: '2026-07-14T00:00:01.000Z',
          blocks: [{ block: { type: 'thinking', thinking: '正在梳理步骤' } }],
        } as ChatMessage,
      ],
      activeSubmitted: {
        clientMessageId: 'c1',
        localMessageId: 'temp-user-1',
        message: '写一段',
      },
    })
    expect(mode).toBe('stop_only')
  })
})
