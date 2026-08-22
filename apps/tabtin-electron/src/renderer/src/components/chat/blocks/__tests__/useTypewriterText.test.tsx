/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypewriterText } from '../useTypewriterText'

describe('useTypewriterText', () => {
  let rafQueue: FrameRequestCallback[]

  beforeEach(() => {
    rafQueue = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue[id - 1] = () => {}
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function flushFrames(n: number) {
    for (let i = 0; i < n; i++) {
      const batch = rafQueue.splice(0, rafQueue.length)
      for (const cb of batch) cb(performance.now())
    }
  }

  it('freeze=true 时停在当前揭示长度，不 drain 到 fullText', () => {
    const { result, rerender } = renderHook(
      ({ text, active, freeze }) => useTypewriterText(text, active, freeze),
      { initialProps: { text: 'ab', active: true, freeze: false } },
    )

    rerender({ text: 'abcdefghij', active: true, freeze: false })
    act(() => {
      flushFrames(2)
    })
    const beforeFreeze = result.current
    expect(beforeFreeze.length).toBeGreaterThan(0)
    expect(beforeFreeze.length).toBeLessThan(10)

    rerender({ text: 'abcdefghij', active: false, freeze: true })
    const frozen = result.current
    act(() => {
      flushFrames(40)
    })
    expect(result.current).toBe(frozen)
    expect(result.current).not.toBe('abcdefghij')
  })

  it('正常 finalize（无 freeze）仍可 drain 尾部', () => {
    const { result, rerender } = renderHook(
      ({ text, active, freeze }) => useTypewriterText(text, active, freeze),
      { initialProps: { text: 'ab', active: true, freeze: false } },
    )
    rerender({ text: 'abcdefghij', active: true, freeze: false })
    act(() => {
      flushFrames(2)
    })
    rerender({ text: 'abcdefghij', active: false, freeze: false })
    act(() => {
      flushFrames(80)
    })
    expect(result.current).toBe('abcdefghij')
  })
})
