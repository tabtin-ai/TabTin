/**
 * OffscreenWindowPool — Widget Wave 4 共用资源池（widget RFC §五 4.2 + §七 🟡）
 *
 * 业务目标：让 widget 烤图（WidgetRenderService）从 pool 拿隐藏 BrowserWindow，
 * 而不是每次 `renderToImage` 都新建（每个 BrowserWindow ~30MB）。同时通过
 * 并发上限 + FIFO 排队 + idle eviction 保证：
 *
 *   - **不拖慢主进程**：高峰期最多 2 个并发，多余请求排队（widget execute
 *     典型 200ms-2s，排队对用户来说是"卡 1-3 秒"，比 BrowserWindow 内存
 *     压垮整个 app 强）。
 *   - **不占内存**：30s 内无新请求 → 销毁所有 idle BrowserWindow，让用户
 *     不用 widget 时 ~60MB 内存还回去。
 *   - **可观测**：metric counter（创建 / 复用 / 排队时长 / idle 销毁），
 *     dev mode 输出 console.debug；harness / Wave 5b dogfood 拿来评估"
 *     2 并发上限是否合理"。
 *
 * **设计取舍**（Wave 4 范围）：
 *
 *   1. **不与 TabVideoRenderService 共用 pool**：那要改 TabVideoRenderService 的
 *      内部逻辑（它自己有 chunk-level concurrency=8），改它会大动干戈。Wave 4
 *      pool 只给 widget 用；未来若 TabSlide / TabDoc 接入 OffscreenRenderAPI
 *      可以共用同一 pool（接口已预留 acquire/release）。RFC §五 4.2 已留笔记。
 *
 *   2. **接口而非具体类**：通过 `BrowserWindowFactory` 注入"如何创建一个隐藏
 *      离屏 window"——这样 vitest 测试可以注入 mock factory 不依赖 Electron
 *      runtime。生产环境由 WidgetRenderService 注入 `() => new BrowserWindow(...)`。
 *
 *   3. **轻量级 mutex** vs PromiseMutex：用同一文件内简单 FIFO queue 实现，
 *      因为 pool 的"借出 / 归还"语义比通用 mutex 更清晰，且不需要 timeout。
 */

import type { BrowserWindow } from 'electron'

/**
 * 池子里的 entry——封装 BrowserWindow 实例 + lastUsed 时间戳。
 *
 * `inUse` 标识当前是否被 acquire 借出去；release 后改回 false 让 evict 计时
 * 从最后一次 release 起算。
 */
interface PoolEntry {
  window: BrowserWindow
  inUse: boolean
  lastReleasedAt: number
}

/**
 * 工厂函数：如何创建一个隐藏离屏 BrowserWindow。
 *
 * 由 WidgetRenderService 注入（生产）/ 测试注入（mock）。返回的 window 必须：
 *   - `show: false` + `webPreferences.offscreen: true`
 *   - 创建好就 ready（异步加载内容由调用方负责）
 *
 * 工厂可能抛——那是 BrowserWindow 真的创建失败（OS 资源不够等），由
 * `acquire` 捕获并 reject 排队的 Promise，调用方降级。
 */
export type BrowserWindowFactory = () => BrowserWindow

/**
 * Pool 配置（widget RFC §五 4.2 + §七 🟡 风险约束）。
 */
export interface OffscreenWindowPoolOptions {
  /**
   * 并发上限。widget RFC §七 🟡 #4：> 2 拖慢主进程。Wave 4 守住 2。
   * 测试可以传 1 让排队断言更明显。
   */
  maxConcurrent?: number
  /**
   * Idle 多久后销毁 window（ms）。Wave 4 默认 30 秒——比 Daemon
   * Chrome page 的 5min/30min 更激进，因为单次 widget 烤图比 Daemon
   * 一次浏览会话短得多，长期持有 BrowserWindow 内存浪费。
   */
  idleTimeoutMs?: number
  /**
   * 工厂函数——必填（生产环境调 BrowserWindow 构造，测试注入 mock）。
   */
  factory: BrowserWindowFactory
  /**
   * 可选 logger。dev 模式 console.debug，生产模式 noop。注意不要写 console.log
   * （会污染 stdout，触发 dev tools 警告）。
   */
  logger?: (msg: string) => void
}

