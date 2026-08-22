import { describe, expect, it } from 'vitest'
import { BLOCK_TYPE_TO_REF } from '../contextRefCodec'
import { isUserPreservedBlock, userPreservedBlockKey } from '../userPreservedBlocks'

describe('userPreservedBlocks ', () => {
  it('保留上传附件三态', () => {
    expect(isUserPreservedBlock({ type: 'image', url: 'https://x/a.png' })).toBe(true)
    expect(isUserPreservedBlock({ type: 'file', file_id: 'f1' })).toBe(true)
    expect(isUserPreservedBlock({ type: 'video', url: 'https://x/a.mp4' })).toBe(true)
  })

  it('保留 BLOCK_TYPE_TO_REF 全部 context 类型', () => {
    for (const type of Object.keys(BLOCK_TYPE_TO_REF)) {
      expect(isUserPreservedBlock({ type, preview: type })).toBe(true)
    }
  })

  it('保留 document/table/plan/composer_preset 特例', () => {
    expect(isUserPreservedBlock({ type: 'document', document_id: 'd1' })).toBe(true)
    expect(isUserPreservedBlock({ type: 'table', table_id: 't1' })).toBe(true)
    expect(isUserPreservedBlock({ type: 'plan', plan_id: 'p1' })).toBe(true)
    expect(isUserPreservedBlock({ type: 'composer_preset' })).toBe(true)
  })

  it('拒绝 tool / thinking 等非用户可见块', () => {
    expect(isUserPreservedBlock({ type: 'tool_use', id: 'x' })).toBe(false)
    expect(isUserPreservedBlock({ type: 'thinking', thinking: '...' })).toBe(false)
    expect(isUserPreservedBlock({ type: 'tool_result' })).toBe(false)
  })

  it('去重 key 优先资源 id', () => {
    expect(userPreservedBlockKey({ type: 'table_selection', table_id: 't1', preview: 'A' }))
      .toBe('table_selection:table_id:t1')
    expect(userPreservedBlockKey({ type: 'file', file_id: 'fid', url: 'https://x' }))
      .toBe('file:fid:fid')
  })
})
