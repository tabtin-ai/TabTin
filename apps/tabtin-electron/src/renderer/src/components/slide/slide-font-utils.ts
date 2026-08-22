import type { SlidePresentation } from '@tabtin/tabslide'
import { setRuntimeFontFamilies } from '@tabtin/tabslide'

// ─── 类型 ──────────────────────────────────────────────

export type EmbeddedFontPayload = {
  name: string
  style: string
  format: string
  data_base64?: string
  oss_url?: string
}
export type ThemeFontsPayload = Record<string, string>
export type FontEmbeddingMeta = {
  embeddedFonts: EmbeddedFontPayload[]
  themeFonts: ThemeFontsPayload
}

export const FONT_META_THEME_KEY = '_tabslideFontEmbedding'

// ─── 字体名称解析 ─────────────────────────────────────

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

const CJK_FONT_FALLBACK_STACK = `'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Source Han Sans SC', sans-serif`

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

export function normalizeFontFamilyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const first = splitFirstFontFamilyToken(trimmed).trim().replace(/^['"]|['"]$/g, '')
  if (!first) return null
  const lower = first.toLowerCase()
  if (lower.startsWith('var(')) return null
  if (GENERIC_FONT_FAMILY_KEYWORDS.has(lower)) return null
  return first
}

function escapeCssSingleQuoted(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function toCssFontFamilyToken(fontName: string): string {
  return `'${escapeCssSingleQuoted(fontName)}'`
}

function buildFontStack(primaryName: string | null): string {
  if (!primaryName) return CJK_FONT_FALLBACK_STACK
  return `${toCssFontFamilyToken(primaryName)}, ${CJK_FONT_FALLBACK_STACK}`
}

// ─── 字体元数据清洗 ────────────────────────────────────

export function sanitizeThemeFonts(raw: unknown): ThemeFontsPayload {
  if (!raw || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const out: ThemeFontsPayload = {}
  for (const key of ['major_latin', 'major_ea', 'major_cs', 'minor_latin', 'minor_ea', 'minor_cs']) {
    const value = normalizeFontFamilyName(source[key])
    if (value) out[key] = value
  }
  return out
}

function normalizeEmbeddedFontStyle(raw: unknown): 'normal' | 'bold' | 'italic' | 'bolditalic' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'bold') return 'bold'
  if (value === 'italic') return 'italic'
  if (value === 'bolditalic' || value === 'bold_italic' || value === 'bold-italic') return 'bolditalic'
  return 'normal'
}

function resolveEmbeddedFontFormat(raw: unknown): {
  format: 'truetype' | 'opentype' | 'woff' | 'woff2'
  mimeType: string
} {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'woff') return { format: 'woff', mimeType: 'font/woff' }
  if (value === 'woff2') return { format: 'woff2', mimeType: 'font/woff2' }
  if (value === 'opentype' || value === 'otf') return { format: 'opentype', mimeType: 'font/otf' }
  return { format: 'truetype', mimeType: 'font/ttf' }
}

export function sanitizeEmbeddedFonts(raw: unknown): EmbeddedFontPayload[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: EmbeddedFontPayload[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = normalizeFontFamilyName(record.name)
    const dataBase64 = typeof record.data_base64 === 'string' ? record.data_base64.trim() : ''
    const ossUrl = typeof record.oss_url === 'string' ? record.oss_url.trim() : ''
    if (!name || (!dataBase64 && !ossUrl)) continue
    const style = normalizeEmbeddedFontStyle(record.style)
    const { format } = resolveEmbeddedFontFormat(record.format)
    const key = `${name.toLowerCase()}__${style}`
    if (seen.has(key)) continue
    seen.add(key)
    const entry: EmbeddedFontPayload = {
      name,
      style,
      format,
      data_base64: dataBase64,
    }
    if (ossUrl) entry.oss_url = ossUrl
    out.push(entry)
  }
  return out
}

export function normalizeFontEmbeddingMeta(raw: {
  embeddedFonts?: unknown
  themeFonts?: unknown
}): FontEmbeddingMeta {
  return {
    embeddedFonts: sanitizeEmbeddedFonts(raw.embeddedFonts),
    themeFonts: sanitizeThemeFonts(raw.themeFonts),
  }
}

