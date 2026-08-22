/**
 * OffscreenWindowPool 测试 — Widget Wave 4.2 关键不变量
 *
 * 守住的核心约束（widget RFC §五 4.2 + §七 🟡 风险监控）：
 *
 *   1. **并发上限 2**：第 3 个 acquire 必须排队等 release。
 *   2. **FIFO 顺序**：先排队的先拿到。
 *   3. **复用空闲 entry**：release 后下一个 acquire 拿到同一 window（不创建新）。
 *   4. **idle eviction**：超过 idleTimeoutMs 后销毁 idle window 释放内存。
 *   5. **dispose 清理 + reject 排队**：宿主关闭时不留 leak。
 *   6. **metric 完整**：created / reused / evicted / queueWaitMs 都能拿到，
 *      让 Wave 5b dogfood 评估"2 并发是否够"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OffscreenWindowPool,
  OFFSCREEN_POOL_MAX_CONCURRENT,
  OFFSCREEN_POOL_IDLE_TIMEOUT_MS,
  OFFSCREEN_POOL_ACQUIRE_TIMEOUT_MS,
} from '../OffscreenWindowPool'
import type { BrowserWindow } from 'electron'

/**
 * Mock BrowserWindow——没 Electron runtime，只暴露测试关心的 API：
 * `isDestroyed()` / `destroy()`。Pool 不会调任何 webContents 方法，
 * 那些是 WidgetRenderService 的事。
 */
class MockBrowserWindow {
  private destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }
}

function makeMockFactory(): { factory: () => BrowserWindow; createCount: () => number; created: MockBrowserWindow[] } {
  const created: MockBrowserWindow[] = []
  const factory = (): BrowserWindow => {
    const w = new MockBrowserWindow()
    created.push(w)
    return w as unknown as BrowserWindow
  }
  return { factory, createCount: () => created.length, created }
}

