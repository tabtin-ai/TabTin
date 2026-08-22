/**
 * PPTX 导出 — 基于 pptxgenjs
 *
 * 将 SlidePresentation 数据映射到 pptxgenjs API，生成标准 .pptx 文件。
 *
 * 映射策略：
 * - 坐标系转换：px → inch（pptxgenjs 使用 inch）
 * - 文本：HTML 内容解析为 pptxgenjs 的 TextProps 段落数组
 * - 形状：优先使用 pptxShapeType 映射到 pptxgenjs 预定义形状
 * - 图片：直接使用 base64/URL
 * - 表格：映射行列结构 + 样式
 * - 线条：映射为 addShape('line')
 * - 不支持的元素类型：降级为截图图片
 */

import PptxGenJS from 'pptxgenjs'
import type {
  SlidePresentation, Slide, PPTElement,
  PPTTextElement, PPTImageElement, PPTShapeElement,
  PPTLineElement, PPTTableElement, PPTChartElement, Gradient, ImageFilters, ImageClip, PPTLatexElement,
  PPTVideoElement, PPTAudioElement, PPTElementOutline,
} from '../types/slides'
import { pxToInch, pxToPt, resolveShadowCssColor } from '../utils/geometry'
import { resolvePalette } from '../utils/chart-option'
import {
  getTableThemeColors,
  getCellThemeStyle,
  resolveTableCellStyle,
  getTableColumnCount,
  normalizeTableColWidths,
  normalizeTableRowHeights,
  resolveTableCellBorderSpecs,
  normalizeTableBorders,
} from '../utils/tableTheme'
import {
  applyColorToLatexSvg,
  applyStrokeWidthToLatexSvg,
  buildLatexPlaceholderSvg,
  buildLatexSvgFromPath,
  encodeLatexMetadata,
  svgToDataUrl,
} from '../utils/latex-shared'
import { renderLatexToSvg } from '../utils/latex'
import { resolveBackgroundColor } from '../utils/background'
import {
  normalizeSlideLinkTarget,
  normalizeWebHyperlinkInput,
  parseRichTextHyperlinkHref,
} from '../utils/hyperlink'
import { getShapePath, ShapePathFormulas, isUniformRoundRectKeypoints, normalizeRoundRectKeypoints } from '../configs/shapes'
import { postProcessPptxBlob } from './pptx-postprocess'

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

export interface PPTXExportOptions {
  /** 作者 */
  author?: string
  /** 公司 */
  company?: string
  /** 标题 */
  title?: string
  /** 主题 */
  subject?: string
  /**
   * 图片代理归一化（第 3 级降级）
   *
   * 典型用途：前端受 CORS/跨域限制无法栅格化时，交由后端下载并转为 data URL。
   * 返回值需是可直接用于 <img src> / addImage(data) 的 data URL。
   */
  normalizeImageForExport?: (req: {
    elementId: string
    src: string
    sourceExt?: string
    reason: 'rasterize_failed' | 'unsupported_format'
  }) => Promise<string | null>
  /** 嵌入字体数据（来源于 PPTX 导入时提取的字体，支持 base64 或 OSS URL） */
  embeddedFonts?: Array<{
    name: string
    style: string
    format: string
    data_base64?: string
    oss_url?: string
  }>
  /** 单条告警回调 */
  onWarning?: (warning: PPTXExportWarning) => void
  /** 批量告警回调（导出结束后触发） */
  onWarnings?: (warnings: PPTXExportWarning[]) => void
}

export interface PPTXExportWarning {
  code:
    | 'image_rasterize_failed'
    | 'image_proxy_normalized'
    | 'image_proxy_failed'
    | 'image_placeholder_fallback'
    | 'media_embed_failed'
  message: string
  elementId?: string
  elementType?: PPTElement['type']
}

interface PPTXExportContext {
  options: PPTXExportOptions
  warnings: PPTXExportWarning[]
  warn: (warning: PPTXExportWarning) => void
  slideNumberById: Map<string, number>
}

// ═══════════════════════════════════════════════
// 主导出函数
// ═══════════════════════════════════════════════

/**
 * 导出 SlidePresentation 为 PPTX Blob
 */
export async function exportToPPTXBlob(
  presentation: SlidePresentation,
  options: PPTXExportOptions = {},
  onProgress?: (current: number, total: number) => void,
): Promise<Blob> {
  const pptx = new PptxGenJS()
  const warnings: PPTXExportWarning[] = []
  const warn = (warning: PPTXExportWarning) => {
    warnings.push(warning)
    options.onWarning?.(warning)
  }
  const slideNumberById = new Map<string, number>()
  presentation.pages.forEach((page, idx) => {
    const slideNo = idx + 1
    slideNumberById.set(`page-${slideNo}`, slideNo)
    if (page.id) {
      slideNumberById.set(page.id, slideNo)
    }
  })
  const context: PPTXExportContext = { options, warnings, warn, slideNumberById }

  // 设置文档属性
  pptx.author = options.author || 'TabSlide'
  pptx.company = options.company || ''
  pptx.title = options.title || presentation.name || '演示文稿'
  pptx.subject = options.subject || ''

  // 设置画布尺寸（inch）
  pptx.defineLayout({
    name: 'CUSTOM',
    width: pxToInch(presentation.canvasWidth),
    height: pxToInch(presentation.canvasHeight),
  })
  pptx.layout = 'CUSTOM'

  const total = presentation.pages.length

  // 逐页转换
  for (let i = 0; i < total; i++) {
    onProgress?.(i, total)
    const page = presentation.pages[i]
    const slide = pptx.addSlide()

    // 页面背景
    applyBackground(slide, page, presentation.theme)

    // 页面元素（隐藏元素也导出，后处理阶段会标记 cNvPr@hidden）
    for (const el of page.elements) {
      try {
        await addElement(slide, el, context)
      } catch (err) {
        console.warn(`[PPTX Export] 元素 ${el.id} (${el.type}) 导出失败:`, err)
      }
    }

    // 备注
    if (page.remark) {
      slide.addNotes(page.remark)
    }
  }

  onProgress?.(total, total)

  // 生成文件
  const rawBlob = await pptx.write({ outputType: 'blob' }) as Blob

  // 后处理：注入 pptxgenjs 不支持的特性（表格旋转、元素分组、字体嵌入）
  const finalBlob = await postProcessPptxBlob(rawBlob, presentation, options.embeddedFonts)
  if (warnings.length > 0) {
    options.onWarnings?.([...warnings])
  }
  return finalBlob
}

/**
 * 导出 PPTX 并下载
 */
export async function downloadAsPPTX(
  presentation: SlidePresentation,
  options: PPTXExportOptions = {},
  filename?: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const blob = await exportToPPTXBlob(presentation, options, onProgress)
  const name = filename || `${presentation.name || '演示文稿'}.pptx`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ═══════════════════════════════════════════════
// 页面背景
// ═══════════════════════════════════════════════

function applyBackground(
  slide: PptxGenJS.Slide,
  page: Slide,
  presentationTheme?: SlidePresentation['theme'],
) {
  const bg = page.background
  if (!bg) return
  const legacyBg = bg as unknown as { type?: string; value?: string }
  const legacyType = legacyBg.type as string | undefined

  if (bg.type === 'theme') {
    const color = bg.theme?.color || bg.color || legacyBg.value || resolveBackgroundColor(bg, presentationTheme)
    if (color) {
      slide.background = { fill: hexToRGB(color) }
    }
  } else if ((bg.type === 'solid' || legacyType === 'color') && (bg.color || legacyBg.value)) {
    slide.background = { fill: hexToRGB(bg.color || legacyBg.value || '#ffffff') }
  } else if (bg.type === 'image' && bg.image?.src) {
    // base64 或 URL
    if (bg.image.src.startsWith('data:')) {
      slide.background = { data: bg.image.src }
    } else {
      slide.background = { path: bg.image.src }
    }
  } else if (bg.type === 'gradient' && bg.gradient) {
    // pptxgenjs 不直接支持渐变背景，用纯色降级
    const firstColor = bg.gradient.colors[0]?.color
    if (firstColor) {
      slide.background = { fill: hexToRGB(firstColor) }
    }
  }
}

// ═══════════════════════════════════════════════
// 元素转换
// ═══════════════════════════════════════════════

async function addElement(
  slide: PptxGenJS.Slide,
  el: PPTElement,
  context: PPTXExportContext,
): Promise<void> {
  switch (el.type) {
    case 'text': return addTextElement(slide, el, context)
    case 'image': return addImageElement(slide, el, context)
    case 'shape': return addShapeElement(slide, el, context)
    case 'line': return addLineElement(slide, el, context)
    case 'table': return addTableElement(slide, el, context)
    case 'chart': return addChartElement(slide, el as PPTChartElement, context)
    case 'latex': return addLatexElement(slide, el, context)
    case 'video': return addVideoElement(slide, el, context)
    case 'audio': return addAudioElement(slide, el, context)
    default:
      addPlaceholder(slide, el)
      return
  }
}

function resolveElementHyperlink(
  rawLink: unknown,
  context: PPTXExportContext,
): PptxGenJS.HyperlinkProps | undefined {
  if (!rawLink || typeof rawLink !== 'object') return undefined
  const link = rawLink as { type?: unknown; target?: unknown }
  const target = typeof link.target === 'string' ? link.target.trim() : ''
  if (!target) return undefined

  const rawType = typeof link.type === 'string' ? link.type.trim().toLowerCase() : ''
  if (rawType === 'slide') {
    const pageRef = normalizeSlideLinkTarget(target)
    if (!pageRef) {
      return undefined
    }
    const slideNo = context.slideNumberById.get(pageRef)
    if (slideNo && slideNo > 0) {
      return { slide: slideNo }
    }
    return undefined
  }

  const normalizedUrl = normalizeWebHyperlinkInput(target)
  if (!normalizedUrl) return undefined
  return { url: normalizedUrl, tooltip: '' }
}

function resolveRichTextInlineHyperlink(
  rawHref: string,
  context: PPTXExportContext,
): PptxGenJS.HyperlinkProps | undefined {
  const parsed = parseRichTextHyperlinkHref(rawHref)
  if (!parsed) return undefined

  if (parsed.type === 'slide') {
    const slideNo = context.slideNumberById.get(parsed.target)
    if (slideNo && slideNo > 0) {
      return { slide: slideNo }
    }
    return undefined
  }

  return { url: parsed.target, tooltip: '' }
}

// ── 文本 ──

function addTextElement(
  slide: PptxGenJS.Slide,
  el: PPTTextElement,
  context: PPTXExportContext,
) {
  const textParts = parseHtmlToTextProps(el.content, el, context)

  // 文本框内边距（pt）：
  // - 与后端 python-pptx 读写链路统一（3.6/7.2pt 默认值）
  // - pptxgenjs TextProps.margin 语义为 points
  const m = el.margin
  const textMargin: [number, number, number, number] = m
    ? [m.top ?? 3.6, m.right ?? 7.2, m.bottom ?? 3.6, m.left ?? 7.2]
    : [3.6, 7.2, 3.6, 7.2]

  const textOpts: PptxGenJS.TextPropsOptions = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(el.height),
    rotate: el.rotate,
    valign: (el.verticalAlign || 'top') as 'top' | 'middle' | 'bottom',
    margin: textMargin,
    wrap: true,
    shrinkText: el.autoFit === 'shrink',
    autoFit: el.autoFit === 'resize',
  }

  if (el.fill) {
    textOpts.fill = { color: hexToRGB(el.fill) }
  }

  if (el.outline) {
    textOpts.line = {
      color: hexToRGB(el.outline.color),
      width: el.outline.width,
      dashType: mapLineStyleToDashType(el.outline.style),
    }
  }

  if (el.shadow) {
    const shadowOpacity = resolveShadowOpacity(el.shadow, 0.5)
    textOpts.shadow = {
      type: 'outer',
      blur: el.shadow.blur,
      offset: Math.sqrt(el.shadow.h * el.shadow.h + el.shadow.v * el.shadow.v),
      color: hexToRGB(el.shadow.color),
      opacity: shadowOpacity,
      angle: Math.atan2(el.shadow.v, el.shadow.h) * (180 / Math.PI),
    }
  }

  // 翻转
  if (el.flipH) textOpts.flipH = true
  if (el.flipV) textOpts.flipV = true

  // 透明度
  if (el.opacity !== undefined && el.opacity < 1) {
    (textOpts as Record<string, unknown>).transparency = Math.round((1 - el.opacity) * 100)
  }

  // 竖排文本
  if (el.vertical) {
    textOpts.vert = 'eaVert'
  }

  // 元素级超链接（整个文本框可点击跳转）
  const hyperlink = resolveElementHyperlink(el.link, context)
  if (hyperlink) {
    textOpts.hyperlink = hyperlink
  }

  slide.addText(textParts, textOpts)
}

// ── 图片 ──

