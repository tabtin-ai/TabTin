import {
  createRuntimeCacheKey,
  runtimeCacheKeysMatch,
  type CreateRuntimeCacheKeyInput,
  type RuntimeCacheKey,
} from './runtime-cache-key.js'
import { executionOwnerScopeId } from './execution-owner-lifecycle.js'
import { decideRuntimeReuse, type RuntimeReuseDecision } from './runtime-reuse-policy.js'
import { RuntimeSessionRegistry } from './runtime-session-registry.js'

export interface RuntimeSessionRequest<Input, Mode extends string, ExtraKey> {
  sessionId: string
  mode: Mode
  cacheKey: CreateRuntimeCacheKeyInput
  extraKey?: ExtraKey
  input: Input
}

export interface RuntimeBuildContext<Input, Mode extends string, CarryForward> {
  sessionId: string
  mode: Mode
  cacheKey: RuntimeCacheKey
  input: Input
  carryForward: CarryForward | undefined
}

/**
 * Session bag accessors. Hosts store HostState / DaemonHostState directly in the
 * shared {@link RuntimeSessionRegistry}; the factory never wraps a second map.
 */
export interface RuntimeSessionFactoryAdapter<
  Input,
  Session,
  Mode extends string,
  CarryForward,
  ExtraKey,
> {
  build(context: RuntimeBuildContext<Input, Mode, CarryForward>): Promise<Session>
  getMode(session: Session): Mode
  setMode(session: Session, mode: Mode): void
  /** Project baked cache-key fields from the stored session for match / scope. */
  getCacheKey(session: Session): RuntimeCacheKey
  getExtraKey?(session: Session): ExtraKey | undefined
  softReconfigure?(
    existing: Session,
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
  ): Promise<void>
  canSoftReconfigure?(
    existing: Session,
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
  ): boolean
  captureCarryForward?(existing: Session): CarryForward
  teardownForRebuild?(
    existing: Session,
    carryForward: CarryForward | undefined,
  ): Promise<void>
  extraKeysMatch?(existing: ExtraKey | undefined, requested: ExtraKey | undefined): boolean
}

export interface RuntimeSessionResolution<Session> {
  decision: RuntimeReuseDecision['kind']
  session: Session
}

/** @deprecated Prefer Session as the registry value; kept for test/helpers. */
export interface RuntimeSessionRecord<Runtime, State, Mode extends string, ExtraKey> {
  runtime: Runtime
  state: State
  cacheKey: RuntimeCacheKey
  mode: Mode
  extraKey: ExtraKey | undefined
}

export class RuntimeOwnerQuiescedError extends Error {
  constructor(readonly scopeId: string) {
    super(`Runtime owner scope is quiesced: ${scopeId}`)
    this.name = 'RuntimeOwnerQuiescedError'
  }
}

/**
 * Serializes per-session runtime resolution and owns the reuse,
 * soft-reconfigure and rebuild state machine over a shared session registry.
 */
export class RuntimeSessionFactory<
  Input,
  Session,
  Mode extends string,
  CarryForward = never,
  ExtraKey = never,
