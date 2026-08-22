import { describe, it, expect } from 'vitest'
import { basicMarkdownToHtml } from '../basicMarkdownToHtml.js'

/**
 * EC-14: 粗斜体嵌套修复验证
 * EC-35: JSDoc 限制范围标注（通过代码审查验证）
 */

describe('EC-14: basicMarkdownToHtml 粗斜体嵌套', () => {
  it('***text*** 应渲染为粗斜体', () => {
    const result = basicMarkdownToHtml('***bold italic***')
    expect(result).toContain('<strong><em>bold italic</em></strong>')
  })

  it('**bold** 仍正常渲染', () => {
    const result = basicMarkdownToHtml('**bold text**')
    expect(result).toContain('<strong>bold text</strong>')
  })

  it('*italic* 仍正常渲染', () => {
    const result = basicMarkdownToHtml('*italic text*')
    expect(result).toContain('<em>italic text</em>')
  })

  it('混合粗体和斜体在同一行', () => {
    const result = basicMarkdownToHtml('**bold** and *italic*')
    expect(result).toContain('<strong>bold</strong>')
    expect(result).toContain('<em>italic</em>')
  })

  it('粗斜体与普通文本混合', () => {
    const result = basicMarkdownToHtml('hello ***world*** end')
    expect(result).toContain('hello <strong><em>world</em></strong> end')
  })

  it('行内代码不被粗体规则处理', () => {
    const result = basicMarkdownToHtml('`**not bold**`')
    expect(result).toContain('<code>**not bold**</code>')
    expect(result).not.toContain('<strong>')
  })
})

describe('basicMarkdownToHtml 基本功能', () => {
  it('标题渲染', () => {
    expect(basicMarkdownToHtml('# H1')).toContain('<h1>H1</h1>')
    expect(basicMarkdownToHtml('## H2')).toContain('<h2>H2</h2>')
    expect(basicMarkdownToHtml('### H3')).toContain('<h3>H3</h3>')
  })

  it('无序列表渲染', () => {
    const result = basicMarkdownToHtml('- item1\n- item2')
    expect(result).toContain('<ul>')
    expect(result).toContain('<li>item1</li>')
    expect(result).toContain('<li>item2</li>')
  })

  it('代码块渲染', () => {
    const result = basicMarkdownToHtml('```\nconst x = 1\n```')
    expect(result).toContain('<pre><code>')
    expect(result).toContain('const x = 1')
  })

  it('链接 URL 安全校验', () => {
    const safe = basicMarkdownToHtml('[link](https://example.com)')
    expect(safe).toContain('<a href="https://example.com">link</a>')

    const unsafe = basicMarkdownToHtml('[evil](javascript:alert(1))')
    expect(unsafe).not.toContain('javascript:')
    expect(unsafe).toContain('evil')
  })

  it('HTML 实体转义', () => {
    const result = basicMarkdownToHtml('<script>alert(1)</script>')
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;script&gt;')
  })
})
