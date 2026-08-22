/**
 * 后端数据适配器 — 将后端 pptx_io.read() 输出的 JSON 转换为前端 SlidePresentation
 *
 * 后端 API 返回格式（_serialize_project_detail）:
 * {
 *   id, name, preset, canvas_width, canvas_height, page_count,
 *   thumbnail, theme, created_at, updated_at,
 *   pages: [
 *     {
 *       id: "page-1",
 *       elements: [
 *         { id, type, x, y, width, height, rotate, zIndex, name?, props: {...} }
 *       ],
 *       background: { type: "color"|"gradient"|"image", value: string, ... },
 *       notes: "演讲备注"
 *     }
 *   ]
 * }
 *
 * 前端需要的格式（SlidePresentation）:
 * - 元素类型各不相同，属性直接平铺在元素对象上（不是 props 嵌套）
 * - 页面有 Slide 类型约束
 */

import type {
  SlidePresentation,
  Slide,
  SlidePreset,
  PPTElement,
  PPTElementLink,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  PPTTableElement,
  PPTChartElement,
  PPTLatexElement,
  PPTLineElement,
  PPTVideoElement,
  PPTAudioElement,
  PPTCanvasElement,
  PPTElementShadow,
  PPTElementOutline,
  SlideBackground,
  SlideTheme,
  SlideLayoutRef,
  PPTPlaceholderRef,
  TextType,
  TableCell,
  TableCellPadding,
  TableBorderSpec,
  ChartType,
  ChartData,
  ChartOptions,
  LinePointSize,
  PPTAnimation,
  AnimationType,
  AnimationTrigger,
  TurningMode,
  SlideNote,
  SectionTag,
  SlideType,
} from '../../types/slides'
import { createElementId, createPageId, createPresentationId } from '../../utils/id'
import {
  applyColorToLatexSvg,
  applyStrokeWidthToLatexSvg,
  buildLatexPlaceholderSvg,
  buildLatexSvgFromPath,
  decodeLatexMetadata,
  encodeLatexMetadata,
  getLatexVisualRegenerator,
  sanitizeSvgStrict,
  svgToDataUrl,
} from '../../utils/latex-shared'
import { getLineLocalBounds, normalizeLineGeometry } from '../../utils/line-geometry'
import type { ImportResult } from '../import-pptx'
import { ShapePathFormulas, normalizeRoundRectKeypoints } from '../../configs/shapes'
import { getAllAnimationEffects } from '../../configs/animations'
import {
  getTableColumnCount,
  normalizeTableColWidths,
  normalizeTableRowHeights,
  normalizeTableBorders,
  normalizeTableBorderSpec,
} from '../../utils/tableTheme'
import {
  COORD_DECIMALS,
  roundTo,
  getFrontendVisible,
  normalizeBackendElementLink,
  normalizeFrontendElementLink,
  toFiniteNumber,
  normalizeCoord,
  normalizeSize,
  normalizeRotate,
  normalizeOpacity,
  normalizeZIndex,
} from './normalize'

// ═══════════════════════════════════════════════
// 后端 → 前端 类型映射
// ═══════════════════════════════════════════════

/**
 * 后端 API 返回的项目详情（_serialize_project_detail 输出）
 */
export interface BackendProjectDetail {
  id: string
  organization_id?: string
  project_id?: string
  name: string
  preset?: string
  canvas_width: number
  canvas_height: number
  page_count?: number
  thumbnail?: string
  theme?: Record<string, unknown>
  created_by?: string
  updated_by?: string
  created_at?: string
  updated_at?: string
  pages: BackendSlidePage[]
}

/**
 * 后端 pptx_io.read() 返回的单页数据
 */
export interface BackendSlidePage {
  id: string
  elements: BackendSlideElement[]
  masterElements?: BackendSlideElement[]
  master_elements?: BackendSlideElement[]
  background?: {
    type: string
    value?: string
    gradient?: Record<string, unknown>
    image?: Record<string, unknown>
    theme?: Record<string, unknown>
  }
  layout?: Record<string, unknown>
  notes?: string
  /** 后端 field_mapping 可能返回 remark 而非 notes */
  remark?: string
  /** 元素动画列表（DB page_meta 合并而来，PPTX 本身不存储） */
  animations?: BackendAnimation[]
  /** 翻页动画（DB page_meta 合并而来） */
  turningMode?: string
  /** 批注数组（与 notes 演讲备注区分，独立字段存储） */
  slide_notes?: BackendSlideNote[]
  /** 章节标签 */
  section_tag?: { id: string; title: string }
  /** 页面语义类型 */
  slide_type?: string
}

/**
 * 后端动画数据（与前端 PPTAnimation 结构一致，直接透传）
 */
interface BackendAnimation {
  id: string
  elId: string
  type: string   // 'in' | 'out' | 'attention'
  effect: string
  duration: number
  trigger: string // 'click' | 'meantime' | 'auto'
  delay?: number
}

/**
 * 后端批注数据（对应前端 SlideNote）
 */
interface BackendSlideNote {
  id: string
  content: string
  elId?: string
  createdAt?: string
}

const KNOWN_ANIMATION_EFFECTS = (() => {
  const map = new Map<string, string>()
  for (const effect of getAllAnimationEffects()) {
    map.set(effect.name.toLowerCase(), effect.name)
  }
  return map
})()

const DEFAULT_EFFECT_BY_TYPE: Record<AnimationType, string> = {
  in: 'fadeIn',
  out: 'fadeOut',
  attention: 'pulse',
}

const WARNED_UNKNOWN_BACKEND_EFFECTS = new Set<string>()

function normalizeBackendAnimationEffect(rawEffect: unknown, type: AnimationType): string {
  const fallback = DEFAULT_EFFECT_BY_TYPE[type]
  if (typeof rawEffect !== 'string') return fallback

  const trimmed = rawEffect.trim()
  if (!trimmed) return fallback

  const normalized = KNOWN_ANIMATION_EFFECTS.get(trimmed.toLowerCase())
  if (normalized) return normalized

  const warnKey = `${type}:${trimmed.toLowerCase()}`
  if (!WARNED_UNKNOWN_BACKEND_EFFECTS.has(warnKey)) {
    WARNED_UNKNOWN_BACKEND_EFFECTS.add(warnKey)
    console.warn(
      `[backend-adapter] 未知动画 effect "${trimmed}" (type=${type})，已降级为 ${fallback}`,
    )
  }
  return fallback
}

/**
 * 后端 SlideElement（通用结构）
 *
 * 后端元素使用 { type, x, y, width, height, rotate, zIndex, props: {...} } 格式，
 * 其中 props 内容因 type 不同而不同。
 */
export interface BackendSlideElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotate?: number
  zIndex?: number
  name?: string
  groupId?: string
  groupName?: string
  visible?: boolean
  opacity?: number
  locked?: boolean
  shadow?: Record<string, unknown>
  flipH?: boolean
  flipV?: boolean
  link?: {
    type?: string
    target?: string
  }
  props?: Record<string, unknown>
}

// 数值 / 坐标 / 链接归一化纯函数已抽到 ./backend-adapter/normalize

function normalizeTextType(raw: unknown): TextType | undefined {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.trim().toLowerCase()
  if (
    normalized === 'title'
    || normalized === 'subtitle'
    || normalized === 'content'
    || normalized === 'item'
  ) {
    return normalized as TextType
  }
  return undefined
}

function normalizePlaceholderRef(raw: unknown): PPTPlaceholderRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const next: PPTPlaceholderRef = {}

  if (typeof rec.type === 'string' && rec.type.trim()) {
    next.type = rec.type.trim()
  }
  const idx = toFiniteNumber(rec.idx, Number.NaN)
  if (Number.isFinite(idx) && idx >= 0) {
    next.idx = Math.trunc(idx)
  }
  if (typeof rec.orient === 'string' && rec.orient.trim()) {
    next.orient = rec.orient.trim()
  }
  if (typeof rec.sz === 'string' && rec.sz.trim()) {
    next.sz = rec.sz.trim()
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function normalizeLayoutRef(raw: unknown): SlideLayoutRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const next: SlideLayoutRef = {}

  if (typeof rec.name === 'string' && rec.name.trim()) {
    next.name = rec.name.trim()
  }
  const index = toFiniteNumber(rec.index, Number.NaN)
  if (Number.isFinite(index) && index >= 0) {
    next.index = Math.trunc(index)
  }
  if (typeof rec.partName === 'string' && rec.partName.trim()) {
    next.partName = rec.partName.trim()
  }
  if (typeof rec.masterName === 'string' && rec.masterName.trim()) {
    next.masterName = rec.masterName.trim()
  }
  if (typeof rec.masterPartName === 'string' && rec.masterPartName.trim()) {
    next.masterPartName = rec.masterPartName.trim()
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function normalizeBackendBase(be: BackendSlideElement): BackendSlideElement {
  const isLine = be.type === 'line'
  const defaultWidth = isLine ? 0 : 100
  const defaultHeight = isLine ? 0 : 50
  const minSize = isLine ? 0 : 1

  return {
    ...be,
    x: normalizeCoord(be.x, 0),
    y: normalizeCoord(be.y, 0),
    width: normalizeSize(be.width, defaultWidth, minSize),
    height: normalizeSize(be.height, defaultHeight, minSize),
    rotate: normalizeRotate(be.rotate, 0),
    zIndex: normalizeZIndex(be.zIndex, 0),
    opacity: normalizeOpacity(be.opacity, 1),
  }
}

// ═══════════════════════════════════════════════
// 主转换函数
// ═══════════════════════════════════════════════

/**
 * 将后端 API 返回的完整项目数据转换为 SlidePresentation
 *
 * 这是最高层的转换函数，用于：
 * 1. PPTX 导入 API 返回后的数据转换
 * 2. 从后端加载已有项目时的数据转换
 *
 * @param data - 后端 _serialize_project_detail 输出
 * @param overrideId - 可选的覆盖 ID（新建导入时使用前端生成的 ID）
 */
export function convertBackendToPresentation(
  data: BackendProjectDetail,
  overrideId?: string,
): SlidePresentation {
  // 推断 preset
  const preset = inferPreset(data.preset, data.canvas_width, data.canvas_height)

  // 转换页面
  const pages: Slide[] = (data.pages || []).map((page) => convertBackendPage(page))

  // 转换主题（保留所有 SlideTheme 字段，包括扩展色和默认样式）
  const theme: SlideTheme = data.theme
    ? {
        backgroundColor: (data.theme.backgroundColor as string) || '#ffffff',
        themeColors: (() => {
          const validated = normalizeThemeColors(data.theme.themeColors)
          return validated.length > 0 ? validated : [...DEFAULT_ACCENT_COLORS]
        })(),
        fontColor: (data.theme.fontColor as string) || '#333333',
        fontName: (data.theme.fontName as string) || 'Microsoft YaHei',
        headingFontName: data.theme.headingFontName as string | undefined,
        bg2Color: data.theme.bg2Color as string | undefined,
        tx2Color: data.theme.tx2Color as string | undefined,
        hlinkColor: data.theme.hlinkColor as string | undefined,
        folHlinkColor: data.theme.folHlinkColor as string | undefined,
        outline: data.theme.outline as PPTElementOutline | undefined,
        shadow: data.theme.shadow as PPTElementShadow | undefined,
      }
    : {
        backgroundColor: '#ffffff',
        themeColors: [...DEFAULT_ACCENT_COLORS],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
      }

  return {
    id: overrideId || data.id || createPresentationId(),
    name: data.name || '导入的演示文稿',
    preset,
    canvasWidth: data.canvas_width || 1280,
    canvasHeight: data.canvas_height || 720,
    pages,
    theme,
    thumbnail: data.thumbnail,
    createdAt: data.created_at || new Date().toISOString(),
    updatedAt: data.updated_at || new Date().toISOString(),
  }
}

/**
 * 将后端 API 数据转换为 ImportResult（用于导入 adapter）
 */
export function convertBackendToImportResult(
  data: BackendProjectDetail,
  filename?: string,
): ImportResult {
  try {
    const presentation = convertBackendToPresentation(data)

    // 如果有 filename 覆盖名称
    if (filename) {
      presentation.name = filename.replace(/\.pptx$/i, '')
    }

    // 统计
    let totalElements = 0
    let unsupportedElements = 0
    for (const page of presentation.pages) {
      totalElements += page.elements.length
    }

    return {
      success: true,
      presentation,
      stats: {
        totalSlides: presentation.pages.length,
        totalElements,
        unsupportedElements,
        mediaFiles: 0, // 后端已处理媒体
      },
    }
  } catch (err) {
    return {
      success: false,
      error: `后端数据转换失败: ${(err as Error).message}`,
    }
  }
}

// ═══════════════════════════════════════════════
// 页面转换
// ═══════════════════════════════════════════════

/**
 * 转换单个页面
 */
function convertBackendElementsByZIndex(rawElements: BackendSlideElement[] | undefined): PPTElement[] {
  const sortedBackendElements = [...(rawElements || [])]
    .map((el, idx) => ({
      el,
      idx,
      zIndex: normalizeZIndex(el?.zIndex, Number.MAX_SAFE_INTEGER),
    }))
    .sort((a, b) => {
      if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex
      return a.idx - b.idx
    })
    .map((item) => item.el)

  const elements: PPTElement[] = []
  for (const be of sortedBackendElements) {
    const el = convertBackendElement(be)
    if (el) {
      elements.push(el)
    }
  }
  return elements
}

export function convertBackendPage(page: BackendSlidePage): Slide {
  // 先按 zIndex 排序后端元素（PPTElement 无 zIndex 字段，必须在转换前排序）
  const elements = convertBackendElementsByZIndex(page.elements)
  const rawMasterElements = page.masterElements || page.master_elements
  const masterElements = convertBackendElementsByZIndex(rawMasterElements)
  const layout = normalizeLayoutRef(page.layout)

  // 转换动画数据（从后端 page_meta 合并而来）
  const animations = convertBackendAnimations(page.animations, elements)
  const turningMode = normalizeBackendTurningMode(page.turningMode)

  const slideNotes = convertBackendSlideNotes(page.slide_notes)
  const sectionTag = convertBackendSectionTag(page.section_tag)
  const slideType = normalizeBackendSlideType(page.slide_type)

  return {
    id: page.id || createPageId(),
    elements,
    ...(masterElements.length > 0 ? { masterElements } : {}),
    background: convertBackground(page.background),
    layout,
    ...(animations.length > 0 ? { animations } : {}),
    ...(turningMode ? { turningMode } : {}),
    remark: (page.remark ?? page.notes) || undefined,
    ...(slideNotes.length > 0 ? { notes: slideNotes } : {}),
    ...(sectionTag ? { sectionTag } : {}),
    ...(slideType ? { slideType } : {}),
  }
}

/**
 * 转换后端动画数据到前端 PPTAnimation[]
 *
 * 验证每个动画引用的元素确实存在于当前页面，
 * 过滤掉已被删除的元素的残留动画引用。
 */
function convertBackendAnimations(
  raw: BackendAnimation[] | undefined,
  pageElements: PPTElement[],
): PPTAnimation[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const elementIds = new Set(pageElements.map((el) => el.id))

  const VALID_TYPES: ReadonlySet<string> = new Set(['in', 'out', 'attention'])
  const VALID_TRIGGERS: ReadonlySet<string> = new Set(['click', 'meantime', 'auto'])

  return raw
    .filter((anim) => {
      if (!anim || typeof anim !== 'object') return false
      if (typeof anim.id !== 'string' || !anim.id) return false
      if (typeof anim.elId !== 'string' || !anim.elId) return false
      // 只保留引用了当前页面中存在的元素的动画
      if (!elementIds.has(anim.elId)) return false
      if (!VALID_TYPES.has(anim.type)) return false
      if (!VALID_TRIGGERS.has(anim.trigger)) return false
      return true
    })
    .map((anim) => {
      const delay = typeof anim.delay === 'number' && anim.delay > 0 ? anim.delay : undefined
      return {
        id: anim.id,
        elId: anim.elId,
        type: anim.type as AnimationType,
        effect: normalizeBackendAnimationEffect(anim.effect, anim.type as AnimationType),
        duration: typeof anim.duration === 'number' && anim.duration > 0 ? anim.duration : 500,
        trigger: anim.trigger as AnimationTrigger,
        ...(delay ? { delay } : {}),
      }
    })
}

const VALID_TURNING_MODES: ReadonlySet<string> = new Set([
  'no', 'fade', 'slideX', 'slideY', 'slideX3D', 'slideY3D',
  'rotate', 'scaleY', 'scaleX', 'scale', 'scaleReverse', 'random', 'fadeScale',
])

function normalizeBackendTurningMode(raw: unknown): TurningMode | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw === '') return 'no'
  if (raw === 'fadeScale') return 'scale'
  return VALID_TURNING_MODES.has(raw) ? (raw as TurningMode) : undefined
}