> {
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly pendingCarryForward = new Map<
    string,
    { scopeId: string; value: CarryForward }
  >()
  private readonly quiescedScopeIds = new Set<string>()
  private readonly activeScopeCounts = new Map<string, number>()
  private readonly scopeIdleWaiters = new Map<string, Set<() => void>>()

  constructor(
    private readonly adapter: RuntimeSessionFactoryAdapter<
      Input,
      Session,
      Mode,
      CarryForward,
      ExtraKey
    >,
    readonly sessions: RuntimeSessionRegistry<Session> = new RuntimeSessionRegistry<Session>(),
  ) {}

  resolve(
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
  ): Promise<RuntimeSessionResolution<Session>> {
    const requestSnapshot = snapshotRequest(request)
    const scopeId = executionOwnerScopeId(requestSnapshot.cacheKey.owner)
    if (this.quiescedScopeIds.has(scopeId)) {
      return Promise.reject(new RuntimeOwnerQuiescedError(scopeId))
    }
    this.activeScopeCounts.set(
      scopeId,
      (this.activeScopeCounts.get(scopeId) ?? 0) + 1,
    )
    return this.runExclusive(
      requestSnapshot.sessionId,
      () => this.resolveExclusive(requestSnapshot, scopeId),
    ).finally(() => this.releaseScope(scopeId))
  }

  quiesceScope(scopeId: string): void {
    this.quiescedScopeIds.add(scopeId)
  }

  restoreScope(scopeId: string): void {
    this.quiescedScopeIds.delete(scopeId)
  }

  waitForScopeIdle(scopeId: string): Promise<void> {
    if ((this.activeScopeCounts.get(scopeId) ?? 0) === 0) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      const waiters = this.scopeIdleWaiters.get(scopeId) ?? new Set()
      waiters.add(resolve)
      this.scopeIdleWaiters.set(scopeId, waiters)
    })
  }

  private async resolveExclusive(
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
    scopeId: string,
  ): Promise<RuntimeSessionResolution<Session>> {
    const cacheKey = createRuntimeCacheKey(request.cacheKey)
    const existing = this.sessions.get(request.sessionId)
    const existingExtra = existing
      ? this.adapter.getExtraKey?.(existing)
      : undefined
    const extraKeysMatch = this.adapter.extraKeysMatch
      ? this.adapter.extraKeysMatch(existingExtra, request.extraKey)
      : Object.is(existingExtra, request.extraKey)
    const softReconfigureAllowed = !!existing
      && !!this.adapter.softReconfigure
      && (this.adapter.canSoftReconfigure?.(existing, request) ?? true)
    const decision = decideRuntimeReuse({
      hasExisting: !!existing,
      bakedFieldsMatch: !!existing
        && runtimeCacheKeysMatch(this.adapter.getCacheKey(existing), cacheKey),
      agentModeMatches: !!existing && this.adapter.getMode(existing) === request.mode,
      softReconfigureAllowed,
      extraFieldsMatch: extraKeysMatch,
    })

    if (decision.kind === 'reuse') {
      return { decision: decision.kind, session: existing! }
    }

    if (decision.kind === 'soft-reconfigure') {
      await this.adapter.softReconfigure!(existing!, request)
      this.adapter.setMode(existing!, request.mode)
      return { decision: decision.kind, session: existing! }
    }

    const pendingCarryForward = this.pendingCarryForward.get(request.sessionId)
    if (pendingCarryForward && pendingCarryForward.scopeId !== scopeId) {
      this.pendingCarryForward.delete(request.sessionId)
    }
    let carryForward = pendingCarryForward?.scopeId === scopeId
      ? pendingCarryForward.value
      : undefined
    if (existing) {
      const existingScopeId = executionOwnerScopeId(
        this.adapter.getCacheKey(existing).owner,
      )
      carryForward = existingScopeId === scopeId
        ? this.adapter.captureCarryForward?.(existing)
        : undefined
      await this.adapter.teardownForRebuild?.(existing, carryForward)
      if (this.sessions.get(request.sessionId) === existing) {
        this.sessions.delete(request.sessionId)
      }
      if (carryForward !== undefined) {
        this.pendingCarryForward.set(request.sessionId, {
          scopeId,
          value: carryForward,
        })
      }
    }

    const session = await this.adapter.build({
      sessionId: request.sessionId,
      mode: request.mode,
      cacheKey,
      input: request.input,
      carryForward,
    })
    this.sessions.set(request.sessionId, session)
    this.pendingCarryForward.delete(request.sessionId)
    return { decision: decision.kind, session }
  }

  private async runExclusive<Result>(
    sessionId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const prior = this.operationTails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    this.operationTails.set(sessionId, tail)
    await prior
    try {
      return await operation()
    } finally {
      release()
      if (this.operationTails.get(sessionId) === tail) {
        this.operationTails.delete(sessionId)
      }
    }
  }

  private releaseScope(scopeId: string): void {
    const remaining = (this.activeScopeCounts.get(scopeId) ?? 1) - 1
    if (remaining > 0) {
      this.activeScopeCounts.set(scopeId, remaining)
      return
    }
    this.activeScopeCounts.delete(scopeId)
    const waiters = this.scopeIdleWaiters.get(scopeId)
    this.scopeIdleWaiters.delete(scopeId)
    for (const resolve of waiters ?? []) resolve()
  }
}

function snapshotRequest<Input, Mode extends string, ExtraKey>(
  request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
): RuntimeSessionRequest<Input, Mode, ExtraKey> {
  return {
    ...request,
    cacheKey: {
      ...request.cacheKey,
      owner: { ...request.cacheKey.owner },
      operationSwitches: request.cacheKey.operationSwitches
        ? { ...request.cacheKey.operationSwitches }
        : undefined,
      enabledApps: request.cacheKey.enabledApps?.map(app => ({ ...app })),
    },
  }
}
