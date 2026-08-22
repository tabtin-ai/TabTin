import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SafeHighlight } from './SafeHighlight'

describe('SafeHighlight', () => {
  it('null/undefined/空串 不渲染', () => {
    const { container: c1 } = render(<SafeHighlight html={null} />)
    expect(c1.textContent).toBe('')
    const { container: c2 } = render(<SafeHighlight html={undefined} />)
    expect(c2.textContent).toBe('')
    const { container: c3 } = render(<SafeHighlight html="" />)
    expect(c3.textContent).toBe('')
  })

  it('无 <em> 时直接输出文本', () => {
    const { container } = render(<SafeHighlight html="纯文本片段" />)
    expect(container.textContent).toBe('纯文本片段')
    expect(container.querySelector('mark')).toBeNull()
  })

  it('<em>...</em> 包成 <mark> 并保留前后文本', () => {
    const { container } = render(<SafeHighlight html="可以用 <em>二分查找</em> 替代线性扫描" />)
    const mark = container.querySelector('mark')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('二分查找')
    expect(container.textContent).toBe('可以用 二分查找 替代线性扫描')
  })

  it('多个 <em> 命中片段都被高亮', () => {
    const { container } = render(<SafeHighlight html="<em>性能</em>优化与<em>缓存</em>策略" />)
    const marks = container.querySelectorAll('mark')
    expect(marks).toHaveLength(2)
    expect(marks[0].textContent).toBe('性能')
    expect(marks[1].textContent).toBe('缓存')
  })

  it('XSS：<script> 标签被 React 当作文本，永不执行', () => {
    const malicious = '前缀 <script>window.__pwned = true</script> 后缀 <em>真命中</em>'
    const { container } = render(<SafeHighlight html={malicious} />)
    // <script> 应该作为字面文本出现
    expect(container.textContent).toContain('<script>')
    expect(container.textContent).toContain('window.__pwned = true')
    // 但 DOM 里没有真的 <script> 元素
    expect(container.querySelector('script')).toBeNull()
    // <em> 仍然正常高亮
    const mark = container.querySelector('mark')
    expect(mark!.textContent).toBe('真命中')
    // 全局 __pwned 没被设置
    expect((globalThis as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('XSS：<img onerror=...> 被当文本，不会触发图片加载/执行', () => {
    const malicious = '<img src=x onerror="window.__pwned2=1"> <em>safe</em>'
    const { container } = render(<SafeHighlight html={malicious} />)
    expect(container.textContent).toContain('<img')
    expect(container.querySelector('img')).toBeNull()
    expect((globalThis as unknown as { __pwned2?: number }).__pwned2).toBeUndefined()
  })

  it('XSS：嵌套 <em><script></em> 不会被剥成裸 script 执行', () => {
    const malicious = '<em>safe<script>x</script></em>'
    const { container } = render(<SafeHighlight html={malicious} />)
    // <em> 被识别为高亮，内层 <script> 文本被一并放进 <mark>
    const mark = container.querySelector('mark')
    expect(mark).not.toBeNull()
    // mark 内文本含 <script> 字面字符串，但没有真正 <script> 元素
    expect(mark!.textContent).toContain('<script>')
    expect(container.querySelector('script')).toBeNull()
  })

  it('多行 <em> 片段（含换行）也能匹配', () => {
    const html = 'line1\n<em>multi\nline</em>\nline2'
    const { container } = render(<SafeHighlight html={html} />)
    const mark = container.querySelector('mark')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('multi\nline')
  })

  it('自定义 markClassName 生效', () => {
    const { container } = render(
      <SafeHighlight html="<em>x</em>" markClassName="custom-mark-cls" />,
    )
    const mark = container.querySelector('mark')
    expect(mark).not.toBeNull()
    expect(mark!.className).toBe('custom-mark-cls')
  })

  it('大小写不敏感：<EM>...</EM> 同样高亮（兼容网关改写）', () => {
    const { container } = render(<SafeHighlight html="前 <EM>大写</EM> 中 <Em>混合</Em> 后" />)
    const marks = container.querySelectorAll('mark')
    expect(marks).toHaveLength(2)
    expect(marks[0].textContent).toBe('大写')
    expect(marks[1].textContent).toBe('混合')
  })
})
