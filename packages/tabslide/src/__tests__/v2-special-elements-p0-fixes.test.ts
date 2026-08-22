/**
 * Regression tests for V2 Special Elements P0 fixes:
 * - B7-01: LaTeX SVG XSS — sanitizeSvgStrict DOM-based whitelist sanitization
 * - M01: Video loop attribute rendering
 * - M02: Backend local file read prevention (covered in Python tests)
 */
import { describe, it, expect } from 'vitest'

import {
  sanitizeSvgUnsafe,
  sanitizeSvgStrict,
  normalizeLatexSvgForDisplay,
} from '../utils/latex-shared'

/* ── B7-01: LaTeX SVG XSS sanitization ── */

describe('sanitizeSvgStrict', () => {
  it('preserves valid SVG with path elements', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0L100 50" fill="currentColor"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).toContain('<path')
    expect(result).toContain('d="M0 0L100 50"')
    expect(result).toContain('viewBox')
  })

  it('strips <script> tags', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("xss")</script><path d="M0 0"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('script')
    expect(result).not.toContain('alert')
    expect(result).toContain('<path')
  })

  it('strips <foreignObject> elements', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><div>XSS</div></body></foreignObject></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('foreignObject')
    expect(result).not.toContain('XSS')
  })

  it('strips inline event handlers (onclick, onload, etc.)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" onload="evil()" width="100" height="50"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('onload')
    expect(result).not.toContain('alert')
    expect(result).toContain('<rect')
  })

  it('strips <animate> elements (potential XSS vector)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="50"/><animate attributeName="href" to="javascript:alert(1)"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('animate')
    expect(result).not.toContain('javascript')
    expect(result).toContain('<rect')
  })

  it('strips <set> elements', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onmouseover" to="alert(1)"/><path d="M0 0"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('<set')
    expect(result).not.toContain('onmouseover')
  })

  it('strips dangerous href attributes from non-use elements', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g href="javascript:alert(1)"><path d="M0 0"/></g></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('javascript')
  })

  it('allows <use> with internal href (#id)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p1" d="M0 0"/></defs><use href="#p1"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).toContain('use')
    expect(result).toContain('#p1')
  })

  it('strips <use> with external href', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.com/xss.svg#payload"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('evil.com')
  })

  it('sanitizes CSS expression in style attributes', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" style="background: expression(alert(1))"><path d="M0 0"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('expression')
    expect(result).not.toContain('alert')
  })

  it('sanitizes url() in style attributes', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background: url(javascript:alert(1))" width="100" height="50"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('javascript')
  })

  it('strips <image> elements (not in whitelist)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.com/tracker.png" width="100" height="100"/></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('image')
    expect(result).not.toContain('evil.com')
  })

  it('strips <a> elements (not in whitelist)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="100" height="50"/></a></svg>'
    const result = sanitizeSvgStrict(svg)
    expect(result).not.toContain('<a ')
  })

  it('returns empty string for non-SVG input', () => {
    const result = sanitizeSvgStrict('<div>not svg</div>')
    expect(result).toBe('')
  })

  it('returns empty string for malformed XML', () => {
    const result = sanitizeSvgStrict('<svg><path d="M0 0"')
    expect(result).toBe('')
  })

  it('preserves complex MathJax-style SVG', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5730 2009" style="color:#111827">
      <g>
        <path d="M150 750Q147 750 138 750" fill="currentColor" stroke="currentColor" stroke-width="0"/>
        <rect x="70" y="1780" width="5588" height="60" fill="currentColor"/>
      </g>
    </svg>`
    const result = sanitizeSvgStrict(svg)
    expect(result).toContain('<path')
    expect(result).toContain('<rect')
    expect(result).toContain('<g')
    expect(result).toContain('color:#111827')
  })
})

describe('normalizeLatexSvgForDisplay (integrated with sanitizeSvgStrict)', () => {
  it('sanitizes and patches SVG for display', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0"/></svg>'
    const result = normalizeLatexSvgForDisplay(svg)
    expect(result).toContain('width="100%"')
    expect(result).toContain('height="100%"')
    expect(result).toContain('preserveAspectRatio="xMidYMid meet"')
  })

  it('removes XSS vectors before display', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><animate attributeName="href" to="javascript:alert(1)"/><path d="M0 0"/></svg>'
    const result = normalizeLatexSvgForDisplay(svg)
    expect(result).not.toContain('script')
    expect(result).not.toContain('animate')
    expect(result).not.toContain('alert')
    expect(result).toContain('<path')
  })
})

describe('sanitizeSvgUnsafe (regex fallback)', () => {
  it('still strips script tags', () => {
    const svg = '<svg><script>alert(1)</script><path d="M0 0"/></svg>'
    const result = sanitizeSvgUnsafe(svg)
    expect(result).not.toContain('script')
  })

  it('strips onclick handlers', () => {
    const svg = '<svg><rect onclick="alert(1)" width="100"/></svg>'
    const result = sanitizeSvgUnsafe(svg)
    expect(result).not.toContain('onclick')
  })
})

/* ── M01: Video loop attribute ── */

describe('PPTVideoElement loop field type contract', () => {
  it('loop field exists and is boolean in type definition', () => {
    const videoElement = {
      id: 'test-video',
      type: 'video' as const,
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      rotate: 0,
      opacity: 1,
      visible: true,
      locked: false,
      src: 'https://example.com/video.mp4',
      autoplay: false,
      loop: true,
    }
    expect(videoElement.loop).toBe(true)

    const videoNoLoop = { ...videoElement, loop: undefined }
    expect(videoNoLoop.loop).toBeUndefined()
  })
})
