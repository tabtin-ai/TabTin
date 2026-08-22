import { describe, it, expect } from 'vitest'
import { pmJsonToHtml } from '../converters/pmJsonToHtml.js'

describe('pmJsonToHtml', () => {
  it('should render headings', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      ],
    }
    expect(pmJsonToHtml(doc)).toBe('<h2>Title</h2>')
  })

  it('should render paragraphs with inline marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
          ],
        },
      ],
    }
    expect(pmJsonToHtml(doc)).toBe('<p><strong>bold</strong></p>')
  })

  it('should render code marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'const x', marks: [{ type: 'code' }] },
          ],
        },
      ],
    }
    expect(pmJsonToHtml(doc)).toBe('<p><code>const x</code></p>')
  })

  it('should render underline marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'underlined', marks: [{ type: 'underline' }] },
          ],
        },
      ],
    }
    expect(pmJsonToHtml(doc)).toContain('<u>underlined</u>')
  })

  it('should render highlight marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'highlighted', marks: [{ type: 'highlight', attrs: { color: 'yellow' } }] },
          ],
        },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).toContain('<mark data-color="yellow">highlighted</mark>')
  })

  it('should render textStyle color marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
          ],
        },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).toContain('style="color: #ff0000"')
  })

  it('should render links', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'https://x.com' } }] },
          ],
        },
      ],
    }
    expect(pmJsonToHtml(doc)).toContain('<a href="https://x.com">click</a>')
  })

  it('should render image nodes (inline and block)', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://img.com/a.png', alt: 'pic' } },
      ],
    }
    expect(pmJsonToHtml(doc)).toBe('<img src="https://img.com/a.png" alt="pic" />')
  })

  it('should preserve image width and height attrs', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://img.com/a.png', alt: 'pic', width: 320, height: '180px' } },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).toContain('width="320"')
    expect(html).toContain('height="180"')
    expect(html).toContain('style="width: 320px; height: 180px"')
  })

  it('should render inline images', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: 'https://img.com/b.png', alt: 'inline' } },
          ],
        },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).toContain('<img src="https://img.com/b.png" alt="inline" />')
  })

  it('should render linked inline images', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'image',
              attrs: { src: 'https://img.com/b.png', alt: 'inline' },
              marks: [{ type: 'link', attrs: { href: 'https://www.example.com' } }],
            },
          ],
        },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).toContain('<a href="https://www.example.com"><img src="https://img.com/b.png" alt="inline" /></a>')
  })

  it('should render table with thead when first row has tableHeader', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }] },
              ],
            },
          ],
        },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).toContain('<thead>')
    expect(html).toContain('<th>')
    expect(html).toContain('<tbody>')
    expect(html).toContain('<td>')
  })

  it('should render blockquote', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quote' }] }],
        },
      ],
    }
    expect(pmJsonToHtml(doc)).toBe('<blockquote><p>quote</p></blockquote>')
  })

  it('should preserve task-list semantics for editor clipboard round-trips', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
            },
          ],
        },
      ],
    }

    const html = pmJsonToHtml(doc)
    expect(html).toContain('<ul data-type="taskList"')
    expect(html).toContain('<li data-type="taskItem" data-checked="true">')
    expect(html).toContain('<input type="checkbox" checked disabled />')
    expect(html).toContain('<div><p>done</p></div>')
  })

  it('should render code blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'python' },
          content: [{ type: 'text', text: 'print("hi")' }],
        },
      ],
    }
    expect(pmJsonToHtml(doc)).toContain('class="language-python"')
    expect(pmJsonToHtml(doc)).toContain('print(&quot;hi&quot;)')
  })

  it('should render horizontal rule', () => {
    expect(pmJsonToHtml({ type: 'doc', content: [{ type: 'horizontalRule' }] })).toBe('<hr />')
  })

  it('should escape HTML special chars', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '<script>alert("xss")</script>' }] },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('should render youtube nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'youtube', attrs: { src: 'https://www.youtube.com/embed/abc', width: 640, height: 480 } },
      ],
    }
    const html = pmJsonToHtml(doc)
    expect(html).toContain('<iframe')
    expect(html).toContain('data-youtube-video')
    expect(html).toContain('https://www.youtube.com/embed/abc')
  })

  it('should return empty string for null input', () => {
    expect(pmJsonToHtml(null)).toBe('')
    expect(pmJsonToHtml(undefined)).toBe('')
  })

  // --- XSS Security Tests ---

  describe('XSS protection', () => {
    it('should strip javascript: from link href', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
        }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('javascript:')
      expect(html).not.toContain('<a ')
      expect(html).toContain('evil')
    })

    it('should strip data: URLs from link href', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'data:text/html,<script>alert(1)</script>' } }] }],
        }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('data:text/html')
    })

    it('should strip javascript: from image src', () => {
      const doc = {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'xss' } }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('javascript:')
      expect(html).toBe('')
    })

    it('should strip non-youtube URLs from youtube iframe src', () => {
      const doc = {
        type: 'doc',
        content: [{ type: 'youtube', attrs: { src: 'javascript:alert(1)', width: 640, height: 480 } }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('javascript:')
      expect(html).toBe('')
    })

    it('should reject non-youtube embed URLs for youtube nodes', () => {
      const doc = {
        type: 'doc',
        content: [{ type: 'youtube', attrs: { src: 'https://evil.com/embed/abc', width: 640, height: 480 } }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toBe('')
    })

    it('should sanitize CSS injection in textStyle color', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'textStyle', attrs: { color: 'red; } </style><script>alert(1)</script>' } }] }],
        }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('<script>')
      expect(html).not.toContain('</style>')
    })

    it('should allow safe CSS colors', () => {
      for (const color of ['#ff0000', 'red', 'rgb(255,0,0)', 'hsl(0,100%,50%)']) {
        const doc = {
          type: 'doc',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 't', marks: [{ type: 'textStyle', attrs: { color } }] }],
          }],
        }
        const html = pmJsonToHtml(doc)
        expect(html).toContain(`style="color: ${color}"`)
      }
    })

    it('should allow relative and hash URLs', () => {
      for (const href of ['/page', '#section', 'https://safe.com', 'mailto:a@b.com']) {
        const doc = {
          type: 'doc',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }],
          }],
        }
        const html = pmJsonToHtml(doc)
        expect(html).toContain(`href="${href}"`)
      }
    })

    it('should strip vbscript: from link href', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'vbscript:msgbox("xss")' } }] }],
        }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('vbscript:')
    })

    it('should block protocol-relative URLs (//evil.com)', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: '//evil.com/phish' } }] }],
        }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('//evil.com')
    })

    it('should block uppercase JAVASCRIPT: protocol', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'JAVASCRIPT:alert(1)' } }] }],
        }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('JAVASCRIPT:')
    })

    it('should include sandbox attribute on youtube iframe', () => {
      const doc = {
        type: 'doc',
        content: [{ type: 'youtube', attrs: { src: 'https://www.youtube.com/embed/abc', width: 640, height: 480 } }],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('sandbox=')
    })
  })

  describe('mathematics', () => {
    it('should render inline mathematics', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Formula: ' },
              { type: 'mathematics', attrs: { latex: 'E=mc^2', display: false } },
            ],
          },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('<code class="math">E=mc^2</code>')
      expect(html).toContain('data-latex="E=mc^2"')
    })

    it('should render block-level mathematics', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematics', attrs: { latex: '\\int_0^1 x^2 dx', display: true } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('<div class="math-display"')
      expect(html).toContain('<code class="math">\\int_0^1 x^2 dx</code>')
      expect(html).toContain('data-latex="\\int_0^1 x^2 dx"')
    })

    it('should preserve < and > in latex code body for rendering libraries (DC-3)', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematics', attrs: { latex: 'a < b > c', display: false } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('<code class="math">a < b > c</code>')
      expect(html).toContain('data-latex="a &lt; b &gt; c"')
    })

    it('should escape HTML in data-latex attribute but not in code body', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematics', attrs: { latex: 'a<b>c</b>', display: false } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-latex="a&lt;b&gt;c&lt;/b&gt;"')
      expect(html).toContain('<code class="math">a<b>c</b></code>')
    })

    it('should preserve LaTeX commands with angle brackets', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematics', attrs: { latex: '\\langle x, y \\rangle', display: false } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('<code class="math">\\langle x, y \\rangle</code>')
    })

    it('should preserve ampersands in LaTeX (matrix alignment)', () => {
      const latex = '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematics', attrs: { latex, display: true } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain(`<code class="math">${latex}</code>`)
      expect(html).toContain('data-latex="\\begin{pmatrix} a &amp; b \\\\ c &amp; d \\end{pmatrix}"')
    })

    it('should preserve LaTeX inequality expressions', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematics', attrs: { latex: 'x < y \\leq z', display: false } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('<code class="math">x < y \\leq z</code>')
    })

    it('should render mathematicsBlock without escaping latex body', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematicsBlock', attrs: { latex: 'a < b & c > d' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('<code class="math">a < b & c > d</code>')
      expect(html).toContain('data-latex="a &lt; b &amp; c &gt; d"')
    })

    it('should return empty for mathematics with empty latex', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematics', attrs: { latex: '', display: true } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toBe('')
    })

    it('should return empty for mathematicsBlock with empty latex', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'mathematicsBlock', attrs: { latex: '' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toBe('')
    })

    it('should render inline mathematics node inside paragraph without escaping', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'If ' },
              { type: 'mathematics', attrs: { latex: 'x < 0', display: false } },
              { type: 'text', text: ' then ...' },
            ],
          },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('<code class="math">x < 0</code>')
      expect(html).toContain('data-latex="x &lt; 0"')
    })
  })

  describe('tabdataBlock', () => {
    it('should render tabdataBlock with all data attributes', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_123', viewId: 'vw_456', title: '用户表', maxHeight: 500 } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-type="tabdata-block"')
      expect(html).toContain('data-table-id="tbl_123"')
      expect(html).toContain('data-table-title="用户表"')
      expect(html).toContain('data-view-id="vw_456"')
      expect(html).toContain('data-max-height="500"')
      expect(html).toContain('class="tabdata-block"')
    })

    it('should render tabdataBlock without optional viewId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_123', title: 'Table' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-table-id="tbl_123"')
      expect(html).not.toContain('data-view-id')
    })

    it('should escape HTML in tabdataBlock title', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: '<script>alert(1)</script>' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    })

    it('should escape HTML in tabdataBlock tableId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: '"><img src=x onerror=alert(1)>', title: 'test' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('<img')
      expect(html).toContain('&lt;img')
    })

    it('should escape HTML in tabdataBlock viewId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', viewId: '"><script>alert(1)</script>', title: 'test' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('<script>')
    })

    it('should return empty string for tabdataBlock with no tableId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: '', title: 'no-id' } },
        ],
      }
      expect(pmJsonToHtml(doc)).toBe('')
    })

    it('should handle undefined maxHeight gracefully', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-table-id="tbl_1"')
    })

    it('should render tabdataBlock with maxHeight attribute', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: 600 } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-max-height="600"')
    })

    it('should handle attrs as null gracefully', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: null },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toBe('')
    })

    it('should default title to 未命名表格 when title is empty string', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: '' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-table-title="未命名表格"')
      expect(html).toContain('📊 未命名表格')
    })

    it('should default title to 未命名表格 when title is missing', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-table-title="未命名表格"')
      expect(html).toContain('📊 未命名表格')
    })

    it('should default title to 未命名表格 when title is non-string', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 123 } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toContain('data-table-title="未命名表格"')
    })

    it('should not render data-view-id when viewId is empty string', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', viewId: '', title: 'test' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('data-view-id')
    })

    it('should not render data-max-height when maxHeight is 0', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: 0 } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('data-max-height')
    })

    it('should not render data-max-height when maxHeight is negative', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: -100 } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('data-max-height')
    })

    it('should not render data-max-height when maxHeight is NaN', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: NaN } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('data-max-height')
    })

    it('should not render data-max-height when maxHeight is a string', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: 'abc' } },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).not.toContain('data-max-height')
    })

    it('should handle attrs as undefined gracefully', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock' },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toBe('')
    })

    it('should handle attrs as empty object (no tableId) gracefully', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: {} },
        ],
      }
      const html = pmJsonToHtml(doc)
      expect(html).toBe('')
    })
  })
})
