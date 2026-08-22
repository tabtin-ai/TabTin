/**
 * runtime-session-lifecycle.ts — deep module that owns runtime/session
 * creation, reuse, soft-reconfigure, hard-rebuild, the single session registry,
 * owner-scope quiescing, and full teardown.
 *
 * It composes the existing shared state machines ({@link RuntimeSessionFactory}
 * for per-session serialized reuse/rebuild and {@link ExecutionOwnerLifecycle}
 * for owner replace/clear/dispose) behind one interface, so a host wires runtime
 * concerns exactly once and the platform never holds a `sessions` Map.
 *
 * Stage 1 exposes the frozen interface; the concrete class collapses the two
 * builders (factory adapter + owner adapter) that Electron/Daemon previously
 * duplicated into a single {@link RuntimeResourceFactory}.
 */

import type { ConversationLifecycleIdentity } from '../conversation/conversation-identity.js'
import type { ApprovalMode } from '@tabtin/security-policy'
import type { AgentModeName } from '@tabtin/agent-modes'
import type { ConversationSupervisor } from '../conversation/conversation-supervisor.js'
import {
  ExecutionOwnerLifecycle,
  type ExecutionOwner,
} from './execution-owner-lifecycle.js'
import {
  RuntimeSessionFactory,
  type RuntimeSessionRequest,
} from './runtime-session-factory.js'
import { RuntimeSessionRegistry } from './runtime-session-registry.js'
import type {
  RuntimeResourceFactory,
  RuntimeSessionHandle,
} from './runtime-resource-factory.js'

/**
 * In-place, no-rebuild policy mutation applied to a live session (approval mode
 * / agent mode / group flag). The platform IPC/wire layer only maps the values;
 * the lifecycle applies them so a live turn reads the newest authoritative
 * policy without a runtime rebuild.
 */
export interface LivePolicyUpdate {
  agentMode?: AgentModeName
  requestedApprovalMode?: ApprovalMode
  allowYolo?: boolean
  approvalGrant?: ApprovalMode
  isGroupSpace?: boolean
}

/**
 * Deep module interface. `Input`/`Mode`/`ExtraKey` are the platform runtime
 * request generics; `Session` is the platform session bag (e.g. `HostState`).
 */
export interface RuntimeSessionLifecycle<
  Input,
  Session,
  Mode extends string = AgentModeName,
  ExtraKey = never,
> {
  /** Query hot path — resolve (reuse / soft / rebuild) a session, serialized per sessionId. */
  acquire(
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
  ): Promise<RuntimeSessionHandle<Session>>

  /** Apply a live policy mutation without rebuilding the runtime. */
  updateLivePolicy(sessionId: string, update: LivePolicyUpdate): Promise<void>

  /** Abort + remove a single session (its runs and pending interactions). */
  disposeSession(identity: ConversationLifecycleIdentity): Promise<void>

  /** Owner replacement (account/agent switch) as one serialized transition. */
  replaceOwner(owner: ExecutionOwner): Promise<boolean>

  /** Explicit owner teardown (logout / account reset), scope restored after. */
  disposeOwner(owner: ExecutionOwner): Promise<void>

  /** Process-level shutdown: abort + release all sessions. */
  stop(): Promise<void>
}

/**
 * How a live-policy update is applied to a session bag. The platform / host wires
 * the concrete mutation (typically {@link applyAuthoritativeSecurityMutate}); the
 * lifecycle only decides *when* it runs and keeps the registry the single source.
 */
export type LivePolicyApplier<Session> = (
  session: Session,
  update: LivePolicyUpdate,
) => void | Promise<void>

export interface RuntimeSessionLifecycleOptions<
  Input,
  Session,
  Mode extends string,
  CarryForward,
  ExtraKey,
  Request,
  Result,
> {
  resources: RuntimeResourceFactory<Input, Session, Mode, CarryForward, ExtraKey>
  /** FIFO supervisor owned by QueryTurnPipeline; shared for owner-scope teardown. */
  supervisor: ConversationSupervisor<Request, Result, Session>
  /** The single session registry. Shared with the supervisor's coordinator. */
  sessions: RuntimeSessionRegistry<Session>
  /**
   * Reuse an existing {@link RuntimeSessionFactory} (its serialization locks +
   * owner-scope barrier) instead of creating a second one. Required when a
   * platform already owns a factory over the same registry (e.g. Electron's
   * assembly) — two factories over one registry would race per-session resolves.
   */
  factory?: RuntimeSessionFactory<Input, Session, Mode, CarryForward, ExtraKey>
  initialOwner?: ExecutionOwner
  applyLivePolicy?: LivePolicyApplier<Session>
}

