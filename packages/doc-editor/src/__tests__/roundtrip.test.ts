import { describe, it, expect } from 'vitest'
import { markdownToPmJson } from '../converters/markdownToPmJson.js'
import { pmJsonToMarkdown } from '../converters/pmJsonToMarkdown.js'

describe('markdown roundtrip', () => {
  const roundtrip = (md: string) => {
    const json = markdownToPmJson(md)
    return pmJsonToMarkdown(json)
  }

  it('should roundtrip headings', () => {
    const md = '# Hello\n\n## World'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip paragraphs', () => {
    const md = 'Hello world'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip bold and italic', () => {
    const md = '**bold** and *italic*'
    const result = roundtrip(md)
    expect(result).toContain('**bold**')
    expect(result).toContain('*italic*')
  })

  it('should roundtrip code blocks', () => {
    const md = '```js\nconst x = 1;\n```'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip code blocks containing backtick fences', () => {
    const md = '````\n# Hello\n\n```python\ndef foo():\n    pass\n```\n\nMore text\n````'
    const result = roundtrip(md)
    const json = markdownToPmJson(md)
    expect((json.content as any[]).length).toBe(1)
    expect((json.content as any[])[0].type).toBe('codeBlock')
    const resultJson = markdownToPmJson(result)
    expect((resultJson.content as any[]).length).toBe(1)
    expect((resultJson.content as any[])[0].type).toBe('codeBlock')
  })

  it('should auto-upgrade fence when code block content has triple backticks', () => {
    const json = {
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: null },
        content: [{ type: 'text', text: '```python\ndef foo():\n    pass\n```' }],
      }],
    }
    const md = pmJsonToMarkdown(json)
    expect(md.startsWith('````')).toBe(true)
    expect(md.endsWith('````')).toBe(true)
    const reparsed = markdownToPmJson(md)
    expect((reparsed.content as any[]).length).toBe(1)
    expect((reparsed.content as any[])[0].type).toBe('codeBlock')
  })

  it('should roundtrip bullet lists', () => {
    const md = '- a\n- b\n- c'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip ordered lists', () => {
    const md = '1. first\n2. second'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip task lists', () => {
    const md = '- [ ] todo\n- [x] done'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip blockquotes', () => {
    const md = '> quoted text'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip horizontal rules', () => {
    const md = '---'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip tables', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const result = roundtrip(md)
    expect(result).toContain('| A | B |')
    expect(result).toContain('| 1 | 2 |')
  })

  it('should roundtrip inline code without corruption', () => {
    const md = '`a*b_c`'
    const result = roundtrip(md)
    expect(result).toBe('`a*b_c`')
    expect(result).not.toContain('\\*')
  })

  it('should roundtrip images', () => {
    const md = '![alt](https://img.com/a.png)'
    const result = roundtrip(md)
    expect(result).toContain('![alt](https://img.com/a.png)')
  })

  it('should roundtrip image links', () => {
    const md = '[![alt](https://img.com/a.png)](https://www.example.com)'
    expect(roundtrip(md)).toBe(md)
  })

  it('should roundtrip inline math', () => {
    const md = 'The formula $E=mc^2$ is famous.'
    const result = roundtrip(md)
    expect(result).toContain('$E=mc^2$')
  })

  it('should roundtrip block math', () => {
    const md = '$$\n\\int_0^1 x^2 dx\n$$'
    const result = roundtrip(md)
    expect(result).toContain('$$')
    expect(result).toContain('\\int_0^1 x^2 dx')
  })

  describe('tabdataBlock', () => {
    it('should roundtrip basic tabdataBlock', () => {
      const md = ':::tabdata{tableId="tbl_123" title="用户表"}\n:::'
      const result = roundtrip(md)
      expect(result).toBe(md)
    })

    it('should roundtrip tabdataBlock with viewId', () => {
      const md = ':::tabdata{tableId="tbl_123" viewId="vw_456" title="用户表"}\n:::'
      const result = roundtrip(md)
      expect(result).toBe(md)
    })

    it('should roundtrip tabdataBlock with escaped quotes in title', () => {
      const md = ':::tabdata{tableId="tbl_1" title="A \\"quoted\\" table"}\n:::'
      const result = roundtrip(md)
      expect(result).toContain('tableId="tbl_1"')
      expect(result).toContain('title="A \\"quoted\\" table"')
    })

    it('should roundtrip tabdataBlock with escaped backslashes in title', () => {
      const md = ':::tabdata{tableId="tbl_1" title="path\\\\to\\\\table"}\n:::'
      const result = roundtrip(md)
      expect(result).toContain('title="path\\\\to\\\\table"')
    })

    it('should roundtrip tabdataBlock among other blocks', () => {
      const md = '# Title\n\n:::tabdata{tableId="tbl_1" title="表格"}\n:::\n\nSome text after.'
      const result = roundtrip(md)
      expect(result).toContain('# Title')
      expect(result).toContain(':::tabdata{tableId="tbl_1" title="表格"}')
      expect(result).toContain('Some text after.')
    })

    it('should normalize title newlines to spaces on serialization', () => {
      const json = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'line1\nline2', maxHeight: 400 } },
        ],
      }
      const md = pmJsonToMarkdown(json)
      expect(md).toContain('title="line1 line2"')
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.title).toBe('line1 line2')
    })

    it('should roundtrip tabdataBlock with non-default maxHeight', () => {
      const md = ':::tabdata{tableId="tbl_1" maxHeight="600" title="tall"}\n:::'
      const result = roundtrip(md)
      expect(result).toContain('maxHeight="600"')
      expect(result).toContain('tableId="tbl_1"')
      expect(result).toContain('title="tall"')
    })

    it('should roundtrip tabdataBlock with default maxHeight (omitted)', () => {
      const md = ':::tabdata{tableId="tbl_1" title="default"}\n:::'
      const result = roundtrip(md)
      expect(result).not.toContain('maxHeight')
      expect(result).toContain('tableId="tbl_1"')
    })

    it('should roundtrip multiple consecutive tabdataBlocks', () => {
      const md = ':::tabdata{tableId="tbl_1" title="表格A"}\n:::\n\n:::tabdata{tableId="tbl_2" viewId="vw_1" title="表格B"}\n:::'
      const result = roundtrip(md)
      expect(result).toContain('tableId="tbl_1"')
      expect(result).toContain('tableId="tbl_2"')
      expect(result).toContain('title="表格A"')
      expect(result).toContain('title="表格B"')
    })
  })
})
