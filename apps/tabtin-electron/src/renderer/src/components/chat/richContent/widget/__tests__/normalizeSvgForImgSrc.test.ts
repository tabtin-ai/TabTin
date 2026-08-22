import { describe, expect, it } from 'vitest'
import { capDisplayWidth, normalizeSvgForImgSrc } from '../normalizeSvgForImgSrc'

describe('normalizeSvgForImgSrc', () => {
  it('用 viewBox 覆盖百分比宽高，并补 preserveAspectRatio', () => {
    const raw = '<svg width="100%" height="100%" viewBox="0 0 400 500"><circle r="10"/></svg>'
    const result = normalizeSvgForImgSrc(raw)
    expect(result).not.toBeNull()
    expect(result!.width).toBe(400)
    expect(result!.height).toBe(500)
    expect(result!.code).toContain('width="400"')
    expect(result!.code).toContain('height="500"')
    expect(result!.code).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(result!.code).not.toContain('width="100%"')
  })

  it('去掉 preserveAspectRatio=none', () => {
    const raw = '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect/></svg>'
    const result = normalizeSvgForImgSrc(raw)
    expect(result!.code).not.toMatch(/preserveAspectRatio="none"/)
    expect(result!.code).toContain('preserveAspectRatio="xMidYMid meet"')
  })

  it('capDisplayWidth 只缩宽度并等比高度', () => {
    expect(capDisplayWidth(800, 1000, 560)).toEqual({ width: 560, height: 700 })
    expect(capDisplayWidth(400, 500, 560)).toEqual({ width: 400, height: 500 })
  })
})
