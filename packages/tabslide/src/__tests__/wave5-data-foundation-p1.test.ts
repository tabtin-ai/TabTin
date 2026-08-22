/**
 * 回归测试 — Wave 5 数据基座 P1 修复
 *
 * DF-06: PPTVideoElement/PPTAudioElement 类型声明 shadow 字段
 * DF-07: PPTVideoElement 增加 loop 字段 + backend-adapter 双向序列化
 * DF-10: factory.ts 补全 6 种工厂函数
 */
import { describe, it, expect } from 'vitest'
import { convertBackendPage, convertPagesToBackend } from '../exports/backend-adapter'
import {
  createChartElement,
  createLatexElement,
  createVideoElement,
  createAudioElement,
  createCanvasElement,
  createEllipseShape,
} from '../utils/factory'
import type {
  PPTVideoElement,
  PPTAudioElement,
  PPTElementShadow,
  Slide,
} from '../types/slides'

// ═══════════════════════════════════════════════
// DF-06: shadow 类型声明一致性
// ═══════════════════════════════════════════════

describe('DF-06: Video/Audio 元素 shadow 类型声明', () => {
  const shadow: PPTElementShadow = {
    h: 4,
    v: 4,
    blur: 8,
    color: '#000000',
    opacity: 0.3,
  }

  it('PPTVideoElement 应支持 shadow 可选字段', () => {
    const video: PPTVideoElement = {
      id: 'v1',
      type: 'video',
      x: 0, y: 0, width: 320, height: 180, rotate: 0, opacity: 1, locked: false,
      src: 'test.mp4',
      autoplay: false,
      shadow,
    }
    expect(video.shadow).toBeDefined()
    expect(video.shadow!.blur).toBe(8)
  })

  it('PPTAudioElement 应支持 shadow 可选字段', () => {
    const audio: PPTAudioElement = {
      id: 'a1',
      type: 'audio',
      x: 0, y: 0, width: 140, height: 48, rotate: 0, opacity: 1, locked: false,
      src: 'test.mp3',
      color: '#666666',
      fixedRatio: true,
      loop: false,
      autoplay: false,
      shadow,
    }
    expect(audio.shadow).toBeDefined()
    expect(audio.shadow!.opacity).toBe(0.3)
  })

  it('后端 Video 带 shadow 数据应正确反序列化', () => {
    const backendPage = {
      id: 'page-1',
      elements: [
        {
          id: 'v1',
          type: 'video',
          x: 0, y: 0, width: 320, height: 180, rotate: 0, opacity: 1, locked: false,
          shadow: { h: 4, v: 4, blur: 8, color: '#000000', opacity: 0.3 },
          props: { src: 'test.mp4', autoplay: false },
        },
      ],
    }
    const page = convertBackendPage(backendPage as any)
    const el = page.elements[0] as PPTVideoElement
    expect(el.type).toBe('video')
    expect(el.shadow).toBeDefined()
    expect(el.shadow!.blur).toBe(8)
  })

  it('后端 Audio 带 shadow 数据应正确反序列化', () => {
    const backendPage = {
      id: 'page-1',
      elements: [
        {
          id: 'a1',
          type: 'audio',
          x: 0, y: 0, width: 140, height: 48, rotate: 0, opacity: 1, locked: false,
          shadow: { h: 4, v: 4, blur: 8, color: '#333333', opacity: 0.5 },
          props: { src: 'test.mp3', color: '#666666', fixedRatio: true, loop: false, autoplay: false },
        },
      ],
    }
    const page = convertBackendPage(backendPage as any)
    const el = page.elements[0] as PPTAudioElement
    expect(el.type).toBe('audio')
    expect(el.shadow).toBeDefined()
    expect(el.shadow!.color).toBe('#333333')
  })
})

// ═══════════════════════════════════════════════
// DF-07: Video loop 字段双向序列化
// ═══════════════════════════════════════════════

