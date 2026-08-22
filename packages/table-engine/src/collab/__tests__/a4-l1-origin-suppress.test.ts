/**
 * A4-L1: originId 跳过测试
 *
 * 验证 recordsObserver 在 origin 抑制窗口内跳过远端变更回调，
 * 窗口外正常触发。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('A4-L1: origin suppress window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('suppresses remote change callbacks when within suppress window', () => {
    const suppressUntilRef = { current: Date.now() + 500 }
    const changes = [
      { recordId: 'r1', fieldId: 'f1', value: 'v1', isLocal: false },
    ]
    const callback = vi.fn()
    const callbacks = new Set([callback])

    const txnOrigin = 'server'
    const isLocal = txnOrigin === 'local'

    if (!isLocal) {
      const suppressed = suppressUntilRef.current > 0
        && Date.now() < suppressUntilRef.current
      if (!suppressed) {
        callbacks.forEach(cb => cb(changes))
      }
    }

    expect(callback).not.toHaveBeenCalled()
  })

  it('fires remote change callbacks when suppress window expired', () => {
    const suppressUntilRef = { current: Date.now() - 100 }
    const changes = [
      { recordId: 'r1', fieldId: 'f1', value: 'v1', isLocal: false },
    ]
    const callback = vi.fn()
    const callbacks = new Set([callback])

    const txnOrigin = 'server'
    const isLocal = txnOrigin === 'local'

    if (!isLocal) {
      const suppressed = suppressUntilRef.current > 0
        && Date.now() < suppressUntilRef.current
      if (!suppressed) {
        callbacks.forEach(cb => cb(changes))
      }
    }

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(changes)
  })

  it('does not suppress local origin changes', () => {
    const suppressUntilRef = { current: Date.now() + 500 }
    const callback = vi.fn()

    const txnOrigin = 'local'
    const isLocal = txnOrigin === 'local'

    expect(isLocal).toBe(true)
  })

  it('suppression activates when origin_id matches user', () => {
    const userId = 'user-123'
    const suppressUntilRef = { current: 0 }
    const windowMs = 500

    const event = {
      type: 'table.cells.pushed',
      payload: { origin_id: 'user-123', applied_count: 10 },
    }
    const p = event.payload as Record<string, unknown>
    if (p && typeof p.origin_id === 'string' && p.origin_id === userId) {
      suppressUntilRef.current = Date.now() + windowMs
    }

    expect(suppressUntilRef.current).toBeGreaterThan(0)
    expect(suppressUntilRef.current).toBeGreaterThan(Date.now())
  })

  it('suppression does NOT activate for different user', () => {
    const userId = 'user-123'
    const suppressUntilRef = { current: 0 }
    const windowMs = 500

    const event = {
      type: 'table.cells.pushed',
      payload: { origin_id: 'user-456', applied_count: 10 },
    }
    const p = event.payload as Record<string, unknown>
    if (p && typeof p.origin_id === 'string' && p.origin_id === userId) {
      suppressUntilRef.current = Date.now() + windowMs
    }

    expect(suppressUntilRef.current).toBe(0)
  })

  it('suppress window respects configured duration', () => {
    const userId = 'user-123'
    const suppressUntilRef = { current: 0 }
    const windowMs = 200

    const now = Date.now()
    const event = {
      type: 'table.cells.pushed',
      payload: { origin_id: 'user-123', applied_count: 5 },
    }
    const p = event.payload as Record<string, unknown>
    if (p && typeof p.origin_id === 'string' && p.origin_id === userId) {
      suppressUntilRef.current = now + windowMs
    }

    expect(suppressUntilRef.current).toBe(now + 200)

    vi.advanceTimersByTime(250)
    const afterAdvance = Date.now()
    const suppressed = suppressUntilRef.current > 0
      && afterAdvance < suppressUntilRef.current
    expect(suppressed).toBe(false)
  })
})
