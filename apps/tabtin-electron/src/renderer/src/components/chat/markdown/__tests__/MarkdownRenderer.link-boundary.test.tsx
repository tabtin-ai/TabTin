import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkAutolinkResource } from '@tabtin/markdown-resource-autolink'

afterEach(cleanup)

function renderMarkdown(content: string) {
  return render(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkAutolinkResource]}>
      {content}
    </ReactMarkdown>,
  )
}

describe('MarkdownRenderer bare URL boundaries', () => {
  it('keeps a worktree switch status label non-interactive', () => {
    const content = '已切换代码根到 ` TabTin `，Agent 正在同一对话中继续任务。'
    const { container } = renderMarkdown(content)

    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('TabTin')
    expect(container.textContent).toBe('已切换代码根到 TabTin，Agent 正在同一对话中继续任务。')
  })

  it('splits adjacent Chinese source notes into two independent links', () => {
    const content =
      '链接：https://www.36kr.com/p/3934784382958726（原始信源：https://www.anthropic.com/research/riemann-zeta，未能直接抓取核验）'
    const { container } = renderMarkdown(content)
    const links = Array.from(container.querySelectorAll('a'))

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://www.36kr.com/p/3934784382958726',
      'https://www.anthropic.com/research/riemann-zeta',
    ])
    expect(links.map((link) => link.textContent)).toEqual([
      'https://www.36kr.com/p/3934784382958726',
      'https://www.anthropic.com/research/riemann-zeta',
    ])
    expect(container.textContent).toBe(content)
  })

  it.each([
    '（说明）',
    '，说明',
    '。说明',
    '；说明',
    '：说明',
    '！说明',
    '？说明',
    '……说明',
    '——说明',
    '“说明”',
    '‘说明’',
    '《说明》',
    '〈说明〉',
    '〔说明〕',
  ])(
    'keeps %s outside an autolink',
    (suffix) => {
      const content = `https://example.com${suffix}`
      const { container } = renderMarkdown(content)
      const link = container.querySelector('a')

      expect(link?.getAttribute('href')).toBe('https://example.com')
      expect(link?.textContent).toBe('https://example.com')
      expect(container.textContent).toBe(content)
    },
  )

  it('preserves an unpunctuated Unicode URL path', () => {
    const content = 'https://example.com/中文路径'
    const { container } = renderMarkdown(content)
    const link = container.querySelector('a')

    expect(decodeURI(link?.getAttribute('href') ?? '')).toBe(content)
    expect(link?.textContent).toBe(content)
  })

  it('preserves percent-encoded punctuation in a bare URL', () => {
    const content = 'https://example.com/%EF%BC%88path%EF%BC%89'
    const { container } = renderMarkdown(content)
    const link = container.querySelector('a')

    expect(link?.getAttribute('href')).toBe(content)
    expect(link?.textContent).toBe(content)
  })

  it('does not rewrite an explicit Markdown link', () => {
    const href = 'https://target.example'
    const label = 'https://example.com/路径（第1版）'
    const { container } = renderMarkdown(`[${label}](${href})`)
    const link = container.querySelector('a')

    expect(link?.getAttribute('href')).toBe(href)
    expect(link?.textContent).toBe(label)
  })

  it('preserves Unicode punctuation in an angle-bracket autolink', () => {
    const href = 'https://example.com/路径（第1版）'
    const content = `<${href}>`
    const { container } = renderMarkdown(content)
    const link = container.querySelector('a')

    expect(decodeURI(link?.getAttribute('href') ?? '')).toBe(href)
    expect(link?.textContent).toBe(href)
  })
})
