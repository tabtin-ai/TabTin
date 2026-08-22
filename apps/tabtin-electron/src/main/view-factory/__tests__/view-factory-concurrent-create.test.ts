/**
 *  回归：并发建 View 的单飞 + 同步配额占坑模型
 *
 * 背景：旧实现用一把全局 `_createViewMutex` 串行化 createView 的「复用检查 + 配额检查 +
 * 建实例」，把不同 id 的慢活也串成一队，导致并发 browser open 墙钟线性叠加、撞 120s 超时。
 *
 * 新实现（方案 A）：
 *  - `evaluateViewQuota` 纯同步判定；ViewFactory 在同步段内「判定 + 占坑」（reservations 计入配额）。
 *  - `inFlight` 单飞：同 id 并发折叠为一次，替代旧锁的「同 id 不重复建 → 不漏 view」职责。
 *  - 不同 id 之间并发建实例，不再串行。
 *
 * 本文件用与 ViewFactory 一致的算法模型验证三条不变量（不实例化 Electron 依赖）：
 *  1. 并发不同 id 绝不超发配额（AA-008 不变量，去锁后仍成立）。
 *  2. 并发同 id 只建一次、不漏 view（P2-01 不变量）。
 *  3. 不同 id 的慢活并发执行，不被串行化（性能目标）。
 *
 * 本文件取代原 view-quota-concurrent.test.ts（其 checkViewQuota 与 mutex 序列化
 * 演示随本次改造删除）：evaluateViewQuota 判定 + AA-008「无序列化不超发」覆盖落于此。
 */

import { describe, it, expect } from 'vitest'
import { evaluateViewQuota } from '../view-quota'

const makeRunManager = (overrides: Record<string, any> = {}) => ({
  getQuota: () => ({ enabled: true, maxTotalViews: 5 }),
  checkQuotaForNewView: () => ({ allowed: true }),
  ...overrides,
})

const cfg = (overrides: Record<string, any> = {}) => ({ id: 'v', ...overrides }) as any

describe(': evaluateViewQuota 纯同步判定', () => {
  it('未达任何上限 → allow', () => {
    expect(evaluateViewQuota(3, cfg(), makeRunManager(), 50)).toEqual({ decision: 'allow' })
  })

  it('达到全局上限 → reject（带原因）', () => {
    expect(evaluateViewQuota(5, cfg(), makeRunManager(), 50)).toEqual({
      decision: 'reject',
      reason: '达到全局最大 View 数限制 (5)',
    })
  })

  it('Run 配额超限 → reject', () => {
    const rm = makeRunManager({ checkQuotaForNewView: () => ({ allowed: false, reason: 'Run 超限' }) })
    expect(evaluateViewQuota(1, cfg({ runId: 'run-1' }), rm, 50)).toEqual({
      decision: 'reject',
      reason: '配额不足: Run 超限',
    })
  })

  it('未开启全局配额但达 ViewFactory 兜底上限 → needCleanup', () => {
    const rm = makeRunManager({ getQuota: () => ({ enabled: false }) })
    expect(evaluateViewQuota(50, cfg(), rm, 50)).toEqual({ decision: 'needCleanup' })
  })

  it('纯函数：无副作用，可重复调用得同一结论', () => {
    const rm = makeRunManager()
    const a = evaluateViewQuota(5, cfg(), rm, 50)
    const b = evaluateViewQuota(5, cfg(), rm, 50)
    expect(a).toEqual(b)
  })
})

/**
 * 与 ViewFactory 一致的最小并发模型：
 * - views: 已落表的 id 集合
 * - reservations: 已占坑未落表的 id 集合
 * - getQuotaUsage = views.size + reservations.size
 * - tryReserveSync: 同步判定 + 占坑（无 await，单线程原子）
 * - createView: 单飞（同 id 返回同一 Promise）→ 占坑 → 异步建实例 → 落表转正
 */
