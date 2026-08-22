import { describe, it, expect } from 'vitest'
import { pmJsonToMarkdown } from '../converters/pmJsonToMarkdown.js'

describe('pmJsonToMarkdown', () => {
  it('should serialize headings', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Subtitle' }] },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toContain('# Title')
    expect(md).toContain('### Subtitle')
  })

  it('should serialize paragraph with inline marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toContain('**bold**')
    expect(md).toContain('*italic*')
  })

  it('should NOT escape text inside code marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a*b_c', marks: [{ type: 'code' }] },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('`a*b_c`')
    expect(md).not.toContain('\\*')
    expect(md).not.toContain('\\_')
  })

  it('should serialize image nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { src: 'https://img.com/photo.png', alt: 'photo' },
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('![photo](https://img.com/photo.png)')
  })

  it('should serialize inline image nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'image', attrs: { src: 'https://img.com/a.png', alt: 'pic' } },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toContain('![pic](https://img.com/a.png)')
  })

  it('should serialize linked inline image nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'image',
              attrs: { src: 'https://img.com/a.png', alt: 'pic' },
              marks: [{ type: 'link', attrs: { href: 'https://www.example.com' } }],
            },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('[![pic](https://img.com/a.png)](https://www.example.com)')
  })

  it('should serialize bullet lists', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('- a\n- b')
  })

  it('should serialize ordered lists', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1 },
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('1. first\n2. second')
  })

  it('should serialize task lists', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }] },
            { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toContain('- [ ] todo')
    expect(md).toContain('- [x] done')
  })

  it('should serialize code blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'console.log("hi")' }],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('```js\nconsole.log("hi")\n```')
  })

  it('should serialize blockquotes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('> quoted')
  })

  it('should serialize tables preserving inline formatting', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name', marks: [{ type: 'strong' }] }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
              ],
            },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toContain('**Name**')
    expect(md).toContain('| x | 1 |')
  })

  it('should serialize horizontal rules', () => {
    const md = pmJsonToMarkdown({ type: 'doc', content: [{ type: 'horizontalRule' }] })
    expect(md).toBe('---')
  })

  it('should serialize youtube nodes as links', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'youtube', attrs: { src: 'https://www.youtube.com/embed/abc' } },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toBe('[YouTube](https://www.youtube.com/embed/abc)')
  })

  it('should serialize multi-paragraph table cells', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] },
                  ],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'para1' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'para2' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const md = pmJsonToMarkdown(doc)
    expect(md).toContain('para1 para2')
  })

  it('should return empty string for null input', () => {
    expect(pmJsonToMarkdown(null)).toBe('')
    expect(pmJsonToMarkdown(undefined)).toBe('')
  })

  it('should serialize inline mathematics', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The formula ' },
            { type: 'mathematics', attrs: { latex: 'E=mc^2', display: false } },
            { type: 'text', text: ' is famous.' },
          ],
        },
      ],
    }
    expect(pmJsonToMarkdown(doc)).toBe('The formula $E=mc^2$ is famous.')
  })

  it('should serialize block-level mathematics (legacy display:true)', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'mathematics', attrs: { latex: '\\int_0^1 x^2 dx', display: true } },
      ],
    }
    expect(pmJsonToMarkdown(doc)).toBe('$$\n\\int_0^1 x^2 dx\n$$')
  })

  it('should serialize canonical mathematicsBlock', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'mathematicsBlock', attrs: { latex: '\\int_0^1 x^2 dx' } },
      ],
    }
    expect(pmJsonToMarkdown(doc)).toBe('$$\n\\int_0^1 x^2 dx\n$$')
  })

  it('should serialize legacy Novel math node as inline', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'math', attrs: { latex: 'a^2' } },
          ],
        },
      ],
    }
    expect(pmJsonToMarkdown(doc)).toBe('$a^2$')
  })

  it('should skip mathematics with empty latex', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'mathematics', attrs: { latex: '', display: true } },
      ],
    }
    expect(pmJsonToMarkdown(doc)).toBe('')
  })

  describe('URL safety', () => {
    it('should strip javascript: from link href and output plain text', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('javascript:')
      expect(md).not.toContain('[evil]')
      expect(md).toBe('evil')
    })

    it('should strip JAVASCRIPT: (uppercase) from link href', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'JAVASCRIPT:alert(1)' } }] }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('JAVASCRIPT:')
      expect(md).toBe('evil')
    })

    it('should strip data: URLs from link href', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'data:text/html,<script>alert(1)</script>' } }] }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('data:')
      expect(md).toBe('evil')
    })

    it('should strip javascript: from image src', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'xss' } }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('javascript:')
      expect(md).not.toContain('![')
    })

    it('should allow safe URLs in links', () => {
      for (const href of ['https://safe.com', 'mailto:a@b.com', '/page', '#section']) {
        const doc = {
          type: 'doc',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }],
          }],
        }
        const md = pmJsonToMarkdown(doc)
        expect(md).toContain(`[link](${href})`)
      }
    })

    it('should allow safe URLs in images', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: 'https://img.com/photo.png', alt: 'photo' } }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('![photo](https://img.com/photo.png)')
    })

    it('should strip vbscript: from link href', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'vbscript:msgbox("xss")' } }] }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('vbscript:')
      expect(md).toBe('evil')
    })

    it('should strip javascript: from block-level image src', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'xss' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('javascript:')
      expect(md).toBe('')
    })

    it('should strip javascript: from youtube src', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'youtube', attrs: { src: 'javascript:alert(1)' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('javascript:')
      expect(md).toBe('')
    })

    it('should allow safe URLs for block-level images', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'image', attrs: { src: 'https://img.com/photo.png', alt: 'photo' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('![photo](https://img.com/photo.png)')
    })
  })

  describe('unsupported rich marks', () => {
    it('should ignore textStyle color and keep plain text', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'red text', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] }],
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe('red text')
    })

    it('should preserve native marks when mixed with textStyle', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: 'bold red',
            marks: [{ type: 'strong' }, { type: 'textStyle', attrs: { color: '#ff0000' } }],
          }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('**bold red**')
    })

    it('should ignore textStyle with invalid color', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'safe', marks: [{ type: 'textStyle', attrs: { color: '";alert(1)//' } }] }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('style=')
      expect(md).toBe('safe')
    })

    it('should ignore textStyle with named color', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'blue', marks: [{ type: 'textStyle', attrs: { color: 'blue' } }] }],
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe('blue')
    })

    it('should escape HTML in text with unsupported rich marks', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: '<script>alert(1)</script>', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('<script>')
      expect(md).toBe('\\<script\\>alert(1)\\</script\\>')
    })

    it('should ignore highlight and preserve native marks', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: 'emphasis',
            marks: [{ type: 'em' }, { type: 'highlight', attrs: { color: '#00ff00' } }],
          }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('*emphasis*')
    })

    it('should ignore underline marks and keep text', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'underlined', marks: [{ type: 'underline' }] }],
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe('underlined')
    })

    it('should ignore underline and textStyle together', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: 'blue underline',
            marks: [{ type: 'underline' }, { type: 'textStyle', attrs: { color: 'blue' } }],
          }],
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe('blue underline')
    })
  })

  describe('image width/height (EIP-010)', () => {
    it('should export a standard Markdown image and ignore width', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: 'https://img.com/a.png', alt: 'pic', width: 800 },
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('![pic](https://img.com/a.png)')
    })

    it('should export a standard Markdown image and ignore width/height', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: 'https://img.com/a.png', alt: 'pic', width: 800, height: 600 },
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('![pic](https://img.com/a.png)')
    })

    it('should fall back to Markdown when no dimensions', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: 'https://img.com/a.png', alt: 'pic' },
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe('![pic](https://img.com/a.png)')
    })

    it('should preserve image with data URI source', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgo='
      const doc = {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: dataUri, alt: 'inline' },
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe(`![inline](${dataUri})`)
    })

    it('should preserve image with local object path', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: 'tabdoc/images/hash.png', alt: 'local' },
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe('![local](tabdoc/images/hash.png)')
    })

    it('should preserve a private image as a stable file marker', () => {
      const fileId = '802cf8e7-08fc-4619-9145-a37b201fb877'
      const doc = {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: '', fileId, alt: 'private' },
        }],
      }
      expect(pmJsonToMarkdown(doc)).toBe(`![private](tabtin-file://asset/${fileId})`)
    })

    it('should use standard Markdown for inline image with dimensions', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'image', attrs: { src: 'https://img.com/a.png', alt: 'pic', width: 400, height: 300 } },
          ],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('![pic](https://img.com/a.png)')
    })

    it('should wrap standard Markdown image in link when linked', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'image',
            attrs: { src: 'https://img.com/a.png', alt: 'pic', width: 200 },
            marks: [{ type: 'link', attrs: { href: 'https://www.example.com' } }],
          }],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('[![pic](https://img.com/a.png)](https://www.example.com)')
    })

    it('should escape Markdown special chars in image alt', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: 'https://img.com/a.png', alt: 'a<b>"c&d', width: 100 },
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('![a\\<b\\>"c&d](https://img.com/a.png)')
    })
  })

  describe('table colspan/rowspan (EIP-002)', () => {
    it('should serialize table with colspan as HTML', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', attrs: { colspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Merged Header' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
              ],
            },
          ],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('<table>')
      expect(md).toContain('<th colspan="2">Merged Header</th>')
      expect(md).toContain('<td>A</td>')
      expect(md).toContain('<td>B</td>')
      expect(md).toContain('</table>')
    })

    it('should serialize table with rowspan as HTML', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', attrs: { rowspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Span' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }] },
              ],
            },
          ],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('<th rowspan="2">Span</th>')
    })

    it('should keep Markdown syntax for table without merged cells', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H1' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H2' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
              ],
            },
          ],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('<table>')
      expect(md).toContain('| H1 | H2 |')
      expect(md).toContain('| a | b |')
    })

    it('should treat colspan=1 / rowspan=1 as normal (no merge)', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Normal' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Data' }] }] },
              ],
            },
          ],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('<table>')
      expect(md).toContain('|')
    })

    it('should preserve bold formatting in HTML table cells', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 2 },
                  content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Bold Header', marks: [{ type: 'strong' }] }],
                  }],
                },
              ],
            },
          ],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('<strong>Bold Header</strong>')
    })

    it('should escape HTML in merged table cell text', () => {
      const doc = {
        type: 'doc',
        content: [{
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 2 },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }],
                },
              ],
            },
          ],
        }],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('<script>')
      expect(md).toContain('&lt;script&gt;')
    })
  })

  describe('tabdataBlock', () => {
    it('should serialize basic tabdataBlock', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_123', title: '用户表' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe(':::tabdata{tableId="tbl_123" title="用户表"}\n:::')
    })

    it('should serialize tabdataBlock with viewId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_123', viewId: 'vw_456', title: '用户表' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe(':::tabdata{tableId="tbl_123" viewId="vw_456" title="用户表"}\n:::')
    })

    it('should escape double quotes in title', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'A "quoted" table' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('title="A \\"quoted\\" table"')
    })

    it('should escape backslashes in title', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'path\\to\\table' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('title="path\\\\to\\\\table"')
    })

    it('should emit empty string for tabdataBlock with no tableId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: '', title: 'empty' } },
        ],
      }
      expect(pmJsonToMarkdown(doc)).toBe('')
    })

    it('should default title to 未命名表格 when empty', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_x', title: '' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('title="未命名表格"')
    })

    it('should replace newlines in title with spaces', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'line1\nline2\rline3' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('title="line1 line2 line3"')
      expect(md).not.toContain('\n line')
    })

    it('should escape quotes in tableId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl"inject', title: 'test' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('tableId="tbl\\"inject"')
    })

    it('should escape quotes in viewId', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', viewId: 'vw"bad', title: 'test' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('viewId="vw\\"bad"')
    })

    it('should include maxHeight when not default (400)', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: 600 } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toContain('maxHeight="600"')
    })

    it('should omit maxHeight when equal to default (400)', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: 400 } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('maxHeight')
    })

    it('should treat non-number maxHeight as default', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: { tableId: 'tbl_1', title: 'test', maxHeight: 'abc' } },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).not.toContain('maxHeight')
    })

    it('should handle attrs as undefined gracefully (no tableId emits empty)', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock' },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('')
    })

    it('should handle attrs as empty object gracefully (no tableId emits empty)', () => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'tabdataBlock', attrs: {} },
        ],
      }
      const md = pmJsonToMarkdown(doc)
      expect(md).toBe('')
    })
  })
})
