import type { AgentRunSyncPayload } from '@tabtin/agent-wire'
import {
  ConversationRunCancelledError,
  ConversationRunCoordinator,
  type ConversationRunState,
  type ConversationRunSubmission,
  type ConversationRunSubmissionHandle,
} from './conversation-run-coordinator.js'
import { HumanInteractionRegistry } from '../interaction/human-interaction-registry.js'
import type { ConversationLifecycleIdentity } from './conversation-identity.js'

export interface ConversationQuery<Request> extends ConversationLifecycleIdentity {
  runId: string
  lifecycleScopeId: string
  interruptScopeId?: string
  interruptActive?: boolean
  request: Request
}

export interface ConversationExecutionContext
  extends ConversationLifecycleIdentity {
  runId: string
  signal: AbortSignal
}

export interface ConversationSupervisorAdapter<Request, Result> {
  execute(
    request: Request,
    context: ConversationExecutionContext,
  ): Promise<Result>
  onQueued?(query: ConversationQuery<Request>, position: number): void
  onDequeued?(query: ConversationQuery<Request>): void
}

export interface ConversationExecutionState {
  running: boolean
  busy: boolean
  queuedRunIds: string[]
}

const DEFERRED_ADAPTER: ConversationSupervisorAdapter<unknown, never> = {
  execute: () => {
    throw new Error('ConversationSupervisor adapter not bound')
  },
}

export interface ConversationSupervisorHooks {
  /**
   * run queue 真正转 idle（slot 已释放、队列已空）后触发。典型用途：push 通知
   * drain 的补 schedule——turn 收尾时（onTurnFinally）排的 drain 会赶在 slot
   * 释放前被 isBusy 闸吞掉，必须等 idle 后重排。
   */
  onIdle?(conversationId: string): void
  /**
   * ：执行态独立同步（每 session 单调 seq）。前端只镜像本事件改 busy，
   * 不得从 lifecycle / terminal / 乐观发送路径推断。
   */
  onRunSync?(payload: AgentRunSyncPayload): void
}

/**
 * The single source of truth for one host's conversation lifecycle: the FIFO
 * run queue, owner-scope quiescing, active-run cancellation, pending-interaction
 * cleanup, and execution cleanup. Every host holds exactly one instance; the
 * FIFO queue and scope maps live here (previously in the now-removed host
 * coordinator) so busy / queue / scope state has one owner.
 *
 * The session registry and the human-interaction registry are owned by the host
 * (`AgentHost`) and shared in; the supervisor references the interaction
 * registry so aborting / quiescing a conversation also cancels its pending HITL.
 */
export class ConversationSupervisor<Request, Result, SessionState = unknown> {
  private readonly conversationRuns: ConversationRunCoordinator
  private readonly conversationScopeIds = new Map<string, string>()
  private readonly scopeConversationIds = new Map<string, Set<string>>()
  private readonly quiescedScopeIds = new Set<string>()
  private readonly quiescedScopeConversationIds = new Map<string, Set<string>>()
  private readonly scopeIdleWaiters = new Map<string, Set<() => void>>()

  private readonly activeRuns = new Map<
    string,
    {
      sessionId: string
      interruptScopeId?: string
      abortController: AbortController
    }
  >()
  private readonly queuedRunSessions = new Map<string, Map<string, string>>()
  /** 仅高优先级窗口存在时使用；普通空闲跨会话 run 不进入该队列。 */
  private readonly interruptScopeRuns = new ConversationRunCoordinator()
  private readonly activeInterruptScopeIds = new Set<string>()
  private readonly queuedInterruptScopeRuns = new Map<
    string,
    { sessionId: string; scopeId: string; runId: string }
  >()

  private adapter: ConversationSupervisorAdapter<Request, Result>

