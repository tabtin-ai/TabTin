import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, cleanupWithPendingSyncCheck, scheduleSeqGapSync } from '../seqTracker'

describe('seqTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('只执行最后一次 schedule 的同步函数', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()

    scheduleSeqGapSync('session-1', fn1, 2000)
    scheduleSeqGapSync('session-1', fn2, 2000)

    vi.advanceTimersByTime(2000)

    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('cleanup 会取消待执行的同步', () => {
    const fn = vi.fn()

    scheduleSeqGapSync('session-1', fn, 2000)
    cleanup('session-1')
    vi.advanceTimersByTime(2000)

    expect(fn).not.toHaveBeenCalled()
  })

  it('cleanupWithPendingSyncCheck 在有 pending 时返回 true 并取消同步', () => {
    const fn = vi.fn()

    scheduleSeqGapSync('session-1', fn, 2000)

    expect(cleanupWithPendingSyncCheck('session-1')).toBe(true)
    vi.advanceTimersByTime(2000)

    expect(fn).not.toHaveBeenCalled()
  })
})
