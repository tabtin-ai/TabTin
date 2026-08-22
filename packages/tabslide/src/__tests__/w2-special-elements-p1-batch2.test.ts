/**
 * Regression tests for W2 Special Elements P1 fixes (batch 2):
 * - B7-04: LatexPanel SVG preview — use DOM manipulation instead of regex
 * - B7-07: LatexPanel LaTeX input length limit + debounced preview
 * - M05: Video loop field collected in PPTX postprocess mediaMetadata
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const LATEX_PANEL_SRC = fs.readFileSync(
  path.resolve(__dirname, '../toolbar/insert-panels/LatexPanel.tsx'),
  'utf-8',
)

const POSTPROCESS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../exports/pptx-postprocess.ts'),
  'utf-8',
)

/* ── B7-04: LatexPanel SVG attribute injection via DOM ── */

describe('B7-04: LatexPanel SVG preview attribute injection', () => {
  it('uses normalizeSvgForPreview helper (DOM-based) instead of inline regex', () => {
    expect(LATEX_PANEL_SRC).toContain('normalizeSvgForPreview')
  })

  it('normalizeSvgForPreview uses DOMParser for robust SVG manipulation', () => {
    expect(LATEX_PANEL_SRC).toMatch(/new DOMParser\(\)/)
    expect(LATEX_PANEL_SRC).toMatch(/new XMLSerializer\(\)/)
  })

  it('normalizeSvgForPreview removes original attributes via removeAttribute', () => {
    expect(LATEX_PANEL_SRC).toMatch(/removeAttribute\(\s*'width'\s*\)/)
    expect(LATEX_PANEL_SRC).toMatch(/removeAttribute\(\s*'height'\s*\)/)
    expect(LATEX_PANEL_SRC).toMatch(/removeAttribute\(\s*'preserveAspectRatio'\s*\)/)
  })

  it('sets preview attributes to 100% via setAttribute', () => {
    expect(LATEX_PANEL_SRC).toMatch(/setAttribute\(\s*'width'\s*,\s*'100%'\s*\)/)
    expect(LATEX_PANEL_SRC).toMatch(/setAttribute\(\s*'height'\s*,\s*'100%'\s*\)/)
    expect(LATEX_PANEL_SRC).toMatch(/setAttribute\(\s*'preserveAspectRatio'\s*,\s*'xMidYMid meet'\s*\)/)
  })

  it('dangerouslySetInnerHTML calls normalizeSvgForPreview, not inline regex', () => {
    const dangerousLine = LATEX_PANEL_SRC.match(
      /dangerouslySetInnerHTML=\{\{[^}]+\}\}/g,
    )
    expect(dangerousLine).toBeTruthy()
    expect(dangerousLine![0]).toContain('normalizeSvgForPreview')
    expect(dangerousLine![0]).not.toContain('.replace(/<svg')
  })
})

/* ── B7-07: LatexPanel input length limit + debounce ── */

describe('B7-07: LatexPanel input length limit and debounced preview', () => {
  it('defines MAX_LATEX_INPUT constant', () => {
    expect(LATEX_PANEL_SRC).toMatch(/MAX_LATEX_INPUT\s*=\s*\d+/)
  })

  it('MAX_LATEX_INPUT is at most 8192 to prevent UI freeze', () => {
    const match = LATEX_PANEL_SRC.match(/MAX_LATEX_INPUT\s*=\s*(\d+)/)
    expect(match).toBeTruthy()
    const limit = parseInt(match![1], 10)
    expect(limit).toBeLessThanOrEqual(8192)
    expect(limit).toBeGreaterThanOrEqual(1024)
  })

  it('textarea has maxLength prop bound to limit', () => {
    expect(LATEX_PANEL_SRC).toMatch(/maxLength=\{MAX_LATEX_INPUT\}/)
  })

  it('shows character count when approaching limit', () => {
    expect(LATEX_PANEL_SRC).toMatch(/latex\.length\s*>\s*MAX_LATEX_INPUT\s*\*\s*0\.8/)
    expect(LATEX_PANEL_SRC).toMatch(/\{latex\.length\}\s*\/\s*\{MAX_LATEX_INPUT\}/)
  })

  it('uses debounced preview rendering (useEffect + setTimeout) instead of useMemo', () => {
    expect(LATEX_PANEL_SRC).toMatch(/PREVIEW_DEBOUNCE_MS/)
    expect(LATEX_PANEL_SRC).toMatch(/setTimeout\(/)
    expect(LATEX_PANEL_SRC).toMatch(/clearTimeout\(/)
    expect(LATEX_PANEL_SRC).not.toMatch(/useMemo\(\s*\(\)\s*=>\s*\{[\s\S]*?renderLatexToSvg/)
  })
})

/* ── M05: Video loop field in PPTX postprocess metadata ── */

describe('M05: Video loop field in PPTX export postprocess', () => {
  it('video mediaMetadata.push includes loop field', () => {
    const videoBlock = POSTPROCESS_SRC.match(
      /if\s*\(el\.type\s*===\s*'video'\)\s*\{[\s\S]*?info\.mediaMetadata\.push\(\{([\s\S]*?)\}\)/,
    )
    expect(videoBlock).toBeTruthy()
    expect(videoBlock![1]).toContain('loop')
  })

  it('audio mediaMetadata.push also includes loop field (parity check)', () => {
    const audioStart = POSTPROCESS_SRC.indexOf("el.type === 'audio'")
    expect(audioStart).toBeGreaterThan(-1)
    const audioBlock = POSTPROCESS_SRC.slice(audioStart, audioStart + 500)
    expect(audioBlock).toContain('mediaMetadata.push')
    expect(audioBlock).toContain('loop')
  })
})