function makeModel(maxViews: number) {
  const views = new Set<string>()
  const reservations = new Set<string>()
  const inFlight = new Map<string, Promise<string>>()
  const runManager = { getQuota: () => ({ enabled: false }), checkQuotaForNewView: () => ({ allowed: true }) }
  let peakConcurrentBuilds = 0
  let activeBuilds = 0
  const buildStarts: string[] = []

  const tryReserveSync = (id: string) => {
    const decision = evaluateViewQuota(views.size + reservations.size, { id } as any, runManager, maxViews)
    if (decision.decision === 'allow') reservations.add(id)
    return decision
  }

  const createView = (id: string, buildMs = 5): Promise<string> => {
    const existing = inFlight.get(id)
    if (existing) return existing // 单飞：同 id 折叠

    const flow = (async () => {
      const decision = tryReserveSync(id)
      if (decision.decision !== 'allow') {
        throw new Error(decision.decision === 'reject' ? decision.reason : `needCleanup: ${maxViews}`)
      }
      let held = true
      try {
        buildStarts.push(id)
        activeBuilds++
        peakConcurrentBuilds = Math.max(peakConcurrentBuilds, activeBuilds)
        await new Promise(r => setTimeout(r, buildMs)) // 模拟慢的 createViewInstance
        activeBuilds--
        views.add(id)
        reservations.delete(id)
        held = false
        return id
      } finally {
        if (held) reservations.delete(id)
      }
    })()

    inFlight.set(id, flow)
    return flow.finally(() => inFlight.delete(id))
  }

  return { views, reservations, createView, get peakConcurrentBuilds() { return peakConcurrentBuilds }, buildStarts }
}

describe(': 并发创建不变量（去全局锁后）', () => {
  it('不变量1：并发不同 id 超过配额 → 恰好建到上限，其余拒绝，绝不超发', async () => {
    const m = makeModel(3)
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => m.createView(`v${i}`)),
    )
    expect(m.views.size).toBe(3)
    expect(m.reservations.size).toBe(0) // 占坑全部转正或回滚，无泄漏
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(3)
  })

  it('不变量2：并发同 id 只建一次、返回同一结果、不漏 view', async () => {
    const m = makeModel(50)
    const results = await Promise.all([
      m.createView('same'),
      m.createView('same'),
      m.createView('same'),
      m.createView('same'),
    ])
    expect(results).toEqual(['same', 'same', 'same', 'same'])
    expect(m.views.size).toBe(1)
    // 同 id 只应真正进入建实例一次
    expect(m.buildStarts.filter(x => x === 'same')).toHaveLength(1)
  })

  it('不变量3：不同 id 的慢活并发执行，不被串行化', async () => {
    const m = makeModel(50)
    await Promise.all(Array.from({ length: 4 }, (_, i) => m.createView(`v${i}`, 20)))
    expect(m.views.size).toBe(4)
    // 全局锁会让 peak=1（串行）；去锁后 4 个 build 应真正并发重叠
    expect(m.peakConcurrentBuilds).toBeGreaterThan(1)
  })

  it('占坑计入配额：占坑期间的并发读到彼此，不超发', async () => {
    const m = makeModel(2)
    const results = await Promise.allSettled([
      m.createView('a', 30),
      m.createView('b', 30),
      m.createView('c', 30),
    ])
    expect(m.views.size).toBe(2)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  })

  it('建实例失败 → 释放占坑，配额可继续使用', async () => {
    // 用一个会抛错的建实例流程验证 reservation 回滚
    const views = new Set<string>()
    const reservations = new Set<string>()
    const runManager = { getQuota: () => ({ enabled: false }), checkQuotaForNewView: () => ({ allowed: true }) }
    const createFailing = async (id: string) => {
      const d = evaluateViewQuota(views.size + reservations.size, { id } as any, runManager, 1)
      if (d.decision !== 'allow') throw new Error('quota')
      reservations.add(id)
      let held = true
      try {
        await new Promise(r => setTimeout(r, 1))
        throw new Error('createViewInstance failed')
      } finally {
        if (held) { reservations.delete(id); held = false }
      }
    }
    await expect(createFailing('x')).rejects.toThrow('createViewInstance failed')
    expect(reservations.size).toBe(0) // 占坑已释放
    // 上限=1，失败释放后仍可再占
    const d = evaluateViewQuota(views.size + reservations.size, { id: 'y' } as any, runManager, 1)
    expect(d.decision).toBe('allow')
  })
})
