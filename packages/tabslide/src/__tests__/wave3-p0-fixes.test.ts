/**
 * Regression tests for Wave 3 P0 fixes:
 * - P0-01/P0-02: shadow/colorMask alpha preservation
 * - P0-04: video element color collection dead code removal
 * - P0-05: Canvas fallback black-equivalent parsing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  parseColorToHex,
  normalizeHex,
  parseOpacity,
} from '../panels/right-sidebar/shared/color-utils'

import {
  extractColorAlpha,
  colorWithAlpha,
  toColorInputHex,
} from '../panels/right-sidebar/shared/constants'

import { collectElementColors } from '../panels/right-sidebar/shared/usePresentationColors'
import type { PPTElement } from '../types/slides'

/* ── P0-01 / P0-02: alpha round-trip preservation ── */

describe('extractColorAlpha + colorWithAlpha round-trip', () => {
  it('preserves alpha from rgba string', () => {
    const original = 'rgba(0,0,0,0.15)'
    const alpha = extractColorAlpha(original)
    expect(alpha).toBeCloseTo(0.15)

    const hex = toColorInputHex(original)
    expect(hex).toBe('#000000')

    const reconstructed = colorWithAlpha(hex, alpha)
    expect(reconstructed).toBe('rgba(0,0,0,0.15)')
  })

  it('preserves alpha=0.2 for default colorMask', () => {
    const original = 'rgba(0,0,0,0.2)'
    const alpha = extractColorAlpha(original)
    const hex = toColorInputHex(original)
    const reconstructed = colorWithAlpha(hex, alpha)
    expect(reconstructed).toBe('rgba(0,0,0,0.2)')
  })

  it('returns alpha=1 for plain hex', () => {
    expect(extractColorAlpha('#ff0000')).toBe(1)
  })

  it('colorWithAlpha with alpha=1 returns plain hex', () => {
    expect(colorWithAlpha('#ff0000', 1)).toBe('#ff0000')
  })

  it('handles 8-digit hex alpha', () => {
    const alpha = extractColorAlpha('#ff000080')
    expect(alpha).toBeCloseTo(0.5, 1)
  })

  it('handles user changing color while preserving alpha', () => {
    const original = 'rgba(0,0,0,0.3)'
    const alpha = extractColorAlpha(original)
    const newHex = '#ff6600'
    const result = colorWithAlpha(newHex, alpha)
    expect(result).toBe('rgba(255,102,0,0.3)')
  })
})

/* ── P0-04: video element color collection ── */

describe('collectElementColors: video element', () => {
  const makeVideoEl = (overrides?: Partial<PPTElement>): PPTElement => ({
    id: 'v1',
    type: 'video',
    x: 0, y: 0, width: 100, height: 100, rotate: 0, opacity: 1,
    locked: false,
    src: 'https://example.com/video.mp4',
    autoplay: false,
    ...overrides,
  } as PPTElement)

  it('does not add any colors for a plain video element', () => {
    const set = new Set<string>()
    collectElementColors(makeVideoEl(), set)
    expect(set.size).toBe(0)
  })

  it('does not add undefined or null to color set', () => {
    const set = new Set<string>()
    collectElementColors(makeVideoEl({ poster: 'thumb.png' } as Partial<PPTElement>), set)
    expect(set.has('undefined')).toBe(false)
    expect(set.has('null')).toBe(false)
    expect(set.size).toBe(0)
  })

  it('still collects outline color from video element', () => {
    const set = new Set<string>()
    const el = { ...makeVideoEl(), outline: { color: '#ff0000', width: 1, style: 'solid' } } as unknown as PPTElement
    collectElementColors(el, set)
    expect(set.has('#ff0000')).toBe(true)
  })

  it('still collects shadow color from video element', () => {
    const set = new Set<string>()
    const el = { ...makeVideoEl(), shadow: { color: '#00ff00', h: 1, v: 1, blur: 5 } } as unknown as PPTElement
    collectElementColors(el, set)
    expect(set.has('#00ff00')).toBe(true)
  })
})

/* ── P0-05: parseColorToHex black equivalents ── */

describe('parseColorToHex: black-equivalent colors', () => {
  it('parses rgb(0,0,0) to #000000', () => {
    expect(parseColorToHex('rgb(0,0,0)')).toBe('#000000')
  })

  it('parses rgb(0, 0, 0) with spaces to #000000', () => {
    expect(parseColorToHex('rgb(0, 0, 0)')).toBe('#000000')
  })

  it('parses rgba(0,0,0,1) to #000000', () => {
    expect(parseColorToHex('rgba(0,0,0,1)')).toBe('#000000')
  })

  it('parses  to #000000', () => {
    expect(parseColorToHex('#000')).toBe('#000000')
  })

  it('parses #000000 to #000000', () => {
    expect(parseColorToHex('#000000')).toBe('#000000')
  })

  it('parses standard hex colors', () => {
    expect(parseColorToHex('#ff6600')).toBe('#ff6600')
    expect(parseColorToHex('#abc')).toBe('#aabbcc')
  })

  it('parses rgb() format', () => {
    expect(parseColorToHex('rgb(255, 128, 0)')).toBe('#ff8000')
  })

  it('returns null for empty/invalid input', () => {
    expect(parseColorToHex('')).toBeNull()
    expect(parseColorToHex('not-a-color')).toBeNull()
  })
})

describe('parseColorToHex: canvas fallback with sentinel', () => {
  let origDoc: typeof globalThis.document

  beforeEach(() => {
    origDoc = globalThis.document
    const mockCtx = {
      _fillStyle: '#02fe01',
      get fillStyle() { return this._fillStyle },
      set fillStyle(v: string) {
        if (v === '#02fe01' || v === 'rgb(2, 254, 1)') {
          this._fillStyle = '#02fe01'
          return
        }
        if (v === 'black' || v === 'hsl(0, 0%, 0%)' || v === 'hsl(0,0%,0%)') {
          this._fillStyle = '#000000'
          return
        }
        if (v === 'red') {
          this._fillStyle = '#ff0000'
          return
        }
        if (v === 'invalidcolor123') {
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

  it('parses "black" via canvas fallback to #000000', () => {
    expect(parseColorToHex('black')).toBe('#000000')
  })

  it('parses hsl(0,0%,0%) via canvas fallback to #000000', () => {
    expect(parseColorToHex('hsl(0, 0%, 0%)')).toBe('#000000')
  })

  it('parses "red" via canvas fallback', () => {
    expect(parseColorToHex('red')).toBe('#ff0000')
  })

  it('returns null for truly invalid color', () => {
    expect(parseColorToHex('invalidcolor123')).toBeNull()
  })
})
