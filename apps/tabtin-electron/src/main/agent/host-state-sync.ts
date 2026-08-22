import type { HostTurnStateSnapshot, HostTurnStore } from '@tabtin/agent-host/policy'

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000
const RECONCILE_JITTER_RATIO = 0.2

export type HostStateSyncDeps = {
  turnStore: () => HostTurnStore
  fetchSnapshots: () => Promise<{ contexts: HostTurnStateSnapshot[] }>
  subscribeInvalidation: (listener: (invalidatesBindings: boolean) => void) => () => void
  subscribeReconnect: (listener: () => void) => () => void
  subscribeRegistration?: (listener: () => void | Promise<boolean>) => () => void
  afterReconcile?: (contexts: HostTurnStateSnapshot[]) => void | Promise<void>
  intervalMs?: number
  random?: () => number
  logger?: { warn: (message: string, error?: unknown) => void }
}

export class HostStateSync {
  private timer: ReturnType<typeof setTimeout> | null = null
  private invalidationUnsubscribe: (() => void) | null = null
  private reconnectUnsubscribe: (() => void) | null = null
  private registrationUnsubscribe: (() => void) | null = null
  private reconcilePromise: Promise<boolean> | null = null
  private reconcileRequested = false
  private invalidationVersion = 0
  private stopped = true

  constructor(private readonly deps: HostStateSyncDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.invalidationUnsubscribe = this.deps.subscribeInvalidation(
      invalidatesBindings => this.invalidateAndReconcile(invalidatesBindings),
    )
    this.reconnectUnsubscribe = this.deps.subscribeReconnect(
      () => this.invalidateAndReconcile(true),
    )
    this.registrationUnsubscribe = this.deps.subscribeRegistration?.(
      () => this.reconcileFresh(),
    ) ?? null
    void this.reconcile()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.invalidationUnsubscribe?.()
    this.invalidationUnsubscribe = null
    this.reconnectUnsubscribe?.()
    this.reconnectUnsubscribe = null
    this.registrationUnsubscribe?.()
    this.registrationUnsubscribe = null
    this.reconcileRequested = false
  }

  reconcile(): Promise<boolean> {
    if (this.reconcilePromise) return this.reconcilePromise
    const startedAtVersion = this.invalidationVersion
    this.reconcilePromise = this.deps.fetchSnapshots()
      .then(({ contexts }) => {
        if (startedAtVersion !== this.invalidationVersion) return false
        this.deps.turnStore().replaceSnapshots(contexts)
        return Promise.resolve(this.deps.afterReconcile?.(contexts)).then(() => true)
      })
      .catch((error) => {
        this.deps.logger?.warn('[HostStateSync] reconcile failed', error)
        return false
      })
      .finally(() => {
        this.reconcilePromise = null
        if (this.reconcileRequested && !this.stopped) {
          this.reconcileRequested = false
          void this.reconcile()
        } else {
          this.scheduleNext()
        }
      })
    return this.reconcilePromise
  }

  private async reconcileFresh(): Promise<boolean> {
    if (this.reconcilePromise) {
      this.reconcileRequested = true
      await this.reconcilePromise
    }
    return this.reconcilePromise ?? this.reconcile()
  }

  private requestReconcile(): void {
    if (this.reconcilePromise) {
      this.reconcileRequested = true
      return
    }
    void this.reconcile()
  }

  private invalidateAndReconcile(invalidatesBindings: boolean): void {
    this.invalidationVersion += 1
    if (invalidatesBindings) this.deps.turnStore().invalidateExecutionBindings()
    this.requestReconcile()
  }

  private scheduleNext(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const intervalMs = this.deps.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
    const random = this.deps.random?.() ?? Math.random()
    const jitter = (random * 2 - 1) * intervalMs * RECONCILE_JITTER_RATIO
    this.timer = setTimeout(() => void this.reconcile(), Math.max(1, intervalMs + jitter))
  }
}
