/**
 * delivery-coordinator.ts — deep module that owns event delivery end-to-end:
 * local publish + relay fork, `client_event_id/trace_id` correlation, event /
 * session / snapshot persistence ordering, critical-flush + batch thresholds,
 * in-flight ACK tracking, ACK/NAK interpretation, `message_ids →
 * MessagePersistedEvent`, memory retry, durable outbox handoff, reconnect
 * recover/backfill, owner bucketing, and the terminal barrier.
 *
 * `QueryTurnPipeline` never learns whether a host has a UI: it opens a
 * {@link DeliveryTurn} and emits; the coordinator decides local-vs-relay and
 * whether an ACK produces a persisted event. The platform only implements
 * {@link DeliveryTransportPort}.
 */

import type { StreamEvent } from '@tabtin/agent-runtime'
import type { ExecutionOwner } from '../runtime/execution-owner-lifecycle.js'
import type { HostQueryOutcome } from '../conversation/host-query.js'
import { DeliveryBatchBuffer } from './delivery-batch-buffer.js'
import { correlateSourceClientEvent } from './source-event-correlation.js'
import { projectLlmSnapshotDeliveryEvent } from './llm-snapshot-projection.js'
import { shouldPersistInParentSession } from './local-event-persistence-policy.js'
import { projectRelayMessageEvent } from './relay-message-projection.js'
import { isRelayTransientEvent } from './relay-transient-events.js'
import { routeDeliveryEvent, type DeliveryEventSource } from './delivery-event-routing.js'
import type {
  DeliveryTransportPort,
  LocalStreamPort,
  RelayContext,
} from './delivery-transport-port.js'
import type { RelayEvent } from './relay-transport.js'

/** Owner scope key (userId|organizationId). */
export type OwnerScope = string

/**
 * Session-owned persistence sinks. Storage lives on the session bag; the
 * coordinator owns *ordering* (session stream event → event log → snapshot),
 * the sinks own the *write*.
 */
export interface DeliveryPersistenceSinks {
  /** Whitelisted persist types (persist_message / compaction / env user / tool notices). */
  appendSessionStreamEvent(event: StreamEvent): Promise<void> | void
  /** Debug/observability event log (events.jsonl). */
  appendEventLog(entry: { type: string; payload: unknown; timestamp: number }): Promise<void> | void
  /** LLM request snapshot (snapshots.jsonl). */
  appendSnapshot(payload: Record<string, unknown>): Promise<void> | void
}

/** Context for opening a per-turn delivery. */
export interface DeliveryTurnContext {
  /** Session registry / lifecycle key. */
  lifecycleSessionId: string
  /** Relay session id (real ChatSession UUID on forward paths, else sessionId). */
  conversationId: string
  /**
   * Django / business layer authoritative run id (= `HostQuery.identity.runId`).
   * Outbound events pin `run_id` here; `trace_id` / `subagent_run_id` unchanged.
   * Runtime uses the same id via `QueryParams.hostRunId` .
   */
  businessRunId?: string
  owner?: ExecutionOwner
  organizationId?: string
  /** Stable client message id used for source correlation. */
  clientMessageId?: string
  /** Forward-path task id injected into agent.stream.done. */
  taskId?: string
  /** Session-owned persistence sinks (ordering owned here). */
  persist?: DeliveryPersistenceSinks
  /** Build the local MessagePersistedEvent from relay-returned message ids. */
  projectPersistedEvent?: (messageIds: string[]) => StreamEvent | undefined
  /** Wrap a projected snapshot delivery event with the session emitter. */
  buildStream?: (event: StreamEvent) => StreamEvent
  /** Durable handoff after in-memory retries exhaust. */
  onExhausted?: (sessionId: string, events: RelayEvent[]) => void
}

/** Context for a host-originated (non-turn) event publish. */
export interface HostEventContext {
  sessionId: string
  conversationId: string
  owner?: ExecutionOwner
  organizationId?: string
}

/**
 * A single turn's delivery handle. The pipeline emits every runtime event here
 * and calls `complete(outcome)` exactly once.
 *
 * `complete` seals the local viewer immediately (flush + close/fail) and returns;
 * in-flight relay ACK wait runs asynchronously up to terminalFlushDeadlineMs so
 * the query-turn finalize chain / next loop is not blocked. Call
 * {@link settleRelay} when a caller must observe ACK drain (tests / teardown).
 */
