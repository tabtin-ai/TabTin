import type { AgentRunSyncPayload } from '@tabtin/agent-wire'
import { ConversationRunQueue } from './conversation-run-queue.js'

export interface ConversationRunSubmission<Result> {
  conversationId: string
  /** Authenticated owner/account scope used to quiesce runs during reset. */
  lifecycleScopeId?: string
  runId: string
  execute(): Promise<Result>
  onQueued?(position: number): void
  onDequeued?(): void
}

export interface ConversationRunState {
  busy: boolean
  queuedRunIds: string[]
}

export interface ConversationRunCoordinatorEvents {
  onIdle?(conversationId: string): void
  /**
   * ：执行态独立同步。每次 queue 状态变迁（started / queued / idle /
   * clearQueued）携带单调 seq；前端只镜像本事件，不从 lifecycle/terminal 推断 busy。
   */
  onRunSync?(payload: AgentRunSyncPayload): void
}

export type ConversationRunAcceptanceStatus = 'started' | 'queued'

export interface ConversationRunAcceptance {
  status: ConversationRunAcceptanceStatus
  /** started=0；queued 为 1 基队列位置。 */
  position: number
}

export interface ConversationRunSubmissionHandle<Result> {
  acceptance: ConversationRunAcceptance
  completion: Promise<Result>
  wasCancelled(): boolean
}

export class ConversationRunCancelledError extends Error {
  constructor(
    readonly conversationId: string,
    readonly runId: string,
  ) {
    super(`Conversation run was cancelled before execution: ${runId}`)
    this.name = 'ConversationRunCancelledError'
  }
}

/**
 * The single per-session serialization point shared by every TabTin host.
 */
export class ConversationRunCoordinator {
  /**
   * A device EventBuffer retains at most 5,000 action events. Keeping the same
   * number of admitted run handles makes every still-replayable forward
   * idempotent without growing for the lifetime of a long-running host.
   */
  private static readonly ADMITTED_RUN_LIMIT = 5_000
  private readonly runQueue: ConversationRunQueue
  private readonly quiescedConversationIds = new Set<string>()
  private readonly syncSeqByConversation = new Map<string, number>()
  private readonly activeRunByConversation = new Map<string, string>()
  private readonly admittedRuns = new Map<string, {
    conversationId: string
    handle: ConversationRunSubmissionHandle<unknown>
  }>()

  constructor(private readonly events: ConversationRunCoordinatorEvents = {}) {
    this.runQueue = new ConversationRunQueue({
      onStarted: (conversationId, runId) => {
        this.activeRunByConversation.set(conversationId, runId)
        this.emitRunSync(conversationId, 'running', runId)
      },
      onEnqueued: (conversationId) => {
        // run_id 仍指向当前 running；新入队项在 queued_run_ids。
        const active = this.activeRunByConversation.get(conversationId) ?? null
        this.emitRunSync(conversationId, 'queued', active)
      },
      onIdle: (conversationId) => {
        this.activeRunByConversation.delete(conversationId)
        this.emitRunSync(conversationId, 'idle', null)
        this.events.onIdle?.(conversationId)
      },
    })
  }

  private emitRunSync(
    conversationId: string,
    status: AgentRunSyncPayload['status'],
    runId: string | null,
  ): void {
    if (!this.events.onRunSync) return
    const nextSeq = (this.syncSeqByConversation.get(conversationId) ?? 0) + 1
    this.syncSeqByConversation.set(conversationId, nextSeq)
    const queuedRunIds = this.runQueue.queuedRunIds(conversationId)
    this.events.onRunSync({
      session_id: conversationId,
      run_id: runId,
      status,
      seq: nextSeq,
      queued_run_ids: queuedRunIds,
    })
  }

