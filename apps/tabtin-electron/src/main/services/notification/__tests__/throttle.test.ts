import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NotificationThrottle } from '../throttle'
import type { NotificationPrefs } from '../types'
import { DEFAULT_PREFS } from '../types'

describe('NotificationThrottle', () => {
  let throttle: NotificationThrottle

  beforeEach(() => {
    throttle = new NotificationThrottle(5000, 3)
  })

  afterEach(() => {
    throttle.stopAutoCleanup()
  })

  it('should not throttle first occurrence', () => {
    expect(throttle.isThrottled('agent.task.completed')).toBe(false)
  })

  it('should allow up to maxPerType within window', () => {
    expect(throttle.isThrottled('test.type')).toBe(false)
    expect(throttle.isThrottled('test.type')).toBe(false)
    expect(throttle.isThrottled('test.type')).toBe(false)
    expect(throttle.isThrottled('test.type')).toBe(true)
  })

  it('should track different types independently', () => {
    throttle.isThrottled('type.a')
    throttle.isThrottled('type.a')
    throttle.isThrottled('type.a')
    expect(throttle.isThrottled('type.a')).toBe(true)
    expect(throttle.isThrottled('type.b')).toBe(false)
  })

  it('should reset after window expires', () => {
    vi.useFakeTimers()
    throttle.isThrottled('test')
    throttle.isThrottled('test')
    throttle.isThrottled('test')
    expect(throttle.isThrottled('test')).toBe(true)

    vi.advanceTimersByTime(6000)
    expect(throttle.isThrottled('test')).toBe(false)
    vi.useRealTimers()
  })

  it('should cleanup expired entries', () => {
    vi.useFakeTimers()
    throttle.isThrottled('old.type')
    vi.advanceTimersByTime(15000)
    throttle.cleanup()
    expect(throttle.size).toBe(0)
    vi.useRealTimers()
  })

  it('should not cleanup recent entries', () => {
    throttle.isThrottled('recent.type')
    throttle.cleanup()
    expect(throttle.size).toBe(1)
  })
})

/**
 * Wave 6 W6-D（R5-12）多窗口同账号 OS 通知去重 — NotificationThrottle.checkDedup
 *
 * checkDedup 接收任意 caller 构造的 string 作为 dedup key，与 NotificationPayload
 * 业务 schema 完全解耦；NotificationServiceImpl.buildDedupKey 才负责把 payload
 * 映射成 (type|navigateTo.type|navigateTo.id) 三元组或 (type|fallback|title) 退化键。
 */
