import { LeaseStore, type TrackedLease } from './lease-store.js'

export const RUN_HOST_LEASE_SECONDS = 90
export const RUN_HOST_HEARTBEAT_MIN_DELAY_MS = 16_000
export const RUN_HOST_HEARTBEAT_MAX_DELAY_MS = 24_000

export const FENCE_REASON_LEASE_EXPIRED = 'lease_expired'
export const FENCE_REASON_RELEASED = 'released'
export const FENCE_REASON_OWNERSHIP_TRANSFERRED = 'ownership_transferred'
export const FENCE_REASON_PROJECTION_MISMATCH = 'projection_mismatch'
export const FENCE_REASON_HELD = 'held'

export type RunHostLeaseOutcome =
  | 'claimed'
  | 'renewed'
  | 'held'
  | 'fenced'
  | 'invalid'
  | 'not_found'

export type RunHostLeaseResponse = {
  outcome: RunHostLeaseOutcome
  run_id?: string
  lease_token?: string
  generation?: number
  lease_expires_at?: string
  reason?: string
}

export type RunHostLeaseClaimDecision = 'claimed' | 'duplicate' | 'rejected'

export type RunHostLeaseApi = {
  claim(runId: string, hostId: string): Promise<RunHostLeaseResponse>
  heartbeat(
    runId: string,
    hostId: string,
    leaseToken: string,
  ): Promise<RunHostLeaseResponse>
  reconcile(
    hostId: string,
    activeRuns: Array<{ run_id: string; lease_token: string }>,
  ): Promise<{
    runs: RunHostLeaseResponse[]
    converged_run_ids: string[]
  }>
}

type TimerPort = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

function isHardFence(outcome: RunHostLeaseOutcome, reason?: string): boolean {
  if (outcome === 'held' || outcome === 'invalid' || outcome === 'not_found') {
    return true
  }
  if (outcome !== 'fenced') return false
  return reason === FENCE_REASON_PROJECTION_MISMATCH
    || reason === FENCE_REASON_RELEASED
    || reason === FENCE_REASON_HELD
}