async function addImageElement(
  slide: PptxGenJS.Slide,
  el: PPTImageElement,
  context: PPTXExportContext,
): Promise<void> {
  const srcExt = detectImageExt(el.src)
  const shouldRasterize = needsRasterizeForPptx(el, srcExt)
  let proxySource: string | null = null
  let rasterizedData: string | null = null

  if (shouldRasterize) {
    rasterizedData = await rasterizeImageElementForPptx(el).catch((err) => {
      console.warn('[PPTX Export] 图片栅格化失败:', err)
      context.warn({
        code: 'image_rasterize_failed',
        message: `图片栅格化失败，尝试后端代理降级（element=${el.id}）`,
        elementId: el.id,
        elementType: 'image',
      })
      return null
    })

    if (!rasterizedData) {
      proxySource = await tryNormalizeImageByProxy(
        el,
        context,
        !isPptxImageExtSupported(srcExt) ? 'unsupported_format' : 'rasterize_failed',
        srcExt,
      )
      if (proxySource) {
        rasterizedData = await rasterizeImageElementForPptx(el, proxySource).catch((err) => {
          console.warn('[PPTX Export] 代理图片栅格化失败:', err)
          return null
        })
      }
    }

    if (!rasterizedData) {
      context.warn({
        code: 'image_placeholder_fallback',
        message: `图片导出降级为占位图（element=${el.id}）`,
        elementId: el.id,
        elementType: 'image',
      })
      addImagePlaceholder(slide, el)
      return
    }
  }
  const useRasterized = !!rasterizedData
  const directSrc = proxySource || el.src
  const directExt = detectImageExt(directSrc)

  const imgOpts: PptxGenJS.ImageProps = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(el.height),
    rotate: el.rotate,
    rounding: !useRasterized && (el.clip?.shape === 'ellipse' || !!el.radius),
    ...(el.altText ? { altText: el.altText } : {}),
  }

  if (useRasterized && rasterizedData) {
    imgOpts.data = rasterizedData
  } else {
    if (!isPptxImageExtSupported(directExt)) {
      context.warn({
        code: 'image_placeholder_fallback',
        message: `图片格式不受支持且无法降级，导出占位图（element=${el.id}, ext=${directExt || 'unknown'}）`,
        elementId: el.id,
        elementType: 'image',
      })
      addImagePlaceholder(slide, el)
      return
    }
    if (directSrc.startsWith('data:')) {
      imgOpts.data = directSrc
    } else {
      imgOpts.path = directSrc
    }
  }

  const hyperlink = resolveElementHyperlink(el.link, context)
  if (hyperlink) {
    imgOpts.hyperlink = hyperlink
  }

  // 边框（pptxgenjs ImageProps 类型未声明 line，但运行时生效）
  if (el.outline) {
    ;(imgOpts as Record<string, unknown>).line = {
      color: hexToRGB(el.outline.color),
      width: el.outline.width,
      dashType: mapLineStyleToDashType(el.outline.style),
    }
  }

  // 阴影
  if (el.shadow) {
    const shadowOpacity = resolveShadowOpacity(el.shadow, 0.5)
    imgOpts.shadow = {
      type: 'outer',
      blur: el.shadow.blur,
      offset: Math.sqrt(el.shadow.h * el.shadow.h + el.shadow.v * el.shadow.v),
      color: hexToRGB(el.shadow.color),
      opacity: shadowOpacity,
      angle: Math.atan2(el.shadow.v, el.shadow.h) * (180 / Math.PI),
    }
  }

  // 翻转 — 栅格化路径已在 Canvas 中处理 flip，不再传递给 PPTX（B2-04）
  if (!useRasterized) {
    if (el.flipH) imgOpts.flipH = true
    if (el.flipV) imgOpts.flipV = true
  }

  // 透明度
  if (el.opacity !== undefined && el.opacity < 1) {
    imgOpts.transparency = Math.round((1 - el.opacity) * 100)
  }

  // 裁剪（clip → pptxgenjs sizing crop）
  const rectClip = !useRasterized ? getAxisAlignedRectClipBounds(el.clip) : null
  if (!useRasterized && rectClip) {
    // B2-02: clip.range 存储视觉（post-flip）坐标，但 PPTX srcRect 在 flip 前生效。
    // 有 flip 时需将裁剪坐标做镜像换算。
    const clipLeft = el.flipH ? (1 - rectClip.right) : rectClip.left
    const clipRight = el.flipH ? (1 - rectClip.left) : rectClip.right
    const clipTop = el.flipV ? (1 - rectClip.bottom) : rectClip.top
    const clipBottom = el.flipV ? (1 - rectClip.top) : rectClip.bottom
    const cropW = clipRight - clipLeft
    const cropH = clipBottom - clipTop
    if (cropW > 1e-6 && cropH > 1e-6 && (cropW < 1 - 1e-6 || cropH < 1 - 1e-6)) {
      imgOpts.sizing = {
        type: 'crop',
        w: pxToInch(el.width / cropW),
        h: pxToInch(el.height / cropH),
        x: pxToInch((el.width * clipLeft) / cropW),
        y: pxToInch((el.height * clipTop) / cropH),
      }
    }
  } else if (!useRasterized && el.objectFit === 'contain') {
    imgOpts.sizing = {
      type: 'contain',
      w: pxToInch(el.width),
      h: pxToInch(el.height),
    }
  } else if (!useRasterized && el.objectFit === 'cover') {
    imgOpts.sizing = {
      type: 'cover',
      w: pxToInch(el.width),
      h: pxToInch(el.height),
    }
  }

  slide.addImage(imgOpts)

  // 颜色蒙版 → 叠加一个同位置同尺寸的半透明形状（跟随图片裁剪形状）
  if (el.colorMask && !useRasterized) {
    const maskColor = hexToRGB(el.colorMask)
    const maskAlpha = parseAlpha(el.colorMask)
    const isEllipse = el.clip?.shape === 'ellipse'
    const maskShape = isEllipse ? 'ellipse' : 'rect'
    slide.addShape(maskShape as PptxGenJS.ShapeType, {
      x: pxToInch(el.x),
      y: pxToInch(el.y),
      w: pxToInch(el.width),
      h: pxToInch(el.height),
      rotate: el.rotate,
      fill: { color: maskColor, transparency: Math.round((1 - maskAlpha) * 100) },
      line: { color: maskColor, width: 0 },
      ...(!isEllipse && el.radius ? { rectRadius: pxToInch(el.radius) } : {}),
      ...(el.flipH ? { flipH: true } : {}),
      ...(el.flipV ? { flipV: true } : {}),
    })
  }
}

async function tryNormalizeImageByProxy(
  el: PPTImageElement,
  context: PPTXExportContext,
  reason: 'rasterize_failed' | 'unsupported_format',
  sourceExt?: string,
): Promise<string | null> {
  const normalize = context.options.normalizeImageForExport
  if (!normalize) return null

  try {
    const normalized = await normalize({
      elementId: el.id,
      src: el.src,
      sourceExt,
      reason,
    })
    if (!normalized || !normalized.startsWith('data:image/')) {
      context.warn({
        code: 'image_proxy_failed',
        message: `后端代理返回无效图片数据，跳过（element=${el.id}）`,
        elementId: el.id,
        elementType: 'image',
      })
      return null
    }
    context.warn({
      code: 'image_proxy_normalized',
      message: `图片已通过后端代理归一化（element=${el.id}）`,
      elementId: el.id,
      elementType: 'image',
    })
    return normalized
  } catch (err) {
    console.warn('[PPTX Export] 后端代理归一化失败:', err)
    context.warn({
      code: 'image_proxy_failed',
      message: `后端代理归一化失败，继续占位兜底（element=${el.id}）`,
      elementId: el.id,
      elementType: 'image',
    })
    return null
  }
}

/** 从 CSS 颜色值中提取 alpha（0-1），默认 1 */
function parseAlpha(color: string): number {
  const rgbaMatch = color.match(
    /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)/i,
  )
  if (rgbaMatch) {
    if (rgbaMatch[1] == null || rgbaMatch[1] === '') return 1
    const parsed = Number.parseFloat(rgbaMatch[1])
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed))
    return 1
  }
  // #RGBA
  if (/^#[0-9a-fA-F]{4}$/.test(color)) return parseInt(color[4] + color[4], 16) / 255
  // #RRGGBBAA
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return parseInt(color.slice(7, 9), 16) / 255
  return 1
}

/** 解析阴影透明度：优先 shadow.opacity，其次从颜色 alpha 推断，最后使用默认值 */
function resolveShadowOpacity(
  shadow: { color?: string; opacity?: number } | undefined,
  fallback = 0.5,
): number {
  if (!shadow) return fallback
  if (typeof shadow.opacity === 'number' && Number.isFinite(shadow.opacity)) {
    return Math.max(0, Math.min(1, shadow.opacity))
  }
  if (shadow.color) {
    return Math.max(0, Math.min(1, parseAlpha(shadow.color)))
  }
  return fallback
}

function buildPptxFillFromColor(color?: string): PptxGenJS.ShapeFillProps | undefined {
  if (!color || color === 'transparent') return undefined
  const alpha = parseAlpha(color)
  const fill: PptxGenJS.ShapeFillProps = { color: hexToRGB(color) }
  if (alpha < 1) {
    fill.transparency = Math.round((1 - alpha) * 100)
  }
  return fill
}

function detectImageExt(src: string): string | undefined {
  if (!src) return undefined

  if (src.startsWith('data:image/')) {
    const m = src.match(/^data:image\/([a-zA-Z0-9.+-]+);/i)
    if (!m) return undefined
    const mimeExt = m[1].toLowerCase()
    if (mimeExt === 'svg+xml') return 'svg'
    if (mimeExt === 'jpeg') return 'jpg'
    return mimeExt
  }

  const clean = src.split('?')[0].split('#')[0].trim().toLowerCase()
  const dotIdx = clean.lastIndexOf('.')
  if (dotIdx < 0 || dotIdx === clean.length - 1) return undefined
  const ext = clean.slice(dotIdx + 1)
  if (ext === 'jpeg') return 'jpg'
  return ext
}