describe('DF-07: PPTVideoElement loop 字段', () => {
  it('后端 loop=true 应正确反序列化到前端', () => {
    const backendPage = {
      id: 'page-1',
      elements: [
        {
          id: 'v1',
          type: 'video',
          x: 0, y: 0, width: 320, height: 180, rotate: 0, opacity: 1, locked: false,
          props: { src: 'test.mp4', autoplay: false, loop: true },
        },
      ],
    }
    const page = convertBackendPage(backendPage as any)
    const el = page.elements[0] as PPTVideoElement
    expect(el.loop).toBe(true)
  })

  it('后端无 loop 字段时默认为 false（不输出）', () => {
    const backendPage = {
      id: 'page-1',
      elements: [
        {
          id: 'v1',
          type: 'video',
          x: 0, y: 0, width: 320, height: 180, rotate: 0, opacity: 1, locked: false,
          props: { src: 'test.mp4', autoplay: false },
        },
      ],
    }
    const page = convertBackendPage(backendPage as any)
    const el = page.elements[0] as PPTVideoElement
    expect(el.loop).toBeFalsy()
  })

  it('前端 loop=true 应序列化到后端 props', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [
        {
          id: 'v1',
          type: 'video',
          x: 0, y: 0, width: 320, height: 180, rotate: 0, opacity: 1, locked: false,
          src: 'test.mp4',
          autoplay: false,
          loop: true,
        } as PPTVideoElement,
      ],
    }
    const [backendPage] = convertPagesToBackend([page])
    const el = backendPage.elements[0]
    expect(el.props!.loop).toBe(true)
  })

  it('前端 loop=false 时不输出到后端（减少冗余）', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [
        {
          id: 'v1',
          type: 'video',
          x: 0, y: 0, width: 320, height: 180, rotate: 0, opacity: 1, locked: false,
          src: 'test.mp4',
          autoplay: false,
          loop: false,
        } as PPTVideoElement,
      ],
    }
    const [backendPage] = convertPagesToBackend([page])
    const el = backendPage.elements[0]
    expect(el.props!.loop).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════
// DF-10: factory 工厂函数
// ═══════════════════════════════════════════════

describe('DF-10: 补全工厂函数', () => {
  it('createChartElement 应生成合法的图表元素', () => {
    const el = createChartElement()
    expect(el.type).toBe('chart')
    expect(el.chartType).toBe('bar')
    expect(el.data.labels).toHaveLength(3)
    expect(el.data.legends).toHaveLength(1)
    expect(el.data.series).toHaveLength(1)
    expect(el.themeColors).toHaveLength(1)
    expect(el.id).toMatch(/^el_/)
    expect(el.width).toBeGreaterThan(0)
    expect(el.height).toBeGreaterThan(0)
  })

  it('createChartElement 应支持 overrides', () => {
    const el = createChartElement({ chartType: 'pie', width: 600 })
    expect(el.chartType).toBe('pie')
    expect(el.width).toBe(600)
  })

  it('createLatexElement 应生成合法的 LaTeX 元素', () => {
    const el = createLatexElement()
    expect(el.type).toBe('latex')
    expect(el.latex).toBe('E = mc^2')
    expect(el.color).toBeTruthy()
    expect(el.strokeWidth).toBe(2)
    expect(el.fixedRatio).toBe(true)
    expect(el.id).toMatch(/^el_/)
  })

  it('createLatexElement 应接受自定义 LaTeX 源码', () => {
    const el = createLatexElement('\\int_0^1 x^2 dx')
    expect(el.latex).toBe('\\int_0^1 x^2 dx')
  })

  it('createVideoElement 应生成合法的视频元素', () => {
    const el = createVideoElement('https://example.com/video.mp4')
    expect(el.type).toBe('video')
    expect(el.src).toBe('https://example.com/video.mp4')
    expect(el.autoplay).toBe(false)
    expect(el.id).toMatch(/^el_/)
    expect(el.width).toBe(640)
    expect(el.height).toBe(360)
  })

  it('createAudioElement 应生成合法的音频元素', () => {
    const el = createAudioElement('https://example.com/audio.mp3')
    expect(el.type).toBe('audio')
    expect(el.src).toBe('https://example.com/audio.mp3')
    expect(el.loop).toBe(false)
    expect(el.autoplay).toBe(false)
    expect(el.color).toBe('#666666')
    expect(el.fixedRatio).toBe(true)
    expect(el.id).toMatch(/^el_/)
  })

  it('createCanvasElement 应生成合法的画布元素', () => {
    const el = createCanvasElement('canvas-123')
    expect(el.type).toBe('canvas')
    expect(el.canvasId).toBe('canvas-123')
    expect(el.id).toMatch(/^el_/)
    expect(el.width).toBeGreaterThan(0)
    expect(el.height).toBeGreaterThan(0)
  })

  it('createEllipseShape 应生成合法的椭圆形状', () => {
    const el = createEllipseShape()
    expect(el.type).toBe('shape')
    expect(el.pptxShapeType).toBe('ellipse')
    expect(el.path).toContain('A')
    expect(el.viewBox).toEqual([200, 200])
    expect(el.id).toMatch(/^el_/)
  })

  it('createEllipseShape 应支持 overrides', () => {
    const el = createEllipseShape({ fill: '#ff0000', width: 300 })
    expect(el.fill).toBe('#ff0000')
    expect(el.width).toBe(300)
  })

  it('所有工厂函数生成的 ID 应唯一', () => {
    const ids = [
      createChartElement().id,
      createLatexElement().id,
      createVideoElement('a').id,
      createAudioElement('b').id,
      createCanvasElement('c').id,
      createEllipseShape().id,
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
