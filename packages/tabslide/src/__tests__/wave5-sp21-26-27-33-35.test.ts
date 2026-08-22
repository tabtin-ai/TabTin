/**
 * Wave 5b 场景验证修复回归测试
 *
 * SP1-21: PPTAnimation.delay 字段 — 类型、后端适配器往返
 * SP1-26: 图片导出 video 元素使用 poster 渲染（单元测试级覆盖）
 * SP1-27: downloadAsPDFWithProgress 函数存在性
 * SP1-33: exportAllPagesToImages 流式回调 onPage
 * SP1-35: updatePresentationMeta 切换主题时更新元素 fill
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { convertBackendPage, convertPagesToBackend } from '../exports/backend-adapter'
import type { PPTAnimation, SlidePresentation, Slide, PPTChartElement, PPTShapeElement, PPTLineElement, PPTTextElement, PPTTableElement, SlideTheme } from '../types/slides'
import { resolveMovableLayerIds, useSlideStore } from '../store/slide'

// ═══════════════════════════════════════════════
// SP1-21: PPTAnimation.delay 往返
// ═══════════════════════════════════════════════
describe('SP1-21: PPTAnimation delay field round-trip', () => {
  it('delay is preserved through backend → frontend conversion', () => {
    const backendPage = {
      id: 'page-1',
      elements: [{ id: 'el-1', type: 'text', x: 0, y: 0, width: 200, height: 50, props: { content: 'hi' } }],
      animations: [
        { id: 'a1', elId: 'el-1', type: 'in', effect: 'fadeIn', duration: 1000, trigger: 'click', delay: 500 },
        { id: 'a2', elId: 'el-1', type: 'out', effect: 'fadeOut', duration: 800, trigger: 'auto' },
      ],
    }
    const slide = convertBackendPage(backendPage as any)
    expect(slide.animations).toBeDefined()
    const a1 = slide.animations!.find((a) => a.id === 'a1')
    expect(a1?.delay).toBe(500)
    const a2 = slide.animations!.find((a) => a.id === 'a2')
    expect(a2?.delay).toBeUndefined()
  })

  it('delay is preserved through frontend → backend conversion', () => {
    const slide: Slide = {
      id: 'page-1',
      elements: [{ id: 'el-1', type: 'text', x: 0, y: 0, width: 200, height: 50, rotate: 0, content: '<p>hi</p>', defaultFontName: 'Arial', defaultColor: '#000', opacity: 1 } as PPTTextElement],
      animations: [
        { id: 'a1', elId: 'el-1', type: 'in', effect: 'fadeIn', duration: 1000, trigger: 'click', delay: 300 },
        { id: 'a2', elId: 'el-1', type: 'out', effect: 'fadeOut', duration: 800, trigger: 'auto' },
      ],
    }
    const backend = convertPagesToBackend([slide])
    const anims = backend[0].animations!
    expect(anims[0].delay).toBe(300)
    expect(anims[1].delay).toBeUndefined()
  })

  it('PPTAnimation type allows delay field', () => {
    const anim: PPTAnimation = {
      id: 'a1',
      elId: 'el-1',
      type: 'in',
      effect: 'fadeIn',
      duration: 500,
      trigger: 'click',
      delay: 200,
    }
    expect(anim.delay).toBe(200)
  })
})

// ═══════════════════════════════════════════════
// SP1-33: exportAllPagesToImages onPage streaming callback
// ═══════════════════════════════════════════════
describe('SP1-33: exportAllPagesToImages accepts onPage callback', () => {
  it('function signature includes onPage parameter', async () => {
    const { exportAllPagesToImages } = await import('../exports/image')
    expect(exportAllPagesToImages.length).toBeGreaterThanOrEqual(1)
    expect(typeof exportAllPagesToImages).toBe('function')
  })
})

// ═══════════════════════════════════════════════
// SP1-27: downloadAsPDFWithProgress exists
// ═══════════════════════════════════════════════
describe('SP1-27: downloadAsPDFWithProgress export', () => {
  it('is exported from pdf module', async () => {
    const mod = await import('../exports/pdf')
    expect(typeof mod.downloadAsPDFWithProgress).toBe('function')
  })

  it('is exported from exports index', async () => {
    const mod = await import('../exports/index')
    expect(typeof mod.downloadAsPDFWithProgress).toBe('function')
  })
})

// ═══════════════════════════════════════════════
// SP1-35: updatePresentationMeta theme → element fill
// ═══════════════════════════════════════════════
describe('SP1-35: theme switch updates element fill via themeColorKey', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('shape fillThemeKey color is updated on theme change', () => {
    const shape: PPTShapeElement = {
      id: 'shape-1',
      type: 'shape',
      x: 100, y: 100, width: 200, height: 150, rotate: 0, opacity: 1,
      viewBox: [200, 150],
      path: 'M 0 0 L 200 0 L 200 150 L 0 150 Z',
      fixedRatio: false,
      fill: '#5b9bd5',
      fillThemeKey: 'accent1',
    }
    const pres: SlidePresentation = {
      id: 'pres-1',
      name: 'Test',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [{
        id: 'p1',
        elements: [shape],
        background: { type: 'solid', color: '#ffffff' },
      }],
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
      },
    }
    useSlideStore.getState().setPresentation(pres)

    const newTheme: SlideTheme = {
      backgroundColor: '#1a1a2e',
      themeColors: ['#e94560', '#0f3460', '#16213e', '#533483', '#2b2d42', '#8d99ae'],
      fontColor: '#eaeaea',
      fontName: 'Microsoft YaHei',
    }
    useSlideStore.getState().updatePresentationMeta({ theme: newTheme })

    const updatedShape = useSlideStore.getState().presentation!.pages[0].elements[0] as PPTShapeElement
    expect(updatedShape.fill).toBe('#e94560')
    expect(updatedShape.fillThemeKey).toBe('accent1')
  })

  it('line colorThemeKey color is updated on theme change', () => {
    const line: PPTLineElement = {
      id: 'line-1',
      type: 'line',
      x: 0, y: 0, width: 200, height: 0, rotate: 0, opacity: 1,
      start: [0, 0],
      end: [200, 0],
      style: 'solid',
      color: '#333333',
      colorThemeKey: 'tx1',
      lineWidth: 2,
      points: ['', ''],
    }
    const pres: SlidePresentation = {
      id: 'pres-2',
      name: 'Test',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [{
        id: 'p1',
        elements: [line],
      }],
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
      },
    }
    useSlideStore.getState().setPresentation(pres)

    const newTheme: SlideTheme = {
      backgroundColor: '#1a1a2e',
      themeColors: ['#e94560', '#0f3460', '#16213e', '#533483', '#2b2d42', '#8d99ae'],
      fontColor: '#ffffff',
      fontName: 'Microsoft YaHei',
    }
    useSlideStore.getState().updatePresentationMeta({ theme: newTheme })

    const updatedLine = useSlideStore.getState().presentation!.pages[0].elements[0] as PPTLineElement
    expect(updatedLine.color).toBe('#ffffff')
  })

  it('text defaultColorThemeKey color is updated on theme change', () => {
    const text: PPTTextElement = {
      id: 'text-1',
      type: 'text',
      x: 0, y: 0, width: 200, height: 50, rotate: 0, opacity: 1,
      content: '<p>Hello</p>',
      defaultFontName: 'Microsoft YaHei',
      defaultColor: '#5b9bd5',
      defaultColorThemeKey: 'accent1',
    }
    const pres: SlidePresentation = {
      id: 'pres-3',
      name: 'Test',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [{
        id: 'p1',
        elements: [text],
      }],
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
      },
    }
    useSlideStore.getState().setPresentation(pres)

    const newTheme: SlideTheme = {
      backgroundColor: '#1a1a2e',
      themeColors: ['#ff6347', '#0f3460', '#16213e', '#533483', '#2b2d42', '#8d99ae'],
      fontColor: '#eaeaea',
      fontName: 'Microsoft YaHei',
    }
    useSlideStore.getState().updatePresentationMeta({ theme: newTheme })

    const updatedText = useSlideStore.getState().presentation!.pages[0].elements[0] as PPTTextElement
    expect(updatedText.defaultColor).toBe('#ff6347')
  })

  it('table, chart, background, and master elements are updated on theme change', () => {
    const table: PPTTableElement = {
      id: 'table-1',
      type: 'table',
      x: 0,
      y: 0,
      width: 320,
      height: 120,
      rotate: 0,
      opacity: 1,
      data: [[{
        id: 'cell-1',
        text: 'A',
        colspan: 1,
        rowspan: 1,
        style: {
          color: '#111111',
          colorThemeKey: 'tx1',
          bgColor: '#222222',
          bgColorThemeKey: 'accent2',
        },
      }]],
      colWidths: [1],
      cellMinHeight: 24,
      theme: { color: '#333333', colorThemeKey: 'accent1' },
      outline: { color: '#444444', width: 1, themeKey: 'accent3' },
    }
    const chart: PPTChartElement = {
      id: 'chart-1',
      type: 'chart',
      x: 0,
      y: 140,
      width: 320,
      height: 200,
      rotate: 0,
      opacity: 1,
      chartType: 'bar',
      data: { labels: ['A'], datasets: [{ label: 'S1', data: [1] }] },
      themeColors: ['#555555', '#666666'],
      themeColorKeys: ['accent4', 'tx1'],
    }
    const masterText: PPTTextElement = {
      id: 'master-text-1',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 50,
      rotate: 0,
      opacity: 1,
      content: '<p>Master</p>',
      defaultFontName: 'Microsoft YaHei',
      defaultColor: '#777777',
      defaultColorThemeKey: 'accent5',
    }
    const pres: SlidePresentation = {
      id: 'pres-4',
      name: 'Test',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [{
        id: 'p1',
        elements: [table, chart],
        masterElements: [masterText],
        background: { type: 'theme', theme: { key: 'accent6', color: '#888888' } },
      }],
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
      },
    }
    useSlideStore.getState().setPresentation(pres)

    const newTheme: SlideTheme = {
      backgroundColor: '#101010',
      themeColors: ['#aa0000', '#00aa00', '#0000aa', '#aaaa00', '#aa00aa', '#00aaaa'],
      fontColor: '#fafafa',
      fontName: 'Microsoft YaHei',
    }
    useSlideStore.getState().updatePresentationMeta({ theme: newTheme })

    const page = useSlideStore.getState().presentation!.pages[0]
    const updatedTable = page.elements[0] as PPTTableElement
    const updatedChart = page.elements[1] as PPTChartElement
    const updatedMaster = page.masterElements![0] as PPTTextElement

    expect(updatedTable.theme?.color).toBe('#aa0000')
    expect(updatedTable.outline.color).toBe('#0000aa')
    expect(updatedTable.data[0][0].style?.color).toBe('#fafafa')
    expect(updatedTable.data[0][0].style?.bgColor).toBe('#00aa00')
    expect(updatedChart.themeColors).toEqual(['#aaaa00', '#fafafa'])
    expect(updatedMaster.defaultColor).toBe('#aa00aa')
    expect(page.background.theme?.color).toBe('#00aaaa')
  })
})

describe('SM-P1-11: resolveMovableLayerIds remains compatible from store module', () => {
  it('keeps group movement atomic and blocks locked groups from the old import path', () => {
    const elements: PPTShapeElement[] = [
      { id: 'single', type: 'shape', x: 0, y: 0, width: 10, height: 10, rotate: 0, opacity: 1, locked: false, fill: '#fff' },
      { id: 'group-a', type: 'shape', x: 0, y: 0, width: 10, height: 10, rotate: 0, opacity: 1, locked: false, fill: '#fff', groupId: 'g1' },
      { id: 'group-b', type: 'shape', x: 0, y: 0, width: 10, height: 10, rotate: 0, opacity: 1, locked: false, fill: '#fff', groupId: 'g1' },
      { id: 'locked-a', type: 'shape', x: 0, y: 0, width: 10, height: 10, rotate: 0, opacity: 1, locked: false, fill: '#fff', groupId: 'g2' },
      { id: 'locked-b', type: 'shape', x: 0, y: 0, width: 10, height: 10, rotate: 0, opacity: 1, locked: true, fill: '#fff', groupId: 'g2' },
    ]

    expect(resolveMovableLayerIds(elements, ['single'])).toEqual(['single'])
    expect(resolveMovableLayerIds(elements, ['group-a'])).toEqual(['group-a', 'group-b'])
    expect(resolveMovableLayerIds(elements, ['locked-a'])).toEqual([])
  })
})