function isPptxImageExtSupported(ext?: string): boolean {
  if (!ext) return false
  return ['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext.toLowerCase())
}

function hasMeaningfulFilters(filters?: ImageFilters): boolean {
  if (!filters) return false
  if (filters.brightness !== undefined && Math.abs(filters.brightness - 1) > 1e-3) return true
  if (filters.contrast !== undefined && Math.abs(filters.contrast - 1) > 1e-3) return true
  if (filters.saturate !== undefined && Math.abs(filters.saturate - 1) > 1e-3) return true
  if (filters.blur !== undefined && filters.blur > 1e-3) return true
  if (filters.grayscale !== undefined && filters.grayscale > 1e-3) return true
  if (filters.invert !== undefined && filters.invert > 1e-3) return true
  if (filters.hueRotate !== undefined && Math.abs(filters.hueRotate % 360) > 1e-3) return true
  if (filters.sepia !== undefined && filters.sepia > 1e-3) return true
  return false
}

function getAxisAlignedRectClipBounds(
  clip?: ImageClip,
): { left: number; top: number; right: number; bottom: number } | null {
  if (!clip || clip.shape === 'ellipse' || !clip.range || clip.range.length < 4) {
    return null
  }

  const [p0, p1, p2, p3] = clip.range
  if (!p0 || !p1 || !p2 || !p3) return null

  const tol = 1e-3
  const isAxisAligned =
    Math.abs(p0[1] - p1[1]) <= tol &&
    Math.abs(p2[1] - p3[1]) <= tol &&
    Math.abs(p0[0] - p3[0]) <= tol &&
    Math.abs(p1[0] - p2[0]) <= tol
  if (!isAxisAligned) return null

  const left = Math.max(0, Math.min(1, Math.min(p0[0], p3[0])))
  const top = Math.max(0, Math.min(1, Math.min(p0[1], p1[1])))
  const right = Math.max(0, Math.min(1, Math.max(p1[0], p2[0])))
  const bottom = Math.max(0, Math.min(1, Math.max(p2[1], p3[1])))
  if (right - left <= tol || bottom - top <= tol) return null

  return { left, top, right, bottom }
}

function needsRasterizeForPptx(el: PPTImageElement, srcExt?: string): boolean {
  if (!isPptxImageExtSupported(srcExt)) return true
  if (hasMeaningfulFilters(el.filters)) return true
  if (el.clip?.shape === 'ellipse') return true
  if (el.clip?.range && el.clip.range.length >= 3 && !getAxisAlignedRectClipBounds(el.clip)) return true
  if (el.colorMask) return true
  if (typeof el.radius === 'number' && el.radius > 0) return true
  return false
}

function buildCssFilterString(filters?: ImageFilters): string {
  if (!filters) return ''
  return [
    filters.brightness !== undefined && `brightness(${filters.brightness})`,
    filters.contrast !== undefined && `contrast(${filters.contrast})`,
    filters.saturate !== undefined && `saturate(${filters.saturate})`,
    filters.blur !== undefined && `blur(${filters.blur}px)`,
    filters.grayscale !== undefined && `grayscale(${filters.grayscale})`,
    filters.invert !== undefined && `invert(${filters.invert})`,
    filters.hueRotate !== undefined && `hue-rotate(${filters.hueRotate}deg)`,
    filters.sepia !== undefined && `sepia(${filters.sepia})`,
  ]
    .filter(Boolean)
    .join(' ')
}

function applyRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function applyImageClipPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  el: PPTImageElement,
): void {
  if (el.clip?.shape === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
    ctx.clip()
    return
  }

  if (el.clip?.range && el.clip.range.length >= 3) {
    const points = el.clip.range
    ctx.beginPath()
    points.forEach((p, idx) => {
      const px = p[0] * width
      const py = p[1] * height
      if (idx === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.closePath()
    ctx.clip()
    return
  }

  if (typeof el.radius === 'number' && el.radius > 0) {
    applyRoundedRectPath(ctx, 0, 0, width, height, el.radius)
    ctx.clip()
  }
}

function drawImageWithObjectFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number,
  objectFit: PPTImageElement['objectFit'] = 'cover',
): void {
  const naturalW = img.naturalWidth || img.width
  const naturalH = img.naturalHeight || img.height
  if (!naturalW || !naturalH || width <= 0 || height <= 0) return

  if (objectFit === 'fill') {
    ctx.drawImage(img, 0, 0, width, height)
    return
  }

  const scale = objectFit === 'contain'
    ? Math.min(width / naturalW, height / naturalH)
    : Math.max(width / naturalW, height / naturalH)
  const drawW = naturalW * scale
  const drawH = naturalH * scale
  const drawX = (width - drawW) / 2
  const drawY = (height - drawH) / 2

  ctx.drawImage(img, drawX, drawY, drawW, drawH)
}

async function loadImageForCanvas(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image()
    if (!src.startsWith('data:')) {
      img.crossOrigin = 'anonymous'
    }
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

async function rasterizeImageElementForPptx(
  el: PPTImageElement,
  srcOverride?: string,
): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const source = srcOverride || el.src
  if (!source) return null

  // 2x 超采样提升导出清晰度（与后端 supersample=2.0 保持一致），
  // 限制最大尺寸避免 Canvas 内存溢出。
  const SUPERSAMPLE = 2
  const MAX_DIM = 4096
  const rawW = Math.max(1, Math.round(el.width * SUPERSAMPLE))
  const rawH = Math.max(1, Math.round(el.height * SUPERSAMPLE))
  const scale = Math.min(1, MAX_DIM / Math.max(rawW, rawH))
  const canvasW = Math.round(rawW * scale)
  const canvasH = Math.round(rawH * scale)

  const img = await loadImageForCanvas(source)
  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const filterStr = buildCssFilterString(el.filters)

  ctx.save()
  // B2-04: 栅格化时应用 flip 镜像，使裁剪路径与图片内容正确对齐。
  // 栅格化后的 PNG 已包含 flip 效果，imgOpts 中的 flipH/flipV 会在下游清除。
  if (el.flipH || el.flipV) {
    ctx.translate(el.flipH ? canvasW : 0, el.flipV ? canvasH : 0)
    ctx.scale(el.flipH ? -1 : 1, el.flipV ? -1 : 1)
  }
  applyImageClipPath(ctx, canvasW, canvasH, el)
  if (filterStr) {
    ctx.filter = filterStr
  }
  drawImageWithObjectFit(ctx, img, canvasW, canvasH, el.objectFit || 'cover')
  ctx.restore()

  if (el.colorMask) {
    ctx.save()
    applyImageClipPath(ctx, canvasW, canvasH, el)
    ctx.fillStyle = el.colorMask
    ctx.fillRect(0, 0, canvasW, canvasH)
    ctx.restore()
  }

  return canvas.toDataURL('image/png')
}

function hasCustomShapeKeypointOverrides(el: PPTShapeElement): boolean {
  if (!Array.isArray(el.keypoints) || el.keypoints.length === 0) return false
  const formula = el.pathFormula ? ShapePathFormulas[el.pathFormula] : undefined
  if (!formula) return true
  const defaults = formula.defaultValue || []
  if (defaults.length !== el.keypoints.length) return true
  return el.keypoints.some((v, i) => Math.abs((Number(v) || 0) - (Number(defaults[i]) || 0)) > 1e-4)
}

function canRoundRectUseNativePreset(el: PPTShapeElement): boolean {
  return el.pathFormula === 'roundRect' && isUniformRoundRectKeypoints(el.keypoints)
}

function getRoundRectUniformRatio(el: PPTShapeElement): number {
  return normalizeRoundRectKeypoints(el.keypoints)[0]
}

function isSupportedPatternDataUrl(pattern?: string): boolean {
  if (!pattern || typeof pattern !== 'string') return false
  const m = pattern.match(/^data:([^;,]+)[;,]/i)
  if (!m) return false
  const mime = m[1].toLowerCase()
  return mime === 'image/png'
    || mime === 'image/jpeg'
    || mime === 'image/jpg'
    || mime === 'image/gif'
    || mime === 'image/bmp'
    || mime === 'image/x-ms-bmp'
}

function shouldRasterizeShapeForPptx(
  el: PPTShapeElement,
  shapeTypeMatched: boolean,
  hasCustomGeomFallback: boolean,
): boolean {
  if (el.special) return true
  if (el.pattern) return !isSupportedPatternDataUrl(el.pattern)
  // 渐变可通过 postprocess 注入 OOXML gradFill，优先保留矢量可编辑性。
  if (hasCustomShapeKeypointOverrides(el)) {
    // roundRect 优先用 rectRadius，其它 keypoint 形状优先走 custom geometry（保持矢量可编辑）。
    const canMapRoundRect = canRoundRectUseNativePreset(el)
    if (canMapRoundRect) return false
    return !hasCustomGeomFallback
  }
  if (!shapeTypeMatched || !el.pptxShapeType) {
    // freeform / 未映射形状：优先 custGeom，失败再栅格化
    return !hasCustomGeomFallback
  }
  return false
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function rasterizeShapeElementForPptx(el: PPTShapeElement): Promise<string | null> {
  if (typeof document === 'undefined') return null

  const width = Math.max(1, Math.round(el.width))
  const height = Math.max(1, Math.round(el.height))
  const actualPath = getShapePath(el.pathFormula, el.path, width, height, el.keypoints)
  const viewBox = el.pathFormula
    ? `0 0 ${width} ${height}`
    : `0 0 ${el.viewBox?.[0] ?? width} ${el.viewBox?.[1] ?? height}`
  const gradId = `shape-grad-${el.id}`
  const patId = `shape-pat-${el.id}`
  const clipId = `shape-clip-${el.id}`

  let defs = `<clipPath id="${clipId}"><path d="${actualPath}"/></clipPath>`
  let fillAttr = el.fill === 'transparent' || el.fill === 'none' ? 'transparent' : (el.fill || '#5b9bd5')

  if (el.pattern) {
    defs += `<pattern id="${patId}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="${escapeXmlAttr(el.pattern)}" width="1" height="1" preserveAspectRatio="xMidYMid slice"/></pattern>`
    fillAttr = `url(#${patId})`
  } else if (el.gradient) {
    const stops = el.gradient.colors
      .map((s) => `<stop offset="${s.pos * 100}%" stop-color="${escapeXmlAttr(s.color)}"/>`)
      .join('')
    defs += el.gradient.type === 'linear'
      ? `<linearGradient id="${gradId}" gradientTransform="rotate(${el.gradient.rotate}, 0.5, 0.5)">${stops}</linearGradient>`
      : `<radialGradient id="${gradId}" cx="${el.gradient.center?.x ?? 0.5}" cy="${el.gradient.center?.y ?? 0.5}" r="0.5" fx="${el.gradient.center?.x ?? 0.5}" fy="${el.gradient.center?.y ?? 0.5}" gradientUnits="objectBoundingBox">${stops}</radialGradient>`
    fillAttr = `url(#${gradId})`
  }

  let outlineAttr = ''
  if (el.outline) {
    outlineAttr = ` stroke="${escapeXmlAttr(el.outline.color)}" stroke-width="${el.outline.width}"`
    if (el.outline.style === 'dashed') outlineAttr += ' stroke-dasharray="8 4"'
    else if (el.outline.style === 'dotted') outlineAttr += ' stroke-dasharray="2 2"'
    else if (el.outline.style === 'dashDot') outlineAttr += ' stroke-dasharray="8 4 2 4"'
    else if (el.outline.style === 'longDash') outlineAttr += ' stroke-dasharray="16 4"'
    else if (el.outline.style === 'longDashDot') outlineAttr += ' stroke-dasharray="16 4 2 4"'
  }

  let textMarkup = ''
  if (el.text?.content) {
    const txtAlign = el.text.align || 'center'
    const vAlign = el.text.verticalAlign || 'middle'
    const justifyMap: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
    const alignMap: Record<string, string> = { left: 'flex-start', center: 'center', right: 'flex-end' }
    textMarkup = `<foreignObject x="0" y="0" width="100%" height="100%" clip-path="url(#${clipId})"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;display:flex;flex-direction:column;align-items:${alignMap[txtAlign] || 'center'};justify-content:${justifyMap[vAlign] || 'center'};padding:8px;overflow:hidden;word-break:break-word;font-size:${el.text.defaultFontSize || 14}px;color:${escapeXmlAttr(el.text.defaultColor || '#333333')};font-family:${escapeXmlAttr(el.text.defaultFontName || 'inherit')};text-align:${txtAlign};">${el.text.content}</div></foreignObject>`
  }

  const shadowStyle = el.shadow
    ? `filter:drop-shadow(${el.shadow.h}px ${el.shadow.v}px ${el.shadow.blur}px ${escapeXmlAttr(resolveShadowCssColor(el.shadow.color, el.shadow.opacity))});`
    : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" preserveAspectRatio="none" style="overflow:visible;${shadowStyle}"><defs>${defs}</defs><path d="${actualPath}" fill="${fillAttr}"${outlineAttr}/>${textMarkup}</svg>`

  const img = await loadImageForCanvas(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  const scale = typeof window !== 'undefined'
    ? Math.max(1, Math.min(3, window.devicePixelRatio || 2))
    : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

type ParsedShapePathCmd =
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'lineTo'; x: number; y: number }
  | { type: 'cubicTo'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'quadTo'; x1: number; y1: number; x: number; y: number }
  | { type: 'close' }

function parseShapeSvgPath(path: string): ParsedShapePathCmd[] | null {
  const tokens = path.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g)
  if (!tokens || tokens.length === 0) return null

  let i = 0
  let cmd = ''
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const out: ParsedShapePathCmd[] = []

  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t)
  const hasNum = () => i < tokens.length && !isCmd(tokens[i])
  const readNum = (): number | null => {
    if (i >= tokens.length) return null
    const n = Number(tokens[i])
    if (!Number.isFinite(n)) return null
    i += 1
    return n
  }
  const setPoint = (x: number, y: number, relative: boolean) => {
    if (relative) {
      cx += x
      cy += y
    } else {
      cx = x
      cy = y
    }
  }

  while (i < tokens.length) {
    if (isCmd(tokens[i])) {
      cmd = tokens[i]
      i += 1
    } else if (!cmd) {
      return null
    }

    const relative = cmd === cmd.toLowerCase()
    const upper = cmd.toUpperCase()

    if (upper === 'M') {
      const x = readNum()
      const y = readNum()
      if (x == null || y == null) return null
      setPoint(x, y, relative)
      sx = cx
      sy = cy
      out.push({ type: 'moveTo', x: cx, y: cy })
      while (hasNum()) {
        const lx = readNum()
        const ly = readNum()
        if (lx == null || ly == null) return null
        setPoint(lx, ly, relative)
        out.push({ type: 'lineTo', x: cx, y: cy })
      }
      continue
    }

    if (upper === 'L') {
      while (hasNum()) {
        const x = readNum()
        const y = readNum()
        if (x == null || y == null) return null
        setPoint(x, y, relative)
        out.push({ type: 'lineTo', x: cx, y: cy })
      }
      continue
    }

    if (upper === 'H') {
      while (hasNum()) {
        const x = readNum()
        if (x == null) return null
        if (relative) cx += x
        else cx = x
        out.push({ type: 'lineTo', x: cx, y: cy })
      }
      continue
    }

    if (upper === 'V') {
      while (hasNum()) {
        const y = readNum()
        if (y == null) return null
        if (relative) cy += y
        else cy = y
        out.push({ type: 'lineTo', x: cx, y: cy })
      }
      continue
    }

    if (upper === 'C') {
      while (hasNum()) {
        const x1 = readNum()
        const y1 = readNum()
        const x2 = readNum()
        const y2 = readNum()
        const x = readNum()
        const y = readNum()
        if ([x1, y1, x2, y2, x, y].some((n) => n == null)) return null
        const ax1 = relative ? cx + (x1 as number) : (x1 as number)
        const ay1 = relative ? cy + (y1 as number) : (y1 as number)
        const ax2 = relative ? cx + (x2 as number) : (x2 as number)
        const ay2 = relative ? cy + (y2 as number) : (y2 as number)
        setPoint(x as number, y as number, relative)
        out.push({ type: 'cubicTo', x1: ax1, y1: ay1, x2: ax2, y2: ay2, x: cx, y: cy })
      }
      continue
    }

    if (upper === 'Q') {
      while (hasNum()) {
        const x1 = readNum()
        const y1 = readNum()
        const x = readNum()
        const y = readNum()
        if ([x1, y1, x, y].some((n) => n == null)) return null
        const ax1 = relative ? cx + (x1 as number) : (x1 as number)
        const ay1 = relative ? cy + (y1 as number) : (y1 as number)
        setPoint(x as number, y as number, relative)
        out.push({ type: 'quadTo', x1: ax1, y1: ay1, x: cx, y: cy })
      }
      continue
    }

    if (upper === 'Z') {
      cx = sx
      cy = sy
      out.push({ type: 'close' })
      continue
    }

    // 暂不支持 A/S/T 等命令；交给栅格化兜底。
    return null
  }

  return out.length > 0 ? out : null
}

function buildShapeCustomPoints(
  el: PPTShapeElement,
): NonNullable<PptxGenJS.ShapeProps['points']> | null {
  const actualPath = getShapePath(el.pathFormula, el.path, el.width, el.height, el.keypoints)
  const cmds = parseShapeSvgPath(actualPath)
  if (!cmds || cmds.length === 0) return null

  const baseW = el.pathFormula ? Math.max(el.width, 1) : Math.max(el.viewBox?.[0] || el.width, 1)
  const baseH = el.pathFormula ? Math.max(el.height, 1) : Math.max(el.viewBox?.[1] || el.height, 1)
  const sx = el.pathFormula ? 1 : el.width / baseW
  const sy = el.pathFormula ? 1 : el.height / baseH
  const toInPoint = (x: number, y: number) => ({ x: pxToInch(x * sx), y: pxToInch(y * sy) })

  const points: NonNullable<PptxGenJS.ShapeProps['points']> = []
  for (const cmd of cmds) {
    if (cmd.type === 'moveTo') {
      const p = toInPoint(cmd.x, cmd.y)
      points.push({ ...p, moveTo: true })
      continue
    }
    if (cmd.type === 'lineTo') {
      points.push(toInPoint(cmd.x, cmd.y))
      continue
    }
    if (cmd.type === 'cubicTo') {
      const p = toInPoint(cmd.x, cmd.y)
      const p1 = toInPoint(cmd.x1, cmd.y1)
      const p2 = toInPoint(cmd.x2, cmd.y2)
      points.push({
        ...p,
        curve: { type: 'cubic', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
      })
      continue
    }
    if (cmd.type === 'quadTo') {
      const p = toInPoint(cmd.x, cmd.y)
      const p1 = toInPoint(cmd.x1, cmd.y1)
      points.push({
        ...p,
        curve: { type: 'quadratic', x1: p1.x, y1: p1.y },
      })
      continue
    }
    points.push({ close: true })
  }
  return points.length > 0 ? points : null
}

// ── 形状 ──

async function addShapeElement(
  slide: PptxGenJS.Slide,
  el: PPTShapeElement,
  context: PPTXExportContext,
) {
  // 尝试映射 pptxShapeType → pptxgenjs 形状名称
  let { shapeType, exact: shapeTypeMatched } = mapPptxShapeType(el.pptxShapeType)
  const canMapRoundRectNative = canRoundRectUseNativePreset(el)
  if (canMapRoundRectNative) {
    shapeType = 'roundRect' as PptxGenJS.ShapeType
    shapeTypeMatched = true
  }
  const customGeomPoints = buildShapeCustomPoints(el)
  const hasCustomGeomFallback = !!customGeomPoints
  const needRasterize = shouldRasterizeShapeForPptx(el, shapeTypeMatched, hasCustomGeomFallback)

  if (needRasterize) {
    const rasterizedData = await rasterizeShapeElementForPptx(el).catch((err) => {
      console.warn('[PPTX Export] 形状栅格化失败，回退原生形状导出:', err)
      return null
    })
    if (rasterizedData) {
      const imgOpts: PptxGenJS.ImageProps = {
        x: pxToInch(el.x),
        y: pxToInch(el.y),
        w: pxToInch(el.width),
        h: pxToInch(el.height),
        rotate: el.rotate,
        data: rasterizedData,
      }
      if (el.flipH) imgOpts.flipH = true
      if (el.flipV) imgOpts.flipV = true
      if (el.opacity !== undefined && el.opacity < 1) {
        imgOpts.transparency = Math.round((1 - el.opacity) * 100)
      }
      const hyperlink = resolveElementHyperlink(el.link, context)
      if (hyperlink) {
        imgOpts.hyperlink = hyperlink
      }
      slide.addImage(imgOpts)
      return
    }
  }

  const hasSolidFill = el.fill !== 'transparent' && el.fill !== 'none' && !!el.fill
  const solidFill = hasSolidFill ? buildPptxFillFromColor(el.fill) : undefined

  const shapeOpts: PptxGenJS.ShapeProps = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(el.height),
    rotate: el.rotate,
    fill: el.pattern
      ? (solidFill || { color: 'D9D9D9' })
      : el.gradient
        ? gradientToFill(el.gradient)
        : hasSolidFill
          ? (solidFill || { color: hexToRGB(el.fill) })
          : { type: 'none' as const },
  }

  if (el.outline) {
    const lineAlpha = parseAlpha(el.outline.color)
    const lineCfg: PptxGenJS.ShapeLineProps = {
      color: hexToRGB(el.outline.color),
      width: el.outline.width,
      dashType: mapLineStyleToDashType(el.outline.style),
    }
    if (lineAlpha < 1) lineCfg.transparency = Math.round((1 - lineAlpha) * 100)
    shapeOpts.line = lineCfg
  }

  if (el.shadow) {
    const shadowOpacity = resolveShadowOpacity(el.shadow, 0.5)
    shapeOpts.shadow = {
      type: 'outer',
      blur: el.shadow.blur,
      offset: Math.sqrt(el.shadow.h * el.shadow.h + el.shadow.v * el.shadow.v),
      color: hexToRGB(el.shadow.color),
      opacity: shadowOpacity,
      angle: Math.atan2(el.shadow.v, el.shadow.h) * (180 / Math.PI),
    }
  }

  if (el.flipH) shapeOpts.flipH = true
  if (el.flipV) shapeOpts.flipV = true

  // roundRect 四角一致时映射为原生 rectRadius；非一致时走 custGeom。
  if (shapeType === ('roundRect' as PptxGenJS.ShapeType) && canMapRoundRectNative) {
    const kp = Math.max(0, Math.min(0.5, getRoundRectUniformRatio(el)))
    if (kp > 0) {
      const radiusPx = Math.min(el.width, el.height) * kp
      ;(shapeOpts as Record<string, unknown>).rectRadius = pxToInch(radiusPx)
    }
  }

  // 透明度
  if (el.opacity !== undefined && el.opacity < 1) {
    (shapeOpts as Record<string, unknown>).transparency = Math.round((1 - el.opacity) * 100)
  }

  const hyperlink = resolveElementHyperlink(el.link, context)
  if (hyperlink) {
    shapeOpts.hyperlink = hyperlink
  }

  // 未命中原生 shape（freeform / 未映射）或 keypoint 非原生可表达时，优先走 custGeom 矢量导出
  const useCustGeom =
    !!customGeomPoints && (
      !shapeTypeMatched
      || !el.pptxShapeType
      || (hasCustomShapeKeypointOverrides(el) && !canMapRoundRectNative)
    )

  // B3-02: 形状含文字时用 addText+shape 合并为单个 PPTX 对象，
  // 使文字随形状旋转/裁剪，且在 PowerPoint 中不可独立选中/移动。
  if (el.text?.content) {
    const pseudoTextEl: PPTTextElement = {
      id: el.id + '_text',
      type: 'text',
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      rotate: 0,
      opacity: 1,
      locked: false,
      content: el.text.content,
      defaultFontName: el.text.defaultFontName || 'Microsoft YaHei',
      defaultFontSize: el.text.defaultFontSize,
      defaultColor: el.text.defaultColor || '#333333',
      defaultColorThemeKey: el.text.defaultColorThemeKey,
    }
    const textParts = parseHtmlToTextProps(el.text.content, pseudoTextEl, context)
    const textHyperlink = resolveElementHyperlink(el.link, context)
    const textShapeOpts: Record<string, unknown> = {
      ...shapeOpts,
      margin: [4, 8, 4, 8],
      align: el.text.align || 'left',
      valign: (el.text.verticalAlign || 'top') as 'top' | 'middle' | 'bottom',
      ...(textHyperlink ? { hyperlink: textHyperlink } : {}),
    }
    if (useCustGeom) {
      textShapeOpts.shape = 'custGeom'
      textShapeOpts.points = customGeomPoints
    } else {
      textShapeOpts.shape = shapeType
    }
    slide.addText(textParts, textShapeOpts as PptxGenJS.TextPropsOptions)
  } else if (useCustGeom) {
    slide.addShape('custGeom' as PptxGenJS.ShapeType, {
      ...shapeOpts,
      points: customGeomPoints,
    })
  } else {
    slide.addShape(shapeType, shapeOpts)
  }

  // pattern fill（图片/图案填充）：
  // - data URL 且格式受支持时，后处理阶段会注入原生 blipFill（可编辑）
  // - 其余来源保持当前降级/栅格化策略（优先稳定性）
}

// ── 线条 ──

function addLineElement(
  slide: PptxGenJS.Slide,
  el: PPTLineElement,
  context: PPTXExportContext,
) {
  const start = normalizeLineCoord(el.start, [0, 0])
  const endFallback: [number, number] = [Math.max(toFiniteNumber(el.width, 100), 1), 0]
  const end = normalizeLineCoord(el.end, endFallback)
  const lineWidth = Math.max(0.1, toFiniteNumber(el.lineWidth, 2))
  const linePoints: [PPTLineElement['points'][number], PPTLineElement['points'][number]] = [
    el.points?.[0] || '',
    el.points?.[1] || '',
  ]

  const lineHex = hexToRGB(el.color)
  const colorAlpha = parseAlpha(el.color)
  const mergedAlpha = Math.max(0, Math.min(1, colorAlpha * (el.opacity ?? 1)))
  const lineCfg: PptxGenJS.ShapeLineProps = {
    color: lineHex,
    // 线宽在 TabSlide 数据层按 pt 语义存储（与 shape.outline.width、后端 python-pptx 保持一致），
    // 这里直接透传，避免再次 px->pt 导致线条导出变细。
    width: Math.max(0.1, lineWidth),
    dashType: mapLineStyleToDashType(el.style),
    beginArrowType: mapLinePointToArrowType(linePoints[0]),
    endArrowType: mapLinePointToArrowType(linePoints[1]),
  }
  if (mergedAlpha < 1) lineCfg.transparency = Math.round((1 - mergedAlpha) * 100)

  // 非直线用 custom geometry 精确导出，避免连接器近似导致折线/三次曲线失真。
  if (el.broken || el.broken2 || el.curve || el.cubic) {
    const geom = getLineGeometryBounds(el)
    const shapeOpts: PptxGenJS.ShapeProps = {
      x: pxToInch(el.x + geom.minX),
      y: pxToInch(el.y + geom.minY),
      w: pxToInch(Math.max(geom.width, 1)),
      h: pxToInch(Math.max(geom.height, 1)),
      fill: { type: 'none' as const },
      line: lineCfg,
      points: buildLineCustomPoints(geom, el),
      flipH: !!el.flipH,
      flipV: !!el.flipV,
    }

    if (el.rotate) shapeOpts.rotate = el.rotate
    if (el.shadow) {
      const shadowOpacity = resolveShadowOpacity(el.shadow, 0.5)
      shapeOpts.shadow = {
        type: 'outer',
        blur: el.shadow.blur,
        offset: Math.sqrt(el.shadow.h * el.shadow.h + el.shadow.v * el.shadow.v),
        color: hexToRGB(el.shadow.color),
        opacity: shadowOpacity,
        angle: Math.atan2(el.shadow.v, el.shadow.h) * (180 / Math.PI),
      }
    }
    const hyperlink = resolveElementHyperlink(el.link, context)
    if (hyperlink) {
      shapeOpts.hyperlink = hyperlink
    }
    slide.addShape('custGeom' as PptxGenJS.ShapeType, shapeOpts)
    return
  }

  const x1 = pxToInch(el.x + start[0])
  const y1 = pxToInch(el.y + start[1])
  const x2 = pxToInch(el.x + end[0])
  const y2 = pxToInch(el.y + end[1])
  const baseFlipH = x1 > x2
  const baseFlipV = y1 > y2
  const finalFlipH = baseFlipH !== !!el.flipH
  const finalFlipV = baseFlipV !== !!el.flipV

  const lineOpts: PptxGenJS.ShapeProps = {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1) || 0.01,
    h: Math.abs(y2 - y1) || 0.01,
    line: lineCfg,
    flipV: finalFlipV,
    flipH: finalFlipH,
  }

  if (el.rotate) lineOpts.rotate = el.rotate

  if (el.shadow) {
    const shadowOpacity = resolveShadowOpacity(el.shadow, 0.5)
    lineOpts.shadow = {
      type: 'outer',
      blur: el.shadow.blur,
      offset: Math.sqrt(el.shadow.h * el.shadow.h + el.shadow.v * el.shadow.v),
      color: hexToRGB(el.shadow.color),
      opacity: shadowOpacity,
      angle: Math.atan2(el.shadow.v, el.shadow.h) * (180 / Math.PI),
    }
  }

  const hyperlink = resolveElementHyperlink(el.link, context)
  if (hyperlink) {
    lineOpts.hyperlink = hyperlink
  }

  slide.addShape('line' as PptxGenJS.ShapeType, lineOpts)
}

// ── LaTeX 公式 ──

function addLatexElement(
  slide: PptxGenJS.Slide,
  el: PPTLatexElement,
  context: PPTXExportContext,
) {
  let svgMarkup = ''
  const color = el.color || '#111111'
  const strokeWidth = Number.isFinite(el.strokeWidth) ? Math.max(0, el.strokeWidth) : 0

  if (el.svg) {
    svgMarkup = el.svg
  } else if (el.path && el.viewBox) {
    svgMarkup = buildLatexSvgFromPath(
      el.path,
      el.viewBox,
      color,
      strokeWidth,
    )
  } else if (el.latex.trim()) {
    try {
      const rendered = renderLatexToSvg(el.latex, { display: true, color })
      svgMarkup = rendered.svg
    } catch {
      svgMarkup = buildLatexPlaceholderSvg(el.latex, color, el.width, el.height)
    }
  }

  if (svgMarkup) {
    svgMarkup = applyColorToLatexSvg(svgMarkup, color)
    svgMarkup = applyStrokeWidthToLatexSvg(svgMarkup, strokeWidth)
  }

  if (!svgMarkup) {
    addPlaceholder(slide, el)
    return
  }

  const altText = encodeLatexMetadata({
    latex: el.latex,
    svg: el.svg || svgMarkup,
    ...(el.path ? { path: el.path } : {}),
    ...(el.viewBox ? { viewBox: el.viewBox } : {}),
    color,
    strokeWidth,
    fixedRatio: el.fixedRatio,
  })

  const imgOpts: PptxGenJS.ImageProps = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(el.height),
    rotate: el.rotate,
    data: svgToDataUrl(svgMarkup),
    altText,
  }

  if (el.opacity !== undefined && el.opacity < 1) {
    imgOpts.transparency = Math.round((1 - el.opacity) * 100)
  }
  if (el.flipH) imgOpts.flipH = true
  if (el.flipV) imgOpts.flipV = true
  const hyperlink = resolveElementHyperlink(el.link, context)
  if (hyperlink) {
    imgOpts.hyperlink = hyperlink
  }

  slide.addImage(imgOpts)
}

