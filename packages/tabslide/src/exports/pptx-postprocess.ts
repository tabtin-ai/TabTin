/**
 * PPTX 后处理 — 弥补 pptxgenjs 的能力缺口
 *
 * pptxgenjs 不支持的 OOXML 特性：
 * 1. 表格旋转（graphicFrame 的 xfrm rot 属性）
 * 2. 元素分组（grpSp 节点包裹子元素）
 * 3. 渐变填充（solidFill → gradFill）
 * 4. 形状图片填充（solidFill/gradFill → blipFill）
 * 5. 背景高级能力（渐变背景、图片 contain/repeat、主题背景）
 * 6. 翻页过渡（slide transition）
 * 7. 元素动画（timing tree / animEffect / animScale）
 *
 * 原理：pptxgenjs 生成的 PPTX 是标准 ZIP 包，每张幻灯片是一个 XML 文件。
 * 我们用 JSZip 打开生成的 Blob，解析 slide XML，注入缺失的特性，然后重新打包。
 */

import JSZip from 'jszip'
import type { SlidePresentation, PPTElement, PPTTextElement, PPTShapeElement, Gradient, SlideTheme } from '../types/slides'
import { pxToInch } from '../utils/geometry'
import { getLineLocalBounds } from '../utils/line-geometry'

// OOXML 命名空间
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'

const MEDIA_META_PREFIX = 'TABSLIDE_MEDIA_V1:'
const MAX_MEDIA_META_LENGTH = 8000

/** OOXML 旋转单位：60000 = 1度 */
const EMU_PER_DEGREE = 60000
/** 1 inch = 914400 EMU */
const EMU_PER_INCH = 914400

function pxToEmu(px: number): number {
  return Math.round(pxToInch(px) * EMU_PER_INCH)
}

