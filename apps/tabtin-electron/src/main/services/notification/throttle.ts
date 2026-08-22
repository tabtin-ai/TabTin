/**
 * NotificationThrottle — 通知限流与免打扰判断
 *
 * 纯逻辑模块，不依赖 Electron API 也不感知 NotificationPayload 业务结构，
 * 易于单元测试、可被未来其他通知通道复用。
 *
 * Wave 6 W6-D（R5-12 多窗口同账号重复 OS 通知收口）：新增 dedup 接口
 *   - 同账号开 2+ 个 Electron 主窗口时，每个 renderer 各自的事件流
 *     listener 都可能让同一 envelope 触发 N 次 IPC 'notification:show'
 *     → 主进程作为单例汇聚点，按 caller 提供的 dedup key 在 5s 短窗口内
 *     只放行第一条 OS 通知。
 *   - 单纯 type 维度的 throttle 不够（throttle 5s 内允许 3 条同 type，
 *     2~3 个窗口几乎同时触发都不会被限流，仍然重复弹）。
 *   - dedup 与 throttle **概念解耦**：dedup 是 “这条具体通知刚弹过”
 *     （per-event 唯一性），throttle 是 “这种类型最近弹太多”
 *     （per-type 频率控制）。
 *   - dedup key 的 *构造规则* 由 caller（NotificationServiceImpl）负责，
 *     throttle 只关心 string 比较，避免业务字段 schema 渗入。
 */
import type { NotificationPrefs } from './types'

interface ThrottleEntry {
  count: number
  firstAt: number
  lastAt: number
}

export interface ThrottleResult {
  throttled: boolean
  /** 被限流时，当前窗口内已累积（含本条）的通知数 */
  suppressedCount: number
}

const DEFAULT_WINDOW_MS = 5_000
const DEFAULT_MAX_PER_TYPE = 3
const CLEANUP_INTERVAL_MS = 60_000
const DEFAULT_AGGREGATE_COOLDOWN_MS = 30_000

// W6-D8：multi-window dedup 短窗口（与 windowMs 一致，便于行为预期）。
// 同 dedup key 5s 内只允许首发 OS 通知；窗口外允许再弹（让用户感知任务再次状态变化）。
const DEDUP_WINDOW_MS = 5_000
const EXACT_EVENT_DEDUP_WINDOW_MS = 60_000

// 软上限：dedupMap 超过 200 条时清理过期条目，防止长跑进程内存增长。
// 单用户多窗口稳态下同时活跃的 dedup key 一般 < 50；200 已留充足缓冲。
const DEDUP_MAP_SOFT_CAP = 200

export class NotificationThrottle {
  private map = new Map<string, ThrottleEntry>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private lastAggregateAt = 0
  // W6-D：dedupKey → lastSeenAt 时间戳（ms）。caller 负责 key 构造规则。
  private dedupMap = new Map<string, number>()

  readonly windowMs: number
  readonly maxPerType: number
  readonly aggregateCooldownMs: number
  readonly dedupWindowMs: number

  constructor(
    windowMs = DEFAULT_WINDOW_MS,
    maxPerType = DEFAULT_MAX_PER_TYPE,
    aggregateCooldownMs = DEFAULT_AGGREGATE_COOLDOWN_MS,
    dedupWindowMs = DEDUP_WINDOW_MS,
  ) {
    this.windowMs = windowMs
    this.maxPerType = maxPerType
    this.aggregateCooldownMs = aggregateCooldownMs
    this.dedupWindowMs = dedupWindowMs
  }

  startAutoCleanup(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
  }

  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /**
   * 判断是否被限流，同时返回被抑制的通知数量。
   */
  checkThrottle(type: string): ThrottleResult {
    const now = Date.now()
    const entry = this.map.get(type)
    if (!entry) {
      this.map.set(type, { count: 1, firstAt: now, lastAt: now })
      return { throttled: false, suppressedCount: 0 }
    }
    if (now - entry.firstAt > this.windowMs) {
      this.map.set(type, { count: 1, firstAt: now, lastAt: now })
      return { throttled: false, suppressedCount: 0 }
    }
    entry.count += 1
    entry.lastAt = now
    const throttled = entry.count > this.maxPerType
    return { throttled, suppressedCount: throttled ? entry.count - this.maxPerType : 0 }
  }