const MEDIA_EXT_FROM_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-msvideo': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/mpeg': 'mpeg',
  'video/mpg': 'mpg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/mp4a-latm': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/x-ms-wma': 'wma',
}

function parseBase64DataUrl(src: string): { mime: string; base64: string } | null {
  if (!src || typeof src !== 'string') return null
  const trimmed = src.trim()
  if (!trimmed) return null

  const payload = trimmed.toLowerCase().startsWith('data:')
    ? trimmed.slice(5)
    : trimmed
  const commaIdx = payload.indexOf(',')
  if (commaIdx <= 0) return null

  const header = payload.slice(0, commaIdx).trim()
  const base64Part = payload.slice(commaIdx + 1).trim().replace(/\s+/g, '')
  if (!header || !base64Part) return null

  const headerParts = header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  if (headerParts.length === 0) return null

  const mime = (headerParts[0] || '').toLowerCase()
  if (!mime.includes('/')) return null
  const hasBase64Flag = headerParts.slice(1).some((part) => part.toLowerCase() === 'base64')
  if (!hasBase64Flag) return null

  return {
    mime,
    base64: base64Part,
  }
}

function sanitizeMediaExt(raw?: string): string | undefined {
  if (!raw) return undefined
  const ext = raw.trim().toLowerCase().replace(/^\./, '')
  if (!ext) return undefined
  return ext.split('?')[0]?.split('#')[0] || undefined
}

function detectMediaExtFromPath(path: string): string | undefined {
  if (!path) return undefined
  const clean = path.split('#')[0]?.split('?')[0] || path
  const last = clean.split('/').pop() || clean
  const idx = last.lastIndexOf('.')
  if (idx <= 0 || idx >= last.length - 1) return undefined
  return sanitizeMediaExt(last.slice(idx + 1))
}

function resolveMediaExt(src: string, extHint?: string): string | undefined {
  const normalizedHint = sanitizeMediaExt(extHint)
  if (normalizedHint) return normalizedHint
  const parsed = parseBase64DataUrl(src)
  if (parsed) return MEDIA_EXT_FROM_MIME[parsed.mime]
  return detectMediaExtFromPath(src)
}

