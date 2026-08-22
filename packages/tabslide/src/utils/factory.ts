/**
 * 数据工厂函数
 *
 * 创建符合类型定义的默认数据，保证所有必填字段有合理默认值。
 */

import type {
  SlidePresentation,
  Slide,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  PPTLineElement,
  PPTTableElement,
  PPTChartElement,
  PPTLatexElement,
  PPTVideoElement,
  PPTAudioElement,
  PPTCanvasElement,
  TableCell,
  SlidePreset,
} from '../types/slides'
import { PRESET_DIMENSIONS } from '../types/slides'
import { createElementId, createPageId, createPresentationId } from './id'
import * as D from '../defaults/colors'

// ═══════════════════════════════════════════════
// 演示文稿
// ═══════════════════════════════════════════════

/** 创建默认演示文稿 */
export function createDefaultPresentation(
  preset: SlidePreset = '16:9',
  name: string = '未命名演示文稿',
): SlidePresentation {
  const dims = PRESET_DIMENSIONS[preset]
  return {
    id: createPresentationId(),
    name,
    preset,
    canvasWidth: dims.width,
    canvasHeight: dims.height,
    pages: [createBlankSlide()],
    theme: {
      backgroundColor: D.SLIDE_BG,
      themeColors: [...D.THEME_COLORS],
      fontColor: D.TEXT_COLOR,
      fontName: D.FONT_NAME,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ═══════════════════════════════════════════════
// 页面
// ═══════════════════════════════════════════════

/** 创建空白页 */
export function createBlankSlide(): Slide {
  return {
    id: createPageId(),
    elements: [],
    background: { type: 'solid', color: D.SLIDE_BG },
  }
}

// ═══════════════════════════════════════════════
// 元素
// ═══════════════════════════════════════════════

/** 创建文本元素 */
export function createTextElement(
  overrides?: Partial<PPTTextElement>,
): PPTTextElement {
  return {
    id: createElementId(),
    type: 'text',
    x: 100,
    y: 100,
    width: 400,
    height: 80,
    rotate: 0,
    opacity: 1,
    locked: false,
    content: '<p>输入文本</p>',
    defaultFontName: D.FONT_NAME,
    defaultColor: D.TEXT_COLOR,
    ...overrides,
  }
}

/** 创建图片元素 */
export function createImageElement(
  src: string,
  overrides?: Partial<PPTImageElement>,
): PPTImageElement {
  return {
    id: createElementId(),
    type: 'image',
    x: 100,
    y: 100,
    width: 480,
    height: 320,
    rotate: 0,
    opacity: 1,
    locked: false,
    src,
    fixedRatio: true,
    ...overrides,
  }
}

/** 创建矩形形状 */
export function createRectShape(
  overrides?: Partial<PPTShapeElement>,
): PPTShapeElement {
  const w = 200
  const h = 150
  return {
    id: createElementId(),
    type: 'shape',
    x: 100,
    y: 100,
    width: w,
    height: h,
    rotate: 0,
    opacity: 1,
    locked: false,
    viewBox: [w, h],
    path: `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`,
    fixedRatio: false,
    fill: D.BRAND_COLOR,
    pptxShapeType: 'rect',
    ...overrides,
  }
}

/** 创建线条元素 */
export function createLineElement(
  overrides?: Partial<PPTLineElement>,
): PPTLineElement {
  return {
    id: createElementId(),
    type: 'line',
    x: 100,
    y: 300,
    width: 400,
    opacity: 1,
    locked: false,
    start: [0, 0],
    end: [400, 0],
    style: 'solid',
    color: D.TEXT_COLOR,
    lineWidth: 2,
    points: ['', 'arrow'],
    ...overrides,
  }
}

/** 创建表格元素 */
export function createTableElement(
  rows: number = 3,
  cols: number = 3,
  overrides?: Partial<PPTTableElement>,
): PPTTableElement {
  const cellWidth = 120
  const cellHeight = 36
  const totalWidth = cellWidth * cols
  const totalHeight = cellHeight * rows

  const data: TableCell[][] = Array.from({ length: rows }, (_, ri) =>
    Array.from({ length: cols }, (_, ci) => ({
      id: createElementId(),
      text: ri === 0 ? `标题 ${ci + 1}` : '',
      colspan: 1,
      rowspan: 1,
    })),
  )

  const colWidths = Array.from({ length: cols }, () => 1 / cols)
  const rowHeights = Array.from({ length: rows }, () => cellHeight)

  return {
    id: createElementId(),
    type: 'table',
    x: 200,
    y: 200,
    width: totalWidth,
    height: totalHeight,
    rotate: 0,
    opacity: 1,
    locked: false,
    data,
    colWidths,
    rowHeights,
    cellMinHeight: cellHeight,
    outline: { style: 'solid', width: 1, color: '#e5e7eb' },
    theme: {
      color: D.BRAND_COLOR,
      headerRow: true,
      stripedRows: true,
    },
    ...overrides,
  }
}

/** 创建图表元素 */
export function createChartElement(
  overrides?: Partial<PPTChartElement>,
): PPTChartElement {
  return {
    id: createElementId(),
    type: 'chart',
    x: 100,
    y: 100,
    width: 480,
    height: 320,
    rotate: 0,
    opacity: 1,
    locked: false,
    chartType: 'bar',
    data: {
      labels: ['类别 1', '类别 2', '类别 3'],
      legends: ['系列 1'],
      series: [[30, 50, 40]],
    },
    themeColors: [D.BRAND_COLOR],
    ...overrides,
  }
}

/** 创建 LaTeX 公式元素 */
export function createLatexElement(
  latex: string = 'E = mc^2',
  overrides?: Partial<PPTLatexElement>,
): PPTLatexElement {
  return {
    id: createElementId(),
    type: 'latex',
    x: 100,
    y: 100,
    width: 300,
    height: 80,
    rotate: 0,
    opacity: 1,
    locked: false,
    latex,
    color: D.TEXT_COLOR,
    strokeWidth: 2,
    fixedRatio: true,
    ...overrides,
  }
}

/** 创建视频元素 */
export function createVideoElement(
  src: string,
  overrides?: Partial<PPTVideoElement>,
): PPTVideoElement {
  return {
    id: createElementId(),
    type: 'video',
    x: 100,
    y: 100,
    width: 640,
    height: 360,
    rotate: 0,
    opacity: 1,
    locked: false,
    src,
    autoplay: false,
    ...overrides,
  }
}

/** 创建音频元素 */
export function createAudioElement(
  src: string,
  overrides?: Partial<PPTAudioElement>,
): PPTAudioElement {
  return {
    id: createElementId(),
    type: 'audio',
    x: 100,
    y: 100,
    width: 140,
    height: 48,
    rotate: 0,
    opacity: 1,
    locked: false,
    src,
    color: '#666666',
    fixedRatio: true,
    loop: false,
    autoplay: false,
    ...overrides,
  }
}

/** 创建画布元素 */
export function createCanvasElement(
  canvasId: string,
  overrides?: Partial<PPTCanvasElement>,
): PPTCanvasElement {
  return {
    id: createElementId(),
    type: 'canvas',
    x: 100,
    y: 100,
    width: 480,
    height: 320,
    rotate: 0,
    opacity: 1,
    locked: false,
    canvasId,
    ...overrides,
  }
}

/** 创建椭圆形状 */
export function createEllipseShape(
  overrides?: Partial<PPTShapeElement>,
): PPTShapeElement {
  const w = 200
  const h = 200
  const rx = w / 2
  const ry = h / 2
  return {
    id: createElementId(),
    type: 'shape',
    x: 100,
    y: 100,
    width: w,
    height: h,
    rotate: 0,
    opacity: 1,
    locked: false,
    viewBox: [w, h],
    path: `M ${rx} 0 A ${rx} ${ry} 0 1 1 ${rx} ${h} A ${rx} ${ry} 0 1 1 ${rx} 0 Z`,
    fixedRatio: false,
    fill: D.ACCENT_COLOR,
    pptxShapeType: 'ellipse',
    ...overrides,
  }
}
