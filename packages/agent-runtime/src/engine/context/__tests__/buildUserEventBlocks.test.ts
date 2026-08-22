import { describe, expect, it } from 'vitest'
import { buildUserEventBlocks } from '../user-message.js'

describe('buildUserEventBlocks — Django 不再合成时的落库契约', () => {
  it('有可见正文且 blocks 空 → 必须产出含 text 的块', () => {
    const blocks = buildUserEventBlocks('hello world', [])
    expect(blocks).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('有可见正文且未传 blocks → 必须产出含 text 的块', () => {
    const blocks = buildUserEventBlocks('hello world')
    expect(blocks).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('有可见正文且 blocks 已含等价 text → 原样返回', () => {
    const input = [{ type: 'text', text: 'hello world' }, { type: 'image', file_id: 'f1' }]
    expect(buildUserEventBlocks('hello world', input)).toEqual(input)
  })

  it('有可见正文且 blocks 无等价 text → 前置 text 再跟原块', () => {
    const input = [{ type: 'image', file_id: 'f1' }]
    expect(buildUserEventBlocks('caption', input)).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', file_id: 'f1' },
    ])
  })

  it('无正文仅附件 → 返回附件块', () => {
    const input = [{ type: 'file', file_id: 'f2' }]
    expect(buildUserEventBlocks('   ', input)).toEqual(input)
  })

  it('无正文无附件 → undefined（调用方可不带 blocks_json）', () => {
    expect(buildUserEventBlocks('', [])).toBeUndefined()
    expect(buildUserEventBlocks('   ')).toBeUndefined()
  })
})