function buildMediaSourcePayload(
  src: string,
  extHint?: string,
): { data?: string; path?: string; extn?: string } | null {
  if (!src || typeof src !== 'string') return null
  const trimmed = src.trim()
  if (!trimmed) return null
  const extn = resolveMediaExt(trimmed, extHint)

  const parsed = parseBase64DataUrl(trimmed)
  if (parsed) {
    return {
      data: `${parsed.mime};base64,${parsed.base64}`,
      ...(extn ? { extn } : {}),
    }
  }

  if (trimmed.includes('base64,') && /^(audio|video)\//i.test(trimmed)) {
    return {
      data: trimmed,
      ...(extn ? { extn } : {}),
    }
  }

  return {
    path: trimmed,
    ...(extn ? { extn } : {}),
  }
}

function normalizeMediaCoverData(poster?: string): string | undefined {
  if (!poster || typeof poster !== 'string') return undefined
  const trimmed = poster.trim()
  const parsed = parseBase64DataUrl(trimmed)
  if (parsed && parsed.mime.startsWith('image/')) {
    return `${parsed.mime};base64,${parsed.base64}`
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }
  return undefined
}

function addVideoElement(slide: PptxGenJS.Slide, el: PPTVideoElement, context: PPTXExportContext): void {
  try {
    const media = buildMediaSourcePayload(el.src, el.ext)
    if (!media) {
      context.warn({
        code: 'media_embed_failed',
        message: '视频源无效，已降级为占位图形',
        elementId: el.id,
        elementType: el.type,
      })
      addPlaceholder(slide, el)
      addOverlayHyperlinkIfNeeded(slide, el, context)
      return
    }

    const mediaOpts: PptxGenJS.MediaProps = {
      type: 'video',
      x: pxToInch(el.x),
      y: pxToInch(el.y),
      w: pxToInch(el.width),
      h: pxToInch(el.height),
      ...(media.data ? { data: media.data } : {}),
      ...(media.path ? { path: media.path } : {}),
      ...(media.extn ? { extn: media.extn } : {}),
      ...(el.name ? { objectName: el.name } : {}),
    }

    const cover = normalizeMediaCoverData(el.poster)
    if (cover) mediaOpts.cover = cover

    slide.addMedia(mediaOpts)
    addOverlayHyperlinkIfNeeded(slide, el, context)
  } catch (err) {
    context.warn({
      code: 'media_embed_failed',
      message: `视频嵌入失败，已降级为占位图形: ${(err as Error).message}`,
      elementId: el.id,
      elementType: el.type,
    })
    addPlaceholder(slide, el)
    addOverlayHyperlinkIfNeeded(slide, el, context)
  }
}

function addAudioElement(slide: PptxGenJS.Slide, el: PPTAudioElement, context: PPTXExportContext): void {
  try {
    const media = buildMediaSourcePayload(el.src, el.ext)
    if (!media) {
      context.warn({
        code: 'media_embed_failed',
        message: '音频源无效，已降级为占位图形',
        elementId: el.id,
        elementType: el.type,
      })
      addPlaceholder(slide, el)
      addOverlayHyperlinkIfNeeded(slide, el, context)
      return
    }

    const mediaOpts: PptxGenJS.MediaProps = {
      type: 'audio',
      x: pxToInch(el.x),
      y: pxToInch(el.y),
      w: pxToInch(el.width),
      h: pxToInch(el.height),
      ...(media.data ? { data: media.data } : {}),
      ...(media.path ? { path: media.path } : {}),
      ...(media.extn ? { extn: media.extn } : {}),
      ...(el.name ? { objectName: el.name } : {}),
    }

    slide.addMedia(mediaOpts)
    addOverlayHyperlinkIfNeeded(slide, el, context)
  } catch (err) {
    context.warn({
      code: 'media_embed_failed',
      message: `音频嵌入失败，已降级为占位图形: ${(err as Error).message}`,
      elementId: el.id,
      elementType: el.type,
    })
    addPlaceholder(slide, el)
    addOverlayHyperlinkIfNeeded(slide, el, context)
  }
}

function mapLinePointToArrowType(
  point: PPTLineElement['points'][number],
): PptxGenJS.ShapeLineProps['beginArrowType'] | undefined {
  if (!point) return undefined
  if (point === 'dot') return 'oval'
  if (point === 'diamond') return 'diamond'
  if (point === 'stealth') return 'stealth'
  if (point === 'triangle') return 'triangle'
  return 'arrow'
}

function mapLineStyleToDashType(style: PPTLineElement['style']): NonNullable<PptxGenJS.ShapeLineProps['dashType']> {
  switch (style) {
    case 'dashed': return 'dash'
    case 'dotted': return 'sysDot'
    case 'dashDot': return 'dashDot'
    case 'longDash': return 'lgDash'
    case 'longDashDot': return 'lgDashDot'
    default: return 'solid'
  }
}

function toFiniteNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function normalizeLineCoord(raw: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(raw) || raw.length < 2) return fallback
  return [
    toFiniteNumber(raw[0], fallback[0]),
    toFiniteNumber(raw[1], fallback[1]),
  ]
}

function getLineGeometryBounds(el: PPTLineElement) {
  const start = normalizeLineCoord(el.start, [0, 0])
  const endFallback: [number, number] = [Math.max(toFiniteNumber(el.width, 100), 1), 0]
  const end = normalizeLineCoord(el.end, endFallback)

  const pts: Array<[number, number]> = [start, end]
  if (el.broken) pts.push(normalizeLineCoord(el.broken, start))
  if (el.broken2) {
    const broken2 = normalizeLineCoord(el.broken2, start)
    pts.push(broken2)
    const mid: [number, number] = [(start[0] + end[0]) / 2, (broken2[1] + end[1]) / 2]
    pts.push(mid)
  }
  if (el.curve) pts.push(normalizeLineCoord(el.curve, start))
  if (el.cubic) {
    pts.push(normalizeLineCoord(el.cubic[0], start))
    pts.push(normalizeLineCoord(el.cubic[1], end))
  }

  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  return {
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function buildLineCustomPoints(
  geom: { minX: number; minY: number },
  el: PPTLineElement,
): NonNullable<PptxGenJS.ShapeProps['points']> {
  const startAbs = normalizeLineCoord(el.start, [0, 0])
  const endFallback: [number, number] = [Math.max(toFiniteNumber(el.width, 100), 1), 0]
  const endAbs = normalizeLineCoord(el.end, endFallback)
  const toIn = (pt: [number, number]) => ({
    x: pxToInch(pt[0] - geom.minX),
    y: pxToInch(pt[1] - geom.minY),
  })

  const start = toIn(startAbs)
  const end = toIn(endAbs)
  const points: NonNullable<PptxGenJS.ShapeProps['points']> = [
    { ...start, moveTo: true },
  ]

  if (el.cubic) {
    const cp1 = toIn(normalizeLineCoord(el.cubic[0], startAbs))
    const cp2 = toIn(normalizeLineCoord(el.cubic[1], endAbs))
    points.push({
      x: end.x,
      y: end.y,
      curve: {
        type: 'cubic',
        x1: cp1.x,
        y1: cp1.y,
        x2: cp2.x,
        y2: cp2.y,
      },
    })
    return points
  }

  if (el.curve) {
    const cp = toIn(normalizeLineCoord(el.curve, startAbs))
    points.push({
      x: end.x,
      y: end.y,
      curve: {
        type: 'quadratic',
        x1: cp.x,
        y1: cp.y,
      },
    })
    return points
  }

  if (el.broken2) {
    const broken2 = normalizeLineCoord(el.broken2, startAbs)
    const bp = toIn(broken2)
    const mid = toIn([
      (startAbs[0] + endAbs[0]) / 2,
      (broken2[1] + endAbs[1]) / 2,
    ] as [number, number])
    points.push(bp)
    points.push(mid)
    points.push(end)
    return points
  }

  if (el.broken) {
    points.push(toIn(normalizeLineCoord(el.broken, startAbs)))
    points.push(end)
    return points
  }

  points.push(end)
  return points
}

// ── 表格 ──

const _fontSizeAttrToPtMap: Record<number, number> = {
  1: 8, 2: 10, 3: 12, 4: 14, 5: 18, 6: 24, 7: 36,
}

function _fontSizeAttrToPt(size: number): number | undefined {
  return _fontSizeAttrToPtMap[size]
}

interface _TableParaEntry {
  node: Node
  bulletType?: 'bullet' | 'number'
  numberType?: string
  bulletChar?: string
  indentLevel: number
}

function _flattenTableListItems(
  listEl: HTMLElement,
  entries: _TableParaEntry[],
  indentLevel: number,
): void {
  const tag = listEl.tagName.toUpperCase()
  const bulletType: 'bullet' | 'number' = tag === 'UL' ? 'bullet' : 'number'
  const olType = tag === 'OL' ? listEl.getAttribute('type') : null
  const numberType = olType ? (_olTypeToNumberType[olType] || 'arabicPeriod') : 'arabicPeriod'
  const bulletChar = tag === 'UL' ? (listEl.getAttribute('data-bullet-char') || undefined) : undefined

  for (const child of Array.from(listEl.children)) {
    if (child.tagName.toUpperCase() !== 'LI') continue
    entries.push({
      node: child,
      bulletType,
      numberType: bulletType === 'number' ? numberType : undefined,
      bulletChar,
      indentLevel,
    })
    for (const liChild of Array.from(child.children)) {
      const childTag = (liChild as HTMLElement).tagName?.toUpperCase?.()
      if (childTag === 'UL' || childTag === 'OL') {
        _flattenTableListItems(liChild as HTMLElement, entries, indentLevel + 1)
      }
    }
  }
}

/**
 * 解析 richText HTML 为 pptxgenjs TextProps[] 数组。
 *
 * 使用 DOM 解析，支持嵌套标签与段落级对齐信息。
 * 降级：解析失败返回 null，调用方使用纯文本兜底。
 */
export function parseRichTextForPptx(
  html: string,
  context: PPTXExportContext,
): { textProps: PptxGenJS.TextProps[]; firstParagraphAlign?: PptxGenJS.TextPropsOptions['align'] } | null {
  if (typeof document === 'undefined' || !html) return null

  try {
    const container = document.createElement('div')
    container.innerHTML = html

    const paragraphNodes = Array.from(container.childNodes)
      .filter((n) => !(n.nodeType === Node.TEXT_NODE && !(n.textContent || '').trim()))
    if (paragraphNodes.length === 0) return null

    const paraEntries: _TableParaEntry[] = []
    for (const node of paragraphNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as HTMLElement).tagName.toUpperCase()
        if (tag === 'UL' || tag === 'OL') {
          _flattenTableListItems(node as HTMLElement, paraEntries, 0)
          continue
        }
      }
      paraEntries.push({ node, indentLevel: 0 })
    }
    if (paraEntries.length === 0) return null

    const result: PptxGenJS.TextProps[] = []
    let firstParagraphAlign: PptxGenJS.TextPropsOptions['align'] | undefined

    paraEntries.forEach((entry, pi) => {
      const paraEl = entry.node.nodeType === Node.ELEMENT_NODE
        ? entry.node as HTMLElement
        : null
      const paraAlignRaw = paraEl?.style?.textAlign as string | undefined
      const paraAlign = paraAlignRaw && ['left', 'center', 'right', 'justify'].includes(paraAlignRaw)
        ? paraAlignRaw as PptxGenJS.TextPropsOptions['align']
        : undefined
      const paraLineHeightRaw = paraEl?.style?.lineHeight
      let paraLineSpacing: number | undefined
      if (paraLineHeightRaw) {
        const lhNum = parseFloat(paraLineHeightRaw)
        if (Number.isFinite(lhNum) && lhNum > 0 && lhNum <= 9.99) {
          paraLineSpacing = lhNum
        }
      }

      if (!firstParagraphAlign && paraAlign) {
        firstParagraphAlign = paraAlign
      }

      const runs = extractInlineRunsForTableRichText(entry.node, context)
      if (runs.length === 0) {
        runs.push({ text: '', options: {} })
      }

      runs.forEach((run, ri) => {
        const opts: PptxGenJS.TextPropsOptions = { ...(run.options || {}) }
        if (ri === 0 && paraAlign) {
          opts.align = paraAlign
        }
        if (ri === 0 && paraLineSpacing) {
          opts.lineSpacingMultiple = paraLineSpacing
        }
        if (ri === 0 && entry.bulletType) {
          if (entry.bulletType === 'number') {
            opts.bullet = { type: 'number', numberType: (entry.numberType || 'arabicPeriod') as never }
          } else if (entry.bulletChar) {
            opts.bullet = { characterCode: entry.bulletChar.codePointAt(0)!.toString(16).toUpperCase() }
          } else {
            opts.bullet = true
          }
          if (entry.indentLevel > 0) {
            opts.indentLevel = entry.indentLevel
          }
        }
        if (pi < paraEntries.length - 1 && ri === runs.length - 1) {
          opts.breakLine = true
        }
        result.push({ text: run.text, options: opts })
      })
    })

    if (result.length === 0) {
      return null
    }

    return { textProps: result, firstParagraphAlign }
  } catch {
    return null
  }
}

interface _TableInlineState {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fontSizePt?: number
  fontFace?: string
  hyperlink?: PptxGenJS.HyperlinkProps
}

function extractInlineRunsForTableRichText(
  node: Node,
  context: PPTXExportContext,
): PptxGenJS.TextProps[] {
  const runs: PptxGenJS.TextProps[] = []
  walkTableRichTextNode(node, {}, runs, context)
  return runs
}

