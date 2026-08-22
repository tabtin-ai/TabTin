import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import {
  countSubagentDetailSteps,
  selectSubagentDetailMessages,
} from '../selectSubagentDetailMessages'

function makeAssistant(
  id: string,
  blocks: ContentBlockEntry[],
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    created_at: '2026-08-03T00:00:00Z',
    blocks,
  } as ChatMessage
}

function toolUse(id: string): ContentBlockEntry {
  return {
    index: 0,
    block_id: id,
    block: { type: 'tool_use', id, name: 'bash', input: {} },
    finalized: true,
    partial: false,
  } as ContentBlockEntry
}

function thinking(id: string): ContentBlockEntry {
  return {
    index: 0,
    block_id: id,
    block: { type: 'thinking', thinking: '…' },
    finalized: true,
    partial: false,
  } as ContentBlockEntry
}

describe('countSubagentDetailSteps', () => {
  it('统计 thinking + tool_use（含 mcp_tool_use / redacted_thinking）', () => {
    const messages = [
      makeAssistant('a', [
        thinking('t1'),
        toolUse('u1'),
        {
          index: 2,
          block_id: 'm1',
          block: { type: 'mcp_tool_use', id: 'm1', name: 'x', input: {} },
          finalized: true,
          partial: false,
        } as ContentBlockEntry,
        {
          index: 3,
          block_id: 'rt',
          block: { type: 'redacted_thinking' },
          finalized: true,
          partial: false,
        } as ContentBlockEntry,
        {
          index: 4,
          block_id: 'txt',
          block: { type: 'text', text: 'hi' },
          finalized: true,
          partial: false,
        } as ContentBlockEntry,
      ]),
    ]
    expect(countSubagentDetailSteps(messages)).toBe(4)
  })

  it('无 blocks 时回落 content_blocks_json', () => {
    const messages = [{
      id: 'a',
      role: 'assistant',
      content: '',
      created_at: '2026-08-03T00:00:00Z',
      content_blocks_json: [
        { type: 'thinking', thinking: 'x' },
        { type: 'tool_use', id: 'u1', name: 'bash', input: {} },
        { type: 'text', text: 'hi' },
      ],
    }] as ChatMessage[]
    expect(countSubagentDetailSteps(messages)).toBe(2)
  })
})

describe('selectSubagentDetailMessages', () => {
  it('两侧皆空 → 空数组（调用方须先把 undefined live 归一化为 []）', () => {
    expect(selectSubagentDetailMessages([], [])).toEqual([])
  })

  it('归档为空 → 用 live', () => {
    const live = [makeAssistant('l1', [toolUse('u1')])]
    expect(selectSubagentDetailMessages(live, [])).toBe(live)
  })

  it('live 为空 → 用归档', () => {
    const archive = [makeAssistant('a1', [toolUse('u1')])]
    expect(selectSubagentDetailMessages([], archive)).toBe(archive)
  })

  it('归档步数更多 → 选归档（修残缺 live 盖掉磁盘）', () => {
    const live = [makeAssistant('l1', [toolUse('u1'), thinking('t1')])]
    const archive = [makeAssistant('a1', [
      toolUse('u1'),
      thinking('t1'),
      toolUse('u2'),
      toolUse('u3'),
    ])]
    expect(selectSubagentDetailMessages(live, archive)).toBe(archive)
  })

  it('步数打平但归档消息更多 → 选归档', () => {
    const live = [makeAssistant('l1', [toolUse('u1')])]
    const archive = [
      makeAssistant('a1', [toolUse('u1')]),
      makeAssistant('a2', []),
    ]
    expect(selectSubagentDetailMessages(live, archive)).toBe(archive)
  })

  it('live 步数不少于归档 → 选 live（保留流式正文）', () => {
    const live = [makeAssistant('l1', [toolUse('u1'), toolUse('u2'), thinking('t1')])]
    const archive = [makeAssistant('a1', [toolUse('u1'), toolUse('u2')])]
    expect(selectSubagentDetailMessages(live, archive)).toBe(live)
  })
})
