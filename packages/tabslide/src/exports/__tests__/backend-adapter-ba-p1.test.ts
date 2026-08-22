/**
 * 回归测试 — BA-P1-01 / BA-P1-02 / BA-P1-03
 *
 * BA-P1-01: LaTeX 元素 fromBackend 丢失 flipH/flipV
 * BA-P1-02: Shadow 颜色 hex→rgba 单向转换导致 PPTX 导出异常
 * BA-P1-03: normalizeOutline 静默丢弃 lineCap/lineJoin
 */
import { describe, it, expect } from 'vitest'
import {
  convertBackendElement,
  convertBackendPage,
  convertPagesToBackend,
  type BackendSlideElement,
  type BackendSlidePage,
} from '../backend-adapter'
import type {
  PPTLatexElement,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  Slide,
} from '../../types/slides'

function encodeLatexAltText(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  return `TABSLIDE_LATEX_V1:${b64}`
}

// ═══════════════════════════════════════════════
// BA-P1-01: LaTeX flipH/flipV 往返保持
// ═══════════════════════════════════════════════

describe('BA-P1-01: LaTeX 元素 flipH/flipV 往返', () => {
  const makeLatexBackendElement = (flip: { flipH?: boolean; flipV?: boolean }): BackendSlideElement => ({
    id: 'latex-1',
    type: 'latex',
    x: 100,
    y: 200,
    width: 320,
    height: 96,
    rotate: 0,
    zIndex: 0,
    ...flip,
    props: {
      latex: 'E = mc^2',
      color: '#111827',
      svg: '<svg></svg>',
    },
  })

  const makeLatexAsImageBackendElement = (flip: { flipH?: boolean; flipV?: boolean }): BackendSlideElement => ({
    id: 'latex-img-1',
    type: 'image',
    x: 50,
    y: 60,
    width: 200,
    height: 80,
    rotate: 0,
    zIndex: 0,
    ...flip,
    props: {
      src: 'data:image/png;base64,abc',
      altText: encodeLatexAltText({ latex: 'x^2', svg: '<svg></svg>' }),
    },
  })

  it('convertLatexElement 应保留 flipH=true', () => {
    const el = convertBackendElement(makeLatexBackendElement({ flipH: true }))
    expect(el).not.toBeNull()
    expect(el!.type).toBe('latex')
    expect((el as PPTLatexElement).flipH).toBe(true)
    expect((el as PPTLatexElement).flipV).toBeUndefined()
  })

  it('convertLatexElement 应保留 flipV=true', () => {
    const el = convertBackendElement(makeLatexBackendElement({ flipV: true }))
    expect(el).not.toBeNull()
    expect((el as PPTLatexElement).flipV).toBe(true)
    expect((el as PPTLatexElement).flipH).toBeUndefined()
  })

  it('convertLatexElement 应同时保留 flipH 和 flipV', () => {
    const el = convertBackendElement(makeLatexBackendElement({ flipH: true, flipV: true }))
    expect(el).not.toBeNull()
    expect((el as PPTLatexElement).flipH).toBe(true)
    expect((el as PPTLatexElement).flipV).toBe(true)
  })

  it('tryConvertLatexFromImage 应保留 flipH/flipV', () => {
    const el = convertBackendElement(makeLatexAsImageBackendElement({ flipH: true, flipV: true }))
    expect(el).not.toBeNull()
    expect(el!.type).toBe('latex')
    expect((el as PPTLatexElement).flipH).toBe(true)
    expect((el as PPTLatexElement).flipV).toBe(true)
  })

  it('无翻转时 flipH/flipV 不应出现在结果中', () => {
    const el = convertBackendElement(makeLatexBackendElement({}))
    expect(el).not.toBeNull()
    expect((el as PPTLatexElement).flipH).toBeUndefined()
    expect((el as PPTLatexElement).flipV).toBeUndefined()
  })

  it('全链路往返：LaTeX flipH/flipV 保存后加载不丢失', () => {
    const page: Slide = {
      id: 'page-flip',
      elements: [{
        id: 'latex-rt',
        type: 'latex',
        x: 10,
        y: 20,
        width: 300,
        height: 80,
        rotate: 0,
        opacity: 1,
        latex: 'a^2 + b^2 = c^2',
        color: '#000',
        strokeWidth: 0,
        fixedRatio: true,
        flipH: true,
        flipV: true,
      } as PPTLatexElement],
      background: { type: 'solid', value: '#fff' },
    }

    const [backendPage] = convertPagesToBackend([page])
    const beEl = backendPage.elements[0]
    expect(beEl.flipH).toBe(true)
    expect(beEl.flipV).toBe(true)

    const restored = convertBackendPage(backendPage)
    const restoredEl = restored.elements[0] as PPTLatexElement
    expect(restoredEl.flipH).toBe(true)
    expect(restoredEl.flipV).toBe(true)
  })
})