describe('NotificationThrottle.checkDedup (Wave 6 W6-D / R5-12)', () => {
  let throttle: NotificationThrottle

  beforeEach(() => {
    // 5s 短窗口 + 3 maxPerType + 30s aggregate cooldown + 5s dedup window
    throttle = new NotificationThrottle(5000, 3, 30000, 5000)
  })

  afterEach(() => {
    throttle.stopAutoCleanup()
  })

  it('首次到达任意 dedup key → duplicate=false，并写入 dedup map', () => {
    const result = throttle.checkDedup('agent.task.error|chat-session|session-1')
    expect(result.duplicate).toBe(false)
    expect(throttle.dedupSize).toBe(1)
  })

  it('5s 内同 key 第二次到达 → duplicate=true', () => {
    const key = 'agent.task.error|chat-session|session-1'
    expect(throttle.checkDedup(key).duplicate).toBe(false)
    expect(throttle.checkDedup(key).duplicate).toBe(true)
  })

  it('5s 窗口过期后第三次到达 → duplicate=false（窗口过期允许再次发送）', () => {
    vi.useFakeTimers()
    const key = 'agent.task.error|chat-session|session-1'
    expect(throttle.checkDedup(key).duplicate).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(throttle.checkDedup(key).duplicate).toBe(true)
    // 窗口长 5s；总累积 6s（>5s）后允许再次发送
    vi.advanceTimersByTime(4000)
    expect(throttle.checkDedup(key).duplicate).toBe(false)
    vi.useRealTimers()
  })

  it('不同 dedup key 互不影响（不同 navigateTo.id 的失败应都弹）', () => {
    const ka = 'agent.task.error|chat-session|session-A'
    const kb = 'agent.task.error|chat-session|session-B'
    expect(throttle.checkDedup(ka).duplicate).toBe(false)
    expect(throttle.checkDedup(kb).duplicate).toBe(false)
    expect(throttle.checkDedup(ka).duplicate).toBe(true)
    expect(throttle.checkDedup(kb).duplicate).toBe(true)
  })

  it('多窗口场景：模拟 2 个 renderer 几乎同时触发同事件 → 仅首条放行', () => {
    // 主窗口 A、主窗口 B 各自的事件流 listener → IPC 'notification:show'
    // 几乎同时到达主进程；NotificationServiceImpl 给两次都 build 出相同 key
    const sharedKey = 'agent.hitl.waiting|chat-session|session-shared'
    const winA = throttle.checkDedup(sharedKey)
    const winB = throttle.checkDedup(sharedKey)
    expect(winA.duplicate).toBe(false)
    expect(winB.duplicate).toBe(true)
  })

  it('命中 dedup 时不刷新时间戳：高频重复请求不会无限把窗口往后推', () => {
    vi.useFakeTimers()
    const key = 'agent.task.error|chat-session|session-1'
    expect(throttle.checkDedup(key).duplicate).toBe(false)
    // 模拟高频回调：每 1s 触发一次同 key
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(1000)
      expect(throttle.checkDedup(key).duplicate).toBe(true)
    }
    // 自首次到达累积 5s（4 + 1）后超出窗口（5s 是不严格小于 → 等于不算 duplicate）
    vi.advanceTimersByTime(1100)
    expect(throttle.checkDedup(key).duplicate).toBe(false)
    vi.useRealTimers()
  })

  it('GC：dedupMap > 200 条时触发清理，过期条目被清掉', () => {
    vi.useFakeTimers()
    // 写入 200 条 “旧” key
    for (let i = 0; i < 200; i++) {
      throttle.checkDedup(`old|key|${i}`)
    }
    expect(throttle.dedupSize).toBe(200)

    // 让所有 200 条过期（>5s）
    vi.advanceTimersByTime(6000)
    // 第 201 条触发 cleanup（size > 200）
    throttle.checkDedup('new|key|trigger-gc')
    // GC 应已清掉所有过期条目，仅剩刚刚写入的 1 条
    expect(throttle.dedupSize).toBe(1)
    vi.useRealTimers()
  })

  it('GC：未过期条目不会被清掉', () => {
    vi.useFakeTimers()
    // 写入 200 条 “最近” key
    for (let i = 0; i < 200; i++) {
      throttle.checkDedup(`recent|key|${i}`)
    }
    // 不推进时间，第 201 条触发 cleanup
    throttle.checkDedup('recent|key|201')
    // 全部都还在窗口内，cleanup 不应该删任何条目
    expect(throttle.dedupSize).toBe(201)
    vi.useRealTimers()
  })

  it('cleanup() 与 throttle map 一起同步清理 dedupMap 过期条目', () => {
    vi.useFakeTimers()
    throttle.checkDedup('agent.task.error|chat-session|old-session')
    expect(throttle.dedupSize).toBe(1)

    // 远超 5s 窗口
    vi.advanceTimersByTime(15000)
    throttle.cleanup()
    expect(throttle.dedupSize).toBe(0)
    vi.useRealTimers()
  })

  it('clearDedup() 立即清空 dedup 窗口（测试 / 进程重置用）', () => {
    throttle.checkDedup('a|b|c')
    throttle.checkDedup('d|e|f')
    expect(throttle.dedupSize).toBe(2)

    throttle.clearDedup()
    expect(throttle.dedupSize).toBe(0)
    // 之前去重过的 key 再次到达不会被识别为 duplicate（因为已被 clear）
    expect(throttle.checkDedup('a|b|c').duplicate).toBe(false)
  })

  it('clearDedup() 不影响 throttle map（throttle 与 dedup 是独立维度）', () => {
    throttle.checkDedup('shared|key')
    throttle.checkThrottle('agent.task.completed')
    expect(throttle.dedupSize).toBe(1)
    expect(throttle.size).toBe(1)

    throttle.clearDedup()
    expect(throttle.dedupSize).toBe(0)
    // throttle map 应保留
    expect(throttle.size).toBe(1)
  })
})

