/**
 * PPTX 导入 — 解析 .pptx 映射到 SlidePresentation
 *
 * 架构：Adapter 模式
 * - 宿主应用通过 setImportAdapter() 注入后端解析能力（保真度 ~70%+）
 * - 未注入 adapter 时直接失败；产品导入不再降级到客户端解析
 *
 * 后端解析（宿主应用必须注入）：
 * - python-pptx 提取富文本 HTML、表格、图表、形状、背景、备注
 *
 * 客户端解析工具（仅供独立 viewer / parser 单测显式调用）：
 * - JSZip 解压 + 正则解析 XML
 * - 仅支持纯文本、位置/尺寸、图片 base64、基础形状
 */

import JSZip from 'jszip'
import type {
  SlidePresentation, Slide, PPTElement,
  PPTTextElement, PPTImageElement, PPTShapeElement,
  PPTLineElement, SlideBackground, PPTVideoElement, PPTAudioElement,
  SlideTheme,
} from '../../types/slides'
import { createElementId, createPageId, createPresentationId } from '../../utils/id'
import { emuToPx } from '../../utils/geometry'
import { ShapePathFormulas } from '../../configs/shapes'
import {
  extractExtFromPath,
  getMimeByExt,
  resolveRelTargetFileName,
  decodeXmlEntities,
  escapeHtml,
  sanitizeTextForHtml,
  classifyRelMediaKind,
  parseDataUrlMeta,
} from './media-utils'

// 重新导出供既有单测从 '../import-pptx' 引用
export { decodeXmlEntities, escapeHtml, sanitizeTextForHtml }

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

export interface ImportResult {
  success: boolean
  presentation?: SlidePresentation
  error?: string
  warnings?: string[]
  stats?: {
    totalSlides: number
    totalElements: number
    unsupportedElements: number
    mediaFiles: number
  }
}

/**
 * 导入适配器接口
 *
 * 宿主应用实现此接口来提供自定义解析能力。
 * 例如 Electron 宿主可以通过后端 API 实现高保真解析。
 */
export interface ImportAdapter {
  /** 从 File 对象导入 PPTX */
  importFromFile(file: File): Promise<ImportResult>
}

// ═══════════════════════════════════════════════
// Adapter 管理
// ═══════════════════════════════════════════════

let _importAdapter: ImportAdapter | null = null

/**
 * 注入自定义导入适配器
 *
 * 宿主应用调用此函数注入后端解析能力：
 * ```typescript
 * import { setImportAdapter } from '@tabtin/tabslide'
 *
 * setImportAdapter({
 *   async importFromFile(file) {
 *     const formData = new FormData()
 *     formData.append('file', file)
 *     const res = await fetch('/api/tabslide/projects/import-pptx/', {
 *       method: 'POST', body: formData
 *     })
 *     const data = await res.json()
 *     return convertBackendToPresentation(data)
 *   }
 * })
 * ```
 */
export function setImportAdapter(adapter: ImportAdapter): void {
  _importAdapter = adapter
}

/**
 * 获取当前导入适配器（如果已注入）
 */
export function getImportAdapter(): ImportAdapter | null {
  return _importAdapter
}

// ═══════════════════════════════════════════════
// 主导入函数
// ═══════════════════════════════════════════════

/**
 * 从 File 对象导入 PPTX
 *
 * 如果已注入后端 adapter，使用后端解析。
 * 未注入 adapter 时直接失败，避免低保真客户端解析污染产品导入链路。
 */
export async function importPPTXFromFile(file: File): Promise<ImportResult> {
  // 已注入 adapter → 走后端解析，失败直接报错，不降级
  if (_importAdapter) {
    return _importAdapter.importFromFile(file)
  }

  return {
    success: false,
    error: 'PPTX 导入需要宿主注入后端解析 adapter，已禁止客户端降级解析',
  }
}

/**
 * 从 ArrayBuffer 解析 PPTX（低保真客户端工具）
 *
 * 注意：这是保真度较低的显式工具（~20%），不作为产品导入 fallback。
 * 真实导入必须通过 setImportAdapter() 注入后端解析能力。
 */
