/**
 * useCountdown hook 测试
 * 验证倒计时逻辑、清理机制
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCountdown } from '@tabtin/shared/use-countdown'

describe('useCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始状态应为 0 且非活跃', () => {
    const { result } = renderHook(() => useCountdown(60))
    expect(result.current.countdown).toBe(0)
    expect(result.current.isActive).toBe(false)
  })

  it('start 应启动倒计时', () => {
    const { result } = renderHook(() => useCountdown(60))

    act(() => {
      result.current.start()
    })

    expect(result.current.countdown).toBe(60)
    expect(result.current.isActive).toBe(true)
  })

  it('倒计时应每秒递减', () => {
    const { result } = renderHook(() => useCountdown(3))

    act(() => {
      result.current.start()
    })
    expect(result.current.countdown).toBe(3)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.countdown).toBe(2)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.countdown).toBe(1)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.countdown).toBe(0)
    expect(result.current.isActive).toBe(false)
  })

  it('start 支持自定义秒数', () => {
    const { result } = renderHook(() => useCountdown(60))

    act(() => {
      result.current.start(10)
    })

    expect(result.current.countdown).toBe(10)
  })

  it('clear 应立即停止倒计时', () => {
    const { result } = renderHook(() => useCountdown(60))

    act(() => {
      result.current.start()
    })
    expect(result.current.isActive).toBe(true)

    act(() => {
      result.current.clear()
    })
    // clear 后 countdown 保持当前值，但定时器已停止
    expect(result.current.countdown).toBe(60)

    // 推进时间后不应改变
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.countdown).toBe(60)
  })

  it('重复调用 start 应重置倒计时', () => {
    const { result } = renderHook(() => useCountdown(60))

    act(() => {
      result.current.start(10)
    })

    act(() => {
      vi.advanceTimersByTime(5000) // 消耗5秒 → 还剩5秒
    })
    expect(result.current.countdown).toBe(5)

    act(() => {
      result.current.start(20) // 重新开始20秒
    })
    expect(result.current.countdown).toBe(20)
  })

  it('组件卸载时应自动清理定时器', () => {
    const { result, unmount } = renderHook(() => useCountdown(60))

    act(() => {
      result.current.start()
    })

    unmount()

    // 不应有定时器泄漏（setInterval 应已被清除）
    // 推进时间不应导致错误
    act(() => {
      vi.advanceTimersByTime(60000)
    })
  })
})