  /** @deprecated 使用 checkThrottle 代替 */
  isThrottled(type: string): boolean {
    return this.checkThrottle(type).throttled
  }

  /**
   * Wave 6 W6-D（R5-12）：在 dedup 窗口（5s）内判断同一 dedupKey 是否已经
   * 被 “看见” 过——首次返回 `{ duplicate: false }` 并写入时间戳；窗口内
   * 重复出现返回 `{ duplicate: true }`（caller 应直接 return，不弹 OS 通知）。
   *
   * 设计取舍：
   *   - 接收 `string` 而非 `NotificationPayload`，让 throttle 类与业务
   *     schema 完全解耦；构造 dedup key 的策略由 caller（NotificationServiceImpl
   *     的 buildDedupKey）决定，未来 IM / Goal / Extension 通道可以各自
   *     选择不同的 key 维度。
   *   - 命中 dedup 时**不**刷新时间戳，避免高频重复请求一直把窗口往后推
   *     （否则一个失败 task 的高频回调会让 OS 通知永远弹不出来）。
   *   - 软上限 200 条触发 GC：清理 lastSeenAt 早于 (now - dedupWindowMs)
   *     的条目，保证 map 大小在合理量级。
   */
  checkDedup(dedupKey: string): { duplicate: boolean } {
    const now = Date.now()
    const lastAt = this.dedupMap.get(dedupKey)
    const windowMs = dedupKey.startsWith('dedup_ref|')
      ? EXACT_EVENT_DEDUP_WINDOW_MS
      : this.dedupWindowMs
    if (lastAt !== undefined && now - lastAt < windowMs) {
      return { duplicate: true }
    }
    this.dedupMap.set(dedupKey, now)
    if (this.dedupMap.size > DEDUP_MAP_SOFT_CAP) {
      this.cleanupDedupMap(now)
    }
    return { duplicate: false }
  }

  /** 测试 / 进程重置用：清空 dedup 窗口（不影响 throttle map）。 */
  clearDedup(): void {
    this.dedupMap.clear()
  }

  private cleanupDedupMap(now: number): void {
    for (const [key, ts] of this.dedupMap) {
      const windowMs = key.startsWith('dedup_ref|')
        ? EXACT_EVENT_DEDUP_WINDOW_MS
        : this.dedupWindowMs
      if (ts < now - windowMs) this.dedupMap.delete(key)
    }
  }

  /**
   * 判断聚合通知是否处于冷却中（每 aggregateCooldownMs 最多一条）。
   * 返回 true 表示可以发送聚合通知。
   */
  canSendAggregate(): boolean {
    const now = Date.now()
    if (now - this.lastAggregateAt < this.aggregateCooldownMs) return false
    this.lastAggregateAt = now
    return true
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.map) {
      if (now - entry.lastAt > this.windowMs * 2) {
        this.map.delete(key)
      }
    }
    // W6-D：与 throttle map 同步清理 dedupMap 过期条目
    this.cleanupDedupMap(now)
  }

  get size(): number {
    return this.map.size
  }

  /** 仅用于测试 / 诊断 */
  get dedupSize(): number {
    return this.dedupMap.size
  }

  /** 判断是否处于免打扰时段 */
  static isDnd(prefs: NotificationPrefs): boolean {
    if (!prefs.dndEnabled) return false
    if (!prefs.dndSchedule) return true

    const now = new Date()
    const day = now.getDay()
    if (!prefs.dndSchedule.days.includes(day)) return false

    const currentMin = now.getHours() * 60 + now.getMinutes()
    const [startH, startM] = prefs.dndSchedule.start.split(':').map(Number)
    const [endH, endM] = prefs.dndSchedule.end.split(':').map(Number)
    const startMin = startH * 60 + startM
    const endMin = endH * 60 + endM

    if (startMin <= endMin) {
      return currentMin >= startMin && currentMin < endMin
    }
    return currentMin >= startMin || currentMin < endMin
  }
}