export async function importPPTXFromBuffer(
  buffer: ArrayBuffer,
  filename?: string,
): Promise<ImportResult> {
  const warnings: string[] = []
  let totalElements = 0
  let unsupportedElements = 0
  let mediaCount = 0

  try {
    const zip = await JSZip.loadAsync(buffer)

    // 1. 解析演示文稿信息
    const presentationXml = await readXml(zip, 'ppt/presentation.xml')
    if (!presentationXml) {
      return { success: false, error: '无效的 PPTX 文件：缺少 presentation.xml' }
    }

    // 解析画布尺寸（EMU → px）
    const sldSzTag = presentationXml.match(/<p:sldSz\b[^>]*\/?>/)
    const sldCxMatch = sldSzTag?.[0].match(/cx="(\d+)"/)
    const sldCyMatch = sldSzTag?.[0].match(/cy="(\d+)"/)
    // 兜底 1280×720（ canvas 统一）；正常路径从 sldSz EMU 换算真实尺寸
    const canvasWidth = sldCxMatch ? emuToPx(parseInt(sldCxMatch[1])) : 1280
    const canvasHeight = sldCyMatch ? emuToPx(parseInt(sldCyMatch[1])) : 720

    // 1b. 解析主题色（从 ppt/theme/theme1.xml）
    const themeXml = await readXml(zip, 'ppt/theme/theme1.xml')
    const parsedTheme = themeXml ? parseThemeXml(themeXml) : null
    const schemeColorMap = (parsedTheme && Object.keys(parsedTheme.colors).length > 0)
      ? { ...DEFAULT_SCHEME_COLOR_MAP, ...parsedTheme.colors }
      : DEFAULT_SCHEME_COLOR_MAP
    const themeFonts: PptxThemeFonts = {
      latin: parsedTheme?.fontName,
      eastAsian: parsedTheme?.eastAsianFontName,
      majorLatin: parsedTheme?.majorLatin,
      majorEastAsian: parsedTheme?.majorEastAsian,
    }

    // 2. 获取幻灯片文件列表
    const presRels = await readXml(zip, 'ppt/_rels/presentation.xml.rels')
    const slideFiles = extractSlideFiles(presRels || '')

    // 3. 提取媒体文件
    const mediaMap = new Map<string, string>() // rId → base64 data URL
    const mediaFolder = zip.folder('ppt/media')
    if (mediaFolder) {
      const mediaFiles = Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/'))
      for (const mf of mediaFiles) {
        const ext = extractExtFromPath(mf) || 'bin'
        if (ext === 'svg') {
          warnings.push(`已跳过 SVG 媒体文件 "${mf.replace('ppt/media/', '')}"（安全限制）`)
          continue
        }
        const data = await zip.file(mf)?.async('base64')
        if (data) {
          const mime = getMimeByExt(ext)
          const shortName = mf.replace('ppt/media/', '')
          mediaMap.set(shortName, `data:${mime};base64,${data}`)
          mediaCount++
        }
      }
    }

    // 4. 逐个解析幻灯片
    const pages: Slide[] = []

    for (const slideFile of slideFiles) {
      const slideXml = await readXml(zip, slideFile)
      if (!slideXml) {
        warnings.push(`无法读取 ${slideFile}`)
        continue
      }

      // 解析该幻灯片的关系文件
      const slideRelsPath = slideFile.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels'
      const slideRels = await readXml(zip, slideRelsPath)
      const relsMap = parseRelationships(slideRels || '')

      const { page, elementCount, unsupported } = parseSlide(
        slideXml, relsMap, mediaMap, canvasWidth, canvasHeight, warnings, schemeColorMap, themeFonts,
      )

      pages.push(page)
      totalElements += elementCount
      unsupportedElements += unsupported
    }

    // 根据宽高比推断 preset
    const ratio = canvasWidth / canvasHeight
    const preset = ratio > 1.5 ? '16:9' as const : ratio > 1.2 ? '4:3' as const : '16:9' as const

    const theme: SlideTheme = (parsedTheme && Object.keys(parsedTheme.colors).length > 0)
      ? buildThemeFromColors(parsedTheme)
      : {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
          fontColor: '#333333',
          fontName: 'Microsoft YaHei',
        }

    const presentation: SlidePresentation = {
      id: createPresentationId(),
      name: (filename || '导入的演示文稿').replace(/\.pptx$/i, ''),
      preset,
      canvasWidth: Math.round(canvasWidth),
      canvasHeight: Math.round(canvasHeight),
      pages,
      theme,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    return {
      success: true,
      presentation,
      warnings: warnings.length > 0 ? warnings : undefined,
      stats: {
        totalSlides: pages.length,
        totalElements,
        unsupportedElements,
        mediaFiles: mediaCount,
      },
    }
  } catch (err) {
    return { success: false, error: `PPTX 解析失败: ${(err as Error).message}` }
  }
}

/**
 * 弹出文件选择对话框并导入 PPTX
 */
export function importPPTXFromDialog(): Promise<ImportResult> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pptx'

    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve({ success: false, error: '未选择文件' })
        return
      }
      resolve(await importPPTXFromFile(file))
    }

    input.oncancel = () => resolve({ success: false, error: '已取消' })
    input.click()
  })
}

// ═══════════════════════════════════════════════
// XML 解析工具
// ═══════════════════════════════════════════════

async function readXml(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path)
  if (!file) return null
  return await file.async('text')
}

function extractSlideFiles(relsXml: string): string[] {
  const files: { index: number; path: string }[] = []
  const regex = /Relationship[^>]*Target="(slides\/slide(\d+)\.xml)"/g
  let match
  while ((match = regex.exec(relsXml))) {
    files.push({ index: parseInt(match[2]), path: `ppt/${match[1]}` })
  }
  return files.sort((a, b) => a.index - b.index).map((f) => f.path)
}

function parseRelationships(relsXml: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>()
  const regex = /<Relationship\b[^>]*\/?>/g
  let match
  while ((match = regex.exec(relsXml))) {
    const tag = match[0]
    const idMatch = tag.match(/Id="([^"]+)"/)
    const typeMatch = tag.match(/Type="([^"]+)"/)
    const targetMatch = tag.match(/Target="([^"]+)"/)
    if (idMatch && typeMatch && targetMatch) {
      map.set(idMatch[1], { target: targetMatch[1], type: typeMatch[1] })
    }
  }
  return map
}

// ═══════════════════════════════════════════════
// 幻灯片解析
// ═══════════════════════════════════════════════

function parseSlide(
  xml: string,
  relsMap: Map<string, { target: string; type: string }>,
  mediaMap: Map<string, string>,
  canvasWidth: number,
  canvasHeight: number,
  warnings: string[],
  schemeColorMap: Record<string, string>,
  themeFonts: PptxThemeFonts = {},
): { page: Slide; elementCount: number; unsupported: number } {
  const elements: PPTElement[] = []
  let unsupported = 0

  // 解析背景
  const background = parseSlideBackground(xml, relsMap, mediaMap, schemeColorMap)

  // 解析所有 sp（形状/文本框）
  const spRegex = /<p:sp\b(?:(?!<p:sp\b)[\s\S])*?<\/p:sp>/g
  let spMatch
  while ((spMatch = spRegex.exec(xml))) {
    const result = parseShapeOrText(spMatch[0], relsMap, mediaMap, schemeColorMap, warnings, themeFonts)
    if (result) {
      elements.push(result.element)
      if (result.degraded) unsupported++
    } else {
      unsupported++
    }
  }

  // 解析所有 pic（图片）
  const picRegex = /<p:pic\b[\s\S]*?<\/p:pic>/g
  let picMatch
  while ((picMatch = picRegex.exec(xml))) {
    const el = parsePicture(picMatch[0], relsMap, mediaMap)
    if (el) elements.push(el)
    else unsupported++
  }

  return {
    page: {
      id: createPageId(),
      elements,
      background,
    },
    elementCount: elements.length + unsupported,
    unsupported,
  }
}

const DEFAULT_SCHEME_COLOR_MAP: Record<string, string> = {
  accent1: '#5b9bd5',
  accent2: '#ed7d31',
  accent3: '#a5a5a5',
  accent4: '#ffc000',
  accent5: '#4472c4',
  accent6: '#70ad47',
  dk1: '#000000',
  dk2: '#44546A',
  lt1: '#FFFFFF',
  lt2: '#E7E6E6',
  bg1: '#FFFFFF',
  bg2: '#E7E6E6',
  tx1: '#000000',
  tx2: '#44546A',
  hlink: '#0563C1',
  folHlink: '#954F72',
}

