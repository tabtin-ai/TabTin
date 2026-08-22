/**
 * runtime-resource-factory.ts — the platform seam for
 * {@link RuntimeSessionLifecycle}.
 *
 * The lifecycle owns *when* to reuse / soft-reconfigure / hard-rebuild a runtime
 * session, *what order* to tear resources down in, registry ownership, owner
 * scope quiescing, and carry-forward isolation. The platform only implements
 * this factory: *how* to construct or release the platform objects behind a
 * session (tool provider, permission handler, native backend, storage bundle),
 * plus the owner-scoped resource disposal.
 *
 * Rules (enforced by boundary tests):
 *  - No method here may decide cache hits, call order, soft-vs-hard rebuild,
 *    registry writes, or carry-forward policy.
 *  - No `createRuntime()` catch-all that hands orchestration back to the adapter.
 */

import type { ConversationLifecycleIdentity } from '../conversation/conversation-identity.js'
import type { ExecutionOwner } from './execution-owner-lifecycle.js'
import type {
  RuntimeBuildContext,
  RuntimeSessionRequest,
} from './runtime-session-factory.js'
import type { RuntimeCacheKey } from './runtime-cache-key.js'

/**
 * Platform resource factory + owner-teardown seam for a session bag `Session`.
 *
 * This is the union of the two adapter shapes the shared runtime state machine
 * already needs — build/reuse projection (formerly `RuntimeSessionFactoryAdapter`)
 * and owner teardown (formerly `ExecutionOwnerLifecycleAdapter`) — collapsed into
 * a single platform port so a host wires runtime concerns exactly once.
 */
export interface RuntimeResourceFactory<
  Input,
  Session,
  Mode extends string,
  CarryForward = never,
  ExtraKey = never,
> {
  // ── Build / reconfigure / rebuild (resource construction only) ──
  build(context: RuntimeBuildContext<Input, Mode, CarryForward>): Promise<Session>
  softReconfigure?(
    existing: Session,
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
  ): Promise<void>
  teardownForRebuild?(
    existing: Session,
    carryForward: CarryForward | undefined,
  ): Promise<void>

  // ── Pure projections used by the reuse decision (no side effects) ──
  getMode(session: Session): Mode
  setMode(session: Session, mode: Mode): void
  getCacheKey(session: Session): RuntimeCacheKey
  getExtraKey?(session: Session): ExtraKey | undefined
  extraKeysMatch?(existing: ExtraKey | undefined, requested: ExtraKey | undefined): boolean
  canSoftReconfigure?(
    existing: Session,
    request: RuntimeSessionRequest<Input, Mode, ExtraKey>,
  ): boolean
  captureCarryForward?(existing: Session): CarryForward

  // ── Owner-scoped teardown (lifecycle drives order, factory releases) ──
  getOwner(session: Session): ExecutionOwner
  getConversationIdentity(
    sessionId: string,
    session: Session,
  ): ConversationLifecycleIdentity
  interruptSession(sessionId: string, session: Session): Promise<void>
  teardownSession(sessionId: string, session: Session): Promise<void>
  disposeOwnerResources(owner: ExecutionOwner): Promise<void>
}

/** Result of acquiring a runtime session for one turn. */
export interface RuntimeSessionHandle<Session> {
  decision: 'reuse' | 'soft-reconfigure' | 'rebuild'
  session: Session
}
