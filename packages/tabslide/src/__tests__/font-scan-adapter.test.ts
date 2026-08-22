/**
 * font-scan-adapter 单元测试
 *
 * 覆盖：
 * - adaptElementsToSceneObjects：各类型 PPTElement 到 SceneObjects 的转换
 * - scanSlideFonts：端到端扫描结果验证
 */
import { describe, it, expect, vi } from 'vitest'
import {
  adaptElementsToSceneObjects,
  scanSlideFonts,
} from '../fonts/font-scan-adapter'
import type {
  PPTElement,
  PPTTextElement,
  PPTShapeElement,
  PPTTableElement,
} from '../types/slides'

// ---------------------------------------------------------------------------
// mock media-core 的 resolveFontFamily，避免依赖真实的字体注册表
// ---------------------------------------------------------------------------
vi.mock('@tabtin/media-core/fonts/registry', () => ({
  resolveFontFamily: (family: string) => {
    // 返回一个伪造的解析结果，让 scanFonts 能正常工作
    if (family === 'Inter' || family === 'sans-serif') return undefined
    return {
      url: `https://fonts.example.com/${family}.woff2`,
      resolvedFamily: family,
      weights: [400, 700],
      cjk: family.includes('Noto Sans SC') || family.includes('SimSun'),
    }
  },
}))

// ---------------------------------------------------------------------------
// 工具函数：快速构造最小化的 PPTElement 测试数据
// ---------------------------------------------------------------------------

function makeTextElement(
  overrides: Partial<PPTTextElement> & { id: string; content: string; defaultFontName: string },
): PPTTextElement {
  return {
    type: 'text',
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    defaultColor: '#000',
    ...overrides,
  } as PPTTextElement
}

function makeShapeElement(
  overrides: Partial<PPTShapeElement> & { id: string },
): PPTShapeElement {
  return {
    type: 'shape',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    viewBox: [200, 200] as [number, number],
    path: 'M0,0',
    fixedRatio: false,
    fill: '#fff',
    ...overrides,
  } as PPTShapeElement
}

function makeTableElement(
  overrides: Partial<PPTTableElement> & { id: string; data: PPTTableElement['data'] },
): PPTTableElement {
  return {
    type: 'table',
    x: 0,
    y: 0,
    width: 600,
    height: 300,
    colWidths: [0.5, 0.5],
    cellMinHeight: 36,
    ...overrides,
  } as PPTTableElement
}

// ---------------------------------------------------------------------------
// adaptElementsToSceneObjects
// ---------------------------------------------------------------------------

