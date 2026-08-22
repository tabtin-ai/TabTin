import { RuntimeSessionRegistry } from '../../runtime/runtime-session-registry.js'
import { ProvisionalSessionStore } from './provisional-session-store.js'

/**
 * Runtime session bag 权威容器（ Phase 2）。
 */
export class SessionStore<SessionState = unknown> {
  readonly registry: RuntimeSessionRegistry<SessionState>
  readonly provisional: ProvisionalSessionStore

  constructor(
    registry?: RuntimeSessionRegistry<SessionState>,
    provisional?: ProvisionalSessionStore,
  ) {
    this.registry = registry ?? new RuntimeSessionRegistry<SessionState>()
    this.provisional = provisional ?? new ProvisionalSessionStore()
  }
}
