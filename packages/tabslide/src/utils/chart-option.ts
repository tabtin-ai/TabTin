import type { PPTChartElement, ChartType, ChartData } from '../types/slides'

const DEFAULT_COLORS = [
  '#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de',
  '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc',
]
const HEX_COLOR_REG = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RGBA_COLOR_REG = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:\d+\.?\d*|\.\d+)\s*)?\)$/
const HSL_COLOR_REG = /^hsla?\(\s*(\d{1,3}(?:\.\d+)?)\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*(?:,\s*[\d.]+\s*)?\)$/

export function isPieType(ct: ChartType): boolean {
  return ct === 'pie' || ct === 'ring'
}

export function hasValidChartData(el: PPTChartElement): boolean {
  const { data } = el
  if (!data) return false
  if (isPieType(el.chartType)) {
    return data.labels.length > 0 && data.series.length > 0 && data.series[0]?.length > 0
  }
  return data.series.length > 0 && data.series.some((s) => s.length > 0)
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function byteToHex(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0')
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const a = sn * Math.min(ln, 1 - ln)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return clampByte(255 * (ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)))
  }
  return `#${byteToHex(f(0))}${byteToHex(f(8))}${byteToHex(f(4))}`
}

function normalizePaletteColor(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const hexMatch = trimmed.match(HEX_COLOR_REG)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase()
    }
    if (hex.length === 8) {
      return `#${hex.slice(0, 6)}`.toLowerCase()
    }
    return `#${hex}`.toLowerCase()
  }

  const rgbaMatch = trimmed.match(RGBA_COLOR_REG)
  if (rgbaMatch) {
    return `#${byteToHex(parseInt(rgbaMatch[1], 10))}${byteToHex(parseInt(rgbaMatch[2], 10))}${byteToHex(parseInt(rgbaMatch[3], 10))}`
  }

  const hslMatch = trimmed.match(HSL_COLOR_REG)
  if (hslMatch) {
    return hslToHex(parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3]))
  }

  return null
}

export function resolvePalette(themeColors?: string[]): string[] {
  const seen = new Set<string>()
  const picked: string[] = []
  for (const raw of themeColors || []) {
    if (typeof raw !== 'string') continue
    const color = normalizePaletteColor(raw)
    if (!color || seen.has(color)) continue
    seen.add(color)
    picked.push(color)
  }
  if (picked.length === 0) return DEFAULT_COLORS
  const fallback = DEFAULT_COLORS.filter((c) => !seen.has(c.toLowerCase()))
  return [...picked, ...fallback]
}

function legendPosToECharts(pos?: 'b' | 't' | 'l' | 'r'): Record<string, unknown> {
  switch (pos) {
    case 't': return { top: 'top', left: 'center', orient: 'horizontal' }
    case 'l': return { left: 'left', top: 'middle', orient: 'vertical' }
    case 'r': return { right: 'right', top: 'middle', orient: 'vertical' }
    case 'b':
    default: return { bottom: 0, left: 'center', orient: 'horizontal' }
  }
}

