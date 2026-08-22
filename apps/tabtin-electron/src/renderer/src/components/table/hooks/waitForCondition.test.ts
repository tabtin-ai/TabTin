import { describe, it, expect } from 'vitest'
import { waitForCondition } from './waitForCondition'

/** 构造一个可注入的虚拟时钟：sleep 直接推进时间并 resolve，无真实等待。 */
function makeVirtualClock() {
  let current = 0
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    },
  }
}

describe('waitForCondition', () => {
  it('条件一开始即成立时同步返回 true，不进入等待', async () => {
    let checks = 0
    const clock = makeVirtualClock()
    const ok = await waitForCondition(
      () => {
        checks += 1
        return true
      },
      { now: clock.now, sleep: clock.sleep },
    )
    expect(ok).toBe(true)
    expect(checks).toBe(1)
  })

  it('条件在若干次轮询后成立则返回 true', async () => {
    const clock = makeVirtualClock()
    let readyAt = 3
    const ok = await waitForCondition(
      () => {
        readyAt -= 1
        return readyAt <= 0
      },
      { now: clock.now, sleep: clock.sleep, intervalMs: 10, timeoutMs: 1000 },
    )
    expect(ok).toBe(true)
  })

  it('超时前条件始终不成立则返回 false，且是有界的（不会死循环）', async () => {
    const clock = makeVirtualClock()
    let checks = 0
    const ok = await waitForCondition(
      () => {
        checks += 1
        return false
      },
      { now: clock.now, sleep: clock.sleep, intervalMs: 16, timeoutMs: 100 },
    )
    expect(ok).toBe(false)
    // 首检 1 次 + 每 16ms 一轮直到 >=100ms + 结尾兜底检查一次，次数有限
    expect(checks).toBeGreaterThan(1)
    expect(checks).toBeLessThan(20)
  })

  it('恰在超时点成立仍返回 true（结尾兜底再检查一次）', async () => {
    const clock = makeVirtualClock()
    const ok = await waitForCondition(
      () => clock.now() >= 100,
      { now: clock.now, sleep: clock.sleep, intervalMs: 50, timeoutMs: 100 },
    )
    expect(ok).toBe(true)
  })
})
