import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { buildTurnNavigatorEntries, resolveActiveTurnIndex } from '../turnNavigator'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage {
  const content = partial.content ?? ''
  return {
    id: partial.id ?? `msg-${Math.random()}`,
    content,
    content_blocks_json: partial.content_blocks_json ?? (
      typeof content === 'string' && content
        ? [{ type: 'text', text: content }]
        : []
    ),
    created_at: partial.created_at ?? new Date().toISOString(),
    ...partial,
  } as ChatMessage
}

describe('buildTurnNavigatorEntries', () => {
  it('extracts real user turns with timeline index and preview', () => {
    const messages = [
      msg({ role: 'user', id: 'u1', content: '第一轮问题' }),
      msg({ role: 'assistant', id: 'a1', content: 'reply 1' }),
      msg({ role: 'user', id: 'u2', content: '第二轮问题' }),
      msg({ role: 'assistant', id: 'a2', content: 'reply 2' }),
    ]
    const entries = buildTurnNavigatorEntries(messages)
    expect(entries).toEqual([
      { index: 0, id: 'u1', preview: '第一轮问题' },
      { index: 2, id: 'u2', preview: '第二轮问题' },
    ])
  })

  it('excludes synthetic user messages (context / skill_invoke / push notification)', () => {
    const messages = [
      msg({ role: 'user', id: 'u1', content: 'real question' }),
      msg({
        role: 'user',
        id: 'env',
        message_kind: 'environment_context',
        content: '<context type="environment">\nx\n</context>',
      }),
      msg({ role: 'user', id: 'skill', content: 'SKILL.md ...', metadata: { source: 'skill_invoke' } }),
      msg({
        role: 'user',
        id: 'system-prompt',
        message_kind: 'system_prompt_context',
        content: '<identity>\nsecret system prompt\n</identity>',
      }),
      msg({ role: 'user', id: 'push', content: 'done', metadata: { triggered_by: 'push-notification' } }),
      msg({ role: 'assistant', id: 'a1', content: 'reply' }),
    ]
    const entries = buildTurnNavigatorEntries(messages)
    expect(entries.map(e => e.id)).toEqual(['u1'])
  })

  it('collapses whitespace and truncates long previews', () => {
    const long = `第一行\n第二行  ${'很'.repeat(200)}`
    const entries = buildTurnNavigatorEntries([msg({ role: 'user', id: 'u1', content: long })])
    expect(entries[0].preview.startsWith('第一行 第二行 很')).toBe(true)
    expect(entries[0].preview.endsWith('…')).toBe(true)
    expect(entries[0].preview.length).toBeLessThanOrEqual(161)
  })

  it('keeps only the first segment when one user message is split by timeline materialization', () => {
    const messages = [
      msg({ role: 'user', id: 'u1', content: 'seg A' }),
      msg({ role: 'user', id: 'u1', content: 'seg B' }),
      msg({ role: 'user', id: 'u2', content: 'next turn' }),
    ]
    const entries = buildTurnNavigatorEntries(messages)
    expect(entries.map(e => e.index)).toEqual([0, 2])
  })
})

describe('resolveActiveTurnIndex', () => {
  const entries = [
    { index: 0, id: 'u1', preview: 'a' },
    { index: 4, id: 'u2', preview: 'b' },
    { index: 9, id: 'u3', preview: 'c' },
  ]

  it('returns -1 for empty entries', () => {
    expect(resolveActiveTurnIndex([], 3)).toBe(-1)
  })

  it('maps top visible message index to its owning turn', () => {
    expect(resolveActiveTurnIndex(entries, 0)).toBe(0)
    expect(resolveActiveTurnIndex(entries, 3)).toBe(0)
    expect(resolveActiveTurnIndex(entries, 4)).toBe(1)
    expect(resolveActiveTurnIndex(entries, 8)).toBe(1)
    expect(resolveActiveTurnIndex(entries, 12)).toBe(2)
  })
})