function mapSchemeColor(scheme: string, colorMap: Record<string, string>): string {
  return colorMap[scheme] || '#5b9bd5'
}

const THEME_CLR_KEYS = [
  'dk1', 'lt1', 'dk2', 'lt2',
  'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
  'hlink', 'folHlink',
] as const

export type PptxThemeFonts = {
  latin?: string
  eastAsian?: string
  majorLatin?: string
  majorEastAsian?: string
}

const THEME_TYPEFACE_PLACEHOLDER = /^\+(mn|mj)-(lt|ea|cs)$/i

function readDrawingmlTypeface(xml: string, tag: 'latin' | 'ea' | 'cs'): string | undefined {
  const match = xml.match(new RegExp(`<a:${tag}[^>]*typeface="([^"]+)"`))
  const value = match?.[1]?.trim()
  if (!value || THEME_TYPEFACE_PLACEHOLDER.test(value)) return undefined
  return value
}

/** 把 `+mn-lt` / `+mn-ea` 这类主题占位符还原成 theme 里的实名字体。 */
export function resolvePptxThemePlaceholder(
  typeface: string | undefined,
  themeFonts: PptxThemeFonts = {},
): string | undefined {
  const value = typeface?.trim()
  if (!value) return undefined
  const placeholder = value.match(/^\+(mn|mj)-(lt|ea|cs)$/i)
  if (!placeholder) return value
  const role = placeholder[1].toLowerCase()
  const script = placeholder[2].toLowerCase()
  const major = role === 'mj'
  if (script === 'ea') {
    return major
      ? (themeFonts.majorEastAsian || themeFonts.eastAsian)
      : (themeFonts.eastAsian || themeFonts.majorEastAsian)
  }
  if (script === 'lt') {
    return major
      ? (themeFonts.majorLatin || themeFonts.latin)
      : (themeFonts.latin || themeFonts.majorLatin)
  }
  return themeFonts.latin
}

/**
 * 从 DrawingML 片段读 latin / ea。东亚字体必须一起读，否则中文 PPT
 * 会只剩 Arial/Calibri，预览里变成空心方框。
 */
export function resolvePptxTypeface(
  xml: string,
  themeFonts: PptxThemeFonts = {},
): string | undefined {
  const latinRaw = xml.match(/<a:latin[^>]*typeface="([^"]+)"/)?.[1]
  const eaRaw = xml.match(/<a:ea[^>]*typeface="([^"]+)"/)?.[1]
  return resolvePptxThemePlaceholder(latinRaw, themeFonts)
    || resolvePptxThemePlaceholder(eaRaw, themeFonts)
}

export function parseThemeXml(themeXml: string): {
  colors: Record<string, string>
  fontName?: string
  eastAsianFontName?: string
  majorLatin?: string
  majorEastAsian?: string
} {
  const colors: Record<string, string> = {}

  const clrSchemeMatch = themeXml.match(/<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/)
  if (clrSchemeMatch) {
    const body = clrSchemeMatch[1]
    for (const key of THEME_CLR_KEYS) {
      const tagMatch = body.match(new RegExp(`<a:${key}>([\\s\\S]*?)<\\/a:${key}>`))
      if (!tagMatch) continue
      const inner = tagMatch[1]

      const srgb = inner.match(/<a:srgbClr[^>]*val="([0-9a-fA-F]{6})"/)
      if (srgb) { colors[key] = '#' + srgb[1]; continue }

      const sys = inner.match(/<a:sysClr[^>]*lastClr="([0-9a-fA-F]{6})"/)
      if (sys) { colors[key] = '#' + sys[1]; continue }
    }
  }

  if (colors.lt1) colors.bg1 = colors.lt1
  if (colors.lt2) colors.bg2 = colors.lt2
  if (colors.dk1) colors.tx1 = colors.dk1
  if (colors.dk2) colors.tx2 = colors.dk2

  const minorFont = themeXml.match(/<a:minorFont>([\s\S]*?)<\/a:minorFont>/)?.[1] ?? ''
  const majorFont = themeXml.match(/<a:majorFont>([\s\S]*?)<\/a:majorFont>/)?.[1] ?? ''

  return {
    colors,
    fontName: readDrawingmlTypeface(minorFont, 'latin'),
    eastAsianFontName: readDrawingmlTypeface(minorFont, 'ea'),
    majorLatin: readDrawingmlTypeface(majorFont, 'latin'),
    majorEastAsian: readDrawingmlTypeface(majorFont, 'ea'),
  }
}

function buildThemeFromColors(
  parsed: { colors: Record<string, string>; fontName?: string },
): SlideTheme {
  const c = parsed.colors
  return {
    backgroundColor: c.lt1 || '#ffffff',
    themeColors: [
      c.accent1 || '#5b9bd5', c.accent2 || '#ed7d31', c.accent3 || '#a5a5a5',
      c.accent4 || '#ffc000', c.accent5 || '#4472c4', c.accent6 || '#70ad47',
    ],
    fontColor: c.dk1 || '#333333',
    bg2Color: c.lt2,
    tx2Color: c.dk2,
    hlinkColor: c.hlink,
    folHlinkColor: c.folHlink,
    fontName: parsed.fontName || 'Microsoft YaHei',
  }
}

