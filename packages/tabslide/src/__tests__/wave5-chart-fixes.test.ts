/**
 * Regression tests for Wave 5 chart fixes:
 * - B5-01: scatter chart with smoothScatter keeps type='scatter' (not 'line')
 * - B5-02: front-end PPTX export emits radarStyle='filled' for radarFilled radar charts
 * - B5-03: ChartEditor data inputs use debounced onChange + onBlur flush
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { buildChartOption, resolvePalette } from '../utils/chart-option'
import type { PPTChartElement, ChartData } from '../types/slides'

function makeChartElement(overrides?: Partial<PPTChartElement>): PPTChartElement {
  return {
    id: 'chart-1',
    type: 'chart',
    chartType: 'bar',
    x: 100,
    y: 100,
    width: 600,
    height: 400,
    rotate: 0,
    opacity: 1,
    locked: false,
    data: {
      labels: ['A', 'B', 'C'],
      legends: ['Series 1'],
      series: [[10, 20, 30]],
    },
    themeColors: ['#5470c6'],
    ...overrides,
  }
}

/* ── B5-01: scatter + smoothScatter always uses type='scatter' ── */

describe('B5-01: scatter chart smoothScatter type preservation', () => {
  it('generates type=scatter when smoothScatter is false', () => {
    const el = makeChartElement({
      chartType: 'scatter',
      options: { lineSmooth: false },
      data: {
        labels: ['1', '2', '3'],
        legends: ['S1'],
        series: [[10, 20, 30]],
      },
    })
    const option = buildChartOption(el)
    const series = option.series as Array<{ type: string }>
    expect(series).toHaveLength(1)
    expect(series[0].type).toBe('scatter')
  })

  it('generates type=scatter (NOT line) when smoothScatter is true', () => {
    const el = makeChartElement({
      chartType: 'scatter',
      options: { lineSmooth: true },
      data: {
        labels: ['1', '2', '3'],
        legends: ['S1'],
        series: [[10, 20, 30]],
      },
    })
    const option = buildChartOption(el)
    const series = option.series as Array<{ type: string; smooth?: boolean; symbolSize: number }>
    expect(series).toHaveLength(1)
    expect(series[0].type).toBe('scatter')
    expect(series[0].symbolSize).toBe(8)
  })

  it('does not set smooth property on scatter series (ECharts scatter ignores it)', () => {
    const el = makeChartElement({
      chartType: 'scatter',
      options: { lineSmooth: true },
      data: {
        labels: ['1', '2', '3'],
        legends: ['S1'],
        series: [[10, 20, 30]],
      },
    })
    const option = buildChartOption(el)
    const series = option.series as Array<{ smooth?: boolean }>
    expect(series[0]).not.toHaveProperty('smooth')
  })
})

/* ── B5-02: PPTX export radarFilled → radarStyle='filled' ── */

describe('B5-02: PPTX export radarFilled support', () => {
  const PPTX_SRC = fs.readFileSync(
    path.resolve(__dirname, '../exports/pptx.ts'),
    'utf-8',
  )

  it('addChartElement sets radarStyle=filled when radarFilled is true', () => {
    expect(PPTX_SRC).toContain("radarStyle = 'filled'")
  })

  it('radarStyle is only applied for radar chartType', () => {
    const radarFilledBlock = PPTX_SRC.match(
      /chartType === 'radar' && options\?\.radarFilled/,
    )
    expect(radarFilledBlock).toBeTruthy()
  })
})

/* ── B5-03: ChartEditor debounced input commit ── */

describe('B5-03: ChartEditor debounced input commit', () => {
  const STYLE_EDITOR_SRC = fs.readFileSync(
    path.resolve(__dirname, '../panels/right-sidebar/editors/style-editor/index.tsx'),
    'utf-8',
  )

  it('uses debouncedCommitChartData on onChange for labels input', () => {
    expect(STYLE_EDITOR_SRC).toMatch(
      /setLabelsInput\(e\.target\.value\).*debouncedCommitChartData\(\)/s,
    )
  })

  it('uses debouncedCommitChartData on onChange for legends input', () => {
    expect(STYLE_EDITOR_SRC).toMatch(
      /setLegendsInput\(e\.target\.value\).*debouncedCommitChartData\(\)/s,
    )
  })

  it('uses debouncedCommitChartData on onChange for series textarea', () => {
    expect(STYLE_EDITOR_SRC).toMatch(
      /setSeriesInput\(e\.target\.value\).*debouncedCommitChartData\(\)/s,
    )
  })

  it('uses debouncedCommitChartData on onChange for xSeries textarea', () => {
    expect(STYLE_EDITOR_SRC).toMatch(
      /setXSeriesInput\(e\.target\.value\).*debouncedCommitChartData\(\)/s,
    )
  })

  it('uses flushAndCommit as onBlur handler for all data inputs', () => {
    const blurMatches = STYLE_EDITOR_SRC.match(/onBlur=\{flushAndCommit\}/g)
    expect(blurMatches).toBeTruthy()
    expect(blurMatches!.length).toBeGreaterThanOrEqual(4)
  })

  it('debounce timer uses 300ms delay', () => {
    expect(STYLE_EDITOR_SRC).toContain('}, 300)')
  })

  it('flushAndCommit clears pending timer before immediate commit', () => {
    expect(STYLE_EDITOR_SRC).toMatch(
      /flushAndCommit.*clearTimeout\(debounceTimerRef\.current\)/s,
    )
  })
})

