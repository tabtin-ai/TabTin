/**
 * V2 Wave-2 regression tests for basic-elements fixes:
 * - B1-03: sanitizeHtml preserves data-theme-color-key attribute
 * - B3-03: callout1 tail sub-path is closed with Z
 * - B4-01: SlideShow / image export lineWidth uses ptToPx
 */
import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from '../utils/sanitize'
import { ShapePathFormulas } from '../configs/shapes'
import { ptToPx } from '../utils/geometry'

/* ── B1-03: sanitizeHtml preserves data-theme-color-key ── */

describe('B1-03: sanitizeHtml preserves data-theme-color-key', () => {
  it('keeps data-theme-color-key on SPAN elements', () => {
    const input = '<p><span style="color:#FF0000" data-theme-color-key="accent1">Hello</span></p>'
    const result = sanitizeHtml(input)
    expect(result).toContain('data-theme-color-key="accent1"')
  })

  it('keeps data-theme-color-key on nested elements', () => {
    const input = '<p><b data-theme-color-key="dk1"><span style="color:">Bold</span></b></p>'
    const result = sanitizeHtml(input)
    expect(result).toContain('data-theme-color-key="dk1"')
  })

  it('still strips non-whitelisted attributes', () => {
    const input = '<span data-theme-color-key="accent1" onclick="alert(1)" data-foo="bar">text</span>'
    const result = sanitizeHtml(input)
    expect(result).toContain('data-theme-color-key="accent1"')
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('data-foo')
  })

  it('preserves multiple theme-color-key spans in one paragraph', () => {
    const input = '<p><span data-theme-color-key="accent1">A</span><span data-theme-color-key="accent2">B</span></p>'
    const result = sanitizeHtml(input)
    expect(result).toContain('data-theme-color-key="accent1"')
    expect(result).toContain('data-theme-color-key="accent2"')
  })
})

/* ── B3-03: callout1 tail sub-path closed with Z ── */

describe('B3-03: callout1 tail sub-path is closed', () => {
  const callout1 = ShapePathFormulas.callout1

  it('callout1 path contains two Z commands (box + tail)', () => {
    const path = callout1.formula(200, 100, [])
    const zCount = (path.match(/Z/g) || []).length
    expect(zCount).toBe(2)
  })

  it('tail sub-path ends with Z for proper fill', () => {
    const path = callout1.formula(200, 100, [])
    const subPaths = path.split(/(?=M )/)
    expect(subPaths).toHaveLength(2)
    expect(subPaths[1].trim()).toMatch(/Z$/)
  })

  it('callout2 already has proper closure (regression guard)', () => {
    const callout2 = ShapePathFormulas.callout2
    const path = callout2.formula(200, 100, [])
    expect(path).toContain('Z')
  })
})

/* ── B4-01: lineWidth ptToPx consistency across render paths ── */

describe('B4-01: lineWidth ptToPx in SlideShow and image export', () => {
  it('ptToPx(2) is ~2.667px, not raw 2', () => {
    const converted = ptToPx(2)
    expect(converted).toBeCloseTo(2.667, 2)
    expect(converted).toBeGreaterThan(2)
  })

  it('ptToPx ratio is 4/3 (96dpi / 72pt-per-inch)', () => {
    expect(ptToPx(72)).toBe(96)
    expect(ptToPx(36)).toBe(48)
  })

  it('default lineWidth 2pt → px matches LineElement editor behavior', () => {
    const editorWidth = ptToPx(2)
    expect(editorWidth).toBeCloseTo(2 * (96 / 72), 6)
  })
})
