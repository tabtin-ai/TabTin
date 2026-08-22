import type { ConversationLifecycleIdentity } from '../conversation/conversation-identity.js'
import type { ConversationSupervisor } from '../conversation/conversation-supervisor.js'
import type { OwnerStore } from '../state/owner/owner-store.js'
import { executionOwnerScopeId, type ExecutionOwner } from '../state/owner/owner-types.js'
import type { RuntimeSessionRegistry } from './runtime-session-registry.js'

export { executionOwnerScopeId } from '../state/owner/owner-types.js'
export type { ExecutionOwner } from '../state/owner/owner-types.js'

export interface ExecutionOwnerLifecycleAdapter<SessionState> {
  getOwner(session: SessionState): ExecutionOwner
  getConversationIdentity(
    sessionId: string,
    session: SessionState,
  ): ConversationLifecycleIdentity
  interruptSession(sessionId: string, session: SessionState): Promise<void>
  teardownSession(sessionId: string, session: SessionState): Promise<void>
  disposeOwnerResources(owner: ExecutionOwner): Promise<void>
}

export interface OwnerRuntimeBarrier {
  quiesceScope(scopeId: string): void
  restoreScope(scopeId: string): void
  waitForScopeIdle(scopeId: string): Promise<void>
}

export interface ExecutionOwnerLifecycleOptions<Request, Result, SessionState> {
  supervisor: ConversationSupervisor<Request, Result, SessionState>
  sessions: RuntimeSessionRegistry<SessionState>
  runtimeBarrier?: OwnerRuntimeBarrier
  adapter: ExecutionOwnerLifecycleAdapter<SessionState>
  initialOwner?: ExecutionOwner
  /** 权威 owner 投影；lifecycle 写、子域只读 */
  ownerStore?: OwnerStore
}

/**
 * Lifecycle scope shared by query runs, runtime factory barriers, and account
 * reset. Matches host `lifecycleScopeId` / outbox owner key: `userId|organizationId`.
 * `agentId` is not part of the barrier — account reset is org-scoped.
 */
/**
 * Owns account/agent replacement as one serialized transition. Stale clear
 * requests are ignored by exact owner snapshot matching.
 */
export class ExecutionOwnerLifecycle<Request, Result, SessionState> {
  private currentOwner: ExecutionOwner | undefined
  private transitionTail: Promise<void> = Promise.resolve()

  private readonly supervisor: ConversationSupervisor<Request, Result, SessionState>
  private readonly sessions: RuntimeSessionRegistry<SessionState>
  private readonly runtimeBarrier: OwnerRuntimeBarrier | undefined
  private readonly adapter: ExecutionOwnerLifecycleAdapter<SessionState>
  private readonly ownerStore: OwnerStore | undefined

  constructor(options: ExecutionOwnerLifecycleOptions<Request, Result, SessionState>) {
    this.supervisor = options.supervisor
    this.sessions = options.sessions
    this.runtimeBarrier = options.runtimeBarrier
    this.adapter = options.adapter
    this.ownerStore = options.ownerStore
    this.currentOwner = cloneOwner(options.initialOwner)
    this.syncOwnerStore()
  }

  private syncOwnerStore(): void {
    this.ownerStore?.setOwner(this.currentOwner)
  }

  private setCurrentOwner(owner: ExecutionOwner | undefined): void {
    this.currentOwner = owner
    this.syncOwnerStore()
  }

  get owner(): ExecutionOwner | undefined {
    return cloneOwner(this.currentOwner)
  }

  replace(nextOwner: ExecutionOwner): Promise<boolean> {
    const nextOwnerSnapshot = cloneOwner(nextOwner)!
    return this.enqueueTransition(async () => {
      if (this.currentOwner && ownersEqual(this.currentOwner, nextOwnerSnapshot)) {
        return false
      }
      await this.transitionFromCurrent(nextOwnerSnapshot)
      return true
    })
  }

  clear(expectedOwner: ExecutionOwner): Promise<boolean> {
    const expectedOwnerSnapshot = cloneOwner(expectedOwner)!
    return this.enqueueTransition(async () => {
      if (
        !this.currentOwner
        || !ownersEqual(this.currentOwner, expectedOwnerSnapshot)
      ) {
        return false
      }
      await this.transitionFromCurrent(undefined)
      return true
    })
  }

