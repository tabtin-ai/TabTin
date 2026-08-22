import { describe, expect, it } from 'vitest'
import { countDocumentWords } from './word-count'

describe('countDocumentWords', () => {
  it('returns 0 for empty input', () => {
    expect(countDocumentWords('')).toBe(0)
  })

  it('counts CJK characters individually', () => {
    expect(countDocumentWords('这是一段中文文档')).toBe(8)
  })

  it('counts English words by whitespace', () => {
    expect(countDocumentWords('Hello world')).toBe(2)
    expect(countDocumentWords('The quick brown fox jumps over the lazy dog')).toBe(9)
  })

  it('counts mixed Chinese and English content', () => {
    expect(countDocumentWords('Hello 你好 world')).toBe(4)
    expect(countDocumentWords('混合 content 123 test')).toBe(5)
  })

  it('handles multiline paragraphs', () => {
    expect(countDocumentWords('# 标题\n\n正文内容测试')).toBe(9)
    expect(countDocumentWords('第一段\n\n第二段')).toBe(6)
  })
})