function convertBackendSlideNotes(raw: BackendSlideNote[] | undefined): SlideNote[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  return raw
    .filter((note): note is BackendSlideNote =>
      !!note
      && typeof note === 'object'
      && typeof note.id === 'string'
      && !!note.id
      && typeof note.content === 'string',
    )
    .map((note) => ({
      id: note.id,
      content: note.content,
      ...(typeof note.elId === 'string' && note.elId ? { elId: note.elId } : {}),
      ...(typeof note.createdAt === 'string' && note.createdAt ? { createdAt: note.createdAt } : {}),
    }))
}

function convertBackendSectionTag(raw: { id: string; title: string } | undefined): SectionTag | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  if (typeof raw.id !== 'string' || !raw.id.trim()) return undefined
  if (typeof raw.title !== 'string') return undefined
  return { id: raw.id.trim(), title: raw.title }
}

const VALID_SLIDE_TYPES: ReadonlySet<string> = new Set(['cover', 'contents', 'transition', 'content', 'end'])

function normalizeBackendSlideType(raw: unknown): SlideType | undefined {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.trim().toLowerCase()
  return VALID_SLIDE_TYPES.has(normalized) ? (normalized as SlideType) : undefined
}

// ═══════════════════════════════════════════════
// 元素转换
// ═══════════════════════════════════════════════

/**
 * 转换后端 shadow 到前端 PPTElementShadow
 */
/**
 * 将 hex 颜色与 opacity 合并为 rgba 字符串。
 * 如果颜色已是 rgba 格式则直接返回。
 */