export function buildChartOption(el: PPTChartElement): Record<string, unknown> {
  const { chartType, data, themeColors, options, textColor, gridColor, chartTitle } = el
  const colors = resolvePalette(themeColors)

  const hasTitle = !!chartTitle
  const legendPos = options?.legendPosition ?? 'b'

  const base: Record<string, unknown> = {
    color: colors,
    animation: false,
    tooltip: { trigger: isPieType(chartType) ? 'item' : 'axis' },
    ...(chartTitle
      ? {
          title: {
            text: chartTitle,
            left: 'center',
            ...(textColor ? { textStyle: { color: textColor } } : {}),
          },
        }
      : {}),
  }

  if (!isPieType(chartType) && chartType !== 'radar') {
    const gridTop = hasTitle ? 40 : 20
    const gridBottom = legendPos === 'b' ? 40 : 20
    const gridLeft = legendPos === 'l' ? 80 : 'auto'
    const gridRight = legendPos === 'r' ? 80 : 'auto'
    base.grid = {
      top: gridTop,
      bottom: gridBottom,
      left: gridLeft,
      right: gridRight,
      containLabel: true,
    }
  }

  if (isPieType(chartType)) {
    const showDataLabel = options?.showDataLabel !== false
    base.series = [
      {
        type: 'pie',
        radius: chartType === 'ring' ? ['40%', '70%'] : '70%',
        data: data.labels.map((label, i) => ({
          name: label,
          value: data.series[0]?.[i] ?? 0,
          ...(i < colors.length ? { itemStyle: { color: colors[i] } } : {}),
        })),
        label: {
          show: showDataLabel,
          formatter: '{b}: {d}%',
          ...(textColor ? { color: textColor } : {}),
        },
      },
    ]
    const showLegend = options?.showLegend !== false
    base.legend = {
      show: showLegend,
      data: data.labels,
      ...legendPosToECharts(options?.legendPosition),
      ...(textColor ? { textStyle: { color: textColor } } : {}),
    }
  } else if (chartType === 'radar') {
    const showDataLabel = options?.showDataLabel === true
    base.radar = {
      indicator: data.labels.map((name) => ({ name })),
      ...(textColor ? { axisName: { color: textColor } } : {}),
      ...(gridColor ? { splitLine: { lineStyle: { color: gridColor } } } : {}),
    }
    base.series = [
      {
        type: 'radar',
        data: data.series.map((values, i) => ({
          value: values,
          name: data.legends[i] || `Series ${i + 1}`,
        })),
        ...(options?.radarFilled ? { areaStyle: { opacity: 0.3 } } : {}),
        ...(showDataLabel
          ? {
              label: {
                show: true,
                ...(textColor ? { color: textColor } : {}),
              },
            }
          : {}),
      },
    ]
    const showLegendRadar = options?.showLegend ?? (data.legends.length > 1)
    if (showLegendRadar) {
      base.legend = {
        show: true,
        data: data.legends,
        ...legendPosToECharts(options?.legendPosition),
        ...(textColor ? { textStyle: { color: textColor } } : {}),
      }
    }
  } else if (chartType === 'scatter') {
    const axisLabelStyle = textColor ? { axisLabel: { color: textColor }, axisLine: { lineStyle: { color: gridColor || textColor } } } : {}
    const splitLineStyle = gridColor ? { splitLine: { lineStyle: { color: gridColor } } } : {}
    const showDataLabel = options?.showDataLabel === true
    // smoothScatter 在 ECharts 侧仅影响 symbolSize；PPTX 导出中的平滑连线由 pptxgenjs lineSmooth 控制
    const smoothScatter = options?.lineSmooth === true
    const xSeries = Array.isArray(data.xSeries) ? data.xSeries : []

    base.xAxis = { type: 'value' as const, ...axisLabelStyle, ...splitLineStyle }
    base.yAxis = { type: 'value' as const, ...axisLabelStyle, ...splitLineStyle }
    base.tooltip = { trigger: 'item' }

    base.series = data.series.map((values, i) => ({
      type: 'scatter' as const,
      name: data.legends[i] || `Series ${i + 1}`,
      data: values.map((y, j) => {
        const xRow = Array.isArray(xSeries[i]) ? xSeries[i] : undefined
        let x = j + 1
        if (xRow && j < xRow.length) {
          const parsed = Number(xRow[j])
          if (!isNaN(parsed)) x = parsed
        } else if (j < data.labels.length) {
          const parsed = Number(data.labels[j])
          if (!isNaN(parsed)) x = parsed
        }
        return [x, y]
      }),
      showSymbol: true,
      symbolSize: smoothScatter ? 8 : 6,
      ...(showDataLabel
        ? {
            label: {
              show: true,
              formatter: (p: { value?: unknown }) => {
                const value = Array.isArray(p?.value) ? p.value[1] : p?.value
                return value === null || value === undefined ? '' : String(value)
              },
              ...(textColor ? { color: textColor } : {}),
            },
          }
        : {}),
    }))

    const showLegendScatter = options?.showLegend ?? (data.legends.length > 1)
    if (showLegendScatter) {
      base.legend = {
        show: true,
        data: data.legends,
        ...legendPosToECharts(options?.legendPosition),
        ...(textColor ? { textStyle: { color: textColor } } : {}),
      }
    }
  } else {
    const echartsType = chartType === 'area' ? 'line' : chartType === 'column' ? 'bar' : chartType
    const canStack = chartType === 'bar' || chartType === 'column' || chartType === 'line' || chartType === 'area'
    const canSmooth = chartType === 'line' || chartType === 'area'

    const axisLabelStyle = textColor ? { axisLabel: { color: textColor }, axisLine: { lineStyle: { color: gridColor || textColor } } } : {}
    const splitLineStyle = gridColor ? { splitLine: { lineStyle: { color: gridColor } } } : {}

    if (chartType === 'column') {
      base.xAxis = { type: 'value' as const, ...axisLabelStyle, ...splitLineStyle }
      base.yAxis = { type: 'category' as const, data: data.labels, ...axisLabelStyle }
    } else {
      base.xAxis = { type: 'category' as const, data: data.labels, ...axisLabelStyle }
      base.yAxis = { type: 'value' as const, ...axisLabelStyle, ...splitLineStyle }
    }

    const showDataLabel = options?.showDataLabel === true
    const isStacked = canStack && !!options?.stack
    base.series = data.series.map((values, i) => ({
      type: echartsType,
      name: data.legends[i] || `Series ${i + 1}`,
      data: values,
      smooth: canSmooth ? (options?.lineSmooth ?? false) : undefined,
      stack: isStacked ? 'total' : undefined,
      ...(chartType === 'area' ? { areaStyle: {} } : {}),
      ...(showDataLabel
        ? {
            label: {
              show: true,
              position: isStacked ? 'inside' : (chartType === 'column' ? 'right' : 'top'),
              ...(textColor ? { color: textColor } : {}),
            },
          }
        : {}),
    }))

    const showLegend = options?.showLegend ?? (data.legends.length > 1)
    if (showLegend) {
      base.legend = {
        show: true,
        data: data.legends,
        ...legendPosToECharts(options?.legendPosition),
        ...(textColor ? { textStyle: { color: textColor } } : {}),
      }
    }
  }

  return base
}
