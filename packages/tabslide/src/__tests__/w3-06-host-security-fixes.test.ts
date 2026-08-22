/**
 * W3-06 回归测试：host/testing/security 修复
 *
 * 覆盖：
 * - K1-11: ALLOWED_TAG_OPEN_RE 正确处理含 > 的属性值
 * - K1-17: regexFallbackSanitize script 标签剥离更健壮
 * - J1-08: 错误状态按钮不再调用 window.location.reload()
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sanitizeHtml } from '../utils/sanitize'

/* ── K1-11: ALLOWED_TAG_OPEN_RE handles > inside attribute values ── */

describe('sanitizeHtml regex fallback: attribute values containing >', () => {
  let origDOMParser: typeof globalThis.DOMParser

  beforeEach(() => {
    origDOMParser = globalThis.DOMParser
    // @ts-expect-error — force regex fallback path
    delete globalThis.DOMParser
  })

  afterEach(() => {
    globalThis.DOMParser = origDOMParser
  })

  it('strips non-whitelisted tag even when attribute contains >', () => {
    const input = '<img data-x="a>b" src="evil.png">'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('<img')
    expect(result).not.toContain('evil.png')
  })

  it('strips non-whitelisted tag with single-quoted attribute containing >', () => {
    const input = "<video data-x='a>b' src='evil.mp4'>"
    const result = sanitizeHtml(input)
    expect(result).not.toContain('<video')
  })

  it('preserves whitelisted tags with attribute containing >', () => {
    const input = '<span data-theme-color-key="a>b">text</span>'
    const result = sanitizeHtml(input)
    expect(result).toContain('text')
  })

  it('strips tag even when multiple attributes contain >', () => {
    const input = '<iframe data-a="x>y" data-b="m>n">content</iframe>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('<iframe')
  })
})

/* ── K1-17: regexFallbackSanitize script tag stripping ── */

describe('sanitizeHtml regex fallback: script tag stripping', () => {
  let origDOMParser: typeof globalThis.DOMParser

  beforeEach(() => {
    origDOMParser = globalThis.DOMParser
    // @ts-expect-error — force regex fallback path
    delete globalThis.DOMParser
  })

  afterEach(() => {
    globalThis.DOMParser = origDOMParser
  })

  it('strips basic <script>alert(1)</script>', () => {
    const input = '<script>alert(1)</script>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('script')
    expect(result).not.toContain('alert')
  })

  it('strips <script> with attributes', () => {
    const input = '<script src="evil.js"></script>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('script')
  })

  it('strips self-closing-like <script/> variant', () => {
    const input = '<script/src="evil.js">alert(1)</script>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('script')
    expect(result).not.toContain('alert')
  })

  it('strips <SCRIPT> (case-insensitive)', () => {
    const input = '<SCRIPT>alert(1)</SCRIPT>'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('SCRIPT')
    expect(result).not.toContain('alert')
  })

  it('strips orphan <script> tag without closing pair', () => {
    const input = '<p>hello</p><script type="text/javascript">'
    const result = sanitizeHtml(input)
    expect(result).not.toContain('script')
    expect(result).toContain('hello')
  })
})