function parseSlideBackground(
  xml: string,
  relsMap: Map<string, { target: string; type: string }>,
  mediaMap: Map<string, string>,
  schemeColorMap: Record<string, string>,
): SlideBackground | undefined {
  const bgMatch = xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)
  if (!bgMatch) return undefined
  const bgXml = bgMatch[0]

  // 图片背景
  const blipMatch = bgXml.match(/<a:blip[^>]*r:embed="([^"]+)"/)
  if (blipMatch) {
    const rId = blipMatch[1]
    const rel = relsMap.get(rId)
    const mediaFile = rel?.target?.replace('../media/', '')
    const src = mediaFile ? (mediaMap.get(mediaFile) || `media/${mediaFile}`) : ''

    let size: 'cover' | 'contain' | 'repeat' = 'cover'
    if (/<a:tile\b/.test(bgXml)) {
      size = 'repeat'
    } else {
      const fillRectMatch = bgXml.match(/<a:fillRect\b([^>]*)\/?>/)
      if (fillRectMatch) {
        const attrs = fillRectMatch[1] || ''
        const hasNonZero = ['t', 'r', 'b', 'l'].some((k) => {
          const m = attrs.match(new RegExp(`${k}="(-?\\d+)"`))
          return !!(m && Number(m[1]) !== 0)
        })
        if (hasNonZero) size = 'contain'
      }
    }

    return {
      type: 'image',
      image: { src, size },
    }
  }

  // 渐变背景
  const gradMatch = bgXml.match(/<a:gradFill[\s\S]*?<\/a:gradFill>/)
  if (gradMatch) {
    const gradXml = gradMatch[0]
    const type = /<a:path\b/.test(gradXml) ? 'radial' : 'linear'
    const linAng = gradXml.match(/<a:lin[^>]*ang="(-?\d+)"/)
    const rotate = linAng ? parseInt(linAng[1], 10) / 60000 : 0
    const colors: Array<{ pos: number; color: string }> = []
    const stopRegex = /<a:gs\b[^>]*pos="(\d+)"[^>]*>([\s\S]*?)<\/a:gs>/g
    let stopMatch: RegExpExecArray | null
    while ((stopMatch = stopRegex.exec(gradXml))) {
      const pos = Math.max(0, Math.min(1, parseInt(stopMatch[1], 10) / 100000))
      const stopXml = stopMatch[2]
      const srgb = stopXml.match(/<a:srgbClr[^>]*val="([0-9a-fA-F]{6})"/)
      if (srgb) {
        colors.push({ pos, color: `#${srgb[1]}` })
        continue
      }
      const scheme = stopXml.match(/<a:schemeClr[^>]*val="([^"]+)"/)
      if (scheme) {
        colors.push({ pos, color: mapSchemeColor(scheme[1], schemeColorMap) })
      }
    }
    if (colors.length === 1) colors.push({ ...colors[0], pos: 1 })
    if (colors.length >= 2) {
      return {
        type: 'gradient',
        gradient: {
          type,
          rotate,
          colors: colors.sort((a, b) => a.pos - b.pos),
        },
      }
    }
  }

  // 纯色背景（RGB）
  const solidFillMatch = bgXml.match(/<a:solidFill>[\s\S]*?<a:srgbClr val="([0-9a-fA-F]{6})"/)
  if (solidFillMatch) {
    return { type: 'solid', color: `#${solidFillMatch[1]}` }
  }

  // 主题背景（schemeClr）
  const schemeMatch = bgXml.match(/<a:solidFill>[\s\S]*?<a:schemeClr val="([^"]+)"/)
  if (schemeMatch) {
    const key = schemeMatch[1]
    const color = mapSchemeColor(key, schemeColorMap)
    return {
      type: 'theme',
      color,
      theme: { key, color },
    }
  }

  // 主题引用背景（bgRef）
  const bgRefScheme = bgXml.match(/<p:bgRef[\s\S]*?<a:schemeClr val="([^"]+)"/)
  if (bgRefScheme) {
    const key = bgRefScheme[1]
    const color = mapSchemeColor(key, schemeColorMap)
    return {
      type: 'theme',
      color,
      theme: { key, color },
    }
  }

  return undefined
}

// ── 形状/文本框解析 ──

function parseShapeOrText(
  spXml: string,
  relsMap: Map<string, { target: string; type: string }>,
  mediaMap: Map<string, string>,
  schemeColorMap: Record<string, string>,
  warnings: string[],
  themeFonts: PptxThemeFonts = {},
): { element: PPTElement; degraded: boolean } | null {
  // 提取位置和尺寸
  const pos = extractPosition(spXml)
  if (!pos) return null

  // 检查是否是文本框（有 <p:txBody>）
  const hasTxBody = spXml.includes('<p:txBody>')
  const hasGeom = spXml.includes('<a:prstGeom') || spXml.includes('<a:custGeom')

  // 提取文本内容
  const textContent = extractTextContent(spXml, schemeColorMap)

  // 提取填充颜色
  const fillColor = extractFillColor(spXml, schemeColorMap)

  // 提取形状类型
  const geomMatch = spXml.match(/<a:prstGeom\s+prst="([^"]+)"/)
  const geomType = geomMatch ? geomMatch[1] : null

  // 文本框识别：PowerPoint / pptxgenjs 生成的纯文本框也会带 `<a:prstGeom prst="rect">`，
  // 仅靠 `!hasGeom` 会把它们误判为带默认蓝色填充的矩形 shape。一个矩形几何 + 无填充
  // (`<a:noFill/>` 或 spPr 内无 solidFill/gradFill) 的 txBody 元素应按纯文本渲染。
  const spPrXml = spXml.match(/<p:spPr\b[\s\S]*?<\/p:spPr>/)?.[0] ?? ''
  const hasExplicitNoFill = /<a:noFill\s*\/>/.test(spPrXml)
  const hasShapeFill = /<a:(?:solidFill|gradFill|blipFill|pattFill)\b/.test(spPrXml)
  const isPlainTextBox =
    hasTxBody &&
    !spXml.includes('<a:custGeom') &&
    (!geomType || geomType === 'rect') &&
    (hasExplicitNoFill || !hasShapeFill)

  if (hasTxBody && (!hasGeom || isPlainTextBox)) {
    // 纯文本框：从首个 run 推断默认字号/颜色/字体，避免标题、正文统一退化成
    // 14px 灰字（run 级颜色/粗体/斜体已在 content 里以 <span> 保留）。
    const defaults = extractTextBoxDefaults(spXml, schemeColorMap, themeFonts)
    const textEl: PPTTextElement = {
      id: createElementId(),
      type: 'text',
      x: pos.x,
      y: pos.y,
      width: pos.width,
      height: pos.height,
      rotate: pos.rotate,
      opacity: 1,
      locked: false,
      content: textContent || '<p></p>',
      defaultFontName: defaults.defaultFontName || 'Microsoft YaHei',
      defaultColor: defaults.defaultColor || '#333333',
      ...(defaults.defaultFontSize ? { defaultFontSize: defaults.defaultFontSize } : {}),
    }
    return { element: textEl, degraded: false }
  }

  if (geomType || hasGeom) {
    // 映射 pathFormula（与 backend-adapter 一致）
    const formulaName = geomType === 'plus' ? 'cross' : geomType
    const hasFormula = formulaName ? !!ShapePathFormulas[formulaName] : false

    const isCustomGeom = spXml.includes('<a:custGeom')
    const degraded = isCustomGeom || (!!geomType && !hasFormula)
    if (degraded) {
      warnings.push(`形状 "${geomType || 'custGeom'}" 无预定义路径，已降级为矩形`)
    }

    // 形状元素
    const shapeEl: PPTShapeElement = {
      id: createElementId(),
      type: 'shape',
      x: pos.x,
      y: pos.y,
      width: pos.width,
      height: pos.height,
      rotate: pos.rotate,
      opacity: 1,
      locked: false,
      viewBox: [pos.width, pos.height],
      path: generatePathFromGeom(geomType, pos.width, pos.height),
      fixedRatio: geomType === 'ellipse' ? false : false,
      // 显式 <a:noFill/> 的形状应透明，不能套默认蓝色；仅在既无显式填充、
      // 又无 noFill 声明时才回退到占位蓝。
      fill: fillColor || (hasExplicitNoFill ? 'transparent' : '#5b9bd5'),
      pptxShapeType: geomType || undefined,
      // 设置 pathFormula，使形状缩放时动态计算路径
      ...(hasFormula && formulaName ? {
        pathFormula: formulaName,
        keypoints: ShapePathFormulas[formulaName].defaultValue.length > 0
          ? [...ShapePathFormulas[formulaName].defaultValue]
          : undefined,
      } : {}),
    }

    // 形状内部文本
    if (textContent) {
      const textDefaults = extractTextBoxDefaults(spXml, schemeColorMap, themeFonts)
      shapeEl.text = {
        content: textContent,
        defaultFontName: textDefaults.defaultFontName,
        defaultColor: textDefaults.defaultColor || '#333333',
        defaultFontSize: textDefaults.defaultFontSize || 14,
        align: 'center',
        verticalAlign: 'middle',
      }
    }

    return { element: shapeEl, degraded }
  }

  return null
}

