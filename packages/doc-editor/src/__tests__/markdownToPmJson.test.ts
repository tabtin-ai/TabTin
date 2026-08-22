import { describe, it, expect } from 'vitest'
import { markdownToPmJson } from '../converters/markdownToPmJson.js'

describe('markdownToPmJson', () => {
  it('should parse headings H1-H6', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6'
    const result = markdownToPmJson(md) as any
    expect(result.content).toHaveLength(6)
    for (let i = 0; i < 6; i++) {
      expect(result.content[i].type).toBe('heading')
      expect(result.content[i].attrs.level).toBe(i + 1)
    }
  })

  it('should parse paragraphs', () => {
    const md = 'Hello world'
    const result = markdownToPmJson(md) as any
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('paragraph')
    expect(result.content[0].content[0].text).toBe('Hello world')
  })

  it('should parse inline bold, italic, code, strike', () => {
    const md = '**bold** *italic* `code` ~~strike~~'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content
    expect(inlines.some((n: any) => n.marks?.some((m: any) => m.type === 'bold'))).toBe(true)
    expect(inlines.some((n: any) => n.marks?.some((m: any) => m.type === 'italic'))).toBe(true)
    expect(inlines.some((n: any) => n.marks?.some((m: any) => m.type === 'code'))).toBe(true)
    expect(inlines.some((n: any) => n.marks?.some((m: any) => m.type === 'strike'))).toBe(true)
  })

  it('should parse inline links', () => {
    const md = '[TabTin](https://www.example.com)'
    const result = markdownToPmJson(md) as any
    const linkNode = result.content[0].content[0]
    expect(linkNode.marks[0].type).toBe('link')
    expect(linkNode.marks[0].attrs.href).toBe('https://www.example.com')
  })

  it('should parse inline images', () => {
    const md = '![alt text](https://img.com/photo.png)'
    const result = markdownToPmJson(md) as any
    const imgNode = result.content[0].content.find((n: any) => n.type === 'image')
    expect(imgNode).toBeDefined()
    expect(imgNode.attrs.src).toBe('https://img.com/photo.png')
    expect(imgNode.attrs.alt).toBe('alt text')
  })

  it('should restore private image identity from a stable marker', () => {
    const fileId = '802cf8e7-08fc-4619-9145-a37b201fb877'
    const result = markdownToPmJson(`![private](tabtin-file://asset/${fileId})`) as any
    const imgNode = result.content[0].content.find((node: any) => node.type === 'image')

    expect(imgNode.attrs.src).toBe('')
    expect(imgNode.attrs.fileId).toBe(fileId)
    expect(imgNode.attrs.alt).toBe('private')
  })

  it('should preserve surrounding text when inline image and math are mixed', () => {
    const md = 'before ![alt](https://img.com/photo.png) after $x^2$ end'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content

    expect(inlines.map((n: any) => n.type)).toEqual([
      'text',
      'image',
      'text',
      'mathematics',
      'text',
    ])
    expect(inlines[0].text).toBe('before ')
    expect(inlines[2].text).toBe(' after ')
    expect(inlines[4].text).toBe(' end')
    expect(inlines[1].attrs.src).toBe('https://img.com/photo.png')
    expect(inlines[3].attrs.latex).toBe('x^2')
  })

  it('should keep image and math atomic when wrapped by bold marks', () => {
    const md = '**before ![alt](https://img.com/photo.png) after $x^2$ end**'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content

    expect(inlines.map((n: any) => n.type)).toEqual([
      'text',
      'image',
      'text',
      'mathematics',
      'text',
    ])
    expect(inlines[0].marks.some((m: any) => m.type === 'bold')).toBe(true)
    expect(inlines[2].marks.some((m: any) => m.type === 'bold')).toBe(true)
    expect(inlines[4].marks.some((m: any) => m.type === 'bold')).toBe(true)
    expect(inlines[1].marks.some((m: any) => m.type === 'bold')).toBe(true)
    expect(inlines[3].marks.some((m: any) => m.type === 'bold')).toBe(true)
  })

  it('should keep inline math atomic when wrapped by a link', () => {
    const md = '[$x^2$](https://www.example.com)'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content

    expect(inlines).toHaveLength(1)
    expect(inlines[0].type).toBe('mathematics')
    expect(inlines[0].attrs.latex).toBe('x^2')
    expect(inlines[0].marks[0].type).toBe('link')
    expect(inlines[0].marks[0].attrs.href).toBe('https://www.example.com')
  })

  it('should parse image wrapped by a link', () => {
    const md = '[![alt](https://img.com/photo.png)](https://www.example.com)'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content

    expect(inlines).toHaveLength(1)
    expect(inlines[0].type).toBe('image')
    expect(inlines[0].attrs.src).toBe('https://img.com/photo.png')
    expect(inlines[0].attrs.alt).toBe('alt')
    expect(inlines[0].marks[0].type).toBe('link')
    expect(inlines[0].marks[0].attrs.href).toBe('https://www.example.com')
  })

  it('should parse link href with nested parentheses', () => {
    const md = '[TabTin](https://www.example.com/docs/image_(linked))'
    const result = markdownToPmJson(md) as any
    const linkNode = result.content[0].content[0]

    expect(linkNode.type).toBe('text')
    expect(linkNode.text).toBe('TabTin')
    expect(linkNode.marks[0].type).toBe('link')
    expect(linkNode.marks[0].attrs.href).toBe('https://www.example.com/docs/image_(linked)')
  })

  it('should parse flat bullet list', () => {
    const md = '- item 1\n- item 2\n- item 3'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('bulletList')
    expect(result.content[0].content).toHaveLength(3)
  })

  it('should parse nested bullet list', () => {
    const md = '- parent\n  - child\n    - grandchild'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('bulletList')
    const parent = result.content[0].content[0]
    expect(parent.type).toBe('listItem')
    const childList = parent.content.find((n: any) => n.type === 'bulletList')
    expect(childList).toBeDefined()
    expect(childList.content[0].type).toBe('listItem')
    const grandchildList = childList.content[0].content.find((n: any) => n.type === 'bulletList')
    expect(grandchildList).toBeDefined()
  })

  it('should parse ordered list with start number', () => {
    const md = '3. third\n4. fourth'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('orderedList')
    expect(result.content[0].attrs.start).toBe(3)
    expect(result.content[0].content).toHaveLength(2)
  })

  it('should parse task list', () => {
    const md = '- [ ] unchecked\n- [x] checked'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('taskList')
    expect(result.content[0].content[0].attrs.checked).toBe(false)
    expect(result.content[0].content[1].attrs.checked).toBe(true)
  })

  it('should parse code blocks', () => {
    const md = '```typescript\nconst x = 1;\n```'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('codeBlock')
    expect(result.content[0].attrs.language).toBe('typescript')
    expect(result.content[0].content[0].text).toBe('const x = 1;')
  })

  it('closes a code fence with a spaced info string before following blocks', () => {
    const md = '```Plain Text\n\n```\n\n1. Gs\n\n# gsttu1'

    const result = markdownToPmJson(md) as any

    expect(result.content.map((node: any) => node.type)).toEqual([
      'codeBlock',
      'orderedList',
      'heading',
    ])
    expect(result.content[0].attrs.language).toBe('Plain Text')
    expect(result.content[0].content).toEqual([])
  })

  it('should parse blockquote with inner structure', () => {
    const md = '> # Title\n> Some text'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('blockquote')
    const inner = result.content[0].content
    expect(inner[0].type).toBe('heading')
    expect(inner[1].type).toBe('paragraph')
  })

  it('should parse tables', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('table')
    expect(result.content[0].content[0].content[0].type).toBe('tableHeader')
    expect(result.content[0].content[1].content[0].type).toBe('tableCell')
  })

  it('should parse horizontal rule', () => {
    const md = '---'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('horizontalRule')
  })

  it('should reject mixed-char horizontal rules', () => {
    const md = '-*_'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('paragraph')
  })

  it('should parse block-level math $$...$$', () => {
    const md = '$$\nE = mc^2\n$$'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('mathematicsBlock')
    expect(result.content[0].attrs.latex).toBe('E = mc^2')
  })

  it('should parse inline math $...$', () => {
    const md = 'The equation $E = mc^2$ is famous'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content
    const mathNode = inlines.find((n: any) => n.type === 'mathematics')
    expect(mathNode).toBeDefined()
    expect(mathNode.attrs.latex).toBe('E = mc^2')
    expect(mathNode.attrs.display).toBe(false)
  })

  it('should handle table rows with escaped pipes', () => {
    const md = '| A \\| B | C |\n| --- | --- |\n| x | y |'
    const result = markdownToPmJson(md) as any
    const headerCells = result.content[0].content[0].content
    expect(headerCells[0].content[0].content[0].text).toBe('A | B')
    expect(headerCells[1].content[0].content[0].text).toBe('C')
  })

  it('should handle empty input', () => {
    const result = markdownToPmJson('')
    expect(result).toEqual({ type: 'doc', content: [] })
  })

  it('should parse nested marks: bold containing link', () => {
    const md = '**[click here](https://example.com)**'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content
    const linkedNode = inlines.find((n: any) =>
      n.marks?.some((m: any) => m.type === 'link') &&
      n.marks?.some((m: any) => m.type === 'bold')
    )
    expect(linkedNode).toBeDefined()
    expect(linkedNode.text).toBe('click here')
  })

  it('should parse nested marks: italic containing code is flat (code is atomic)', () => {
    const md = '*before `code` after*'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content
    const codeNode = inlines.find((n: any) => n.marks?.some((m: any) => m.type === 'code'))
    expect(codeNode).toBeDefined()
    expect(codeNode.marks.some((m: any) => m.type === 'italic')).toBe(true)
  })

  it('should parse multi-paragraph list items', () => {
    const md = '- First paragraph\n  Second paragraph\n- Next item'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('bulletList')
    const firstItem = result.content[0].content[0]
    expect(firstItem.content.length).toBeGreaterThanOrEqual(2)
  })

  it('should parse nested blockquote (>>)', () => {
    const md = '>> nested quote'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].type).toBe('blockquote')
    const inner = result.content[0].content
    expect(inner[0].type).toBe('blockquote')
  })

  it('should handle escaped $ in inline math', () => {
    const md = '$x + \\$5$'
    const result = markdownToPmJson(md) as any
    const inlines = result.content[0].content
    const mathNode = inlines.find((n: any) => n.type === 'mathematics')
    expect(mathNode).toBeDefined()
    expect(mathNode.attrs.latex).toBe('x + $5')
  })

  describe('tabdataBlock', () => {
    it('should parse basic tabdataBlock directive', () => {
      const md = ':::tabdata{tableId="tbl_123" title="用户表"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('tabdataBlock')
      expect(result.content[0].attrs.tableId).toBe('tbl_123')
      expect(result.content[0].attrs.title).toBe('用户表')
      expect(result.content[0].attrs.viewId).toBeNull()
      expect(result.content[0].attrs.maxHeight).toBe(400)
    })

    it('should parse tabdataBlock with viewId', () => {
      const md = ':::tabdata{tableId="tbl_123" viewId="vw_456" title="用户表"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.viewId).toBe('vw_456')
    })

    it('should unescape double quotes in title', () => {
      const md = ':::tabdata{tableId="tbl_1" title="A \\"quoted\\" table"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.title).toBe('A "quoted" table')
    })

    it('should unescape backslashes in title', () => {
      const md = ':::tabdata{tableId="tbl_1" title="path\\\\to\\\\table"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.title).toBe('path\\to\\table')
    })

    it('should default title to 未命名表格 when missing', () => {
      const md = ':::tabdata{tableId="tbl_x"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.title).toBe('未命名表格')
    })

    it('should default maxHeight to 400', () => {
      const md = ':::tabdata{tableId="tbl_1" title="test"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.maxHeight).toBe(400)
    })

    it('should handle title with spaces (replaced from newlines)', () => {
      const md = ':::tabdata{tableId="tbl_1" title="line1 line2 line3"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.title).toBe('line1 line2 line3')
    })

    it.each([
      ['empty tableId', ':::tabdata{tableId="" title="oops"}\n:::'],
      ['unquoted tableId', ':::tabdata{tableId=tbl_1 title="oops"}\n:::'],
      ['missing tableId', ':::tabdata{title="oops"}\n:::'],
      ['empty attrs', ':::tabdata{}\n:::'],
      ['malformed directive', ':::tabdata{tableId="tbl_1"\n:::'],
    ])('should reject invalid tabdata directive: %s', (_name, md) => {
      expect(() => markdownToPmJson(md)).toThrow(/tableId|tabdata/)
    })

    it('should parse maxHeight attribute', () => {
      const md = ':::tabdata{tableId="tbl_1" maxHeight="600" title="test"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.maxHeight).toBe(600)
    })

    it('should default maxHeight to 400 when missing', () => {
      const md = ':::tabdata{tableId="tbl_1" title="test"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.maxHeight).toBe(400)
    })

    it('should handle unclosed tabdata block gracefully', () => {
      const md = ':::tabdata{tableId="tbl_1" title="unclosed"}\nSome text after'
      const result = markdownToPmJson(md) as any
      const tabdataBlock = result.content.find((n: any) => n.type === 'tabdataBlock')
      expect(tabdataBlock).toBeDefined()
      expect(tabdataBlock.attrs.tableId).toBe('tbl_1')
      const textNode = result.content.find((n: any) => n.type === 'paragraph')
      expect(textNode).toBeDefined()
    })

    it('should handle tabdata with blank line before close', () => {
      const md = ':::tabdata{tableId="tbl_1" title="spaced"}\n\n:::'
      const result = markdownToPmJson(md) as any
      const tabdataBlock = result.content.find((n: any) => n.type === 'tabdataBlock')
      expect(tabdataBlock).toBeDefined()
      expect(tabdataBlock.attrs.tableId).toBe('tbl_1')
    })

    it('should handle attribute order variation', () => {
      const md = ':::tabdata{title="test" tableId="tbl_1" viewId="vw_2"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.tableId).toBe('tbl_1')
      expect(result.content[0].attrs.viewId).toBe('vw_2')
      expect(result.content[0].attrs.title).toBe('test')
    })

    it('should not match prefixed optional attribute names', () => {
      const md = (
        ':::tabdata{tableId="tbl_1" stableViewId="bad" '
        + 'mytitle="bad" mymaxHeight="999"}\n:::'
      )
      const result = markdownToPmJson(md) as any
      expect(result.content[0].attrs.viewId).toBeNull()
      expect(result.content[0].attrs.title).toBe('未命名表格')
      expect(result.content[0].attrs.maxHeight).toBe(400)
    })

    it('should treat explicit empty viewId as null', () => {
      const md = ':::tabdata{tableId="tbl_1" viewId="" title="test"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].type).toBe('tabdataBlock')
      expect(result.content[0].attrs.viewId).toBeNull()
    })

    it('should handle title with many escape sequences (ReDoS defense)', () => {
      const escapedTitle = 'a'.repeat(1000) + '\\\\'
      const md = `:::tabdata{tableId="tbl_1" title="${escapedTitle}"}\n:::`
      const start = performance.now()
      const result = markdownToPmJson(md) as any
      const elapsed = performance.now() - start
      expect(result.content[0].type).toBe('tabdataBlock')
      expect(result.content[0].attrs.title).toBe('a'.repeat(1000) + '\\')
      expect(elapsed).toBeLessThan(100)
    })

    it('should handle title with trailing backslash', () => {
      const md = ':::tabdata{tableId="tbl_1" title="hello\\\\"}\n:::'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].type).toBe('tabdataBlock')
      expect(result.content[0].attrs.title).toBe('hello\\')
    })
  })

  describe('HTML inline extensions (MD-HTML-PARSE)', () => {
    it('should parse <span style="color:..."> as textStyle mark', () => {
      const md = '<span style="color:#ff0000">red text</span>'
      const result = markdownToPmJson(md) as any
      const textNode = result.content[0].content[0]
      expect(textNode.text).toBe('red text')
      expect(textNode.marks).toContainEqual({ type: 'textStyle', attrs: { color: '#ff0000' } })
    })

    it('should parse <span> with named color', () => {
      const md = '<span style="color:red">colored</span>'
      const result = markdownToPmJson(md) as any
      const textNode = result.content[0].content[0]
      expect(textNode.marks).toContainEqual({ type: 'textStyle', attrs: { color: 'red' } })
    })

    it('should parse <span> without color as plain text', () => {
      const md = '<span class="foo">text</span>'
      const result = markdownToPmJson(md) as any
      const textNode = result.content[0].content[0]
      expect(textNode.text).toBe('text')
      expect(textNode.marks).toBeUndefined()
    })

    it('should parse <mark> as highlight mark with default yellow', () => {
      const md = '<mark>highlighted</mark>'
      const result = markdownToPmJson(md) as any
      const textNode = result.content[0].content[0]
      expect(textNode.text).toBe('highlighted')
      expect(textNode.marks).toContainEqual({ type: 'highlight', attrs: { color: 'yellow' } })
    })

    it('should parse <mark style="background-color:..."> with custom color', () => {
      const md = '<mark style="background-color:#00ff00">green</mark>'
      const result = markdownToPmJson(md) as any
      const textNode = result.content[0].content[0]
      expect(textNode.text).toBe('green')
      expect(textNode.marks).toContainEqual({ type: 'highlight', attrs: { color: '#00ff00' } })
    })

    it('should parse <img> with width and height', () => {
      const md = '<img src="https://img.com/photo.png" alt="photo" width="800" height="600">'
      const result = markdownToPmJson(md) as any
      const imgNode = result.content[0].content[0]
      expect(imgNode.type).toBe('image')
      expect(imgNode.attrs.src).toBe('https://img.com/photo.png')
      expect(imgNode.attrs.alt).toBe('photo')
      expect(imgNode.attrs.width).toBe(800)
      expect(imgNode.attrs.height).toBe(600)
    })

    it('should parse self-closing <img />', () => {
      const md = '<img src="https://img.com/photo.png" alt="photo" width="800" />'
      const result = markdownToPmJson(md) as any
      const imgNode = result.content[0].content[0]
      expect(imgNode.type).toBe('image')
      expect(imgNode.attrs.width).toBe(800)
    })

    it('should parse <img> without dimensions as image without width/height attrs', () => {
      const md = '<img src="https://img.com/photo.png" alt="photo">'
      const result = markdownToPmJson(md) as any
      const imgNode = result.content[0].content[0]
      expect(imgNode.type).toBe('image')
      expect(imgNode.attrs.src).toBe('https://img.com/photo.png')
      expect(imgNode.attrs.width).toBeUndefined()
      expect(imgNode.attrs.height).toBeUndefined()
    })

    it('should parse mixed inline HTML and markdown', () => {
      const md = 'Hello **<span style="color:#ff0000">red bold</span>** world'
      const result = markdownToPmJson(md) as any
      const inlines = result.content[0].content
      const redBold = inlines.find((n: any) =>
        n.marks?.some((m: any) => m.type === 'textStyle') &&
        n.marks?.some((m: any) => m.type === 'bold')
      )
      expect(redBold).toBeDefined()
      expect(redBold.text).toBe('red bold')
    })

    it('should parse nested <mark> inside <span>', () => {
      const md = '<span style="color:#ff0000"><mark>important</mark></span>'
      const result = markdownToPmJson(md) as any
      const node = result.content[0].content[0]
      expect(node.text).toBe('important')
      expect(node.marks).toContainEqual({ type: 'textStyle', attrs: { color: '#ff0000' } })
      expect(node.marks).toContainEqual({ type: 'highlight', attrs: { color: 'yellow' } })
    })
  })

  describe('HTML table parsing (MD-HTML-PARSE)', () => {
    it('should parse HTML table with colspan', () => {
      const md = '<table>\n<tr><th colspan="2">Header</th></tr>\n<tr><td>A</td><td>B</td></tr>\n</table>'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].type).toBe('table')
      const firstRow = result.content[0].content[0]
      expect(firstRow.content[0].type).toBe('tableHeader')
      expect(firstRow.content[0].attrs.colspan).toBe(2)
    })

    it('should parse HTML table with rowspan', () => {
      const md = '<table>\n<tr><td rowspan="2">Merged</td><td>A</td></tr>\n<tr><td>B</td></tr>\n</table>'
      const result = markdownToPmJson(md) as any
      const firstCell = result.content[0].content[0].content[0]
      expect(firstCell.attrs.rowspan).toBe(2)
    })

    it('should parse HTML table without merge attrs (no attrs key)', () => {
      const md = '<table>\n<tr><th>H1</th><th>H2</th></tr>\n<tr><td>A</td><td>B</td></tr>\n</table>'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].type).toBe('table')
      expect(result.content[0].content).toHaveLength(2)
      expect(result.content[0].content[0].content[0].attrs).toBeUndefined()
    })

    it('should parse single-line HTML table', () => {
      const md = '<table><tr><td>A</td><td>B</td></tr></table>'
      const result = markdownToPmJson(md) as any
      expect(result.content[0].type).toBe('table')
      expect(result.content[0].content[0].content).toHaveLength(2)
    })

    it('should parse HTML table with inline marks in cells', () => {
      const md = '<table>\n<tr><td><span style="color:#ff0000">red</span></td><td>B</td></tr>\n</table>'
      const result = markdownToPmJson(md) as any
      const cell = result.content[0].content[0].content[0]
      const textNode = cell.content[0].content[0]
      expect(textNode.text).toBe('red')
      expect(textNode.marks).toContainEqual({ type: 'textStyle', attrs: { color: '#ff0000' } })
    })

    it('should parse HTML table with both colspan and rowspan on same cell', () => {
      const md = '<table>\n<tr><td colspan="2" rowspan="3">Big Cell</td></tr>\n</table>'
      const result = markdownToPmJson(md) as any
      const cell = result.content[0].content[0].content[0]
      expect(cell.attrs.colspan).toBe(2)
      expect(cell.attrs.rowspan).toBe(3)
    })
  })

  describe('hardBreak parsing (MD-HTML-PARSE)', () => {
    it('should parse trailing double space as hardBreak', () => {
      const md = 'line one  \nline two'
      const result = markdownToPmJson(md) as any
      const inlines = result.content[0].content
      expect(inlines).toHaveLength(3)
      expect(inlines[0].text).toBe('line one')
      expect(inlines[1].type).toBe('hardBreak')
      expect(inlines[2].text).toBe('line two')
    })

    it('should parse <br> as hardBreak', () => {
      const md = 'before<br>after'
      const result = markdownToPmJson(md) as any
      const inlines = result.content[0].content
      expect(inlines.some((n: any) => n.type === 'hardBreak')).toBe(true)
      expect(inlines[0].text).toBe('before')
      expect(inlines[2].text).toBe('after')
    })

    it('should parse <br/> as hardBreak', () => {
      const md = 'before<br/>after'
      const result = markdownToPmJson(md) as any
      const inlines = result.content[0].content
      expect(inlines.some((n: any) => n.type === 'hardBreak')).toBe(true)
    })

    it('should parse <br /> (with space) as hardBreak', () => {
      const md = 'before<br />after'
      const result = markdownToPmJson(md) as any
      const inlines = result.content[0].content
      expect(inlines.some((n: any) => n.type === 'hardBreak')).toBe(true)
    })

    it('should not treat single trailing space as hardBreak', () => {
      const md = 'line one \nline two'
      const result = markdownToPmJson(md) as any
      const inlines = result.content[0].content
      expect(inlines.every((n: any) => n.type !== 'hardBreak')).toBe(true)
    })

    it('should handle multiple hardBreaks in sequence', () => {
      const md = 'a  \nb  \nc'
      const result = markdownToPmJson(md) as any
      const inlines = result.content[0].content
      const hardBreaks = inlines.filter((n: any) => n.type === 'hardBreak')
      expect(hardBreaks).toHaveLength(2)
    })
  })
})