/**
 * 排队中的等待者——`acquire` 返回 Promise，等到有 entry 可用时 resolve。
 * 同时记录 enqueuedAt 让 metric 能算"排队时长"。
 *
 * **P0-2 修复（2026-04-30）**：加 `timeoutHandle`——acquire 指定超时后，
 * 超时触发 reject + 从 waiters 列表移除，避免恶意 widget 永久占满 pool 后
 * 合法 widget 被无限排队死锁。
 */
interface Waiter {
  resolve: (entry: PoolEntry) => void
  reject: (err: Error) => void
  enqueuedAt: number
  timeoutHandle: NodeJS.Timeout | null
}

/**
 * Pool 当前 metric——可被 WidgetRenderService 暴露给测试 / dev panel。
 *
 * `queueWaitMsP95` 用最近 32 次的 95 分位（不存全部历史避免内存增长）；
 * Wave 5b dogfood 时这个数高就要调 maxConcurrent。
 */
export interface OffscreenWindowPoolMetric {
  /** 历史累计创建过的 window 数 */
  windowsCreated: number
  /** 历史累计 acquire 复用既有 idle window 的次数 */
  windowsReused: number
  /** 历史累计 idle eviction 销毁过的 window 数 */
  windowsEvicted: number
  /** 当前池子里 (idle + inUse) 的 window 总数 */
  poolSize: number
  /** 当前 inUse 中的 window 数 */
  inUseCount: number
  /** 当前等待 acquire 的 waiter 数（即排队长度） */
  queuedCount: number
  /** 历史最大排队长度——dogfood 时这个 > 0 说明 maxConcurrent 不够 */
  maxQueueDepthSeen: number
  /** 最近 32 次 acquire 的排队等待时长（ms，含立刻拿到的 0ms）的 95 分位 */
  queueWaitMsP95: number
  /** 历史所有 acquire 排队时长的总和——dev panel 显示 */
  totalQueueWaitMs: number
  /**
   * **P0-2**：acquire 超时被拒的累计次数。
   *
   * > 0 **要报警**——代表 pool 饱和到合法请求被挤出。常见根因：
   *   - 恶意 widget 死循环占满 pool（loadFile timeout 兜底但仍会短暂饱和）
   *   - maxConcurrent=2 在某 agent 大量并发 widget 时不够（该调大）
   */
  waitersTimedOut: number
}

/**
 * 默认配置。
 */
const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
/** P95 计算用的滑动窗口大小（最近 N 次 acquire）。 */
const QUEUE_WAIT_WINDOW = 32
/**
 * **P0-2 修复 + 可靠性 Review 自修（2026-04-30）**：acquire 默认超时。
 *
 * widget 烤图合法耗时：
 *   - 典型：200ms-2s
 *   - 极端（大 Mermaid ER + 慢字体 + reducedMotion 未命中）：5-10s
 *
 * 值选定 **17s** 的理由（对比旧值 15s）：
 *   - 必须 > WidgetRenderService.loadFile timeout (8s)
 *   - **必须** > 2 × loadFile timeout (= 16s)，否则「4 恶意 widget + 1 合法」
 *     场景下合法 widget 排第 3 位会误拒：
 *       t=0  : W1/W2 拿槽 A/B，W3-5 排队
 *       t=8s : W1/W2 loadFile timeout → destroy → W3/W4 拿 A/B（W5 仍在排队）
 *       t=16s: W3/W4 也 timeout → W5 本该被 serve
 *       但若 acquire_timeout=15s，W5 在 t=15s 就被拒（距恢复 1 秒）
 *     17s 留 1s 缓冲让 W5 在第二波释放时能赶上。
 *
 * 这不是无限扩大——超时是 DoS 防线，真实场景「4 恶意 widget 排队」也极少见。
 * 17s 覆盖常见边界。超过这个值说明 pool 真饱和，该调 `maxConcurrent`。
 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 17_000

/**
 * 离屏渲染窗口资源池——FIFO 队列 + 并发上限 + idle eviction。
 *
 * **生命周期**：
 *
 *   - `acquire()`：拿一个空闲 entry，没空闲 → 创建（直到 maxConcurrent）→
 *     满了 → 排队（FIFO）。返回 Promise<PoolEntry>。
 *   - `release(entry)`：归还，标 lastReleasedAt = now，触发等待者继续。
 *   - `dispose()`：销毁所有 window + reject 所有 waiter（用于宿主关闭时
 *     清理）。
 *
 * **idle 巡检**：每秒检查一次（setInterval），把 inUse=false 且
 * `now - lastReleasedAt > idleTimeoutMs` 的 entry 销毁。setInterval 在
 * 第一次 acquire 时启动，dispose 或池子完全空时停止——不让空闲 pool
 * 持续占用 timer slot。
 */
