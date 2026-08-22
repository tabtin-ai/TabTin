import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SEND_COOLDOWN_MS,
  useSendCooldownStore,
  isSendOnCooldown,
  __resetSendCooldownForTest,
} from '../sendCooldown'

describe('sendCooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'))
    __resetSendCooldownForTest()
  })

  afterEach(() => {
    __resetSendCooldownForTest()
    vi.useRealTimers()
  })

  it('开窗后同会话立即处于冷却', () => {
    useSendCooldownStore.getState().beginSendCooldown('s1')
    expect(isSendOnCooldown('s1')).toBe(true)
  })

  it('不同会话互不影响（per-session）', () => {
    useSendCooldownStore.getState().beginSendCooldown('s1')
    expect(isSendOnCooldown('s2')).toBe(false)
  })

  it('空 sessionId 一律非冷却且不开窗', () => {
    useSendCooldownStore.getState().beginSendCooldown('')
    expect(isSendOnCooldown('')).toBe(false)
    expect(isSendOnCooldown(null)).toBe(false)
    expect(isSendOnCooldown(undefined)).toBe(false)
  })

  it('冷却时长内仍处冷却，到期后自动恢复且清掉登记', () => {
    useSendCooldownStore.getState().beginSendCooldown('s1')
    // 尚未到期
    vi.advanceTimersByTime(SEND_COOLDOWN_MS - 1)
    expect(isSendOnCooldown('s1')).toBe(true)
    // 到期：计时器触发删除条目
    vi.advanceTimersByTime(1)
    expect(isSendOnCooldown('s1')).toBe(false)
    expect(useSendCooldownStore.getState().cooldownUntilBySessionId['s1']).toBeUndefined()
  })
})
