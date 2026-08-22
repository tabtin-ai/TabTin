import type { PPTShapeElement, SlideLayoutRef, PPTElement, ChartType, ChartData } from '../../../types/slides'
import { normalizeRoundRectKeypoints } from '../../../configs/shapes'

export const TOOLBAR_WIDTH = 40
export const PANEL_WIDTH = 240
export const ANIM_MS = '0.22s'

export type ThemeKeyOption = {
  key: string
  labelKey: string
  fallback: string
}

export const BG_THEME_KEYS: ThemeKeyOption[] = [
  { key: 'lt1', labelKey: 'color.light1', fallback: 'Light 1' },
  { key: 'lt2', labelKey: 'color.light2', fallback: 'Light 2' },
  { key: 'dk1', labelKey: 'color.dark1', fallback: 'Dark 1' },
  { key: 'dk2', labelKey: 'color.dark2', fallback: 'Dark 2' },
  { key: 'accent1', labelKey: 'color.accent1', fallback: 'Accent 1' },
  { key: 'accent2', labelKey: 'color.accent2', fallback: 'Accent 2' },
  { key: 'accent3', labelKey: 'color.accent3', fallback: 'Accent 3' },
  { key: 'accent4', labelKey: 'color.accent4', fallback: 'Accent 4' },
  { key: 'accent5', labelKey: 'color.accent5', fallback: 'Accent 5' },
  { key: 'accent6', labelKey: 'color.accent6', fallback: 'Accent 6' },
  { key: 'bg1', labelKey: 'color.background1', fallback: 'Background 1' },
  { key: 'bg2', labelKey: 'color.background2', fallback: 'Background 2' },
  { key: 'tx1', labelKey: 'color.text1', fallback: 'Text 1' },
  { key: 'tx2', labelKey: 'color.text2', fallback: 'Text 2' },
]

export const getThemeKeyLabel = (
  item: ThemeKeyOption,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string => {
  const translated = translate(item.labelKey)
  return translated === item.labelKey ? item.fallback : translated
}

export const CHART_PRIMARY_THEME_KEYS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as const

export const CHART_THEME_KEY_NORMALIZE_MAP: Record<string, string> = {
  '1': 'tx1', '13': 'tx1', dk1: 'tx1', dark1: 'tx1', dark_1: 'tx1', tx1: 'tx1', text1: 'tx1', text_1: 'tx1',
  '2': 'bg1', '14': 'bg1', lt1: 'bg1', light1: 'bg1', light_1: 'bg1', bg1: 'bg1', background1: 'bg1', background_1: 'bg1',
  '3': 'tx2', '15': 'tx2', dk2: 'tx2', dark2: 'tx2', dark_2: 'tx2', tx2: 'tx2', text2: 'tx2', text_2: 'tx2',
  '4': 'bg2', '16': 'bg2', lt2: 'bg2', light2: 'bg2', light_2: 'bg2', bg2: 'bg2', background2: 'bg2', background_2: 'bg2',
  accent1: 'accent1', accent_1: 'accent1', accent2: 'accent2', accent_2: 'accent2',
  accent3: 'accent3', accent_3: 'accent3', accent4: 'accent4', accent_4: 'accent4',
  accent5: 'accent5', accent_5: 'accent5', accent6: 'accent6', accent_6: 'accent6',
}

export const CHART_THEME_KEY_ALLOWED = new Set(BG_THEME_KEYS.map((item) => item.key))

export const normalizeChartThemeKey = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (!key) return null
  const normalized = CHART_THEME_KEY_NORMALIZE_MAP[key] || key
  return CHART_THEME_KEY_ALLOWED.has(normalized) ? normalized : null
}

export const roundTo = (value: number, digits = 2): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export const toColorInputHex = (raw?: string): string => {
  if (!raw) return '#000000'
  const value = raw.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
    return value.slice(0, 7).toLowerCase()
  }
  const rgbMatch = value.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
  if (rgbMatch) {
    const toHex = (v: string) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0')
    return `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`
  }
  return '#000000'
}