export interface DeliveryTurn {
  emit(event: StreamEvent): Promise<void>
  /** Route an event through the host delivery policy for its source. */
  emitRouted(event: StreamEvent, context: { source: DeliveryEventSource }): Promise<void>
  /** Deliver observer-only events without writing them into the parent session archive. */
  emitTransient(event: StreamEvent): Promise<void>
  complete(outcome: HostQueryOutcome): Promise<void>
  /** Await background relay settle started by {@link complete}. */
  settleRelay(): Promise<void>
  cancel(): Promise<void>
}

/** Deep module interface — the host holds exactly one instance. */
export interface DeliveryCoordinator {
  /** Query start: create a per-conversation delivery turn. */
  openTurn(context: DeliveryTurnContext): DeliveryTurn
  /** Terminal / out-of-turn single-batch publish (notification terminal, managed task, exit flush). */
  publishHostEvent(context: HostEventContext, event: StreamEvent): Promise<void>
  /** Flush + settle all delivery for an owner scope (owner teardown / shutdown). */
  flushScope(scope: OwnerScope): Promise<void>
  /** Startup / reconnect / owner activation recover + backfill. */
  kickRecoverAndBackfill(opts: { activateOwner: boolean }): Promise<void>
  /** Process-level shutdown. */
  stop(): Promise<void>
}

// ─── Default implementation ──────────────────────────────────────────

const DEFAULT_TERMINAL_FLUSH_DEADLINE_MS = 5_000

export interface DeliveryCoordinatorConfig {
  /**
   * Max time the terminal barrier waits for in-flight relay ACKs before
   * emitting the local terminal sentinel. Replaces the two hosts' hand-written
   * `Promise.race([..., setTimeout(5_000)])` magic.
   */
  terminalFlushDeadlineMs?: number
}

/**
 * Durable / recovery layer the coordinator delegates to. Wired by the host from
 * {@link MessageDeliveryOutbox} + {@link RelaySessionOrchestrator}; kept as an
 * injected seam so the per-turn engine stays independently testable.
 */
export interface DeliveryDurableLayer {
  send(context: HostEventContext, event: StreamEvent): Promise<void>
  /** Persist a batch whose in-memory relay retries exhausted (durable outbox). */
  persist?(context: HostEventContext, events: RelayEvent[]): Promise<void> | void
  flushScope?(scope: OwnerScope): Promise<void>
  kickRecoverAndBackfill?(opts: { activateOwner: boolean }): Promise<void>
  stop?(): Promise<void>
}

export interface DefaultDeliveryCoordinatorOptions {
  transport: DeliveryTransportPort
  config?: DeliveryCoordinatorConfig
  durable?: DeliveryDurableLayer
}

const PERSIST_TASK_ID_ON = 'agent.stream.done'
const LLM_REQUEST = 'agent.stream.llm_request'
const LLM_SNAPSHOT = 'agent.stream.llm_snapshot'
const SUBAGENT_STREAM_EVENT = 'agent.stream.subagent_stream_event'

function isLocalOnlyRelayEvent(event: StreamEvent): boolean {
  if (event.type === LLM_REQUEST) return true
  if (event.type !== SUBAGENT_STREAM_EVENT) return false
  const childEvent = (event.payload as { child_event?: unknown } | undefined)?.child_event
  return Boolean(
    childEvent
    && typeof childEvent === 'object'
    && (childEvent as { type?: unknown }).type === LLM_REQUEST,
  )
}

class DeliveryTurnImpl implements DeliveryTurn {
  private readonly buffer: DeliveryBatchBuffer
  private readonly localStream: LocalStreamPort | undefined
  private readonly settled: Promise<void>
  private settleResolve!: () => void
  private settleArmed = false
  private terminalDone = false
  private settlePromise: Promise<void> | undefined

