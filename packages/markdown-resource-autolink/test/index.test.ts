import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { remarkAutolinkResource } from '../src/index.js'

function transform(src: string): string {
  const out = unified()
    .use(remarkParse)
    .use(remarkAutolinkResource)
    .use(remarkStringify)
    .processSync(src)
  return String(out)
}

describe('remarkAutolinkResource', () => {
  it('裸 TabTin 资源深链升级为可点击链接并保留完整 query', () => {
    const uri = 'tabtin://resource/table/46ff7041-cfdd-41f4-9f7e-2f9c93236e3d?hint=tabdata&recordIds=f7372b28-0636-432c-82d2-477d6af58af5'
    const out = transform(`查看 ${uri}`)

    // remark-stringify 会把「label 与 href 相同」的 link 节点压成 autolink literal。
    expect(out).toContain(`<${uri}>`)
  })

  it('POSIX 绝对路径升级为 tabtin://resource/file/<encoded>', () => {
    const out = transform('看这个 /Users/x/log.json 文件')
    expect(out).toContain('[/Users/x/log.json]')
    expect(out).toContain('tabtin://resource/file/')
    expect(out).toContain(encodeURIComponent('/Users/x/log.json'))
  })

  it('Windows 绝对路径升级', () => {
    const out = transform('Windows 路径 C:\\projects\\report.html 也支持')
    expect(out).toContain('[C:\\projects\\report.html]')
    expect(out).toContain(encodeURIComponent('C:\\projects\\report.html'))
  })

  it('裸路径在行首也能识别', () => {
    const out = transform('/tmp/out.json')
    expect(out).toContain('tabtin://resource/file/')
  })

  it('文件路径含 Unicode 字符（中文）支持', () => {
    const out = transform('打开 /Users/developer/项目报告.md 看看')
    expect(out).toContain(encodeURIComponent('/Users/developer/项目报告.md'))
  })

  it('结尾标点不被吞进路径', () => {
    const out = transform('参考 /Users/x/y.md，里面写得很详细')
    expect(out).toContain(encodeURIComponent('/Users/x/y.md'))
    expect(out).not.toContain(encodeURIComponent('/Users/x/y.md，'))
  })

  it('已在 markdown 链接里的路径不再二次升级', () => {
    const src = '看 [日志](file:///tmp/log.json) 这个文件'
    const out = transform(src)
    expect(out).toBe(src + '\n')
  })

  it('相对路径不识别（缺少 baseDir 上下文）', () => {
    const out = transform('看 ./relative/path.json 这个')
    expect(out).not.toContain('tabtin://resource/file/')
    expect(out).toContain('./relative/path.json')
  })

  it('URL 形式的文本不识别（remark-gfm 处理 url）', () => {
    const out = transform('链接 https://example.com/x 这个')
    expect(out).not.toContain('tabtin://resource/file/')
  })

  it('一行多个裸路径都能识别', () => {
    const out = transform('a /tmp/x.json 和 b /home/u/y.md 比对')
    expect(out.match(/tabtin:\/\/resource\/file\//g)?.length).toBe(2)
  })

  it('被括号包裹的路径只取内容', () => {
    const out = transform('详见(/Users/x/y.md)说明')
    expect(out).toContain(encodeURIComponent('/Users/x/y.md'))
    expect(out).not.toContain(encodeURIComponent('(/Users/x/y.md)'))
  })

  it('支持自定义 buildUri', () => {
    const src = '看 /tmp/out.json'
    const out = unified()
      .use(remarkParse)
      .use(remarkAutolinkResource, {
        buildUri: (raw) => `custom://${encodeURIComponent(raw)}`,
      })
      .use(remarkStringify)
      .processSync(src)
    expect(String(out)).toContain('custom://')
  })

  it('空文本节点不报错', () => {
    expect(() => transform('')).not.toThrow()
  })

  it.each(['tabtin-preprod', 'tabtin-dev'])(
    'bare %s resource URI becomes a link',
    (scheme) => {
      const uri = `${scheme}://resource/table/tbl_1?hint=tabdata&recordIds=rec_1`
      const out = transform(`open ${uri}`)
      expect(out).toContain(`<${uri}>`)
    },
  )
})
