import { describe, expect, it } from 'vitest'
import { fitMarketplaceTextWithEllipsis } from './marketplaceCardTextFit'

describe('fitMarketplaceTextWithEllipsis', () => {
  it('根据实际可容纳宽度尽量填满并在末尾追加省略号', () => {
    const text = '一二三四五六七八九十'
    const fitted = fitMarketplaceTextWithEllipsis(
      text,
      candidate => Array.from(candidate).length <= 8,
    )
    expect(fitted).toBe('一二三四五...')
    expect(Array.from(fitted)).toHaveLength(8)
  })

  it('卡片变宽后会展示更多内容，而不是使用固定字符数', () => {
    const text = 'Browser Operator 可以操作浏览器完成复杂任务'
    const narrow = fitMarketplaceTextWithEllipsis(text, candidate => candidate.length <= 14)
    const wide = fitMarketplaceTextWithEllipsis(text, candidate => candidate.length <= 22)
    expect(wide.length).toBeGreaterThan(narrow.length)
    expect(narrow.endsWith('...')).toBe(true)
    expect(wide.endsWith('...')).toBe(true)
  })

  it('完整文本能放下时不追加省略号', () => {
    expect(fitMarketplaceTextWithEllipsis('日报助手', () => true)).toBe('日报助手')
  })
})
