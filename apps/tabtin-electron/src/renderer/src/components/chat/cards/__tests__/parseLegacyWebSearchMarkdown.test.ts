import { describe, expect, it } from 'vitest'
import { parseLegacyWebSearchMarkdown } from '../parseLegacyWebSearchMarkdown'

describe('parseLegacyWebSearchMarkdown', () => {
  it('parses markdown links and attaches snippet from next line', () => {
    const output = [
      '**[Example](https://example.com)**',
      'This is a snippet line',
    ].join('\n')
    expect(parseLegacyWebSearchMarkdown(output)).toEqual([
      { title: 'Example', url: 'https://example.com', snippet: 'This is a snippet line' },
    ])
  })

  it('skips bullet-like next lines for snippet', () => {
    const output = [
      '**[Example](https://example.com)**',
      '- bullet line',
    ].join('\n')
    expect(parseLegacyWebSearchMarkdown(output)[0]?.snippet).toBe('')
  })

  it('returns empty array when no links', () => {
    expect(parseLegacyWebSearchMarkdown('plain text')).toEqual([])
  })
})
