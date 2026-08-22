import { describe, expect, it } from 'vitest'
import {
  computeImageGeneratingProgress,
  DEFAULT_IMAGE_GENERATING_TAU_MS,
} from '../imageGeneratingProgress'

describe('computeImageGeneratingProgress', () => {
  it('elapsed=0 → 接近 0', () => {
    expect(
      computeImageGeneratingProgress({ elapsedMs: 0, tauMs: 18000, done: false }),
    ).toBeGreaterThanOrEqual(0)
    expect(
      computeImageGeneratingProgress({ elapsedMs: 0, tauMs: 18000, done: false }),
    ).toBeLessThan(5)
  })

  it('elapsed=tau → 小于 93（封顶 92）', () => {
    expect(
      computeImageGeneratingProgress({ elapsedMs: 18000, tauMs: 18000, done: false }),
    ).toBeLessThan(93)
  })

  it('超长 elapsed 仍封顶 92', () => {
    expect(
      computeImageGeneratingProgress({ elapsedMs: 600_000, tauMs: 18000, done: false }),
    ).toBe(92)
  })

  it('done → 100', () => {
    expect(
      computeImageGeneratingProgress({ elapsedMs: 5000, tauMs: 18000, done: true }),
    ).toBe(100)
  })

  it('默认 tauMs = 18000', () => {
    expect(DEFAULT_IMAGE_GENERATING_TAU_MS).toBe(18000)
    expect(
      computeImageGeneratingProgress({ elapsedMs: 18000, done: false }),
    ).toBe(
      computeImageGeneratingProgress({ elapsedMs: 18000, tauMs: 18000, done: false }),
    )
  })

  it('公式：100*(1-exp(-t/τ)) 再 min 92（连续浮点，不 round）', () => {
    const elapsedMs = 5000
    const tauMs = 18000
    const expected = Math.min(92, 100 * (1 - Math.exp(-elapsedMs / tauMs)))
    expect(computeImageGeneratingProgress({ elapsedMs, tauMs, done: false })).toBeCloseTo(
      expected,
      6,
    )
  })

  it('同 elapsed 连续推进（不量化成整数台阶）', () => {
    const a = computeImageGeneratingProgress({ elapsedMs: 1000, tauMs: 18000, done: false })
    const b = computeImageGeneratingProgress({ elapsedMs: 1016, tauMs: 18000, done: false })
    expect(b).toBeGreaterThan(a)
    expect(b - a).toBeLessThan(1)
  })
})