export class OffscreenWindowPool {
  private readonly maxConcurrent: number
  private readonly idleTimeoutMs: number
  private readonly factory: BrowserWindowFactory
  private readonly logger: (msg: string) => void

  private readonly entries: PoolEntry[] = []
  private readonly waiters: Waiter[] = []

  private idleTimer: NodeJS.Timeout | null = null

  // ── metrics ─────────────────────────────────────────────────
  private windowsCreated = 0
  private windowsReused = 0
  private windowsEvicted = 0
  private maxQueueDepthSeen = 0
  private totalQueueWaitMs = 0
  /** P0-2 修复：acquire 超时 reject 次数——dogfood 时 > 0 说明 pool 真的被饱和过。 */
  private waitersTimedOut = 0
  private readonly recentQueueWaits: number[] = []

  constructor(options: OffscreenWindowPoolOptions) {
    this.maxConcurrent =
      typeof options.maxConcurrent === 'number' && options.maxConcurrent > 0
        ? options.maxConcurrent
        : DEFAULT_MAX_CONCURRENT
    this.idleTimeoutMs =
      typeof options.idleTimeoutMs === 'number' && options.idleTimeoutMs >= 0
        ? options.idleTimeoutMs
        : DEFAULT_IDLE_TIMEOUT_MS
    this.factory = options.factory
    this.logger = options.logger ?? (() => {})
  }

