import type { GradientStop, SlideBackground, SlideTheme } from '../types/slides'

const DEFAULT_BG = '#ffffff'
const DEFAULT_THEME_BG2 = '#e7e6e6'
const DEFAULT_THEME_TX2 = '#44546a'
const DEFAULT_THEME_HLINK = '#0563c1'
const DEFAULT_THEME_FOLHLINK = '#954f72'

type LegacySlideBackground = SlideBackground & {
  /** 兼容历史后端字段 */
  value?: string
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function normalizeGradientStops(stops: GradientStop[] = []): GradientStop[] {
  if (stops.length === 0) {
    return [
      { pos: 0, color: '#ffffff' },
      { pos: 1, color: '#000000' },
    ]
  }

  const normalized = stops
    .map((s, idx) => ({
      pos: typeof s.pos === 'number' ? clamp01(s.pos) : (stops.length === 1 ? 0 : idx / (stops.length - 1)),
      color: s.color || '#000000',
    }))
    .sort((a, b) => a.pos - b.pos)

  if (normalized.length === 1) {
    return [
      { pos: 0, color: normalized[0].color },
      { pos: 1, color: normalized[0].color },
    ]
  }

  return normalized
}

function getBackgroundColorValue(bg: SlideBackground | undefined): string | undefined {
  if (!bg) return undefined
  const legacy = bg as LegacySlideBackground
  return bg.color || legacy.value
}

function isLegacyColorType(bg: SlideBackground | undefined): boolean {
  if (!bg) return false
  const legacyType = (bg as { type?: string }).type
  return legacyType === 'color'
}

function normalizeThemeColorKey(key: string | undefined): string | undefined {
  if (!key) return undefined
  const raw = key.trim().toLowerCase()
  if (!raw) return undefined

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

  return map[raw]
}

export function resolveThemeColorByKey(key: string | undefined, theme?: SlideTheme): string | undefined {
  const normalized = normalizeThemeColorKey(key)
  if (!normalized) return undefined

  if (normalized === 'bg1') {
    return theme?.backgroundColor
  }
  if (normalized === 'tx1') {
    return theme?.fontColor
  }
  if (normalized === 'bg2') {
    return theme?.bg2Color || DEFAULT_THEME_BG2
  }
  if (normalized === 'tx2') {
    return theme?.tx2Color || DEFAULT_THEME_TX2
  }
  if (normalized.startsWith('accent')) {
    const index = Number.parseInt(normalized.slice(6), 10)
    if (Number.isFinite(index) && index >= 1 && index <= 6) {
      return theme?.themeColors?.[index - 1]
    }
  }
  if (normalized === 'hlink') return theme?.hlinkColor || DEFAULT_THEME_HLINK
  if (normalized === 'folhlink') return theme?.folHlinkColor || DEFAULT_THEME_FOLHLINK
  return undefined
}

function normalizeBackgroundImageSize(raw: unknown): 'cover' | 'contain' | 'repeat' {
  return raw === 'contain' || raw === 'repeat' ? raw : 'cover'
}

function resolveThemeBgColor(bg: SlideBackground, theme?: SlideTheme): string {
  if (theme && bg.theme?.key) {
    const live = resolveThemeColorByKey(bg.theme.key, theme)
    if (live) return live
  }
  return (
    bg.theme?.color
    || getBackgroundColorValue(bg)
    || theme?.backgroundColor
    || DEFAULT_BG
  )
}

export function resolveBackgroundColor(
  bg?: SlideBackground,
  theme?: SlideTheme,
): string {
  if (!bg) return theme?.backgroundColor || DEFAULT_BG
  if (bg.type === 'solid' || isLegacyColorType(bg)) {
    return getBackgroundColorValue(bg) || theme?.backgroundColor || DEFAULT_BG
  }
  if (bg.type === 'theme') return resolveThemeBgColor(bg, theme)
  return theme?.backgroundColor || DEFAULT_BG
}

export function getBackgroundCssValue(
  bg?: SlideBackground,
  theme?: SlideTheme,
): string {
  const fallback = theme?.backgroundColor || DEFAULT_BG
  if (!bg) return fallback

  if (bg.type === 'solid' || isLegacyColorType(bg)) {
    return getBackgroundColorValue(bg) || fallback
  }

  if (bg.type === 'theme') {
    return resolveThemeBgColor(bg, theme)
  }

  if (bg.type === 'image') {
    const src = bg.image?.src || ''
    if (!src) return fallback
    const size = normalizeBackgroundImageSize(bg.image?.size)
    const bgSize = size === 'repeat' ? 'auto' : size
    const bgRepeat = size === 'repeat' ? 'repeat' : 'no-repeat'
    const escaped = src.replace(/(["\\])/g, '\\$1')
    return `${fallback} url("${escaped}") center / ${bgSize} ${bgRepeat}`
  }

  if (bg.type === 'gradient' && bg.gradient) {
    const stops = normalizeGradientStops(bg.gradient.colors)
      .map((s) => `${s.color} ${Math.round(clamp01(s.pos) * 100)}%`)
      .join(', ')
    if (bg.gradient.type === 'radial') {
      const cx = typeof bg.gradient.center?.x === 'number' ? Math.round(bg.gradient.center.x * 100) : 50
      const cy = typeof bg.gradient.center?.y === 'number' ? Math.round(bg.gradient.center.y * 100) : 50
      return `radial-gradient(circle at ${cx}% ${cy}%, ${stops})`
    }
    // 存储角度使用 PPTX 语义（0°=左→右，90°=上→下），转 CSS 需 +90°
    const pptxAngle = typeof bg.gradient.rotate === 'number' ? bg.gradient.rotate : 0
    const cssAngle = (pptxAngle + 90) % 360
    return `linear-gradient(${cssAngle}deg, ${stops})`
  }

  return fallback
}

export function getBackgroundCssText(
  bg?: SlideBackground,
  theme?: SlideTheme,
): string {
  return `background: ${getBackgroundCssValue(bg, theme)};`
}