function walkTableRichTextNode(
  node: Node,
  inherited: _TableInlineState,
  runs: PptxGenJS.TextProps[],
  context: PPTXExportContext,
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || ''
    if (!text) return

    const opts: PptxGenJS.TextPropsOptions = {}
    if (inherited.bold) opts.bold = true
    if (inherited.italic) opts.italic = true
    if (inherited.underline) opts.underline = { style: 'sng' }
    if (inherited.strike) opts.strike = 'sngStrike'
    if (inherited.color) opts.color = hexToRGB(inherited.color)
    if (inherited.fontSizePt) opts.fontSize = inherited.fontSizePt
    if (inherited.fontFace) opts.fontFace = inherited.fontFace
    if (inherited.hyperlink) opts.hyperlink = inherited.hyperlink

    runs.push({ text, options: opts })
    return
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as HTMLElement
  const tag = el.tagName.toUpperCase()

  if (tag === 'BR') {
    runs.push({ text: '\n', options: {} })
    return
  }

  if (tag === 'UL' || tag === 'OL') return

  const next: _TableInlineState = { ...inherited }
  const style = el.style

  if (tag === 'B' || tag === 'STRONG') next.bold = true
  if (tag === 'I' || tag === 'EM') next.italic = true
  if (tag === 'U') next.underline = true
  if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.strike = true

  if (style.fontWeight && (style.fontWeight === 'bold' || parseInt(style.fontWeight, 10) >= 700)) {
    next.bold = true
  }
  if (style.fontStyle === 'italic') next.italic = true
  const textDecoration = `${style.textDecoration} ${style.textDecorationLine}`.toLowerCase()
  if (textDecoration.includes('underline')) next.underline = true
  if (textDecoration.includes('line-through')) next.strike = true

  if (style.color) {
    const c = cssColorToHex(style.color)
    if (c) next.color = c
  }

  if (style.fontSize) {
    const sizePt = parseCssFontSizeToPt(style.fontSize)
    if (sizePt) next.fontSizePt = sizePt
  }

  if (style.fontFamily) {
    const fontFace = pickPrimaryFontFamily(style.fontFamily)
    if (fontFace) next.fontFace = fontFace
  }

  if (tag === 'FONT') {
    const colorAttr = el.getAttribute('color')
    if (colorAttr) {
      const c = cssColorToHex(colorAttr)
      if (c) next.color = c
    }
    const faceAttr = el.getAttribute('face')
    if (faceAttr) {
      const fontFace = pickPrimaryFontFamily(faceAttr)
      if (fontFace) next.fontFace = fontFace
    }
    const sizeAttr = el.getAttribute('size')
    if (sizeAttr) {
      const sizePt = _fontSizeAttrToPt(parseInt(sizeAttr, 10))
      if (sizePt) next.fontSizePt = sizePt
    }
  }

  if (tag === 'A') {
    const href = (el as HTMLAnchorElement).getAttribute('href')
    const hyperlink = resolveRichTextInlineHyperlink(href || '', context)
    if (hyperlink) next.hyperlink = hyperlink
  }

  for (const child of Array.from(el.childNodes)) {
    walkTableRichTextNode(child, next, runs, context)
  }
}

function parseCssLengthToPt(rawSize: string): number | undefined {
  if (!rawSize) return undefined
  const num = parseFloat(rawSize)
  if (Number.isNaN(num)) return undefined

  const lower = rawSize.trim().toLowerCase()
  if (lower.endsWith('px')) return Number(pxToPt(num).toFixed(3))
  if (lower.endsWith('pt') || /^-?\d+(\.\d+)?$/.test(lower)) return Number(num.toFixed(3))
  return undefined
}

function parseCssLengthToPx(rawSize: string): number | undefined {
  if (!rawSize) return undefined
  const num = parseFloat(rawSize)
  if (Number.isNaN(num)) return undefined

  const lower = rawSize.trim().toLowerCase()
  if (lower.endsWith('pt')) return Number((num / 0.75).toFixed(3))
  if (lower.endsWith('px') || /^-?\d+(\.\d+)?$/.test(lower)) return Number(num.toFixed(3))
  return undefined
}

function parseCssFontSizeToPt(rawSize: string): number | undefined {
  const sizePt = parseCssLengthToPt(rawSize)
  if (sizePt === undefined || sizePt <= 0) return undefined
  return sizePt
}

const GENERIC_FONT_FAMILY_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])

function splitFirstFontFamilyToken(input: string): string {
  let quote: '"' | '\'' | null = null
  let depth = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === '\'') {
      const prev = i > 0 ? input[i - 1] : ''
      if (!prev || /\s|,|\(/.test(prev)) {
        quote = ch
        continue
      }
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (ch === ',' && depth === 0) {
      return input.slice(0, i)
    }
  }
  return input
}

function pickPrimaryFontFamily(fontFamily: string): string | undefined {
  if (!fontFamily) return undefined
  const first = splitFirstFontFamilyToken(fontFamily).trim().replace(/^['"]|['"]$/g, '')
  if (!first) return undefined
  const lower = first.toLowerCase()
  if (lower.startsWith('var(')) return undefined
  if (GENERIC_FONT_FAMILY_KEYWORDS.has(lower)) return undefined
  return first
}

function resolveFontFace(fontFamily?: string): string | undefined {
  if (!fontFamily) return undefined
  return pickPrimaryFontFamily(fontFamily)
}

function createTableBorderSpec(
  ri: number,
  ci: number,
  cell: { colspan?: number; rowspan?: number },
  totalRows: number,
  totalCols: number,
  outline: PPTElementOutline,
  borders: PPTTableElement['borders'] | undefined,
  innerBorderBottomColor: string,
  innerBorderRightColor: string,
): [PptxGenJS.BorderProps, PptxGenJS.BorderProps, PptxGenJS.BorderProps, PptxGenJS.BorderProps] {
  const resolved = resolveTableCellBorderSpecs({
    rowIdx: ri,
    colIdx: ci,
    totalRows,
    totalCols,
    cell,
    outline,
    borders,
    fallbackInsideHColor: innerBorderBottomColor,
    fallbackInsideVColor: innerBorderRightColor,
  })
  const toPptxBorder = (spec: PPTElementOutline | undefined): PptxGenJS.BorderProps => {
    if (!spec || spec.width <= 0) return { type: 'none' }
    const type: PptxGenJS.BorderProps['type'] = spec.style !== 'solid' ? 'dash' : 'solid'
    return {
      type,
      pt: Math.max(spec.width, 0),
      color: hexToRGB(spec.color),
    }
  }

  const top = toPptxBorder(resolved.top)
  const left = toPptxBorder(resolved.left)
  const bottom = toPptxBorder(resolved.bottom)
  const right = toPptxBorder(resolved.right)

  return [top, right, bottom, left]
}

function createTableBorderSpecWithCellOverrides(
  ri: number, ci: number,
  cell: { colspan?: number; rowspan?: number },
  totalRows: number, totalCols: number,
  outline: PPTElementOutline,
  borders: PPTTableElement['borders'] | undefined,
  innerBorderBottomColor: string, innerBorderRightColor: string,
  cellBorders: Partial<Record<'top' | 'right' | 'bottom' | 'left', { style: string; width: number; color: string }>>,
): [PptxGenJS.BorderProps, PptxGenJS.BorderProps, PptxGenJS.BorderProps, PptxGenJS.BorderProps] {
  const base = createTableBorderSpec(ri, ci, cell, totalRows, totalCols, outline, borders, innerBorderBottomColor, innerBorderRightColor)
  const toPptxBorder = (spec: { style: string; width: number; color: string } | undefined): PptxGenJS.BorderProps | undefined => {
    if (!spec) return undefined
    if (spec.width <= 0) return { type: 'none' }
    const type: PptxGenJS.BorderProps['type'] = spec.style !== 'solid' ? 'dash' : 'solid'
    return { type, pt: Math.max(spec.width, 0), color: hexToRGB(spec.color) }
  }
  return [
    toPptxBorder(cellBorders.top) ?? base[0],
    toPptxBorder(cellBorders.right) ?? base[1],
    toPptxBorder(cellBorders.bottom) ?? base[2],
    toPptxBorder(cellBorders.left) ?? base[3],
  ]
}

function addTableElement(
  slide: PptxGenJS.Slide,
  el: PPTTableElement,
  context: PPTXExportContext,
) {
  const valignMap: Record<string, 'top' | 'middle' | 'bottom'> = {
    top: 'top', middle: 'middle', bottom: 'bottom',
  }
  const cellMarginPt: [number, number, number, number] = [4.5, 7.5, 4.5, 7.5]

  const outline = el.outline || { style: 'solid' as const, width: 1, color: '#d0d0d0' }
  const normalizedBorders = normalizeTableBorders(el.borders, outline)
  const innerBorderVisible = (normalizedBorders?.insideH?.width ?? normalizedBorders?.insideV?.width) != null
    ? ((normalizedBorders?.insideH?.width || 0) > 0 || (normalizedBorders?.insideV?.width || 0) > 0)
    : outline.width > 0
  const tblTC = getTableThemeColors(el.theme, outline.color, innerBorderVisible)
  const totalRows = el.data.length
  const totalCols = getTableColumnCount(el.data)

  const rows: PptxGenJS.TableRow[] = el.data.map((row, ri) => {
    const rowCells: PptxGenJS.TableRow = []

    row.forEach((cell, ci) => {
      if ((cell.colspan ?? 1) <= 0 || (cell.rowspan ?? 1) <= 0) return

      const style = resolveTableCellStyle(cell)
      const cts = getCellThemeStyle(cell, ri, ci, totalRows, totalCols, el.theme, tblTC)
      const richTextParsed = cell.richText ? parseRichTextForPptx(cell.richText, context) : null

      // 背景色：theme 计算的 > 单元格自定义的
      const fillColor = cts.bgColor && cts.bgColor !== 'transparent' ? cts.bgColor : style.bgColor
      const fill = buildPptxFillFromColor(fillColor)

      // 文字颜色：theme 计算的 > 单元格自定义的
      const textColor = cts.textColor || style.color || '#333333'

      rowCells.push({
        text: richTextParsed?.textProps || cell.text || '',
        options: {
          // 表格单元格字号在数据层按 pt 存储，这里直接透传，避免二次 px→pt 缩小
          fontSize: typeof style.fontSize === 'number'
            ? style.fontSize
            : (typeof style.fontSize === 'string' ? (parseCssFontSizeToPt(style.fontSize) || 14) : 14),
          fontFace: resolveFontFace(style.fontName || style.fontFamily || undefined),
          color: hexToRGB(textColor),
          bold: cts.bold,
          italic: style.italic || false,
          underline: style.underline ? { style: 'sng' as const } : undefined,
          align: richTextParsed?.firstParagraphAlign
            || (style.align as PptxGenJS.TextPropsOptions['align'])
            || 'left',
          valign: valignMap[style.verticalAlign || 'middle'] || 'middle',
          fill,
          colspan: cell.colspan ?? 1,
          rowspan: cell.rowspan ?? 1,
          margin: style.padding
            ? [
                pxToPt(style.padding.paddingTop ?? 4),
                pxToPt(style.padding.paddingRight ?? 7),
                pxToPt(style.padding.paddingBottom ?? 4),
                pxToPt(style.padding.paddingLeft ?? 7),
              ]
            : cellMarginPt,
          border: style.cellBorders
            ? createTableBorderSpecWithCellOverrides(
                ri, ci, cell, totalRows, totalCols, outline, normalizedBorders,
                tblTC.borderBottomColor, tblTC.borderRightColor, style.cellBorders,
              )
            : createTableBorderSpec(
                ri, ci, cell, totalRows, totalCols, outline, normalizedBorders,
                tblTC.borderBottomColor, tblTC.borderRightColor,
              ),
        },
      })
    })

    return rowCells
  })

  const normalizedColWidths = normalizeTableColWidths(el.colWidths, totalCols)
  const colW = normalizedColWidths
    ? normalizedColWidths.map((w) => pxToInch(el.width * w))
    : undefined

  // 行高：优先使用逐行 rowHeights（并按元素高度缩放），否则回退均分+最小高度
  const normalizedRowHeights = el.rowHeights?.length
    ? normalizeTableRowHeights(
        el.rowHeights,
        totalRows,
        { totalHeight: el.height, minHeight: el.cellMinHeight || 0 },
      )
    : undefined
  const rowH = normalizedRowHeights?.length
    ? normalizedRowHeights.map((h) => pxToInch(h))
    : (() => {
        const uniformRowHeightPx = totalRows > 0
          ? Math.max(el.height / totalRows, el.cellMinHeight || 0)
          : 0
        return uniformRowHeightPx > 0
          ? Array(totalRows).fill(pxToInch(uniformRowHeightPx))
          : undefined
      })()

  slide.addTable(rows, {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(el.height),
    border: {
      type: 'none',
    },
    ...(colW ? { colW } : {}),
    ...(rowH ? { rowH } : {}),
    autoPage: false,
  })

  addOverlayHyperlinkIfNeeded(slide, el, context)
}

// ── 图表 ──

function addChartElement(slide: PptxGenJS.Slide, el: PPTChartElement, context: PPTXExportContext) {
  const { data, chartType, themeColors, options } = el
  const chartPalette = resolvePalette(themeColors).map((c) => c.replace('#', '').toUpperCase())

  // 前端 chartType → pptxgenjs CHART_NAME
  const chartTypeMap: Record<string, PptxGenJS.CHART_NAME> = {
    bar: 'bar',
    column: 'bar',
    line: 'line',
    area: 'area',
    pie: 'pie',
    ring: 'doughnut',
    radar: 'radar',
    scatter: 'scatter',
  }
  const pptxChartType = chartTypeMap[chartType] || 'bar'

  // 构建 pptxgenjs 图表数据
  const isPieType = chartType === 'pie' || chartType === 'ring'
  const isScatter = chartType === 'scatter'
  const isStacked = options?.stack === true

  let chartData: Array<{ name: string; labels?: string[]; values: unknown[] }>

  if (isScatter) {
    // 散点图数据格式: values 为 {x, y} 对象数组
    const xSeries = Array.isArray(data.xSeries) ? data.xSeries : []
    chartData = data.series.map((values: number[], i: number) => ({
      name: data.legends[i] || `Series ${i + 1}`,
      values: values.map((y: number, j: number) => {
        const xRow = Array.isArray(xSeries[i]) ? xSeries[i] : []
        let x = j + 1
        if (j < xRow.length) {
          const parsed = Number(xRow[j])
          if (!isNaN(parsed)) x = parsed
        } else if (j < data.labels.length) {
          const parsed = parseFloat(data.labels[j])
          if (!isNaN(parsed)) x = parsed
        }
        return { x, y: y ?? 0 }
      }),
    }))
  } else if (isPieType) {
    // 饼图/环形图：仅第一个系列
    chartData = [{
      name: data.legends[0] || 'Series 1',
      labels: data.labels,
      values: data.series[0] || [],
    }]
  } else {
    // 其他类型：所有系列
    chartData = data.series.map((values: number[], i: number) => ({
      name: data.legends[i] || `Series ${i + 1}`,
      labels: data.labels,
      values,
    }))
  }

  // 构建 options
  const showLegend = options?.showLegend ?? (isPieType ? true : data.series.length > 1)
  const legendPos = options?.legendPosition ?? 'b'

  const chartOpts: Record<string, unknown> & PptxGenJS.IChartOpts = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(el.height),
    showLegend,
    legendPos,
    showTitle: !!el.chartTitle,
    title: el.chartTitle || '',
  }

  // 旋转（IChartOpts 未声明 rotate，但 pptxgenjs 运行时支持）
  if (el.rotate) chartOpts.rotate = el.rotate

  // 数据标签（饼图/环形图使用 showPercent，其他类型使用 showValue）
  if (isPieType) {
    chartOpts.showPercent = options?.showDataLabel !== false
    chartOpts.showValue = false
  } else if (options?.showDataLabel) {
    chartOpts.showValue = true
    // 水平条形图（column）数据标签放在条尾
    if (chartType === 'column') {
      chartOpts.dataLabelPosition = 'r'
    }
  }

  // 系列颜色
  if (chartPalette.length) {
    chartOpts.chartColors = chartPalette
  }

  // 条形图方向（column = 水平条形图）
  if (chartType === 'column') {
    chartOpts.barDir = 'bar'
  }

  // 堆叠
  if (isStacked && !isPieType) {
    chartOpts.barGrouping = 'stacked'
  }

  // 平滑（折线图/面积图/散点平滑线）
  if (options?.lineSmooth && (chartType === 'line' || chartType === 'area' || chartType === 'scatter')) {
    chartOpts.lineSmooth = true
  }

  // 雷达图填充区域
  if (chartType === 'radar' && options?.radarFilled) {
    chartOpts.radarStyle = 'filled'
  }

  // 图表区域背景色
  if (el.fill) {
    chartOpts.chartArea = { fill: { color: hexToRGB(el.fill) } }
  }

  // 坐标轴文字颜色
  if (el.textColor) {
    const tc = hexToRGB(el.textColor)
    chartOpts.catAxisLabelColor = tc
    chartOpts.valAxisLabelColor = tc
    if (el.chartTitle) {
      chartOpts.titleColor = tc
    }
  }

  // 网格线颜色
  if (el.gridColor) {
    const gc = hexToRGB(el.gridColor)
    chartOpts.valGridLine = { color: gc }
    chartOpts.catGridLine = { color: gc }
  }

  // 饼图/环形图额外设置
  if (isPieType) {
    chartOpts.showLegend = showLegend
    chartOpts.legendPos = legendPos
  }

  // 翻转
  if (el.flipH) chartOpts.flipH = true
  if (el.flipV) chartOpts.flipV = true

  // 透明度
  if (el.opacity !== undefined && el.opacity < 1) {
    chartOpts.transparency = Math.round((1 - el.opacity) * 100)
  }

  slide.addChart(pptxChartType, chartData as unknown[], chartOpts)
  addOverlayHyperlinkIfNeeded(slide, el, context)
}

// ── 占位符 ──

function addImagePlaceholder(slide: PptxGenJS.Slide, el: PPTImageElement) {
  const shapeOpts: PptxGenJS.ShapeProps = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(el.height),
    rotate: el.rotate,
    fill: { color: 'F5F5F5' },
    line: { color: 'CCCCCC', width: 1, dashType: 'dash' },
  }
  if (el.flipH) shapeOpts.flipH = true
  if (el.flipV) shapeOpts.flipV = true
  if (el.opacity !== undefined && el.opacity < 1) {
    ;(shapeOpts as Record<string, unknown>).transparency = Math.round((1 - el.opacity) * 100)
  }

  slide.addShape('rect' as PptxGenJS.ShapeType, shapeOpts)
  if (el.width >= 64 && el.height >= 24) {
    slide.addText('图片不可用', {
      x: pxToInch(el.x),
      y: pxToInch(el.y),
      w: pxToInch(el.width),
      h: pxToInch(el.height),
      align: 'center',
      valign: 'middle',
      color: '888888',
      fontSize: 10,
    })
  }
}