  constructor(
    private readonly context: DeliveryTurnContext,
    transport: DeliveryTransportPort,
    private readonly deadlineMs: number,
  ) {
    this.settled = new Promise<void>((resolve) => {
      this.settleResolve = resolve
    })
    const relayTransport = {
      send: async (sessionId: string, events: RelayEvent[]): Promise<void> => {
        const organizationId = context.organizationId
        if (!organizationId) {
          throw new Error('relay batch missing organizationId')
        }
        const relayContext: RelayContext = {
          sessionId,
          owner: context.owner,
          organizationId,
          purpose: 'query',
        }
        const ack = await transport.sendRelayBatch(relayContext, events)
        const messageIds = ack.messageIds
        if (
          messageIds
          && messageIds.length > 0
          && this.localStream
          && context.projectPersistedEvent
        ) {
          const persistedEvent = context.projectPersistedEvent(messageIds)
          if (persistedEvent) this.localStream.emit(persistedEvent)
        }
      },
    }
    this.buffer = new DeliveryBatchBuffer(
      context.conversationId,
      relayTransport,
      context.onExhausted,
      () => {
        if (this.settleArmed) this.settleResolve()
      },
    )
    this.localStream = transport.openLocalStream({
      sessionId: context.lifecycleSessionId,
      conversationId: context.conversationId,
    })
  }

  async emit(event: StreamEvent): Promise<void> {
    const normalized = this.normalizeBusinessRunId(event)
    const correlated = correlateSourceClientEvent(normalized, this.context.clientMessageId)
    const persist = this.context.persist
    if (persist && shouldPersistInParentSession(
      correlated.type,
      correlated.payload as Record<string, unknown> | undefined,
    )) {
      await persist.appendSessionStreamEvent(correlated)
      if (correlated.type !== PERSIST_TASK_ID_ON && !isRelayTransientEvent(correlated.type)) {
        await persist.appendEventLog({
          type: correlated.type,
          payload: correlated.payload,
          timestamp: Date.now(),
        })
      }
      if (correlated.type === LLM_REQUEST || correlated.type === LLM_SNAPSHOT) {
        await persist.appendSnapshot(correlated.payload as Record<string, unknown>)
      }
      if (correlated.type === LLM_REQUEST) {
        const snapshotEvent = projectLlmSnapshotDeliveryEvent(
          correlated.payload as Record<string, unknown>,
        )
        if (snapshotEvent) {
          this.buffer.push(this.context.buildStream?.(snapshotEvent) ?? snapshotEvent)
        }
      }
    }

    const finalEvent = this.injectTaskId(correlated)
    if (finalEvent.type === PERSIST_TASK_ID_ON && persist) {
      await persist.appendEventLog({
        type: finalEvent.type,
        payload: finalEvent.payload,
        timestamp: Date.now(),
      })
    }
    if (finalEvent.type === LLM_SNAPSHOT) {
      this.localStream?.emit(finalEvent)
      return
    }
    this.deliver(finalEvent)
  }

  async emitTransient(event: StreamEvent): Promise<void> {
    const normalized = this.normalizeBusinessRunId(event)
    const correlated = correlateSourceClientEvent(normalized, this.context.clientMessageId)
    this.deliver(this.injectTaskId(correlated))
  }

  async emitRouted(event: StreamEvent, context: { source: DeliveryEventSource }): Promise<void> {
    const route = routeDeliveryEvent(event, context.source)
    if (route === 'durable') {
      await this.emit(event)
      return
    }
    await this.emitTransient(event)
  }

  async complete(outcome: HostQueryOutcome): Promise<void> {
    if (this.terminalDone) return
    this.terminalDone = true

    if (outcome.kind === 'failed' && outcome.lifecycleErrorEvent) {
      const normalized = this.normalizeBusinessRunId(outcome.lifecycleErrorEvent)
      this.localStream?.emit(normalized)
      this.buffer.push(normalized)
    }

    this.buffer.flush()
    this.settleArmed = true
    this.buffer.dispose()

    // Close before ACK wait so finalize / next loop are not blocked on relay.
    // Late message_persisted after close is dropped (IpcStreamHost sentinel
    // invariant); mid-turn ACK projection is unchanged.
    if (outcome.kind === 'failed') {
      this.localStream?.fail(outcome.error)
    } else {
      this.localStream?.close(outcome.kind === 'aborted' ? 'aborted' : 'completed')
    }

    this.settlePromise = this.awaitSettledWithDeadline()
  }