// ── 图片解析 ──

function extractMediaRelIdsFromPicture(picXml: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (rid?: string) => {
    if (!rid || seen.has(rid)) return
    seen.add(rid)
    ids.push(rid)
  }

  const captureAll = (regex: RegExp) => {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(picXml))) {
      push(match[1])
    }
  }

  // 先解析显式的 audio/videoFile，再解析 p14:media 兜底。
  captureAll(/<a:audioFile[^>]*r:(?:embed|link)="([^"]+)"/g)
  captureAll(/<a:videoFile[^>]*r:(?:embed|link)="([^"]+)"/g)
  captureAll(/<p14:media[^>]*r:(?:embed|link)="([^"]+)"/g)

  return ids
}

function resolvePictureRelData(
  relId: string,
  relsMap: Map<string, { target: string; type: string }>,
  mediaMap: Map<string, string>,
): {
  src: string
  ext?: string
  mime?: string
  relType: string
} | null {
  const rel = relsMap.get(relId)
  if (!rel) return null

  const fileName = resolveRelTargetFileName(rel.target)
  const shortName = rel.target?.replace('../media/', '') || fileName
  const dataUrl = mediaMap.get(shortName || '') || (fileName ? mediaMap.get(fileName) : undefined)
  const parsed = dataUrl ? parseDataUrlMeta(dataUrl) : null
  const extFromMime = parsed?.mime.split('/')[1]?.toLowerCase()
  const ext = extractExtFromPath(fileName || shortName || rel.target || '') || extFromMime

  return {
    src: dataUrl || (fileName ? `media/${fileName}` : (rel.target || '')),
    ext,
    mime: parsed?.mime || (ext ? getMimeByExt(ext) : undefined),
    relType: rel.type || '',
  }
}

function parsePicture(
  picXml: string,
  relsMap: Map<string, { target: string; type: string }>,
  mediaMap: Map<string, string>,
): PPTElement | null {
  const pos = extractPosition(picXml)
  if (!pos) return null

  const imageStyle = extractPictureStyle(picXml, pos.width, pos.height)

  // 媒体关系（video/audio）优先于普通图片关系。
  const mediaRelIds = extractMediaRelIdsFromPicture(picXml)
  let resolvedMedia: ReturnType<typeof resolvePictureRelData> = null
  let mediaKind: 'video' | 'audio' | null = null
  for (const mediaRid of mediaRelIds) {
    const relData = resolvePictureRelData(mediaRid, relsMap, mediaMap)
    if (!relData) continue
    const kind = classifyRelMediaKind(relData.relType, relData.ext)
    if (kind === 'video' || kind === 'audio') {
      resolvedMedia = relData
      mediaKind = kind
      break
    }
  }

  // 封面图仍来自 blip（通常是预览帧）。
  const blipMatch = picXml.match(/<a:blip\s+r:embed="(rId\d+)"/)
  const posterRelId = blipMatch?.[1]
  const posterRel = posterRelId ? resolvePictureRelData(posterRelId, relsMap, mediaMap) : null
  const posterSrc = posterRel && classifyRelMediaKind(posterRel.relType, posterRel.ext) === 'image'
    ? posterRel.src
    : undefined

  if (resolvedMedia && mediaKind === 'video') {
    const videoEl: PPTVideoElement = {
      id: createElementId(),
      type: 'video',
      x: pos.x,
      y: pos.y,
      width: pos.width,
      height: pos.height,
      rotate: pos.rotate,
      opacity: imageStyle.opacity ?? 1,
      locked: false,
      src: resolvedMedia.src,
      autoplay: false,
      ...(posterSrc ? { poster: posterSrc } : {}),
      ...(resolvedMedia.ext ? { ext: resolvedMedia.ext } : {}),
      ...(imageStyle.flipH ? { flipH: true } : {}),
      ...(imageStyle.flipV ? { flipV: true } : {}),
      ...(imageStyle.shadow ? { shadow: imageStyle.shadow } : {}),
    }
    return videoEl
  }

  if (resolvedMedia && mediaKind === 'audio') {
    const audioEl: PPTAudioElement = {
      id: createElementId(),
      type: 'audio',
      x: pos.x,
      y: pos.y,
      width: pos.width,
      height: pos.height,
      rotate: pos.rotate,
      opacity: imageStyle.opacity ?? 1,
      locked: false,
      src: resolvedMedia.src,
      color: '#666666',
      fixedRatio: true,
      loop: false,
      autoplay: false,
      ...(resolvedMedia.ext ? { ext: resolvedMedia.ext } : {}),
      ...(imageStyle.flipH ? { flipH: true } : {}),
      ...(imageStyle.flipV ? { flipV: true } : {}),
      ...(imageStyle.shadow ? { shadow: imageStyle.shadow } : {}),
    }
    return audioEl
  }

  if (!blipMatch) return null
  const relData = resolvePictureRelData(blipMatch[1], relsMap, mediaMap)
  if (!relData) return null

  return {
    id: createElementId(),
    type: 'image',
    x: pos.x,
    y: pos.y,
    width: pos.width,
    height: pos.height,
    rotate: pos.rotate,
    opacity: imageStyle.opacity ?? 1,
    locked: false,
    src: relData.src,
    fixedRatio: imageStyle.fixedRatio ?? true,
    // B2-03: base64 图片标记 offlinePendingUpload，触发重传机制上传到 CDN，
    // 避免大体积 data URI 永久存留在演示 JSON 中。
    ...(relData.src.startsWith('data:') ? { offlinePendingUpload: true } : {}),
    ...(imageStyle.flipH ? { flipH: true } : {}),
    ...(imageStyle.flipV ? { flipV: true } : {}),
    ...(imageStyle.clip ? { clip: imageStyle.clip } : {}),
    ...(imageStyle.radius ? { radius: imageStyle.radius } : {}),
    ...(imageStyle.objectFit ? { objectFit: imageStyle.objectFit } : {}),
    ...(imageStyle.filters ? { filters: imageStyle.filters } : {}),
    ...(imageStyle.shadow ? { shadow: imageStyle.shadow } : {}),
  }
}