function addOverlayHyperlinkIfNeeded(slide: PptxGenJS.Slide, el: PPTElement, context: PPTXExportContext): void {
  const hyperlink = resolveElementHyperlink(el.link, context)
  if (!hyperlink) return
  const opts: PptxGenJS.ShapeProps = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch((el as { height: number }).height),
    fill: { type: 'none' as const },
    line: { type: 'none' as const },
    hyperlink,
  }
  ;(opts as Record<string, unknown>).transparency = 100
  slide.addShape('rect' as PptxGenJS.ShapeType, opts)
}

function addPlaceholder(slide: PptxGenJS.Slide, el: PPTElement) {
  const isLine = el.type === 'line'
  const opts: PptxGenJS.ShapeProps = {
    x: pxToInch(el.x),
    y: pxToInch(el.y),
    w: pxToInch(el.width),
    h: pxToInch(isLine ? 4 : (el as { height: number }).height),
    fill: { color: 'F0F0F0' },
    line: { color: 'CCCCCC', width: 1 },
  }
  if ('rotate' in el && (el as { rotate?: number }).rotate) opts.rotate = (el as { rotate: number }).rotate
  if ('flipH' in el && (el as { flipH?: boolean }).flipH) opts.flipH = true
  if ('flipV' in el && (el as { flipV?: boolean }).flipV) opts.flipV = true
  if (el.opacity !== undefined && el.opacity < 1) {
    (opts as Record<string, unknown>).transparency = Math.round((1 - el.opacity) * 100)
  }
  slide.addShape('rect' as PptxGenJS.ShapeType, opts)
}

// ═══════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════

/** pptxShapeType → pptxgenjs ShapeType */
function mapPptxShapeType(pptxType?: string): { shapeType: PptxGenJS.ShapeType; exact: boolean } {
  if (!pptxType) {
    return { shapeType: 'rect' as PptxGenJS.ShapeType, exact: false }
  }

  // 完整映射：覆盖后端所有可能输出的形状类型
  const map: Record<string, string> = {
    // 矩形类
    rect: 'rect',
    roundRect: 'roundRect',
    round1Rect: 'round1Rect',
    round2SameRect: 'round2SameRect',
    round2DiagRect: 'round2DiagRect',
    snip2DiagRect: 'snip2DiagRect',
    snipRoundRect: 'snipRoundRect',
    // 基础形状
    ellipse: 'ellipse',
    triangle: 'triangle',
    rtTriangle: 'rtTriangle',
    rightTriangle: 'rtTriangle',
    diamond: 'diamond',
    parallelogram: 'parallelogram',
    trapezoid: 'trapezoid',
    pentagon: 'pentagon',
    hexagon: 'hexagon',
    octagon: 'octagon',
    // 星形
    star4: 'star4',
    star5: 'star5',
    star6: 'star6',
    star6Point: 'star6',
    // 箭头
    rightArrow: 'rightArrow',
    leftArrow: 'leftArrow',
    upArrow: 'upArrow',
    downArrow: 'downArrow',
    leftRightArrow: 'leftRightArrow',
    upDownArrow: 'upDownArrow',
    notchedRightArrow: 'notchedRightArrow',
    // 特殊形状
    cloud: 'cloud',
    heart: 'heart',
    lightningBolt: 'lightningBolt',
    plus: 'plus',
    cross: 'plus',
    chevron: 'chevron',
    // 标注框 — pptxgenjs 可能不支持全部，降级为 rect 由 fallback 处理
    callout1: 'callout1',
    callout2: 'callout2',
  }

  const mapped = map[pptxType]
  if (!mapped) {
    return { shapeType: 'rect' as PptxGenJS.ShapeType, exact: false }
  }
  return { shapeType: mapped as PptxGenJS.ShapeType, exact: true }
}

/** 渐变 → pptxgenjs fill */
function gradientToFill(gradient: Gradient): PptxGenJS.ShapeFillProps {
  if (gradient.type === 'linear') {
    return {
      color: hexToRGB(gradient.colors[0]?.color || '#FFFFFF'),
      // pptxgenjs 不完整支持渐变，降级为首色
    }
  }
  return {
    color: hexToRGB(gradient.colors[0]?.color || '#FFFFFF'),
  }
}

/**
 * 解析 HTML 内容为 pptxgenjs 文本段落
 *
 * 结构感知：正确处理 <p>、嵌套 <ul>/<ol>/<li>，
 * 提取段落级属性（对齐、段前/段后间距、行距、列表符号/层级）。
 */
function parseHtmlToTextProps(
  html: string,
  el: PPTTextElement,
  context: PPTXExportContext,
): PptxGenJS.TextProps[] {
  if (!html) return [{ text: '', options: {} }]

  // Node.js: no DOM — fallback to regex-stripped plain text
  if (typeof document === 'undefined') {
    const plain = html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    return [{
      text: plain,
      options: {
        fontSize: el.defaultFontSize || pxToPt(14),
        fontFace: resolveFontFace(el.defaultFontName),
        color: resolveTextColorToken(el.defaultColor, normalizeThemeTextColorKey(el.defaultColorThemeKey)),
        ...(el.defaultFontWeight === 'bold' ? { bold: true } : {}),
        ...(el.defaultTextAlign ? { align: el.defaultTextAlign as PptxGenJS.TextPropsOptions['align'] } : {}),
      },
    }]
  }

  const div = document.createElement('div')
  div.innerHTML = html

  const paragraphs: _ParagraphData[] = []

  collectParagraphs(div, paragraphs, el, context, undefined, 0)

  if (paragraphs.length === 0) {
    return [{ text: '', options: {} }]
  }

  // B1-04: 末段不应注入 paraSpaceAfter —— CSS `p + p` 只在段间生效，
  // PPTX 末段的 paraSpaceAfter 会在文本框底部多出空白。
  // 单段落或多段落均需删除末段 paraSpaceAfter（上文已保证 paragraphs.length >= 1）。
  const lastPara = paragraphs[paragraphs.length - 1]
  if (lastPara.paraOptions.paraSpaceAfter !== undefined) {
    delete lastPara.paraOptions.paraSpaceAfter
  }

  const result: PptxGenJS.TextProps[] = []

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi]
    const isLast = pi === paragraphs.length - 1

    if (para.runs.length === 0) {
      const opts: PptxGenJS.TextPropsOptions = {
        ...para.paraOptions,
        breakLine: !isLast,
      }
      result.push({ text: '', options: opts })
      continue
    }

    for (let ri = 0; ri < para.runs.length; ri++) {
      const run = para.runs[ri]
      const opts: PptxGenJS.TextPropsOptions = { ...run.options }

      if (ri === 0) {
        Object.assign(opts, para.paraOptions)
      }

      if (ri === para.runs.length - 1 && !isLast) {
        opts.breakLine = true
      }

      result.push({ text: run.text, options: opts })
    }
  }

  return result
}

interface _ParagraphData {
  runs: PptxGenJS.TextProps[]
  paraOptions: PptxGenJS.TextPropsOptions
}

// HTML <ol type> → pptxgenjs numberType 映射
const _olTypeToNumberType: Record<string, string> = {
  a: 'alphaLcPeriod', A: 'alphaUcPeriod',
  i: 'romanLcPeriod', I: 'romanUcPeriod',
  '1': 'arabicPeriod',
}

const _themeTextColorKeyMap: Record<string, string> = {
  '1': 'tx1',
  '13': 'tx1',
  dk1: 'tx1',
  dark1: 'tx1',
  dark_1: 'tx1',
  tx1: 'tx1',
  text1: 'tx1',
  text_1: 'tx1',
  '2': 'bg1',
  '14': 'bg1',
  lt1: 'bg1',
  light1: 'bg1',
  light_1: 'bg1',
  bg1: 'bg1',
  background1: 'bg1',
  background_1: 'bg1',
  '3': 'tx2',
  '15': 'tx2',
  dk2: 'tx2',
  dark2: 'tx2',
  dark_2: 'tx2',
  tx2: 'tx2',
  text2: 'tx2',
  text_2: 'tx2',
  '4': 'bg2',
  '16': 'bg2',
  lt2: 'bg2',
  light2: 'bg2',
  light_2: 'bg2',
  bg2: 'bg2',
  background2: 'bg2',
  background_2: 'bg2',
  accent1: 'accent1',
  accent_1: 'accent1',
  accent2: 'accent2',
  accent_2: 'accent2',
  accent3: 'accent3',
  accent_3: 'accent3',
  accent4: 'accent4',
  accent_4: 'accent4',
  accent5: 'accent5',
  accent_5: 'accent5',
  accent6: 'accent6',
  accent_6: 'accent6',
}

function normalizeThemeTextColorKey(raw?: string | null): PptxGenJS.ThemeColor | undefined {
  if (!raw) return undefined
  const key = _themeTextColorKeyMap[String(raw).trim().toLowerCase()]
  if (!key) return undefined
  return key as PptxGenJS.ThemeColor
}

function resolveTextColorToken(
  colorHex: string | undefined,
  themeKey: string | undefined,
): PptxGenJS.Color {
  if (themeKey) return themeKey as PptxGenJS.Color
  return hexToRGB(colorHex || '#333333')
}

