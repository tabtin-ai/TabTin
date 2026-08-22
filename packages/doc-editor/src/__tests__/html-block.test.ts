import { describe, it, expect } from 'vitest'
import { markdownToPmJson } from '../converters/markdownToPmJson.js'
import { pmJsonToMarkdown } from '../converters/pmJsonToMarkdown.js'
import { pmJsonToHtml } from '../converters/pmJsonToHtml.js'
import { pmJsonToBinary, binaryToPmJson } from '../converters/yjsConverters.js'

/**
 *  — HTML 嵌入块（htmlBlock）TS 侧转换与安全测试。
 *
 * markdown 语法契约（CLI 依赖，必须精确）：
 *   :::htmlblock{fileId="xxx" src="https://..." title="架构图" height="480"}
 *   :::
 */
describe('htmlBlock — markdown → PM JSON', () => {
  it('解析完整属性', () => {
    const md = ':::htmlblock{fileId="f_1" src="https://cdn.example.com/a.html" title="架构图" height="600"}\n:::'
    const result = markdownToPmJson(md) as any
    expect(result.content).toHaveLength(1)
    const node = result.content[0]
    expect(node.type).toBe('htmlBlock')
    expect(node.attrs.fileId).toBe('f_1')
    expect(node.attrs.src).toBe('https://cdn.example.com/a.html')
    expect(node.attrs.title).toBe('架构图')
    expect(node.attrs.height).toBe(600)
  })

  it('缺省属性用默认值', () => {
    const md = ':::htmlblock{fileId="f_2"}\n:::'
    const result = markdownToPmJson(md) as any
    const node = result.content[0]
    expect(node.type).toBe('htmlBlock')
    expect(node.attrs.fileId).toBe('f_2')
    expect(node.attrs.src).toBe('')
    expect(node.attrs.title).toBe('未命名 HTML')
    expect(node.attrs.height).toBe(480)
  })

  it('属性顺序无关（解析按名取值）', () => {
    const md = ':::htmlblock{title="标题" height="720" src="https://x.com/a.html" fileId="f_3"}\n:::'
    const result = markdownToPmJson(md) as any
    const node = result.content[0]
    expect(node.attrs.fileId).toBe('f_3')
    expect(node.attrs.src).toBe('https://x.com/a.html')
    expect(node.attrs.title).toBe('标题')
    expect(node.attrs.height).toBe(720)
  })

  it('title 含转义双引号', () => {
    const md = ':::htmlblock{fileId="f_1" src="https://x.com/a.html" title="A \\"quoted\\" html" height="480"}\n:::'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].attrs.title).toBe('A "quoted" html')
  })

  it('title 含转义反斜杠', () => {
    const md = ':::htmlblock{fileId="f_1" src="https://x.com/a.html" title="path\\\\to" height="480"}\n:::'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].attrs.title).toBe('path\\to')
  })

  it('非法 height 回落默认值', () => {
    const md = ':::htmlblock{fileId="f_1" src="https://x.com/a.html" title="t" height="0"}\n:::'
    const result = markdownToPmJson(md) as any
    expect(result.content[0].attrs.height).toBe(480)
  })

  it('闭合 ::: 行不泄漏为多余段落', () => {
    const md = '# 标题\n\n:::htmlblock{fileId="f_1" src="https://x.com/a.html" title="t" height="480"}\n:::\n\n正文'
    const result = markdownToPmJson(md) as any
    const types = result.content.map((n: any) => n.type)
    expect(types).toEqual(['heading', 'htmlBlock', 'paragraph'])
  })
})

describe('htmlBlock — PM JSON → markdown 往返', () => {
  const roundtrip = (md: string) => pmJsonToMarkdown(markdownToPmJson(md))

  it('完整属性往返稳定', () => {
    const md = ':::htmlblock{fileId="f_1" src="https://cdn.example.com/a.html" title="架构图" height="480"}\n:::'
    expect(roundtrip(md)).toBe(md)
  })

  it('非默认 height 往返稳定', () => {
    const md = ':::htmlblock{fileId="f_1" src="https://cdn.example.com/a.html" title="架构图" height="720"}\n:::'
    expect(roundtrip(md)).toBe(md)
  })

  it('转义双引号 title 往返稳定', () => {
    const md = ':::htmlblock{fileId="f_1" src="https://x.com/a.html" title="A \\"q\\" html" height="480"}\n:::'
    expect(roundtrip(md)).toBe(md)
  })

  it('title 换行序列化归一为空格', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'htmlBlock', attrs: { fileId: 'f_1', src: 'https://x.com/a.html', title: 'line1\nline2', height: 480 } },
      ],
    }
    const md = pmJsonToMarkdown(json)
    expect(md).toContain('title="line1 line2"')
    const back = markdownToPmJson(md) as any
    expect(back.content[0].attrs.title).toBe('line1 line2')
  })

  it('与其他块共存往返稳定', () => {
    const md = '# 标题\n\n:::htmlblock{fileId="f_1" src="https://x.com/a.html" title="t" height="480"}\n:::\n\n正文'
    const result = roundtrip(md)
    expect(result).toContain('# 标题')
    expect(result).toContain(':::htmlblock{fileId="f_1" src="https://x.com/a.html" title="t" height="480"}')
    expect(result).toContain('正文')
  })

  it('fileId 与 src 皆空视为退化块，序列化为空', () => {
    const json = {
      type: 'doc',
      content: [{ type: 'htmlBlock', attrs: { fileId: '', src: '', title: 't', height: 480 } }],
    }
    expect(pmJsonToMarkdown(json)).toBe('')
  })
})