function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${opacity})`
}

function convertShadow(raw: Record<string, unknown> | undefined): PPTElementShadow | undefined {
  if (!raw) return undefined
  const h = toFiniteNumber(raw.h, 2)
  const v = toFiniteNumber(raw.v, 2)
  const blur = toFiniteNumber(raw.blur, 4)
  const color = (typeof raw.color === 'string' && raw.color.trim()) ? raw.color.trim() : '#000000'
  const opacityRaw = toFiniteNumber(raw.opacity, Number.NaN)
  const opacity = Number.isFinite(opacityRaw) ? opacityRaw : undefined
  return { h, v, blur, color, opacity }
}

function normalizeOutline(raw: unknown): PPTElementOutline | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const rawStyle = typeof o.style === 'string' ? o.style.trim() : ''
  const style = normalizeLineStyle(rawStyle)
  const width = Math.max(0, roundTo(toFiniteNumber(o.width, 1), COORD_DECIMALS))
  const color = typeof o.color === 'string' && o.color.trim()
    ? o.color.trim()
    : '#000000'
  const themeKey = normalizeBackgroundThemeKey(o.themeKey)
  const VALID_LINE_CAPS: ReadonlySet<string> = new Set(['butt', 'round', 'square'])
  const VALID_LINE_JOINS: ReadonlySet<string> = new Set(['miter', 'round', 'bevel'])
  const lineCap = typeof o.lineCap === 'string' && VALID_LINE_CAPS.has(o.lineCap)
    ? o.lineCap as PPTElementOutline['lineCap']
    : undefined
  const lineJoin = typeof o.lineJoin === 'string' && VALID_LINE_JOINS.has(o.lineJoin)
    ? o.lineJoin as PPTElementOutline['lineJoin']
    : undefined
  return {
    style,
    width,
    color,
    ...(themeKey ? { themeKey } : {}),
    ...(lineCap ? { lineCap } : {}),
    ...(lineJoin ? { lineJoin } : {}),
  }
}

/**
 * BackendSlideElement 中已知的 base-level 字段名。
 * 其余顶层字段视为 type-specific 属性（等同于 props 内容）。
 */
const BACKEND_BASE_KEYS: ReadonlySet<string> = new Set([
  'id', 'type', 'x', 'y', 'width', 'height',
  'rotate', 'zIndex', 'name', 'groupId', 'groupName',
  'visible', 'opacity', 'locked', 'shadow', 'flipH', 'flipV',
  'link', 'props',
])

/**
 * 转换单个后端元素到前端 PPTElement
 *
 * 兼容两种后端数据格式：
 *   1. 嵌套 props 格式（PPTX reader）：type-specific 属性在 `props` 内
 *   2. 扁平格式（dom_extractor / Y.js collab）：所有属性在顶层
 *
 * 策略：将顶层的非 base 字段作为 fallback 合并到 props，
 * props 内的同名字段优先（保持向后兼容）。
 */
export function convertBackendElement(be: BackendSlideElement): PPTElement | null {
  const normalizedBe = normalizeBackendBase(be)

  const flatExtras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(normalizedBe)) {
    if (!BACKEND_BASE_KEYS.has(key)) {
      flatExtras[key] = value
    }
  }
  const props = { ...flatExtras, ...(normalizedBe.props || {}) }

  const elementLink = normalizeBackendElementLink(normalizedBe.link ?? props.link)

  const withLink = <T extends PPTElement>(el: T | null): T | null => {
    if (!el) return null
    if (elementLink) {
      ;(el as T & { link?: PPTElementLink }).link = elementLink
    }
    return el
  }

  if (normalizedBe.type === 'image') {
    const fromMeta = tryConvertLatexFromImage(normalizedBe, props)
    if (fromMeta) return withLink(fromMeta)
  }

  switch (normalizedBe.type) {
    case 'text':
      return withLink(convertTextElement(normalizedBe, props))
    case 'image':
      return withLink(convertImageElement(normalizedBe, props))
    case 'latex':
      return withLink(convertLatexElement(normalizedBe, props))
    case 'shape':
      return withLink(convertShapeElement(normalizedBe, props))
    case 'table':
      return withLink(convertTableElement(normalizedBe, props))
    case 'chart':
      return withLink(convertChartElement(normalizedBe, props))
    case 'line':
      return withLink(convertLineElement(normalizedBe, props))
    case 'video':
      return withLink(convertVideoElement(normalizedBe, props))
    case 'audio':
      return withLink(convertAudioElement(normalizedBe, props))
    case 'canvas':
      return withLink(convertCanvasElement(normalizedBe, props))
    default:
      console.warn(`[backend-adapter] 不支持的元素类型: ${normalizedBe.type}`)
      return null
  }
}

// ── 文本元素 ──

function convertTextElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTTextElement {
  // 后端 content 已经是 <p> 包裹的 HTML（每个段落独立 <p>）
  // 如果不是，兜底包一层 <p>（兼容旧数据或异常情况）
  let content = (props.content as string) || '<p></p>'
  if (content && !content.startsWith('<p') && !content.startsWith('<h') && !content.startsWith('<ul') && !content.startsWith('<ol')) {
    content = `<p>${content}</p>`
  }

  const defaultFontFamily = typeof props.defaultFontFamily === 'string' && props.defaultFontFamily.trim()
    ? props.defaultFontFamily.trim()
    : undefined
  const defaultFontName = typeof props.defaultFontName === 'string' && props.defaultFontName.trim()
    ? props.defaultFontName.trim()
    : undefined
  const defaultColor = typeof props.defaultColor === 'string' && props.defaultColor.trim()
    ? props.defaultColor.trim()
    : '#000000'
  const defaultColorThemeKey = normalizeBackgroundThemeKey(props.defaultColorThemeKey)

  const defaultFontSize = toFiniteNumber(props.defaultFontSize, Number.NaN)
  const lineHeight = toFiniteNumber(props.lineHeight, Number.NaN)
  const paragraphSpace = toFiniteNumber(props.paragraphSpace, Number.NaN)
  const textType = normalizeTextType(props.textType)
  const placeholder = normalizePlaceholderRef(props.placeholder)

  const rawVerticalAlign = typeof props.verticalAlign === 'string'
    ? props.verticalAlign.trim()
    : ''
  const verticalAlign: 'top' | 'middle' | 'bottom' =
    rawVerticalAlign === 'middle' || rawVerticalAlign === 'bottom'
      ? rawVerticalAlign
      : 'top'

  const el: PPTTextElement = {
    id: be.id || createElementId(),
    type: 'text',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 200,
    height: be.height ?? 50,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    content,
    defaultFontName: defaultFontFamily || defaultFontName || 'Microsoft YaHei',
    defaultFontSize: Number.isFinite(defaultFontSize) && defaultFontSize > 0
      ? roundTo(defaultFontSize, 3)
      : undefined,
    defaultColor,
    lineHeight: Number.isFinite(lineHeight) && lineHeight > 0
      ? roundTo(lineHeight, 3)
      : undefined,
    paragraphSpace: Number.isFinite(paragraphSpace) && paragraphSpace >= 0
      ? roundTo(paragraphSpace, 3)
      : undefined,
    // 垂直对齐（PPT 默认 top）
    verticalAlign,
  }
  if (textType) el.textType = textType
  if (placeholder) el.placeholder = placeholder

  if (defaultColorThemeKey) {
    el.defaultColorThemeKey = defaultColorThemeKey
  }

  // 内边距（PPT 文本框默认有 margin）
  if (props.margin && typeof props.margin === 'object') {
    const m = props.margin as Record<string, unknown>
    el.margin = {
      top: roundTo(toFiniteNumber(m.top, 3.6), 3),
      right: roundTo(toFiniteNumber(m.right, 7.2), 3),
      bottom: roundTo(toFiniteNumber(m.bottom, 3.6), 3),
      left: roundTo(toFiniteNumber(m.left, 7.2), 3),
    }
  }

  // 默认文本对齐
  const rawDefaultTextAlign = typeof props.defaultTextAlign === 'string'
    ? props.defaultTextAlign.trim()
    : ''
  if (rawDefaultTextAlign === 'center' || rawDefaultTextAlign === 'right' || rawDefaultTextAlign === 'justify') {
    el.defaultTextAlign = rawDefaultTextAlign
  }

  // 默认字重
  if (props.defaultFontWeight === 'bold') {
    el.defaultFontWeight = 'bold'
  }

  // 背景填充
  if (props.fill) {
    el.fill = props.fill as string
  }

  // 边框
  const outline = normalizeOutline(props.outline)
  if (outline) el.outline = outline

  // 竖排文字
  if (props.vertical) {
    el.vertical = true
  }

  // 文本自动适应
  if (props.autoFit === 'shrink' || props.autoFit === 'resize') {
    el.autoFit = props.autoFit
  }

  // 字间距
  if (props.wordSpace != null) {
    const wordSpace = toFiniteNumber(props.wordSpace, Number.NaN)
    if (Number.isFinite(wordSpace)) {
      el.wordSpace = roundTo(wordSpace, 3)
    }
  }

  // flipH/flipV
  if (be.flipH) el.flipH = true
  if (be.flipV) el.flipV = true

  // 阴影
  const shadow = convertShadow(be.shadow as Record<string, unknown> | undefined)
  if (shadow) el.shadow = shadow

  return el
}

// ── 图片元素 ──

function convertImageElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTImageElement {
  const el: PPTImageElement = {
    id: be.id || createElementId(),
    type: 'image',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 200,
    height: be.height ?? 200,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    src: (props.src as string) || '',
    fixedRatio: (props.fixedRatio as boolean) ?? true,
  }
  if (be.flipH) el.flipH = true
  if (be.flipV) el.flipV = true
  const shadow = convertShadow(be.shadow as Record<string, unknown> | undefined)
  if (shadow) el.shadow = shadow
  // 边框
  const outline = normalizeOutline(props.outline)
  if (outline) el.outline = outline
  // 裁剪
  if (props.clip) el.clip = props.clip as PPTImageElement['clip']
  // 圆角
  if (props.radius) el.radius = props.radius as number
  // 滤镜
  if (props.filters) el.filters = props.filters as PPTImageElement['filters']
  // 颜色蒙版
  if (props.colorMask) el.colorMask = props.colorMask as string
  // 图片填充模式
  if (props.objectFit) el.objectFit = props.objectFit as PPTImageElement['objectFit']
  // 替代文本
  if (typeof props.altText === 'string' && props.altText.trim()) {
    el.altText = props.altText.trim()
  }
  // 图片语义类型
  if (props.imageType) el.imageType = props.imageType as PPTImageElement['imageType']
  return el
}

function regenerateLatexVisual(
  latexSource: string,
  color: string,
): { svg: string; path?: string; viewBox: [number, number] } | null {
  const source = latexSource.trim()
  if (!source) return null
  const regenerator = getLatexVisualRegenerator()
  return regenerator ? regenerator(source, color) : null
}

function normalizeLatexSvgStyle(
  svgMarkup: string,
  color: string,
  strokeWidth: number,
): string {
  let normalized = applyColorToLatexSvg(svgMarkup, color)
  normalized = applyStrokeWidthToLatexSvg(normalized, strokeWidth)
  return normalized
}

function tryConvertLatexFromImage(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTLatexElement | null {
  const rawMeta = (props.altText as string) || ''
  const meta = decodeLatexMetadata(rawMeta)
  if (!meta) return null

  const color = meta.color || '#111827'
  const strokeWidth = Number.isFinite(meta.strokeWidth) ? Math.max(0, meta.strokeWidth as number) : 0
  let svgMarkup = meta.svg ? (sanitizeSvgStrict(meta.svg) || undefined) : undefined
  let path = meta.path
  let viewBox = meta.viewBox

  if (!svgMarkup && !path) {
    const regenerated = regenerateLatexVisual(meta.latex, color)
    if (regenerated) {
      svgMarkup = regenerated.svg
      path = regenerated.path
      viewBox = regenerated.viewBox
    }
  }

  if (svgMarkup) {
    svgMarkup = normalizeLatexSvgStyle(svgMarkup, color, strokeWidth)
  } else if (!path && !(typeof props.src === 'string' && props.src)) {
    svgMarkup = buildLatexPlaceholderSvg(meta.latex, color, be.width ?? 320, be.height ?? 96)
  }

  return {
    id: be.id || createElementId(),
    type: 'latex',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 320,
    height: be.height ?? 96,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    latex: meta.latex,
    ...(svgMarkup ? { svg: svgMarkup } : {}),
    ...(path ? { path } : {}),
    ...(viewBox ? { viewBox } : {}),
    color,
    strokeWidth,
    fixedRatio: meta.fixedRatio ?? true,
    ...(typeof props.src === 'string' && props.src ? { rasterSrc: props.src as string } : {}),
    ...(be.flipH ? { flipH: true } : {}),
    ...(be.flipV ? { flipV: true } : {}),
  }
}

function convertLatexElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTLatexElement {
  const meta = decodeLatexMetadata((props.altText as string) || '')
  const fromPropsViewBox = props.viewBox as [number, number] | undefined
  const color = meta?.color || (props.color as string) || '#111827'
  const strokeWidth = Number.isFinite(meta?.strokeWidth)
    ? Math.max(0, meta?.strokeWidth as number)
    : Math.max(0, toFiniteNumber(props.strokeWidth, 0))
  const latex = (meta?.latex || (props.latex as string) || '').trim()

  let svgMarkup = meta?.svg
    || (typeof props.svg === 'string' ? (props.svg as string) : undefined)
  let path = meta?.path
    || (typeof props.path === 'string' ? (props.path as string) : undefined)
  let viewBox = meta?.viewBox || fromPropsViewBox
  const rasterSrc = typeof props.rasterSrc === 'string' && props.rasterSrc
    ? props.rasterSrc as string
    : (typeof props.src === 'string' && props.src ? props.src as string : undefined)

  if (!svgMarkup && !path) {
    const regenerated = regenerateLatexVisual(latex, color)
    if (regenerated) {
      svgMarkup = regenerated.svg
      path = regenerated.path
      viewBox = regenerated.viewBox
    }
  }

  if (svgMarkup) {
    svgMarkup = normalizeLatexSvgStyle(svgMarkup, color, strokeWidth)
  } else if (!path && !rasterSrc && latex) {
    svgMarkup = buildLatexPlaceholderSvg(latex, color, be.width ?? 320, be.height ?? 96)
  }

  return {
    id: be.id || createElementId(),
    type: 'latex',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 320,
    height: be.height ?? 96,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    latex,
    ...(svgMarkup ? { svg: svgMarkup } : {}),
    ...(path ? { path } : {}),
    ...(viewBox ? { viewBox } : {}),
    color,
    strokeWidth,
    fixedRatio: meta?.fixedRatio ?? (props.fixedRatio as boolean) ?? true,
    ...(rasterSrc ? { rasterSrc } : {}),
    ...(be.flipH ? { flipH: true } : {}),
    ...(be.flipV ? { flipV: true } : {}),
  }
}

// ── 形状元素 ──

function convertShapeElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTShapeElement {
  const viewBox = (props.viewBox as [number, number]) || [be.width || 100, be.height || 100]
  const path = (props.path as string) || generateRectPath(viewBox[0], viewBox[1])

  // 如果有 pathFormula 映射
  const pptxShapeType = (props.pptxShapeType as string) || (props.shapeType as string) || undefined
  const mapped = mapShapeTypeToFormula(pptxShapeType)
  const pathFormula = (props.pathFormula as string) || mapped.pathFormula
  const defaultKp = pathFormula && ShapePathFormulas[pathFormula]
    ? ShapePathFormulas[pathFormula].defaultValue
    : undefined
  const keypoints = Array.isArray(props.keypoints)
    ? (props.keypoints as number[])
    : (defaultKp && defaultKp.length > 0 ? [...defaultKp] : mapped.keypoints)
  const normalizedKeypoints = pathFormula === 'roundRect'
    ? [...normalizeRoundRectKeypoints(keypoints)]
    : keypoints

  // 内部文本
  const textProps = props.text as Record<string, unknown> | undefined
  const contentProps = props.content as string | undefined
  const fillThemeKey = normalizeBackgroundThemeKey(props.fillThemeKey)
  const fillThemeTransforms = (typeof props.fillThemeTransforms === 'object' && props.fillThemeTransforms !== null)
    ? props.fillThemeTransforms as Record<string, number>
    : undefined

  const shapeEl: PPTShapeElement = {
    id: be.id || createElementId(),
    type: 'shape',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 100,
    height: be.height ?? 100,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    viewBox,
    path: path || generateRectPath(viewBox[0], viewBox[1]),
    fixedRatio: (props.fixedRatio as boolean) ?? false,
    fill: (props.fill as string) === 'none' ? 'transparent' : (props.fill as string) || 'transparent',
    ...(fillThemeKey ? { fillThemeKey } : {}),
    ...(fillThemeTransforms ? { fillThemeTransforms } : {}),
    pptxShapeType,
    pathFormula,
    keypoints: normalizedKeypoints,
  }

  // 处理形状内文本
  if (textProps || contentProps) {
    const textContent = contentProps || (textProps?.content as string) || ''
    if (textContent) {
      shapeEl.text = {
        content: textContent,
        // 后端统一用 defaultFontFamily，前端 ShapeText 用 defaultFontName，做映射
        defaultFontName: (textProps?.defaultFontFamily as string)
          || (textProps?.defaultFontName as string)
          || undefined,
        defaultColor: (textProps?.defaultColor as string) || '#000000',
        defaultColorThemeKey: normalizeBackgroundThemeKey(textProps?.defaultColorThemeKey),
        defaultFontSize: (textProps?.defaultFontSize as number) || 18,
        align: (textProps?.align as 'left' | 'center' | 'right') || 'left',
        verticalAlign: (textProps?.verticalAlign as 'top' | 'middle' | 'bottom') || 'top',
      }
    }
  }

  // 渐变
  if (props.gradient) {
    shapeEl.gradient = props.gradient as PPTShapeElement['gradient']
  }

  // 图片/图案填充
  if (typeof props.pattern === 'string' && props.pattern) {
    shapeEl.pattern = props.pattern
  }

  // 轮廓
  if (props.outline) {
    const normalized = normalizeOutline(props.outline)
    if (normalized) shapeEl.outline = normalized
  }

  // flipH/flipV
  if (be.flipH) shapeEl.flipH = true
  if (be.flipV) shapeEl.flipV = true

  // 阴影
  const shadow = convertShadow(be.shadow as Record<string, unknown> | undefined)
  if (shadow) shapeEl.shadow = shadow

  return shapeEl
}

// ── 表格元素 ──

function convertTableElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTTableElement {
  const rawData = (props.data as Record<string, unknown>[][]) || []
  const colWidths = (props.colWidths as number[]) || []

  const normalizeSpan = (raw: unknown): number | undefined => {
    if (raw === undefined || raw === null) return undefined
    const parsed = toFiniteNumber(raw, Number.NaN)
    if (!Number.isFinite(parsed)) return undefined
    const intVal = Math.trunc(parsed)
    if (intVal < 0) return undefined
    return intVal
  }

  const normalizeToken = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined
    const normalized = raw.trim()
    return normalized.length > 0 ? normalized : undefined
  }

  const normalizeFontSize = (raw: unknown): number | undefined => {
    const parsed = toFiniteNumber(raw, Number.NaN)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return roundTo(parsed, 3)
  }

  const normalizeCellAlign = (
    raw: unknown,
  ): 'left' | 'center' | 'right' | 'justify' | undefined => {
    if (typeof raw !== 'string') return undefined
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'left' || normalized === 'center' || normalized === 'right' || normalized === 'justify') {
      return normalized
    }
    return undefined
  }

  const normalizeCellVerticalAlign = (
    raw: unknown,
  ): 'top' | 'middle' | 'bottom' | undefined => {
    if (typeof raw !== 'string') return undefined
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'top' || normalized === 'middle' || normalized === 'bottom') {
      return normalized
    }
    return undefined
  }

  // 后端表格数据格式: [[{ text, rowspan?, colspan?, bgColor?, bold?, ... }, ...], ...]
  // 前端需要: [[TableCell, ...], ...]
  // 注意：colspan=0 / rowspan=0 表示被合并的占位单元格，不能用 || 1 覆盖
  const data: TableCell[][] = rawData.map((row) =>
    (row || []).map((cell) => {
      const isStr = typeof cell === 'string'
      const cellObj = (!isStr ? cell as Record<string, unknown> : undefined)
      const nestedStyle = cellObj?.style as Record<string, unknown> | undefined
      const readCellVal = (key: string) => cellObj?.[key] ?? nestedStyle?.[key]

      // 使用 ?? 而非 || ，保留合法的 0 值（被合并的占位单元格）
      const rawColspan = !isStr ? normalizeSpan(readCellVal('colspan')) : undefined
      const rawRowspan = !isStr ? normalizeSpan(readCellVal('rowspan')) : undefined
      const colspan = rawColspan ?? 1
      const rowspan = rawRowspan ?? 1

      // 被合并的占位单元格无需提取样式
      if (colspan === 0 || rowspan === 0) {
        return {
          id: (typeof cellObj?.id === 'string' && cellObj.id) || createElementId(),
          text: '',
          colspan: 0,
          rowspan: 0,
        }
      }

      const rawPadding = readCellVal('padding') as Record<string, unknown> | undefined
      const normalizePadding = (raw: Record<string, unknown> | undefined): TableCellPadding | undefined => {
        if (!raw || typeof raw !== 'object') return undefined
        const pad: TableCellPadding = {}
        let hasValue = false
        for (const [key, feKey] of [['paddingTop', 'paddingTop'], ['paddingRight', 'paddingRight'], ['paddingBottom', 'paddingBottom'], ['paddingLeft', 'paddingLeft']] as const) {
          const v = toFiniteNumber(raw[key], Number.NaN)
          if (Number.isFinite(v) && v >= 0) {
            pad[feKey] = roundTo(v, 1)
            hasValue = true
          }
        }
        return hasValue ? pad : undefined
      }
      const cellStyle = !isStr ? {
        bold: normalizeBoolean(readCellVal('bold')),
        italic: normalizeBoolean(readCellVal('italic')),
        underline: (() => {
          const raw = normalizeBoolean(readCellVal('underline'))
          if (raw !== undefined) return raw
          const td = readCellVal('textDecoration')
          if (typeof td === 'string' && td.toLowerCase().includes('underline')) return true
          return undefined
        })(),
        color: normalizeToken(readCellVal('color')),
        colorThemeKey: normalizeBackgroundThemeKey(readCellVal('colorThemeKey')),
        bgColor: normalizeToken(readCellVal('bgColor')),
        bgColorThemeKey: normalizeBackgroundThemeKey(readCellVal('bgColorThemeKey')),
        fontSize: normalizeFontSize(readCellVal('fontSize')),
        fontName: normalizeToken(readCellVal('fontName')) || normalizeToken(readCellVal('fontFamily')),
        align: normalizeCellAlign(readCellVal('align')),
        verticalAlign: normalizeCellVerticalAlign(readCellVal('verticalAlign')),
        padding: normalizePadding(rawPadding),
        cellBorders: (() => {
          const raw = readCellVal('cellBorders') as Record<string, unknown> | undefined
          if (!raw || typeof raw !== 'object') return undefined
          const result: Partial<Record<'top' | 'right' | 'bottom' | 'left', TableBorderSpec>> = {}
          let hasAny = false
          for (const side of ['top', 'right', 'bottom', 'left'] as const) {
            const spec = normalizeTableBorderSpec(raw[side])
            if (spec) { result[side] = spec; hasAny = true }
          }
          return hasAny ? result : undefined
        })(),
      } : undefined
      // 只保留有值的 style
      const hasStyle = cellStyle && Object.values(cellStyle).some((v) => v !== undefined)
      const tableCell: TableCell = {
        id: (typeof cellObj?.id === 'string' && cellObj.id) || createElementId(),
        text: isStr
          ? String(cell ?? '')
          : String(readCellVal('text') ?? ''),
        colspan,
        rowspan,
        style: hasStyle ? cellStyle : undefined,
      }
      // 富文本 HTML（单元格有多段落或混合格式时后端会生成）
      if (!isStr) {
        const richTextRaw = readCellVal('richText')
        if (typeof richTextRaw === 'string' && richTextRaw.length > 0) {
          tableCell.richText = richTextRaw
        }
      }
      return tableCell
    }),
  )

  // 确保 colWidths 有值（使用各行最大列数，避免首行异常导致列宽错位）
  const cols = getTableColumnCount(data) || 1
  const finalColWidths = normalizeTableColWidths(colWidths, cols) || Array.from({ length: cols }, () => 1 / cols)

  // 从后端透传 outline，兜底灰色细线
  const beOutline = props.outline as Record<string, unknown> | undefined
  const rawOutlineStyle = beOutline?.style as string | undefined
  const outlineStyle = normalizeLineStyle(rawOutlineStyle || '')
  const outlineWidthRaw = toFiniteNumber(beOutline?.width, Number.NaN)
  const outlineWidth = Number.isFinite(outlineWidthRaw) ? Math.max(0, roundTo(outlineWidthRaw, COORD_DECIMALS)) : 1
  const outlineColor = normalizeToken(beOutline?.color) || '#d0d0d0'
  const outlineThemeKey = normalizeBackgroundThemeKey(beOutline?.themeKey)
  const outline: PPTTableElement['outline'] = beOutline
    ? {
        style: outlineStyle,
        width: outlineWidth,
        color: outlineColor,
        ...(outlineThemeKey ? { themeKey: outlineThemeKey } : {}),
      }
    : { style: 'solid', width: 1, color: '#d0d0d0' }
  const borders = normalizeTableBorders(props.borders, outline)

  // 表格主题（交替行颜色、首行高亮等）
  const beTheme = props.theme as Record<string, unknown> | undefined
  const themeColor = normalizeToken(beTheme?.color) || '#5b9bd5'
  const headerRow = normalizeBoolean(beTheme?.headerRow) === true
  const headerCol = normalizeBoolean(beTheme?.headerCol) === true
  const footerRow = normalizeBoolean(beTheme?.footerRow) === true
  const lastCol = normalizeBoolean(beTheme?.lastCol) === true
  const stripedRows = normalizeBoolean(beTheme?.stripedRows) === true
  const stripedCols = normalizeBoolean(beTheme?.stripedCols) === true
  const themeColorThemeKey = normalizeBackgroundThemeKey(beTheme?.colorThemeKey)
  const theme = beTheme ? {
    color: themeColor,
    ...(themeColorThemeKey ? { colorThemeKey: themeColorThemeKey } : {}),
    ...(headerRow ? { headerRow: true } : {}),
    ...(headerCol ? { headerCol: true } : {}),
    ...(footerRow ? { footerRow: true } : {}),
    ...(lastCol ? { lastCol: true } : {}),
    ...(stripedRows ? { stripedRows: true } : {}),
    ...(stripedCols ? { stripedCols: true } : {}),
  } as PPTTableElement['theme'] : undefined

  const rawCellMinHeight = toFiniteNumber(props.cellMinHeight, Number.NaN)
  const cellMinHeight = Number.isFinite(rawCellMinHeight) && rawCellMinHeight > 0
    ? roundTo(rawCellMinHeight, COORD_DECIMALS)
    : 36
  const hasRawRowHeights = Array.isArray(props.rowHeights) && (props.rowHeights as unknown[]).length > 0
  const normalizedRowHeights = hasRawRowHeights
    ? normalizeTableRowHeights(
        (props.rowHeights as unknown[]).map((v) => toFiniteNumber(v, Number.NaN)),
        data.length,
        { totalHeight: be.height ?? 200, minHeight: cellMinHeight },
      )
    : undefined

  return {
    id: be.id || createElementId(),
    type: 'table',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 400,
    height: be.height ?? 200,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    data,
    colWidths: finalColWidths,
    ...(normalizedRowHeights ? { rowHeights: normalizedRowHeights } : {}),
    cellMinHeight,
    outline,
    ...(borders ? { borders } : {}),
    theme,
    ...(be.flipH ? { flipH: true } : {}),
    ...(be.flipV ? { flipV: true } : {}),
  }
}

// ── 图表元素 ──

const CHART_TYPES: ReadonlySet<ChartType> = new Set<ChartType>([
  'bar',
  'column',
  'line',
  'area',
  'pie',
  'ring',
  'radar',
  'scatter',
])

const CHART_LEGEND_POSITIONS = new Set(['b', 't', 'l', 'r'])
const HEX_COLOR_REG = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function normalizeChartType(raw: unknown): ChartType {
  return typeof raw === 'string' && CHART_TYPES.has(raw as ChartType)
    ? (raw as ChartType)
    : 'bar'
}

function normalizeChartTokens(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (item === null || item === undefined) return ''
      return String(item).trim()
    })
    .filter((item) => item.length > 0)
}

function normalizeBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') {
    if (raw === 1) return true
    if (raw === 0) return false
    return undefined
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (!normalized) return undefined
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return undefined
}

function normalizeChartLegendPosition(raw: unknown): ChartOptions['legendPosition'] | undefined {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return undefined
  const aliasMap: Record<string, ChartOptions['legendPosition']> = {
    bottom: 'b',
    top: 't',
    left: 'l',
    right: 'r',
  }
  const candidate = aliasMap[normalized] || normalized
  if (!CHART_LEGEND_POSITIONS.has(candidate)) return undefined
  return candidate as ChartOptions['legendPosition']
}

function normalizeChartSeries(raw: unknown): number[][] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      row.map((cell) => {
        const value = Number(cell)
        return Number.isFinite(value) ? value : 0
      }),
    )
}

function normalizeScatterXSeries(raw: unknown): number[][] {
  if (!Array.isArray(raw)) return []
  let hasInvalid = false
  const result = raw
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      row.map((cell, idx) => {
        const value = Number(cell)
        if (Number.isFinite(value)) return value
        hasInvalid = true
        return idx + 1
      }),
    )
  if (hasInvalid) {
    console.warn('[TabSlide] 散点图 xSeries 包含无法解析的数据点，已用索引值替代。请检查数据源。')
  }
  return result
}

function normalizeChartDataByType(chartType: ChartType, rawData: Record<string, unknown>): ChartData {
  let labels = normalizeChartTokens(rawData.labels)
  let legends = normalizeChartTokens(rawData.legends)
  let series = normalizeChartSeries(rawData.series)
  let xSeries = chartType === 'scatter' ? normalizeScatterXSeries(rawData.xSeries) : []

  const isPieType = chartType === 'pie' || chartType === 'ring'
  if (isPieType) {
    const firstSeries = series[0] ? [...series[0]] : []
    const count = Math.max(firstSeries.length, labels.length)
    if (labels.length === 0 && count > 0) {
      labels = Array.from({ length: count }, (_, i) => `分类${i + 1}`)
    }
    const normalizedSeries = Array.from({ length: labels.length }, (_, i) => firstSeries[i] ?? 0)
    series = [normalizedSeries]
    legends = legends.length > 0 ? [legends[0]] : ['占比']
    return { labels, legends, series }
  }

  const maxSeriesLen = series.reduce((max, row) => Math.max(max, row.length), 0)
  const targetLen = Math.max(labels.length, maxSeriesLen)
  if (labels.length === 0 && targetLen > 0) {
    labels = Array.from({ length: targetLen }, (_, i) => String(i + 1))
  }

  const normalizedLen = labels.length
  series = series.map((row) => Array.from({ length: normalizedLen }, (_, i) => row[i] ?? 0))
  if (series.length === 0 && normalizedLen > 0) {
    series = [Array.from({ length: normalizedLen }, () => 0)]
  }

  if (legends.length < series.length) {
    legends = [
      ...legends,
      ...Array.from({ length: series.length - legends.length }, (_, i) => `系列${legends.length + i + 1}`),
    ]
  } else if (legends.length > series.length) {
    legends = legends.slice(0, series.length)
  }

  if (chartType === 'scatter') {
    const baseX = Array.from({ length: normalizedLen }, (_, i) => {
      if (i < labels.length) {
        const parsed = Number(labels[i])
        if (Number.isFinite(parsed)) return parsed
      }
      return i + 1
    })

    xSeries = Array.from({ length: series.length }, (_, rowIdx) => {
      const row = xSeries[rowIdx] || []
      return Array.from({ length: normalizedLen }, (_, i) => {
        const value = row[i]
        return Number.isFinite(value) ? value : baseX[i]
      })
    })

    labels = (xSeries[0] || baseX).map((value) => String(value))
    return {
      labels,
      legends,
      series,
      ...(xSeries.length ? { xSeries } : {}),
    }
  }

  return { labels, legends, series }
}

function normalizeChartOptionsByType(
  chartType: ChartType,
  rawOptions: Record<string, unknown> | undefined,
): ChartOptions | undefined {
  if (!rawOptions) return undefined

  const normalized: ChartOptions = {}
  const showLegend = normalizeBoolean(rawOptions.showLegend)
  if (showLegend !== undefined) normalized.showLegend = showLegend
  const showDataLabel = normalizeBoolean(rawOptions.showDataLabel)
  if (showDataLabel !== undefined) normalized.showDataLabel = showDataLabel

  const legendPosition = normalizeChartLegendPosition(rawOptions.legendPosition)
  if (legendPosition) normalized.legendPosition = legendPosition

  const canStack = chartType === 'bar' || chartType === 'column' || chartType === 'line' || chartType === 'area'
  const stack = normalizeBoolean(rawOptions.stack)
  if (canStack && stack !== undefined) {
    normalized.stack = stack
  }

  const canSmooth = chartType === 'line' || chartType === 'area' || chartType === 'scatter'
  const lineSmooth = normalizeBoolean(rawOptions.lineSmooth)
  if (canSmooth && lineSmooth !== undefined) {
    normalized.lineSmooth = lineSmooth
  }

  if (chartType === 'radar') {
    const radarFilled = normalizeBoolean(rawOptions.radarFilled)
    if (radarFilled !== undefined) normalized.radarFilled = radarFilled
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeThemeColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((color): color is string => typeof color === 'string')
    .map((color) => color.trim())
    .filter((color) => HEX_COLOR_REG.test(color))
    .map((color) => (color.startsWith('#') ? color : `#${color}`))
    .map((color) => {
      const hex = color.slice(1)
      if (hex.length === 3) {
        return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
      }
      if (hex.length === 8) {
        return `#${hex.slice(0, 6)}`
      }
      return `#${hex}`
    })
}