// ═══════════════════════════════════════════════
// 属性提取工具
// ═══════════════════════════════════════════════

interface ElementPosition {
  x: number
  y: number
  width: number
  height: number
  rotate: number
}

interface ParsedPictureStyle {
  opacity?: number
  fixedRatio?: boolean
  flipH?: boolean
  flipV?: boolean
  clip?: PPTImageElement['clip']
  radius?: number
  objectFit?: PPTImageElement['objectFit']
  filters?: NonNullable<PPTImageElement['filters']>
  shadow?: NonNullable<PPTImageElement['shadow']>
}

function parseTagAttrs(attrChunk: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const regex = /([a-zA-Z0-9:_-]+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(attrChunk))) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function parsePct100k(attrs: Record<string, string>, key: string): number {
  const raw = attrs[key]
  if (raw == null || raw === '') return 0
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) return 0
  return clamp01(parsed / 100000)
}

function parseBoolAttr(attrs: Record<string, string>, key: string): boolean {
  const raw = attrs[key]
  if (!raw) return false
  const val = raw.toLowerCase()
  return val === '1' || val === 'true'
}

function formatColorWithAlpha(hex: string, alpha?: number): string {
  const clean = hex.replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '#000000'
  if (alpha == null || alpha >= 0.999) return `#${clean.toLowerCase()}`
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${clamp01(alpha)})`
}

function extractPictureStyle(
  picXml: string,
  width: number,
  height: number,
): ParsedPictureStyle {
  const style: ParsedPictureStyle = {}

  // xfrm 级翻转
  const xfrmMatch = picXml.match(/<a:xfrm\b([^>]*)>/i)
  if (xfrmMatch) {
    const attrs = parseTagAttrs(xfrmMatch[1] || '')
    if (parseBoolAttr(attrs, 'flipH')) style.flipH = true
    if (parseBoolAttr(attrs, 'flipV')) style.flipV = true
  }

  // 锁定宽高比（picLocks.noChangeAspect）
  const lockMatch = picXml.match(/<a:picLocks\b([^>]*)\/?>/i)
  if (lockMatch) {
    const attrs = parseTagAttrs(lockMatch[1] || '')
    if (parseBoolAttr(attrs, 'noChangeAspect')) style.fixedRatio = true
  }

  // 透明度（blip alphaModFix）
  const alphaModFixMatch = picXml.match(/<a:alphaModFix\b[^>]*amt="(\d+)"/i)
  if (alphaModFixMatch) {
    const amt = Number.parseInt(alphaModFixMatch[1], 10)
    if (Number.isFinite(amt)) {
      style.opacity = clamp01(amt / 100000)
    }
  }

  // 裁剪（srcRect）
  const srcRectMatch = picXml.match(/<a:srcRect\b([^>]*)\/?>/i)
  if (srcRectMatch) {
    const attrs = parseTagAttrs(srcRectMatch[1] || '')
    const t = parsePct100k(attrs, 't')
    const r = parsePct100k(attrs, 'r')
    const b = parsePct100k(attrs, 'b')
    const l = parsePct100k(attrs, 'l')
    if (t > 1e-4 || r > 1e-4 || b > 1e-4 || l > 1e-4) {
      style.clip = {
        shape: 'rect',
        range: [
          [l, t],
          [1 - r, t],
          [1 - r, 1 - b],
          [l, 1 - b],
        ],
      }
    }
  }

  // 图片填充模式（stretch/fillRect）
  const fillRectMatch = picXml.match(/<a:fillRect\b([^>]*)\/?>/i)
  if (fillRectMatch) {
    const attrs = parseTagAttrs(fillRectMatch[1] || '')
    const t = Number.parseInt(attrs.t || '0', 10)
    const r = Number.parseInt(attrs.r || '0', 10)
    const b = Number.parseInt(attrs.b || '0', 10)
    const l = Number.parseInt(attrs.l || '0', 10)
    if ([t, r, b, l].some((v) => Number.isFinite(v) && v !== 0)) {
      style.objectFit = 'contain'
    } else {
      style.objectFit = 'cover'
    }
  }

  // 几何裁剪/圆角
  const prstGeomBlock = picXml.match(/<a:prstGeom\b[^>]*prst="([^"]+)"[\s\S]*?<\/a:prstGeom>/i)
  if (prstGeomBlock) {
    const prst = (prstGeomBlock[1] || '').trim()
    if (prst === 'ellipse') {
      style.clip = { shape: 'ellipse', range: [] }
    } else if (
      prst === 'roundRect'
      || prst === 'round1Rect'
      || prst === 'round2SameRect'
      || prst === 'round2DiagRect'
      || prst === 'snipRndRect'
    ) {
      const gdValMatch = prstGeomBlock[0].match(/<a:gd\b[^>]*fmla="val\s+(\d+)"/i)
      const ratio = gdValMatch ? Number.parseInt(gdValMatch[1], 10) / 100000 : 16667 / 100000
      const radiusPx = Math.round(Math.max(0, ratio) * Math.min(width, height))
      if (radiusPx > 0) style.radius = radiusPx
    }
  }

  // blip 滤镜
  const filters: NonNullable<PPTImageElement['filters']> = {}
  if (/<a:grayscl\b/i.test(picXml)) filters.grayscale = 1
  if (/<a:inv\b/i.test(picXml)) filters.invert = 1
  const blurMatch = picXml.match(/<a:blur\b[^>]*rad="(\d+)"/i)
  if (blurMatch) {
    const rad = Number.parseInt(blurMatch[1], 10)
    if (Number.isFinite(rad)) {
      const blurPx = Math.max(0, Math.round(emuToPx(rad) * 100) / 100)
      if (blurPx > 0) filters.blur = blurPx
    }
  }
  const lumMatch = picXml.match(/<a:lum\b([^>]*)\/?>/i)
  if (lumMatch) {
    const attrs = parseTagAttrs(lumMatch[1] || '')
    if (attrs.bright != null) {
      const bright = Number.parseInt(attrs.bright, 10)
      if (Number.isFinite(bright)) filters.brightness = Math.round((1 + bright / 100000) * 100) / 100
    }
    if (attrs.contrast != null) {
      const contrast = Number.parseInt(attrs.contrast, 10)
      if (Number.isFinite(contrast)) filters.contrast = Math.round((1 + contrast / 100000) * 100) / 100
    }
  }
  const hslMatch = picXml.match(/<a:hsl\b([^>]*)\/?>/i)
  if (hslMatch) {
    const attrs = parseTagAttrs(hslMatch[1] || '')
    if (attrs.hue != null) {
      const hue = Number.parseInt(attrs.hue, 10)
      if (Number.isFinite(hue)) filters.hueRotate = Math.round(hue / 60000)
    }
    if (attrs.sat != null) {
      const sat = Number.parseInt(attrs.sat, 10)
      if (Number.isFinite(sat)) filters.saturate = Math.round((1 + sat / 100000) * 100) / 100
    }
  }
  if (/<a:duotone\b/i.test(picXml)) {
    if (filters.sepia == null) filters.sepia = 0.8
    if (filters.saturate == null) filters.saturate = 1.5
  }
  if (/<a:biLevel\b/i.test(picXml)) {
    filters.contrast = 2
    filters.grayscale = 1
  }
  if (Object.keys(filters).length > 0) {
    style.filters = filters
  }

  // 阴影（outerShdw）
  const shadowBlockMatch = picXml.match(/<a:outerShdw\b([^>]*)>([\s\S]*?)<\/a:outerShdw>|<a:outerShdw\b([^>]*)\/>/i)
  if (shadowBlockMatch) {
    const attrs = parseTagAttrs((shadowBlockMatch[1] || shadowBlockMatch[3] || '').trim())
    const distEmu = Number.parseInt(attrs.dist || '0', 10)
    const blurEmu = Number.parseInt(attrs.blurRad || '0', 10)
    const dirRaw = Number.parseInt(attrs.dir || '0', 10)
    const distPx = Number.isFinite(distEmu) ? emuToPx(distEmu) : 0
    const blurPx = Number.isFinite(blurEmu) ? emuToPx(blurEmu) : 0
    const dirDeg = Number.isFinite(dirRaw) ? dirRaw / 60000 : 0
    const rad = (dirDeg * Math.PI) / 180
    const h = Math.round(distPx * Math.cos(rad) * 100) / 100
    const v = Math.round(distPx * Math.sin(rad) * 100) / 100

    let color = '#000000'
    const shadowBlock = shadowBlockMatch[0] || ''
    const srgbMatch = shadowBlock.match(/<a:srgbClr\b[^>]*val="([0-9a-fA-F]{6})"/i)
    const alphaMatch = shadowBlock.match(/<a:alpha\b[^>]*val="(\d+)"/i)
    let alpha = 1
    if (alphaMatch) {
      const parsed = Number.parseInt(alphaMatch[1], 10)
      if (Number.isFinite(parsed)) alpha = clamp01(parsed / 100000)
    }
    if (srgbMatch) {
      color = formatColorWithAlpha(`#${srgbMatch[1]}`, alpha)
    }

    style.shadow = {
      h,
      v,
      blur: Math.max(0, Math.round(blurPx * 100) / 100),
      color,
      ...(alpha < 1 ? { opacity: alpha } : {}),
    }
  }

  return style
}

