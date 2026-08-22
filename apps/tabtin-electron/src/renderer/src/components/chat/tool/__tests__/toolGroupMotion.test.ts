import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  prefersReducedMotion,
  runCountUp,
  TOOL_GROUP_COUNT_UP_MS,
} from '../toolGroupMotion'

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('matchMedia 命中 reduce 时返回 true', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, media: '(prefers-reduced-motion: reduce)' })),
    )
    expect(prefersReducedMotion()).toBe(true)
  })

  it('未命中时返回 false', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, media: '(prefers-reduced-motion: reduce)' })),
    )
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('runCountUp', () => {
  it('reduced-motion：直接呈现最终 N，不调度 rAF', () => {
    const updates: number[] = []
    const raf = vi.fn()
    const onComplete = vi.fn()
    const cancel = runCountUp(5, (n) => updates.push(n), {
      reducedMotion: true,
      raf,
      onComplete,
    })
    expect(updates).toEqual([5])
    expect(raf).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()
    cancel()
  })

  it('300ms 内从 0 count-up 到 N，完成后静止；cancel 清理 rAF', () => {
    const updates: number[] = []
    let pending: FrameRequestCallback | null = null
    let nextId = 1
    const onComplete = vi.fn()
    const raf = vi.fn((cb: FrameRequestCallback) => {
      pending = cb
      return nextId++
    })
    const caf = vi.fn()

    const cancel = runCountUp(4, (n) => updates.push(n), {
      reducedMotion: false,
      durationMs: TOOL_GROUP_COUNT_UP_MS,
      raf,
      caf,
      onComplete,
    })

    expect(updates[0]).toBe(0)
    expect(raf).toHaveBeenCalledTimes(1)

    // t=0
    pending?.(0)
    // t=150 → ~2
    pending?.(150)
    expect(updates.at(-1)).toBe(2)
    // t=300 → 4
    pending?.(300)
    expect(updates.at(-1)).toBe(4)
    expect(onComplete).toHaveBeenCalledOnce()

    const callsBeforeCancel = raf.mock.calls.length
    cancel()
    expect(caf).toHaveBeenCalled()
    // 完成后不应再继续排帧；cancel 后也不应再增长
    expect(raf.mock.calls.length).toBe(callsBeforeCancel)
  })

  it('cancel 在中途调用：停止后续更新', () => {
    const updates: number[] = []
    let pending: FrameRequestCallback | null = null
    const raf = vi.fn((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    })
    const caf = vi.fn()

    const cancel = runCountUp(10, (n) => updates.push(n), {
      reducedMotion: false,
      durationMs: 300,
      raf,
      caf,
    })

    pending?.(0)
    cancel()
    const frozen = updates.length
    pending?.(300)
    expect(updates.length).toBe(frozen)
    expect(updates.at(-1)).not.toBe(10)
  })
})