function extractParagraphStyle(
  elem: HTMLElement,
  el: PPTTextElement,
  bulletType?: 'bullet' | 'number',
  indentLevel = 0,
  numberType?: string,
  bulletChar?: string,
): PptxGenJS.TextPropsOptions {
  const opts: PptxGenJS.TextPropsOptions = {
    fontSize: el.defaultFontSize || pxToPt(14),
    fontFace: resolveFontFace(el.defaultFontName),
    color: resolveTextColorToken(el.defaultColor, normalizeThemeTextColorKey(el.defaultColorThemeKey)),
    ...(el.defaultFontWeight === 'bold' ? { bold: true } : {}),
  }
  const style = elem.style

  if (style.textAlign && ['left', 'center', 'right', 'justify'].includes(style.textAlign)) {
    opts.align = style.textAlign as PptxGenJS.TextPropsOptions['align']
  } else if (el.defaultTextAlign && ['left', 'center', 'right', 'justify'].includes(el.defaultTextAlign)) {
    opts.align = el.defaultTextAlign as PptxGenJS.TextPropsOptions['align']
  }

  if (style.lineHeight) {
    const raw = style.lineHeight.trim().toLowerCase()
    if (raw.endsWith('%')) {
      const pct = parseFloat(raw)
      if (!Number.isNaN(pct) && pct > 0) {
        opts.lineSpacingMultiple = Number((pct / 100).toFixed(3))
      }
    } else if (raw.endsWith('pt') || raw.endsWith('px')) {
      const lhPt = parseCssLengthToPt(raw)
      if (lhPt && lhPt > 0) {
        opts.lineSpacing = lhPt
      }
    } else {
      const lh = parseFloat(raw)
      if (lh > 0 && lh < 10) {
        opts.lineSpacingMultiple = lh
      } else if (lh >= 10) {
        opts.lineSpacing = lh
      }
    }
  } else if (el.lineHeight) {
    opts.lineSpacingMultiple = el.lineHeight
  }

  if (style.marginTop) {
    const val = parseCssLengthToPt(style.marginTop)
    if (val !== undefined && val > 0) opts.paraSpaceBefore = val
  }

  if (style.marginBottom) {
    const val = parseCssLengthToPt(style.marginBottom)
    if (val !== undefined && val > 0) opts.paraSpaceAfter = val
  } else if (typeof el.paragraphSpace === 'number' && Number.isFinite(el.paragraphSpace) && el.paragraphSpace > 0) {
    // 段落未单独声明 margin-bottom 时，回退到元素级 paragraphSpace
    opts.paraSpaceAfter = el.paragraphSpace
  }

  // 段落左缩进（padding-left → indentLevel 近似，pptxgenjs 无直接 indent 属性）
  if (style.paddingLeft) {
    const pl = parseCssLengthToPx(style.paddingLeft)
    if (pl !== undefined && pl > 0) {
      // 近似：每 24px ≈ 1 级缩进
      const level = Math.min(Math.round(pl / 24), 4)
      if (level > 0 && !opts.indentLevel) opts.indentLevel = level
    }
  }

  if (bulletType) {
    if (bulletType === 'number') {
      const nt = numberType || 'arabicPeriod'
      opts.bullet = { type: 'number', numberType: nt as never }
    } else if (bulletChar) {
      opts.bullet = { characterCode: bulletChar.codePointAt(0)!.toString(16).toUpperCase() }
    } else {
      opts.bullet = true
    }
    if (indentLevel > 0) {
      opts.indentLevel = indentLevel
    }
  }

  return opts
}

function collectParagraphs(
  container: Node,
  paragraphs: _ParagraphData[],
  el: PPTTextElement,
  context: PPTXExportContext,
  bulletType?: 'bullet' | 'number',
  indentLevel = 0,
  numberType?: string,
  bulletChar?: string,
): void {
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent || ''
      if (!text.trim()) continue
      paragraphs.push({
        runs: [{
          text,
          options: {
            fontSize: el.defaultFontSize || pxToPt(14),
            fontFace: resolveFontFace(el.defaultFontName),
            color: resolveTextColorToken(el.defaultColor, normalizeThemeTextColorKey(el.defaultColorThemeKey)),
          },
        }],
        paraOptions: {},
      })
      continue
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const elem = child as HTMLElement
    const tag = elem.tagName.toUpperCase()

    if (tag === 'P') {
      const paraOpts = extractParagraphStyle(elem, el, bulletType, indentLevel, numberType, bulletChar)
      const runs = extractInlineRuns(elem, el, context)
      paragraphs.push({ runs, paraOptions: paraOpts })
    } else if (tag === 'UL' || tag === 'OL') {
      const type: 'bullet' | 'number' = tag === 'UL' ? 'bullet' : 'number'
      const olType = tag === 'OL' ? elem.getAttribute('type') : null
      const nt = olType ? (_olTypeToNumberType[olType] || 'arabicPeriod') : undefined
      const bc = tag === 'UL' ? (elem.getAttribute('data-bullet-char') || undefined) : undefined
      for (const liNode of Array.from(elem.children)) {
        if (liNode.tagName.toUpperCase() === 'LI') {
          collectFromLi(liNode as HTMLElement, paragraphs, el, context, type, indentLevel, nt, bc)
        }
      }
    } else {
      collectParagraphs(elem, paragraphs, el, context, bulletType, indentLevel, numberType, bulletChar)
    }
  }
}

function collectFromLi(
  li: HTMLElement,
  paragraphs: _ParagraphData[],
  el: PPTTextElement,
  context: PPTXExportContext,
  bulletType: 'bullet' | 'number',
  indentLevel: number,
  numberType?: string,
  bulletChar?: string,
): void {
  let hasStructuredChildren = false

  for (const child of Array.from(li.children)) {
    const tag = child.tagName.toUpperCase()
    if (tag === 'P') {
      hasStructuredChildren = true
      const paraOpts = extractParagraphStyle(child as HTMLElement, el, bulletType, indentLevel, numberType, bulletChar)
      const runs = extractInlineRuns(child as HTMLElement, el, context)
      paragraphs.push({ runs, paraOptions: paraOpts })
    } else if (tag === 'UL' || tag === 'OL') {
      hasStructuredChildren = true
      const nestedType: 'bullet' | 'number' = tag === 'UL' ? 'bullet' : 'number'
      const olType = tag === 'OL' ? (child as HTMLElement).getAttribute('type') : null
      const nt = olType ? (_olTypeToNumberType[olType] || 'arabicPeriod') : numberType
      const bc = tag === 'UL' ? ((child as HTMLElement).getAttribute('data-bullet-char') || bulletChar) : undefined
      for (const nested of Array.from(child.children)) {
        if (nested.tagName.toUpperCase() === 'LI') {
          collectFromLi(nested as HTMLElement, paragraphs, el, context, nestedType, indentLevel + 1, nt, bc)
        }
      }
    }
  }

  if (!hasStructuredChildren) {
    const paraOpts = extractParagraphStyle(li, el, bulletType, indentLevel, numberType, bulletChar)
    const runs = extractInlineRuns(li, el, context)
    paragraphs.push({ runs, paraOptions: paraOpts })
  }
}

function extractInlineRuns(
  elem: HTMLElement,
  el: PPTTextElement,
  context: PPTXExportContext,
): PptxGenJS.TextProps[] {
  const result: PptxGenJS.TextProps[] = []
  _walkInline(elem, el, result, {}, context)
  return result
}

interface _InlineState {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** OOXML underline style preserved via data-underline-style (sng/dbl/wavy/dotted etc.) */
  underlineStyle?: string
  strike?: boolean
  superscript?: boolean
  subscript?: boolean
  fontSizePt?: number
  color?: string
  themeColorKey?: PptxGenJS.ThemeColor
  fontFace?: string
  hyperlink?: PptxGenJS.HyperlinkProps
  letterSpacing?: number
  highlight?: string
}

function _walkInline(
  node: Node,
  el: PPTTextElement,
  result: PptxGenJS.TextProps[],
  inherited: _InlineState,
  context: PPTXExportContext,
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || ''
    if (!text) return

    const parent = node.parentElement
    const state: _InlineState = { ...inherited }

    if (parent) {
      const tag = parent.tagName.toUpperCase()
      const style = parent.style
      if (tag === 'B' || tag === 'STRONG' || style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 700) state.bold = true
      if (tag === 'I' || tag === 'EM' || style.fontStyle === 'italic') state.italic = true
      if (tag === 'U' || style.textDecoration?.includes('underline')) {
        state.underline = true
        if (tag === 'U') {
          const us = parent.getAttribute('data-underline-style')
          if (us) state.underlineStyle = us
        }
      }
      if (tag === 'S' || tag === 'DEL' || style.textDecoration?.includes('line-through')) state.strike = true
      if (tag === 'SUP') state.superscript = true
      if (tag === 'SUB') state.subscript = true
      if (tag === 'MARK') {
        state.highlight = parent.getAttribute('data-color')
          || style.backgroundColor
          || '#FFFF00'
      }
      if (style.fontSize) {
        const sizePt = parseCssFontSizeToPt(style.fontSize)
        if (sizePt) state.fontSizePt = sizePt
      }
      const themeKey = normalizeThemeTextColorKey(parent.getAttribute('data-theme-color-key'))
      if (themeKey) state.themeColorKey = themeKey
      if (style.color) {
        state.color = cssColorToHex(style.color) || undefined
        if (!themeKey) state.themeColorKey = undefined
      }
      if (style.fontFamily) state.fontFace = resolveFontFace(style.fontFamily)
      if (style.letterSpacing) {
        const ls = parseCssLengthToPx(style.letterSpacing)
        if (ls !== undefined) state.letterSpacing = ls
      }
    }

    const opts: PptxGenJS.TextPropsOptions = {
      fontSize: state.fontSizePt || el.defaultFontSize || pxToPt(14),
      fontFace: state.fontFace || resolveFontFace(el.defaultFontName),
      color: resolveTextColorToken(
        state.color || el.defaultColor,
        state.themeColorKey || normalizeThemeTextColorKey(el.defaultColorThemeKey),
      ),
      bold: state.bold || false,
      italic: state.italic || false,
      underline: state.underline ? { style: (state.underlineStyle || 'sng') as 'sng' } : undefined,
      strike: state.strike ? 'sngStrike' as const : undefined,
      superscript: state.superscript || false,
      subscript: state.subscript || false,
      highlight: state.highlight ? hexToRGB(state.highlight) : undefined,
    }
    if (state.hyperlink) opts.hyperlink = state.hyperlink
    // 字间距：run 级别 letter-spacing 优先，降级到全局 wordSpace
    if (state.letterSpacing !== undefined) {
      opts.charSpacing = state.letterSpacing * 0.75
    } else if (el.wordSpace) {
      opts.charSpacing = el.wordSpace * 0.75
    }
    result.push({ text, options: opts })
    return
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return
  const elem = node as HTMLElement
  const tag = elem.tagName.toUpperCase()

  if (tag === 'BR') {
    // 软换行（Shift+Enter）需要显式转成 breakLine，
    // 否则在导出 PPTX 时会被吞掉，导致段内换行丢失。
    result.push({ text: '', options: { breakLine: true } })
    return
  }

  const state: _InlineState = { ...inherited }
  const style = elem.style
  if (tag === 'B' || tag === 'STRONG' || style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 700) state.bold = true
  if (tag === 'I' || tag === 'EM' || style.fontStyle === 'italic') state.italic = true
  if (tag === 'U' || style.textDecoration?.includes('underline')) {
    state.underline = true
    if (tag === 'U') {
      const us = elem.getAttribute('data-underline-style')
      if (us) state.underlineStyle = us
    }
  }
  if (tag === 'S' || tag === 'DEL' || style.textDecoration?.includes('line-through')) state.strike = true
  if (tag === 'SUP') state.superscript = true
  if (tag === 'SUB') state.subscript = true
  if (tag === 'A') {
    const href = (elem as HTMLAnchorElement).getAttribute('href')
    const hyperlink = resolveRichTextInlineHyperlink(href || '', context)
    if (hyperlink) state.hyperlink = hyperlink
  }
  if (tag === 'MARK') {
    state.highlight = elem.getAttribute('data-color')
      || elem.style.backgroundColor
      || '#FFFF00'
  }
  const themeKey = normalizeThemeTextColorKey(elem.getAttribute('data-theme-color-key'))
  if (themeKey) state.themeColorKey = themeKey
  if (style.fontSize) {
    const sizePt = parseCssFontSizeToPt(style.fontSize)
    if (sizePt) state.fontSizePt = sizePt
  }
  if (style.color) {
    state.color = cssColorToHex(style.color) || undefined
    if (!themeKey) state.themeColorKey = undefined
  }
  if (style.fontFamily) state.fontFace = resolveFontFace(style.fontFamily)
  if (style.letterSpacing) {
    const ls = parseCssLengthToPx(style.letterSpacing)
    if (ls !== undefined) state.letterSpacing = ls
  }

  for (const child of Array.from(elem.childNodes)) {
    _walkInline(child, el, result, state, context)
  }
}

/** 去掉 HTML 标签，返回纯文本 */
function stripHtml(html: string): string {
  if (typeof document === 'undefined') {
    return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  }
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

/**
 * 十六进制颜色 → pptxgenjs 格式（6 位无 #）
 * 支持 #RGB, #RRGGBB, #RRGGBBAA, rgba(), rgb() 等
 */
function hexToRGB(color: string): string {
  if (!color) return '333333'

  // 已是 6 位无 # 格式
  if (/^[0-9a-fA-F]{6}$/.test(color)) return color.toUpperCase()

  // #RRGGBB / #RRGGBBAA
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) return color.slice(1, 7).toUpperCase()

  // #RGBA → take RGB only
  if (/^#[0-9a-fA-F]{4}$/.test(color)) {
    const r = color[1], g = color[2], b = color[3]
    return `${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }

  // #RGB → #RRGGBB
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    const r = color[1], g = color[2], b = color[3]
    return `${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }

  // rgba()/rgb()
  const rgbaMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbaMatch) {
    const r = Math.min(255, parseInt(rgbaMatch[1])).toString(16).padStart(2, '0')
    const g = Math.min(255, parseInt(rgbaMatch[2])).toString(16).padStart(2, '0')
    const b = Math.min(255, parseInt(rgbaMatch[3])).toString(16).padStart(2, '0')
    return `${r}${g}${b}`.toUpperCase()
  }

  // hsl()/hsla()
  const hslMatch = color.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/)
  if (hslMatch) {
    const h = parseFloat(hslMatch[1])
    const s = parseFloat(hslMatch[2]) / 100
    const l = parseFloat(hslMatch[3]) / 100
    const a = s * Math.min(l, 1 - l)
    const f = (n: number) => {
      const k = (n + h / 30) % 12
      return Math.max(0, Math.min(255, Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)))))
    }
    return `${f(0).toString(16).padStart(2, '0')}${f(8).toString(16).padStart(2, '0')}${f(4).toString(16).padStart(2, '0')}`.toUpperCase()
  }

  return '333333' // fallback
}

/** CSS 颜色值 → hex (支持 rgba alpha → #RRGGBBAA) */
function cssColorToHex(color: string): string | undefined {
  if (!color) return undefined
  if (color.startsWith('#')) return color
  const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/)
  if (match) {
    const hex = '#' + [match[1], match[2], match[3]]
      .map((v) => parseInt(v).toString(16).padStart(2, '0'))
      .join('')
    if (match[4] !== undefined) {
      let a = match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4])
      if (Number.isFinite(a) && a < 1) {
        return hex + Math.round(a * 255).toString(16).padStart(2, '0')
      }
    }
    return hex
  }
  return undefined
}
