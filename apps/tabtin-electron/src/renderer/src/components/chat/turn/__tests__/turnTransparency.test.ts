import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  canHostTurnArtifacts,
  isLlmAssistantSegment,
  isRegularUserMessage,
  isToolArtifactMessage,
  shouldSkipInTurnScan,
} from '../turnTransparency'

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    created_at: '2026-07-04T00:00:00.000Z',
    message_kind: 'llm',
    ...partial,
  } as ChatMessage
}

describe('turnTransparency ', () => {
  it('仅真实用户分轮（正向谓词）', () => {
    expect(isRegularUserMessage(msg({ id: 'u', role: 'user', message_kind: undefined }))).toBe(true)
    expect(
      isRegularUserMessage(
        msg({
          id: 'p',
          role: 'user',
          message_kind: 'agent_profile_context',
          content: '<context type="agent-profile">x</context>',
        }),
      ),
    ).toBe(false)
    expect(
      isRegularUserMessage(
        msg({
          id: 'push',
          role: 'user',
          message_kind: undefined,
          metadata: { triggered_by: 'push-notification' },
        }),
      ),
    ).toBe(false)
    expect(
      isRegularUserMessage(
        msg({
          id: 'c',
          role: 'user',
          message_kind: 'compaction_summary',
          content: '[对话摘要]',
        }),
      ),
    ).toBe(false)
    expect(
      isRegularUserMessage(
        msg({
          id: 'att',
          role: 'user',
          content: '',
          attachments_json: [{ type: 'file', filename: 'a.pdf', mime_type: 'application/pdf', size: 1 }],
        }),
      ),
    ).toBe(true)
    expect(
      isRegularUserMessage(
        msg({
          id: 'reply',
          role: 'user',
          content: '跟进',
          reply_to_message_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          reply_to_preview: { role: 'assistant', author: 'A', text: 'prev' },
        }),
      ),
    ).toBe(true)
  })

  it('peer 扫描：跳过非真实用户 / 非 llm；挂载点', () => {
    expect(isLlmAssistantSegment(msg({ id: 'a' }))).toBe(true)
    expect(isToolArtifactMessage(msg({ id: 't', message_kind: 'tool_artifact' }))).toBe(true)
    expect(shouldSkipInTurnScan(msg({ id: 'a' }))).toBe(false)
    expect(shouldSkipInTurnScan(msg({ id: 'u', role: 'user', message_kind: undefined }))).toBe(false)
    expect(shouldSkipInTurnScan(msg({ id: 't', message_kind: 'tool_artifact' }))).toBe(true)
    expect(
      shouldSkipInTurnScan(
        msg({
          id: 'push',
          role: 'user',
          message_kind: undefined,
          metadata: { triggered_by: 'push-notification' },
        }),
      ),
    ).toBe(true)
    expect(
      shouldSkipInTurnScan(
        msg({
          id: 'c',
          role: 'user',
          message_kind: 'compaction_summary',
          content: '[对话摘要]',
        }),
      ),
    ).toBe(true)
    expect(canHostTurnArtifacts(msg({ id: 'a' }))).toBe(true)
    expect(canHostTurnArtifacts(msg({ id: 'e', message_kind: 'error_envelope' }))).toBe(true)
  })

  it('#7533 compaction 夹在同轮 llm 之间时 peer 扫描穿透', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', content: '已转后台。' }),
      msg({
        id: 'push',
        role: 'user',
        metadata: { triggered_by: 'push-notification' },
        content: 'A background command completed',
      }),
      msg({ id: 'a2', role: 'assistant', content: '[工具调用]' }),
      msg({
        id: 'comp',
        role: 'user',
        message_kind: 'compaction_summary',
        content: '[对话摘要]',
      }),
      msg({ id: 'a3', role: 'assistant', content: '7533收到完成' }),
    ]
    // 从 a3 向前找：跳过 compaction → 命中 a2（同轮续写应藏头）
    let prev: ChatMessage | null = null
    for (let i = 4 - 1; i >= 0; i--) {
      if (!shouldSkipInTurnScan(messages[i])) {
        prev = messages[i]
        break
      }
    }
    expect(prev?.id).toBe('a2')
    expect(isLlmAssistantSegment(prev)).toBe(true)
  })
})