function normalizeThemeColorKeys(
  raw: unknown,
  expectedLength = 0,
): Array<string | null> {
  const source = Array.isArray(raw) ? raw : []
  const normalized = source.map((item) => normalizeBackgroundThemeKey(item) ?? null)
  const targetLength = Math.max(expectedLength, normalized.length)
  const output: Array<string | null> = []
  for (let i = 0; i < targetLength; i += 1) {
    output.push(i < normalized.length ? normalized[i] : null)
  }
  return output
}

function convertChartElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTChartElement {
  const rawData = (props.data as Record<string, unknown>) || {}
  const chartType = normalizeChartType(props.chartType)
  const chartData = normalizeChartDataByType(chartType, rawData)
  const themeColors = normalizeThemeColors(props.themeColors)
  const themeColorKeys = normalizeThemeColorKeys(props.themeColorKeys, themeColors.length)

  const rawOptions = props.options as Record<string, unknown> | undefined
  const options = normalizeChartOptionsByType(chartType, rawOptions)

  const rawTitle = typeof props.title === 'string'
    ? props.title
    : typeof props.chartTitle === 'string'
      ? props.chartTitle
      : undefined
  const chartTitle = typeof rawTitle === 'string' ? rawTitle.trim() : ''

  return {
    id: be.id || createElementId(),
    type: 'chart',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 400,
    height: be.height ?? 300,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    chartType,
    data: chartData,
    themeColors,
    ...(themeColorKeys.length ? { themeColorKeys } : {}),
    ...(options ? { options } : {}),
    ...(chartTitle ? { chartTitle } : {}),
    ...(props.fill ? { fill: props.fill as string } : {}),
    ...(props.textColor ? { textColor: props.textColor as string } : {}),
    ...(props.gridColor ? { gridColor: props.gridColor as string } : {}),
    ...(props.outline ? { outline: props.outline as PPTChartElement['outline'] } : {}),
    ...(be.flipH ? { flipH: true } : {}),
    ...(be.flipV ? { flipV: true } : {}),
  }
}