export const extractColorAlpha = (raw?: string): number => {
  if (!raw) return 1
  const value = raw.trim()
  const rgbaMatch = value.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/i)
  if (rgbaMatch) return Math.max(0, Math.min(1, Number(rgbaMatch[1]) || 1))
  if (/^#[0-9a-fA-F]{8}$/.test(value)) {
    return Math.round((parseInt(value.slice(7, 9), 16) / 255) * 100) / 100
  }
  return 1
}

export const colorWithAlpha = (hex: string, alpha: number): string => {
  const h = toColorInputHex(hex)
  if (alpha >= 1) return h
  const r = parseInt(h.slice(1, 3), 16)
  const g = parseInt(h.slice(3, 5), 16)
  const b = parseInt(h.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${Math.round(alpha * 100) / 100})`
}

export const ROUND_RECT_PPTX_TYPES = new Set(['roundRect', 'round1Rect', 'round2SameRect', 'round2DiagRect'])

export const clampRoundRectRatio = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(0.5, value))
}

export const resolveRoundRectCorners = (shape: PPTShapeElement): [number, number, number, number] => {
  const keypoints = Array.isArray(shape.keypoints) ? shape.keypoints : undefined
  if (shape.pathFormula === 'roundRectSingle') {
    const single = clampRoundRectRatio(Number(keypoints?.[0] ?? 0.2))
    return [single, 0, 0, 0]
  }
  if (shape.pathFormula === 'roundRect') {
    return normalizeRoundRectKeypoints(keypoints)
  }
  if (ROUND_RECT_PPTX_TYPES.has(shape.pptxShapeType || '')) {
    if (shape.pptxShapeType === 'round1Rect') {
      const single = clampRoundRectRatio(Number(keypoints?.[0] ?? 0.2))
      return [single, 0, 0, 0]
    }
    if (shape.pptxShapeType === 'round2DiagRect') {
      const diagonal = clampRoundRectRatio(Number(keypoints?.[0] ?? 0.1))
      return [diagonal, 0, diagonal, 0]
    }
    if (shape.pptxShapeType === 'round2SameRect') {
      const sameSide = clampRoundRectRatio(Number(keypoints?.[0] ?? 0.1))
      return [sameSide, 0, 0, sameSide]
    }
    return normalizeRoundRectKeypoints(keypoints)
  }
  return normalizeRoundRectKeypoints(undefined, 0)
}

export type LayoutOption = {
  key: string
  layout: SlideLayoutRef
  label: string
  masterElements?: PPTElement[]
}

export const getLayoutKey = (layout?: SlideLayoutRef): string => {
  if (!layout) return ''
  const partName = typeof layout.partName === 'string' ? layout.partName.trim() : ''
  if (partName) return `part:${partName.toLowerCase()}`
  if (typeof layout.index === 'number' && Number.isFinite(layout.index)) {
    return `index:${Math.trunc(layout.index)}`
  }
  const name = typeof layout.name === 'string' ? layout.name.trim() : ''
  if (name) return `name:${name.toLowerCase()}`
  return ''
}

export const cloneLayoutRef = (layout: SlideLayoutRef): SlideLayoutRef => ({
  ...(layout.name ? { name: layout.name } : {}),
  ...(typeof layout.index === 'number' ? { index: layout.index } : {}),
  ...(layout.partName ? { partName: layout.partName } : {}),
  ...(layout.masterName ? { masterName: layout.masterName } : {}),
  ...(layout.masterPartName ? { masterPartName: layout.masterPartName } : {}),
})

export const getLayoutOptionLabel = (
  layout: SlideLayoutRef,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string => {
  const parts: string[] = []
  if (layout.name) {
    parts.push(layout.name)
  } else if (typeof layout.index === 'number') {
    const key = 'property.pageLayout.layoutIndex'
    const translated = translate(key, { index: layout.index })
    parts.push(translated === key ? `Layout #${layout.index}` : translated)
  } else {
    parts.push(translate('property.pageLayout.unnamed'))
  }
  if (layout.masterName) {
    parts.push(translate('property.pageLayout.master', { name: layout.masterName }))
  }
  return parts.join(' · ')
}