  constructor(
    adapter: ConversationSupervisorAdapter<Request, Result> = DEFERRED_ADAPTER as ConversationSupervisorAdapter<Request, Result>,
    private readonly interactions = new HumanInteractionRegistry(),
    private readonly hooks: ConversationSupervisorHooks = {},
  ) {
    this.adapter = adapter
    this.conversationRuns = new ConversationRunCoordinator({
      onIdle: (conversationId) => {
        this.unbindConversationScope(conversationId)
        this.notify(() => this.hooks.onIdle?.(conversationId))
      },
      onRunSync: (payload) => {
        this.notify(() => this.hooks.onRunSync?.(payload))
      },
    })
  }

  /**
   * Late-bind the execution adapter. Used when a supervisor must exist before
   * the module that provides `execute` (e.g. the query pipeline needs the
   * supervisor for owner teardown wiring, then binds its own `runTurn`). Must be
   * called before the first {@link submit}.
   */
  bindAdapter(adapter: ConversationSupervisorAdapter<Request, Result>): void {
    this.adapter = adapter
  }

  // ─── FIFO run submission (single per-session serialization point) ─────

  /**
   * Submit an arbitrary execute closure through the FIFO run queue with owner
   * scope quiescing. Bypass paths (compact 旁路) and the facade `submitRun` use
   * this directly; {@link submit} wraps it for the query path.
   */
  beginSubmitRun<R>(
    submission: ConversationRunSubmission<R>,
  ): ConversationRunSubmissionHandle<R> {
    const scopeId = submission.lifecycleScopeId
    if (scopeId) {
      if (this.quiescedScopeIds.has(scopeId)) {
        throw new ConversationRunCancelledError(
          submission.conversationId,
          submission.runId,
        )
      }
      this.bindConversationScope(submission.conversationId, scopeId)
    }
    return this.conversationRuns.beginSubmit(submission)
  }

  submitRun<R>(submission: ConversationRunSubmission<R>): Promise<R> {
    return this.beginSubmitRun(submission).completion
  }

  hasAdmittedRun(runId: string): boolean {
    return this.conversationRuns.hasAdmittedRun(runId)
  }

  getRunState(conversationId: string): ConversationRunState {
    return this.conversationRuns.getState(conversationId)
  }

  syncCurrentRunState(conversationId: string): boolean {
    return this.conversationRuns.syncCurrentRunState(conversationId)
  }

  getBusyConversationIds(): string[] {
    return this.conversationRuns.getBusyConversationIds()
  }

  private buildQuerySubmission(
    query: ConversationQuery<Request>,
  ): ConversationRunSubmission<Result> {
    return {
      conversationId: query.conversationId,
      lifecycleScopeId: query.lifecycleScopeId,
      runId: query.runId,
      onQueued: (position) => {
        const queuedRuns =
          this.queuedRunSessions.get(query.conversationId) ?? new Map()
        queuedRuns.set(query.runId, query.sessionId)
        this.queuedRunSessions.set(query.conversationId, queuedRuns)
        this.notify(() => this.adapter.onQueued?.(query, position))
      },
      onDequeued: () => {
        this.removeQueuedRun(query)
        this.notify(() => this.adapter.onDequeued?.(query))
      },
      execute: () => this.executeQuery(query),
    }
  }

  private executeQuery(query: ConversationQuery<Request>): Promise<Result> {
    const execute = async () => {
      const abortController = new AbortController()
      const activeRun = {
        sessionId: query.sessionId,
        interruptScopeId: query.interruptScopeId,
        abortController,
      }
      this.activeRuns.set(query.conversationId, activeRun)
      try {
        return await this.adapter.execute(query.request, {
          conversationId: query.conversationId,
          sessionId: query.sessionId,
          runId: query.runId,
          signal: abortController.signal,
        })
      } finally {
        this.removeQueuedRun(query)
        if (this.activeRuns.get(query.conversationId) === activeRun) {
          this.activeRuns.delete(query.conversationId)
        }
      }
    }

    const scopeId = query.interruptScopeId
    if (!scopeId || (!query.interruptActive && !this.activeInterruptScopeIds.has(scopeId))) {
      return execute()
    }

    if (query.interruptActive) this.activeInterruptScopeIds.add(scopeId)
    const queuedRun = {
      sessionId: query.sessionId,
      scopeId,
      runId: query.runId,
    }
    const handle = this.interruptScopeRuns.beginSubmit({
      conversationId: scopeId,
      runId: query.runId,
      onQueued: () => {
        this.queuedInterruptScopeRuns.set(query.conversationId, queuedRun)
      },
      onDequeued: () => {
        this.removeQueuedInterruptScopeRun(query.conversationId, query.runId)
      },
      execute,
    })
    if (query.interruptActive && handle.acceptance.status === 'queued') {
      this.interruptScopeRuns.promoteQueued(scopeId, query.runId)
    }
    return handle.completion.finally(() => {
      this.removeQueuedInterruptScopeRun(query.conversationId, query.runId)
      if (!this.interruptScopeRuns.getState(scopeId).busy) {
        this.activeInterruptScopeIds.delete(scopeId)
      }
    })
  }