// ═══════════════════════════════════════════════
// BA-P1-02: Shadow 颜色格式往返保持
// ═══════════════════════════════════════════════

describe('BA-P1-02: Shadow 颜色 hex 格式保持', () => {
  const makeTextWithShadow = (shadow: Record<string, unknown>): BackendSlidePage => ({
    id: 'page-shadow',
    elements: [{
      id: 'text-shadow',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 50,
      rotate: 0,
      zIndex: 0,
      shadow,
      props: {
        content: '<p>hello</p>',
        defaultFontFamily: 'Arial',
        defaultColor: '#000',
      },
    }],
    background: { type: 'color', value: '#ffffff' },
  })

  it('fromBackend 应保持 hex 颜色不转 rgba', () => {
    const page = convertBackendPage(makeTextWithShadow({
      h: 2, v: 3, blur: 5, color: '#ff0000', opacity: 0.5,
    }))
    const el = page.elements[0] as PPTTextElement
    expect(el.shadow).toBeDefined()
    expect(el.shadow!.color).toBe('#ff0000')
    expect(el.shadow!.opacity).toBe(0.5)
  })

  it('hex 颜色往返后仍为 hex 格式（可被 python-pptx 解析）', () => {
    const page: Slide = {
      id: 'page-rt',
      elements: [{
        id: 'text-rt',
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 50,
        rotate: 0,
        opacity: 1,
        content: '<p>test</p>',
        defaultFontName: 'Arial',
        defaultColor: '#000',
        shadow: { h: 1, v: 2, blur: 3, color: '#00ff00', opacity: 0.7 },
      } as PPTTextElement],
      background: { type: 'solid', value: '#fff' },
    }

    const [backend] = convertPagesToBackend([page])
    const shadowOut = backend.elements[0].shadow as Record<string, unknown>
    expect(shadowOut.color).toBe('#00ff00')
    expect(typeof shadowOut.color).toBe('string')
    expect((shadowOut.color as string).startsWith('#')).toBe(true)

    const restored = convertBackendPage(backend)
    const restoredShadow = (restored.elements[0] as PPTTextElement).shadow!
    expect(restoredShadow.color).toBe('#00ff00')
    expect(restoredShadow.color.startsWith('#')).toBe(true)
  })

  it('无 opacity 时颜色保持不变', () => {
    const page = convertBackendPage(makeTextWithShadow({
      h: 2, v: 2, blur: 4, color: '#000000',
    }))
    const el = page.elements[0] as PPTTextElement
    expect(el.shadow!.color).toBe('#000000')
    expect(el.shadow!.opacity).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════
// BA-P1-03: normalizeOutline 透传 lineCap/lineJoin
// ═══════════════════════════════════════════════

describe('BA-P1-03: normalizeOutline lineCap/lineJoin 透传', () => {
  const makeTextWithOutline = (outline: Record<string, unknown>): BackendSlidePage => ({
    id: 'page-outline',
    elements: [{
      id: 'text-outline',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 50,
      rotate: 0,
      zIndex: 0,
      props: {
        content: '<p>hello</p>',
        defaultFontFamily: 'Arial',
        defaultColor: '#000',
        outline,
      },
    }],
    background: { type: 'color', value: '#ffffff' },
  })

  const makeShapeWithOutline = (outline: Record<string, unknown>): BackendSlidePage => ({
    id: 'page-shape-outline',
    elements: [{
      id: 'shape-outline',
      type: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotate: 0,
      zIndex: 0,
      props: {
        viewBox: [100, 100],
        path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
        fill: '#ccc',
        outline,
      },
    }],
    background: { type: 'color', value: '#ffffff' },
  })

  it('text 元素 outline 应保留 lineCap 和 lineJoin', () => {
    const page = convertBackendPage(makeTextWithOutline({
      style: 'solid', width: 2, color: '#333',
      lineCap: 'round', lineJoin: 'bevel',
    }))
    const el = page.elements[0] as PPTTextElement
    expect(el.outline).toBeDefined()
    expect(el.outline!.lineCap).toBe('round')
    expect(el.outline!.lineJoin).toBe('bevel')
  })

  it('shape 元素 outline 应保留 lineCap 和 lineJoin（消除内联重复）', () => {
    const page = convertBackendPage(makeShapeWithOutline({
      style: 'dashed', width: 3, color: '#ff0000',
      lineCap: 'square', lineJoin: 'miter',
    }))
    const el = page.elements[0] as PPTShapeElement
    expect(el.outline).toBeDefined()
    expect(el.outline!.lineCap).toBe('square')
    expect(el.outline!.lineJoin).toBe('miter')
  })

  it('无 lineCap/lineJoin 时不应出现在结果中', () => {
    const page = convertBackendPage(makeTextWithOutline({
      style: 'solid', width: 1, color: '#000',
    }))
    const el = page.elements[0] as PPTTextElement
    expect(el.outline).toBeDefined()
    expect(el.outline!.lineCap).toBeUndefined()
    expect(el.outline!.lineJoin).toBeUndefined()
  })

  it('无效 lineCap/lineJoin 值应被过滤', () => {
    const page = convertBackendPage(makeTextWithOutline({
      style: 'solid', width: 1, color: '#000',
      lineCap: 'invalid', lineJoin: 42,
    }))
    const el = page.elements[0] as PPTTextElement
    expect(el.outline!.lineCap).toBeUndefined()
    expect(el.outline!.lineJoin).toBeUndefined()
  })

  it('全链路往返：outline lineCap/lineJoin 保存后加载不丢失', () => {
    const page: Slide = {
      id: 'page-ol-rt',
      elements: [{
        id: 'text-ol-rt',
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 50,
        rotate: 0,
        opacity: 1,
        content: '<p>test</p>',
        defaultFontName: 'Arial',
        defaultColor: '#000',
        outline: {
          style: 'solid',
          width: 2,
          color: '#0000ff',
          lineCap: 'round',
          lineJoin: 'round',
        },
      } as PPTTextElement],
      background: { type: 'solid', value: '#fff' },
    }

    const [backend] = convertPagesToBackend([page])
    const outlineOut = (backend.elements[0].props as Record<string, unknown>).outline as Record<string, unknown>
    expect(outlineOut.lineCap).toBe('round')
    expect(outlineOut.lineJoin).toBe('round')

    const restored = convertBackendPage(backend)
    const restoredOutline = (restored.elements[0] as PPTTextElement).outline!
    expect(restoredOutline.lineCap).toBe('round')
    expect(restoredOutline.lineJoin).toBe('round')
  })

  it('image 元素 outline 应同样保留 lineCap/lineJoin', () => {
    const imgPage: BackendSlidePage = {
      id: 'page-img-outline',
      elements: [{
        id: 'img-1',
        type: 'image',
        x: 0, y: 0, width: 200, height: 150, rotate: 0, zIndex: 0,
        props: {
          src: 'https://example.com/img.png',
          outline: {
            style: 'dotted', width: 1, color: '#999',
            lineCap: 'butt', lineJoin: 'miter',
          },
        },
      }],
      background: { type: 'color', value: '#fff' },
    }
    const page = convertBackendPage(imgPage)
    const el = page.elements[0] as PPTImageElement
    expect(el.outline).toBeDefined()
    expect(el.outline!.lineCap).toBe('butt')
    expect(el.outline!.lineJoin).toBe('miter')
  })
})
