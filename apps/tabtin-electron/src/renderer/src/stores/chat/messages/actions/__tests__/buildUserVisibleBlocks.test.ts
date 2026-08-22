import { describe, expect, it } from 'vitest'
import type { MessageBlock } from '@tabtin/chat-client'
import { buildUserVisibleBlocks } from '../buildUserVisibleBlocks'

describe('buildUserVisibleBlocks ', () => {
  it('无 context 时返回单 text 块（不 trim，对齐历史乐观路径）', () => {
    expect(buildUserVisibleBlocks('  hello  ')).toEqual([
      { type: 'text', text: '  hello  ' },
    ])
  })

  it('有 context + 非空文字：前置 text（trim）再拼 context', () => {
    const context = [{ type: 'document', document_id: 'doc-1' }] as MessageBlock[]
    expect(buildUserVisibleBlocks('  请看文档  ', context)).toEqual([
      { type: 'text', text: '请看文档' },
      { type: 'document', document_id: 'doc-1' },
    ])
  })

  it('有 context + 空白文字：只返回 context（纯引用发送）', () => {
    const context = [{ type: 'document', document_id: 'doc-1' }] as MessageBlock[]
    expect(buildUserVisibleBlocks('   ', context)).toEqual(context)
    expect(buildUserVisibleBlocks('', context)).toEqual(context)
  })

  it('空 / null context 与无 context 等价', () => {
    expect(buildUserVisibleBlocks('hi', null)).toEqual([{ type: 'text', text: 'hi' }])
    expect(buildUserVisibleBlocks('hi', [])).toEqual([{ type: 'text', text: 'hi' }])
  })
})