/** @internal — exported for unit testing */
export function extractPosition(xml: string): ElementPosition | null {
  const offMatch = xml.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/)
  const extMatch = xml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/)

  if (!offMatch || !extMatch) return null

  const x = emuToPx(parseInt(offMatch[1]))
  const y = emuToPx(parseInt(offMatch[2]))
  const width = emuToPx(parseInt(extMatch[1]))
  const height = emuToPx(parseInt(extMatch[2]))

  // 旋转（EMU 角度：60000 = 1°）
  const rotMatch = xml.match(/rot="(-?\d+)"/)
  const rotate = rotMatch ? parseInt(rotMatch[1]) / 60000 : 0

  if (width <= 0 || height <= 0) return null

  return { x, y, width, height, rotate }
}

function mapParagraphAlignment(algn: string): string | undefined {
  switch (algn) {
    case 'l': return 'left'
    case 'ctr': return 'center'
    case 'r': return 'right'
    case 'just':
    case 'dist': return 'justify'
    default: return undefined
  }
}

/**
 * 解析单个 run 的 `<a:rPr>` 行内样式（颜色 / 粗体 / 斜体 / 下划线）。
 *
 * 注意：**不**输出 font-size。缩略图按整体 scale 缩放，元素容器 fontSize 已被
 * 缩放；若在 run 上写绝对 px 字号会脱离缩放体系导致字号失真。字号统一走元素级
 * `defaultFontSize`（见 extractRunStyleSize → 文本元素 defaultFontSize）。
 */
function buildRunInlineStyle(
  runXml: string,
  schemeColorMap: Record<string, string>,
): string {
  const rPr = runXml.match(/<a:rPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/)?.[0] ?? ''
  const styles: string[] = []

  const srgb = rPr.match(/<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/)
  if (srgb) {
    styles.push(`color: #${srgb[1]}`)
  } else {
    const scheme = rPr.match(/<a:solidFill>\s*<a:schemeClr val="(\w+)"/)
    if (scheme) styles.push(`color: ${mapSchemeColor(scheme[1], schemeColorMap)}`)
  }

  if (/\bb="1"/.test(rPr)) styles.push('font-weight: bold')
  if (/\bi="1"/.test(rPr)) styles.push('font-style: italic')
  if (/\bu="(?!none)\w+"/.test(rPr)) styles.push('text-decoration: underline')

  return styles.join('; ')
}