  async settleRelay(): Promise<void> {
    if (this.settlePromise) {
      await this.settlePromise
      return
    }
    if (!this.settleArmed) return
    await this.awaitSettledWithDeadline()
  }

  async cancel(): Promise<void> {
    if (this.terminalDone) return
    this.terminalDone = true
    this.buffer.cancel()
    this.localStream?.close('aborted')
  }

  private injectTaskId(event: StreamEvent): StreamEvent {
    if (event.type !== PERSIST_TASK_ID_ON || !this.context.taskId) return event
    return { ...event, payload: { ...event.payload, task_id: this.context.taskId } }
  }

  private deliver(event: StreamEvent): void {
    // 本地 UI / transcript 保留全量；仅出站 relay 剥 data:/base64。
    this.localStream?.emit(event)
    // 完整 LLM 请求属于本地调试快照；relay 已有有界 llm_snapshot 投影。
    // 子 Agent wrapper 内嵌同类请求时也不能绕过此边界。
    if (isLocalOnlyRelayEvent(event)) return
    this.buffer.push(projectRelayMessageEvent(event))
  }

  private normalizeBusinessRunId(event: StreamEvent): StreamEvent {
    const payload = event.payload as Record<string, unknown> | undefined
    const subagentRunId =
      typeof payload?.subagent_run_id === 'string' ? payload.subagent_run_id : undefined
    if (subagentRunId) {
      return {
        ...event,
        payload: {
          ...event.payload,
          run_id: typeof payload?.run_id === 'string' ? payload.run_id : subagentRunId,
        },
      }
    }
    const businessRunId = this.context.businessRunId
    if (!businessRunId) return event
    return {
      ...event,
      payload: {
        ...event.payload,
        run_id: businessRunId,
      },
    }
  }

  private awaitSettledWithDeadline(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deadlineMs)
    })
    return Promise.race([this.settled, deadline]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
}

/**
 * Default {@link DeliveryCoordinator}. The per-turn engine (batching, local
 * publish, persistence ordering, ACK → persisted projection, terminal barrier)
 * is fully owned here; durable outbox + reconnect recovery are delegated to an
 * injected {@link DeliveryDurableLayer} so both stay independently testable.
 */
export class DefaultDeliveryCoordinator implements DeliveryCoordinator {
  private readonly transport: DeliveryTransportPort
  private readonly deadlineMs: number
  private readonly durable: DeliveryDurableLayer | undefined

  constructor(options: DefaultDeliveryCoordinatorOptions) {
    this.transport = options.transport
    this.deadlineMs =
      options.config?.terminalFlushDeadlineMs ?? DEFAULT_TERMINAL_FLUSH_DEADLINE_MS
    this.durable = options.durable
  }

  openTurn(context: DeliveryTurnContext): DeliveryTurn {
    // Default the exhausted-batch handoff to the durable outbox so relay batches
    // that survive in-memory retries are persisted (recovered on reconnect),
    // unless the caller already wired its own onExhausted.
    const resolved: DeliveryTurnContext =
      context.onExhausted || !this.durable?.persist
        ? context
        : {
            ...context,
            onExhausted: (sessionId, events) => {
              void this.durable!.persist!(
                {
                  sessionId,
                  conversationId: context.conversationId,
                  owner: context.owner,
                  organizationId: context.organizationId,
                },
                events,
              )
            },
          }
    return new DeliveryTurnImpl(resolved, this.transport, this.deadlineMs)
  }

  async publishHostEvent(context: HostEventContext, event: StreamEvent): Promise<void> {
    if (this.durable) {
      await this.durable.send(context, event)
    }
  }

  async flushScope(scope: OwnerScope): Promise<void> {
    await this.durable?.flushScope?.(scope)
  }

  async kickRecoverAndBackfill(opts: { activateOwner: boolean }): Promise<void> {
    await this.durable?.kickRecoverAndBackfill?.(opts)
  }

  async stop(): Promise<void> {
    await this.durable?.stop?.()
  }
}
