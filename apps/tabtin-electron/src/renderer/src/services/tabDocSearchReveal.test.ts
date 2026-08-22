import { describe, expect, it } from 'vitest'

import { buildTabDocSearchReveal, normalizeSearchRevealText, textContainsSearchQuery } from './tabDocSearchReveal'

describe('tabDocSearchReveal', () => {
  it('清理搜索高亮标签和片段省略号，生成 fullText fallback', () => {
    expect(normalizeSearchRevealText('...这里有 <em>西湖</em> 路线...')).toBe('这里有 西湖 路线')
  })

  it('优先使用 block preview，并去重 block ids', () => {
    expect(buildTabDocSearchReveal({
      blockId: ' block-1 ',
      blockIds: ['block-1', 'block-2', ''],
      blockPreview: '命中段落全文',
      snippet: '...命中...',
    })).toEqual({
      blockIds: ['block-1', 'block-2'],
      fullText: '命中段落全文',
    })
  })

  it('没有 block anchor 时使用高亮 preview 或 snippet 定位', () => {
    expect(buildTabDocSearchReveal({
      highlightPreview: ['...路线里的 <em>龙井</em>...'],
      snippet: 'fallback',
    })).toEqual({
      fullText: '路线里的 龙井',
    })
  })

  it('没有可定位信息时返回 null', () => {
    expect(buildTabDocSearchReveal({ blockIds: ['', null] })).toBeNull()
  })

  it('判断 snippet 是否真实包含搜索词，避免 title-only 命中误定位正文预览', () => {
    expect(textContainsSearchQuery('这里写了杭州西湖和龙井路线', '西湖 路线')).toBe(true)
    expect(textContainsSearchQuery('正文第一段没有关键词', '西湖')).toBe(false)
  })
})