/**
 * Default deep-module implementation: composes {@link RuntimeSessionFactory}
 * (per-session serialized reuse/soft/rebuild + owner-scope runtime barrier) and
 * {@link ExecutionOwnerLifecycle} (owner replace/clear/dispose two-phase
 * teardown) behind the {@link RuntimeSessionLifecycle} interface, over the single
 * shared {@link RuntimeSessionRegistry}.
 */
export class DefaultRuntimeSessionLifecycle<
  Input,
  Session,
  Mode extends string = AgentModeName,
  CarryForward = never,
  ExtraKey = never,
  Request = unknown,
  Result = unknown,
> implements RuntimeSessionLifecycle<Input, Session, Mode, ExtraKey> {
  readonly sessions: RuntimeSessionRegistry<Session>
  private readonly resources: RuntimeResourceFactory<Input, Session, Mode, CarryForward, ExtraKey>
  private readonly supervisor: ConversationSupervisor<Request, Result, Session>
  private readonly factory: RuntimeSessionFactory<Input, Session, Mode, CarryForward, ExtraKey>
  private readonly ownerLifecycle: ExecutionOwnerLifecycle<Request, Result, Session>
  private readonly applyLivePolicy?: LivePolicyApplier<Session>

  constructor(
    options: RuntimeSessionLifecycleOptions<
      Input,
      Session,
      Mode,
      CarryForward,
      ExtraKey,
      Request,
      Result
    >,
  ) {
    this.resources = options.resources
    this.supervisor = options.supervisor
    this.sessions = options.sessions ?? new RuntimeSessionRegistry<Session>()
    this.applyLivePolicy = options.applyLivePolicy
    this.factory = options.factory
      ?? new RuntimeSessionFactory<Input, Session, Mode, CarryForward, ExtraKey>(
        this.resources,
        this.sessions,
      )
    this.ownerLifecycle = new ExecutionOwnerLifecycle<Request, Result, Session>({
      supervisor: this.supervisor,
      sessions: this.sessions,
      runtimeBarrier: this.factory,
      adapter: this.resources,
      initialOwner: options.initialOwner,
    })
  }

  acquire(
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
  ): Promise<RuntimeSessionHandle<Session>> {
    return this.factory.resolve(request)
  }

  async updateLivePolicy(sessionId: string, update: LivePolicyUpdate): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !this.applyLivePolicy) return
    await this.applyLivePolicy(session, update)
  }

  async disposeSession(identity: ConversationLifecycleIdentity): Promise<void> {
    const session = this.sessions.get(identity.sessionId)
    this.supervisor.quiesce(identity)
    try {
      if (session) {
        await this.resources.interruptSession(identity.sessionId, session)
        await this.resources.teardownSession(identity.sessionId, session)
      }
    } finally {
      if (this.sessions.get(identity.sessionId) === session) {
        this.sessions.delete(identity.sessionId)
      }
      this.supervisor.restore(identity.conversationId)
    }
  }

  replaceOwner(owner: ExecutionOwner): Promise<boolean> {
    return this.ownerLifecycle.replace(owner)
  }

  disposeOwner(owner: ExecutionOwner): Promise<void> {
    return this.ownerLifecycle.disposeOwner(owner)
  }

  get owner(): ExecutionOwner | undefined {
    return this.ownerLifecycle.owner
  }

  /** Runtime barrier for owner teardown (the factory's scope quiesce/idle). */
  asRuntimeBarrier() {
    return this.factory
  }

  async stop(): Promise<void> {
    const currentOwner = this.ownerLifecycle.owner
    if (currentOwner) {
      await this.ownerLifecycle.clear(currentOwner)
    }
    // Best-effort teardown of any sessions that outlived owner tracking
    // (e.g. sessions created without an owner transition). Registry is the
    // single source; each entry is released exactly once.
    const remaining = [...this.sessions]
    for (const [sessionId, session] of remaining) {
      try {
        await this.resources.interruptSession(sessionId, session)
        await this.resources.teardownSession(sessionId, session)
      } finally {
        if (this.sessions.get(sessionId) === session) {
          this.sessions.delete(sessionId)
        }
      }
    }
  }
}
