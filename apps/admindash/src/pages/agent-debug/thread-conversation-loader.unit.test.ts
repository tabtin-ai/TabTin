import type { ChatMessageItem } from '@/api/chat'
import type { ThreadChatMessagesExport, ThreadOverview } from '@/types/agent-debug'
import { describe, expect, it, vi } from 'vitest'
import {
  loadThreadConversation,
  mergeContentBlocksIntoMessages,
} from './thread-conversation-loader'

describe('mergeContentBlocksIntoMessages', () => {
  it('按消息 id 合并 content_blocks 与缺失附件', () => {
    const merged = mergeContentBlocksIntoMessages(
      [
        {
          id: 'm1',
          role: 'assistant',
          message_kind: 'llm',
          content: '[工具调用]',
          attachments: [],
          trace_id: 'tr1',
          agent_run_id: null,
          model_name: null,
          stop_reason: null,
          usage: null,
          error: null,
          subagent_run_id: null,
          created_at: '2026-08-05T00:00:00Z',
        },
      ],
      {
        thread_id: 't1',
        session_id: 't1',
        source: 'chat_message',
        message_count: 1,
        messages_truncated: false,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            message_kind: 'llm',
            content: '[工具调用]',
            content_blocks_json: [{ type: 'thinking', thinking: '计划中' }],
            attachments: [
              {
                kind: 'file',
                filename: 'a.md',
                source: 'agent',
                url: 'https://cdn.example.com/a.md',
              },
            ],
            trace_id: 'tr1',
            agent_run_id: null,
            model_name: null,
            stop_reason: null,
            usage: null,
            error: null,
            subagent_run_id: null,
            created_at: '2026-08-05T00:00:00Z',
          },
        ],
        system: null,
        system_source: { kind: 'missing' },
      }
    )

    expect(merged[0]?.content_blocks_json).toEqual([{ type: 'thinking', thinking: '计划中' }])
    expect(merged[0]?.attachments?.[0]?.filename).toBe('a.md')
  })
})

describe('loadThreadConversation', () => {
  it('falls back to the existing chat API when the overview endpoint is unavailable', async () => {
    const messages: ChatMessageItem[] = [
      {
        id: 'message-1',
        role: 'user',
        content: '帮我整理这份数据',
        trace_id: 'trace-1',
        model_name: null,
        created_at: '2026-07-29T10:00:00Z',
      },
      {
        id: 'message-2',
        role: 'assistant',
        content: '已经整理完成',
        trace_id: 'trace-1',
        model_name: 'glm-5',
        created_at: '2026-07-29T10:00:01Z',
      },
    ]

    const result = await loadThreadConversation('session-1', {
      getOverview: vi.fn<() => Promise<ThreadOverview>>().mockRejectedValue(new Error('404')),
      getMessages: vi.fn().mockResolvedValue(messages),
      getChatExport: vi.fn<() => Promise<ThreadChatMessagesExport>>().mockRejectedValue(
        new Error('export unavailable')
      ),
    })

    expect(result.overview).toBeNull()
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'message-1', role: 'user', content: '帮我整理这份数据' }),
      expect.objectContaining({
        id: 'message-2',
        role: 'assistant',
        content: '已经整理完成',
        model_name: 'glm-5',
      }),
    ])
    expect(result.warning).toContain('兼容模式')
  })

  it('overview 成功后合并 chat-messages 的 content_blocks', async () => {
    const overview = {
      messages: [
        {
          id: 'message-2',
          role: 'assistant',
          message_kind: 'llm',
          content: '摘要',
          attachments: [],
          trace_id: 'trace-1',
          agent_run_id: null,
          model_name: 'glm-5',
          stop_reason: null,
          usage: null,
          error: null,
          subagent_run_id: null,
          created_at: '2026-07-29T10:00:01Z',
        },
      ],
      messages_truncated: false,
    } as unknown as ThreadOverview

    const result = await loadThreadConversation('session-1', {
      getOverview: vi.fn().mockResolvedValue(overview),
      getMessages: vi.fn(),
      getChatExport: vi.fn().mockResolvedValue({
        thread_id: 'session-1',
        session_id: 'session-1',
        source: 'chat_message',
        message_count: 1,
        messages_truncated: false,
        messages: [
          {
            id: 'message-2',
            role: 'assistant',
            message_kind: 'llm',
            content: '摘要',
            content_blocks_json: [
              { type: 'thinking', thinking: '先分析' },
              { type: 'text', text: '完整正文' },
            ],
            attachments: [],
            trace_id: 'trace-1',
            agent_run_id: null,
            model_name: 'glm-5',
            stop_reason: null,
            usage: null,
            error: null,
            subagent_run_id: null,
            created_at: '2026-07-29T10:00:01Z',
          },
        ],
        system: null,
        system_source: { kind: 'missing' },
      } satisfies ThreadChatMessagesExport),
    })

    expect(result.warning).toBeNull()
    expect(result.messages[0]?.content_blocks_json).toEqual([
      { type: 'thinking', thinking: '先分析' },
      { type: 'text', text: '完整正文' },
    ])
  })
})
