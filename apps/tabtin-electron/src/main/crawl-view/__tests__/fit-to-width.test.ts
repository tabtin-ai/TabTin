import { describe, it, expect } from 'vitest'
import { computeFitZoomFactor } from '../fit-to-width-calc'

describe('computeFitZoomFactor', () => {
  it('固定宽度桌面页在窄面板里缩到刚好放下', () => {
    // 面板 720 CSS px（zoom=1），内容 1180 → 应缩到约 0.61
    const f = computeFitZoomFactor(720, 1180, 1)
    expect(f).toBeCloseTo(720 / 1180, 5)
  })

  it('内容不溢出（响应式页）时不放大，保持 100%', () => {
    expect(computeFitZoomFactor(1039, 800, 1)).toBe(1)
    expect(computeFitZoomFactor(1039, 1039, 1)).toBe(1)
  })

  it('与当前缩放无关、不自我震荡：已缩放后再算结果一致', () => {
    // 第一次：innerWidth=720, zoom=1, content=1180 → 0.6102
    const first = computeFitZoomFactor(720, 1180, 1)!
    // 应用后布局视口变宽：innerWidth' = 720 / first ≈ 1180，content 仍 1180
    const innerAfter = 720 / first
    const second = computeFitZoomFactor(innerAfter, 1180, first)!
    expect(second).toBeCloseTo(first, 4)
  })

  it('窄面板缩小后恢复宽屏时，根据记住的内容宽度恢复缩放', () => {
    const rememberedContentWidth = 1180
    const narrowed = computeFitZoomFactor(720, rememberedContentWidth, 1)!

    // 放宽到 1000px 后，当前小 zoom 下 document scrollWidth 可能等于 innerWidth；
    // 此时要用窄屏时测到的内容宽度恢复到 1000 / 1180，而不是继续保持 0.415。
    const widenedInnerWidth = 1000 / narrowed
    const widened = computeFitZoomFactor(
      widenedInnerWidth,
      widenedInnerWidth,
      narrowed,
      rememberedContentWidth,
    )!

    expect(widened).toBeCloseTo(1000 / rememberedContentWidth, 5)
  })

  it('恢复到足够宽时自动回到 100%', () => {
    const rememberedContentWidth = 1180
    const narrowed = computeFitZoomFactor(720, rememberedContentWidth, 1)!
    const widenedInnerWidth = 1440 / narrowed

    expect(computeFitZoomFactor(
      widenedInnerWidth,
      widenedInnerWidth,
      narrowed,
      rememberedContentWidth,
    )).toBe(1)
  })

  it('过窄面板被 50% 下限兜住，不会压成不可读', () => {
    // 320 / 1180 ≈ 0.271 < 0.5 → clamp 到 0.5
    expect(computeFitZoomFactor(320, 1180, 1)).toBe(0.5)
  })

  it('非法输入返回 null（不动当前缩放）', () => {
    expect(computeFitZoomFactor(0, 1180, 1)).toBeNull()
    expect(computeFitZoomFactor(490, 0, 1)).toBeNull()
    expect(computeFitZoomFactor(490, 1180, 0)).toBeNull()
    expect(computeFitZoomFactor(NaN, 1180, 1)).toBeNull()
  })
})