describe('adaptElementsToSceneObjects', () => {
  it('空数组返回空对象', () => {
    const result = adaptElementsToSceneObjects([])
    expect(result).toEqual({})
  })

  describe('PPTTextElement', () => {
    it('defaultFontName 正确映射为 fontFamily', () => {
      const el = makeTextElement({
        id: 'txt-1',
        content: '你好世界',
        defaultFontName: 'Noto Sans SC',
      })

      const objects = adaptElementsToSceneObjects([el])

      expect(objects['txt-1']).toBeDefined()
      expect(objects['txt-1'].type).toBe('text')
      expect(objects['txt-1'].fontFamily).toBe('Noto Sans SC')
    })

    it('HTML content 中的 font-family 样式被提取', () => {
      const el = makeTextElement({
        id: 'txt-2',
        content: '<span style="font-family: Roboto">Hello</span>',
        defaultFontName: 'Arial',
      })

      const objects = adaptElementsToSceneObjects([el])

      // content 应该是一个树结构，其中叶子节点包含 fontFamily
      const root = objects['txt-2'].content as { children: { children: { text: string; fontFamily?: string }[] }[] }
      const leaves = root.children[0].children
      expect(leaves.length).toBeGreaterThan(0)

      const robotoLeaf = leaves.find((l) => l.fontFamily === 'Roboto')
      expect(robotoLeaf).toBeDefined()
      expect(robotoLeaf!.text).toBe('Hello')
    })

    it('HTML content 中带引号的 font-family 被清理', () => {
      const el = makeTextElement({
        id: 'txt-3',
        content: '<span style="font-family: \'Source Han Sans\', sans-serif">测试</span>',
        defaultFontName: 'Arial',
      })

      const objects = adaptElementsToSceneObjects([el])

      const root = objects['txt-3'].content as { children: { children: { text: string; fontFamily?: string }[] }[] }
      const leaves = root.children[0].children
      const leaf = leaves.find((l) => l.text === '测试')
      expect(leaf).toBeDefined()
      // 应该去掉引号并只取第一个字体
      expect(leaf!.fontFamily).toBe('Source Han Sans')
    })

    it('<strong> 标签识别为 bold', () => {
      const el = makeTextElement({
        id: 'txt-bold-1',
        content: '<strong>粗体文字</strong>',
        defaultFontName: 'Arial',
      })

      const objects = adaptElementsToSceneObjects([el])

      const root = objects['txt-bold-1'].content as { children: { children: { text: string; fontWeight?: string }[] }[] }
      const leaves = root.children[0].children
      const boldLeaf = leaves.find((l) => l.text === '粗体文字')
      expect(boldLeaf).toBeDefined()
      expect(boldLeaf!.fontWeight).toBe('bold')
    })

    it('<b> 标签识别为 bold', () => {
      const el = makeTextElement({
        id: 'txt-bold-2',
        content: '<b>另一种粗体</b>',
        defaultFontName: 'Arial',
      })

      const objects = adaptElementsToSceneObjects([el])

      const root = objects['txt-bold-2'].content as { children: { children: { text: string; fontWeight?: string }[] }[] }
      const leaves = root.children[0].children
      const boldLeaf = leaves.find((l) => l.text === '另一种粗体')
      expect(boldLeaf).toBeDefined()
      expect(boldLeaf!.fontWeight).toBe('bold')
    })

    it('<em> 标签识别为 italic', () => {
      const el = makeTextElement({
        id: 'txt-italic-1',
        content: '<em>斜体文字</em>',
        defaultFontName: 'Arial',
      })

      const objects = adaptElementsToSceneObjects([el])

      const root = objects['txt-italic-1'].content as { children: { children: { text: string; fontStyle?: string }[] }[] }
      const leaves = root.children[0].children
      const italicLeaf = leaves.find((l) => l.text === '斜体文字')
      expect(italicLeaf).toBeDefined()
      expect(italicLeaf!.fontStyle).toBe('italic')
    })

    it('<i> 标签识别为 italic', () => {
      const el = makeTextElement({
        id: 'txt-italic-2',
        content: '<i>另一种斜体</i>',
        defaultFontName: 'Arial',
      })

      const objects = adaptElementsToSceneObjects([el])

      const root = objects['txt-italic-2'].content as { children: { children: { text: string; fontStyle?: string }[] }[] }
      const leaves = root.children[0].children
      const italicLeaf = leaves.find((l) => l.text === '另一种斜体')
      expect(italicLeaf).toBeDefined()
      expect(italicLeaf!.fontStyle).toBe('italic')
    })

    it('纯文本 content（无 HTML 标签）回退到 defaultFontName', () => {
      const el = makeTextElement({
        id: 'txt-plain',
        content: '纯文本内容',
        defaultFontName: 'PingFang SC',
      })

      const objects = adaptElementsToSceneObjects([el])

      const root = objects['txt-plain'].content as { children: { children: { text: string; fontFamily?: string }[] }[] }
      const leaves = root.children[0].children
      expect(leaves.length).toBe(1)
      expect(leaves[0].text).toBe('纯文本内容')
      expect(leaves[0].fontFamily).toBe('PingFang SC')
    })

    it('name 字段被传递到 SceneObject', () => {
      const el = makeTextElement({
        id: 'txt-named',
        content: '文字',
        defaultFontName: 'Arial',
        name: '标题文本框',
      })

      const objects = adaptElementsToSceneObjects([el])
      expect(objects['txt-named'].name).toBe('标题文本框')
    })
  })

  describe('PPTShapeElement', () => {
    it('有文本的形状：text.content 和 text.defaultFontName 被提取', () => {
      const el = makeShapeElement({
        id: 'shape-1',
        text: {
          content: '<p>形状内文字</p>',
          defaultFontName: 'Microsoft YaHei',
        },
      })

      const objects = adaptElementsToSceneObjects([el])

      expect(objects['shape-1']).toBeDefined()
      expect(objects['shape-1'].type).toBe('text')
      expect(objects['shape-1'].fontFamily).toBe('Microsoft YaHei')
    })

    it('无文本的形状安全跳过', () => {
      const el = makeShapeElement({
        id: 'shape-no-text',
      })

      const objects = adaptElementsToSceneObjects([el])
      expect(objects['shape-no-text']).toBeUndefined()
    })

    it('text.content 为空字符串时跳过', () => {
      const el = makeShapeElement({
        id: 'shape-empty-text',
        text: {
          content: '',
          defaultFontName: 'Arial',
        },
      })

      const objects = adaptElementsToSceneObjects([el])
      expect(objects['shape-empty-text']).toBeUndefined()
    })
  })

  describe('PPTTableElement', () => {
    it('每个 cell 的 style.fontName 被提取', () => {
      const el = makeTableElement({
        id: 'table-1',
        data: [
          [
            { id: 'c1', text: '单元格1', colspan: 1, rowspan: 1, style: { fontName: 'SimSun' } },
            { id: 'c2', text: '单元格2', colspan: 1, rowspan: 1, style: { fontName: 'SimHei' } },
          ],
        ],
      })

      const objects = adaptElementsToSceneObjects([el])

      // 合成 ID 格式：{elementId}__r{row}c{col}
      expect(objects['table-1__r0c0']).toBeDefined()
      expect(objects['table-1__r0c0'].fontFamily).toBe('SimSun')

      expect(objects['table-1__r0c1']).toBeDefined()
      expect(objects['table-1__r0c1'].fontFamily).toBe('SimHei')
    })

    it('style.fontFamily（旧字段）作为 fallback', () => {
      const el = makeTableElement({
        id: 'table-compat',
        data: [
          [
            { id: 'c1', text: '旧数据', colspan: 1, rowspan: 1, style: { fontFamily: 'KaiTi' } },
          ],
        ],
      })

      const objects = adaptElementsToSceneObjects([el])

      expect(objects['table-compat__r0c0']).toBeDefined()
      expect(objects['table-compat__r0c0'].fontFamily).toBe('KaiTi')
    })

    it('fontName 优先于 fontFamily', () => {
      const el = makeTableElement({
        id: 'table-priority',
        data: [
          [
            {
              id: 'c1',
              text: '优先级',
              colspan: 1,
              rowspan: 1,
              style: { fontName: 'SimSun', fontFamily: 'SimHei' },
            },
          ],
        ],
      })

      const objects = adaptElementsToSceneObjects([el])
      expect(objects['table-priority__r0c0'].fontFamily).toBe('SimSun')
    })

    it('cell.richText 优先于 cell.text 作为文本内容', () => {
      const el = makeTableElement({
        id: 'table-rich',
        data: [
          [
            {
              id: 'c1',
              text: '纯文本',
              richText: '<span style="font-family: Roboto">富文本</span>',
              colspan: 1,
              rowspan: 1,
              style: {},
            },
          ],
        ],
      })

      const objects = adaptElementsToSceneObjects([el])

      // 应该使用 richText 而非 text
      const root = objects['table-rich__r0c0'].content as { children: { children: { text: string }[] }[] }
      const leaves = root.children[0].children
      const richLeaf = leaves.find((l) => l.text === '富文本')
      expect(richLeaf).toBeDefined()
    })

    it('cell.style.bold 和 italic 映射到 fontWeight/fontStyle', () => {
      const el = makeTableElement({
        id: 'table-style',
        data: [
          [
            {
              id: 'c1',
              text: '粗斜体',
              colspan: 1,
              rowspan: 1,
              style: { bold: true, italic: true },
            },
          ],
        ],
      })

      const objects = adaptElementsToSceneObjects([el])

      expect(objects['table-style__r0c0'].fontWeight).toBe('bold')
      expect(objects['table-style__r0c0'].fontStyle).toBe('italic')
    })

    it('空 cell 安全跳过', () => {
      const el = makeTableElement({
        id: 'table-empty',
        data: [
          [
            null as any,
            { id: 'c2', text: '', colspan: 1, rowspan: 1 },
          ],
        ],
      })

      const objects = adaptElementsToSceneObjects([el])

      // null cell 被跳过，空文本 cell 也被跳过
      expect(objects['table-empty__r0c0']).toBeUndefined()
      expect(objects['table-empty__r0c1']).toBeUndefined()
    })
  })

  describe('非文本元素安全跳过', () => {
    it('image 元素被跳过', () => {
      const el = { id: 'img-1', type: 'image', x: 0, y: 0, width: 100, height: 100 } as any as PPTElement
      const objects = adaptElementsToSceneObjects([el])
      expect(objects['img-1']).toBeUndefined()
    })

    it('line 元素被跳过', () => {
      const el = { id: 'line-1', type: 'line', x: 0, y: 0, width: 100, height: 100 } as any as PPTElement
      const objects = adaptElementsToSceneObjects([el])
      expect(objects['line-1']).toBeUndefined()
    })

    it('chart 元素被跳过', () => {
      const el = { id: 'chart-1', type: 'chart', x: 0, y: 0, width: 100, height: 100 } as any as PPTElement
      const objects = adaptElementsToSceneObjects([el])
      expect(objects['chart-1']).toBeUndefined()
    })

    it('video 元素被跳过', () => {
      const el = { id: 'video-1', type: 'video', x: 0, y: 0, width: 100, height: 100 } as any as PPTElement
      const objects = adaptElementsToSceneObjects([el])
      expect(objects['video-1']).toBeUndefined()
    })

    it('混合元素列表中非文本元素不影响结果', () => {
      const elements: PPTElement[] = [
        { id: 'img-1', type: 'image', x: 0, y: 0, width: 100, height: 100 } as any,
        makeTextElement({ id: 'txt-1', content: '文字', defaultFontName: 'Arial' }),
        { id: 'line-1', type: 'line', x: 0, y: 0, width: 100, height: 100 } as any,
      ]

      const objects = adaptElementsToSceneObjects(elements)
      expect(Object.keys(objects)).toEqual(['txt-1'])
    })
  })
})