function extractRunTexts(scopeXml: string, schemeColorMap: Record<string, string> = {}): string[] {
  const parts: string[] = []
  const runRegex = /<a:r>([\s\S]*?)<\/a:r>/g
  let m
  while ((m = runRegex.exec(scopeXml))) {
    const runXml = m[1]
    const tMatch = runXml.match(/<a:t>([\s\S]*?)<\/a:t>/)
    if (!tMatch) continue
    const text = sanitizeTextForHtml(tMatch[1])
    const style = buildRunInlineStyle(runXml, schemeColorMap)
    parts.push(style ? `<span style="${style}">${text}</span>` : text)
  }
  if (parts.length > 0) return parts

  const tRegex = /<a:t>([\s\S]*?)<\/a:t>/g
  while ((m = tRegex.exec(scopeXml))) parts.push(sanitizeTextForHtml(m[1]))
  return parts
}

/** 从文本框第一个 run 提取默认字号（pt→px）和颜色，供文本元素 default 使用。 */
export function extractTextBoxDefaults(
  xml: string,
  schemeColorMap: Record<string, string>,
  themeFonts: PptxThemeFonts = {},
): { defaultFontSize?: number; defaultColor?: string; defaultFontName?: string } {
  const firstRPr = xml.match(/<a:rPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/)?.[0] ?? ''
  const result: { defaultFontSize?: number; defaultColor?: string; defaultFontName?: string } = {}

  const szMatch = firstRPr.match(/\bsz="(\d+)"/)
  if (szMatch) {
    // sz 单位是百分之一磅；px = pt * 96 / 72
    result.defaultFontSize = Math.round((parseInt(szMatch[1]) / 100) * (96 / 72))
  }

  const srgb = firstRPr.match(/<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/)
  if (srgb) {
    result.defaultColor = `#${srgb[1]}`
  } else {
    const scheme = firstRPr.match(/<a:solidFill>\s*<a:schemeClr val="(\w+)"/)
    if (scheme) result.defaultColor = mapSchemeColor(scheme[1], schemeColorMap)
  }

  const fontName = resolvePptxTypeface(firstRPr, themeFonts)
    || resolvePptxTypeface(xml, themeFonts)
  if (fontName) result.defaultFontName = fontName

  return result
}

/** 段落是否为项目符号段（有 buChar / buAutoNum 且非 buNone）。 */
function isBulletParagraph(paraXml: string): boolean {
  if (/<a:buNone\s*\/>/.test(paraXml)) return false
  return /<a:buChar\b/.test(paraXml) || /<a:buAutoNum\b/.test(paraXml)
}

/** @internal — exported for unit testing */
export function extractTextContent(xml: string, schemeColorMap: Record<string, string> = {}): string {
  const blocks: string[] = []
  let bulletBuffer: string[] = []

  const flushBullets = () => {
    if (bulletBuffer.length > 0) {
      blocks.push(`<ul>${bulletBuffer.join('')}</ul>`)
      bulletBuffer = []
    }
  }

  const paraRegex = /<a:p\b[^>]*(?:\/>|>[\s\S]*?<\/a:p>)/g
  let paraMatch
  while ((paraMatch = paraRegex.exec(xml))) {
    const paraXml = paraMatch[0]

    const algnMatch = paraXml.match(/<a:pPr\b[^>]*algn="([^"]+)"/)
    const alignment = algnMatch ? mapParagraphAlignment(algnMatch[1]) : undefined

    const spcBefMatch = paraXml.match(/<a:spcBef>[\s\S]*?<a:spcPts\s+val="(\d+)"/)
    const spcAftMatch = paraXml.match(/<a:spcAft>[\s\S]*?<a:spcPts\s+val="(\d+)"/)
    const marginTop = spcBefMatch ? parseInt(spcBefMatch[1]) / 100 : 0
    const marginBottom = spcAftMatch ? parseInt(spcAftMatch[1]) / 100 : 0

    const parts = extractRunTexts(paraXml, schemeColorMap)

    const styles: string[] = []
    if (alignment) styles.push(`text-align: ${alignment}`)
    if (marginTop > 0) styles.push(`margin-top: ${marginTop}pt`)
    if (marginBottom > 0) styles.push(`margin-bottom: ${marginBottom}pt`)
    const styleAttr = styles.length > 0 ? ` style="${styles.join('; ')}"` : ''

    if (isBulletParagraph(paraXml)) {
      bulletBuffer.push(`<li${styleAttr}>${parts.join('')}</li>`)
    } else {
      flushBullets()
      blocks.push(`<p${styleAttr}>${parts.join('')}</p>`)
    }
  }
  flushBullets()

  if (blocks.length > 0) return blocks.join('')

  // Fallback: no <a:p> found
  const fallback = extractRunTexts(xml, schemeColorMap)
  if (fallback.length === 0) return ''
  return `<p>${fallback.join('')}</p>`
}

function extractFillColor(xml: string, schemeColorMap: Record<string, string>): string | null {
  // solidFill
  const solidMatch = xml.match(/<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/)
  if (solidMatch) return `#${solidMatch[1]}`

  // scheme color（简化处理）
  const schemeMatch = xml.match(/<a:solidFill>\s*<a:schemeClr val="(\w+)"/)
  if (schemeMatch) {
    return mapSchemeColor(schemeMatch[1], schemeColorMap)
  }

  return null
}

/**
 * 根据预定义形状类型生成默认 SVG path
 *
 * 优先使用 ShapePathFormulas（与编辑器渲染保持一致），
 * 若无对应公式则用内联基础几何生成。
 */
function generatePathFromGeom(geomType: string | null, w: number, h: number): string {
  if (!geomType) return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`

  // 优先使用 ShapePathFormulas（和渲染层、后端适配器共用同一套公式）
  const formulaName = geomType === 'plus' ? 'cross' : geomType
  if (ShapePathFormulas[formulaName]) {
    return ShapePathFormulas[formulaName].formula(w, h)
  }

  // Fallback：未注册公式的形状降级为矩形
  return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`
}