  beginSubmit(
    query: ConversationQuery<Request>,
  ): ConversationRunSubmissionHandle<Result> {
    if (query.interruptActive && query.interruptScopeId) {
      for (const [conversationId, active] of this.activeRuns) {
        if (
          active.interruptScopeId === query.interruptScopeId
        ) {
          this.interactions.cancelConversation(
            conversationId,
            'Pending interaction cancelled because the Agent query was interrupted.',
          )
          if (active.sessionId !== conversationId) {
            this.interactions.cancelConversation(
              active.sessionId,
              'Pending interaction cancelled because the Agent query was interrupted.',
            )
          }
          active.abortController.abort()
        }
      }
    }
    const handle = this.beginSubmitRun(this.buildQuerySubmission(query))
    if (
      query.interruptActive
      && query.interruptScopeId
      && handle.acceptance.status === 'queued'
    ) {
      this.interruptAndPromote(query, query.runId)
    }
    return handle
  }

  submit(query: ConversationQuery<Request>): Promise<Result> {
    return this.beginSubmit(query).completion
  }

  abort(identity: ConversationLifecycleIdentity): string[] {
    const cancelledRunIds = this.canCancelWholeQueue(identity)
      ? this.abortConversationRuns(identity)
      : this.cancelInteraction(identity, 'aborted')
    this.removeCancelledRuns(identity.conversationId, cancelledRunIds)
    this.abortActiveRun(identity)
    return cancelledRunIds
  }

  /**
   * Host 级插队：把指定排队 run 提到队首，并 abort 当前 active。
   * **不清队**——其它排队项保持相对顺序（区别于 abort + clearQueued）。
   */
  interruptAndPromote(
    identity: ConversationLifecycleIdentity,
    runId: string,
  ): {
    promoted: boolean
    abortedActive: boolean
    /** ：被掐断的 active runId；无 active 时 null。 */
    abortedRunId: string | null
    queuedRunIds: string[]
  } {
    const promoted = this.conversationRuns.promoteQueued(identity.conversationId, runId)
    if (!promoted) {
      return {
        promoted: false,
        abortedActive: false,
        abortedRunId: null,
        queuedRunIds: this.getRunState(identity.conversationId).queuedRunIds,
      }
    }
    this.cancelInteraction(identity, 'aborted')
    const abortedRunId = this.conversationRuns.getActiveRunId(identity.conversationId)
    const abortedActive = this.activeRuns.has(identity.conversationId)
    this.abortActiveRun(identity)
    return {
      promoted: true,
      abortedActive,
      abortedRunId: abortedActive ? abortedRunId : null,
      queuedRunIds: this.getRunState(identity.conversationId).queuedRunIds,
    }
  }

  /**
   * 取消单条排队（抽屉移除 / 撤回编辑）。不 abort active、不动其它排队项。
   */
  cancelQueuedRun(
    identity: ConversationLifecycleIdentity,
    runId: string,
  ): { cancelled: boolean; queuedRunIds: string[] } {
    const cancelled = this.conversationRuns.cancelQueuedRun(identity.conversationId, runId)
    if (cancelled) {
      this.removeCancelledRuns(identity.conversationId, [runId])
    }
    return {
      cancelled,
      queuedRunIds: this.getRunState(identity.conversationId).queuedRunIds,
    }
  }