// ── 媒体元素 ──

function convertVideoElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTVideoElement {
  const autoplay = normalizeBoolean(props.autoplay) ?? false
  const loop = normalizeBoolean(props.loop) ?? false
  const shadow = convertShadow(be.shadow as Record<string, unknown> | undefined)
  const ext = typeof props.ext === 'string' && props.ext.trim()
    ? props.ext.trim().replace(/^\./, '').toLowerCase()
    : undefined

  return {
    id: be.id || createElementId(),
    type: 'video',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 320,
    height: be.height ?? 180,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    src: (props.src as string) || '',
    autoplay,
    ...(loop ? { loop } : {}),
    ...(typeof props.poster === 'string' && props.poster ? { poster: props.poster } : {}),
    ...(ext ? { ext } : {}),
    ...(be.flipH ? { flipH: true } : {}),
    ...(be.flipV ? { flipV: true } : {}),
    ...(shadow ? { shadow } : {}),
  }
}

function convertAudioElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTAudioElement {
  const loop = normalizeBoolean(props.loop) ?? false
  const autoplay = normalizeBoolean(props.autoplay) ?? false
  const fixedRatio = normalizeBoolean(props.fixedRatio) ?? true
  const shadow = convertShadow(be.shadow as Record<string, unknown> | undefined)
  const color = typeof props.color === 'string' && props.color.trim()
    ? props.color.trim()
    : '#666666'
  const ext = typeof props.ext === 'string' && props.ext.trim()
    ? props.ext.trim().replace(/^\./, '').toLowerCase()
    : undefined

  return {
    id: be.id || createElementId(),
    type: 'audio',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 140,
    height: be.height ?? 48,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    src: (props.src as string) || '',
    color,
    fixedRatio,
    loop,
    autoplay,
    ...(ext ? { ext } : {}),
    ...(be.flipH ? { flipH: true } : {}),
    ...(be.flipV ? { flipV: true } : {}),
    ...(shadow ? { shadow } : {}),
  }
}

// ── 画布元素 ──

function convertCanvasElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTCanvasElement {
  return {
    id: be.id || createElementId(),
    type: 'canvas',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 400,
    height: be.height ?? 300,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    canvasId: (props.canvasId as string) || '',
    ...(typeof props.canvasTitle === 'string' && props.canvasTitle ? { canvasTitle: props.canvasTitle } : {}),
    ...(typeof props.thumbnail === 'string' && props.thumbnail ? { thumbnail: props.thumbnail } : {}),
    ...(be.flipH ? { flipH: true } : {}),
    ...(be.flipV ? { flipV: true } : {}),
  }
}

// ── 线条元素 ──

function convertLineElement(
  be: BackendSlideElement,
  props: Record<string, unknown>,
): PPTLineElement {
  const start = normalizeLineCoordPair(props.start, [0, 0])
  const end = normalizeLineCoordPair(props.end, [Math.max(be.width || 200, 1), 0])
  const rawPoints = Array.isArray(props.points) ? props.points : ['', '']
  const style = normalizeLineStyle(props.style)
  const lineWidth = Math.max(0.1, roundTo(toFiniteNumber(props.lineWidth, 2), 2))
  const lineColorThemeKey = normalizeBackgroundThemeKey(props.colorThemeKey)
  const el: PPTLineElement = {
    id: be.id || createElementId(),
    type: 'line',
    x: be.x ?? 0,
    y: be.y ?? 0,
    width: be.width ?? 200,
    height: be.height ?? 0,
    rotate: be.rotate ?? 0,
    opacity: be.opacity ?? 1,
    visible: getFrontendVisible(be.visible),
    locked: be.locked ?? false,
    name: be.name,
    groupId: be.groupId,
    groupName: be.groupName,
    start,
    end,
    style,
    color: (props.color as string) || '#333333',
    ...(lineColorThemeKey ? { colorThemeKey: lineColorThemeKey } : {}),
    lineWidth,
    points: [
      normalizeLinePoint(rawPoints[0]),
      normalizeLinePoint(rawPoints[1]),
    ],
  }
  if (be.flipH) el.flipH = true
  if (be.flipV) el.flipV = true
  // 阴影
  const shadow = convertShadow(be.shadow as Record<string, unknown> | undefined)
  if (shadow) el.shadow = shadow
  // 曲线/折线控制点
  const broken = normalizeOptionalLineCoordPair(props.broken)
  if (broken) el.broken = broken
  const broken2 = normalizeOptionalLineCoordPair(props.broken2)
  if (broken2) el.broken2 = broken2
  const curve = normalizeOptionalLineCoordPair(props.curve)
  if (curve) el.curve = curve
  const cubic = normalizeCubicControlPoints(props.cubic)
  if (cubic) el.cubic = cubic
  // 箭头尺寸（sm/med/lg）
  const rawPointSizes = Array.isArray(props.pointSizes) ? props.pointSizes : undefined
  if (rawPointSizes && rawPointSizes.length >= 2) {
    const validSizes = ['sm', 'med', 'lg'] as const
    const isValid = (v: unknown): v is typeof validSizes[number] =>
      typeof v === 'string' && (validSizes as readonly string[]).includes(v)
    const normalizePS = (raw: unknown): LinePointSize => {
      if (!raw || typeof raw !== 'object') return {}
      const s = raw as Record<string, unknown>
      const out: LinePointSize = {}
      if (isValid(s.w)) out.w = s.w
      if (isValid(s.len)) out.len = s.len
      return out
    }
    const ps0 = normalizePS(rawPointSizes[0])
    const ps1 = normalizePS(rawPointSizes[1])
    if (ps0.w || ps0.len || ps1.w || ps1.len) {
      el.pointSizes = [ps0, ps1]
    }
  }
  return normalizeLineGeometry(
    el,
    { minWidth: 1, minHeight: 1, decimals: COORD_DECIMALS },
  )
}

function normalizeLinePoint(v: unknown): PPTLineElement['points'][number] {
  if (typeof v !== 'string') return ''
  switch (v) {
    case '':
    case 'none':
      return ''
    case 'dot':
    case 'oval':
      return 'dot'
    case 'arrow':
    case 'triangle':
    case 'stealth':
    case 'diamond':
      return v as PPTLineElement['points'][number]
    default:
      return ''
  }
}

