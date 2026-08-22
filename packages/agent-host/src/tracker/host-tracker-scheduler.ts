import { planHostSchedule, type HostScheduleItem } from './host-schedule-plan.js'

export const HOST_TRACKER_SCHEDULE_REFRESH_MS = 60_000
export const HOST_TRACKER_WORK_POLL_MS = 15_000
export const HOST_TRACKER_TIMER_MAX_DELAY_MS = 6 * 60 * 60 * 1000
export const HOST_TRACKER_FIRE_RETRY_MS = 60_000

export type { HostScheduleItem }

export type HostWorkItem = {
  runId: string
}

export type HostTrackerSchedulerPorts = {
  fetchSchedule: () => Promise<HostScheduleItem[]>
  fire: (trackerId: string) => Promise<void>
  fetchWork?: () => Promise<HostWorkItem[]>
  executeWork?: (runId: string) => Promise<void>
  reconcile?: () => Promise<void>
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  logger?: {
    info?: (message: string) => void
    warn?: (message: string, error?: unknown) => void
  }
}

export class HostTrackerScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Set<string>()
  private readonly retryNotBefore = new Map<string, number>()
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private workTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private syncing: Promise<void> | null = null

  constructor(private readonly ports: HostTrackerSchedulerPorts) {}

  start(): void {
    if (this.started) return
    this.started = true
    void this.sync()
    this.armRefresh()
    this.armWorkPoll()
  }

  stop(): void {
    this.started = false
    this.clearAllTimers()
    this.inFlight.clear()
    this.retryNotBefore.clear()
    if (this.refreshTimer != null) {
      this.clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.workTimer != null) {
      this.clearTimeout(this.workTimer)
      this.workTimer = null
    }
  }

  async sync(): Promise<void> {
    if (this.syncing) return this.syncing
    this.syncing = this.syncNow().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async syncNow(): Promise<void> {
    if (this.ports.reconcile) {
      try {
        await this.ports.reconcile()
      } catch (error) {
        this.ports.logger?.warn?.('[HostTrackerScheduler] reconcile failed', error)
      }
    }
    let items: HostScheduleItem[]
    try {
      items = await this.ports.fetchSchedule()
    } catch (error) {
      this.ports.logger?.warn?.('[HostTrackerScheduler] fetch schedule failed', error)
      return
    }
    const seen = new Set<string>()
    for (const item of items) {
      const trackerId = item.trackerId.trim()
      const plan = planHostSchedule(item, this.now())
      if (!trackerId || plan == null) continue
      seen.add(trackerId)
      if (this.inFlight.has(trackerId) && plan.dueMs <= this.now()) {
        this.clearTracker(trackerId)
        continue
      }
      if (this.inFlight.has(trackerId) && plan.dueMs > this.now()) {
        this.inFlight.delete(trackerId)
      }
      this.armTracker(trackerId, plan.dueMs, plan.shouldFire)
    }
    for (const trackerId of [...this.timers.keys()]) {
      if (!seen.has(trackerId)) this.clearTracker(trackerId)
    }
    for (const trackerId of [...this.inFlight]) {
      if (!seen.has(trackerId)) this.inFlight.delete(trackerId)
    }
    for (const trackerId of [...this.retryNotBefore.keys()]) {
      if (!seen.has(trackerId)) this.retryNotBefore.delete(trackerId)
    }
    this.ports.logger?.info?.(`[HostTrackerScheduler] armed ${seen.size} tracker(s)`)
    await this.drainWork()
  }

  private async drainWork(): Promise<void> {
    if (!this.ports.fetchWork || !this.ports.executeWork) return
    let work: HostWorkItem[]
    try {
      work = await this.ports.fetchWork()
    } catch (error) {
      this.ports.logger?.warn?.('[HostTrackerScheduler] fetch work failed', error)
      return
    }
    for (const item of work) {
      const runId = item.runId.trim()
      if (!runId || this.inFlight.has(runId)) continue
      if ((this.retryNotBefore.get(runId) ?? 0) > this.now()) continue
      await this.executeWorkThenSync(runId)
    }
  }

  private async executeWorkThenSync(runId: string): Promise<void> {
    if (!this.ports.executeWork) return
    this.inFlight.add(runId)
    try {
      await this.ports.executeWork(runId)
    } catch (error) {
      this.retryNotBefore.set(runId, this.now() + HOST_TRACKER_FIRE_RETRY_MS)
      this.ports.logger?.warn?.(`[HostTrackerScheduler] execute work failed run=${runId}`, error)
    } finally {
      this.inFlight.delete(runId)
    }
  }

  private armTracker(trackerId: string, dueMs: number, shouldFire: boolean): void {
    this.clearTracker(trackerId)
    const retryAt = this.retryNotBefore.get(trackerId) ?? 0
    const earliest = Math.max(dueMs, retryAt)
    const delay = Math.max(0, earliest - this.now())
    const wait = Math.min(delay, HOST_TRACKER_TIMER_MAX_DELAY_MS)
    const handle = this.setTimeout(() => {
      this.timers.delete(trackerId)
      if (!this.started) return
      if (wait < delay || !shouldFire) {
        void this.sync()
        return
      }
      void this.fireThenSync(trackerId)
    }, wait)
    this.timers.set(trackerId, handle)
  }

  private async fireThenSync(trackerId: string): Promise<void> {
    this.inFlight.add(trackerId)
    try {
      await this.ports.fire(trackerId)
    } catch (error) {
      this.inFlight.delete(trackerId)
      this.retryNotBefore.set(trackerId, this.now() + HOST_TRACKER_FIRE_RETRY_MS)
      this.ports.logger?.warn?.(`[HostTrackerScheduler] fire failed tracker=${trackerId}`, error)
    }
    if (this.started) await this.sync()
  }

  private armRefresh(): void {
    if (this.refreshTimer != null) this.clearTimeout(this.refreshTimer)
    this.refreshTimer = this.setTimeout(() => {
      this.refreshTimer = null
      if (!this.started) return
      void this.sync().finally(() => {
        if (this.started) this.armRefresh()
      })
    }, HOST_TRACKER_SCHEDULE_REFRESH_MS)
  }

  private armWorkPoll(): void {
    if (this.workTimer != null) this.clearTimeout(this.workTimer)
    this.workTimer = this.setTimeout(() => {
      this.workTimer = null
      if (!this.started) return
      void this.drainWork().finally(() => {
        if (this.started) this.armWorkPoll()
      })
    }, HOST_TRACKER_WORK_POLL_MS)
  }

  private clearTracker(trackerId: string): void {
    const handle = this.timers.get(trackerId)
    if (handle == null) return
    this.clearTimeout(handle)
    this.timers.delete(trackerId)
  }

  private clearAllTimers(): void {
    for (const handle of this.timers.values()) this.clearTimeout(handle)
    this.timers.clear()
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }

  private setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.ports.setTimeoutFn ?? setTimeout)(handler, ms)
  }

  private clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    (this.ports.clearTimeoutFn ?? clearTimeout)(handle)
  }
}