  quiesce(identity: ConversationLifecycleIdentity): string[] {
    const cancelledRunIds = this.canCancelWholeQueue(identity)
      ? this.quiesceConversation(identity)
      : this.cancelInteraction(identity, 'disposed')
    this.removeCancelledRuns(identity.conversationId, cancelledRunIds)
    this.abortActiveRun(identity)
    return cancelledRunIds
  }

  /**
   * Cancel queued runs + pending interactions only.
   * Does not abort the active run — {@link abort} calls this then `abortActiveRun`.
   */
  abortConversationRuns(identity: ConversationLifecycleIdentity): string[] {
    this.interactions.cancelConversation(
      identity.sessionId,
      'Pending interaction cancelled because the Agent query was aborted.',
    )
    return this.conversationRuns.cancelQueued(identity.conversationId)
  }

  quiesceConversation(identity: ConversationLifecycleIdentity): string[] {
    this.interactions.cancelConversation(
      identity.sessionId,
      'Pending interaction cancelled because the Agent session is being disposed.',
    )
    return this.conversationRuns.quiesce(identity.conversationId)
  }

  restore(conversationId: string): void {
    this.conversationRuns.resume(conversationId)
  }

  quiesceScope(scopeId: string): void {
    this.quiescedScopeIds.add(scopeId)
    const conversationIds = new Set(this.scopeConversationIds.get(scopeId) ?? [])
    this.quiescedScopeConversationIds.set(scopeId, conversationIds)
    for (const conversationId of conversationIds) {
      this.conversationRuns.quiesce(conversationId)
    }
  }

  restoreScope(scopeId: string): void {
    this.quiescedScopeIds.delete(scopeId)
    const conversationIds = this.quiescedScopeConversationIds.get(scopeId)
    this.quiescedScopeConversationIds.delete(scopeId)
    for (const conversationId of conversationIds ?? []) {
      this.conversationRuns.resume(conversationId)
    }
  }

