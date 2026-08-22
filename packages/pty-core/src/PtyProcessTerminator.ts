import type { ProcessUsageEntry } from './process-tree'
import { collectProcessSubtreeUsage } from './process-tree'

export interface PtyProcessTerminationOptions {
  gracefulSignal?: NodeJS.Signals
  forceSignal?: NodeJS.Signals
  forceAfterMs?: number
  /**
   * Guard called immediately before the delayed force-kill (SIGKILL).
   * Return false to abort the force-kill, e.g. when the PID has been reused
   * by a new process after the original session was deleted.
   *
   * When omitted, a default guard is used that checks whether the target PID
   * still exists via a zero-signal probe (process.kill(pid, 0)).
   */
  guard?: () => boolean
}

/**
 * Handle returned by `terminateTree` that allows the caller to cancel the
 * scheduled force-kill timer before it fires.
 */
export interface TerminateTreeHandle {
  /** Cancel the pending force-kill timer. No-op if already fired or cancelled. */
  cancel: () => void
}

export interface PtyProcessTerminatorDeps {
  /**
   * Returns a snapshot of the system process table.
   * When omitted, terminateTree falls back to killing only the root pid.
   * Callers should inject a platform-specific implementation
   * (e.g. Electron's collectProcessUsageTable based on `ps`).
   */
  collectProcessTable?: () => Promise<Map<number, ProcessUsageEntry>>
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}

const DEFAULT_FORCE_AFTER_MS = 750
const EMPTY_PROCESS_TABLE = async (): Promise<Map<number, ProcessUsageEntry>> => new Map()

export class PtyProcessTerminator {
  private readonly collectProcessTable: () => Promise<Map<number, ProcessUsageEntry>>
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>

  constructor(deps: PtyProcessTerminatorDeps = {}) {
    this.collectProcessTable = deps.collectProcessTable ?? EMPTY_PROCESS_TABLE
    this.killProcess = deps.killProcess ?? ((pid, signal) => process.kill(pid, signal))
    this.schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  }

  terminateTree(rootPid: number, options: PtyProcessTerminationOptions = {}): TerminateTreeHandle {
    const noopHandle: TerminateTreeHandle = { cancel: () => {} }

    if (!Number.isFinite(rootPid) || rootPid <= 0) {
      return noopHandle
    }

    const gracefulSignal = options.gracefulSignal ?? 'SIGTERM'
    const forceSignal = options.forceSignal ?? 'SIGKILL'
    const forceAfterMs = options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS

    void this.killProcessTree(rootPid, gracefulSignal)

    if (forceAfterMs <= 0 || forceSignal === gracefulSignal) {
      return noopHandle
    }

    // PC-6: Default guard checks that the PID still exists to avoid killing
    // a reused PID that now belongs to a different process.
    const guard = options.guard ?? (() => {
      try {
        process.kill(rootPid, 0)
        return true
      } catch {
        return false
      }
    })

    let cancelled = false
    const timerId = this.schedule(() => {
      if (cancelled) return
      if (!guard()) return
      void this.killProcessTree(rootPid, forceSignal)
    }, forceAfterMs)

    return {
      cancel: () => {
        cancelled = true
        clearTimeout(timerId)
      },
    }
  }

  private async killProcessTree(rootPid: number, signal: NodeJS.Signals): Promise<void> {
    const pids = await this.collectTargetPids(rootPid)
    for (const pid of pids) {
      try {
        this.killProcess(pid, signal)
      } catch {
        // process may have already exited, ignore best-effort termination failures
      }
    }
  }

  private async collectTargetPids(rootPid: number): Promise<number[]> {
    try {
      const processTable = await this.collectProcessTable()
      const subtree = collectProcessSubtreeUsage(rootPid, processTable)
      if (subtree.pids.length > 0) {
        return [...subtree.pids].reverse()
      }
    } catch {
      // fall back to root pid only
    }
    return [rootPid]
  }
}
