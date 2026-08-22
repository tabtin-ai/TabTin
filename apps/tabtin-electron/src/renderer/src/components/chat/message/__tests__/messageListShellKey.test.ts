import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../blocks/types'
import { computeMessageTimelineShellKey } from '@stores/chat/presentation/messageTimeline/messageTimelineShellKey'

function msg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: 'summary',
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  } as ChatMessage
}

function entry(text: string, finalized = true): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'b0',
    block: { type: 'text', text },
    finalized,
    partial: !finalized,
  }
}

describe('computeMessageTimelineShellKey', () => {
  it('仅 blocks 正文变化（同长度、同 finalized）→ key 不变', () => {
    const a = [msg('1', { blocks: [entry('a', false)] })]
    const b = [msg('1', { blocks: [entry('b', false)] })]
    expect(computeMessageTimelineShellKey(a)).toBe(computeMessageTimelineShellKey(b))
  })

  it('assistant 的 content（text_summary）变化不打穿 shellKey', () => {
    const blocks = [entry('全文', false)]
    const a = [msg('1', { content: '甲'.repeat(200), blocks })]
    const b = [msg('1', { content: '乙'.repeat(200), blocks })]
    expect(computeMessageTimelineShellKey(a)).toBe(computeMessageTimelineShellKey(b))
  })

  it('user 的 content 变化 → key 变（气泡正文在 content）', () => {
    const a = [msg('u1', { role: 'user', content: 'hello' })]
    const b = [msg('u1', { role: 'user', content: 'hello!' })]
    expect(computeMessageTimelineShellKey(a)).not.toBe(computeMessageTimelineShellKey(b))
  })

  it('发送者身份变化 → key 变（共享消息名牌及时刷新）', () => {
    const owner = [msg('u1', { role: 'user', sender_user_id: 'owner-1' })]
    const grantee = [msg('u1', {
      role: 'user',
      sender_user_id: 'grantee-1',
      sender_display_name: '访问者',
    })]
    expect(computeMessageTimelineShellKey(owner))
      .not.toBe(computeMessageTimelineShellKey(grantee))
  })

  it('空 → 有块 → key 变', () => {
    expect(computeMessageTimelineShellKey([msg('1')]))
      .not.toBe(computeMessageTimelineShellKey([msg('1', { blocks: [entry('x')] })]))
  })

  it('未 finalize → finalize → key 变', () => {
    expect(computeMessageTimelineShellKey([msg('1', { blocks: [entry('x', false)] })]))
      .not.toBe(computeMessageTimelineShellKey([msg('1', { blocks: [entry('x', true)] })]))
  })

  it('脏的稀疏 blocks 不会让列表 shell key 崩溃', () => {
    const sparse = [] as ContentBlockEntry[]
    sparse[1] = entry('x', true)
    expect(() => computeMessageTimelineShellKey([msg('1', { blocks: sparse })])).not.toThrow()
    expect(computeMessageTimelineShellKey([msg('1', { blocks: sparse })]))
      .toBe(computeMessageTimelineShellKey([msg('1', { blocks: [entry('x', true)] })]))
  })

  it('#9341 error_info_json 引用变化 → key 变', () => {
    const a = [msg('1', { error_info_json: { error_class: 'LLM_ERROR' } })]
    const b = [msg('1', {
      error_info_json: {
        error_class: 'LLM_BILLING_ERROR',
        category: 'organization_insufficient_credits',
      },
    })]
    expect(computeMessageTimelineShellKey(a)).not.toBe(computeMessageTimelineShellKey(b))
  })
})
