import { describe, expect, it } from 'vitest'
import { normalizeMathPmJson } from '../converters/normalizeMathPmJson.js'
import { markdownToPmJson } from '../converters/markdownToPmJson.js'
import { pmJsonToMarkdown } from '../converters/pmJsonToMarkdown.js'

describe('normalizeMathPmJson ', () => {
  it('migrates legacy Novel math → mathematics', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'eq ' },
            { type: 'math', attrs: { latex: 'a^2' } },
          ],
        },
      ],
    }
    const out = normalizeMathPmJson(input)
    expect(out.content[0].content[1]).toMatchObject({
      type: 'mathematics',
      attrs: { latex: 'a^2', display: false },
    })
  })

  it('migrates top-level mathematics{display:true} → mathematicsBlock', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'mathematics',
          attrs: { latex: '\\int_0^1 x dx', display: true },
        },
      ],
    }
    const out = normalizeMathPmJson(input)
    expect(out.content[0]).toEqual({
      type: 'mathematicsBlock',
      attrs: { latex: '\\int_0^1 x dx' },
    })
  })

  it('keeps inline mathematics{display:false} unchanged (same ref when no-op)', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mathematics', attrs: { latex: 'E=mc^2', display: false } },
          ],
        },
      ],
    }
    expect(normalizeMathPmJson(input)).toBe(input)
  })

  it('round-trips canonical markdown through converters', () => {
    const md = [
      '行内 $a^2+b^2=c^2$',
      '',
      '$$',
      '\\sum_{i=1}^{n} i',
      '$$',
    ].join('\n')
    const pm = normalizeMathPmJson(markdownToPmJson(md) as Record<string, unknown>)
    expect(pm).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '行内 ' },
            { type: 'mathematics', attrs: { latex: 'a^2+b^2=c^2', display: false } },
          ],
        },
        {
          type: 'mathematicsBlock',
          attrs: { latex: '\\sum_{i=1}^{n} i' },
        },
      ],
    })
    const back = pmJsonToMarkdown(pm)
    expect(back).toContain('$a^2+b^2=c^2$')
    expect(back).toContain('$$')
    expect(back).toContain('\\sum_{i=1}^{n} i')
  })
})