  /**
   * Run the standard teardown flow for `targetOwner` regardless of
   * `currentOwner`. Serialized on the same transition tail as
   * replace/clear. Intended for explicit "logout / reset account" flows
   * where the caller wants to reclaim resources tied to `targetOwner`
   * without having to bootstrap owner tracking beforehand.
   *
   * If `currentOwner` matches `targetOwner`, currentOwner is cleared at
   * the end (same as {@link clear}). Otherwise `currentOwner` is left as
   * is — this method only reasons about sessions and resources belonging
   * to `targetOwner`.
   *
   * Unlike `replace` / `clear`, the target scope is explicitly restored
   * after teardown so the same account can re-authenticate within the
   * same process (matches the legacy `resetAccountSync` finally block
   * behaviour on both Electron and Daemon).
   */
  disposeOwner(targetOwner: ExecutionOwner): Promise<void> {
    const targetSnapshot = cloneOwner(targetOwner)!
    return this.enqueueTransition(async () => {
      try {
        await this.runTeardown(targetSnapshot)
      } finally {
        const scopeId = executionOwnerScopeId(targetSnapshot)
        this.supervisor.restoreScope(scopeId)
        this.runtimeBarrier?.restoreScope(scopeId)
        if (this.currentOwner && ownersEqual(this.currentOwner, targetSnapshot)) {
          this.setCurrentOwner(undefined)
        }
      }
    })
  }

  private async transitionFromCurrent(
    nextOwner: ExecutionOwner | undefined,
  ): Promise<void> {
    const previousOwner = this.currentOwner
    if (!previousOwner) {
      this.setCurrentOwner(nextOwner)
      if (nextOwner) {
        const nextScopeId = executionOwnerScopeId(nextOwner)
        this.supervisor.restoreScope(nextScopeId)
        this.runtimeBarrier?.restoreScope(nextScopeId)
      }
      return
    }
    await this.runTeardown(previousOwner)
    this.setCurrentOwner(nextOwner)
    if (nextOwner) {
      const nextScopeId = executionOwnerScopeId(nextOwner)
      this.supervisor.restoreScope(nextScopeId)
      this.runtimeBarrier?.restoreScope(nextScopeId)
    }
  }

  /**
   * Two-phase teardown shared by owner replacement and {@link disposeOwner}:
   * quiesce scopes → interrupt in-flight sessions → wait for the scope to
   * idle → teardown any sessions (including ones that raced in) → dispose
   * owner-level platform resources. Errors are aggregated via
   * {@link runAll} so a single step failure doesn't skip the rest.
   */
  private async runTeardown(owner: ExecutionOwner): Promise<void> {
    if (!this.runtimeBarrier) {
      throw new Error(
        'ExecutionOwnerLifecycle requires a runtime barrier before tearing down an owner',
      )
    }

    const scopeId = executionOwnerScopeId(owner)
    this.supervisor.quiesceScope(scopeId)
    this.runtimeBarrier.quiesceScope(scopeId)
    const identities = new Map<string, ConversationLifecycleIdentity>()

    try {
      const sessionsBeforeIdle = this.findOwnedSessions(owner)
      for (const [sessionId, session] of sessionsBeforeIdle) {
        const identity = this.adapter.getConversationIdentity(sessionId, session)
        identities.set(identity.conversationId, identity)
        this.supervisor.quiesce(identity)
      }
      await runAll(
        sessionsBeforeIdle.map(([sessionId, session]) =>
          () => this.adapter.interruptSession(sessionId, session)),
      )
      await Promise.all([
        this.supervisor.waitForScopeIdle(scopeId),
        this.runtimeBarrier.waitForScopeIdle(scopeId),
      ])

      const sessionsToTeardown = this.findOwnedSessions(owner)
      for (const [sessionId, session] of sessionsToTeardown) {
        const identity = this.adapter.getConversationIdentity(sessionId, session)
        identities.set(identity.conversationId, identity)
        this.supervisor.quiesce(identity)
      }
      await runAll(
        sessionsToTeardown.map(([sessionId, session]) => async () => {
          await this.adapter.teardownSession(sessionId, session)
          if (this.sessions.get(sessionId) === session) {
            this.sessions.delete(sessionId)
          }
        }),
      )
      await this.adapter.disposeOwnerResources(owner)
    } finally {
      for (const identity of identities.values()) {
        this.supervisor.restore(identity.conversationId)
      }
    }
  }

  private findOwnedSessions(
    owner: ExecutionOwner,
  ): Array<[string, SessionState]> {
    return [...this.sessions].filter(([, session]) =>
      ownersEqual(this.adapter.getOwner(session), owner))
  }

  private enqueueTransition<Value>(
    transition: () => Promise<Value>,
  ): Promise<Value> {
    const result = this.transitionTail.then(transition)
    this.transitionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function ownersEqual(left: ExecutionOwner, right: ExecutionOwner): boolean {
  return left.userId === right.userId
    && left.organizationId === right.organizationId
    && (left.agentId ?? undefined) === (right.agentId ?? undefined)
}

async function runAll(steps: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(steps.map(step => step()))
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Execution owner lifecycle step failed')
  }
}

function cloneOwner(owner: ExecutionOwner | undefined): ExecutionOwner | undefined {
  return owner
    ? {
        userId: owner.userId,
        organizationId: owner.organizationId,
        agentId: owner.agentId,
      }
    : undefined
}
