import { describe, expect, it } from 'vitest'

import { buildQuerySnippetHighlight } from './querySnippet'

describe('buildQuerySnippetHighlight', () => {
  it('extracts the text around the keyword and wraps matches in em tags', () => {
    const html = buildQuerySnippetHighlight(
      '前面有一大段不相关内容，需要被收起来。上海本周天气（6月8日-6月14日） 每日天气详情和出行建议。',
      '上海',
      { maxChars: 24, contextBeforeChars: 4 },
    )

    expect(html).toContain('<em>上海</em>')
    expect(html.startsWith('…')).toBe(true)
    expect(html.length).toBeLessThan(40)
  })

  it('normalizes whitespace and highlights every visible occurrence', () => {
    expect(buildQuerySnippetHighlight('周一\n\n要开会，周一要同步进度', '周一')).toBe(
      '<em>周一</em> 要开会，<em>周一</em>要同步进度',
    )
  })
})