export function typeLabel(type: string, translate: (key: string) => string) {
  const map: Record<string, string> = {
    text: translate('element.type.text'),
    image: translate('element.type.image'),
    shape: translate('element.type.shape'),
    line: translate('element.type.line'),
    chart: translate('element.type.chart'),
    table: translate('element.type.table'),
    latex: translate('element.type.latex'),
    video: translate('element.type.video'),
    audio: translate('element.type.audio'),
  }
  return map[type] || type
}

export const CHART_TYPE_OPTIONS: ChartType[] = [
  'bar', 'column', 'line', 'area', 'pie', 'ring', 'radar', 'scatter',
]

export function supportsStack(chartType: ChartType): boolean {
  return chartType === 'bar' || chartType === 'column' || chartType === 'line' || chartType === 'area'
}

export function supportsSmooth(chartType: ChartType): boolean {
  return chartType === 'line' || chartType === 'area' || chartType === 'scatter'
}

export function parseChartTokens(input: string): string[] {
  return input
    .split(/[,\n，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseSeriesMatrix(input: string): number[][] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .split(/[,\t，]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => {
          const n = Number(s)
          return Number.isFinite(n) ? n : 0
        }),
    )
    .filter((row) => row.length > 0)
}

export function formatSeriesMatrix(rows: number[][] | undefined): string {
  if (!Array.isArray(rows) || rows.length === 0) return ''
  return rows.map((row) => row.join(', ')).join('\n')
}

export function normalizeChartData(
  chartType: ChartType,
  data: ChartData,
  translate?: (key: string, options?: Record<string, unknown>) => string,
): ChartData {
  const t = translate || ((key: string) => key)
  let labels = [...data.labels]
  let legends = [...data.legends]
  let series = data.series.map((row) => [...row])
  let xSeries = Array.isArray(data.xSeries)
    ? data.xSeries
      .filter((row): row is number[] => Array.isArray(row))
      .map((row) =>
        row.map((cell, idx) => {
          const value = Number(cell)
          return Number.isFinite(value) ? value : idx + 1
        }),
      )
    : []

  const isPieType = chartType === 'pie' || chartType === 'ring'

  if (isPieType) {
    const firstSeries = series[0] ? [...series[0]] : []
    const count = Math.max(firstSeries.length, labels.length)
    if (labels.length === 0 && count > 0) {
      labels = Array.from({ length: count }, (_, i) =>
        t('property.chart.defaultCategory', { index: i + 1 }),
      )
    }
    const normalizedSeries = Array.from({ length: labels.length }, (_, i) => firstSeries[i] ?? 0)
    series = [normalizedSeries]
    legends = legends.length > 0 ? [legends[0]] : [t('property.chart.defaultLegendShare')]
    return { labels, legends, series }
  }

  const maxSeriesLen = series.reduce((m, row) => Math.max(m, row.length), 0)
  const targetLen = Math.max(labels.length, maxSeriesLen)

  if (labels.length === 0 && targetLen > 0) {
    labels = Array.from({ length: targetLen }, (_, i) => `${i + 1}`)
  }

  const normalizedLen = labels.length
  series = series.map((row) => Array.from({ length: normalizedLen }, (_, i) => row[i] ?? 0))

  if (series.length === 0 && normalizedLen > 0) {
    series = [Array.from({ length: normalizedLen }, () => 0)]
  }

  if (legends.length < series.length) {
    legends = [
      ...legends,
      ...Array.from(
        { length: series.length - legends.length },
        (_, i) => t('property.chart.defaultSeries', { index: legends.length + i + 1 }),
      ),
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
    return { labels, legends, series, xSeries }
  }

  return { labels, legends, series }
}
