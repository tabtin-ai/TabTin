/**
 * Regression tests for W3 Special Elements fixes:
 * P1: M05, M04, B7-02, B7-08, M06
 * P2: B5-V2-06, B7-14, M12
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { encodeLatexMetadata, decodeLatexMetadata } from '../utils/latex-shared'

const POSTPROCESS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../exports/pptx-postprocess.ts'),
  'utf-8',
)

const PPTX_SRC = fs.readFileSync(
  path.resolve(__dirname, '../exports/pptx.ts'),
  'utf-8',
)

const CHART_OPTION_SRC = fs.readFileSync(
  path.resolve(__dirname, '../utils/chart-option.ts'),
  'utf-8',
)

/* ═══════════════════════════════════════════ P1 ═══════════════════════════════════════════ */

/* ── M05: encodeMediaAltText encodes loop for video (not just audio) ── */

describe('M05: encodeMediaAltText encodes video loop', () => {
  it('encodeMediaAltText sets loop at top level (before audio-specific branch)', () => {
    const fnMatch = POSTPROCESS_SRC.match(
      /function encodeMediaAltText[\s\S]*?^}/m,
    )
    expect(fnMatch).toBeTruthy()
    const fnBody = fnMatch![0]

    const loopBeforeAudioCheck = fnBody.indexOf('loop')
    const audioTypeCheck = fnBody.indexOf("meta.type === 'audio'")
    expect(loopBeforeAudioCheck).toBeLessThan(audioTypeCheck)
  })

  it('loop is in the shared payload, not gated by audio type', () => {
    const payloadBlock = POSTPROCESS_SRC.match(
      /const payload[\s\S]*?autoplay[\s\S]*?loop[\s\S]*?\}/,
    )
    expect(payloadBlock).toBeTruthy()
    const payloadStr = payloadBlock![0]
    expect(payloadStr).not.toContain("meta.type === 'audio'")
  })
})

/* ── M04: normalizeMediaCoverData supports HTTP(S) URLs ── */

describe('M04: normalizeMediaCoverData HTTP poster support', () => {
  it('normalizeMediaCoverData handles https:// URLs', () => {
    expect(PPTX_SRC).toMatch(/normalizeMediaCoverData[\s\S]*?https\?:/)
  })

  it('still handles base64 data URLs', () => {
    const fnMatch = PPTX_SRC.match(
      /function normalizeMediaCoverData[\s\S]*?^}/m,
    )
    expect(fnMatch).toBeTruthy()
    expect(fnMatch![0]).toContain('parseBase64DataUrl')
  })
})

/* ── B7-02: encodeLatexMetadata no longer appends "..." to truncated LaTeX ── */

describe('B7-02: encodeLatexMetadata truncation no longer corrupts LaTeX', () => {
  it('does not append literal "..." to truncated LaTeX', () => {
    const result = encodeLatexMetadata({
      latex: 'x'.repeat(30000),
      color: '#111111',
    })
    const decoded = decodeLatexMetadata(result)
    expect(decoded).toBeTruthy()
    expect(decoded!.latex).not.toContain('...')
  })

  it('short LaTeX is preserved intact', () => {
    const latex = '\\frac{a}{b}'
    const result = encodeLatexMetadata({ latex, color: '#000' })
    const decoded = decodeLatexMetadata(result)
    expect(decoded!.latex).toBe(latex)
  })

  it('preserves color/strokeWidth in truncation path', () => {
    const result = encodeLatexMetadata({
      latex: 'x'.repeat(30000),
      color: '#ff0000',
      strokeWidth: 2,
    })
    const decoded = decodeLatexMetadata(result)
    expect(decoded!.color).toBe('#ff0000')
    expect(decoded!.strokeWidth).toBe(2)
  })
})

/* ── B7-08: Backend altText override (structural check) ── */

describe('B7-08: Backend LaTeX altText override logic', () => {
  it('pptx_io checks for TABSLIDE_LATEX_V1 prefix before skipping', () => {
    const pptxIoSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../../apps/tabtin_django/apps/tabslide/services/pptx_io.py'),
      'utf-8',
    )
    expect(pptxIoSrc).toContain('LATEX_META_PREFIX')
    expect(pptxIoSrc).toContain('has_latex_meta')
    expect(pptxIoSrc).toMatch(/has_latex_meta.*startswith.*LATEX_META_PREFIX/)
  })
})

/* ═══════════════════════════════════════════ P2 ═══════════════════════════════════════════ */

/* ── B5-V2-06: RGBA_COLOR_REG rejects multi-dot alpha ── */

describe('B5-V2-06: RGBA_COLOR_REG rejects invalid alpha', () => {
  it('regex does not use bare [\\d.]+  for alpha', () => {
    const rgbaReg = CHART_OPTION_SRC.match(/RGBA_COLOR_REG\s*=\s*(.+)/)
    expect(rgbaReg).toBeTruthy()
    expect(rgbaReg![1]).not.toContain('[\\d.]+')
  })

  it('regex uses proper decimal pattern for alpha', () => {
    const rgbaReg = CHART_OPTION_SRC.match(/RGBA_COLOR_REG\s*=\s*\/(.+)\//)
    expect(rgbaReg).toBeTruthy()
    const regexStr = rgbaReg![1]
    expect(regexStr).toMatch(/\\d\+\\\.\?\\d\*|\\\.\\d\+/)
  })
})

/* ── B7-14: decodeLatexMetadata viewBox NaN/Infinity validation ── */

describe('B7-14: decodeLatexMetadata validates viewBox values', () => {
  it('rejects NaN viewBox', () => {
    const encoded = encodeLatexMetadata({
      latex: 'x',
      viewBox: [NaN, 100],
    })
    const decoded = decodeLatexMetadata(encoded)
    expect(decoded).toBeTruthy()
    expect(decoded!.viewBox).toBeUndefined()
  })

  it('rejects Infinity viewBox', () => {
    const encoded = encodeLatexMetadata({
      latex: 'x',
      viewBox: [100, Infinity],
    })
    const decoded = decodeLatexMetadata(encoded)
    expect(decoded).toBeTruthy()
    expect(decoded!.viewBox).toBeUndefined()
  })

  it('rejects zero viewBox', () => {
    const encoded = encodeLatexMetadata({
      latex: 'x',
      viewBox: [0, 100],
    })
    const decoded = decodeLatexMetadata(encoded)
    expect(decoded).toBeTruthy()
    expect(decoded!.viewBox).toBeUndefined()
  })

  it('accepts valid viewBox', () => {
    const encoded = encodeLatexMetadata({
      latex: 'x',
      viewBox: [200, 50],
    })
    const decoded = decodeLatexMetadata(encoded)
    expect(decoded).toBeTruthy()
    expect(decoded!.viewBox).toEqual([200, 50])
  })
})

/* ── M12: Preview HTML video loop attribute ── */

describe('M12: Preview video element includes loop attribute', () => {
  it('_render_video_element reads loop from element', () => {
    const previewSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../../apps/tabtin_django/apps/tabslide/services/preview_service.py'),
      'utf-8',
    )
    const videoFn = previewSrc.match(
      /def _render_video_element[\s\S]*?(?=\ndef |\Z)/,
    )
    expect(videoFn).toBeTruthy()
    expect(videoFn![0]).toContain('loop')
    expect(videoFn![0]).toMatch(/loop_attr.*loop/)
  })
})