function normalizeLineStyle(v: unknown): PPTLineElement['style'] {
  if (v === 'dashed' || v === 'dotted' || v === 'dashDot' || v === 'longDash' || v === 'longDashDot') return v
  return 'solid'
}

function normalizeLineCoordPair(raw: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(raw) || raw.length < 2) {
    return fallback
  }
  return [
    roundTo(toFiniteNumber(raw[0], fallback[0]), COORD_DECIMALS),
    roundTo(toFiniteNumber(raw[1], fallback[1]), COORD_DECIMALS),
  ]
}

function normalizeOptionalLineCoordPair(raw: unknown): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 2) {
    return undefined
  }
  return normalizeLineCoordPair(raw, [0, 0])
}

function normalizeCubicControlPoints(raw: unknown): [[number, number], [number, number]] | undefined {
  if (!Array.isArray(raw) || raw.length < 2) {
    return undefined
  }
  const cp1 = normalizeOptionalLineCoordPair(raw[0])
  const cp2 = normalizeOptionalLineCoordPair(raw[1])
  if (!cp1 || !cp2) {
    return undefined
  }
  return [cp1, cp2]
}

export const DEFAULT_ACCENT_COLORS = ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'] as const
const DEFAULT_THEME_BG2 = '#E7E6E6'
const DEFAULT_THEME_TX2 = '#44546A'
const DEFAULT_THEME_HLINK = '#0563C1'
const DEFAULT_THEME_FOLHLINK = '#954F72'

function normalizeBackgroundThemeKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().toLowerCase()
  if (!key) return undefined

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

    hlink: 'hlink',
    hyperlink: 'hlink',
    folhlink: 'folhlink',
    followed_hyperlink: 'folhlink',
  }

  return map[key]
}

function resolveThemeBackgroundColorByKey(key?: string): string | undefined {
  if (!key) return undefined
  if (key === 'bg1') return '#FFFFFF'
  if (key === 'tx1') return '#000000'
  if (key === 'bg2') return DEFAULT_THEME_BG2
  if (key === 'tx2') return DEFAULT_THEME_TX2
  if (key === 'hlink') return DEFAULT_THEME_HLINK
  if (key === 'folhlink') return DEFAULT_THEME_FOLHLINK
  if (key.startsWith('accent')) {
    const idx = Number.parseInt(key.slice(6), 10)
    if (Number.isFinite(idx) && idx >= 1 && idx <= 6) {
      return DEFAULT_ACCENT_COLORS[idx - 1]
    }
  }
  return undefined
}

function normalizeBackgroundTheme(
  raw: unknown,
  fallbackColor?: string,
): { key: string; color?: string; transforms?: Record<string, number> } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const theme = raw as Record<string, unknown>
  const keyRaw = theme.key ?? theme.themeKey ?? theme.token
  const normalizedKey = normalizeBackgroundThemeKey(keyRaw)
  if (!normalizedKey && (typeof keyRaw !== 'string' || !keyRaw.trim())) return undefined
  const colorRaw = theme.color ?? theme.resolvedColor ?? theme.value ?? fallbackColor
  const normalizedColor = typeof colorRaw === 'string'
    ? colorRaw
    : resolveThemeBackgroundColorByKey(normalizedKey)
  const result: { key: string; color?: string; transforms?: Record<string, number> } = {
    key: normalizedKey || String(keyRaw).trim(),
    color: normalizedColor,
  }
  // 透传 lumMod/lumOff/tint/shade/satMod 变换参数
  if (theme.transforms && typeof theme.transforms === 'object') {
    result.transforms = theme.transforms as Record<string, number>
  }
  return result
}

function normalizeColorToHex6(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  if (!value) return undefined

  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    }
    return `#${hex.slice(0, 6)}`
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/)
  if (!rgbMatch) return undefined
  const parts = rgbMatch[1].split(',').map((p) => p.trim())
  if (parts.length < 3) return undefined

  const channel = (rawPart: string): number | undefined => {
    if (rawPart.endsWith('%')) {
      const pct = Number(rawPart.slice(0, -1))
      if (!Number.isFinite(pct)) return undefined
      return Math.max(0, Math.min(255, Math.round((pct / 100) * 255)))
    }
    const val = Number(rawPart)
    if (!Number.isFinite(val)) return undefined
    return Math.max(0, Math.min(255, Math.round(val)))
  }

  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  if (r === undefined || g === undefined || b === undefined) return undefined
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function resolveThemeColorByKeyFromTheme(
  key: string | undefined,
  theme?: SlideTheme,
): string | undefined {
  const normalizedKey = normalizeBackgroundThemeKey(key)
  if (!normalizedKey) return undefined
  if (normalizedKey.startsWith('accent')) {
    const idx = Number.parseInt(normalizedKey.slice(6), 10)
    if (Number.isFinite(idx) && idx >= 1 && idx <= 6) {
      const themeColor = theme?.themeColors?.[idx - 1]
      return normalizeColorToHex6(themeColor)
    }
  }
  if (normalizedKey === 'bg1') {
    return normalizeColorToHex6(theme?.backgroundColor)
  }
  if (normalizedKey === 'tx1') {
    return normalizeColorToHex6(theme?.fontColor)
  }
  if (normalizedKey === 'bg2') {
    return normalizeColorToHex6(theme?.bg2Color)
  }
  if (normalizedKey === 'tx2') {
    return normalizeColorToHex6(theme?.tx2Color)
  }
  if (normalizedKey === 'hlink') {
    return normalizeColorToHex6(theme?.hlinkColor)
  }
  if (normalizedKey === 'folhlink') {
    return normalizeColorToHex6(theme?.folHlinkColor)
  }
  return undefined
}

function keepThemeKeyIfColorMatches(
  key: unknown,
  color: unknown,
  theme?: SlideTheme,
): string | undefined {
  const normalizedKey = normalizeBackgroundThemeKey(key)
  if (!normalizedKey) return undefined
  if (!theme) return normalizedKey
  if (!color || typeof color !== 'string') return normalizedKey
  const colorHex = normalizeColorToHex6(color)
  const expectedHex = resolveThemeColorByKeyFromTheme(normalizedKey, theme)
  if (!colorHex || !expectedHex) return normalizedKey
  return colorHex === expectedHex ? normalizedKey : undefined
}

function normalizeBackgroundGradient(
  raw?: Record<string, unknown>,
): SlideBackground['gradient'] | undefined {
  if (!raw) return undefined
  const colorsRaw = Array.isArray(raw.colors) ? raw.colors as Array<{ pos?: number; color?: string }> : []
  const colors = colorsRaw
    .map((s, idx) => ({
      pos: typeof s.pos === 'number'
        ? Math.max(0, Math.min(1, s.pos))
        : (colorsRaw.length <= 1 ? 0 : idx / (colorsRaw.length - 1)),
      color: typeof s.color === 'string' && s.color ? s.color : '#000000',
    }))
    .sort((a, b) => a.pos - b.pos)

  if (colors.length === 0) {
    return {
      type: 'linear',
      rotate: 0,
      colors: [
        { pos: 0, color: '#ffffff' },
        { pos: 1, color: '#000000' },
      ],
    }
  }

  if (colors.length === 1) {
    colors.push({ ...colors[0], pos: 1 })
  }

  const result: NonNullable<SlideBackground['gradient']> = {
    type: raw.type === 'radial' ? 'radial' : 'linear',
    rotate: typeof raw.rotate === 'number' ? raw.rotate : 0,
    colors,
  }

  // 透传径向渐变中心点
  if (result.type === 'radial' && raw.center && typeof raw.center === 'object') {
    const c = raw.center as Record<string, unknown>
    if (typeof c.x === 'number' && typeof c.y === 'number') {
      result.center = { x: c.x, y: c.y }
    }
  }

  return result
}

function normalizeBackgroundImageSize(raw: unknown): 'cover' | 'contain' | 'repeat' {
  return raw === 'contain' || raw === 'repeat' ? raw : 'cover'
}

// ═══════════════════════════════════════════════
// 背景转换
// ═══════════════════════════════════════════════

function convertBackground(
  bg?: BackendSlidePage['background'],
): SlideBackground | undefined {
  if (!bg) return undefined
  const isInherited = !!(bg as Record<string, unknown>).inherited
  const themeBg = normalizeBackgroundTheme(bg.theme, bg.value)
  const normalizedThemeKey = normalizeBackgroundThemeKey(themeBg?.key)
  const validThemeBg = themeBg && normalizedThemeKey
    ? { ...themeBg, key: normalizedThemeKey }
    : undefined
  const themeResolvedColor = themeBg?.color
    || (typeof bg.value === 'string' ? bg.value : undefined)
    || resolveThemeBackgroundColorByKey(validThemeBg?.key)
    || '#ffffff'

  let result: SlideBackground
  switch (bg.type) {
    case 'color':
    case 'solid':
      if (validThemeBg) {
        result = {
          type: 'theme',
          color: themeResolvedColor,
          theme: { ...validThemeBg, color: validThemeBg.color || themeResolvedColor },
        }
      } else {
        result = { type: 'solid', color: (typeof bg.value === 'string' && bg.value) || themeResolvedColor }
      }
      break
    case 'theme':
      if (!validThemeBg) {
        result = { type: 'solid', color: themeResolvedColor }
      } else {
        result = {
          type: 'theme',
          color: themeResolvedColor,
          theme: { ...validThemeBg, color: validThemeBg.color || themeResolvedColor },
        }
      }
      break
    case 'gradient':
      if (bg.gradient) {
        const gradient = normalizeBackgroundGradient(bg.gradient)
        result = {
          type: 'gradient',
          gradient: gradient || {
            type: 'linear',
            rotate: 0,
            colors: [
              { pos: 0, color: '#ffffff' },
              { pos: 1, color: '#000000' },
            ],
          },
        }
      } else {
        result = { type: 'solid', color: '#ffffff' }
      }
      break
    case 'image':
      if (bg.image) {
        result = {
          type: 'image',
          image: {
            src: (bg.image.src as string) || '',
            size: normalizeBackgroundImageSize(bg.image.size),
          },
        }
      } else {
        result = { type: 'solid', color: '#ffffff' }
      }
      break
    default:
      if (validThemeBg) {
        result = {
          type: 'theme',
          color: themeResolvedColor,
          theme: { ...validThemeBg, color: validThemeBg.color || themeResolvedColor },
        }
      } else {
        result = { type: 'solid', color: (typeof bg.value === 'string' && bg.value) || themeResolvedColor }
      }
      break
  }

  if (isInherited) result.inherited = true
  return result
}

// ═══════════════════════════════════════════════
// 前端 → 后端 转换（保存/同步用）
// ═══════════════════════════════════════════════

/**
 * 将前端 SlidePresentation.pages 转换为后端 save-pages 所需的格式
 *
 * 核心区别：
 * - 前端元素属性是扁平的（直接在对象上）
 * - 后端元素属性包在 `props` 内（base 属性 + props 分离）
 * - 背景 type 命名不同：前端 "solid" ↔ 后端 "color"
 * - 备注字段：前端 "remark" ↔ 后端 "notes"
 */
