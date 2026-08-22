import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  markRunSuperseded,
  isRunSuperseded,
  clearSupersededRuns,
  __resetSupersededRunsForTest,
} from '../supersededRuns'

describe('supersededRuns', () => {
  beforeEach(() => {
    __resetSupersededRunsForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('登记后同 session 同 run_id 判为 superseded', () => {
    markRunSuperseded('s1', 'run-a')
    expect(isRunSuperseded('s1', 'run-a')).toBe(true)
  })

  it('不同 run_id / 不同 session 不受影响', () => {
    markRunSuperseded('s1', 'run-a')
    expect(isRunSuperseded('s1', 'run-b')).toBe(false)
    expect(isRunSuperseded('s2', 'run-a')).toBe(false)
  })

  it('空 sessionId / 空 run_id 一律非 superseded 且不登记', () => {
    markRunSuperseded('', 'run-a')
    markRunSuperseded('s1', '')
    expect(isRunSuperseded('', 'run-a')).toBe(false)
    expect(isRunSuperseded('s1', '')).toBe(false)
  })

  it('clearSupersededRuns 清掉整段登记', () => {
    markRunSuperseded('s1', 'run-a')
    markRunSuperseded('s1', 'run-b')
    clearSupersededRuns('s1')
    expect(isRunSuperseded('s1', 'run-a')).toBe(false)
    expect(isRunSuperseded('s1', 'run-b')).toBe(false)
  })

  it('TTL 过后自动失效', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'))
    markRunSuperseded('s1', 'run-a')
    expect(isRunSuperseded('s1', 'run-a')).toBe(true)
    // 推进超过 TTL(60s)
    vi.setSystemTime(new Date('2026-07-10T00:01:01.000Z'))
    expect(isRunSuperseded('s1', 'run-a')).toBe(false)
  })
})