/* ── B5-04: normalizePaletteColor 扩展格式支持 ── */

describe('B5-04: resolvePalette color normalization', () => {
  it('resolves standard 6-digit hex colors', () => {
    const result = resolvePalette(['#ff0000', '#00ff00'])
    expect(result[0]).toBe('#ff0000')
    expect(result[1]).toBe('#00ff00')
  })

  it('resolves 3-digit hex shorthand', () => {
    const result = resolvePalette(['#f00'])
    expect(result[0]).toBe('#ff0000')
  })

  it('resolves 8-digit hex (#RRGGBBAA) by stripping alpha', () => {
    const result = resolvePalette(['#ff000080', '#00ff00ff'])
    expect(result[0]).toBe('#ff0000')
    expect(result[1]).toBe('#00ff00')
  })

  it('resolves 8-digit hex without # prefix', () => {
    const result = resolvePalette(['aabbccdd'])
    expect(result[0]).toBe('#aabbcc')
  })

  it('resolves rgba() format', () => {
    const result = resolvePalette(['rgba(255, 0, 0, 0.5)', 'rgba(0, 128, 255, 1)'])
    expect(result[0]).toBe('#ff0000')
    expect(result[1]).toBe('#0080ff')
  })

  it('resolves rgb() format (no alpha)', () => {
    const result = resolvePalette(['rgb(0, 255, 0)'])
    expect(result[0]).toBe('#00ff00')
  })

  it('resolves hsl() format', () => {
    const result = resolvePalette(['hsl(0, 100%, 50%)'])
    expect(result[0]).toBe('#ff0000')
  })

  it('resolves hsla() format by ignoring alpha', () => {
    const result = resolvePalette(['hsla(120, 100%, 50%, 0.5)'])
    expect(result[0]).toBe('#00ff00')
  })

  it('resolves hsl blue correctly', () => {
    const result = resolvePalette(['hsl(240, 100%, 50%)'])
    expect(result[0]).toBe('#0000ff')
  })

  it('falls back to DEFAULT_COLORS when all colors are invalid', () => {
    const result = resolvePalette(['not-a-color', ''])
    expect(result[0]).toBe('#5470c6')
  })

  it('deduplicates colors from different formats', () => {
    const result = resolvePalette(['#ff0000', 'rgb(255, 0, 0)', '#FF0000FF'])
    expect(result.filter((c) => c === '#ff0000')).toHaveLength(1)
  })

  it('clamps rgb values exceeding 255 to ff', () => {
    const result = resolvePalette(['rgb(300, 0, 0)'])
    expect(result[0]).toBe('#ff0000')
  })

  it('rejects rgb with negative values as invalid', () => {
    const result = resolvePalette(['rgb(255, -10, 0)'])
    expect(result[0]).toBe('#5470c6')
  })

  it('mixes hex, rgba, and hsl in one palette', () => {
    const result = resolvePalette([
      '#ff0000',
      'rgba(0, 255, 0, 0.8)',
      'hsl(240, 100%, 50%)',
    ])
    expect(result[0]).toBe('#ff0000')
    expect(result[1]).toBe('#00ff00')
    expect(result[2]).toBe('#0000ff')
  })

  it('preserves theme colors in buildChartOption when using 8-digit hex', () => {
    const el = makeChartElement({
      themeColors: ['#ff000080', '#00ff00ff', '#0000ffcc'],
    })
    const option = buildChartOption(el)
    const colors = option.color as string[]
    expect(colors[0]).toBe('#ff0000')
    expect(colors[1]).toBe('#00ff00')
    expect(colors[2]).toBe('#0000ff')
  })

  it('preserves theme colors in buildChartOption when using rgba', () => {
    const el = makeChartElement({
      themeColors: ['rgba(255, 128, 0, 1)', 'rgba(0, 0, 255, 0.5)'],
    })
    const option = buildChartOption(el)
    const colors = option.color as string[]
    expect(colors[0]).toBe('#ff8000')
    expect(colors[1]).toBe('#0000ff')
  })
})