export function convertPagesToBackend(pages: Slide[], theme?: SlideTheme): BackendSlidePage[] {
  return pages.map((page, idx) => {
    const backendPage: BackendSlidePage = {
      id: page.id,
      elements: page.elements.map((el, zIdx) => convertElementToBackend(el, zIdx, theme)),
      background: convertBackgroundToBackend(page.background),
      ...(page.layout ? { layout: page.layout as unknown as Record<string, unknown> } : {}),
      notes: page.remark || '',
    }

    // 母版元素透传：虽然 pptx_io.write 使用模板保留 slide master，
    // 但显式传递 masterElements 作为防御性冗余，避免模板损坏时丢失。
    if (page.masterElements && page.masterElements.length > 0) {
      backendPage.masterElements = page.masterElements.map(
        (el, zIdx) => convertElementToBackend(el, zIdx, theme),
      )
    }

    // 动画数据：始终显式输出，确保增量保存时空数组能清除 DB 旧值（DF-04）
    backendPage.animations =
      page.animations && page.animations.length > 0
        ? page.animations.map((anim) => ({
            id: anim.id,
            elId: anim.elId,
            type: anim.type,
            effect: anim.effect,
            duration: anim.duration,
            trigger: anim.trigger,
            ...(anim.delay ? { delay: anim.delay } : {}),
          }))
        : []

    // 翻页动画：始终显式输出，'no' 和空值均映射为 ''，确保增量保存能清除旧值（DF-03）
    backendPage.turningMode =
      page.turningMode && page.turningMode !== 'no' ? page.turningMode : ''

    // 批注数组（slide_notes 独立于演讲备注 notes）
    if (page.notes && page.notes.length > 0) {
      backendPage.slide_notes = page.notes.map((note) => ({
        id: note.id,
        content: note.content,
        ...(note.elId ? { elId: note.elId } : {}),
        ...(note.createdAt ? { createdAt: note.createdAt } : {}),
      }))
    }

    // 章节标签与页面语义类型
    if (page.sectionTag) {
      backendPage.section_tag = { id: page.sectionTag.id, title: page.sectionTag.title }
    }
    if (page.slideType) {
      backendPage.slide_type = page.slideType
    }

    return backendPage
  })
}

/**
 * 将单个前端元素转换为后端格式（base + props 分离）
 */
function convertElementToBackend(
  el: PPTElement,
  zIndex: number,
  theme?: SlideTheme,
): BackendSlideElement {
  const isLine = el.type === 'line'
  const x = normalizeCoord(el.x, 0)
  const y = normalizeCoord(el.y, 0)
  const width = normalizeSize(el.width, isLine ? 0 : 100, isLine ? 0 : 1)
  const height = isLine
    ? 0
    : normalizeSize((el as { height: number }).height, 50, 1)
  const rotate = normalizeRotate(('rotate' in el ? (el as { rotate?: number }).rotate : 0) ?? 0, 0)
  const opacity = normalizeOpacity(el.opacity, 1)
  const normalizedZIndex = Number.isFinite(zIndex) ? Math.max(0, Math.trunc(zIndex)) : 0

  const base: BackendSlideElement = {
    id: el.id,
    type: el.type,
    x,
    y,
    width,
    height,
    rotate,
    zIndex: normalizedZIndex,
    name: el.name,
    groupId: el.groupId,
    groupName: el.groupName,
    visible: el.visible === false ? false : undefined,
    opacity,
    locked: el.locked || undefined,
    props: {},
  }

  const normalizedLink = normalizeFrontendElementLink((el as { link?: PPTElementLink }).link)
  if (normalizedLink) {
    base.link = normalizedLink
  }

  // 通用属性：shadow, flipH, flipV
  if ('shadow' in el && (el as unknown as { shadow?: PPTElementShadow }).shadow) {
    base.shadow = (el as unknown as { shadow: PPTElementShadow }).shadow as unknown as Record<string, unknown>
  }
  if ('flipH' in el && (el as { flipH?: boolean }).flipH) {
    base.flipH = true
  }
  if ('flipV' in el && (el as { flipV?: boolean }).flipV) {
    base.flipV = true
  }

  switch (el.type) {
    case 'text': {
      const t = el as PPTTextElement
      base.props = {
        content: t.content,
        defaultFontFamily: t.defaultFontName,
        ...(t.defaultFontSize != null ? { defaultFontSize: t.defaultFontSize } : {}),
        defaultColor: t.defaultColor,
        ...(t.defaultColorThemeKey ? { defaultColorThemeKey: t.defaultColorThemeKey } : {}),
        ...(t.lineHeight != null ? { lineHeight: t.lineHeight } : {}),
        ...(t.paragraphSpace != null ? { paragraphSpace: t.paragraphSpace } : {}),
        ...(t.fill ? { fill: t.fill } : {}),
        ...(t.outline ? { outline: t.outline } : {}),
        ...(t.defaultTextAlign ? { defaultTextAlign: t.defaultTextAlign } : {}),
        ...(t.defaultFontWeight ? { defaultFontWeight: t.defaultFontWeight } : {}),
        ...(t.verticalAlign ? { verticalAlign: t.verticalAlign } : {}),
        ...(t.margin ? { margin: t.margin } : {}),
        ...(t.wordSpace != null ? { wordSpace: t.wordSpace } : {}),
        ...(t.vertical ? { vertical: t.vertical } : {}),
        ...(t.autoFit ? { autoFit: t.autoFit } : {}),
        ...(t.textType ? { textType: t.textType } : {}),
        ...(t.placeholder ? { placeholder: t.placeholder } : {}),
      }
      break
    }
    case 'image': {
      const img = el as PPTImageElement
      base.props = {
        src: img.src,
        ...(img.fixedRatio != null ? { fixedRatio: img.fixedRatio } : {}),
        ...(img.outline ? { outline: img.outline } : {}),
        ...(img.radius ? { radius: img.radius } : {}),
        ...(img.clip ? { clip: img.clip } : {}),
        ...(img.filters ? { filters: img.filters } : {}),
        ...(img.colorMask ? { colorMask: img.colorMask } : {}),
        ...(img.objectFit ? { objectFit: img.objectFit } : {}),
        ...(img.altText ? { altText: img.altText } : {}),
        ...(img.imageType ? { imageType: img.imageType } : {}),
      }
      break
    }
    case 'video': {
      const video = el as PPTVideoElement
      base.props = {
        src: video.src,
        autoplay: !!video.autoplay,
        ...(video.loop ? { loop: true } : {}),
        ...(video.poster ? { poster: video.poster } : {}),
        ...(video.ext ? { ext: video.ext } : {}),
      }
      break
    }
    case 'audio': {
      const audio = el as PPTAudioElement
      base.props = {
        src: audio.src,
        color: audio.color || '#666666',
        fixedRatio: audio.fixedRatio ?? true,
        loop: !!audio.loop,
        autoplay: !!audio.autoplay,
        ...(audio.ext ? { ext: audio.ext } : {}),
      }
      break
    }
    case 'shape': {
      const s = el as PPTShapeElement
      const inferredPptxShapeType = s.pptxShapeType || mapFormulaToShapeType(s.pathFormula)
      const shapeFillThemeKey = keepThemeKeyIfColorMatches(s.fillThemeKey, s.fill, theme)
      const shapeOutlineThemeKey = s.outline
        ? keepThemeKeyIfColorMatches(s.outline.themeKey, s.outline.color, theme)
        : undefined
      const normalizedOutline = s.outline ? { ...s.outline } : undefined
      if (normalizedOutline) {
        if (shapeOutlineThemeKey) normalizedOutline.themeKey = shapeOutlineThemeKey
        else delete normalizedOutline.themeKey
      }
      base.props = {
        viewBox: s.viewBox,
        path: s.path,
        fill: s.fill,
        ...(shapeFillThemeKey ? { fillThemeKey: shapeFillThemeKey } : {}),
        ...(s.fillThemeTransforms ? { fillThemeTransforms: s.fillThemeTransforms } : {}),
        ...(s.fixedRatio != null ? { fixedRatio: s.fixedRatio } : {}),
        ...(inferredPptxShapeType ? { pptxShapeType: inferredPptxShapeType } : {}),
        ...(s.pathFormula ? { pathFormula: s.pathFormula } : {}),
        ...(s.keypoints ? { keypoints: s.keypoints } : {}),
        ...(s.text ? { text: s.text } : {}),
        ...(s.gradient ? { gradient: s.gradient } : {}),
        ...(s.pattern ? { pattern: s.pattern } : {}),
        ...(normalizedOutline ? { outline: normalizedOutline } : {}),
      }
      break
    }
    case 'table': {
      const tbl = el as PPTTableElement
      const totalCols = getTableColumnCount(tbl.data)
      const normalizedColWidths = normalizeTableColWidths(tbl.colWidths, totalCols) || tbl.colWidths
      const rawCellMinHeight = toFiniteNumber(tbl.cellMinHeight, Number.NaN)
      const normalizedCellMinHeight = Number.isFinite(rawCellMinHeight) && rawCellMinHeight > 0
        ? roundTo(rawCellMinHeight, COORD_DECIMALS)
        : 36
      const normalizedRowHeights = tbl.rowHeights?.length
        ? normalizeTableRowHeights(tbl.rowHeights, tbl.data.length, {
            totalHeight: tbl.height,
            minHeight: normalizedCellMinHeight,
          })
        : undefined
      const tableOutlineThemeKey = keepThemeKeyIfColorMatches(tbl.outline?.themeKey, tbl.outline?.color, theme)
      const normalizedOutline = tbl.outline
        ? {
            ...tbl.outline,
            width: Math.max(0, roundTo(toFiniteNumber(tbl.outline.width, 1), COORD_DECIMALS)),
            color: typeof tbl.outline.color === 'string' && tbl.outline.color.trim()
              ? tbl.outline.color.trim()
              : '#d0d0d0',
          }
        : undefined
      if (normalizedOutline) {
        if (tableOutlineThemeKey) normalizedOutline.themeKey = tableOutlineThemeKey
        else delete normalizedOutline.themeKey
      }
      const tableThemeColorThemeKey = keepThemeKeyIfColorMatches(tbl.theme?.colorThemeKey, tbl.theme?.color, theme)
      const normalizedTableTheme = tbl.theme ? { ...tbl.theme } : undefined
      if (normalizedTableTheme) {
        if (tableThemeColorThemeKey) normalizedTableTheme.colorThemeKey = tableThemeColorThemeKey
        else delete normalizedTableTheme.colorThemeKey
      }
      const normalizedBorders = normalizeTableBorders(tbl.borders, normalizedOutline || tbl.outline)
      // 将前端 TableCell（含 style 嵌套对象）展平为后端格式
      const backendData = tbl.data.map(row =>
        row.map(cell => {
          const flat: Record<string, unknown> = {
            id: cell.id,
            text: cell.text,
            colspan: cell.colspan,
            rowspan: cell.rowspan,
          }
          if (cell.richText) flat.richText = cell.richText
          // 展平 style 到顶层（后端兼容两种格式，但展平更明确）
          if (cell.style) {
            const s = cell.style
            const colorThemeKey = keepThemeKeyIfColorMatches(s.colorThemeKey, s.color, theme)
            const bgColorThemeKey = keepThemeKeyIfColorMatches(s.bgColorThemeKey, s.bgColor, theme)
            const normalizedStyle = { ...s } as typeof s
            if (colorThemeKey) normalizedStyle.colorThemeKey = colorThemeKey
            else delete normalizedStyle.colorThemeKey
            if (bgColorThemeKey) normalizedStyle.bgColorThemeKey = bgColorThemeKey
            else delete normalizedStyle.bgColorThemeKey
            if (s.bold) flat.bold = true
            if (s.italic) flat.italic = true
            if (s.underline) flat.underline = true
            if (s.color) flat.color = s.color
            if (colorThemeKey) flat.colorThemeKey = colorThemeKey
            if (s.bgColor) flat.bgColor = s.bgColor
            if (bgColorThemeKey) flat.bgColorThemeKey = bgColorThemeKey
            if (s.fontSize) flat.fontSize = s.fontSize
            const cellFontName = s.fontName || s.fontFamily
            if (cellFontName) { flat.fontName = cellFontName; flat.fontFamily = cellFontName }
            if (s.align) flat.align = s.align
            if (s.verticalAlign) flat.verticalAlign = s.verticalAlign
            if (s.padding) flat.padding = s.padding
            if (s.cellBorders) flat.cellBorders = s.cellBorders
            // 同时保留 style 对象以确保后端兼容
            flat.style = normalizedStyle
          }
          return flat
        }),
      )
      base.props = {
        data: backendData,
        colWidths: normalizedColWidths,
        ...(normalizedRowHeights ? { rowHeights: normalizedRowHeights } : {}),
        cellMinHeight: normalizedCellMinHeight,
        ...(normalizedOutline ? { outline: normalizedOutline } : {}),
        ...(normalizedBorders ? { borders: normalizedBorders } : {}),
        ...(normalizedTableTheme ? { theme: normalizedTableTheme } : {}),
      }
      break
    }
    case 'chart': {
      const c = el as PPTChartElement
      const chartThemeColorKeysRaw = Array.isArray(c.themeColorKeys) ? c.themeColorKeys : []
      const chartThemeColorCount = Math.max(c.themeColors?.length || 0, chartThemeColorKeysRaw.length)
      const chartThemeColorKeys: Array<string | null> = []
      for (let idx = 0; idx < chartThemeColorCount; idx += 1) {
        const color = Array.isArray(c.themeColors) ? c.themeColors[idx] : undefined
        const rawKey = idx < chartThemeColorKeysRaw.length ? chartThemeColorKeysRaw[idx] : undefined
        const normalized = keepThemeKeyIfColorMatches(rawKey, color, theme)
        chartThemeColorKeys.push(normalized ?? null)
      }
      const hasThemeColorKeys = chartThemeColorKeys.some((key) => Boolean(key))
      base.props = {
        chartType: c.chartType,
        data: c.data,
        ...(c.themeColors?.length ? { themeColors: c.themeColors } : {}),
        ...(hasThemeColorKeys ? { themeColorKeys: chartThemeColorKeys } : {}),
        ...(c.options ? { options: c.options } : {}),
        ...(c.chartTitle ? { title: c.chartTitle } : {}),
        ...(c.fill ? { fill: c.fill } : {}),
        ...(c.textColor ? { textColor: c.textColor } : {}),
        ...(c.gridColor ? { gridColor: c.gridColor } : {}),
        ...(c.outline ? { outline: c.outline } : {}),
      }
      break
    }
    case 'line': {
      const ln = el as PPTLineElement
      const bounds = getLineLocalBounds(ln)
      base.width = normalizeSize(
        bounds.width || ln.width || 100,
        100,
        0,
      )
      base.height = normalizeSize(
        bounds.height,
        0,
        0,
      )
      const lineColorThemeKey = keepThemeKeyIfColorMatches(ln.colorThemeKey, ln.color, theme)
      base.props = {
        start: ln.start,
        end: ln.end,
        style: ln.style,
        color: ln.color,
        ...(lineColorThemeKey ? { colorThemeKey: lineColorThemeKey } : {}),
        lineWidth: ln.lineWidth,
        points: ln.points,
        ...(ln.pointSizes ? { pointSizes: ln.pointSizes } : {}),
        ...(ln.curve ? { curve: ln.curve } : {}),
        ...(ln.broken ? { broken: ln.broken } : {}),
        ...(ln.broken2 ? { broken2: ln.broken2 } : {}),
        ...(ln.cubic ? { cubic: ln.cubic } : {}),
      }
      break
    }
    case 'canvas': {
      const cv = el as PPTCanvasElement
      base.props = {
        canvasId: cv.canvasId,
        ...(cv.canvasTitle ? { canvasTitle: cv.canvasTitle } : {}),
        ...(cv.thumbnail ? { thumbnail: cv.thumbnail } : {}),
      }
      break
    }
    case 'latex': {
      const lx = el as PPTLatexElement
      let svgMarkup = lx.svg || ''
      let generatedPath: string | undefined
      let generatedViewBox: [number, number] | undefined
      const strokeWidth = Math.max(0, toFiniteNumber(lx.strokeWidth, 0))
      const color = lx.color || '#111827'
      if (!svgMarkup && lx.path && lx.viewBox) {
        svgMarkup = buildLatexSvgFromPath(
          lx.path,
          lx.viewBox,
          color,
          strokeWidth,
        )
      }
      if (!svgMarkup && lx.latex.trim()) {
        const regenerated = regenerateLatexVisual(lx.latex, color)
        if (regenerated) {
          svgMarkup = regenerated.svg
          generatedPath = regenerated.path
          generatedViewBox = regenerated.viewBox
        }
      }
      if (svgMarkup) {
        svgMarkup = normalizeLatexSvgStyle(svgMarkup, color, strokeWidth)
      }
      const semanticSvgMarkup = svgMarkup
      if (!svgMarkup && lx.latex.trim()) {
        svgMarkup = buildLatexPlaceholderSvg(lx.latex, color, lx.width, lx.height)
      }

      const altText = encodeLatexMetadata({
        latex: lx.latex,
        ...(semanticSvgMarkup ? { svg: semanticSvgMarkup } : {}),
        ...(lx.path || generatedPath ? { path: lx.path || generatedPath } : {}),
        ...(lx.viewBox || generatedViewBox ? { viewBox: lx.viewBox || generatedViewBox } : {}),
        color,
        strokeWidth,
        fixedRatio: lx.fixedRatio,
      })

      base.type = 'image'
      base.props = {
        src: svgMarkup ? svgToDataUrl(svgMarkup) : (lx.rasterSrc || ''),
        fixedRatio: lx.fixedRatio ?? true,
        altText,
      }
      break
    }
    default:
      break
  }

  return base
}

