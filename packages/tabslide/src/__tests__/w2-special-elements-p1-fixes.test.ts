/**
 * Regression tests for W2 Special Elements P1 fixes:
 * - B5-V2-01: hexToRGB $ anchor — 8-digit hex no longer silently passes
 * - B5-V2-02: hexToRGB HSL/HSLA support
 * - B5-V2-03: addChartElement uses resolvePalette for unified color pipeline
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { resolvePalette } from '../utils/chart-option'

const PPTX_SRC = fs.readFileSync(
  path.resolve(__dirname, '../exports/pptx.ts'),
  'utf-8',
)

/* ── B5-V2-01: hexToRGB regex $ anchor ── */

describe('B5-V2-01: hexToRGB regex anchors', () => {
  it('hexToRGB #RRGGBB regex uses $ end anchor', () => {
    expect(PPTX_SRC).toMatch(/\^#\[0-9a-fA-F\]\{6\}.*\$/)
  })

  it('hexToRGB handles 8-digit hex (#RRGGBBAA) by stripping alpha', () => {
    expect(PPTX_SRC).toContain('[0-9a-fA-F]{2})?$')
  })
})

/* ── B5-V2-02: hexToRGB HSL support ── */

describe('B5-V2-02: hexToRGB HSL/HSLA support', () => {
  it('hexToRGB contains hsl() matching branch', () => {
    expect(PPTX_SRC).toContain("hsla?\\(")
  })

  it('hexToRGB returns uppercase 6-digit hex for all formats', () => {
    expect(PPTX_SRC).toMatch(/\.toUpperCase\(\)/)
  })
})

/* ── B5-V2-03: addChartElement uses resolvePalette ── */

describe('B5-V2-03: addChartElement unified color pipeline', () => {
  it('imports resolvePalette from chart-option', () => {
    expect(PPTX_SRC).toMatch(/import\s*\{[^}]*resolvePalette[^}]*\}\s*from\s*['"]\.\.\/utils\/chart-option['"]/)
  })

  it('addChartElement uses resolvePalette instead of manual hexToRGB mapping', () => {
    const addChartBlock = PPTX_SRC.match(
      /function addChartElement\([\s\S]*?^}/m,
    )
    expect(addChartBlock).toBeTruthy()
    const block = addChartBlock![0]
    expect(block).toContain('resolvePalette(themeColors)')
    expect(block).not.toMatch(/\.map\(\(c\)\s*=>\s*hexToRGB\(c\)\)/)
  })

  it('resolvePalette + strip # produces correct pptxgenjs palette for HSL input', () => {
    const resolved = resolvePalette(['hsl(0, 100%, 50%)', 'hsl(120, 100%, 50%)'])
    const palette = resolved.map((c) => c.replace('#', '').toUpperCase())
    expect(palette[0]).toBe('FF0000')
    expect(palette[1]).toBe('00FF00')
  })

  it('resolvePalette + strip # produces uppercase for rgba input', () => {
    const resolved = resolvePalette(['rgba(0, 128, 255, 0.5)'])
    const palette = resolved.map((c) => c.replace('#', '').toUpperCase())
    expect(palette[0]).toBe('0080FF')
  })
})