describe('OffscreenWindowPool — Wave 4.2 关键防线', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // ── 防线 1: 默认配置常量暴露（grep 验证 widget RFC 验收 4）─────────
  it('OFFSCREEN_POOL_MAX_CONCURRENT === 2 + IDLE_TIMEOUT_MS === 30000', () => {
    expect(OFFSCREEN_POOL_MAX_CONCURRENT).toBe(2)
    expect(OFFSCREEN_POOL_IDLE_TIMEOUT_MS).toBe(30_000)
  })

  // ── 防线 2: 并发上限 2 ────────────────────────────────────────
  it('前 2 次 acquire 立刻拿到（创建 2 个 window）', async () => {
    const { factory, createCount } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 2 })
    const e1 = await pool.acquire()
    const e2 = await pool.acquire()
    expect(createCount()).toBe(2)
    expect(e1).not.toBe(e2)
  })

  it('第 3 次 acquire 排队（pool 满），release 后才 resolve', async () => {
    const { factory, createCount } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 2 })
    const e1 = await pool.acquire()
    const e2 = await pool.acquire()
    expect(createCount()).toBe(2)

    let e3Resolved = false
    let e3: Awaited<ReturnType<typeof pool.acquire>> | null = null
    const p3 = pool.acquire().then((entry) => {
      e3Resolved = true
      e3 = entry
      return entry
    })

    // 给 microtask 一轮跑（Promise resolution）
    await Promise.resolve()
    expect(e3Resolved).toBe(false)
    expect(pool.getMetric().queuedCount).toBe(1)

    pool.release(e1)
    await p3
    expect(e3Resolved).toBe(true)
    // 第 3 个 acquire **复用** e1，不创建新（windowsReused 增加）
    expect(e3).toBe(e1)
    expect(createCount()).toBe(2) // 仍然只创建过 2 个
    expect(pool.getMetric().windowsReused).toBeGreaterThan(0)
  })

  // ── 防线 3: FIFO 顺序 ────────────────────────────────────────
  it('多个排队者按 FIFO 顺序服务（先排队的先拿到）', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    const e1 = await pool.acquire()

    // 排 3 个 waiter：他们各自 then() 回收 entry 后立刻 release，让下一个 waiter
    // 拿到。这样能跑通整条 FIFO 链路而不死锁。
    const order: number[] = []
    const wrap = (id: number) => async (entry: Awaited<ReturnType<typeof pool.acquire>>) => {
      order.push(id)
      pool.release(entry)
    }
    const p2 = pool.acquire().then(wrap(2))
    const p3 = pool.acquire().then(wrap(3))
    const p4 = pool.acquire().then(wrap(4))

    await Promise.resolve()
    expect(pool.getMetric().queuedCount).toBe(3)

    // 第一次 release → 触发链式 2 → 3 → 4
    pool.release(e1)
    await Promise.all([p2, p3, p4])
    expect(order).toEqual([2, 3, 4])
  })

  // ── 防线 4: 复用 idle window（acquire-release-acquire）──────────
  it('release 后再 acquire 复用同一 entry（不创建新 window）', async () => {
    const { factory, createCount } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 2 })
    const e1 = await pool.acquire()
    pool.release(e1)
    const e1Again = await pool.acquire()
    expect(e1Again).toBe(e1)
    expect(createCount()).toBe(1)
    expect(pool.getMetric().windowsReused).toBe(1)
  })

  // ── 防线 5: idle eviction 真销毁 window + 释放池子空间 ──────────
  it('idle 超时后 eviction 销毁 window（释放内存 + 让排队者拿新 window）', async () => {
    const { factory, created } = makeMockFactory()
    const pool = new OffscreenWindowPool({
      factory,
      maxConcurrent: 2,
      idleTimeoutMs: 30_000,
    })
    const e1 = await pool.acquire()
    pool.release(e1)
    expect(pool.getMetric().poolSize).toBe(1)

    // 巡检 setInterval 1s 间隔，30s timeout——advance 32s 让 evict 跑
    vi.advanceTimersByTime(32_000)
    expect(created[0].isDestroyed()).toBe(true)
    expect(pool.getMetric().poolSize).toBe(0)
    expect(pool.getMetric().windowsEvicted).toBe(1)
  })

  it('inUse 的 window 不会被 evict（即便超过 idleTimeoutMs）', async () => {
    const { factory, created } = makeMockFactory()
    const pool = new OffscreenWindowPool({
      factory,
      maxConcurrent: 2,
      idleTimeoutMs: 30_000,
    })
    const e1 = await pool.acquire()
    // 持有 e1 不释放，跨过 30s+巡检
    vi.advanceTimersByTime(32_000)
    expect(created[0].isDestroyed()).toBe(false)
    expect(pool.getMetric().poolSize).toBe(1)
    pool.release(e1)
  })

  // ── 防线 6: dispose 清理 + reject 排队 ──────────────────────────
  it('dispose() 销毁所有 window 并 reject 所有排队 waiter', async () => {
    const { factory, created } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    await pool.acquire()
    const queuedPromise = pool.acquire()

    pool.dispose()

    expect(created[0].isDestroyed()).toBe(true)
    await expect(queuedPromise).rejects.toThrow(/disposed/)
  })

  // ── 防线 7: factory 抛错 → reject Promise ──────────────────────
  it('factory 抛错时 reject acquire（不污染 pool 状态）', async () => {
    let throwOnNext = true
    const factory = (): BrowserWindow => {
      if (throwOnNext) {
        throwOnNext = false
        throw new Error('OOM')
      }
      return new MockBrowserWindow() as unknown as BrowserWindow
    }
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 2 })
    await expect(pool.acquire()).rejects.toThrow(/OOM/)
    // pool 状态干净，下次 acquire 能成功
    const e = await pool.acquire()
    expect(e).toBeDefined()
  })

  // ── 防线 8: window 被外部 destroy（OOM 等）→ release 时清理 ────
  it('release 一个 window 已被外部 destroy 的 entry → 从池子里删除', async () => {
    const { factory, created } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 2 })
    const e = await pool.acquire()
    // 模拟 OOM 等让 window 在烤图中途死掉
    created[0].destroy()
    pool.release(e)
    expect(pool.getMetric().poolSize).toBe(0)
  })

  // ── 防线 9: metric 完整（dogfood 评估用）────────────────────────
  it('metric 包含 created/reused/evicted/queued/maxQueueDepthSeen', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    const e = await pool.acquire()
    pool.acquire() // 排队
    pool.acquire() // 排队
    const m = pool.getMetric()
    expect(m.windowsCreated).toBe(1)
    expect(m.queuedCount).toBe(2)
    expect(m.maxQueueDepthSeen).toBeGreaterThanOrEqual(2)
    pool.release(e)
  })

  it('queue wait time 被记录（让 Wave 5b dogfood 评估排队时长）', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    const e = await pool.acquire()
    const queuedPromise = pool.acquire()

    // 假装 1 秒后释放
    vi.advanceTimersByTime(1000)
    pool.release(e)
    const e2 = await queuedPromise
    expect(e2).toBeDefined()
    const m = pool.getMetric()
    expect(m.totalQueueWaitMs).toBeGreaterThanOrEqual(1000)
    expect(m.queueWaitMsP95).toBeGreaterThanOrEqual(0)
  })

  // ── 防线 10: idle 巡检停掉 timer（pool 空 + 无 waiter）──────────
  it('pool 空 + 无 waiter 时 idle 巡检 timer 自动停（避免 leak）', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({
      factory,
      maxConcurrent: 1,
      idleTimeoutMs: 100,
    })
    const e = await pool.acquire()
    pool.release(e)
    // 巡检 setInterval 是 1s 间隔——advance 1.5s 让 evict 跑一次
    vi.advanceTimersByTime(1500)
    expect(pool.getMetric().poolSize).toBe(0)
    // 再过几秒 timer 应该已经停了——通过 acquire 重新触发能拿到新 window
    vi.advanceTimersByTime(5000)
    const e2 = await pool.acquire()
    expect(e2).toBeDefined()
  })
})