/**
 * 将前端背景格式转换为后端格式
 */
function convertBackgroundToBackend(
  bg?: SlideBackground,
): BackendSlidePage['background'] {
  if (!bg) return { type: 'color', value: '#ffffff' }

  const result = convertBackgroundToBackendInner(bg)
  if (bg.inherited) (result as Record<string, unknown>).inherited = true
  return result
}

function convertBackgroundToBackendInner(
  bg: SlideBackground,
): NonNullable<BackendSlidePage['background']> {
  switch (bg.type) {
    case 'solid':
      return { type: 'color', value: bg.color || '#ffffff' }
    case 'theme': {
      const normalizedKey = normalizeBackgroundThemeKey(bg.theme?.key)
      const resolved = bg.theme?.color
        || bg.color
        || resolveThemeBackgroundColorByKey(normalizedKey)
        || '#ffffff'
      const themePayload: Record<string, unknown> = {}
      if (normalizedKey) themePayload.key = normalizedKey
      if (bg.theme?.color) {
        themePayload.color = bg.theme.color
      } else if (normalizedKey) {
        themePayload.color = resolved
      }
      if (bg.theme?.transforms && Object.keys(bg.theme.transforms).length > 0) {
        themePayload.transforms = bg.theme.transforms
      }
      return {
        type: Object.keys(themePayload).length > 0 ? 'theme' : 'color',
        value: resolved,
        ...(Object.keys(themePayload).length > 0 ? { theme: themePayload } : {}),
      }
    }
    case 'gradient':
      return {
        type: 'gradient',
        gradient: bg.gradient as unknown as Record<string, unknown>,
      }
    case 'image':
      return {
        type: 'image',
        image: {
          src: bg.image?.src || '',
          size: normalizeBackgroundImageSize(bg.image?.size),
        },
      }
    default:
      return { type: 'color', value: '#ffffff' }
  }
}

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

/**
 * 前端 → 后端 preset 映射（SlidePreset → Django model preset）
 *
 * 后端 PRESET_CHOICES 使用 'ppt' 表示 16:9，其余共享相同值。
 */
export const PRESET_FE_TO_BE: Record<SlidePreset, string> = {
  '16:9': 'ppt',
  '4:3': '4:3',
  'xiaohongshu': 'xiaohongshu',
  'poster': 'poster',
  'custom': 'custom',
}

/**
 * 后端 → 前端 preset 映射（Django model preset → SlidePreset）
 */
export const PRESET_BE_TO_FE: Record<string, SlidePreset> = {
  'ppt': '16:9',
  '16:9': '16:9',
  '4:3': '4:3',
  'xiaohongshu': 'xiaohongshu',
  'poster': 'poster',
  'custom': 'custom',
}

/**
 * 将前端 SlidePreset 转为后端 preset 字符串，供 API 请求使用
 */
export function convertPresetToBackend(preset: SlidePreset): string {
  return PRESET_FE_TO_BE[preset] || 'ppt'
}

/**
 * 推断 preset（后端 → 前端方向）
 */
function inferPreset(
  preset?: string,
  width?: number,
  height?: number,
): SlidePreset {
  if (preset && PRESET_BE_TO_FE[preset]) {
    return PRESET_BE_TO_FE[preset]
  }

  if (width && height) {
    const ratio = width / height
    if (ratio > 1.5) return '16:9'
    if (ratio > 1.2) return '4:3'
    if (ratio < 0.8) return 'poster'
    if (height > width) return 'xiaohongshu'
  }

  return '16:9'
}

/**
 * 将 PPTX 形状类型映射到前端 pathFormula
 */
function mapShapeTypeToFormula(
  shapeType?: string,
): { pathFormula?: string; keypoints?: number[] } {
  if (!shapeType) return {}
  const raw = shapeType.trim()
  const snakeToCamel = raw.includes('_')
    ? raw.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
    : raw
  const normalized = snakeToCamel[0]?.toLowerCase() + snakeToCamel.slice(1)

  // OOXML / python-pptx / 前端历史字段别名统一到公式名
  const aliasToFormula: Record<string, string> = {
    rect: 'rect',
    roundRect: 'roundRect',
    round1Rect: 'roundRect',
    round2SameRect: 'roundRect',
    round2DiagRect: 'roundRect',
    snipRoundRect: 'cutRect',
    snip2DiagRect: 'cutRect',

    ellipse: 'ellipse',
    triangle: 'triangle',
    rightTriangle: 'rtTriangle',
    rtTriangle: 'rtTriangle',
    diamond: 'diamond',
    parallelogram: 'parallelogram',
    trapezoid: 'trapezoid',
    pentagon: 'pentagon',
    hexagon: 'hexagon',
    octagon: 'octagon',

    star4: 'star4',
    star5: 'star5',
    star6: 'star6',
    star6Point: 'star6',

    rightArrow: 'rightArrow',
    leftArrow: 'leftArrow',
    upArrow: 'upArrow',
    downArrow: 'downArrow',
    leftRightArrow: 'leftRightArrow',
    upDownArrow: 'upDownArrow',
    notchedRightArrow: 'notchedRightArrow',

    heart: 'heart',
    lightningBolt: 'lightningBolt',
    cloud: 'cloud',
    chevron: 'chevron',
    callout1: 'callout1',
    callout2: 'callout2',

    plus: 'cross',
    cross: 'cross',
  }

  const formula = aliasToFormula[normalized] || aliasToFormula[raw]
  if (formula && ShapePathFormulas[formula]) {
    if (formula === 'roundRect') {
      const roundRectDefaultsByType: Record<string, number[]> = {
        roundrect: [0.1, 0.1, 0.1, 0.1],
        round1rect: [0.2, 0, 0, 0],
        round2samerect: [0.1, 0, 0, 0.1],
        round2diagrect: [0.1, 0, 0.1, 0],
      }
      const preset = roundRectDefaultsByType[normalized.toLowerCase()] || roundRectDefaultsByType[raw.toLowerCase()]
      if (preset) {
        return {
          pathFormula: 'roundRect',
          keypoints: [...preset],
        }
      }
    }
    const defaults = ShapePathFormulas[formula].defaultValue
    return {
      pathFormula: formula,
      keypoints: defaults.length > 0 ? [...defaults] : undefined,
    }
  }

  return {}
}

/**
 * 将前端 pathFormula 反向映射到标准 pptxShapeType。
 */
function mapFormulaToShapeType(pathFormula?: string): string | undefined {
  if (!pathFormula) return undefined
  const formulaToType: Record<string, string> = {
    rect: 'rect',
    roundRect: 'roundRect',
    roundRectSingle: 'round1Rect',
    cutRect: 'snip2DiagRect',
    ellipse: 'ellipse',
    triangle: 'triangle',
    rtTriangle: 'rtTriangle',
    diamond: 'diamond',
    parallelogram: 'parallelogram',
    trapezoid: 'trapezoid',
    pentagon: 'pentagon',
    hexagon: 'hexagon',
    octagon: 'octagon',
    star4: 'star4',
    star5: 'star5',
    star6: 'star6',
    rightArrow: 'rightArrow',
    leftArrow: 'leftArrow',
    upArrow: 'upArrow',
    downArrow: 'downArrow',
    leftRightArrow: 'leftRightArrow',
    upDownArrow: 'upDownArrow',
    notchedRightArrow: 'notchedRightArrow',
    heart: 'heart',
    lightningBolt: 'lightningBolt',
    cloud: 'cloud',
    chevron: 'chevron',
    callout1: 'callout1',
    callout2: 'callout2',
    cross: 'plus',
  }
  return formulaToType[pathFormula]
}

/**
 * 生成默认矩形 SVG path
 */
function generateRectPath(w: number, h: number): string {
  return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`
}
