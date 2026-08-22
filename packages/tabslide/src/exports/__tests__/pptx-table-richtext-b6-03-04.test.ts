/**
 * 回归测试 — B6-03 / B6-04
 *
 * B6-03: <font> 标签属性（color/face/size）在 PPTX 导出中正确提取
 * B6-04: 表格单元格内 UL/OL 列表导出生成正确的 bullet 属性
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('pptxgenjs', () => {
  return { default: class PptxGenJSMock {} }
})

import { parseRichTextForPptx } from '../pptx'

const emptyContext = {
  options: {},
  warnings: [],
  warn: () => {},
  slideNumberById: new Map(),
} as never

// ═══════════════════════════════════════════════
// B6-03: <font> 标签 color / face / size 提取
// ═══════════════════════════════════════════════

describe('B6-03: walkTableRichTextNode 处理 <font> 标签', () => {
  it('提取 font color 为 hex 格式', () => {
    const html = '<p><font color="#ff0000">hex red</font></p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const run = result!.textProps.find((r) => r.text === 'hex red')
    expect(run).toBeDefined()
    expect(run!.options!.color).toBe('FF0000')
  })

  it('提取 font face 属性', () => {
    const html = '<p><font face="Arial">arial text</font></p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const run = result!.textProps.find((r) => r.text === 'arial text')
    expect(run).toBeDefined()
    expect(run!.options!.fontFace).toBe('Arial')
  })

  it('提取 font size 属性（HTML 1-7 映射到 pt）', () => {
    const html = '<p><font size="5">large</font></p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const run = result!.textProps.find((r) => r.text === 'large')
    expect(run).toBeDefined()
    expect(run!.options!.fontSize).toBe(18)
  })

  it('同时提取 font 的多个属性', () => {
    const html = '<p><font color="#00ff00" face="Times New Roman" size="4">multi</font></p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const run = result!.textProps.find((r) => r.text === 'multi')
    expect(run).toBeDefined()
    expect(run!.options!.color).toBe('00FF00')
    expect(run!.options!.fontFace).toBe('Times New Roman')
    expect(run!.options!.fontSize).toBe(14)
  })

  it('font 标签嵌套在 b 标签内，同时保留 bold', () => {
    const html = '<p><b><font color="#0000ff">bold blue</font></b></p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const run = result!.textProps.find((r) => r.text === 'bold blue')
    expect(run).toBeDefined()
    expect(run!.options!.bold).toBe(true)
    expect(run!.options!.color).toBe('0000FF')
  })

  it('font size 无效值被忽略', () => {
    const html = '<p><font size="99">invalid</font></p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const run = result!.textProps.find((r) => r.text === 'invalid')
    expect(run).toBeDefined()
    expect(run!.options!.fontSize).toBeUndefined()
  })

  it('font size 边界值 1 和 7 正确映射', () => {
    const html = '<p><font size="1">tiny</font><font size="7">huge</font></p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const tiny = result!.textProps.find((r) => r.text === 'tiny')
    const huge = result!.textProps.find((r) => r.text === 'huge')
    expect(tiny!.options!.fontSize).toBe(8)
    expect(huge!.options!.fontSize).toBe(36)
  })
})

// ═══════════════════════════════════════════════
// B6-04: UL/OL/LI 列表导出 bullet 属性
// ═══════════════════════════════════════════════

describe('B6-04: parseRichTextForPptx 处理 UL/OL 列表', () => {
  it('无序列表生成 bullet: true', () => {
    const html = '<ul><li>Item A</li><li>Item B</li></ul>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const items = result!.textProps
    expect(items.length).toBe(2)
    expect(items[0].text).toBe('Item A')
    expect(items[0].options!.bullet).toBe(true)
    expect(items[1].text).toBe('Item B')
    expect(items[1].options!.bullet).toBe(true)
  })

  it('有序列表生成 bullet.type=number', () => {
    const html = '<ol><li>First</li><li>Second</li></ol>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const items = result!.textProps
    expect(items.length).toBe(2)
    expect(items[0].options!.bullet).toEqual({
      type: 'number',
      numberType: 'arabicPeriod',
    })
    expect(items[1].options!.bullet).toEqual({
      type: 'number',
      numberType: 'arabicPeriod',
    })
  })

  it('有序列表 type="a" 生成 alphaLcPeriod', () => {
    const html = '<ol type="a"><li>alpha</li></ol>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    expect(result!.textProps[0].options!.bullet).toEqual({
      type: 'number',
      numberType: 'alphaLcPeriod',
    })
  })

  it('混合段落和列表', () => {
    const html = '<p>Normal text</p><ul><li>Bullet</li></ul><p>After</p>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const items = result!.textProps
    expect(items.length).toBe(3)

    expect(items[0].text).toBe('Normal text')
    expect(items[0].options!.bullet).toBeUndefined()
    expect(items[0].options!.breakLine).toBe(true)

    expect(items[1].text).toBe('Bullet')
    expect(items[1].options!.bullet).toBe(true)
    expect(items[1].options!.breakLine).toBe(true)

    expect(items[2].text).toBe('After')
    expect(items[2].options!.bullet).toBeUndefined()
  })

  it('嵌套列表生成 indentLevel', () => {
    const html = '<ul><li>Top<ul><li>Nested</li></ul></li></ul>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const items = result!.textProps

    const topItem = items.find((r) => r.text === 'Top')
    expect(topItem).toBeDefined()
    expect(topItem!.options!.bullet).toBe(true)
    expect(topItem!.options!.indentLevel).toBeUndefined()

    const nestedItem = items.find((r) => r.text === 'Nested')
    expect(nestedItem).toBeDefined()
    expect(nestedItem!.options!.bullet).toBe(true)
    expect(nestedItem!.options!.indentLevel).toBe(1)
  })

  it('列表项内富文本格式保留', () => {
    const html = '<ul><li><b>Bold</b> and <i>italic</i></li></ul>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const items = result!.textProps

    const boldRun = items.find((r) => r.text === 'Bold')
    expect(boldRun).toBeDefined()
    expect(boldRun!.options!.bold).toBe(true)
    expect(boldRun!.options!.bullet).toBe(true)

    const italicRun = items.find((r) => r.text === 'italic')
    expect(italicRun).toBeDefined()
    expect(italicRun!.options!.italic).toBe(true)
  })

  it('UL/OL 在 walkTableRichTextNode 中被跳过，不重复提取文本', () => {
    const html = '<ul><li>Only once</li></ul>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const texts = result!.textProps.map((r) => r.text)
    expect(texts.filter((t) => t === 'Only once')).toHaveLength(1)
  })

  it('data-bullet-char 自定义 bullet 字符', () => {
    const html = '<ul data-bullet-char="★"><li>star</li></ul>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const item = result!.textProps[0]
    expect(item.options!.bullet).toEqual({
      characterCode: '2605',
    })
  })

  it('空列表不影响结果', () => {
    const html = '<p>Text</p><ul></ul>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    expect(result!.textProps.length).toBe(1)
    expect(result!.textProps[0].text).toBe('Text')
  })

  it('多层嵌套列表（三级）正确生成 indentLevel', () => {
    const html = '<ol><li>L1<ol><li>L2<ol><li>L3</li></ol></li></ol></li></ol>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const items = result!.textProps

    const l1 = items.find((r) => r.text === 'L1')
    const l2 = items.find((r) => r.text === 'L2')
    const l3 = items.find((r) => r.text === 'L3')

    expect(l1!.options!.indentLevel).toBeUndefined()
    expect(l2!.options!.indentLevel).toBe(1)
    expect(l3!.options!.indentLevel).toBe(2)
  })
})

// ═══════════════════════════════════════════════
// B6-03 + B6-04 组合场景
// ═══════════════════════════════════════════════

describe('B6-03 + B6-04 组合：font 标签 + 列表', () => {
  it('列表项内 font 标签属性正确提取', () => {
    const html = '<ul><li><font color="#ff0000" face="Courier">red courier</font></li></ul>'
    const result = parseRichTextForPptx(html, emptyContext)
    expect(result).not.toBeNull()
    const run = result!.textProps.find((r) => r.text === 'red courier')
    expect(run).toBeDefined()
    expect(run!.options!.bullet).toBe(true)
    expect(run!.options!.color).toBe('FF0000')
    expect(run!.options!.fontFace).toBe('Courier')
  })
})
