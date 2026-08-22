/**
 * In-memory state machine for Agent-requested worktree changes.
 *
 * A CLI request may declare a transition while its shell tool is still running,
 * but the binding cannot change until that tool result reaches the runtime's
 * tool boundary. The queue makes that ordering explicit and keeps one pending
 * transition per top-level run/session.
 */

export interface PendingAgentWorktreeTransition {
  sessionId: string
  runId: string
  toolUseId: string
  previousRootPath: string
  targetRootPath: string
  branch?: string
  spaceId?: string
  tabScopeKey?: string
  created: boolean
  requestedAt: number
  operationCompleted: boolean
  boundaryReached: boolean
  handoffPersisted: boolean
}

export type AgentWorktreeTransitionAvailability =
  | { ok: true }
  | {
      ok: false
      code: 'transition_pending' | 'tool_boundary_passed'
      message: string
    }

export type ScheduleAgentWorktreeTransitionResult =
  | { ok: true; transition: PendingAgentWorktreeTransition }
  | Exclude<AgentWorktreeTransitionAvailability, { ok: true }>

export class AgentWorktreeTransitionQueue {
  private readonly byRunId = new Map<string, PendingAgentWorktreeTransition>()
  private readonly runIdBySessionId = new Map<string, string>()
  private readonly completedToolIdsByRunId = new Map<string, Set<string>>()
  private readonly operationWaitersByRunId = new Map<string, Array<(completed: boolean) => void>>()

  constructor(private readonly now: () => number = Date.now) {}

  canSchedule(
    sessionId: string,
    runId: string,
    toolUseId: string,
  ): AgentWorktreeTransitionAvailability {
    if (this.completedToolIdsByRunId.get(runId)?.has(toolUseId)) {
      return {
        ok: false,
        code: 'tool_boundary_passed',
        message: 'worktree CLI 必须在当前终端工具中前台等待完成',
      }
    }
    const pendingForRun = this.byRunId.get(runId)
    if (pendingForRun) {
      return {
        ok: false,
        code: 'transition_pending',
        message: `run already has a pending worktree transition to ${pendingForRun.targetRootPath}`,
      }
    }
    const pendingRunId = this.runIdBySessionId.get(sessionId)
    if (pendingRunId) {
      const pendingForSession = this.byRunId.get(pendingRunId)
      return {
        ok: false,
        code: 'transition_pending',
        message: `session already has a pending worktree transition${
          pendingForSession ? ` to ${pendingForSession.targetRootPath}` : ''
        }`,
      }
    }
    return { ok: true }
  }

  schedule(
    input: Omit<
      PendingAgentWorktreeTransition,
      'requestedAt' | 'operationCompleted' | 'boundaryReached' | 'handoffPersisted'
    >,
  ): ScheduleAgentWorktreeTransitionResult {
    const available = this.canSchedule(input.sessionId, input.runId, input.toolUseId)
    if (!available.ok) return available

    const transition: PendingAgentWorktreeTransition = {
      ...input,
      requestedAt: this.now(),
      operationCompleted: false,
      boundaryReached: false,
      handoffPersisted: false,
    }
    this.byRunId.set(input.runId, transition)
    this.runIdBySessionId.set(input.sessionId, input.runId)
    return { ok: true, transition }
  }

  markOperationCompleted(
    runId: string,
    update: Partial<Pick<PendingAgentWorktreeTransition, 'targetRootPath' | 'branch'>> = {},
  ): PendingAgentWorktreeTransition | null {
    const pending = this.byRunId.get(runId)
    if (!pending) return null
    Object.assign(pending, update)
    pending.operationCompleted = true
    this.resolveOperationWaiters(runId, true)
    return pending
  }

  async waitForOperationCompletion(runId: string): Promise<boolean> {
    const pending = this.byRunId.get(runId)
    if (!pending) return false
    if (pending.operationCompleted) return true
    return await new Promise<boolean>((resolve) => {
      const waiters = this.operationWaitersByRunId.get(runId) ?? []
      waiters.push(resolve)
      this.operationWaitersByRunId.set(runId, waiters)
    })
  }

  markToolBoundary(runId: string, toolUseId: string): PendingAgentWorktreeTransition | null {
    const completedToolIds = this.completedToolIdsByRunId.get(runId) ?? new Set<string>()
    completedToolIds.add(toolUseId)
    this.completedToolIdsByRunId.set(runId, completedToolIds)
    const pending = this.byRunId.get(runId)
    if (!pending || pending.toolUseId !== toolUseId) return null
    pending.boundaryReached = true
    return pending
  }

  markHandoffPersisted(runId: string): PendingAgentWorktreeTransition | null {
    const pending = this.byRunId.get(runId)
    if (!pending?.boundaryReached) return null
    pending.handoffPersisted = true
    return pending
  }

  takeForCommit(runId: string): PendingAgentWorktreeTransition | null {
    const pending = this.byRunId.get(runId)
    if (!pending?.operationCompleted || !pending.boundaryReached || !pending.handoffPersisted) return null
    this.removePending(pending)
    return pending
  }

  cancelPending(runId: string): PendingAgentWorktreeTransition | null {
    const pending = this.byRunId.get(runId)
    this.resolveOperationWaiters(runId, false)
    if (!pending) return null
    this.removePending(pending)
    return pending
  }

  discardRun(runId: string): PendingAgentWorktreeTransition | null {
    this.completedToolIdsByRunId.delete(runId)
    return this.cancelPending(runId)
  }

  peekRun(runId: string): PendingAgentWorktreeTransition | undefined {
    return this.byRunId.get(runId)
  }

  clear(): void {
    for (const runId of this.operationWaitersByRunId.keys()) {
      this.resolveOperationWaiters(runId, false)
    }
    this.byRunId.clear()
    this.runIdBySessionId.clear()
    this.completedToolIdsByRunId.clear()
  }

  private removePending(transition: PendingAgentWorktreeTransition): void {
    this.byRunId.delete(transition.runId)
    if (this.runIdBySessionId.get(transition.sessionId) === transition.runId) {
      this.runIdBySessionId.delete(transition.sessionId)
    }
  }

  private resolveOperationWaiters(runId: string, completed: boolean): void {
    const waiters = this.operationWaitersByRunId.get(runId)
    if (!waiters) return
    this.operationWaitersByRunId.delete(runId)
    for (const resolve of waiters) resolve(completed)
  }
}