export function hasFontEmbeddingMeta(meta: FontEmbeddingMeta): boolean {
  return meta.embeddedFonts.length > 0 || Object.keys(meta.themeFonts).length > 0
}

export function extractLegacyFontMetaFromTheme(theme: SlidePresentation['theme']): FontEmbeddingMeta {
  const source = (theme && typeof theme === 'object')
    ? (theme as unknown as Record<string, unknown>)
    : undefined
  const payload = source?.[FONT_META_THEME_KEY]
  if (!payload || typeof payload !== 'object') {
    return { embeddedFonts: [], themeFonts: {} }
  }
  const body = payload as Record<string, unknown>
  return normalizeFontEmbeddingMeta({
    embeddedFonts: body.embeddedFonts ?? body.embedded_fonts,
    themeFonts: body.themeFonts ?? body.theme_fonts,
  })
}

export function buildFontMetaRequestPayload(meta: FontEmbeddingMeta): {
  embedded_fonts: EmbeddedFontPayload[]
  theme_fonts: ThemeFontsPayload
} {
  return {
    embedded_fonts: meta.embeddedFonts,
    theme_fonts: meta.themeFonts,
  }
}

// ─── 字体收集 ──────────────────────────────────────────

function collectFontFamiliesFromHtml(html: unknown, out: Set<string>) {
  if (typeof html !== 'string' || !html) return
  const regex = /font-family\s*:\s*(?:["']([^"']+)["']|([^;"'>]+))/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(html))) {
    const name = normalizeFontFamilyName(match[1] || match[2])
    if (name) out.add(name)
  }
}

function collectPresentationFontFamilies(presentation: SlidePresentation): string[] {
  const fonts = new Set<string>()

  for (const page of presentation.pages) {
    for (const element of page.elements) {
      if (element.type === 'text') {
        const name = normalizeFontFamilyName(element.defaultFontName)
        if (name) fonts.add(name)
        collectFontFamiliesFromHtml(element.content, fonts)
        continue
      }

      if (element.type === 'shape') {
        const text = element.text
        if (text) {
          const name = normalizeFontFamilyName(text.defaultFontName)
          if (name) fonts.add(name)
          collectFontFamiliesFromHtml(text.content, fonts)
        }
        continue
      }

      if (element.type === 'table') {
        for (const row of element.data) {
          for (const cell of row) {
            const style = cell.style || {}
            const legacyFont = (cell as unknown as { fontFamily?: string }).fontFamily
            const name = normalizeFontFamilyName(style.fontFamily || legacyFont)
            if (name) fonts.add(name)
            collectFontFamiliesFromHtml(cell.richText, fonts)
          }
        }
      }
    }
  }

  return Array.from(fonts).sort((a, b) => a.localeCompare(b, 'zh-Hans'))
}

export function applyRuntimeFontFamilies(params: {
  embeddedFonts?: Array<{ name: string }>
  themeFonts?: Record<string, string>
  presentation?: SlidePresentation
}) {
  const out = new Set<string>()
  for (const font of params.embeddedFonts || []) {
    const name = normalizeFontFamilyName(font?.name)
    if (name) out.add(name)
  }
  for (const name of Object.values(params.themeFonts || {})) {
    const normalized = normalizeFontFamilyName(name)
    if (normalized) out.add(normalized)
  }
  if (params.presentation) {
    const themeFontName = normalizeFontFamilyName(params.presentation.theme?.fontName)
    if (themeFontName) out.add(themeFontName)
    const themeHeadingFontName = normalizeFontFamilyName(params.presentation.theme?.headingFontName)
    if (themeHeadingFontName) out.add(themeHeadingFontName)
    for (const name of collectPresentationFontFamilies(params.presentation)) {
      out.add(name)
    }
  }
  setRuntimeFontFamilies(Array.from(out))
}

export function buildThemeFontsFromPresentationTheme(presentation?: SlidePresentation): Record<string, string> {
  if (!presentation?.theme) return {}
  const minor = normalizeFontFamilyName(presentation.theme.fontName)
  const major = normalizeFontFamilyName(presentation.theme.headingFontName) || minor
  const out: Record<string, string> = {}
  if (major) {
    out.major_ea = major
    out.major_latin = major
  }
  if (minor) {
    out.minor_ea = minor
    out.minor_latin = minor
  }
  return out
}

// ─── CSS @font-face 注入 ───────────────────────────────

let lastEmbeddedFontSheetSignature = ''

/**
 * 将 PPTX 嵌入字体注入到浏览器 @font-face。
 *
 * 每个字体通过 base64 data URL 加载，浏览器会缓存字体数据。
 * 注入后，CSS font-family 引用该字体名即可正常渲染。
 */
export function injectEmbeddedFonts(
  fonts: Array<{ name: string; style: string; format: string; data_base64?: string; oss_url?: string }>,
) {
  let styleEl = document.getElementById('tabslide-embedded-fonts') as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'tabslide-embedded-fonts'
    document.head.appendChild(styleEl)
  }

  const unique = new Map<string, {
    key: string
    name: string
    style: 'normal' | 'bold' | 'italic' | 'bolditalic'
    format: 'truetype' | 'opentype' | 'woff' | 'woff2'
    mimeType: string
    dataBase64: string
    ossUrl: string
  }>()

  for (const font of fonts) {
    const name = normalizeFontFamilyName(font?.name)
    if (!name) continue
    const dataBase64 = typeof font?.data_base64 === 'string' ? font.data_base64.trim() : ''
    const ossUrl = typeof font?.oss_url === 'string' ? font.oss_url.trim() : ''
    if (!dataBase64 && !ossUrl) continue

    const style = normalizeEmbeddedFontStyle(font.style)
    const { format, mimeType } = resolveEmbeddedFontFormat(font.format)
    const key = `${name.toLowerCase()}__${style}`
    unique.set(key, { key, name, style, format, mimeType, dataBase64, ossUrl })
  }

  const entries = Array.from(unique.values()).sort((a, b) => a.key.localeCompare(b.key))
  const signature = entries
    .map((entry) => {
      if (entry.ossUrl) return `${entry.key}:${entry.format}:oss:${entry.ossUrl}`
      return `${entry.key}:${entry.format}:${entry.dataBase64.length}:${entry.dataBase64.slice(0, 24)}`
    })
    .join('|')

  if (signature === lastEmbeddedFontSheetSignature) {
    return
  }
  lastEmbeddedFontSheetSignature = signature

  const rules: string[] = []
  for (const entry of entries) {
    let fontWeight = 'normal'
    let fontStyle = 'normal'
    switch (entry.style) {
      case 'bold':
        fontWeight = 'bold'
        break
      case 'italic':
        fontStyle = 'italic'
        break
      case 'bolditalic':
        fontWeight = 'bold'
        fontStyle = 'italic'
        break
    }
    const familyToken = toCssFontFamilyToken(entry.name)
    const srcUrl = entry.ossUrl
      ? entry.ossUrl
      : `data:${entry.mimeType};base64,${entry.dataBase64}`
    rules.push(`
@font-face {
  font-family: ${familyToken};
  font-weight: ${fontWeight};
  font-style: ${fontStyle};
  src: url('${srcUrl}') format('${entry.format}');
  font-display: swap;
}`)
  }
  styleEl.textContent = rules.join('\n')
  console.log(`[TabSlide] Embedded fonts refreshed: ${entries.length}`)
}

/**
 * 将主题字体注入为 CSS 自定义属性和 fallback font-family。
 */
export function injectThemeFonts(themeFonts: Record<string, string>) {
  let styleEl = document.getElementById('tabslide-theme-fonts') as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'tabslide-theme-fonts'
    document.head.appendChild(styleEl)
  }

  const majorFont = normalizeFontFamilyName(themeFonts.major_ea || themeFonts.major_latin)
  const minorFont = normalizeFontFamilyName(themeFonts.minor_ea || themeFonts.minor_latin)
  const majorStack = buildFontStack(majorFont)
  const minorStack = buildFontStack(minorFont)

  const css = `
:root {
  --tabslide-major-font: ${majorStack};
  --tabslide-minor-font: ${minorStack};
}
.slide-editor-container, .tabslide-slide {
  font-family: var(--tabslide-minor-font);
}
`
  if (styleEl.textContent === css) return
  styleEl.textContent = css
  if (majorFont || minorFont) {
    console.log(`[TabSlide] Injected theme fonts: major=${majorFont || '(fallback)'}, minor=${minorFont || '(fallback)'}`)
  }
}