describe('NotificationThrottle.checkThrottle', () => {
  let throttle: NotificationThrottle

  beforeEach(() => {
    throttle = new NotificationThrottle(5000, 3)
  })

  afterEach(() => {
    throttle.stopAutoCleanup()
  })

  it('should return throttled=false and suppressedCount=0 for first call', () => {
    const result = throttle.checkThrottle('agent.task.completed')
    expect(result).toEqual({ throttled: false, suppressedCount: 0 })
  })

  it('should return suppressedCount when throttled', () => {
    throttle.checkThrottle('t')
    throttle.checkThrottle('t')
    throttle.checkThrottle('t')
    const r4 = throttle.checkThrottle('t')
    expect(r4).toEqual({ throttled: true, suppressedCount: 1 })
    const r5 = throttle.checkThrottle('t')
    expect(r5).toEqual({ throttled: true, suppressedCount: 2 })
  })
})

describe('NotificationThrottle.canSendAggregate', () => {
  it('should allow first aggregate immediately', () => {
    const throttle = new NotificationThrottle(5000, 3, 30000)
    expect(throttle.canSendAggregate()).toBe(true)
  })

  it('should block aggregate within cooldown', () => {
    const throttle = new NotificationThrottle(5000, 3, 30000)
    expect(throttle.canSendAggregate()).toBe(true)
    expect(throttle.canSendAggregate()).toBe(false)
  })

  it('should allow aggregate after cooldown', () => {
    vi.useFakeTimers()
    const throttle = new NotificationThrottle(5000, 3, 30000)
    expect(throttle.canSendAggregate()).toBe(true)
    vi.advanceTimersByTime(31000)
    expect(throttle.canSendAggregate()).toBe(true)
    vi.useRealTimers()
  })
})

describe('NotificationThrottle.isDnd', () => {
  it('should return false when dnd is disabled', () => {
    const prefs: NotificationPrefs = { ...DEFAULT_PREFS, dndEnabled: false }
    expect(NotificationThrottle.isDnd(prefs)).toBe(false)
  })

  it('should return true when dnd enabled without schedule', () => {
    const prefs: NotificationPrefs = { ...DEFAULT_PREFS, dndEnabled: true }
    expect(NotificationThrottle.isDnd(prefs)).toBe(true)
  })

  it('should respect day-of-week filter', () => {
    const now = new Date()
    const currentDay = now.getDay()
    const otherDay = (currentDay + 1) % 7

    const prefs: NotificationPrefs = {
      ...DEFAULT_PREFS,
      dndEnabled: true,
      dndSchedule: { start: '00:00', end: '23:59', days: [otherDay] },
    }
    expect(NotificationThrottle.isDnd(prefs)).toBe(false)
  })

  it('should detect within same-day window', () => {
    const now = new Date()
    const currentDay = now.getDay()
    const h = now.getHours()
    const m = now.getMinutes()

    const start = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    const endH = h + 1 > 23 ? 23 : h + 1
    const end = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`

    const prefs: NotificationPrefs = {
      ...DEFAULT_PREFS,
      dndEnabled: true,
      dndSchedule: { start, end, days: [currentDay] },
    }

    if (h < 23) {
      expect(NotificationThrottle.isDnd(prefs)).toBe(true)
    }
  })

  it('should handle cross-midnight schedule', () => {
    const now = new Date()
    const currentDay = now.getDay()
    const h = now.getHours()

    const prefs: NotificationPrefs = {
      ...DEFAULT_PREFS,
      dndEnabled: true,
      dndSchedule: { start: '22:00', end: '06:00', days: [currentDay] },
    }

    const result = NotificationThrottle.isDnd(prefs)
    if (h >= 22 || h < 6) {
      expect(result).toBe(true)
    } else {
      expect(result).toBe(false)
    }
  })
})
