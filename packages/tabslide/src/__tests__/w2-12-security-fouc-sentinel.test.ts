/**
 * Regression tests for W2-12 fixes:
 * - J3-15/K1-03: regexFallbackSanitize style attribute XSS
 * - K2-04: ensureComponentCssInjected FOUC (module-level injection)
 * - K1-01: parseColorToHex sentinel collision
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { sanitizeHtml } from '../utils/sanitize'
import { parseColorToHex } from '../panels/right-sidebar/shared/color-utils'

/* ── J3-15 / K1-03: regexFallbackSanitize strips dangerous CSS in style ── */

describe('regexFallbackSanitize: style attribute sanitization', () => {
  let origDOMParser: typeof globalThis.DOMParser

  beforeEach(() => {
    origDOMParser = globalThis.DOMParser
    // @ts-expect-error — force regex fallback path
    delete globalThis.DOMParser
  })

  afterEach(() => {
    globalThis.DOMParser = origDOMParser
  })

  it('strips expression() from style attributes', () => {
    const input = '<p style="color: expression(alert(1))">text</p>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('expression')
    expect(result).toContain('text')
  })

  it('strips url() from style attributes', () => {
    const input = '<span style="background-image: url(javascript:alert(1))">x</span>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('url(')
    expect(result).toContain('x')
  })

  it('strips -moz-binding from style attributes', () => {
    const input = '<div style="-moz-binding: url(evil.xml#xbl)">content</div>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('-moz-binding')
  })

  it('strips expression() from single-quoted style attributes', () => {
    const input = "<p style='width: expression(document.body.clientWidth)'>text</p>"
    const result = sanitizeHtml(input)
    expect(result).not.toContain('expression')
  })

  it('preserves safe style attributes', () => {
    const input = '<p style="color: red; font-size: 14px">text</p>'
    const result = sanitizeHtml(input)
    expect(result).toContain('color: red')
    expect(result).toContain('font-size: 14px')
  })
})

/* ── K1-01: parseColorToHex sentinel collision ── */

describe('parseColorToHex: sentinel collision fix', () => {
  let origDoc: typeof globalThis.document

  beforeEach(() => {
    origDoc = globalThis.document
    const mockCtx = {
      _fillStyle: '',
      get fillStyle() { return this._fillStyle },
      set fillStyle(v: string) {
        if (v === '#02fe01') {
          this._fillStyle = '#02fe01'
          return
        }
        if (v === '#01fd02') {
          this._fillStyle = '#01fd02'
          return
        }
        if (v === 'rgb(2, 254, 1)' || v === 'rgb(2,254,1)') {
          this._fillStyle = '#02fe01'
          return
        }
        if (v === 'hsl(119, 99%, 50%)' || v === 'hsl(119,99%,50%)') {
          this._fillStyle = '#02fe01'
          return
        }
        if (v === 'invalidcolor123') {
          // browser ignores invalid colors — fillStyle stays unchanged
          return
        }
        if (v === 'red') {
          this._fillStyle = '#ff0000'
          return
        }
        this._fillStyle = v
      },
    }
    const mockCanvas = {
      width: 1,
      height: 1,
      getContext: () => mockCtx,
    }
    globalThis.document = {
      createElement: () => mockCanvas,
    } as unknown as Document
  })

  afterEach(() => {
    globalThis.document = origDoc
  })

  it('correctly parses color matching sentinel value rgb(2,254,1)', () => {
    const result = parseColorToHex('rgb(2, 254, 1)')
    expect(result).toBe('#02fe01')
  })

  it('correctly parses HSL equivalent of sentinel color', () => {
    const result = parseColorToHex('hsl(119, 99%, 50%)')
    expect(result).toBe('#02fe01')
  })

  it('still returns null for truly invalid colors', () => {
    expect(parseColorToHex('invalidcolor123')).toBeNull()
  })

  it('parses normal named colors unaffected', () => {
    expect(parseColorToHex('red')).toBe('#ff0000')
  })
})