  beginSubmit<Result>(
    submission: ConversationRunSubmission<Result>,
  ): ConversationRunSubmissionHandle<Result> {
    const admitted = this.admittedRuns.get(submission.runId)
    if (admitted) {
      if (admitted.conversationId !== submission.conversationId) {
        throw new Error(
          `Conversation run id reused across conversations: ${submission.runId}`,
        )
      }
      return admitted.handle as ConversationRunSubmissionHandle<Result>
    }
    if (this.quiescedConversationIds.has(submission.conversationId)) {
      throw new ConversationRunCancelledError(
        submission.conversationId,
        submission.runId,
      )
    }
    let result: Result | undefined
    let failure: unknown
    let didFail = false
    let wasQueued = false

    const submitted = this.runQueue.submit(
      submission.conversationId,
      submission.runId,
      async () => {
        if (wasQueued) submission.onDequeued?.()
        try {
          result = await submission.execute()
        } catch (error) {
          didFail = true
          failure = error
        }
      },
    )

    if (submitted.status === 'queued') {
      wasQueued = true
      submission.onQueued?.(submitted.position)
    }

    const completion = submitted.done.then(() => {
      if (submitted.wasCancelled()) {
        throw new ConversationRunCancelledError(
          submission.conversationId,
          submission.runId,
        )
      }
      if (didFail) throw failure
      return result as Result
    })

    const handle: ConversationRunSubmissionHandle<Result> = {
      acceptance: {
        status: submitted.status,
        position: submitted.position,
      },
      completion,
      wasCancelled: submitted.wasCancelled,
    }
    this.admittedRuns.set(submission.runId, {
      conversationId: submission.conversationId,
      handle: handle as ConversationRunSubmissionHandle<unknown>,
    })
    if (this.admittedRuns.size > ConversationRunCoordinator.ADMITTED_RUN_LIMIT) {
      const oldestRunId = this.admittedRuns.keys().next().value
      if (oldestRunId) this.admittedRuns.delete(oldestRunId)
    }
    return handle
  }

  async submit<Result>(
    submission: ConversationRunSubmission<Result>,
  ): Promise<Result> {
    return this.beginSubmit(submission).completion
  }

  hasAdmittedRun(runId: string): boolean {
    return this.admittedRuns.has(runId)
  }

  getState(conversationId: string): ConversationRunState {
    return {
      busy: this.runQueue.isBusy(conversationId),
      queuedRunIds: this.runQueue.queuedRunIds(conversationId),
    }
  }

  /**
   * 向新订阅者重放 Host 当前执行态。
   *
   * 只重放本进程确实见过的 conversation，避免 renderer 观察远程会话时由本机
   * Host 凭空发 idle。重放复用原单调 seq，不维护第二份执行态。
   */
  syncCurrentRunState(conversationId: string): boolean {
    const busy = this.runQueue.isBusy(conversationId)
    if (!busy && !this.syncSeqByConversation.has(conversationId)) return false

    const activeRunId = this.activeRunByConversation.get(conversationId) ?? null
    const queuedRunIds = this.runQueue.queuedRunIds(conversationId)
    const status: AgentRunSyncPayload['status'] = !busy
      ? 'idle'
      : queuedRunIds.length > 0
        ? 'queued'
        : 'running'
    this.emitRunSync(conversationId, status, activeRunId)
    return true
  }

  getBusyConversationIds(): string[] {
    return this.runQueue.busySessionIds()
  }

  /** 当前 conversation 正在执行的 runId；无 active 时 null。 */
  getActiveRunId(conversationId: string): string | null {
    return this.activeRunByConversation.get(conversationId) ?? null
  }

  cancelQueued(conversationId: string): string[] {
    const dropped = this.runQueue.clearQueued(conversationId)
    if (dropped.length > 0 && this.runQueue.isBusy(conversationId)) {
      const active = this.activeRunByConversation.get(conversationId) ?? null
      this.emitRunSync(conversationId, 'running', active)
    }
    return dropped
  }

  /**
   * 将排队中的 runId 提到队首并同步 run_sync（不清队、不 abort）。
   * 插队完整语义见 Supervisor.interruptAndPromote。
   */
  promoteQueued(conversationId: string, runId: string): boolean {
    const result = this.runQueue.promote(conversationId, runId)
    if (!result.promoted) return false
    if (this.runQueue.isBusy(conversationId)) {
      const active = this.activeRunByConversation.get(conversationId) ?? null
      this.emitRunSync(conversationId, active ? 'running' : 'queued', active)
    }
    return true
  }

  /** 取消单条排队（不 abort active）。 */
  cancelQueuedRun(conversationId: string, runId: string): boolean {
    const dropped = this.runQueue.dropQueued(conversationId, runId)
    if (!dropped) return false
    if (this.runQueue.isBusy(conversationId)) {
      const active = this.activeRunByConversation.get(conversationId) ?? null
      this.emitRunSync(conversationId, active ? 'running' : 'queued', active)
    } else {
      this.emitRunSync(conversationId, 'idle', null)
    }
    return true
  }

  quiesce(conversationId: string): string[] {
    this.quiescedConversationIds.add(conversationId)
    return this.cancelQueued(conversationId)
  }

  resume(conversationId: string): void {
    this.quiescedConversationIds.delete(conversationId)
  }

  clear(): void {
    this.quiescedConversationIds.clear()
    this.admittedRuns.clear()
    for (const conversationId of this.getBusyConversationIds()) {
      this.cancelQueued(conversationId)
    }
  }
}
