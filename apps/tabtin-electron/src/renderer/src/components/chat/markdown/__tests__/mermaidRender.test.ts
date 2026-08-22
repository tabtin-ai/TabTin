/**
 * 跑真实 mermaid，验证「编译 → 清洗」后节点文字还在。
 * 组件测试里 mermaid 是 mock 的，证明不了这一点。
 */

import { beforeAll, describe, expect, it } from 'vitest'
import mermaid from 'mermaid'
import { mermaidConfigFor, sanitizeMermaidSvg } from '../mermaidRender'

beforeAll(() => {
  // jsdom 不实现 SVG 文本测量，mermaid 布局阶段需要这两个 API。
  const proto = SVGElement.prototype as unknown as {
    getBBox?: () => { x: number; y: number; width: number; height: number }
    getComputedTextLength?: () => number
  }
  if (!proto.getBBox) {
    proto.getBBox = () => ({ x: 0, y: 0, width: 80, height: 24 })
  }
  if (!proto.getComputedTextLength) {
    proto.getComputedTextLength = () => 80
  }
})

const FLOWCHART = [
  'flowchart TD',
  '  A[用户提交订单] --> B{库存充足?}',
  '  B -->|是| C[生成发货单]',
  '  B -->|否| D[通知补货]',
].join('\n')

describe('sanitizeMermaidSvg', () => {
  it('保留原生 text 标签里的中文节点名', () => {
    expect(sanitizeMermaidSvg('<svg><g><text>开始处理</text></g></svg>')).toContain('开始处理')
  })

  // 这条固化的是「为什么必须 htmlLabels: false」：清洗器会把 foreignObject 连内容
  // 一起删掉，所以只能从源头不让 mermaid 产出它，而不是事后放宽清洗。
  it('会整段清掉 foreignObject，包括里面的文字', () => {
    const svg = [
      '<svg><foreignObject width="80" height="24">',
      '<div xmlns="http://www.w3.org/1999/xhtml"><span>开始处理</span></div>',
      '</foreignObject></svg>',
    ].join('')
    const out = sanitizeMermaidSvg(svg)

    expect(out).not.toContain('foreignObject')
    expect(out).not.toContain('开始处理')
  })

  it('清除 script 与事件属性但保留图形内容', () => {
    const out = sanitizeMermaidSvg(
      '<svg><script>alert(1)</script><g onload="alert(2)"><text>节点</text></g></svg>',
    )

    expect(out).not.toContain('<script')
    expect(out).not.toContain('onload')
    expect(out).toContain('节点')
  })
})

describe('真实 mermaid 编译产物', () => {
  it('flowchart 不再产出 foreignObject，中文标签清洗后仍在', async () => {
    mermaid.initialize(mermaidConfigFor('light'))
    const { svg } = await mermaid.render('mermaid_test_light', FLOWCHART)

    expect(svg).not.toContain('foreignObject')

    const clean = sanitizeMermaidSvg(svg)
    expect(clean).toContain('用户提交订单')
    expect(clean).toContain('库存充足')
    expect(clean).toContain('生成发货单')
    expect(clean).toContain('通知补货')
  })

  it('清洗不会掏空 SVG', async () => {
    mermaid.initialize(mermaidConfigFor('light'))
    const { svg } = await mermaid.render('mermaid_test_shape', FLOWCHART)
    const clean = sanitizeMermaidSvg(svg)

    expect(clean).toContain('<svg')
    expect(clean.match(/<text/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  // 对照组：坐实根因。沿用 mermaid 默认的 htmlLabels 就会走 foreignObject，
  // 清洗后节点文字全没——这正是  的现象。
  it('沿用 mermaid 默认 htmlLabels 会让节点文字在清洗后丢失', async () => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
    })
    const { svg } = await mermaid.render('mermaid_test_default_labels', FLOWCHART)

    expect(svg).toContain('foreignObject')
    expect(sanitizeMermaidSvg(svg)).not.toContain('用户提交订单')
  })

  it('深色主题产出与浅色不同的配色', async () => {
    mermaid.initialize(mermaidConfigFor('dark'))
    const dark = await mermaid.render('mermaid_test_dark', FLOWCHART)
    mermaid.initialize(mermaidConfigFor('light'))
    const light = await mermaid.render('mermaid_test_light2', FLOWCHART)

    expect(dark.svg).not.toBe(light.svg)
    expect(sanitizeMermaidSvg(dark.svg)).toContain('用户提交订单')
  })
})