  /**
   * 借一个 entry。Promise resolve 后该 entry 的 `inUse=true`，调用方烤完图
   * 必须 `release(entry)`，否则会一直占着位置。
   *
   * **错误路径**：
   *   - 工厂抛 → reject Promise（pool 自身不负责降级，调用方处理）
   *   - dispose() 后调用 → 立刻 reject
   *   - **P0-2**：排队超过 `timeoutMs`（默认 15s）→ 从 waiters 列表移除 + reject
   *     （调用方可以走"烤图失败 → fallback"路径，不让合法 widget 被恶意 widget
   *     永久占满的 pool 无限挂起）
   *
   * @param timeoutMs 排队超时（ms）。未传则用 `DEFAULT_ACQUIRE_TIMEOUT_MS=15000`。
   *                  立刻拿到 idle / 新建 window 的路径不受 timeout 影响。
   */
  acquire(timeoutMs: number = DEFAULT_ACQUIRE_TIMEOUT_MS): Promise<PoolEntry> {
    return new Promise<PoolEntry>((resolve, reject) => {
      const enqueuedAt = Date.now()
      // 1. 找一个空闲 entry
      const idle = this.entries.find((e) => !e.inUse && !e.window.isDestroyed())
      if (idle) {
        idle.inUse = true
        this.windowsReused += 1
        this.recordQueueWait(0)
        resolve(idle)
        this.ensureIdleTimer()
        return
      }
      // 2. 池子还没满，创建新 window
      if (this.entries.length < this.maxConcurrent) {
        let win: BrowserWindow
        try {
          win = this.factory()
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        const entry: PoolEntry = { window: win, inUse: true, lastReleasedAt: Date.now() }
        this.entries.push(entry)
        this.windowsCreated += 1
        this.recordQueueWait(0)
        this.logger(`[OffscreenWindowPool] created window #${this.windowsCreated} (poolSize=${this.entries.length}/${this.maxConcurrent})`)
        resolve(entry)
        this.ensureIdleTimer()
        return
      }
      // 3. 满了，排队（FIFO + 超时兜底，widget RFC §七 🔴 `OffscreenWindowPool 并发`
      //    风险升级 + P0-2 修复）
      const waiter: Waiter = { resolve, reject, enqueuedAt, timeoutHandle: null }
      this.waiters.push(waiter)
      if (this.waiters.length > this.maxQueueDepthSeen) {
        this.maxQueueDepthSeen = this.waiters.length
      }
      this.logger(`[OffscreenWindowPool] queued (depth=${this.waiters.length}, max=${this.maxConcurrent})`)

      // P0-2：超时兜底——超过 timeoutMs 还没 serve 到，就从 waiters 列表移除 +
      // reject 让调用方走失败路径。避免"两个恶意 widget 死循环 → pool 永久饱和
      // → 合法 widget 永久排队"的死锁。
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        waiter.timeoutHandle = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter)
          if (idx < 0) return // 已经被 serve（竞态：timer 在 tryServeNext 之后才触发）
          this.waiters.splice(idx, 1)
          this.waitersTimedOut += 1
          this.logger(`[OffscreenWindowPool] acquire timed out after ${timeoutMs}ms (waiters now=${this.waiters.length})`)
          waiter.reject(new Error(`OffscreenWindowPool acquire timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        if (typeof waiter.timeoutHandle.unref === 'function') {
          waiter.timeoutHandle.unref()
        }
      }
    })
  }

  /**
   * 归还。立刻让排队中的下一个 waiter 拿到。
   *
   * 安全性：传错 entry / 已被 destroy 的 entry → silently ignore。
   */
  release(entry: PoolEntry): void {
    const idx = this.entries.indexOf(entry)
    if (idx < 0) {
      this.logger('[OffscreenWindowPool] release: entry not in pool, ignoring')
      return
    }
    if (entry.window.isDestroyed()) {
      // window 在烤图过程中被外部 destroy 了（譬如 OOM）。从池子里删除。
      this.entries.splice(idx, 1)
      this.logger('[OffscreenWindowPool] release: entry destroyed externally, removing from pool')
      // 仍要尝试唤醒下一个 waiter——他需要新 window
      this.tryServeNextWaiter()
      return
    }
    entry.inUse = false
    entry.lastReleasedAt = Date.now()
    this.tryServeNextWaiter()
  }

  /**
   * 当一个 entry 归还或 evict 后，尝试服务下一个排队 waiter。
   *
   * 如果是归还：直接复用同一 entry。
   * 如果是 evict：池子有空位，下个 acquire 会自己创建——但本函数也覆盖
   * "evict 后立刻满足 waiter"路径，避免 evict 完 waiter 还在排队的死锁。
   *
   * **P0-2**：serve 成功后清 waiter 的 timeoutHandle，避免服务完成后 timer 再触发。
   */
  private tryServeNextWaiter(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]
      // 优先复用刚 release 的 entry
      const idle = this.entries.find((e) => !e.inUse && !e.window.isDestroyed())
      if (idle) {
        idle.inUse = true
        this.windowsReused += 1
        const waitMs = Date.now() - waiter.enqueuedAt
        this.recordQueueWait(waitMs)
        this.waiters.shift()
        if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle)
        waiter.resolve(idle)
        continue
      }
      // 没 idle 但池子有空位（evict 后）→ 创建新
      if (this.entries.length < this.maxConcurrent) {
        let win: BrowserWindow
        try {
          win = this.factory()
        } catch (err) {
          this.waiters.shift()
          if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle)
          waiter.reject(err instanceof Error ? err : new Error(String(err)))
          continue
        }
        const entry: PoolEntry = { window: win, inUse: true, lastReleasedAt: Date.now() }
        this.entries.push(entry)
        this.windowsCreated += 1
        const waitMs = Date.now() - waiter.enqueuedAt
        this.recordQueueWait(waitMs)
        this.waiters.shift()
        if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle)
        waiter.resolve(entry)
        continue
      }
      // 池子满了 + 无 idle → 等下一个 release
      break
    }
  }

  /**
   * 启动 idle 巡检 timer。已启动则 noop。
   */
  private ensureIdleTimer(): void {
    if (this.idleTimer) return
    // 1 秒一巡——idleTimeoutMs 是 30s 量级，1s 精度足够；高频巡检反而占 CPU
    this.idleTimer = setInterval(() => {
      this.evictIdle()
    }, 1000)
    // unref 让 timer 不阻塞 Electron 退出（SIGTERM 时不需要等 30s）
    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref()
    }
  }

  /**
   * 巡检：销毁 idle 时间超限的 entry。
   *
   * 销毁后池子可能空了→ 停 timer 节省资源；下一次 acquire 触发 ensureIdleTimer。
   */
  private evictIdle(): void {
    const now = Date.now()
    let removed = 0
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.inUse) continue
      if (now - e.lastReleasedAt < this.idleTimeoutMs) continue
      try {
        if (!e.window.isDestroyed()) {
          e.window.destroy()
        }
      } catch (err) {
        this.logger(`[OffscreenWindowPool] destroy failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.entries.splice(i, 1)
      this.windowsEvicted += 1
      removed += 1
    }
    if (removed > 0) {
      this.logger(`[OffscreenWindowPool] evicted ${removed} idle window(s) (poolSize=${this.entries.length})`)
      // evict 让池子有空位，可能能服务排队 waiter
      this.tryServeNextWaiter()
    }
    // 池子空了 + 无 waiter → 停 timer
    if (this.entries.length === 0 && this.waiters.length === 0 && this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }

  /**
   * 销毁所有 window + reject 所有 waiter——用于宿主关闭时清理。
   * 调用后池子不可再用（factory 不会再被调用）。
   *
   * **P0-2**：清理每个 waiter 的 timeoutHandle，避免 dispose 后 timer 再触发污染。
   */
  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    for (const e of this.entries) {
      try {
        if (!e.window.isDestroyed()) {
          e.window.destroy()
        }
      } catch {
        // 忽略——destroy 时 window 可能已经被 closed
      }
    }
    this.entries.length = 0
    const err = new Error('OffscreenWindowPool disposed')
    for (const w of this.waiters) {
      if (w.timeoutHandle) clearTimeout(w.timeoutHandle)
      w.reject(err)
    }
    this.waiters.length = 0
  }

  /**
   * 暴露当前 metric 快照。dev panel / 测试用。
   */
  getMetric(): OffscreenWindowPoolMetric {
    return {
      windowsCreated: this.windowsCreated,
      windowsReused: this.windowsReused,
      windowsEvicted: this.windowsEvicted,
      poolSize: this.entries.length,
      inUseCount: this.entries.filter((e) => e.inUse).length,
      queuedCount: this.waiters.length,
      maxQueueDepthSeen: this.maxQueueDepthSeen,
      queueWaitMsP95: this.computeP95(),
      totalQueueWaitMs: this.totalQueueWaitMs,
      waitersTimedOut: this.waitersTimedOut,
    }
  }

  // ── 内部 helpers ────────────────────────────────────────

  private recordQueueWait(ms: number): void {
    this.totalQueueWaitMs += ms
    this.recentQueueWaits.push(ms)
    while (this.recentQueueWaits.length > QUEUE_WAIT_WINDOW) {
      this.recentQueueWaits.shift()
    }
  }

  private computeP95(): number {
    if (this.recentQueueWaits.length === 0) return 0
    const sorted = [...this.recentQueueWaits].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * 0.95)
    return sorted[Math.min(idx, sorted.length - 1)]
  }
}

// ── module-level constants 供测试断言 ─────────────────────

/**
 * Pool 默认并发上限——Wave 4 北极星验证 4：
 *   `rg "MAX_CONCURRENT.*2|IDLE_TIMEOUT.*30" apps/tabtin-electron/src/main/services/OffscreenWindowPool.ts`
 *
 * 故意用大写常量名暴露——让 grep 验证能命中（widget RFC §七 🟡 风险监控点）。
 */
export const OFFSCREEN_POOL_MAX_CONCURRENT = DEFAULT_MAX_CONCURRENT
export const OFFSCREEN_POOL_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS
/**
 * **P0-2 修复**：acquire 超时默认值。
 *
 * 对外暴露让调用方 / 测试 / dev panel 断言。Wave 4 上线后若发现 p99 烤图真正
 * 需要 > 15s（例如超大 Mermaid ER 图 + 慢字体），可以扩大；但不要无限扩大——
 * 超时是 DoS 防线不是性能 knob。
 */
export const OFFSCREEN_POOL_ACQUIRE_TIMEOUT_MS = DEFAULT_ACQUIRE_TIMEOUT_MS