// ─── P0-2 修复验证（2026-04-30）────────────────────────────────────────
//
// 修复目标：widget 内死循环 script → loadFile 永挂 → pool entry 永久占用 →
// 第二个恶意 widget 占满 pool → 合法 widget 永久排队死锁。
// 本 describe 守住"acquire 超时 + 清理 waiter + 清 timer"的契约。
describe('OffscreenWindowPool — P0-2：acquire 超时', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('OFFSCREEN_POOL_ACQUIRE_TIMEOUT_MS 默认值 17000（覆盖「4 恶意+1 合法」场景 p99）', () => {
    // 可靠性 Review 自修：从 15s 调到 17s，覆盖 2×loadFile(8s)+1s 缓冲的边界场景
    expect(OFFSCREEN_POOL_ACQUIRE_TIMEOUT_MS).toBe(17_000)
  })

  it('两个永挂 widget 占满 pool → 第三个 acquire 在 17s 内 timeout reject', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 2 })

    // 占满 pool（前两个拿到不 release 模拟 loadFile 永挂）
    await pool.acquire()
    await pool.acquire()

    let rejected = false
    let rejectionError: Error | null = null
    const p3 = pool.acquire().catch((err: Error) => {
      rejected = true
      rejectionError = err
    })

    await Promise.resolve()
    expect(rejected).toBe(false)
    expect(pool.getMetric().queuedCount).toBe(1)

    // 17s 超时（默认 OFFSCREEN_POOL_ACQUIRE_TIMEOUT_MS）
    vi.advanceTimersByTime(17_000)
    await p3
    expect(rejected).toBe(true)
    expect(rejectionError).toBeInstanceOf(Error)
    expect(rejectionError!.message).toMatch(/timed out after 17000/)

    // waiters 列表清理干净
    expect(pool.getMetric().queuedCount).toBe(0)
    expect(pool.getMetric().waitersTimedOut).toBe(1)
  })

  it('自定义 timeoutMs：传 500ms 的 acquire 超时 500ms 后 reject', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    await pool.acquire() // 占满

    let rejected = false
    const p2 = pool.acquire(500).catch(() => { rejected = true })
    await Promise.resolve()
    expect(rejected).toBe(false)

    vi.advanceTimersByTime(500)
    await p2
    expect(rejected).toBe(true)
    expect(pool.getMetric().waitersTimedOut).toBe(1)
  })

  it('acquire 超时后 waiter 从队列移除，后续 release 不会误 serve 已超时的 waiter', async () => {
    const { factory, createCount } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    const e1 = await pool.acquire()

    let timedOut = false
    const p2 = pool.acquire(1000).catch(() => { timedOut = true })
    vi.advanceTimersByTime(1000)
    await p2
    expect(timedOut).toBe(true)

    // 现在第一个 entry release ——不应再 serve 已超时的 waiter
    pool.release(e1)
    await Promise.resolve()
    expect(pool.getMetric().queuedCount).toBe(0)
    // 只创建过 1 个 window（没被超时 waiter 触发新建）
    expect(createCount()).toBe(1)
  })

  it('acquire 在超时前被 serve → timer 被清（不会在后续触发 spurious reject）', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    const e1 = await pool.acquire()

    let resolved = false
    let rejected = false
    const p2 = pool.acquire(5000)
      .then(() => { resolved = true })
      .catch(() => { rejected = true })

    vi.advanceTimersByTime(100)
    pool.release(e1)
    await p2
    expect(resolved).toBe(true)
    expect(rejected).toBe(false)

    // 推进到 timeout 时间，不应触发假 reject（timer 已被清）
    vi.advanceTimersByTime(10_000)
    await Promise.resolve()
    expect(rejected).toBe(false)
  })

  it('dispose 时清理所有 waiter 的 timer（避免 disposed 后 timer 触发 spurious reject）', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    await pool.acquire()

    let errors: Error[] = []
    const p2 = pool.acquire(5000).catch((err: Error) => { errors.push(err) })
    const p3 = pool.acquire(5000).catch((err: Error) => { errors.push(err) })

    pool.dispose()
    await Promise.all([p2, p3])
    expect(errors).toHaveLength(2)
    expect(errors[0].message).toMatch(/disposed/)
    expect(errors[1].message).toMatch(/disposed/)

    // 即使推进到 timeout 时间，已经 reject 的 waiter 不会再 reject 一次
    vi.advanceTimersByTime(10_000)
    await Promise.resolve()
    expect(errors).toHaveLength(2)
  })

  it('metric.waitersTimedOut 累计超时 reject 的次数（dogfood 报警信号）', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    await pool.acquire()

    const p2 = pool.acquire(500).catch(() => { /* timeout */ })
    const p3 = pool.acquire(500).catch(() => { /* timeout */ })

    vi.advanceTimersByTime(500)
    await Promise.all([p2, p3])
    expect(pool.getMetric().waitersTimedOut).toBe(2)
  })

  it('timeoutMs=0 禁用超时（保守降级：让旧调用方可以显式选不超时）', async () => {
    const { factory } = makeMockFactory()
    const pool = new OffscreenWindowPool({ factory, maxConcurrent: 1 })
    const e1 = await pool.acquire()

    let resolved = false
    const p2 = pool.acquire(0).then(() => { resolved = true })

    // 推进 60s，p2 仍不应 timeout
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(pool.getMetric().queuedCount).toBe(1)

    // release 后才 resolve
    pool.release(e1)
    await p2
    expect(resolved).toBe(true)
  })
})
