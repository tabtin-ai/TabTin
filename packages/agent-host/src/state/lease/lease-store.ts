export type TrackedLease = {
  runId: string
  leaseToken: string
  generation: number
}

/**
 * Run host lease 跟踪表（ Phase 5）。
 */
export class LeaseStore {
  private readonly leases = new Map<string, TrackedLease>()

  has(runId: string): boolean {
    return this.leases.has(runId)
  }

  get(runId: string): TrackedLease | undefined {
    return this.leases.get(runId)
  }

  set(runId: string, lease: TrackedLease): void {
    this.leases.set(runId, lease)
  }

  delete(runId: string): boolean {
    return this.leases.delete(runId)
  }

  clear(): void {
    this.leases.clear()
  }

  values(): TrackedLease[] {
    return [...this.leases.values()]
  }

  get size(): number {
    return this.leases.size
  }
}