describe('htmlBlock — PM JSON → HTML（sandbox iframe + 安全）', () => {
  const render = (attrs: Record<string, unknown>) =>
    pmJsonToHtml({ type: 'doc', content: [{ type: 'htmlBlock', attrs }] })

  it('输出受控 sandbox iframe 与全部 data 属性', () => {
    const html = render({ fileId: 'f_1', src: 'https://cdn.example.com/a.html', title: '架构图', height: 600 })
    expect(html).toContain('data-type="html-block"')
    expect(html).toContain('data-file-id="f_1"')
    expect(html).toContain('data-src="https://cdn.example.com/a.html"')
    expect(html).toContain('data-title="架构图"')
    expect(html).toContain('data-height="600"')
    expect(html).toContain('<iframe')
    expect(html).toContain('src="https://cdn.example.com/a.html"')
    expect(html).toContain('sandbox="allow-scripts allow-popups"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('title="架构图"')
    expect(html).toContain('height:600px')
  })

  it('安全红线：sandbox 绝不含 allow-same-origin', () => {
    const html = render({ fileId: 'f_1', src: 'https://cdn.example.com/a.html', title: 't', height: 480 })
    expect(html).not.toContain('allow-same-origin')
  })

  it('拒绝 javascript: 协议 src', () => {
    const html = render({ fileId: 'f_1', src: 'javascript:alert(1)', title: 't', height: 480 })
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data-src=')
    // 块仍渲染（fileId 存在），但 iframe 无 src
    expect(html).toContain('data-type="html-block"')
    expect(html).not.toMatch(/<iframe[^>]*\ssrc=/)
  })

  it('拒绝 data: 协议 src', () => {
    const html = render({ fileId: 'f_1', src: 'data:text/html,<script>alert(1)</script>', title: 't', height: 480 })
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('<script>')
  })

  it('拒绝相对路径 src', () => {
    const html = render({ fileId: 'f_1', src: '/relative/path.html', title: 't', height: 480 })
    expect(html).not.toContain('src="/relative')
  })

  it('拒绝协议相对 src（//evil）', () => {
    const html = render({ fileId: 'f_1', src: '//evil.com/x.html', title: 't', height: 480 })
    expect(html).not.toContain('//evil.com')
  })

  it('拒绝大写 JAVASCRIPT: 协议', () => {
    const html = render({ fileId: 'f_1', src: 'JAVASCRIPT:alert(1)', title: 't', height: 480 })
    expect(html).not.toContain('JAVASCRIPT:')
  })

  it('转义 title 中的 HTML 特殊字符', () => {
    const html = render({ fileId: 'f_1', src: 'https://x.com/a.html', title: '<script>alert(1)</script>', height: 480 })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('转义 title 中的双引号', () => {
    const html = render({ fileId: 'f_1', src: 'https://x.com/a.html', title: 'a"b', height: 480 })
    expect(html).toContain('&quot;')
  })

  it('转义 src 中的 & 符号', () => {
    const html = render({ fileId: 'f_1', src: 'https://x.com/a.html?b=1&c=2', title: 't', height: 480 })
    expect(html).toContain('https://x.com/a.html?b=1&amp;c=2')
    expect(html).not.toContain('b=1&c=2')
  })

  it('转义 fileId 中的注入尝试', () => {
    const html = render({ fileId: '"><img src=x onerror=alert(1)>', src: 'https://x.com/a.html', title: 't', height: 480 })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('fileId 与有效 src 皆无 → 空串', () => {
    expect(render({ fileId: '', src: '', title: 't', height: 480 })).toBe('')
    expect(render({ fileId: '', src: 'javascript:alert(1)', title: 't', height: 480 })).toBe('')
  })

  it('title 缺省回落默认值', () => {
    const html = render({ fileId: 'f_1', src: 'https://x.com/a.html', height: 480 })
    expect(html).toContain('data-title="未命名 HTML"')
  })
})

describe('htmlBlock — PM JSON → Yjs → PM JSON 往返（防  同类）', () => {
  it('节点不丢、不转义为文本、属性完整', async () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '前' }] },
        { type: 'htmlBlock', attrs: { fileId: 'f_1', src: 'https://cdn.example.com/a.html', title: '架构图', height: 600 } },
        { type: 'paragraph', content: [{ type: 'text', text: '后' }] },
      ],
    }
    const binary = await pmJsonToBinary(doc)
    expect(binary).not.toBeNull()

    const back = await binaryToPmJson(binary!)
    expect(back).not.toBeNull()

    const content = back!.content as any[]
    const htmlNode = content.find(n => n.type === 'htmlBlock')
    expect(htmlNode).toBeDefined()
    // 未被 degradeUnknownNodes 降级为 paragraph
    expect(htmlNode.type).toBe('htmlBlock')
    expect(htmlNode.attrs.fileId).toBe('f_1')
    expect(htmlNode.attrs.src).toBe('https://cdn.example.com/a.html')
    expect(htmlNode.attrs.title).toBe('架构图')
    expect(htmlNode.attrs.height).toBe(600)
    // 相邻段落文本未受影响
    expect(content.some(n => n.type === 'paragraph')).toBe(true)
  })
})