  waitForScopeIdle(scopeId: string): Promise<void> {
    if ((this.scopeConversationIds.get(scopeId)?.size ?? 0) === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const waiters = this.scopeIdleWaiters.get(scopeId) ?? new Set()
      waiters.add(resolve)
      this.scopeIdleWaiters.set(scopeId, waiters)
    })
  }

  getState(conversationId: string): ConversationExecutionState {
    const state = this.getRunState(conversationId)
    return {
      running: this.activeRuns.has(conversationId),
      busy: state.busy,
      queuedRunIds: state.queuedRunIds,
    }
  }

  /** Release the FIFO queue and scope bookkeeping (host stop). */
  dispose(): void {
    this.conversationRuns.clear()
    this.interruptScopeRuns.clear()
    this.conversationScopeIds.clear()
    this.scopeConversationIds.clear()
    this.quiescedScopeIds.clear()
    this.quiescedScopeConversationIds.clear()
    for (const waiters of this.scopeIdleWaiters.values()) {
      for (const resolve of waiters) resolve()
    }
    this.scopeIdleWaiters.clear()
    this.activeInterruptScopeIds.clear()
    this.queuedInterruptScopeRuns.clear()
  }

  private abortActiveRun(identity: ConversationLifecycleIdentity): void {
    this.cancelQueuedInterruptScopeRun(identity)
    const primary = this.activeRuns.get(identity.conversationId)
    if (primary) {
      // 常规：sessionId 对齐。Map-miss 兜底：identity 两字段同为业务 sessionId
      // （Electron handleAbort 在 sessions Map 尚未登记时使用），此时 activeRun
      // 的 sessionId 可能是 task_id，仍须掐断该 conversation 的在途 run。
      if (
        primary.sessionId === identity.sessionId
        || identity.sessionId === identity.conversationId
      ) {
        primary.abortController.abort()
      }
    }
    // conversation 键与入参不一致时，仅按 activeRun.sessionId 命中——禁止用
    // conversationId === identity.sessionId 宽松扫表，避免误掐其它会话。
    for (const [conversationId, run] of this.activeRuns) {
      if (conversationId === identity.conversationId) continue
      if (run.sessionId === identity.sessionId) {
        run.abortController.abort()
      }
    }
  }

  private canCancelWholeQueue(identity: ConversationLifecycleIdentity): boolean {
    const queuedRuns = this.queuedRunSessions.get(identity.conversationId)
    return [...queuedRuns?.values() ?? []]
      .every(sessionId => sessionId === identity.sessionId)
  }

  private cancelInteraction(
    identity: ConversationLifecycleIdentity,
    reason: 'aborted' | 'disposed',
  ): string[] {
    this.interactions.cancelConversation(
      identity.sessionId,
      reason === 'aborted'
        ? 'Pending interaction cancelled because the Agent query was aborted.'
        : 'Pending interaction cancelled because the Agent session is being disposed.',
    )
    return []
  }

  private removeQueuedRun(query: ConversationQuery<Request>): void {
    const queuedRuns = this.queuedRunSessions.get(query.conversationId)
    queuedRuns?.delete(query.runId)
    if (queuedRuns?.size === 0) {
      this.queuedRunSessions.delete(query.conversationId)
    }
  }

  private removeQueuedInterruptScopeRun(
    conversationId: string,
    runId: string,
  ): void {
    if (this.queuedInterruptScopeRuns.get(conversationId)?.runId === runId) {
      this.queuedInterruptScopeRuns.delete(conversationId)
    }
  }

  private cancelQueuedInterruptScopeRun(
    identity: ConversationLifecycleIdentity,
  ): void {
    const cancel = (conversationId: string) => {
      const queued = this.queuedInterruptScopeRuns.get(conversationId)
      if (!queued) return
      if (
        queued.sessionId !== identity.sessionId
        && identity.sessionId !== identity.conversationId
      ) {
        return
      }
      this.interruptScopeRuns.cancelQueuedRun(queued.scopeId, queued.runId)
      this.queuedInterruptScopeRuns.delete(conversationId)
      if (!this.interruptScopeRuns.getState(queued.scopeId).busy) {
        this.activeInterruptScopeIds.delete(queued.scopeId)
      }
    }

    cancel(identity.conversationId)
    for (const [conversationId, queued] of this.queuedInterruptScopeRuns) {
      if (
        conversationId !== identity.conversationId
        && queued.sessionId === identity.sessionId
      ) {
        cancel(conversationId)
      }
    }
  }

  private removeCancelledRuns(
    conversationId: string,
    cancelledRunIds: string[],
  ): void {
    const queuedRuns = this.queuedRunSessions.get(conversationId)
    for (const runId of cancelledRunIds) queuedRuns?.delete(runId)
    if (queuedRuns?.size === 0) {
      this.queuedRunSessions.delete(conversationId)
    }
  }

  private bindConversationScope(conversationId: string, scopeId: string): void {
    const existingScopeId = this.conversationScopeIds.get(conversationId)
    if (existingScopeId && existingScopeId !== scopeId) {
      throw new Error(
        `Conversation ${conversationId} is already active in lifecycle scope ${existingScopeId}`,
      )
    }
    this.conversationScopeIds.set(conversationId, scopeId)
    const conversationIds = this.scopeConversationIds.get(scopeId) ?? new Set()
    conversationIds.add(conversationId)
    this.scopeConversationIds.set(scopeId, conversationIds)
  }

  private unbindConversationScope(conversationId: string): void {
    const scopeId = this.conversationScopeIds.get(conversationId)
    if (!scopeId) return
    this.conversationScopeIds.delete(conversationId)
    const conversationIds = this.scopeConversationIds.get(scopeId)
    conversationIds?.delete(conversationId)
    if (conversationIds?.size === 0) {
      this.scopeConversationIds.delete(scopeId)
      const waiters = this.scopeIdleWaiters.get(scopeId)
      this.scopeIdleWaiters.delete(scopeId)
      for (const resolve of waiters ?? []) resolve()
    }
  }

  private notify(callback: () => void): void {
    try {
      callback()
    } catch {
      // Queue observers are best-effort and must never alter execution.
    }
  }
}