export class RunHostLeaseCoordinator {
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private syncChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly api: RunHostLeaseApi,
    private readonly hostId: string,
    private readonly onFenced: (runId: string, reason?: string) => void,
    private readonly logger: {
      warn(message: string, details?: unknown): void
      info(message: string, details?: unknown): void
    },
    private readonly timers: TimerPort = {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: timer => clearTimeout(timer),
    },
    private readonly random: () => number = Math.random,
    private readonly leases: LeaseStore = new LeaseStore(),
  ) {}

  get leaseStore(): LeaseStore {
    return this.leases
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.reconcile().catch(error => {
      this.logger.warn('[RunHostLease] startup reconcile failed', error)
    })
    this.scheduleHeartbeat()
  }

  stop(): void {
    this.started = false
    if (this.heartbeatTimer) {
      this.timers.clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.leases.clear()
  }

  async claim(runId: string): Promise<RunHostLeaseClaimDecision> {
    if (this.leases.has(runId)) return 'duplicate'
    const result = await this.api.claim(runId, this.hostId)
    if (!this.adoptSuccessfulClaim(runId, result)) {
      this.logger.warn('[RunHostLease] claim rejected', {
        runId,
        outcome: result.outcome,
        reason: result.reason,
      })
      return 'rejected'
    }
    return 'claimed'
  }

  adoptClaim(runId: string, result: RunHostLeaseResponse): boolean {
    if (
      result.outcome !== 'claimed'
      || result.run_id !== runId
      || !result.lease_token
      || typeof result.generation !== 'number'
    ) {
      this.logger.warn('[RunHostLease] atomic local claim rejected', {
        runId,
        outcome: result.outcome,
      })
      return false
    }
    this.leases.set(runId, {
      runId,
      leaseToken: result.lease_token,
      generation: result.generation,
    })
    return true
  }

  stopTracking(runId: string): void {
    this.leases.delete(runId)
  }

  async reconcile(): Promise<void> {
    await this.runExclusive(() => this.reconcileLocked())
  }

  private async reconcileLocked(): Promise<void> {
    const snapshot = this.leases.values()
    const result = await this.api.reconcile(
      this.hostId,
      snapshot.map(lease => ({
        run_id: lease.runId,
        lease_token: lease.leaseToken,
      })),
    )
    for (const [index, response] of result.runs.entries()) {
      const runId = response.run_id ?? snapshot[index]?.runId
      if (!runId) continue
      if (this.adoptSuccessfulClaim(runId, response)) continue
      if (response.outcome === 'renewed') continue
      if (response.outcome === 'fenced' || response.outcome === 'held') {
        await this.reclaimOrFence(runId, response.outcome, response.reason)
      }
    }
    for (const runId of result.converged_run_ids) {
      this.fence(runId, FENCE_REASON_LEASE_EXPIRED)
    }
  }

  private async heartbeatAll(): Promise<void> {
    await this.runExclusive(() => this.heartbeatAllLocked())
  }

  private async heartbeatAllLocked(): Promise<void> {
    if (this.leases.size === 0) return
    const snapshot = this.leases.values()
    for (const lease of snapshot) {
      try {
        const result = await this.api.heartbeat(
          lease.runId,
          this.hostId,
          lease.leaseToken,
        )
        if (!this.isCurrentLeaseToken(lease.runId, lease.leaseToken)) continue
        if (result.outcome === 'renewed') continue
        if (result.outcome === 'fenced' || result.outcome === 'held') {
          await this.reclaimOrFence(lease.runId, result.outcome, result.reason)
        }
      } catch (error) {
        this.logger.warn('[RunHostLease] heartbeat failed', {
          runId: lease.runId,
          error,
        })
        await this.reclaimOrFence(lease.runId, 'fenced', FENCE_REASON_LEASE_EXPIRED)
      }
    }
  }

  private scheduleHeartbeat(): void {
    if (!this.started) return
    const span = RUN_HOST_HEARTBEAT_MAX_DELAY_MS - RUN_HOST_HEARTBEAT_MIN_DELAY_MS
    const delayMs = RUN_HOST_HEARTBEAT_MIN_DELAY_MS
      + Math.floor(Math.max(0, Math.min(1, this.random())) * span)
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null
      void this.heartbeatAll().finally(() => this.scheduleHeartbeat())
    }, delayMs)
  }

  private runExclusive(work: () => Promise<void>): Promise<void> {
    const run = this.syncChain.then(work, work)
    this.syncChain = run.then(() => undefined, () => undefined)
    return run
  }

  private isCurrentLeaseToken(runId: string, leaseToken: string): boolean {
    return this.leases.get(runId)?.leaseToken === leaseToken
  }

  private adoptSuccessfulClaim(runId: string, result: RunHostLeaseResponse): boolean {
    if (
      result.outcome !== 'claimed'
      || !result.lease_token
      || typeof result.generation !== 'number'
    ) {
      return false
    }
    this.leases.set(runId, {
      runId,
      leaseToken: result.lease_token,
      generation: result.generation,
    })
    return true
  }

  private async reclaimOrFence(
    runId: string,
    outcome: RunHostLeaseOutcome,
    reason?: string,
  ): Promise<void> {
    if (isHardFence(outcome, reason)) {
      this.fence(runId, reason)
      return
    }
    try {
      const result = await this.api.claim(runId, this.hostId)
      if (this.adoptSuccessfulClaim(runId, result)) {
        this.logger.info('[RunHostLease] reclaimed after disconnect', {
          runId,
          reason,
        })
        return
      }
      this.fence(runId, result.reason ?? reason)
    } catch (error) {
      this.logger.warn('[RunHostLease] reclaim failed, will retry', {
        runId,
        error,
      })
    }
  }

  private fence(runId: string, reason?: string): void {
    if (!this.leases.delete(runId)) return
    this.logger.info('[RunHostLease] run fenced', { runId, reason })
    this.onFenced(runId, reason)
  }
}

export type { TrackedLease }
