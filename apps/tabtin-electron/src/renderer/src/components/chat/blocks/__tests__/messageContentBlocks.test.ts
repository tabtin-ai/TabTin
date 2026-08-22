import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { readMessageContentBlocks, readMessageBlocks } from '../messageContentBlocks'

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    created_at: '2026-07-04T00:00:00.000Z',
    ...partial,
  } as ChatMessage
}

function entry(id: string, text: string): ContentBlockEntry {
  return {
    index: 0,
    block_id: id,
    block: { type: 'text', text },
    finalized: true,
    partial: false,
  } as ContentBlockEntry
}

describe('readMessageContentBlocks（ 单一读源 message.blocks）', () => {
  it('直接读 message.blocks（运行时 SSoT）', () => {
    const blocks = [entry('r0', 'live')]
    const out = readMessageContentBlocks(msg({ blocks }))
    expect(out).toBe(blocks)
  })

  it('无 message.blocks → 空数组（不再回退读 content_blocks_json）', () => {
    const out = readMessageContentBlocks(
      msg({ content_blocks_json: [{ type: 'text', text: 'archived' } as never] }),
    )
    expect(out).toEqual([])
  })

  it('两者皆空返回空数组', () => {
    expect(readMessageContentBlocks(msg({}))).toEqual([])
  })
})

describe('readMessageBlocks（取 block 本体）', () => {
  it('映射到 native block 主体数组', () => {
    const blocks = [entry('r0', 'hello')]
    const out = readMessageBlocks(msg({ blocks }))
    expect(out).toHaveLength(1)
    expect((out[0] as { type: string; text: string }).text).toBe('hello')
  })

  it('无 blocks → 空数组', () => {
    expect(readMessageBlocks(msg({}))).toEqual([])
  })
})