/** 将 CSS 颜色转为 6 位 hex（无 #） */
function colorToHex6(color: string): string {
  if (!color) return '000000'
  let c = color.trim()
  if (c.startsWith('#')) c = c.slice(1)
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]
  if (c.length >= 6) return c.slice(0, 6).toUpperCase()
  // rgba(...) 解析
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) {
    return [m[1], m[2], m[3]].map((v) => parseInt(v).toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  return '000000'
}

function parseColorWithAlpha(color: string): { hex: string; alpha?: number } {
  if (!color) return { hex: '000000' }
  const hex = color.trim()
  const shortHex = hex.match(/^#([0-9a-fA-F]{4})$/)
  if (shortHex) {
    const raw = shortHex[1]
    const alpha = parseInt(raw[3] + raw[3], 16) / 255
    return {
      hex: `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toUpperCase(),
      alpha: alpha < 1 ? alpha : undefined,
    }
  }
  const longHex = hex.match(/^#([0-9a-fA-F]{8})$/)
  if (longHex) {
    const raw = longHex[1]
    const alpha = parseInt(raw.slice(6, 8), 16) / 255
    return {
      hex: raw.slice(0, 6).toUpperCase(),
      alpha: alpha < 1 ? alpha : undefined,
    }
  }
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i)
  if (m) {
    const parsedHex = [m[1], m[2], m[3]]
      .map((v) => parseInt(v, 10).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
    const alphaRaw = m[4] !== undefined ? parseFloat(m[4]) : undefined
    const alpha = Number.isFinite(alphaRaw) ? Math.max(0, Math.min(1, alphaRaw!)) : undefined
    return { hex: parsedHex, alpha }
  }
  return { hex: colorToHex6(color) }
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

const DEFAULT_THEME_KEY_COLORS: Record<string, string> = {
  lt1: '#FFFFFF',
  bg1: '#FFFFFF',
  dk1: '#000000',
  tx1: '#000000',
  lt2: '#E7E6E6',
  bg2: '#E7E6E6',
  dk2: '#44546A',
  tx2: '#44546A',
  accent1: '#4472C4',
  accent2: '#ED7D31',
  accent3: '#A5A5A5',
  accent4: '#FFC000',
  accent5: '#5B9BD5',
  accent6: '#70AD47',
  hlink: '#0563C1',
  folhlink: '#954F72',
}

function resolveThemeKeyExpectedColor(
  key: string,
): string | undefined {
  const normalized = normalizeThemeKey(key)
  if (!normalized) return undefined
  if (normalized === 'lt1' || normalized === 'bg1') {
    return DEFAULT_THEME_KEY_COLORS[normalized]
  }
  if (normalized === 'dk1' || normalized === 'tx1') {
    return DEFAULT_THEME_KEY_COLORS[normalized]
  }
  if (normalized.startsWith('accent')) {
    const accentIndex = Number.parseInt(normalized.slice(6), 10)
    if (Number.isFinite(accentIndex) && accentIndex >= 1 && accentIndex <= 6) {
      return DEFAULT_THEME_KEY_COLORS[normalized]
    }
  }
  return DEFAULT_THEME_KEY_COLORS[normalized]
}

function hasBackgroundAlpha(color?: string): boolean {
  if (!color) return false
  const parsed = parseColorWithAlpha(color)
  return typeof parsed.alpha === 'number' && parsed.alpha < 1
}

function shouldApplyThemeBackgroundPatch(
  themeKey: string,
  resolvedColor: string | undefined,
): boolean {
  if (!resolvedColor) return true
  const expectedColor = resolveThemeKeyExpectedColor(themeKey)
  if (!expectedColor) return true
  const expected = parseColorWithAlpha(expectedColor).hex.toUpperCase()
  const actual = parseColorWithAlpha(resolvedColor).hex.toUpperCase()
  return expected === actual
}

// 仅供单元测试使用，避免在测试中复制内部判断逻辑。
export const __TABSLIDE_POSTPROCESS_TESTING__ = {
  normalizeThemeKey,
  shouldApplyThemeBackgroundPatch,
}

function normalizeThemeKey(key?: string): string | undefined {
  if (!key) return undefined
  const raw = key.trim().toLowerCase()
  const map: Record<string, string> = {
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
    '11': 'hlink',
    hlink: 'hlink',
    hyperlink: 'hlink',
    '12': 'folhlink',
    folhlink: 'folhlink',
    followed_hyperlink: 'folhlink',
  }
  return map[raw] || undefined
}

// ═══════════════════════════════════════════════
// 0. 主题色 / 主题字体注入
// ═══════════════════════════════════════════════

/**
 * 将 presentation.theme 中的自定义主题色 / 主题字体写入 ppt/theme/theme1.xml。
 *
 * pptxgenjs 总是使用内置默认主题，这里用用户的真实主题覆写 clrScheme / fontScheme，
 * 使导出的 PPTX 在 PowerPoint 中打开后"设计 > 颜色"面板显示正确配色。
 */
async function patchThemeXml(zip: JSZip, theme: SlideTheme | undefined): Promise<void> {
  if (!theme) return

  const themePath = 'ppt/theme/theme1.xml'
  const xmlStr = await zip.file(themePath)?.async('string')
  if (!xmlStr) return

  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlStr, 'application/xml')

  // ── 1. 覆写 clrScheme ──────────────────────────
  const clrScheme = doc.getElementsByTagNameNS(NS_A, 'clrScheme')[0]
  if (clrScheme) {
    const colorMapping: Array<{ tag: string; hex: string | undefined }> = [
      { tag: 'dk1', hex: theme.fontColor },
      { tag: 'lt1', hex: theme.backgroundColor },
      { tag: 'dk2', hex: theme.tx2Color },
      { tag: 'lt2', hex: theme.bg2Color },
      { tag: 'accent1', hex: theme.themeColors?.[0] },
      { tag: 'accent2', hex: theme.themeColors?.[1] },
      { tag: 'accent3', hex: theme.themeColors?.[2] },
      { tag: 'accent4', hex: theme.themeColors?.[3] },
      { tag: 'accent5', hex: theme.themeColors?.[4] },
      { tag: 'accent6', hex: theme.themeColors?.[5] },
      { tag: 'hlink', hex: theme.hlinkColor },
      { tag: 'folHlink', hex: theme.folHlinkColor },
    ]

    for (const { tag, hex } of colorMapping) {
      if (!hex) continue
      const hexVal = colorToHex6(hex)

      let tagNode: Element | null = null
      for (let i = 0; i < clrScheme.childNodes.length; i++) {
        const child = clrScheme.childNodes[i]
        if (child.nodeType === Node.ELEMENT_NODE && (child as Element).localName === tag) {
          tagNode = child as Element
          break
        }
      }
      if (!tagNode) {
        tagNode = doc.createElementNS(NS_A, `a:${tag}`)
        clrScheme.appendChild(tagNode)
      }

      while (tagNode.firstChild) tagNode.removeChild(tagNode.firstChild)
      const srgbClr = doc.createElementNS(NS_A, 'a:srgbClr')
      srgbClr.setAttribute('val', hexVal)
      tagNode.appendChild(srgbClr)
    }
  }

  // ── 2. 覆写 fontScheme ─────────────────────────
  const fontScheme = doc.getElementsByTagNameNS(NS_A, 'fontScheme')[0]
  if (fontScheme) {
    const fontMappings: Array<{ xmlName: string; fontName: string | undefined }> = [
      { xmlName: 'majorFont', fontName: theme.headingFontName },
      { xmlName: 'minorFont', fontName: theme.fontName },
    ]

    for (const { xmlName, fontName } of fontMappings) {
      if (!fontName) continue
      const fontEl = fontScheme.getElementsByTagNameNS(NS_A, xmlName)[0]
      if (!fontEl) continue

      const latin = fontEl.getElementsByTagNameNS(NS_A, 'latin')[0]
      if (latin) latin.setAttribute('typeface', fontName)
      const ea = fontEl.getElementsByTagNameNS(NS_A, 'ea')[0]
      if (ea) ea.setAttribute('typeface', fontName)
    }
  }

  const serializer = new XMLSerializer()
  zip.file(themePath, serializer.serializeToString(doc))
}

// ═══════════════════════════════════════════════
// 分析阶段：从 Presentation 数据中收集后处理信息
// ═══════════════════════════════════════════════

interface TableRotation {
  rotate: number
  /** 用于匹配 XML 中的 graphicFrame：x/y/w/h 转为 EMU */
  x: number
  y: number
  w: number
  h: number
}

interface GroupInfo {
  groupId: string
  elements: Array<{
    x: number
    y: number
    w: number
    h: number
    rotate?: number
  }>
}

interface GradientFillInfo {
  gradient: Gradient
  /** 元素整体透明度（0~1），用于与 stop alpha 叠乘 */
  opacity?: number
  /** 用于坐标匹配 */
  x: number
  y: number
  w: number
  h: number
}

interface PatternFillInfo {
  pattern: string
  /** 用于坐标匹配 */
  x: number
  y: number
  w: number
  h: number
}

interface LineConnectorInfo {
  /** 连接器类型 */
  connectorType: 'bentConnector3' | 'curvedConnector3'
  /** 调整值 0-100000 */
  adjVal: number
  /** 坐标匹配 */
  x: number
  y: number
  w: number
  h: number
}

/** 线条箭头尺寸信息：pptxgenjs 不支持 headEnd/tailEnd 的 w/len 属性，需后处理注入 */
interface LineArrowPatchInfo {
  /** 坐标匹配（EMU） */
  x: number
  y: number
  w: number
  h: number
  /** 起点箭头尺寸 */
  headSize?: { w?: 'sm' | 'med' | 'lg'; len?: 'sm' | 'med' | 'lg' }
  /** 终点箭头尺寸 */
  tailSize?: { w?: 'sm' | 'med' | 'lg'; len?: 'sm' | 'med' | 'lg' }
}

interface BackgroundPatchInfo {
  type: 'gradient' | 'image' | 'theme' | 'solid'
  gradient?: Gradient
  imageSize?: 'cover' | 'contain' | 'repeat'
  themeKey?: string
  themeColor?: string
  solidColor?: string
}

/** 文本缩进信息：记录每个段落的精确 marL / indent 值（EMU），用于后处理注入 */
interface TextIndentInfo {
  /** 坐标匹配 */
  x: number
  y: number
  w: number
  h: number
  /** 各段落的缩进，index 与 XML 中 <a:p> 顺序对应 */
  paragraphs: Array<{ marL?: number; indent?: number }>
}

/** 主题色填充补丁信息：将 shape/line 的 srgbClr 替换为 schemeClr */
interface ThemeColorFillInfo {
  /** 坐标匹配（EMU） */
  x: number
  y: number
  w: number
  h: number
  /** 形状填充主题色 key */
  fillThemeKey?: string
  /** 填充色变换（tint/shade/lumMod/lumOff），值范围 0-1 */
  fillThemeTransforms?: Record<string, number>
  /** 轮廓主题色 key */
  outlineThemeKey?: string
}

/** 项目符号样式补丁（pptxgenjs 不支持 buClr/buSzPct/buSzPts/buFont） */
interface BulletStylePatchInfo {
  x: number
  y: number
  w: number
  h: number
  /** 各段落的项目符号样式，index 与 XML 中 <a:p> 顺序对应 */
  paragraphs: Array<{
    color?: string
    fontSize?: string
    fontFamily?: string
  }>
}

interface SlidePostProcessInfo {
  tableRotations: TableRotation[]
  groups: GroupInfo[]
  gradientFills: GradientFillInfo[]
  patternFills: PatternFillInfo[]
  lineConnectors: LineConnectorInfo[]
  chartPatches: ChartPatchInfo[]
  mediaMetadata: MediaMetadataInfo[]
  /** 隐藏元素坐标信息（用于后处理阶段按坐标匹配 shape 并标记 cNvPr@hidden） */
  hiddenElements: Array<{ x: number; y: number; w: number; h: number }>
  /** 文本元素的段落缩进信息（pptxgenjs 不支持 indent 属性，需后处理注入） */
  textIndents: TextIndentInfo[]
  /** 线条箭头尺寸补丁（pptxgenjs 不支持 headEnd/tailEnd 的 w/len，需后处理注入） */
  lineArrowPatches: LineArrowPatchInfo[]
  /** 主题色填充补丁（将 srgbClr 替换为 schemeClr） */
  themeColorFills: ThemeColorFillInfo[]
  /** 项目符号样式补丁（注入 buClr/buSzPct/buSzPts/buFont） */
  bulletStyles: BulletStylePatchInfo[]
  background?: BackgroundPatchInfo
  /** 元素动画（pptxgenjs 不支持，通过 OOXML timing tree 注入） */
  slideAnimations: AnimationPostProcessInfo[]
  /** 翻页过渡效果 */
  slideTransition?: string
}

interface ChartPatchInfo {
  chartIndex: number
  /** 线图堆叠：pptxgenjs line + barGrouping 不生效，需补丁到 c:lineChart/c:grouping */
  forceLineStacked?: boolean
  /** 面积图堆叠：部分场景下 grouping 未落盘，需补丁到 c:areaChart/c:grouping */
  forceAreaStacked?: boolean
  /** 散点平滑：pptxgenjs scatter lineSmooth 不生效，需补丁到 c:scatterChart/c:scatterStyle */
  forceScatterSmooth?: boolean
  /** 雷达图填充：pptxgenjs radar 无填充变体，需补丁到 c:radarChart/c:radarStyle */
  forceRadarFilled?: boolean
}

interface MediaMetadataInfo {
  type: 'video' | 'audio'
  autoplay: boolean
  ext?: string
  loop?: boolean
  fixedRatio?: boolean
  color?: string
  /** 变换属性（pptxgenjs MediaProps 不支持，需后处理注入） */
  rotate?: number
  flipH?: boolean
  flipV?: boolean
  opacity?: number
  /** 坐标匹配 */
  x: number
  y: number
  w: number
  h: number
}

interface AnimationPostProcessInfo {
  type: 'in' | 'out' | 'attention'
  effect: string
  durationMs: number
  trigger: 'click' | 'meantime' | 'auto'
  x: number
  y: number
  w: number
  h: number
}

function collectPostProcessInfo(presentation: SlidePresentation): Map<number, SlidePostProcessInfo> {
  const result = new Map<number, SlidePostProcessInfo>()
  const pages = presentation.pages

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const info: SlidePostProcessInfo = {
      tableRotations: [],
      groups: [],
      gradientFills: [],
      patternFills: [],
      lineConnectors: [],
      chartPatches: [],
      mediaMetadata: [],
      hiddenElements: [],
      textIndents: [],
      lineArrowPatches: [],
      themeColorFills: [],
      bulletStyles: [],
      slideAnimations: [],
    }
    const groupMap = new Map<string, GroupInfo>()
    let chartIndex = 0

    if (page.background) {
      const legacyBg = page.background as (typeof page.background) & { type?: string; value?: string }
      const legacyType = (legacyBg as { type?: string }).type
      if (page.background.type === 'gradient' && page.background.gradient) {
        info.background = {
          type: 'gradient',
          gradient: page.background.gradient,
        }
      } else if (page.background.type === 'image') {
        const size = page.background.image?.size || 'cover'
        if (size !== 'cover') {
          info.background = {
            type: 'image',
            imageSize: size,
          }
        }
      } else if (page.background.type === 'solid' && hasBackgroundAlpha(page.background.color)) {
        info.background = {
          type: 'solid',
          solidColor: page.background.color,
        }
      } else if (legacyType === 'color' && hasBackgroundAlpha(legacyBg.value)) {
        info.background = {
          type: 'solid',
          solidColor: legacyBg.value,
        }
      } else if (page.background.type === 'theme') {
          const key = normalizeThemeKey(page.background.theme?.key)
          const themeColor = page.background.theme?.color || page.background.color
          if (key) {
            if (shouldApplyThemeBackgroundPatch(key, themeColor)) {
              info.background = {
                type: 'theme',
                themeKey: key,
                themeColor,
            }
          } else if (themeColor && hasBackgroundAlpha(themeColor)) {
            info.background = {
              type: 'solid',
              solidColor: themeColor,
            }
          }
        } else if (themeColor && hasBackgroundAlpha(themeColor)) {
          info.background = {
            type: 'solid',
            solidColor: themeColor,
          }
        }
      }
    }

    for (const el of page.elements) {
      // 隐藏元素：记录坐标，后处理阶段通过坐标匹配标记 cNvPr@hidden
      if (el.visible === false) {
        const isLine = el.type === 'line'
        const lineBounds = isLine ? getLineLocalBounds(el) : null
        const elW = isLine ? (lineBounds?.width || el.width || 100) : el.width
        const elH = isLine ? Math.max(lineBounds?.height ?? 1, 1) : (el as { height: number }).height
        info.hiddenElements.push({
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(elW),
          h: pxToEmu(elH),
        })
      }

      // 收集文本元素的段落缩进（text-indent / 精确 padding-left）
      if (el.type === 'text') {
        const indentInfo = collectTextElementIndents(el)
        if (indentInfo) {
          info.textIndents.push({
            ...indentInfo,
            x: pxToEmu(el.x),
            y: pxToEmu(el.y),
            w: pxToEmu(el.width),
            h: pxToEmu((el as { height: number }).height),
          })
        }
        // 收集项目符号样式（color/fontSize/fontFamily）
        const bsInfo = collectBulletStyleInfo(el)
        if (bsInfo) {
          info.bulletStyles.push({
            ...bsInfo,
            x: pxToEmu(el.x),
            y: pxToEmu(el.y),
            w: pxToEmu(el.width),
            h: pxToEmu((el as { height: number }).height),
          })
        }
      }

      // 收集图表补丁（按图表出现顺序记录）
      if (el.type === 'chart') {
        const patch: ChartPatchInfo = { chartIndex }
        const chartOptions = el.options || {}
        let needsPatch = false

        if (el.chartType === 'line' && chartOptions.stack === true) {
          patch.forceLineStacked = true
          needsPatch = true
        }
        if (el.chartType === 'area' && chartOptions.stack === true) {
          patch.forceAreaStacked = true
          needsPatch = true
        }
        if (el.chartType === 'scatter' && chartOptions.lineSmooth === true) {
          patch.forceScatterSmooth = true
          needsPatch = true
        }
        if (el.chartType === 'radar' && chartOptions.radarFilled === true) {
          patch.forceRadarFilled = true
          needsPatch = true
        }

        if (needsPatch) {
          info.chartPatches.push(patch)
        }
        chartIndex += 1
      }

      if (el.type === 'video') {
        const ext = typeof el.ext === 'string' && el.ext.trim()
          ? el.ext.trim().replace(/^\./, '').toLowerCase()
          : undefined
        info.mediaMetadata.push({
          type: 'video',
          autoplay: !!el.autoplay,
          loop: !!el.loop,
          ...(ext ? { ext } : {}),
          ...(el.rotate ? { rotate: el.rotate } : {}),
          ...(el.flipH ? { flipH: true } : {}),
          ...(el.flipV ? { flipV: true } : {}),
          ...(el.opacity !== undefined && el.opacity < 1 ? { opacity: el.opacity } : {}),
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(el.width),
          h: pxToEmu(el.height),
        })
      }
      if (el.type === 'audio') {
        const ext = typeof el.ext === 'string' && el.ext.trim()
          ? el.ext.trim().replace(/^\./, '').toLowerCase()
          : undefined
        info.mediaMetadata.push({
          type: 'audio',
          autoplay: !!el.autoplay,
          ...(ext ? { ext } : {}),
          loop: !!el.loop,
          fixedRatio: el.fixedRatio !== false,
          color: el.color || '#666666',
          ...(el.rotate ? { rotate: el.rotate } : {}),
          ...(el.flipH ? { flipH: true } : {}),
          ...(el.flipV ? { flipV: true } : {}),
          ...(el.opacity !== undefined && el.opacity < 1 ? { opacity: el.opacity } : {}),
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(el.width),
          h: pxToEmu(el.height),
        })
      }

      // 收集旋转的表格
      if (el.type === 'table' && el.rotate !== 0) {
        info.tableRotations.push({
          rotate: el.rotate,
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(el.width),
          h: pxToEmu(el.height),
        })
      }

      // 收集渐变形状
      if (el.type === 'shape' && el.gradient && !el.pattern) {
        const rawOpacity = typeof el.opacity === 'number' ? el.opacity : 1
        const shapeOpacity = Number.isFinite(rawOpacity)
          ? Math.max(0, Math.min(1, rawOpacity))
          : 1
        info.gradientFills.push({
          gradient: el.gradient,
          ...(shapeOpacity < 1 ? { opacity: shapeOpacity } : {}),
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(el.width),
          h: pxToEmu(el.height),
        })
      }

      // 收集 pattern 形状（仅 data-url + 受支持格式，后处理注入 blipFill）
      if (el.type === 'shape' && typeof el.pattern === 'string' && isSupportedPatternDataUrl(el.pattern)) {
        info.patternFills.push({
          pattern: el.pattern,
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(el.width),
          h: pxToEmu(el.height),
        })
      }

      // 线条几何已在 addLineElement 中直接输出 custGeom（含折线/贝塞尔），
      // 这里不再做连接器后处理注入，避免重复改写 XML。

      // 收集线条箭头尺寸（pptxgenjs 不支持 headEnd/tailEnd 的 w/len 属性）
      if (el.type === 'line' && el.pointSizes) {
        const sizes = el.pointSizes
        const hasNonDefault =
          (sizes[0]?.w && sizes[0].w !== 'med') ||
          (sizes[0]?.len && sizes[0].len !== 'med') ||
          (sizes[1]?.w && sizes[1].w !== 'med') ||
          (sizes[1]?.len && sizes[1].len !== 'med')
        if (hasNonDefault) {
          const lineBounds = getLineLocalBounds(el)
          const elW = lineBounds ? (lineBounds.width || el.width || 100) : (el.width || 100)
          const elH = lineBounds ? Math.max(lineBounds.height, 1) : 1
          const patch: LineArrowPatchInfo = {
            x: pxToEmu(el.x + (lineBounds?.minX ?? 0)),
            y: pxToEmu(el.y + (lineBounds?.minY ?? 0)),
            w: pxToEmu(Math.max(elW, 1)),
            h: pxToEmu(Math.max(elH, 1)),
          }
          if (sizes[0]?.w || sizes[0]?.len) {
            patch.headSize = {}
            if (sizes[0].w) patch.headSize.w = sizes[0].w
            if (sizes[0].len) patch.headSize.len = sizes[0].len
          }
          if (sizes[1]?.w || sizes[1]?.len) {
            patch.tailSize = {}
            if (sizes[1].w) patch.tailSize.w = sizes[1].w
            if (sizes[1].len) patch.tailSize.len = sizes[1].len
          }
          info.lineArrowPatches.push(patch)
        }
      }

      // 收集主题色填充（将 pptxgenjs 写入的 srgbClr 替换为 schemeClr）
      if (el.type === 'shape') {
        const shapeEl = el as PPTShapeElement
        const fillKey = normalizeThemeKey(shapeEl.fillThemeKey)
        const outlineKey = normalizeThemeKey(shapeEl.outline?.themeKey)
        if (fillKey || outlineKey) {
          info.themeColorFills.push({
            x: pxToEmu(el.x),
            y: pxToEmu(el.y),
            w: pxToEmu(el.width),
            h: pxToEmu((el as { height: number }).height),
            ...(fillKey ? { fillThemeKey: fillKey } : {}),
            ...(shapeEl.fillThemeTransforms ? { fillThemeTransforms: shapeEl.fillThemeTransforms } : {}),
            ...(outlineKey ? { outlineThemeKey: outlineKey } : {}),
          })
        }
      }

      // 收集分组信息
      if (el.groupId) {
        if (!groupMap.has(el.groupId)) {
          groupMap.set(el.groupId, { groupId: el.groupId, elements: [] })
        }
        const isLine = el.type === 'line'
        const lineBounds = isLine ? getLineLocalBounds(el) : null
        const lineW = lineBounds ? (lineBounds.width || el.width || 100) : 0
        const lineH = lineBounds ? Math.max(lineBounds.height, 1) : 0
        const elW = isLine ? lineW : el.width
        const elH = isLine ? lineH : (el as { height: number }).height
        groupMap.get(el.groupId)!.elements.push({
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(elW),
          h: pxToEmu(elH),
          rotate: ('rotate' in el ? (el as { rotate: number }).rotate : 0) || 0,
        })
      }
    }

    // 只保留 2+ 个元素的组
    for (const g of groupMap.values()) {
      if (g.elements.length >= 2) info.groups.push(g)
    }

    // 收集元素动画
    if (page.animations && page.animations.length > 0) {
      const elementById = new Map<string, PPTElement>()
      for (const el of page.elements) elementById.set(el.id, el)

      for (const anim of page.animations) {
        const el = elementById.get(anim.elId)
        if (!el) continue
        const isLine = el.type === 'line'
        const lineBounds = isLine ? getLineLocalBounds(el) : null
        const elW = isLine ? (lineBounds?.width || el.width || 100) : el.width
        const elH = isLine ? Math.max(lineBounds?.height ?? 1, 1) : (el as { height: number }).height
        info.slideAnimations.push({
          type: anim.type,
          effect: anim.effect,
          durationMs: anim.duration,
          trigger: anim.trigger,
          x: pxToEmu(el.x),
          y: pxToEmu(el.y),
          w: pxToEmu(elW),
          h: pxToEmu(elH),
        })
      }
    }

    // 收集翻页过渡
    if (page.turningMode && page.turningMode !== 'no') {
      info.slideTransition = page.turningMode
    }

    if (
      info.tableRotations.length > 0
      || info.groups.length > 0
      || info.gradientFills.length > 0
      || info.patternFills.length > 0
      || info.lineConnectors.length > 0
      || info.chartPatches.length > 0
      || info.mediaMetadata.length > 0
      || info.hiddenElements.length > 0
      || info.textIndents.length > 0
      || info.lineArrowPatches.length > 0
      || info.themeColorFills.length > 0
      || info.bulletStyles.length > 0
      || !!info.background
      || info.slideAnimations.length > 0
      || !!info.slideTransition
    ) {
      result.set(i, info)
    }
  }

  return result
}

// ═══════════════════════════════════════════════
// 后处理主函数
// ═══════════════════════════════════════════════

/**
 * 对 pptxgenjs 生成的 PPTX Blob 进行后处理：
 * 0. 修正页面背景（渐变 / 图片适配 / 主题色）
 * 1. 为旋转的表格注入 rot 属性
 * 2. 将同 groupId 的元素包裹进 grpSp
 * 3. 将渐变形状的 solidFill 替换为 gradFill
 * 4. 将 pattern 形状填充替换为 blipFill（可编辑图片填充）
 */
export async function postProcessPptxBlob(
  blob: Blob,
  presentation: SlidePresentation,
  embeddedFonts?: Array<{ name: string; style: string; format: string; data_base64?: string; oss_url?: string }>,
): Promise<Blob> {
  const infoMap = collectPostProcessInfo(presentation)
  const hasTheme = !!presentation.theme
  const hasEmbeddedFonts = embeddedFonts && embeddedFonts.length > 0

  // 无需后处理
  if (infoMap.size === 0 && !hasTheme && !hasEmbeddedFonts) return blob

  try {
    const zip = await JSZip.loadAsync(blob)

    // 0. 全局：注入自定义主题色 / 主题字体到 theme1.xml
    await patchThemeXml(zip, presentation.theme)

    for (const [slideIdx, info] of infoMap) {
      const path = `ppt/slides/slide${slideIdx + 1}.xml`
      const xmlStr = await zip.file(path)?.async('string')
      if (!xmlStr) continue

      const parser = new DOMParser()
      const doc = parser.parseFromString(xmlStr, 'application/xml')

      // 0. 页面背景
      if (info.background) {
        applyBackgroundPatch(doc, info.background)
      }

      // 1. 表格旋转
      if (info.tableRotations.length > 0) {
        applyTableRotations(doc, info.tableRotations)
      }

      // 2. 元素分组
      if (info.groups.length > 0) {
        applyGroups(doc, info.groups)
      }

      // 3. 渐变填充
      if (info.gradientFills.length > 0) {
        applyGradientFills(doc, info.gradientFills)
      }

      // 4. pattern 图片填充（需要补充 media + rel）
      if (info.patternFills.length > 0) {
        await applyPatternFills(zip, slideIdx, doc, info.patternFills)
      }

      // 5. 线条连接器类型（直线 → 折线/曲线）
      if (info.lineConnectors.length > 0) {
        applyLineConnectors(doc, info.lineConnectors)
      }

      // 6. 图表补丁（line/area stack / scatter smooth）
      if (info.chartPatches.length > 0) {
        await applyChartPatches(zip, slideIdx, doc, info.chartPatches)
      }

      // 7. 媒体元信息（autoplay/loop/fixedRatio/color/ext）
      if (info.mediaMetadata.length > 0) {
        applyMediaMetadata(doc, info.mediaMetadata)
      }

      // 8. 隐藏元素（标记 cNvPr@hidden="1"）
      if (info.hiddenElements.length > 0) {
        applyHiddenElements(doc, info.hiddenElements)
      }

      // 9. 文本段落缩进（注入 pPr@indent / pPr@marL）
      if (info.textIndents.length > 0) {
        applyTextIndents(doc, info.textIndents)
      }

      // 9.5. 项目符号样式（注入 buClr/buSzPct/buSzPts/buFont）
      if (info.bulletStyles.length > 0) {
        applyBulletStyles(doc, info.bulletStyles)
      }

      // 10. 线条箭头尺寸（注入 headEnd/tailEnd 的 w/len 属性）
      if (info.lineArrowPatches.length > 0) {
        applyLineArrowSizes(doc, info.lineArrowPatches)
      }

      // 11. 主题色填充（将 srgbClr 替换为 schemeClr）
      if (info.themeColorFills.length > 0) {
        applyThemeColorFills(doc, info.themeColorFills)
      }

      // 12.5. 翻页过渡（pptxgenjs 不支持 slide transition，注入 <p:transition>）
      if (info.slideTransition) {
        applySlideTransition(doc, info.slideTransition)
      }

      // 12.6. 元素动画（pptxgenjs 不支持 animation，注入 <p:timing> timing tree）
      if (info.slideAnimations.length > 0) {
        applySlideAnimations(doc, info.slideAnimations)
      }

      const serializer = new XMLSerializer()
      zip.file(path, serializer.serializeToString(doc))
    }

    // 12. 嵌入字体（将 base64 字体数据写入 ppt/fonts/，并更新 presentation.xml 和 rels）
    if (hasEmbeddedFonts) {
      await embedFontsIntoPptx(zip, embeddedFonts!)
    }

    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
  } catch (err) {
    console.warn('[PPTX PostProcess] 后处理失败，返回原始文件:', err)
    return blob
  }
}

function encodeMediaAltText(meta: MediaMetadataInfo): string | null {
  const payload: Record<string, unknown> = {
    type: meta.type,
    autoplay: !!meta.autoplay,
    loop: !!meta.loop,
  }
  if (meta.ext) payload.ext = meta.ext
  if (meta.type === 'audio') {
    payload.fixedRatio = meta.fixedRatio !== false
    payload.color = meta.color || '#666666'
  }

  try {
    const raw = JSON.stringify(payload)
    const g = globalThis as unknown as {
      Buffer?: { from: (input: string, encoding?: string) => { toString: (encoding: string) => string } }
    }
    const encoded = g.Buffer
      ? g.Buffer.from(raw, 'utf8').toString('base64')
      : btoa(raw)
    const result = `${MEDIA_META_PREFIX}${encoded}`
    if (result.length <= MAX_MEDIA_META_LENGTH) {
      return result
    }
  } catch {
    // ignore
  }
  return null
}

function isMediaPictureNode(pic: Element): boolean {
  if (pic.getElementsByTagNameNS(NS_A, 'videoFile').length > 0) return true
  if (pic.getElementsByTagNameNS(NS_P14, 'media').length > 0) return true
  const links = pic.getElementsByTagNameNS(NS_A, 'hlinkClick')
  for (let i = 0; i < links.length; i++) {
    const action = links[i].getAttribute('action') || ''
    if (action.toLowerCase() === 'ppaction://media') return true
  }
  return false
}

function applyMediaMetadata(doc: Document, metadataList: MediaMetadataInfo[]) {
  const pics = Array.from(doc.getElementsByTagNameNS(NS_P, 'pic'))
  if (pics.length === 0) return

  const used = new Set<number>()
  const tolerance = 5000

  for (const meta of metadataList) {
    const encoded = encodeMediaAltText(meta)
    if (!encoded) continue

    let matchedIndex = -1
    for (let i = 0; i < pics.length; i++) {
      if (used.has(i)) continue
      const pic = pics[i]
      if (!isMediaPictureNode(pic)) continue
      const coords = getShapeCoords(pic)
      if (!coords) continue
      if (
        Math.abs(coords.x - meta.x) < tolerance &&
        Math.abs(coords.y - meta.y) < tolerance &&
        Math.abs(coords.w - meta.w) < tolerance &&
        Math.abs(coords.h - meta.h) < tolerance
      ) {
        matchedIndex = i
        break
      }
    }

    if (matchedIndex < 0) continue
    const targetPic = pics[matchedIndex]
    const cNvPr = targetPic.getElementsByTagNameNS(NS_P, 'cNvPr')[0]
    if (!cNvPr) continue
    cNvPr.setAttribute('descr', encoded)
    used.add(matchedIndex)

    // 注入变换属性（rotate / flipH / flipV / opacity）到 spPr > xfrm
    const hasTransform = meta.rotate || meta.flipH || meta.flipV || (meta.opacity !== undefined && meta.opacity < 1)
    if (hasTransform) {
      const spPr = targetPic.getElementsByTagNameNS(NS_P, 'spPr')[0]
        || targetPic.getElementsByTagNameNS(NS_A, 'spPr')[0]
      if (spPr) {
        const xfrm = spPr.getElementsByTagNameNS(NS_A, 'xfrm')[0]
        if (xfrm) {
          if (meta.rotate) {
            xfrm.setAttribute('rot', String(Math.round(meta.rotate * EMU_PER_DEGREE)))
          }
          if (meta.flipH) xfrm.setAttribute('flipH', '1')
          if (meta.flipV) xfrm.setAttribute('flipV', '1')
        }

        // opacity → blip alphaModFix
        if (meta.opacity !== undefined && meta.opacity < 1) {
          const blip = targetPic.getElementsByTagNameNS(NS_A, 'blip')[0]
          if (blip) {
            const alphaVal = Math.round(Math.max(0, Math.min(1, meta.opacity)) * 100000)
            const alphaMod = doc.createElementNS(NS_A, 'a:alphaModFix')
            alphaMod.setAttribute('amt', String(alphaVal))
            blip.appendChild(alphaMod)
          }
        }
      }
    }
  }
}

async function applyChartPatches(
  zip: JSZip,
  slideIdx: number,
  slideDoc: Document,
  chartPatches: ChartPatchInfo[],
): Promise<void> {
  const chartRelIds = collectSlideChartRelIds(slideDoc)
  if (chartRelIds.length === 0) return

  const relMap = await readSlideChartRelationshipMap(zip, slideIdx)
  if (relMap.size === 0) return

  const parser = new DOMParser()
  const serializer = new XMLSerializer()

  for (const patch of chartPatches) {
    const relId = chartRelIds[patch.chartIndex]
    if (!relId) continue

    const chartPath = relMap.get(relId)
    if (!chartPath) continue

    const chartXml = await zip.file(chartPath)?.async('string')
    if (!chartXml) continue

    const chartDoc = parser.parseFromString(chartXml, 'application/xml')
    let changed = false

    if (patch.forceLineStacked) {
      changed = patchLineChartGroupingStacked(chartDoc) || changed
    }
    if (patch.forceAreaStacked) {
      changed = patchAreaChartGroupingStacked(chartDoc) || changed
    }
    if (patch.forceScatterSmooth) {
      changed = patchScatterChartSmoothStyle(chartDoc) || changed
    }
    if (patch.forceRadarFilled) {
      changed = patchRadarChartFilledStyle(chartDoc) || changed
    }

    if (changed) {
      zip.file(chartPath, serializer.serializeToString(chartDoc))
    }
  }
}

function collectSlideChartRelIds(slideDoc: Document): string[] {
  const relIds: string[] = []
  const chartNodes = Array.from(slideDoc.getElementsByTagNameNS(NS_C, 'chart'))
  for (const chartNode of chartNodes) {
    const relId = chartNode.getAttributeNS(NS_R, 'id') || chartNode.getAttribute('r:id')
    if (relId) relIds.push(relId)
  }
  return relIds
}

async function readSlideChartRelationshipMap(
  zip: JSZip,
  slideIdx: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const relPath = `ppt/slides/_rels/slide${slideIdx + 1}.xml.rels`
  const sourcePartPath = `ppt/slides/slide${slideIdx + 1}.xml`
  const relXml = await zip.file(relPath)?.async('string')
  if (!relXml) return map

  const parser = new DOMParser()
  const relDoc = parser.parseFromString(relXml, 'application/xml')
  const relNodesNs = Array.from(relDoc.getElementsByTagNameNS(NS_REL, 'Relationship'))
  const relNodes = relNodesNs.length > 0 ? relNodesNs : Array.from(relDoc.getElementsByTagName('Relationship'))

  for (const rel of relNodes) {
    const relId = rel.getAttribute('Id')
    const relType = rel.getAttribute('Type') || ''
    const relTarget = rel.getAttribute('Target') || ''
    if (!relId || !relType || !relTarget) continue
    if (!relType.includes('/chart')) continue
    map.set(relId, resolveRelationshipTarget(sourcePartPath, relTarget))
  }

  return map
}

function resolveRelationshipTarget(sourcePartPath: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, '/')
  if (!normalizedTarget) return sourcePartPath

  if (normalizedTarget.startsWith('/')) {
    return normalizedTarget.replace(/^\/+/, '')
  }

  const parts = sourcePartPath.split('/').slice(0, -1)
  for (const seg of normalizedTarget.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

function findDirectChild(parent: Element, ns: string, localName: string): Element | null {
  const children = Array.from(parent.childNodes)
  for (const child of children) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    if (el.namespaceURI === ns && el.localName === localName) {
      return el
    }
  }
  return null
}

function patchLineChartGroupingStacked(chartDoc: Document): boolean {
  const lineChart = chartDoc.getElementsByTagNameNS(NS_C, 'lineChart')[0]
  if (!lineChart) return false

  let grouping = findDirectChild(lineChart, NS_C, 'grouping')
  if (!grouping) {
    grouping = chartDoc.createElementNS(NS_C, 'c:grouping')
    const firstSer = findDirectChild(lineChart, NS_C, 'ser')
    if (firstSer) lineChart.insertBefore(grouping, firstSer)
    else if (lineChart.firstChild) lineChart.insertBefore(grouping, lineChart.firstChild)
    else lineChart.appendChild(grouping)
  }

  if (grouping.getAttribute('val') === 'stacked') return false
  grouping.setAttribute('val', 'stacked')
  return true
}

function patchAreaChartGroupingStacked(chartDoc: Document): boolean {
  const areaChart = chartDoc.getElementsByTagNameNS(NS_C, 'areaChart')[0]
  if (!areaChart) return false

  let grouping = findDirectChild(areaChart, NS_C, 'grouping')
  if (!grouping) {
    grouping = chartDoc.createElementNS(NS_C, 'c:grouping')
    const firstSer = findDirectChild(areaChart, NS_C, 'ser')
    if (firstSer) areaChart.insertBefore(grouping, firstSer)
    else if (areaChart.firstChild) areaChart.insertBefore(grouping, areaChart.firstChild)
    else areaChart.appendChild(grouping)
  }

  if (grouping.getAttribute('val') === 'stacked') return false
  grouping.setAttribute('val', 'stacked')
  return true
}

function patchScatterChartSmoothStyle(chartDoc: Document): boolean {
  const scatterChart = chartDoc.getElementsByTagNameNS(NS_C, 'scatterChart')[0]
  if (!scatterChart) return false

  let scatterStyle = findDirectChild(scatterChart, NS_C, 'scatterStyle')
  if (!scatterStyle) {
    scatterStyle = chartDoc.createElementNS(NS_C, 'c:scatterStyle')
    const firstSer = findDirectChild(scatterChart, NS_C, 'ser')
    if (firstSer) scatterChart.insertBefore(scatterStyle, firstSer)
    else if (scatterChart.firstChild) scatterChart.insertBefore(scatterStyle, scatterChart.firstChild)
    else scatterChart.appendChild(scatterStyle)
  }

  if (scatterStyle.getAttribute('val') === 'smoothMarker') return false
  scatterStyle.setAttribute('val', 'smoothMarker')
  return true
}

function patchRadarChartFilledStyle(chartDoc: Document): boolean {
  const radarChart = chartDoc.getElementsByTagNameNS(NS_C, 'radarChart')[0]
  if (!radarChart) return false

  let radarStyle = findDirectChild(radarChart, NS_C, 'radarStyle')
  if (!radarStyle) {
    radarStyle = chartDoc.createElementNS(NS_C, 'c:radarStyle')
    const firstSer = findDirectChild(radarChart, NS_C, 'ser')
    if (firstSer) radarChart.insertBefore(radarStyle, firstSer)
    else if (radarChart.firstChild) radarChart.insertBefore(radarStyle, radarChart.firstChild)
    else radarChart.appendChild(radarStyle)
  }

  if (radarStyle.getAttribute('val') === 'filled') return false
  radarStyle.setAttribute('val', 'filled')
  return true
}

// ═══════════════════════════════════════════════
// 0. 页面背景修正
// ═══════════════════════════════════════════════

function getOrCreateSlideBackground(doc: Document): Element | null {
  const cSld = doc.getElementsByTagNameNS(NS_P, 'cSld')[0]
  if (!cSld) return null

  let bg = cSld.getElementsByTagNameNS(NS_P, 'bg')[0]
  if (!bg) {
    bg = doc.createElementNS(NS_P, 'p:bg')
    const spTree = cSld.getElementsByTagNameNS(NS_P, 'spTree')[0]
    if (spTree) {
      cSld.insertBefore(bg, spTree)
    } else {
      cSld.appendChild(bg)
    }
  }
  return bg
}

function clearNodeChildren(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild)
  }
}

function applyBackgroundPatch(doc: Document, patch: BackgroundPatchInfo): void {
  if (patch.type === 'gradient' && patch.gradient) {
    applyGradientBackground(doc, patch.gradient)
    return
  }
  if (patch.type === 'solid' && patch.solidColor) {
    applySolidBackground(doc, patch.solidColor)
    return
  }
  if (patch.type === 'image' && patch.imageSize) {
    applyBackgroundImageSizing(doc, patch.imageSize)
    return
  }
  if (patch.type === 'theme' && patch.themeKey) {
    applyThemeBackground(doc, patch.themeKey, patch.themeColor)
  }
}

function applyGradientBackground(doc: Document, gradient: Gradient): void {
  const bg = getOrCreateSlideBackground(doc)
  if (!bg) return

  clearNodeChildren(bg)

  const bgPr = doc.createElementNS(NS_P, 'p:bgPr')
  const gradFill = createGradFillElement(doc, gradient)
  bgPr.appendChild(gradFill)
  bgPr.appendChild(doc.createElementNS(NS_A, 'a:effectLst'))
  bg.appendChild(bgPr)
}

function applySolidBackground(doc: Document, color: string): void {
  const bg = getOrCreateSlideBackground(doc)
  if (!bg) return

  const parsed = parseColorWithAlpha(color)
  clearNodeChildren(bg)

  const bgPr = doc.createElementNS(NS_P, 'p:bgPr')
  const solidFill = doc.createElementNS(NS_A, 'a:solidFill')
  const srgbClr = doc.createElementNS(NS_A, 'a:srgbClr')
  srgbClr.setAttribute('val', parsed.hex)
  if (typeof parsed.alpha === 'number' && parsed.alpha < 1) {
    const alpha = doc.createElementNS(NS_A, 'a:alpha')
    alpha.setAttribute('val', String(Math.round(parsed.alpha * 100000)))
    srgbClr.appendChild(alpha)
  }
  solidFill.appendChild(srgbClr)
  bgPr.appendChild(solidFill)
  bgPr.appendChild(doc.createElementNS(NS_A, 'a:effectLst'))
  bg.appendChild(bgPr)
}

function applyThemeBackground(doc: Document, themeKey: string, color?: string): void {
  const normalizedKey = normalizeThemeKey(themeKey)
  if (!normalizedKey) return
  const bg = getOrCreateSlideBackground(doc)
  if (!bg) return

  clearNodeChildren(bg)

  const bgPr = doc.createElementNS(NS_P, 'p:bgPr')
  const solidFill = doc.createElementNS(NS_A, 'a:solidFill')
  const schemeClr = doc.createElementNS(NS_A, 'a:schemeClr')
  schemeClr.setAttribute('val', normalizedKey)
  solidFill.appendChild(schemeClr)

  if (color) {
    const parsed = parseColorWithAlpha(color)
    if (typeof parsed.alpha === 'number' && parsed.alpha < 1) {
      const alpha = doc.createElementNS(NS_A, 'a:alpha')
      alpha.setAttribute('val', String(Math.round(parsed.alpha * 100000)))
      schemeClr.appendChild(alpha)
    }
  }

  bgPr.appendChild(solidFill)
  bgPr.appendChild(doc.createElementNS(NS_A, 'a:effectLst'))
  bg.appendChild(bgPr)
}

function applyBackgroundImageSizing(
  doc: Document,
  size: 'cover' | 'contain' | 'repeat',
): void {
  const bg = getOrCreateSlideBackground(doc)
  if (!bg) return
  const blipFill = bg.getElementsByTagNameNS(NS_A, 'blipFill')[0]
  if (!blipFill) return

  const children = Array.from(blipFill.childNodes)
  for (const child of children) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const localName = (child as Element).localName
    if (localName === 'stretch' || localName === 'tile') {
      blipFill.removeChild(child)
    }
  }

  if (size === 'repeat') {
    blipFill.appendChild(doc.createElementNS(NS_A, 'a:tile'))
    return
  }

  const stretch = doc.createElementNS(NS_A, 'a:stretch')
  const fillRect = doc.createElementNS(NS_A, 'a:fillRect')
  if (size === 'contain') {
    fillRect.setAttribute('t', '10000')
    fillRect.setAttribute('r', '10000')
    fillRect.setAttribute('b', '10000')
    fillRect.setAttribute('l', '10000')
  }
  stretch.appendChild(fillRect)
  blipFill.appendChild(stretch)
}

// ═══════════════════════════════════════════════
// 1. 表格旋转注入
// ═══════════════════════════════════════════════

/**
 * 在 OOXML 中，表格位于 <p:graphicFrame> 内。
 * pptxgenjs 不会生成 rot 属性，我们通过坐标匹配找到对应的 graphicFrame，注入 rot。
 *
 * OOXML 结构：
 * <p:graphicFrame>
 *   <p:xfrm rot="5400000">  ← 注入此属性（5400000 = 90度）
 *     <a:off x="..." y="..."/>
 *     <a:ext cx="..." cy="..."/>
 *   </p:xfrm>
 *   ...
 * </p:graphicFrame>
 */
function applyTableRotations(doc: Document, rotations: TableRotation[]) {
  // 收集所有 graphicFrame 元素（表格在 OOXML 中是 graphicFrame）
  const graphicFrames = doc.getElementsByTagNameNS(NS_P, 'graphicFrame')

  for (const rotation of rotations) {
    // 通过坐标匹配找到对应的 graphicFrame
    for (let i = 0; i < graphicFrames.length; i++) {
      const gf = graphicFrames[i]
      const xfrm = gf.getElementsByTagNameNS(NS_P, 'xfrm')[0]
        || gf.getElementsByTagNameNS(NS_A, 'xfrm')[0]
      if (!xfrm) continue

      const off = xfrm.getElementsByTagNameNS(NS_A, 'off')[0]
      const ext = xfrm.getElementsByTagNameNS(NS_A, 'ext')[0]
      if (!off || !ext) continue

      const gfX = parseInt(off.getAttribute('x') || '0', 10)
      const gfY = parseInt(off.getAttribute('y') || '0', 10)
      const gfW = parseInt(ext.getAttribute('cx') || '0', 10)
      const gfH = parseInt(ext.getAttribute('cy') || '0', 10)

      // 坐标容差匹配（EMU 精度可能有细微差异，±5000 EMU ≈ 0.5px）
      const tolerance = 5000
      if (
        Math.abs(gfX - rotation.x) < tolerance &&
        Math.abs(gfY - rotation.y) < tolerance &&
        Math.abs(gfW - rotation.w) < tolerance &&
        Math.abs(gfH - rotation.h) < tolerance
      ) {
        // 注入旋转（OOXML 单位：60000 = 1度）
        const rotVal = Math.round(rotation.rotate * EMU_PER_DEGREE)
        xfrm.setAttribute('rot', String(rotVal))
        break
      }
    }
  }
}

// ═══════════════════════════════════════════════
// 2. 元素分组（grpSp）
// ═══════════════════════════════════════════════

/**
 * 将同一组的形状包裹进 <p:grpSp>。
 *
 * 策略：
 * 1. 通过坐标匹配找到属于同一组的 shape 节点
 * 2. 计算组的 bounding box
 * 3. 创建 grpSp XML 结构
 * 4. 将匹配的 shape 节点从 spTree 移动到 grpSp 内
 *
 * OOXML 组合结构：
 * <p:grpSp>
 *   <p:nvGrpSpPr>
 *     <p:cNvPr id="N" name="Group"/>
 *     <p:cNvGrpSpPr/>
 *     <p:nvPr/>
 *   </p:nvGrpSpPr>
 *   <p:grpSpPr>
 *     <a:xfrm>
 *       <a:off x="组左上角" y="组左上角"/>
 *       <a:ext cx="组宽" cy="组高"/>
 *       <a:chOff x="子坐标原点" y="子坐标原点"/>
 *       <a:chExt cx="子坐标范围宽" cy="子坐标范围高"/>
 *     </a:xfrm>
 *   </p:grpSpPr>
 *   <p:sp>子元素1...</p:sp>
 *   <p:sp>子元素2...</p:sp>
 * </p:grpSp>
 */
function applyGroups(doc: Document, groups: GroupInfo[]) {
  // 找到 spTree（所有形状的父节点）
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return
  let nextShapeId = getNextShapeId(doc)

  for (const group of groups) {
    // 计算组的 bounding box（考虑子元素旋转后的 AABB）
    const boxes = group.elements.map((e) => {
      const rot = e.rotate || 0
      if (Math.abs(rot) < 0.01) return { x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y + e.h }
      const rad = (rot * Math.PI) / 180
      const cosA = Math.abs(Math.cos(rad))
      const sinA = Math.abs(Math.sin(rad))
      const rw = e.w * cosA + e.h * sinA
      const rh = e.w * sinA + e.h * cosA
      const cx = e.x + e.w / 2
      const cy = e.y + e.h / 2
      return { x1: cx - rw / 2, y1: cy - rh / 2, x2: cx + rw / 2, y2: cy + rh / 2 }
    })
    const minX = Math.min(...boxes.map((b) => b.x1))
    const minY = Math.min(...boxes.map((b) => b.y1))
    const maxX = Math.max(...boxes.map((b) => b.x2))
    const maxY = Math.max(...boxes.map((b) => b.y2))
    const grpW = Math.max(maxX - minX, 1)
    const grpH = Math.max(maxY - minY, 1)

    // 通过坐标匹配找到属于此组的 shape 节点。
    // 仅在 spTree 直接子节点中匹配，并按“每个组元素只消费一个节点”的策略避免误匹配。
    const matchedNodes: Element[] = []
    const matchedIndexes: number[] = []
    const used = new Array(group.elements.length).fill(false)
    const allowedShapeTypes = new Set(['sp', 'pic', 'graphicFrame', 'cxnSp'])
    const directChildren = Array.from(spTree.children) as Element[]
    const tolerance = 5000

    for (let childIdx = 0; childIdx < directChildren.length; childIdx++) {
      const shape = directChildren[childIdx]
      const localTag = shape.localName || shape.tagName.split(':').pop() || ''
      if (!allowedShapeTypes.has(localTag)) continue

      const shapeCoords = getShapeCoords(shape)
      if (!shapeCoords) continue

      let matchedGroupIndex = -1
      for (let gi = 0; gi < group.elements.length; gi++) {
        if (used[gi]) continue
        const ge = group.elements[gi]
        if (
          Math.abs(shapeCoords.x - ge.x) < tolerance &&
          Math.abs(shapeCoords.y - ge.y) < tolerance &&
          Math.abs(shapeCoords.w - ge.w) < tolerance &&
          Math.abs(shapeCoords.h - ge.h) < tolerance
        ) {
          matchedGroupIndex = gi
          break
        }
      }

      if (matchedGroupIndex >= 0) {
        used[matchedGroupIndex] = true
        matchedNodes.push(shape)
        matchedIndexes.push(childIdx)
      }
    }

    // 需要至少 2 个元素才能成组
    if (matchedNodes.length < 2) continue
    // 匹配不完整时不强行成组，避免误包裹导致结构损坏。
    if (matchedNodes.length !== group.elements.length) continue
    // 非连续匹配说明该组层级已被打散，跳过成组以保住视觉顺序。
    const sortedIndexes = [...matchedIndexes].sort((a, b) => a - b)
    const isContiguous = sortedIndexes[sortedIndexes.length - 1] - sortedIndexes[0] + 1 === sortedIndexes.length
    if (!isContiguous) continue

    // 创建 grpSp 结构
    const grpSp = createGrpSpElement(doc, minX, minY, grpW, grpH, nextShapeId++)
    const insertAt = Math.min(...matchedIndexes)

    // 将匹配的节点移动到 grpSp 内
    for (const node of matchedNodes) {
      spTree.removeChild(node)
      grpSp.appendChild(node)
    }

    const refNode = spTree.children.item(insertAt)
    if (refNode) {
      spTree.insertBefore(grpSp, refNode)
    } else {
      spTree.appendChild(grpSp)
    }
  }
}

/** 从 shape 节点中提取坐标 */
function getShapeCoords(shape: Element): { x: number; y: number; w: number; h: number } | null {
  // 尝试从 spPr/xfrm 或 graphicFrame 的 xfrm 中提取
  let xfrm =
    shape.getElementsByTagNameNS(NS_A, 'xfrm')[0] ||
    shape.getElementsByTagNameNS(NS_P, 'xfrm')[0]

  if (!xfrm) return null

  const off = xfrm.getElementsByTagNameNS(NS_A, 'off')[0]
  const ext = xfrm.getElementsByTagNameNS(NS_A, 'ext')[0]
  if (!off || !ext) return null

  return {
    x: parseInt(off.getAttribute('x') || '0', 10),
    y: parseInt(off.getAttribute('y') || '0', 10),
    w: parseInt(ext.getAttribute('cx') || '0', 10),
    h: parseInt(ext.getAttribute('cy') || '0', 10),
  }
}

function getShapeSpPr(shape: Element): Element | undefined {
  return shape.getElementsByTagNameNS(NS_P, 'spPr')[0]
    || shape.getElementsByTagNameNS(NS_A, 'spPr')[0]
}

/** 创建 grpSp XML 元素 */
function createGrpSpElement(
  doc: Document,
  x: number,
  y: number,
  w: number,
  h: number,
  shapeId: number,
): Element {
  const grpSp = doc.createElementNS(NS_P, 'p:grpSp')

  // nvGrpSpPr
  const nvGrpSpPr = doc.createElementNS(NS_P, 'p:nvGrpSpPr')
  const cNvPr = doc.createElementNS(NS_P, 'p:cNvPr')
  cNvPr.setAttribute('id', String(shapeId))
  cNvPr.setAttribute('name', 'Group')
  nvGrpSpPr.appendChild(cNvPr)
  nvGrpSpPr.appendChild(doc.createElementNS(NS_P, 'p:cNvGrpSpPr'))
  nvGrpSpPr.appendChild(doc.createElementNS(NS_P, 'p:nvPr'))
  grpSp.appendChild(nvGrpSpPr)

  // grpSpPr
  const grpSpPr = doc.createElementNS(NS_P, 'p:grpSpPr')
  const xfrm = doc.createElementNS(NS_A, 'a:xfrm')

  const off = doc.createElementNS(NS_A, 'a:off')
  off.setAttribute('x', String(x))
  off.setAttribute('y', String(y))
  xfrm.appendChild(off)

  const ext = doc.createElementNS(NS_A, 'a:ext')
  ext.setAttribute('cx', String(w))
  ext.setAttribute('cy', String(h))
  xfrm.appendChild(ext)

  // 子坐标空间 = 组合坐标空间（简化方案，与后端一致）
  const chOff = doc.createElementNS(NS_A, 'a:chOff')
  chOff.setAttribute('x', String(x))
  chOff.setAttribute('y', String(y))
  xfrm.appendChild(chOff)

  const chExt = doc.createElementNS(NS_A, 'a:chExt')
  chExt.setAttribute('cx', String(w))
  chExt.setAttribute('cy', String(h))
  xfrm.appendChild(chExt)

  grpSpPr.appendChild(xfrm)
  grpSp.appendChild(grpSpPr)

  return grpSp
}

/** 获取当前幻灯片内可用的下一个 cNvPr id（max + 1） */
function getNextShapeId(doc: Document): number {
  let maxId = 0
  const cNvPrNodes = doc.getElementsByTagNameNS(NS_P, 'cNvPr')
  for (let i = 0; i < cNvPrNodes.length; i++) {
    const raw = cNvPrNodes[i].getAttribute('id')
    const parsed = raw ? parseInt(raw, 10) : NaN
    if (!Number.isNaN(parsed)) maxId = Math.max(maxId, parsed)
  }
  return maxId + 1
}

// ═══════════════════════════════════════════════
// 3. 渐变填充注入
// ═══════════════════════════════════════════════

/**
 * 将 pptxgenjs 生成的 solidFill 替换为 gradFill。
 *
 * pptxgenjs 不支持渐变，我们将首色降级为 solidFill 传给 pptxgenjs，
 * 然后通过坐标匹配找到对应的 <p:sp>，将其 <a:solidFill> 替换为 <a:gradFill>。
 *
 * OOXML 渐变结构：
 * <a:gradFill>
 *   <a:gsLst>
 *     <a:gs pos="0">
 *       <a:srgbClr val="FF0000"/>
 *     </a:gs>
 *     <a:gs pos="100000">
 *       <a:srgbClr val="0000FF"/>
 *     </a:gs>
 *   </a:gsLst>
 *   <a:lin ang="5400000" scaled="1"/>        <!-- 线性渐变 -->
 *   <!-- 或 <a:path path="circle">...</a:path>  径向渐变 -->
 * </a:gradFill>
 */
function applyGradientFills(doc: Document, gradients: GradientFillInfo[]) {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return

  const shapes = spTree.getElementsByTagNameNS(NS_P, 'sp')

  for (const gradInfo of gradients) {
    for (let i = 0; i < shapes.length; i++) {
      const sp = shapes[i]
      const coords = getShapeCoords(sp)
      if (!coords) continue

      const tolerance = 5000
      if (
        Math.abs(coords.x - gradInfo.x) < tolerance &&
        Math.abs(coords.y - gradInfo.y) < tolerance &&
        Math.abs(coords.w - gradInfo.w) < tolerance &&
        Math.abs(coords.h - gradInfo.h) < tolerance
      ) {
        // 找到 spPr 节点
        const spPr = getShapeSpPr(sp)
        if (!spPr) continue

        // 移除现有的 solidFill
        const existingSolid = spPr.getElementsByTagNameNS(NS_A, 'solidFill')[0]
        if (existingSolid) {
          spPr.removeChild(existingSolid)
        }

        // 创建 gradFill
        const gradFill = createGradFillElement(doc, gradInfo.gradient, gradInfo.opacity)

        // 插入到 xfrm 之后（保持正确的 XML 顺序）
        const xfrm = spPr.getElementsByTagNameNS(NS_A, 'xfrm')[0]
        if (xfrm && xfrm.nextSibling) {
          spPr.insertBefore(gradFill, xfrm.nextSibling)
        } else {
          spPr.appendChild(gradFill)
        }

        break
      }
    }
  }
}

/** 创建 OOXML <a:gradFill> 元素 */
function createGradFillElement(doc: Document, gradient: Gradient, opacity?: number): Element {
  const gradFill = doc.createElementNS(NS_A, 'a:gradFill')
  const stops = normalizeGradientStopsForOoxml(gradient)
  const mergedOpacity = typeof opacity === 'number'
    ? Math.max(0, Math.min(1, opacity))
    : 1

  // 渐变停止点列表
  const gsLst = doc.createElementNS(NS_A, 'a:gsLst')
  for (const stop of stops) {
    const gs = doc.createElementNS(NS_A, 'a:gs')
    // OOXML pos 范围 0-100000（百分比 * 1000）
    const pos = Math.max(0, Math.min(1, stop.pos))
    gs.setAttribute('pos', String(Math.round(pos * 100000)))

    const parsed = parseColorWithAlpha(stop.color)
    const srgbClr = doc.createElementNS(NS_A, 'a:srgbClr')
    srgbClr.setAttribute('val', parsed.hex)
    const stopAlpha = typeof parsed.alpha === 'number' ? parsed.alpha : 1
    const finalAlpha = Math.max(0, Math.min(1, stopAlpha * mergedOpacity))
    if (finalAlpha < 1) {
      const alpha = doc.createElementNS(NS_A, 'a:alpha')
      alpha.setAttribute('val', String(Math.round(finalAlpha * 100000)))
      srgbClr.appendChild(alpha)
    }
    gs.appendChild(srgbClr)

    gsLst.appendChild(gs)
  }
  gradFill.appendChild(gsLst)

  // 渐变类型
  if (gradient.type === 'linear') {
    const lin = doc.createElementNS(NS_A, 'a:lin')
    // CSS rotate 以度数表示，OOXML 以 60000 = 1度表示
    lin.setAttribute('ang', String(Math.round((gradient.rotate || 0) * EMU_PER_DEGREE)))
    lin.setAttribute('scaled', '1')
    gradFill.appendChild(lin)
  } else {
    // 径向渐变
    const path = doc.createElementNS(NS_A, 'a:path')
    path.setAttribute('path', 'circle')
    const fillToRect = doc.createElementNS(NS_A, 'a:fillToRect')
    fillToRect.setAttribute('l', '50000')
    fillToRect.setAttribute('t', '50000')
    fillToRect.setAttribute('r', '50000')
    fillToRect.setAttribute('b', '50000')
    path.appendChild(fillToRect)
    gradFill.appendChild(path)
  }

  return gradFill
}

function normalizeGradientStopsForOoxml(gradient: Gradient): Array<{ pos: number; color: string }> {
  const rawStops = Array.isArray(gradient.colors) ? gradient.colors : []
  const normalized = rawStops
    .map((stop, index) => ({
      pos: typeof stop.pos === 'number'
        ? Math.max(0, Math.min(1, stop.pos))
        : (rawStops.length <= 1 ? 0 : index / (rawStops.length - 1)),
      color: typeof stop.color === 'string' && stop.color ? stop.color : '#000000',
    }))
    .sort((a, b) => a.pos - b.pos)

  if (normalized.length === 0) {
    return [
      { pos: 0, color: '#FFFFFF' },
      { pos: 1, color: '#000000' },
    ]
  }

  if (normalized.length === 1) {
    return [
      { pos: 0, color: normalized[0].color },
      { pos: 1, color: normalized[0].color },
    ]
  }

  return normalized
}

// ═══════════════════════════════════════════════
// 4. 形状 Pattern 填充注入（blipFill）
// ═══════════════════════════════════════════════

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

const PATTERN_DATA_MIME_MAP: Record<string, { ext: 'png' | 'jpeg' | 'gif' | 'bmp'; mime: string }> = {
  'image/png': { ext: 'png', mime: 'image/png' },
  'image/jpeg': { ext: 'jpeg', mime: 'image/jpeg' },
  'image/jpg': { ext: 'jpeg', mime: 'image/jpeg' },
  'image/gif': { ext: 'gif', mime: 'image/gif' },
  'image/bmp': { ext: 'bmp', mime: 'image/bmp' },
  'image/x-ms-bmp': { ext: 'bmp', mime: 'image/bmp' },
}

function parsePatternDataUrl(pattern: string): { bytes: Uint8Array; ext: 'png' | 'jpeg' | 'gif' | 'bmp'; mime: string } | null {
  const m = pattern.match(/^data:([^;,]+)(;base64)?,(.*)$/i)
  if (!m) return null
  const mimeRaw = (m[1] || '').trim().toLowerCase()
  const isBase64 = !!m[2]
  const payload = m[3] || ''
  const mapped = PATTERN_DATA_MIME_MAP[mimeRaw]
  if (!mapped) return null
  try {
    if (isBase64) {
      const binary = atob(payload.replace(/\s/g, ''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return { bytes, ext: mapped.ext, mime: mapped.mime }
    }
    const text = decodeURIComponent(payload)
    return { bytes: new TextEncoder().encode(text), ext: mapped.ext, mime: mapped.mime }
  } catch {
    return null
  }
}

function getNextRelNumericId(relDoc: Document): number {
  const relNodesNs = Array.from(relDoc.getElementsByTagNameNS(NS_REL, 'Relationship'))
  const relNodes = relNodesNs.length > 0 ? relNodesNs : Array.from(relDoc.getElementsByTagName('Relationship'))
  let maxId = 0
  for (const rel of relNodes) {
    const id = rel.getAttribute('Id') || ''
    const m = id.match(/^rId(\d+)$/i)
    if (!m) continue
    const n = Number.parseInt(m[1], 10)
    if (Number.isFinite(n)) maxId = Math.max(maxId, n)
  }
  return maxId + 1
}

function ensureContentTypeDefault(contentTypesDoc: Document, ext: string, mime: string): boolean {
  const types = contentTypesDoc.documentElement
  if (!types) return false

  const defaultsNs = Array.from(contentTypesDoc.getElementsByTagNameNS(NS_CT, 'Default'))
  const defaults = defaultsNs.length > 0 ? defaultsNs : Array.from(contentTypesDoc.getElementsByTagName('Default'))

  for (const def of defaults) {
    const existingExt = (def.getAttribute('Extension') || '').toLowerCase()
    if (existingExt === ext.toLowerCase()) return false
  }

  const def = contentTypesDoc.createElementNS(NS_CT, 'Default')
  def.setAttribute('Extension', ext)
  def.setAttribute('ContentType', mime)

  const firstOverride = contentTypesDoc.getElementsByTagNameNS(NS_CT, 'Override')[0]
    || contentTypesDoc.getElementsByTagName('Override')[0]
  if (firstOverride) {
    types.insertBefore(def, firstOverride)
  } else {
    types.appendChild(def)
  }
  return true
}

function removeDirectFillNodes(spPr: Element): void {
  const fillTags = new Set(['solidFill', 'gradFill', 'blipFill', 'pattFill', 'noFill'])
  const children = Array.from(spPr.childNodes)
  for (const child of children) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    if (el.namespaceURI === NS_A && fillTags.has(el.localName)) {
      spPr.removeChild(el)
    }
  }
}

function createShapeBlipFill(doc: Document, relId: string): Element {
  const blipFill = doc.createElementNS(NS_A, 'a:blipFill')
  blipFill.setAttribute('rotWithShape', '1')

  const blip = doc.createElementNS(NS_A, 'a:blip')
  blip.setAttributeNS(NS_R, 'r:embed', relId)
  blipFill.appendChild(blip)

  const stretch = doc.createElementNS(NS_A, 'a:stretch')
  stretch.appendChild(doc.createElementNS(NS_A, 'a:fillRect'))
  blipFill.appendChild(stretch)
  return blipFill
}

function insertFillAfterXfrm(spPr: Element, fillNode: Element): void {
  const xfrm = spPr.getElementsByTagNameNS(NS_A, 'xfrm')[0]
  if (xfrm && xfrm.nextSibling) {
    spPr.insertBefore(fillNode, xfrm.nextSibling)
  } else {
    spPr.appendChild(fillNode)
  }
}

async function applyPatternFills(
  zip: JSZip,
  slideIdx: number,
  doc: Document,
  patterns: PatternFillInfo[],
): Promise<void> {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return
  const shapes = Array.from(spTree.getElementsByTagNameNS(NS_P, 'sp'))
  if (shapes.length === 0) return

  const parser = new DOMParser()
  const serializer = new XMLSerializer()
  const relPath = `ppt/slides/_rels/slide${slideIdx + 1}.xml.rels`
  const relXml = await zip.file(relPath)?.async('string')
  const relDoc = parser.parseFromString(
    relXml
      || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'application/xml',
  )
  const relRoot = relDoc.getElementsByTagNameNS(NS_REL, 'Relationships')[0] || relDoc.documentElement
  if (!relRoot) return

  const contentTypesPath = '[Content_Types].xml'
  const contentTypesXml = await zip.file(contentTypesPath)?.async('string')
  if (!contentTypesXml) return
  const contentTypesDoc = parser.parseFromString(contentTypesXml, 'application/xml')

  const usedShapeIndexes = new Set<number>()
  const patternRelMap = new Map<string, string>()
  let relIdSeed = getNextRelNumericId(relDoc)
  let mediaCounter = 1
  let relChanged = false
  let contentTypesChanged = false

  for (const patternInfo of patterns) {
    let matchedIdx = -1
    for (let i = 0; i < shapes.length; i++) {
      if (usedShapeIndexes.has(i)) continue
      const coords = getShapeCoords(shapes[i])
      if (!coords) continue
      const tolerance = 5000
      if (
        Math.abs(coords.x - patternInfo.x) < tolerance &&
        Math.abs(coords.y - patternInfo.y) < tolerance &&
        Math.abs(coords.w - patternInfo.w) < tolerance &&
        Math.abs(coords.h - patternInfo.h) < tolerance
      ) {
        matchedIdx = i
        break
      }
    }
    if (matchedIdx < 0) continue

    const sp = shapes[matchedIdx]
    const spPr = getShapeSpPr(sp)
    if (!spPr) continue

    let relId = patternRelMap.get(patternInfo.pattern)
    if (!relId) {
      const parsed = parsePatternDataUrl(patternInfo.pattern)
      if (!parsed) continue

      let mediaName = `tabslide-shape-pattern-s${slideIdx + 1}-${mediaCounter}.${parsed.ext}`
      while (zip.file(`ppt/media/${mediaName}`)) {
        mediaCounter += 1
        mediaName = `tabslide-shape-pattern-s${slideIdx + 1}-${mediaCounter}.${parsed.ext}`
      }
      mediaCounter += 1
      zip.file(`ppt/media/${mediaName}`, parsed.bytes)

      const relEl = relDoc.createElementNS(NS_REL, 'Relationship')
      relId = `rId${relIdSeed}`
      relIdSeed += 1
      relEl.setAttribute('Id', relId)
      relEl.setAttribute('Type', IMAGE_REL_TYPE)
      relEl.setAttribute('Target', `../media/${mediaName}`)
      relRoot.appendChild(relEl)
      relChanged = true
      patternRelMap.set(patternInfo.pattern, relId)

      if (ensureContentTypeDefault(contentTypesDoc, parsed.ext, parsed.mime)) {
        contentTypesChanged = true
      }
    }

    removeDirectFillNodes(spPr)
    insertFillAfterXfrm(spPr, createShapeBlipFill(doc, relId))
    usedShapeIndexes.add(matchedIdx)
  }

  if (relChanged) {
    zip.file(relPath, serializer.serializeToString(relDoc))
  }
  if (contentTypesChanged) {
    zip.file(contentTypesPath, serializer.serializeToString(contentTypesDoc))
  }
}

// ═══════════════════════════════════════════════
// 5. 线条连接器类型注入
// ═══════════════════════════════════════════════

/**
 * 将 pptxgenjs 生成的直线（prstGeom=line）修改为折线/曲线连接器。
 *
 * pptxgenjs 只支持 line 形状，对于 broken/curve 线条需要将其改为：
 * - bentConnector3（折线连接器）
 * - curvedConnector3（曲线连接器）
 *
 * 并设置调整值（avLst/gd）控制弯折/弧度位置。
 *
 * OOXML 结构：
 * <a:prstGeom prst="bentConnector3">
 *   <a:avLst>
 *     <a:gd name="adj1" fmla="val 50000"/>
 *   </a:avLst>
 * </a:prstGeom>
 */
function applyLineConnectors(doc: Document, connectors: LineConnectorInfo[]) {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return

  // pptxgenjs 生成的线条是 p:sp（不是 p:cxnSp），通过坐标匹配
  const shapes = spTree.getElementsByTagNameNS(NS_P, 'sp')

  for (const conn of connectors) {
    for (let i = 0; i < shapes.length; i++) {
      const sp = shapes[i]
      if (sp.parentNode !== spTree) continue

      const coords = getShapeCoords(sp)
      if (!coords) continue

      const tolerance = 5000
      if (
        Math.abs(coords.x - conn.x) < tolerance &&
        Math.abs(coords.y - conn.y) < tolerance &&
        Math.abs(coords.w - conn.w) < tolerance &&
        Math.abs(coords.h - conn.h) < tolerance
      ) {
        // 检查是否是 line 形状
        const spPr = getShapeSpPr(sp)
        if (!spPr) continue

        const prstGeom = spPr.getElementsByTagNameNS(NS_A, 'prstGeom')[0]
        if (!prstGeom) continue

        const currentPrst = prstGeom.getAttribute('prst')
        if (currentPrst !== 'line') continue

        // 修改为目标连接器类型
        prstGeom.setAttribute('prst', conn.connectorType)

        // 替换 avLst（清除旧的，添加调整值）
        const oldAvLst = prstGeom.getElementsByTagNameNS(NS_A, 'avLst')[0]
        if (oldAvLst) {
          prstGeom.removeChild(oldAvLst)
        }
        const newAvLst = doc.createElementNS(NS_A, 'a:avLst')
        const gd = doc.createElementNS(NS_A, 'a:gd')
        gd.setAttribute('name', 'adj1')
        gd.setAttribute('fmla', `val ${conn.adjVal}`)
        newAvLst.appendChild(gd)
        prstGeom.appendChild(newAvLst)

        break
      }
    }
  }
}

// ═══════════════════════════════════════════════
// 7b. 线条箭头尺寸注入
// ═══════════════════════════════════════════════

/**
 * 为线条的 headEnd/tailEnd 注入 w/len 属性。
 *
 * pptxgenjs 只输出 `<a:headEnd type="arrow"/>` 不带尺寸，
 * OOXML 标准支持 w/len 属性：sm/med/lg。
 * 通过坐标匹配找到对应的 shape，在其 <a:ln> 中的 headEnd/tailEnd 上注入属性。
 */
function applyLineArrowSizes(doc: Document, patches: LineArrowPatchInfo[]) {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return

  const shapes = spTree.getElementsByTagNameNS(NS_P, 'sp')

  for (const patch of patches) {
    for (let i = 0; i < shapes.length; i++) {
      const sp = shapes[i]
      if (sp.parentNode !== spTree) continue

      const coords = getShapeCoords(sp)
      if (!coords) continue

      const tolerance = 5000
      if (
        Math.abs(coords.x - patch.x) < tolerance &&
        Math.abs(coords.y - patch.y) < tolerance &&
        Math.abs(coords.w - patch.w) < tolerance &&
        Math.abs(coords.h - patch.h) < tolerance
      ) {
        const spPr = getShapeSpPr(sp)
        if (!spPr) continue

        const ln = spPr.getElementsByTagNameNS(NS_A, 'ln')[0]
        if (!ln) continue

        // 注入 headEnd 的 w/len
        if (patch.headSize) {
          const headEnd = ln.getElementsByTagNameNS(NS_A, 'headEnd')[0]
          if (headEnd) {
            if (patch.headSize.w) headEnd.setAttribute('w', patch.headSize.w)
            if (patch.headSize.len) headEnd.setAttribute('len', patch.headSize.len)
          }
        }

        // 注入 tailEnd 的 w/len
        if (patch.tailSize) {
          const tailEnd = ln.getElementsByTagNameNS(NS_A, 'tailEnd')[0]
          if (tailEnd) {
            if (patch.tailSize.w) tailEnd.setAttribute('w', patch.tailSize.w)
            if (patch.tailSize.len) tailEnd.setAttribute('len', patch.tailSize.len)
          }
        }

        break
      }
    }
  }
}

// ═══════════════════════════════════════════════
// 8. 隐藏元素标记
// ═══════════════════════════════════════════════

/**
 * 将隐藏元素的 cNvPr 标记为 hidden="1"。
 *
 * OOXML 标准中，shape 的 cNvPr 支持 hidden 属性：
 * <p:sp>
 *   <p:nvSpPr>
 *     <p:cNvPr id="N" name="..." hidden="1"/>  ← 标记为隐藏
 *   </p:nvSpPr>
 *   ...
 * </p:sp>
 *
 * PowerPoint 会保留该 shape 但不在编辑/放映视图中显示。
 * 通过坐标匹配找到对应的 shape 节点。
 */
function applyHiddenElements(
  doc: Document,
  hiddenElements: Array<{ x: number; y: number; w: number; h: number }>,
) {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return

  // 收集所有顶层 shape 类节点（sp, pic, graphicFrame）
  const allShapes: Element[] = []
  for (let i = 0; i < spTree.children.length; i++) {
    const child = spTree.children[i]
    const localName = child.localName
    if (localName === 'sp' || localName === 'pic' || localName === 'graphicFrame') {
      allShapes.push(child)
    }
  }

  const tolerance = 5000
  const used = new Set<number>()

  for (const hidden of hiddenElements) {
    for (let i = 0; i < allShapes.length; i++) {
      if (used.has(i)) continue
      const shape = allShapes[i]
      const coords = getShapeCoords(shape)
      if (!coords) continue

      if (
        Math.abs(coords.x - hidden.x) < tolerance &&
        Math.abs(coords.y - hidden.y) < tolerance &&
        Math.abs(coords.w - hidden.w) < tolerance &&
        Math.abs(coords.h - hidden.h) < tolerance
      ) {
        // 找到 cNvPr 并标记 hidden
        const cNvPr = shape.getElementsByTagNameNS(NS_P, 'cNvPr')[0]
        if (cNvPr) {
          cNvPr.setAttribute('hidden', '1')
        }
        used.add(i)
        break
      }
    }
  }
}

// ═══════════════════════════════════════════════
// 9. 文本段落缩进注入
// ═══════════════════════════════════════════════

/** CSS 长度 → pt（仅支持 pt/px 单位） */
function cssLengthToPt(raw: string): number | undefined {
  if (!raw) return undefined
  const num = parseFloat(raw)
  if (!Number.isFinite(num)) return undefined
  const lower = raw.trim().toLowerCase()
  if (lower.endsWith('px')) return num * 0.75
  if (lower.endsWith('pt') || /^-?[\d.]+$/.test(lower)) return num
  return undefined
}

/**
 * 从文本元素的 HTML 内容中提取各段落的 text-indent 和 padding-left。
 * 返回 null 表示该元素无需缩进后处理。
 */
function collectTextElementIndents(
  el: PPTElement,
): { paragraphs: Array<{ marL?: number; indent?: number }> } | null {
  const textEl = el as PPTTextElement
  const html = textEl.content
  if (!html) return null

  const div = document.createElement('div')
  div.innerHTML = html

  const paragraphs: Array<{ marL?: number; indent?: number }> = []
  collectParagraphIndents(div, paragraphs)

  let needsPatch = false
  for (const p of paragraphs) {
    if (p.indent !== undefined || p.marL !== undefined) {
      needsPatch = true
      break
    }
  }

  return needsPatch ? { paragraphs } : null
}

/** 递归收集段落缩进信息，顺序与 pptxgenjs 生成的 <a:p> 一致 */
function collectParagraphIndents(
  container: Element,
  result: Array<{ marL?: number; indent?: number }>,
): void {
  for (let i = 0; i < container.children.length; i++) {
    const child = container.children[i]
    const tag = child.tagName.toUpperCase()

    if (tag === 'P') {
      const style = (child as HTMLElement).style
      const entry: { marL?: number; indent?: number } = {}

      if (style.textIndent) {
        const tiPt = cssLengthToPt(style.textIndent)
        if (tiPt !== undefined && tiPt !== 0) {
          entry.indent = Math.round(tiPt * 12700)
        }
      }

      if (style.paddingLeft) {
        const plPt = cssLengthToPt(style.paddingLeft)
        if (plPt !== undefined && plPt > 0) {
          entry.marL = Math.round(plPt * 12700)
        }
      }

      result.push(entry)
    } else if (tag === 'UL' || tag === 'OL') {
      collectListItemIndents(child, result)
    } else {
      collectParagraphIndents(child, result)
    }
  }
}

/** 递归收集列表项的段落缩进 */
function collectListItemIndents(
  listEl: Element,
  result: Array<{ marL?: number; indent?: number }>,
): void {
  for (let i = 0; i < listEl.children.length; i++) {
    const li = listEl.children[i]
    if (li.tagName.toUpperCase() !== 'LI') continue

    let hasBlockChild = false
    for (let j = 0; j < li.children.length; j++) {
      const child = li.children[j]
      const tag = child.tagName.toUpperCase()
      if (tag === 'P') {
        result.push({})
        hasBlockChild = true
      } else if (tag === 'UL' || tag === 'OL') {
        collectListItemIndents(child, result)
        hasBlockChild = true
      }
    }

    if (!hasBlockChild) {
      result.push({})
    }
  }
}

/**
 * 在生成的 PPTX XML 中为文本段落注入精确的 indent / marL 属性。
 * 通过坐标匹配找到目标 shape，然后按段落索引注入属性。
 */
function applyTextIndents(doc: Document, textIndents: TextIndentInfo[]) {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return

  const allShapes: Element[] = []
  for (let i = 0; i < spTree.children.length; i++) {
    const child = spTree.children[i]
    if (child.localName === 'sp') {
      allShapes.push(child)
    }
  }

  const tolerance = 5000
  const used = new Set<number>()

  for (const ti of textIndents) {
    for (let i = 0; i < allShapes.length; i++) {
      if (used.has(i)) continue
      const shape = allShapes[i]
      const coords = getShapeCoords(shape)
      if (!coords) continue

      if (
        Math.abs(coords.x - ti.x) < tolerance
        && Math.abs(coords.y - ti.y) < tolerance
        && Math.abs(coords.w - ti.w) < tolerance
        && Math.abs(coords.h - ti.h) < tolerance
      ) {
        const txBody = shape.getElementsByTagNameNS(NS_A, 'txBody')[0]
        if (!txBody) break

        const aPs = txBody.getElementsByTagNameNS(NS_A, 'p')
        for (let pi = 0; pi < aPs.length && pi < ti.paragraphs.length; pi++) {
          const paraInfo = ti.paragraphs[pi]
          if (!paraInfo.indent && !paraInfo.marL) continue

          const aP = aPs[pi]
          let pPr = aP.getElementsByTagNameNS(NS_A, 'pPr')[0]
          if (!pPr) {
            pPr = doc.createElementNS(NS_A, 'a:pPr')
            aP.insertBefore(pPr, aP.firstChild)
          }

          if (paraInfo.indent !== undefined) {
            pPr.setAttribute('indent', String(paraInfo.indent))
          }
          if (paraInfo.marL !== undefined) {
            const hasBullet = pPr.getElementsByTagNameNS(NS_A, 'buChar').length > 0
              || pPr.getElementsByTagNameNS(NS_A, 'buAutoNum').length > 0
              || pPr.getElementsByTagNameNS(NS_A, 'buBlip').length > 0
            if (!hasBullet) {
              pPr.setAttribute('marL', String(paraInfo.marL))
            }
          }
        }

        used.add(i)
        break
      }
    }
  }
}

// ═══════════════════════════════════════════════
// 9.5. 项目符号样式注入
// ═══════════════════════════════════════════════

type _BulletParaStyle = { color?: string; fontSize?: string; fontFamily?: string }

/** 从文本元素 HTML 中收集各段落的项目符号样式 */
function collectBulletStyleInfo(
  el: PPTElement,
): { paragraphs: _BulletParaStyle[] } | null {
  const textEl = el as PPTTextElement
  const html = textEl.content
  if (!html) return null

  const div = document.createElement('div')
  div.innerHTML = html

  const paragraphs: _BulletParaStyle[] = []
  _collectBulletParaStyles(div, paragraphs, undefined)

  let needsPatch = false
  for (const p of paragraphs) {
    if (p.color || p.fontSize || p.fontFamily) {
      needsPatch = true
      break
    }
  }

  return needsPatch ? { paragraphs } : null
}

/** 递归收集段落的项目符号样式，顺序与 pptxgenjs 生成的 <a:p> 对应 */
function _collectBulletParaStyles(
  container: Element,
  result: _BulletParaStyle[],
  inherited: _BulletParaStyle | undefined,
): void {
  for (let i = 0; i < container.children.length; i++) {
    const child = container.children[i]
    const tag = child.tagName.toUpperCase()

    if (tag === 'P') {
      result.push(inherited ? { ...inherited } : {})
    } else if (tag === 'UL') {
      const bs: _BulletParaStyle = {}
      const color = child.getAttribute('data-bullet-color')
      const fontSize = child.getAttribute('data-bullet-font-size')
      const fontFamily = child.getAttribute('data-bullet-font')
      if (color) bs.color = color
      if (fontSize) bs.fontSize = fontSize
      if (fontFamily) bs.fontFamily = fontFamily
      const hasStyle = color || fontSize || fontFamily
      _collectBulletListItemStyles(child, result, hasStyle ? bs : inherited)
    } else if (tag === 'OL') {
      _collectBulletListItemStyles(child, result, inherited)
    } else {
      _collectBulletParaStyles(child, result, inherited)
    }
  }
}

/** 递归收集列表项内段落的项目符号样式 */
function _collectBulletListItemStyles(
  listEl: Element,
  result: _BulletParaStyle[],
  inherited: _BulletParaStyle | undefined,
): void {
  for (let i = 0; i < listEl.children.length; i++) {
    const li = listEl.children[i]
    if (li.tagName.toUpperCase() !== 'LI') continue

    let hasBlockChild = false
    for (let j = 0; j < li.children.length; j++) {
      const child = li.children[j]
      const tag = child.tagName.toUpperCase()
      if (tag === 'P') {
        result.push(inherited ? { ...inherited } : {})
        hasBlockChild = true
      } else if (tag === 'UL') {
        const bs: _BulletParaStyle = {}
        const color = child.getAttribute('data-bullet-color')
        const fontSize = child.getAttribute('data-bullet-font-size')
        const fontFamily = child.getAttribute('data-bullet-font')
        if (color) bs.color = color
        if (fontSize) bs.fontSize = fontSize
        if (fontFamily) bs.fontFamily = fontFamily
        const hasStyle = color || fontSize || fontFamily
        _collectBulletListItemStyles(child, result, hasStyle ? bs : inherited)
        hasBlockChild = true
      } else if (tag === 'OL') {
        _collectBulletListItemStyles(child, result, inherited)
        hasBlockChild = true
      }
    }

    if (!hasBlockChild) {
      result.push(inherited ? { ...inherited } : {})
    }
  }
}

/**
 * 在生成的 PPTX XML 中为项目符号段落注入 buClr/buSzPct/buSzPts/buFont。
 * pptxgenjs 不支持这些属性，需要通过后处理注入。
 */
function applyBulletStyles(doc: Document, bulletStyles: BulletStylePatchInfo[]): void {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return

  const allShapes: Element[] = []
  for (let i = 0; i < spTree.children.length; i++) {
    const child = spTree.children[i]
    if (child.localName === 'sp') {
      allShapes.push(child)
    }
  }

  const tolerance = 5000
  const used = new Set<number>()

  for (const bs of bulletStyles) {
    for (let i = 0; i < allShapes.length; i++) {
      if (used.has(i)) continue
      const shape = allShapes[i]
      const coords = getShapeCoords(shape)
      if (!coords) continue

      if (
        Math.abs(coords.x - bs.x) < tolerance
        && Math.abs(coords.y - bs.y) < tolerance
        && Math.abs(coords.w - bs.w) < tolerance
        && Math.abs(coords.h - bs.h) < tolerance
      ) {
        const txBody = shape.getElementsByTagNameNS(NS_A, 'txBody')[0]
        if (!txBody) break

        const aPs = txBody.getElementsByTagNameNS(NS_A, 'p')
        for (let pi = 0; pi < aPs.length && pi < bs.paragraphs.length; pi++) {
          const paraStyle = bs.paragraphs[pi]
          if (!paraStyle.color && !paraStyle.fontSize && !paraStyle.fontFamily) continue

          const aP = aPs[pi]
          let pPr = aP.getElementsByTagNameNS(NS_A, 'pPr')[0]
          if (!pPr) {
            pPr = doc.createElementNS(NS_A, 'a:pPr')
            aP.insertBefore(pPr, aP.firstChild)
          }

          // 检查是否有项目符号（buChar/buAutoNum）才注入样式
          const hasBullet = pPr.getElementsByTagNameNS(NS_A, 'buChar').length > 0
            || pPr.getElementsByTagNameNS(NS_A, 'buAutoNum').length > 0
          if (!hasBullet) continue

          // 注入 buClr（需在 buChar/buAutoNum 之前）
          if (paraStyle.color) {
            const hex = paraStyle.color.replace(/^#/, '').slice(0, 6).toUpperCase()
            const buClr = doc.createElementNS(NS_A, 'a:buClr')
            const srgbClr = doc.createElementNS(NS_A, 'a:srgbClr')
            srgbClr.setAttribute('val', hex)
            buClr.appendChild(srgbClr)
            // 插到 buChar/buAutoNum 之前
            const buCharEl = pPr.getElementsByTagNameNS(NS_A, 'buChar')[0]
              || pPr.getElementsByTagNameNS(NS_A, 'buAutoNum')[0]
            if (buCharEl) {
              pPr.insertBefore(buClr, buCharEl)
            } else {
              pPr.appendChild(buClr)
            }
          }

          // 注入 buSzPct 或 buSzPts
          if (paraStyle.fontSize) {
            const fs = paraStyle.fontSize
            const buCharEl = pPr.getElementsByTagNameNS(NS_A, 'buChar')[0]
              || pPr.getElementsByTagNameNS(NS_A, 'buAutoNum')[0]
            if (fs.endsWith('%')) {
              const pctVal = parseInt(fs) * 1000
              const buSzPct = doc.createElementNS(NS_A, 'a:buSzPct')
              buSzPct.setAttribute('val', String(pctVal))
              if (buCharEl) pPr.insertBefore(buSzPct, buCharEl)
              else pPr.appendChild(buSzPct)
            } else if (fs.endsWith('pt')) {
              const ptsVal = Math.round(parseFloat(fs) * 100)
              const buSzPts = doc.createElementNS(NS_A, 'a:buSzPts')
              buSzPts.setAttribute('val', String(ptsVal))
              if (buCharEl) pPr.insertBefore(buSzPts, buCharEl)
              else pPr.appendChild(buSzPts)
            }
          }

          // 注入 buFont
          if (paraStyle.fontFamily) {
            const buCharEl = pPr.getElementsByTagNameNS(NS_A, 'buChar')[0]
              || pPr.getElementsByTagNameNS(NS_A, 'buAutoNum')[0]
            const buFont = doc.createElementNS(NS_A, 'a:buFont')
            buFont.setAttribute('typeface', paraStyle.fontFamily)
            if (buCharEl) pPr.insertBefore(buFont, buCharEl)
            else pPr.appendChild(buFont)
          }
        }

        used.add(i)
        break
      }
    }
  }
}

// ═══════════════════════════════════════════════
// 11. 主题色填充注入
// ═══════════════════════════════════════════════

/**
 * 将形状的 solidFill/srgbClr 替换为 schemeClr（主题色引用）。
 *
 * pptxgenjs 只能输出固定 RGB 颜色，无法输出 OOXML 的 schemeClr 主题色引用。
 * 此函数通过坐标匹配找到 XML 中的 <p:sp>，将其填充/轮廓中的 srgbClr 替换为 schemeClr。
 */
function applyThemeColorFills(doc: Document, fills: ThemeColorFillInfo[]): void {
  const tolerance = 5000 // ~0.5px
  const allShapes = doc.getElementsByTagNameNS(NS_P, 'sp')

  for (const fill of fills) {
    for (let i = 0; i < allShapes.length; i++) {
      const shape = allShapes[i]
      const coords = getShapeCoords(shape)
      if (!coords) continue

      if (
        Math.abs(coords.x - fill.x) < tolerance
        && Math.abs(coords.y - fill.y) < tolerance
        && Math.abs(coords.w - fill.w) < tolerance
        && Math.abs(coords.h - fill.h) < tolerance
      ) {
        const spPr = shape.getElementsByTagNameNS(NS_A, 'spPr')[0]
        if (!spPr) break

        // 替换形状填充中的 srgbClr → schemeClr
        if (fill.fillThemeKey) {
          const solidFill = spPr.getElementsByTagNameNS(NS_A, 'solidFill')[0]
          if (solidFill) {
            replaceSolidFillWithSchemeClr(doc, solidFill, fill.fillThemeKey, fill.fillThemeTransforms)
          }
        }

        // 替换轮廓中的 srgbClr → schemeClr
        if (fill.outlineThemeKey) {
          const ln = spPr.getElementsByTagNameNS(NS_A, 'ln')[0]
          if (ln) {
            const lnFill = ln.getElementsByTagNameNS(NS_A, 'solidFill')[0]
            if (lnFill) {
              replaceSolidFillWithSchemeClr(doc, lnFill, fill.outlineThemeKey)
            }
          }
        }
        break
      }
    }
  }
}

/**
 * 将 <a:solidFill> 内的颜色元素替换为 <a:schemeClr>。
 * 保留原有 alpha 变换，并可选注入 tint/shade/lumMod/lumOff 变换。
 */
function replaceSolidFillWithSchemeClr(
  doc: Document,
  solidFill: Element,
  themeKey: string,
  transforms?: Record<string, number>,
): void {
  // 保留已有 alpha 值
  let existingAlpha: string | null = null
  const existingColor = solidFill.getElementsByTagNameNS(NS_A, 'srgbClr')[0]
    || solidFill.getElementsByTagNameNS(NS_A, 'schemeClr')[0]
  if (existingColor) {
    const alphaEl = existingColor.getElementsByTagNameNS(NS_A, 'alpha')[0]
    if (alphaEl) {
      existingAlpha = alphaEl.getAttribute('val')
    }
  }

  // 清空 solidFill 内容
  while (solidFill.firstChild) solidFill.removeChild(solidFill.firstChild)

  // 写入 schemeClr
  const schemeClr = doc.createElementNS(NS_A, 'a:schemeClr')
  schemeClr.setAttribute('val', themeKey)

  // 注入颜色变换子元素
  if (transforms) {
    for (const [key, value] of Object.entries(transforms)) {
      if (value == null || !Number.isFinite(value)) continue
      const transformEl = doc.createElementNS(NS_A, `a:${key}`)
      transformEl.setAttribute('val', String(Math.round(value * 100000)))
      schemeClr.appendChild(transformEl)
    }
  }

  // 还原 alpha
  if (existingAlpha) {
    const alphaEl = doc.createElementNS(NS_A, 'a:alpha')
    alphaEl.setAttribute('val', existingAlpha)
    schemeClr.appendChild(alphaEl)
  }

  solidFill.appendChild(schemeClr)
}

// ═══════════════════════════════════════════════
// 12. 嵌入字体注入
// ═══════════════════════════════════════════════

const NS_PRES = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const FONT_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'

/** 生成 v4 风格 GUID（无需加密安全，仅用于 OOXML 字体文件名） */
function generateGuid(): string {
  const hex = '0123456789abcdef'
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
  return template.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    return hex[c === 'x' ? r : (r & 0x3 | 0x8)]
  })
}

/**
 * GUID → 16 字节 OOXML 字体混淆 key。
 *
 * ECMA-376 Part 2 §13.2.1 规定：
 * - 前三段 (uint32, uint16, uint16) little-endian
 * - 后两段 big-endian (raw hex bytes)
 */
function guidToObfuscationKey(guid: string): Uint8Array {
  const parts = guid.split('-')
  if (parts.length !== 5) throw new Error(`Invalid GUID: ${guid}`)
  const key = new Uint8Array(16)

  // Part 1: uint32 LE
  const p1 = parseInt(parts[0], 16)
  key[0] = p1 & 0xff
  key[1] = (p1 >> 8) & 0xff
  key[2] = (p1 >> 16) & 0xff
  key[3] = (p1 >> 24) & 0xff

  // Part 2: uint16 LE
  const p2 = parseInt(parts[1], 16)
  key[4] = p2 & 0xff
  key[5] = (p2 >> 8) & 0xff

  // Part 3: uint16 LE
  const p3 = parseInt(parts[2], 16)
  key[6] = p3 & 0xff
  key[7] = (p3 >> 8) & 0xff

  // Part 4+5: big-endian (raw hex)
  const hexStr = parts[3] + parts[4]
  for (let i = 0; i < 8; i++) {
    key[8 + i] = parseInt(hexStr.substr(i * 2, 2), 16)
  }

  return key
}

/** OOXML 字体混淆：XOR 前 32 字节 with 16-byte key repeated */
function obfuscateFontData(data: Uint8Array, guid: string): Uint8Array {
  const key = guidToObfuscationKey(guid)
  const key32 = new Uint8Array(32)
  key32.set(key, 0)
  key32.set(key, 16)

  const result = new Uint8Array(data)
  for (let i = 0; i < Math.min(32, result.length); i++) {
    result[i] ^= key32[i]
  }
  return result
}

/** Base64 解码为 Uint8Array */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

type EmbeddedFontInput = { name: string; style: string; format: string; data_base64?: string; oss_url?: string }
type FontStyleVariant = 'normal' | 'bold' | 'italic' | 'bolditalic'
const FONT_VARIANT_XML_TAG: Record<FontStyleVariant, string> = {
  normal: 'p:regular',
  bold: 'p:bold',
  italic: 'p:italic',
  bolditalic: 'p:boldItalic',
}

/**
 * 将嵌入字体写入 PPTX ZIP 并更新 presentation.xml + rels。
 *
 * OOXML 字体嵌入结构：
 * - ppt/fonts/{GUID}.fntdata — 混淆后的字体二进制
 * - ppt/presentation.xml — <p:embeddedFontLst> 声明
 * - ppt/_rels/presentation.xml.rels — rId 关系
 * - [Content_Types].xml — fntdata 类型声明
 */
async function embedFontsIntoPptx(
  zip: JSZip,
  fonts: EmbeddedFontInput[],
): Promise<void> {
  if (!fonts || fonts.length === 0) return

  const parser = new DOMParser()
  const serializer = new XMLSerializer()

  // 1. 读取 presentation.xml
  const presPath = 'ppt/presentation.xml'
  const presXml = await zip.file(presPath)?.async('string')
  if (!presXml) return
  const presDoc = parser.parseFromString(presXml, 'application/xml')

  // 2. 读取 presentation.xml.rels
  const presRelPath = 'ppt/_rels/presentation.xml.rels'
  const presRelXml = await zip.file(presRelPath)?.async('string')
  if (!presRelXml) return
  const presRelDoc = parser.parseFromString(presRelXml, 'application/xml')
  const presRelRoot = presRelDoc.getElementsByTagNameNS(NS_REL, 'Relationships')[0]
    || presRelDoc.documentElement
  if (!presRelRoot) return

  // 3. 读取 [Content_Types].xml
  const ctPath = '[Content_Types].xml'
  const ctXml = await zip.file(ctPath)?.async('string')
  if (!ctXml) return
  const ctDoc = parser.parseFromString(ctXml, 'application/xml')

  // 4. 确保 fntdata 有 ContentType
  ensureContentTypeDefault(ctDoc, 'fntdata', 'application/x-fontdata')

  // 5. 按字体名称分组
  const fontMap = new Map<string, Map<FontStyleVariant, EmbeddedFontInput>>()
  for (const font of fonts) {
    const name = font.name.trim()
    if (!name || (!font.data_base64 && !font.oss_url)) continue
    const style = (font.style || 'normal').toLowerCase() as FontStyleVariant
    if (!FONT_VARIANT_XML_TAG[style]) continue

    let variants = fontMap.get(name)
    if (!variants) {
      variants = new Map()
      fontMap.set(name, variants)
    }
    if (!variants.has(style)) {
      variants.set(style, font)
    }
  }

  if (fontMap.size === 0) return

  // 6. 获取下一个可用的 rId
  let relIdSeed = getNextRelNumericId(presRelDoc)

  // 7. 查找或创建 <p:embeddedFontLst>
  const presRoot = presDoc.documentElement
  let embFontLst = presDoc.getElementsByTagNameNS(NS_PRES, 'embeddedFontLst')[0]
  if (!embFontLst) {
    embFontLst = presDoc.createElementNS(NS_PRES, 'p:embeddedFontLst')
    // 按 OOXML schema 顺序，embeddedFontLst 应在 sldMasterIdLst 之后
    const sldMasterIdLst = presDoc.getElementsByTagNameNS(NS_PRES, 'sldMasterIdLst')[0]
    const notesMasterIdLst = presDoc.getElementsByTagNameNS(NS_PRES, 'notesMasterIdLst')[0]
    const handoutMasterIdLst = presDoc.getElementsByTagNameNS(NS_PRES, 'handoutMasterIdLst')[0]
    const sldIdLst = presDoc.getElementsByTagNameNS(NS_PRES, 'sldIdLst')[0]
    // 插入位置：sldIdLst 之后（或 sldMasterIdLst 之后）
    const insertAfter = sldIdLst || handoutMasterIdLst || notesMasterIdLst || sldMasterIdLst
    if (insertAfter && insertAfter.nextSibling) {
      presRoot.insertBefore(embFontLst, insertAfter.nextSibling)
    } else if (insertAfter) {
      presRoot.appendChild(embFontLst)
    } else {
      // Fallback: insert at beginning
      presRoot.insertBefore(embFontLst, presRoot.firstChild)
    }
  }

  // 8. 为每个字体创建嵌入条目
  for (const [fontName, variants] of fontMap) {
    const embFont = presDoc.createElementNS(NS_PRES, 'p:embeddedFont')

    // <p:font typeface="FontName" />
    const fontEl = presDoc.createElementNS(NS_PRES, 'p:font')
    fontEl.setAttribute('typeface', fontName)
    embFont.appendChild(fontEl)

    // 每种样式变体
    for (const [style, fontData] of variants) {
      const xmlTag = FONT_VARIANT_XML_TAG[style]
      if (!xmlTag) continue

      try {
        // 生成 GUID
        const guid = generateGuid()
        const guidBraced = `{${guid.toUpperCase()}}`
        const fntdataFilename = `${guidBraced}.fntdata`
        const fntdataPath = `ppt/fonts/${fntdataFilename}`

        // 获取字体二进制：优先 base64，fallback 到 OSS URL
        let rawBytes: Uint8Array | null = null
        if (fontData.data_base64) {
          rawBytes = base64ToUint8Array(fontData.data_base64)
        } else if (fontData.oss_url) {
          try {
            const resp = await fetch(fontData.oss_url)
            if (resp.ok) {
              rawBytes = new Uint8Array(await resp.arrayBuffer())
            }
          } catch {
            console.warn(`[PPTX PostProcess] 字体 ${fontName} (${style}) OSS 下载失败`)
          }
        }
        if (!rawBytes || rawBytes.length < 32) continue
        const obfuscated = obfuscateFontData(rawBytes, guid)

        // 写入字体文件
        zip.file(fntdataPath, obfuscated)

        // 添加 relationship
        const rId = `rId${relIdSeed}`
        relIdSeed += 1
        const relEl = presRelDoc.createElementNS(NS_REL, 'Relationship')
        relEl.setAttribute('Id', rId)
        relEl.setAttribute('Type', FONT_REL_TYPE)
        relEl.setAttribute('Target', `fonts/${fntdataFilename}`)
        presRelRoot.appendChild(relEl)

        // 添加 <p:regular/p:bold/p:italic/p:boldItalic r:embed="rIdN" />
        const variantEl = presDoc.createElementNS(NS_PRES, xmlTag)
        variantEl.setAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'r:embed',
          rId,
        )
        embFont.appendChild(variantEl)
      } catch (err) {
        console.warn(`[PPTX PostProcess] 字体 ${fontName} (${style}) 嵌入失败:`, err)
      }
    }

    // 只有包含至少一个变体才添加到列表
    if (embFont.children.length > 1) { // >1 because <p:font> is always there
      embFontLst.appendChild(embFont)
    }
  }

  // 9. 写回所有修改的文件
  zip.file(presPath, serializer.serializeToString(presDoc))
  zip.file(presRelPath, serializer.serializeToString(presRelDoc))
  zip.file(ctPath, serializer.serializeToString(ctDoc))
}

// ═══════════════════════════════════════════════
// 12.5. 翻页过渡注入
// ═══════════════════════════════════════════════

function applySlideTransition(doc: Document, mode: string): void {
  const sld = doc.documentElement
  if (!sld) return

  const transition = doc.createElementNS(NS_P, 'p:transition')
  transition.setAttribute('spd', 'med')
  transition.setAttribute('advClick', '1')

  let effectEl: Element | null = null
  switch (mode) {
    case 'fade':
      effectEl = doc.createElementNS(NS_P, 'p:fade')
      break
    case 'slideX':
    case 'slideX3D':
      effectEl = doc.createElementNS(NS_P, 'p:push')
      effectEl.setAttribute('dir', 'l')
      break
    case 'slideY':
    case 'slideY3D':
      effectEl = doc.createElementNS(NS_P, 'p:push')
      effectEl.setAttribute('dir', 'd')
      break
    case 'rotate':
      effectEl = doc.createElementNS(NS_P, 'p:wheel')
      effectEl.setAttribute('spokes', '4')
      break
    case 'scale':
      effectEl = doc.createElementNS(NS_P, 'p:zoom')
      effectEl.setAttribute('dir', 'in')
      break
    case 'scaleReverse':
      effectEl = doc.createElementNS(NS_P, 'p:zoom')
      effectEl.setAttribute('dir', 'out')
      break
    case 'scaleX':
      effectEl = doc.createElementNS(NS_P, 'p:split')
      effectEl.setAttribute('dir', 'horz')
      effectEl.setAttribute('orient', 'out')
      break
    case 'scaleY':
      effectEl = doc.createElementNS(NS_P, 'p:split')
      effectEl.setAttribute('dir', 'vert')
      effectEl.setAttribute('orient', 'out')
      break
    default:
      effectEl = doc.createElementNS(NS_P, 'p:fade')
      break
  }

  if (effectEl) transition.appendChild(effectEl)

  const cSld = doc.getElementsByTagNameNS(NS_P, 'cSld')[0]
  if (cSld && cSld.nextSibling) {
    sld.insertBefore(transition, cSld.nextSibling)
  } else {
    sld.appendChild(transition)
  }
}

// ═══════════════════════════════════════════════
// 12.6. 元素动画注入（OOXML timing tree）
// ═══════════════════════════════════════════════

/**
 * TabSlide 动画效果 → OOXML animEffect 映射
 *
 * presetID / presetSubtype 来自 ECMA-376 Part 1 §19.5.1 Preset Transition Types
 * filter 字符串对应 <p:animEffect> 的 filter 属性
 */
interface OoxmlAnimMapping {
  presetID: number
  presetClass: 'entr' | 'exit' | 'emph'
  presetSubtype: number
  filter: string
}

const ENTRANCE_EFFECT_MAP: Record<string, Partial<OoxmlAnimMapping>> = {
  fadeIn: { presetID: 10, filter: 'fade' },
  fadeInDown: { presetID: 10, presetSubtype: 4, filter: 'fade' },
  fadeInUp: { presetID: 10, presetSubtype: 1, filter: 'fade' },
  fadeInLeft: { presetID: 10, presetSubtype: 8, filter: 'fade' },
  fadeInRight: { presetID: 10, presetSubtype: 2, filter: 'fade' },
  zoomIn: { presetID: 23, filter: 'fade' },
  zoomInDown: { presetID: 23, presetSubtype: 4, filter: 'fade' },
  zoomInUp: { presetID: 23, presetSubtype: 1, filter: 'fade' },
  zoomInLeft: { presetID: 23, presetSubtype: 8, filter: 'fade' },
  zoomInRight: { presetID: 23, presetSubtype: 2, filter: 'fade' },
  bounceIn: { presetID: 10, filter: 'fade' },
  bounceInDown: { presetID: 10, presetSubtype: 4, filter: 'fade' },
  bounceInUp: { presetID: 10, presetSubtype: 1, filter: 'fade' },
  bounceInLeft: { presetID: 10, presetSubtype: 8, filter: 'fade' },
  bounceInRight: { presetID: 10, presetSubtype: 2, filter: 'fade' },
  slideInDown: { presetID: 22, presetSubtype: 4, filter: 'wipe(down)' },
  slideInUp: { presetID: 22, presetSubtype: 1, filter: 'wipe(up)' },
  slideInLeft: { presetID: 22, presetSubtype: 8, filter: 'wipe(left)' },
  slideInRight: { presetID: 22, presetSubtype: 2, filter: 'wipe(right)' },
  rotateIn: { presetID: 10, filter: 'fade' },
  rotateInDownLeft: { presetID: 10, filter: 'fade' },
  rotateInDownRight: { presetID: 10, filter: 'fade' },
  rotateInUpLeft: { presetID: 10, filter: 'fade' },
  rotateInUpRight: { presetID: 10, filter: 'fade' },
  flipInX: { presetID: 10, filter: 'fade' },
  flipInY: { presetID: 10, filter: 'fade' },
  backInDown: { presetID: 10, presetSubtype: 4, filter: 'fade' },
  backInUp: { presetID: 10, presetSubtype: 1, filter: 'fade' },
  backInLeft: { presetID: 10, presetSubtype: 8, filter: 'fade' },
  backInRight: { presetID: 10, presetSubtype: 2, filter: 'fade' },
  lightSpeedInRight: { presetID: 22, presetSubtype: 2, filter: 'wipe(right)' },
  lightSpeedInLeft: { presetID: 22, presetSubtype: 8, filter: 'wipe(left)' },
}

const ATTENTION_EFFECT_MAP: Record<string, Partial<OoxmlAnimMapping>> = {
  pulse: { presetID: 10, filter: 'fade' },
  bounce: { presetID: 24, filter: 'fade' },
  shake: { presetID: 2, filter: 'fade' },
  flash: { presetID: 5, filter: 'fade' },
  spin: { presetID: 8, filter: 'fade' },
  swing: { presetID: 2, filter: 'fade' },
  tada: { presetID: 14, filter: 'fade' },
  wobble: { presetID: 2, filter: 'fade' },
  jello: { presetID: 14, filter: 'fade' },
  heartBeat: { presetID: 10, filter: 'fade' },
  rubberBand: { presetID: 14, filter: 'fade' },
}

const EXIT_EFFECT_MAP: Record<string, Partial<OoxmlAnimMapping>> = {
  fadeOut: { presetID: 10, filter: 'fade' },
  fadeOutDown: { presetID: 10, presetSubtype: 4, filter: 'fade' },
  fadeOutUp: { presetID: 10, presetSubtype: 1, filter: 'fade' },
  fadeOutLeft: { presetID: 10, presetSubtype: 8, filter: 'fade' },
  fadeOutRight: { presetID: 10, presetSubtype: 2, filter: 'fade' },
  zoomOut: { presetID: 23, filter: 'fade' },
  zoomOutDown: { presetID: 23, presetSubtype: 4, filter: 'fade' },
  zoomOutUp: { presetID: 23, presetSubtype: 1, filter: 'fade' },
  zoomOutLeft: { presetID: 23, presetSubtype: 8, filter: 'fade' },
  zoomOutRight: { presetID: 23, presetSubtype: 2, filter: 'fade' },
  bounceOut: { presetID: 10, filter: 'fade' },
  bounceOutDown: { presetID: 10, presetSubtype: 4, filter: 'fade' },
  bounceOutUp: { presetID: 10, presetSubtype: 1, filter: 'fade' },
  bounceOutLeft: { presetID: 10, presetSubtype: 8, filter: 'fade' },
  bounceOutRight: { presetID: 10, presetSubtype: 2, filter: 'fade' },
  slideOutDown: { presetID: 22, presetSubtype: 4, filter: 'wipe(down)' },
  slideOutUp: { presetID: 22, presetSubtype: 1, filter: 'wipe(up)' },
  slideOutLeft: { presetID: 22, presetSubtype: 8, filter: 'wipe(left)' },
  slideOutRight: { presetID: 22, presetSubtype: 2, filter: 'wipe(right)' },
}

function resolveAnimMapping(anim: AnimationPostProcessInfo): OoxmlAnimMapping {
  const effectMap = anim.type === 'in' ? ENTRANCE_EFFECT_MAP
    : anim.type === 'out' ? EXIT_EFFECT_MAP
    : ATTENTION_EFFECT_MAP
  const partial = effectMap?.[anim.effect]
  const presetClass = anim.type === 'in' ? 'entr' : anim.type === 'out' ? 'exit' : 'emph'
  return {
    presetID: partial?.presetID ?? 10,
    presetClass,
    presetSubtype: partial?.presetSubtype ?? 0,
    filter: partial?.filter ?? 'fade',
  }
}

function findShapeSpId(
  allShapes: Element[],
  x: number, y: number, w: number, h: number,
): number | null {
  const tolerance = 5000
  for (const shape of allShapes) {
    const coords = getShapeCoords(shape)
    if (!coords) continue
    if (
      Math.abs(coords.x - x) < tolerance &&
      Math.abs(coords.y - y) < tolerance &&
      Math.abs(coords.w - w) < tolerance &&
      Math.abs(coords.h - h) < tolerance
    ) {
      const cNvPr = shape.getElementsByTagNameNS(NS_P, 'cNvPr')[0]
      if (cNvPr) {
        const id = parseInt(cNvPr.getAttribute('id') || '0', 10)
        if (id > 0) return id
      }
    }
  }
  return null
}

function collectAllShapeNodesDeep(parent: Element, result: Element[]): void {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i]
    const ln = child.localName
    if (ln === 'sp' || ln === 'pic' || ln === 'graphicFrame' || ln === 'cxnSp') {
      result.push(child)
    } else if (ln === 'grpSp') {
      collectAllShapeNodesDeep(child, result)
    }
  }
}

function applySlideAnimations(
  doc: Document,
  animations: AnimationPostProcessInfo[],
): void {
  if (animations.length === 0) return

  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0]
  if (!spTree) return

  const allShapes: Element[] = []
  collectAllShapeNodesDeep(spTree, allShapes)
  if (allShapes.length === 0) return

  // 解析每个动画的目标 shape ID
  type ResolvedAnim = { anim: AnimationPostProcessInfo; spId: number; mapping: OoxmlAnimMapping }
  const resolved: ResolvedAnim[] = []
  for (const anim of animations) {
    const spId = findShapeSpId(allShapes, anim.x, anim.y, anim.w, anim.h)
    if (!spId) continue
    resolved.push({ anim, spId, mapping: resolveAnimMapping(anim) })
  }
  if (resolved.length === 0) return

  // 按触发方式分组（click 开新组，meantime/auto 加入当前组）
  const clickGroups: ResolvedAnim[][] = []
  for (const entry of resolved) {
    if (clickGroups.length === 0 || entry.anim.trigger === 'click') {
      clickGroups.push([entry])
    } else {
      clickGroups[clickGroups.length - 1].push(entry)
    }
  }

  // 构建 OOXML timing tree
  const ctr = { v: 1 }
  const nextId = () => ctr.v++

  const timing = doc.createElementNS(NS_P, 'p:timing')
  const tnLst = doc.createElementNS(NS_P, 'p:tnLst')

  const rootPar = doc.createElementNS(NS_P, 'p:par')
  const rootCTn = doc.createElementNS(NS_P, 'p:cTn')
  rootCTn.setAttribute('id', String(nextId()))
  rootCTn.setAttribute('dur', 'indefinite')
  rootCTn.setAttribute('restart', 'never')
  rootCTn.setAttribute('nodeType', 'tmRoot')

  const rootChildTnLst = doc.createElementNS(NS_P, 'p:childTnLst')

  const seq = doc.createElementNS(NS_P, 'p:seq')
  seq.setAttribute('concurrent', '1')
  seq.setAttribute('nextAc', 'seek')

  const seqCTn = doc.createElementNS(NS_P, 'p:cTn')
  seqCTn.setAttribute('id', String(nextId()))
  seqCTn.setAttribute('dur', 'indefinite')
  seqCTn.setAttribute('nodeType', 'mainSeq')

  const seqChildTnLst = doc.createElementNS(NS_P, 'p:childTnLst')

  for (const group of clickGroups) {
    const groupPar = doc.createElementNS(NS_P, 'p:par')
    const groupCTn = doc.createElementNS(NS_P, 'p:cTn')
    groupCTn.setAttribute('id', String(nextId()))
    groupCTn.setAttribute('fill', 'hold')
    appendStartCondition(doc, groupCTn, '0')

    const groupChildTnLst = doc.createElementNS(NS_P, 'p:childTnLst')

    let currentGroupStart = 0
    let currentGroupMaxEnd = 0

    for (let i = 0; i < group.length; i++) {
      const entry = group[i]
      let startDelay: number

      if (entry.anim.trigger === 'auto' && i > 0) {
        currentGroupStart = currentGroupMaxEnd
        startDelay = currentGroupStart
        currentGroupMaxEnd = currentGroupStart + entry.anim.durationMs
      } else {
        startDelay = currentGroupStart
        currentGroupMaxEnd = Math.max(
          currentGroupMaxEnd,
          currentGroupStart + entry.anim.durationMs,
        )
      }

      const animPar = buildAnimationParNode(doc, entry, nextId, startDelay)
      groupChildTnLst.appendChild(animPar)
    }

    groupCTn.appendChild(groupChildTnLst)
    groupPar.appendChild(groupCTn)
    seqChildTnLst.appendChild(groupPar)
  }

  seqCTn.appendChild(seqChildTnLst)
  seq.appendChild(seqCTn)

  // prevCondLst / nextCondLst
  const prevCondLst = doc.createElementNS(NS_P, 'p:prevCondLst')
  const prevCond = doc.createElementNS(NS_P, 'p:cond')
  prevCond.setAttribute('evt', 'onPrev')
  prevCond.setAttribute('delay', '0')
  const prevTgt = doc.createElementNS(NS_P, 'p:tgtEl')
  prevTgt.appendChild(doc.createElementNS(NS_P, 'p:sldTgt'))
  prevCond.appendChild(prevTgt)
  prevCondLst.appendChild(prevCond)
  seq.appendChild(prevCondLst)

  const nextCondLst = doc.createElementNS(NS_P, 'p:nextCondLst')
  const nextCond = doc.createElementNS(NS_P, 'p:cond')
  nextCond.setAttribute('evt', 'onNext')
  nextCond.setAttribute('delay', '0')
  const nextTgt = doc.createElementNS(NS_P, 'p:tgtEl')
  nextTgt.appendChild(doc.createElementNS(NS_P, 'p:sldTgt'))
  nextCond.appendChild(nextTgt)
  nextCondLst.appendChild(nextCond)
  seq.appendChild(nextCondLst)

  rootChildTnLst.appendChild(seq)
  rootCTn.appendChild(rootChildTnLst)
  rootPar.appendChild(rootCTn)
  tnLst.appendChild(rootPar)
  timing.appendChild(tnLst)

  doc.documentElement.appendChild(timing)
}

function appendStartCondition(doc: Document, cTn: Element, delay: string): void {
  const stCondLst = doc.createElementNS(NS_P, 'p:stCondLst')
  const cond = doc.createElementNS(NS_P, 'p:cond')
  cond.setAttribute('delay', delay)
  stCondLst.appendChild(cond)
  cTn.appendChild(stCondLst)
}

function buildTargetElement(doc: Document, spId: number): Element {
  const tgtEl = doc.createElementNS(NS_P, 'p:tgtEl')
  const spTgt = doc.createElementNS(NS_P, 'p:spTgt')
  spTgt.setAttribute('spid', String(spId))
  tgtEl.appendChild(spTgt)
  return tgtEl
}

function buildSetVisibility(
  doc: Document,
  spId: number,
  nextId: () => number,
  value: 'visible' | 'hidden',
  delayMs: number = 0,
): Element {
  const set = doc.createElementNS(NS_P, 'p:set')
  const cBhvr = doc.createElementNS(NS_P, 'p:cBhvr')

  const cTn = doc.createElementNS(NS_P, 'p:cTn')
  cTn.setAttribute('id', String(nextId()))
  cTn.setAttribute('dur', '1')
  cTn.setAttribute('fill', 'hold')
  appendStartCondition(doc, cTn, String(delayMs))
  cBhvr.appendChild(cTn)

  cBhvr.appendChild(buildTargetElement(doc, spId))

  const attrNameLst = doc.createElementNS(NS_P, 'p:attrNameLst')
  const attrName = doc.createElementNS(NS_P, 'p:attrName')
  attrName.textContent = 'style.visibility'
  attrNameLst.appendChild(attrName)
  cBhvr.appendChild(attrNameLst)
  set.appendChild(cBhvr)

  const to = doc.createElementNS(NS_P, 'p:to')
  const strVal = doc.createElementNS(NS_P, 'p:strVal')
  strVal.setAttribute('val', value)
  to.appendChild(strVal)
  set.appendChild(to)

  return set
}

function buildAnimEffect(
  doc: Document,
  mapping: OoxmlAnimMapping,
  spId: number,
  nextId: () => number,
  durationMs: number,
): Element {
  const animEffect = doc.createElementNS(NS_P, 'p:animEffect')
  animEffect.setAttribute('transition', mapping.presetClass === 'exit' ? 'out' : 'in')
  animEffect.setAttribute('filter', mapping.filter)

  const cBhvr = doc.createElementNS(NS_P, 'p:cBhvr')
  const cTn = doc.createElementNS(NS_P, 'p:cTn')
  cTn.setAttribute('id', String(nextId()))
  cTn.setAttribute('dur', String(Math.max(1, durationMs)))
  cBhvr.appendChild(cTn)
  cBhvr.appendChild(buildTargetElement(doc, spId))
  animEffect.appendChild(cBhvr)

  return animEffect
}

function buildEmphasisAnim(
  doc: Document,
  spId: number,
  nextId: () => number,
  durationMs: number,
): Element {
  const animScale = doc.createElementNS(NS_P, 'p:animScale')
  const cBhvr = doc.createElementNS(NS_P, 'p:cBhvr')

  const cTn = doc.createElementNS(NS_P, 'p:cTn')
  cTn.setAttribute('id', String(nextId()))
  cTn.setAttribute('dur', String(Math.max(1, Math.round(durationMs / 2))))
  cTn.setAttribute('autoRev', '1')
  cTn.setAttribute('fill', 'hold')
  cBhvr.appendChild(cTn)
  cBhvr.appendChild(buildTargetElement(doc, spId))
  animScale.appendChild(cBhvr)

  const by = doc.createElementNS(NS_P, 'p:by')
  by.setAttribute('x', '110000')
  by.setAttribute('y', '110000')
  animScale.appendChild(by)

  return animScale
}

function buildAnimationParNode(
  doc: Document,
  entry: { anim: AnimationPostProcessInfo; spId: number; mapping: OoxmlAnimMapping },
  nextId: () => number,
  startDelayMs: number = 0,
): Element {
  const { anim, spId, mapping } = entry
  const par = doc.createElementNS(NS_P, 'p:par')
  const cTn = doc.createElementNS(NS_P, 'p:cTn')
  cTn.setAttribute('id', String(nextId()))
  cTn.setAttribute('presetID', String(mapping.presetID))
  cTn.setAttribute('presetClass', mapping.presetClass)
  cTn.setAttribute('presetSubtype', String(mapping.presetSubtype))
  cTn.setAttribute('fill', 'hold')
  cTn.setAttribute('grpId', '0')

  const nodeType = anim.trigger === 'meantime' ? 'withEffect'
    : anim.trigger === 'auto' ? 'afterEffect'
    : 'clickEffect'
  cTn.setAttribute('nodeType', nodeType)

  appendStartCondition(doc, cTn, String(startDelayMs))

  const childTnLst = doc.createElementNS(NS_P, 'p:childTnLst')

  if (anim.type === 'in') {
    childTnLst.appendChild(buildSetVisibility(doc, spId, nextId, 'visible'))
    childTnLst.appendChild(buildAnimEffect(doc, mapping, spId, nextId, anim.durationMs))
  } else if (anim.type === 'out') {
    childTnLst.appendChild(buildAnimEffect(doc, mapping, spId, nextId, anim.durationMs))
    childTnLst.appendChild(buildSetVisibility(doc, spId, nextId, 'hidden', anim.durationMs))
  } else {
    childTnLst.appendChild(buildEmphasisAnim(doc, spId, nextId, anim.durationMs))
  }

  cTn.appendChild(childTnLst)
  par.appendChild(cTn)
  return par
}

