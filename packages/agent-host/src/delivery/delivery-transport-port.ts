/**
 * delivery-transport-port.ts — the platform seam for {@link DeliveryCoordinator}.
 *
 * The coordinator owns batching, critical-flush, in-flight tracking, ACK/NAK
 * interpretation, `message_ids → MessagePersistedEvent` projection, memory retry,
 * durable outbox handoff, reconnect recover/backfill, owner bucketing, and the
 * terminal barrier. The platform only implements *how* to move one batch of WS
 * events, *how* to open a local viewer stream (Electron only), *where* durable
 * batches persist, and *how* to observe reconnect.
 *
 * Rules (enforced by boundary tests):
 *  - `sendRelayBatch` returns ACK data only; it does not create
 *    `MessagePersistedEvent`, retry, wait for terminal state, or touch the outbox.
 *  - `openLocalStream` returns undefined on headless (Daemon) hosts.
 */

import type { StreamEvent } from '@tabtin/agent-runtime'
import type { ExecutionOwner } from '../runtime/execution-owner-lifecycle.js'
import type { RelayAckResponse, RelayEvent } from './relay-transport.js'

/** Context for opening a per-turn local (in-process UI) stream. */
export interface LocalStreamContext {
  sessionId: string
  conversationId: string
}

/** A platform-provided local viewer stream (Electron `IpcStreamHost`). */
export interface LocalStreamPort {
  emit(event: StreamEvent): void
  fail(error: Error): void
  close(reason: 'completed' | 'aborted'): void
  /** True when the viewer is gone and the run should stop iterating. */
  shouldAbortIteration(): boolean
}

/** Context for a relay batch send. */
export interface RelayContext {
  sessionId: string
  owner?: ExecutionOwner
  organizationId: string
  /** Coarse purpose tag for platform logging/metrics only. */
  purpose: 'query' | 'terminal' | 'recover' | 'backfill'
  timeoutMs?: number
}

/** ACK returned by the platform transport (no interpretation applied here). */
export interface RelayTransportAck {
  /** Undefined / empty response is treated as success (legacy gateway compat). */
  ack?: RelayAckResponse
  /** Django-returned message ids, used by the coordinator for persisted projection. */
  messageIds?: string[]
}

/** Durable, owner-bucketed store for relay batches whose memory retries exhausted. */
export interface DurableOutboxStore {
  persist(sessionId: string, events: RelayEvent[]): Promise<void> | void
  drain(): AsyncIterable<{ sessionId: string; events: RelayEvent[] }>
  remove(sessionId: string, events: RelayEvent[]): Promise<void> | void
}

/** The only transport seam the coordinator depends on. */
export interface DeliveryTransportPort {
  /** Open a local viewer stream, or undefined on headless hosts. */
  openLocalStream(context: LocalStreamContext): LocalStreamPort | undefined
  /** Send one batch of relay events. Throws on failure; ACK returned on success. */
  sendRelayBatch(context: RelayContext, events: RelayEvent[]): Promise<RelayTransportAck>
  /** Owner-scoped durable store for exhausted batches. */
  createOutboxStore(owner: ExecutionOwner): DurableOutboxStore
  /** Subscribe to transport reconnect; returns an unsubscribe. */
  subscribeReconnect(listener: () => void): () => void
}