// ---------------------------------------------------------------------------
// scanSlideFonts（端到端）
// ---------------------------------------------------------------------------

describe('scanSlideFonts', () => {
  it('混合元素列表返回正确的 ScanResult', () => {
    const elements: PPTElement[] = [
      makeTextElement({
        id: 'txt-1',
        content: '<span style="font-family: Roboto">English text</span>',
        defaultFontName: 'Roboto',
      }),
      makeShapeElement({
        id: 'shape-1',
        text: {
          content: '<p>Shape text</p>',
          defaultFontName: 'Lato',
        },
      }),
      makeTableElement({
        id: 'table-1',
        data: [
          [
            { id: 'c1', text: 'Cell', colspan: 1, rowspan: 1, style: { fontName: 'Montserrat' } },
          ],
        ],
      }),
      // 非文本元素应被跳过
      { id: 'img-1', type: 'image', x: 0, y: 0, width: 100, height: 100 } as any,
    ]

    const result = scanSlideFonts(elements)

    expect(result).toBeDefined()
    expect(result.fonts).toBeInstanceOf(Map)
    // 扫描结果应该包含字体（具体哪些取决于 resolveFontFamily mock 的返回）
    expect(result.allText).toContain('English text')
    expect(result.allText).toContain('Shape text')
    expect(result.allText).toContain('Cell')
  })

  it('包含 CJK 字符时 hasCjk 为 true', () => {
    const elements: PPTElement[] = [
      makeTextElement({
        id: 'txt-cjk',
        content: '你好世界',
        defaultFontName: 'Noto Sans SC',
      }),
    ]

    const result = scanSlideFonts(elements)

    expect(result.hasCjk).toBe(true)
    expect(result.allText).toContain('你好世界')
  })

  it('纯英文内容时 hasCjk 为 false', () => {
    const elements: PPTElement[] = [
      makeTextElement({
        id: 'txt-en',
        content: 'Hello World',
        defaultFontName: 'Roboto',
      }),
    ]

    const result = scanSlideFonts(elements)

    expect(result.hasCjk).toBe(false)
  })

  it('空元素列表返回空结果', () => {
    const result = scanSlideFonts([])

    expect(result.fonts.size).toBe(0)
    expect(result.allText).toBe('')
    expect(result.hasCjk).toBe(false)
  })
})
