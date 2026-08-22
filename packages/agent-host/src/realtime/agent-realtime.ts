import { isStreamEvent } from '@tabtin/agent-wire'
import { isClientBroadcastExcludedStreamType } from '../delivery/client-broadcast-excluded.js'

export const AGENT_REALTIME_EVENT_TYPES = {
  PROMPT_FORWARD: 'agent.prompt.forward',
  PROMPT_CANCEL: 'agent.prompt.cancel',
  PROMPT_PAUSE: 'agent.prompt.pause',
  PROMPT_RESUME: 'agent.prompt.resume',
  SUBAGENT_CANCEL: 'agent.subagent.cancel',
  USER_RESPONSE: 'localrt.user_response',
  APPROVAL_RESPONSE: 'agent.action.approval_response',
  APPROVAL_MEMO_UPDATED: 'agent.action.approval_memo_updated',
  PERMISSION_RESPONSE: 'agent.permission.response',
  PERMISSION_RESET_SESSION: 'agent.permission.reset_session',
  PERMISSION_MODE_UPDATE: 'agent.permission.mode_update',
  ACTION_REQUEST: 'agent.action.request',
} as const

const CONVERSATION_TOPIC_PREFIX = 'agent.stream.'
const DEVICE_TOPIC_PREFIX = 'agent.action.device.'
const CONVERSATION_THREAD_PREFIX = 'chat-session-'
const DEFAULT_DEDUP_LIMIT = 4096
const DEFAULT_TRACKED_SEQ_SESSION_LIMIT = 200

export function conversationThreadForSession(sessionId: string): string {
  return `${CONVERSATION_THREAD_PREFIX}${sessionId}`
}

export function conversationTopicForSession(sessionId: string): string {
  return `${CONVERSATION_TOPIC_PREFIX}${conversationThreadForSession(sessionId)}`
}

export function deviceTopicForDevice(deviceId: string): string {
  return `${DEVICE_TOPIC_PREFIX}${deviceId}`
}

export interface AgentTransportEnvelope {
  type: string
  payload?: unknown
  _topic?: string
  thread_id?: string
  session_id?: string
  [key: string]: unknown
}

export interface AgentTransportReadyInfo {
  reconnected: boolean
}

export interface AgentTransportPort {
  subscribe(
    topics: string[],
    options?: { topicContexts?: Record<string, Record<string, unknown>> },
  ): void | Promise<unknown>
  unsubscribe(topics: string[]): void | Promise<unknown>
  onEnvelope(handler: (envelope: AgentTransportEnvelope) => void): () => void
  onReady?(handler: (info: AgentTransportReadyInfo) => void): () => void
}

export interface AgentStreamTarget {
  id: string | number
  send(envelope: AgentStreamEnvelope): void
  isDestroyed?(): boolean
}

export interface AgentWatchOptions {
  /** sharedsession: 入口的当前共享卡；普通任务入口不传。 */
  shareId?: string
  /** 是否同时订阅传输层会话流；Electron renderer watcher 只需要 IPC target。 */
  observeTransport?: boolean
}

export type PublishBody =
  | { event: { type: string; payload: Record<string, unknown> } }
  | { terminal: { reason: 'completed' | 'errored' | 'aborted'; error?: string } }
  | { heartbeat: true }
  | { control: 'seq-gap' }

export type AgentStreamEnvelope = { sessionId: string } & PublishBody

type AgentCommandOf<T extends string> = {
  type: T
  payload: Record<string, unknown>
  envelope: AgentTransportEnvelope
}

export type AgentCommandType =
  typeof AGENT_REALTIME_EVENT_TYPES[keyof typeof AGENT_REALTIME_EVENT_TYPES]

export type AgentCommand = {
  [Type in AgentCommandType]: AgentCommandOf<Type>
}[AgentCommandType]

export interface AgentRealtimeLogger {
  warn(message: string, context?: Record<string, unknown>): void
}

export interface AgentRealtimeOptions {
  transport: AgentTransportPort
  onCommand?: (command: AgentCommand) => void
  onReady?: (info: AgentTransportReadyInfo) => void
  deviceId?: string
  logger?: AgentRealtimeLogger
  dedupLimit?: number
  trackedSeqSessionLimit?: number
}

interface SessionDedup {
  seen: Set<string | number>
  order: Array<string | number>
}

const COMMAND_TYPES = new Set<string>(Object.values(AGENT_REALTIME_EVENT_TYPES))

/**
 * Shared realtime deep module for Agent hosts.
 *
 * The transport owns connection recovery and desired-topic replay. This module
 * subscribes only when local interest changes and never re-subscribes on ready.
 */
export class AgentRealtime {
  private readonly transport: AgentTransportPort
  private readonly onCommand?: (command: AgentCommand) => void
  private readonly logger?: AgentRealtimeLogger
  private readonly dedupLimit: number
  private readonly trackedSeqSessionLimit: number
  private readonly targetsBySession = new Map<string, Map<string | number, AgentStreamTarget>>()
  private readonly sessionByTopic = new Map<string, string>()
  private readonly dedupBySession = new Map<string, SessionDedup>()
  private readonly lastSeqBySession = new Map<string, number>()
  private readonly subscribedTopics = new Set<string>()
  private readonly removeEnvelopeHandler: () => void
  private readonly removeReadyHandler?: () => void
  private disposed = false

  constructor(options: AgentRealtimeOptions) {
    this.transport = options.transport
    this.onCommand = options.onCommand
    this.logger = options.logger
    this.dedupLimit = options.dedupLimit ?? DEFAULT_DEDUP_LIMIT
    this.trackedSeqSessionLimit =
      options.trackedSeqSessionLimit ?? DEFAULT_TRACKED_SEQ_SESSION_LIMIT
    this.removeEnvelopeHandler = this.transport.onEnvelope((envelope) => {
      this.handleEnvelope(envelope)
    })
    if (options.onReady && this.transport.onReady) {
      this.removeReadyHandler = this.transport.onReady(options.onReady)
    }
    if (options.deviceId) {
      this.subscribeTopic(deviceTopicForDevice(options.deviceId))
    }
  }

  watch(
    sessionId: string,
    target: AgentStreamTarget,
    options?: AgentWatchOptions,
  ): void {
    if (this.disposed || !sessionId) return
    let targets = this.targetsBySession.get(sessionId)
    if (!targets) {
      targets = new Map()
      this.targetsBySession.set(sessionId, targets)
      if (options?.observeTransport !== false) {
        this.observe(sessionId, options)
      }
    }
    targets.set(target.id, target)
  }

  observe(sessionId: string, options?: AgentWatchOptions): void {
    if (this.disposed || !sessionId) return
    const topic = conversationTopicForSession(sessionId)
    this.sessionByTopic.set(topic, sessionId)
    this.subscribeTopic(topic, options)
  }

  unwatch(sessionId: string, targetId: string | number): void {
    const targets = this.targetsBySession.get(sessionId)
    if (!targets) return
    targets.delete(targetId)
    if (targets.size === 0) this.teardownSession(sessionId)
  }

  removeTarget(targetId: string | number): void {
    for (const [sessionId, targets] of [...this.targetsBySession]) {
      targets.delete(targetId)
      if (targets.size === 0) this.teardownSession(sessionId)
    }
  }

  publish(sessionId: string, body: PublishBody): number {
    return this.broadcast({ sessionId, ...body })
  }

  broadcast(envelope: AgentStreamEnvelope): number {
    if (this.disposed) return 0
    // ：与 Django RELAY broadcast skip 对齐——本地 IPC 两条路径
    // （publish / DeliveryCoordinator→IpcStreamHost）都汇聚于此。
    if (
      'event' in envelope
      && isClientBroadcastExcludedStreamType(envelope.event.type)
    ) {
      return 0
    }
    const targets = this.targetsBySession.get(envelope.sessionId)
    if (!targets) return 0
    if (this.isDuplicate(envelope)) return 0

    let delivered = 0
    for (const target of [...targets.values()]) {
      if (target.isDestroyed?.()) {
        targets.delete(target.id)
        continue
      }
      try {
        target.send(envelope)
        delivered += 1
      } catch (error) {
        this.logger?.warn('Failed to deliver Agent stream envelope', {
          sessionId: envelope.sessionId,
          error,
        })
      }
    }
    if (targets.size === 0) this.teardownSession(envelope.sessionId)
    return delivered
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeEnvelopeHandler()
    this.removeReadyHandler?.()

    const topics = [...this.subscribedTopics]
    this.subscribedTopics.clear()
    this.targetsBySession.clear()
    this.sessionByTopic.clear()
    this.dedupBySession.clear()
    this.lastSeqBySession.clear()
    if (topics.length > 0) this.unsubscribe(topics)
  }

  private handleEnvelope(envelope: AgentTransportEnvelope): void {
    if (this.disposed || !envelope || typeof envelope.type !== 'string') return
    if (isStreamEvent(envelope.type)) {
      this.handleStreamEnvelope(envelope)
      return
    }
    if (!isAgentCommandType(envelope.type) || !this.onCommand) return
    this.onCommand({
      type: envelope.type,
      payload: asRecord(envelope.payload),
      envelope,
    })
  }

  private handleStreamEnvelope(envelope: AgentTransportEnvelope): void {
    const sessionId = this.resolveWatchedSession(envelope)
    if (!sessionId) return
    const payload = asRecord(envelope.payload)
    this.trackSeqAndSignalGap(sessionId, payload._seq, payload.coalesced_count)
    this.publish(sessionId, {
      event: {
        type: envelope.type,
        payload,
      },
    })
  }

  private resolveWatchedSession(envelope: AgentTransportEnvelope): string | null {
    if (envelope._topic) {
      const sessionId = this.sessionByTopic.get(envelope._topic)
      if (sessionId) return sessionId
    }
    if (typeof envelope.thread_id === 'string') {
      const sessionId = sessionFromThread(envelope.thread_id)
      if (this.targetsBySession.has(sessionId)) return sessionId
      if (this.targetsBySession.has(envelope.thread_id)) return envelope.thread_id
    }
    if (
      typeof envelope.session_id === 'string'
      && this.targetsBySession.has(envelope.session_id)
    ) {
      return envelope.session_id
    }
    return null
  }

  private trackSeqAndSignalGap(
    sessionId: string,
    rawSeq: unknown,
    rawCoalescedCount?: unknown,
  ): void {
    if (!Number.isSafeInteger(rawSeq) || (rawSeq as number) <= 0) return
    const seq = rawSeq as number
    const coalescedCount = Number.isSafeInteger(rawCoalescedCount)
      && (rawCoalescedCount as number) > 0
      && (rawCoalescedCount as number) <= seq
      ? rawCoalescedCount as number
      : 1
    const firstCoveredSeq = seq - coalescedCount + 1
    const previous = this.lastSeqBySession.get(sessionId)
    if (previous === undefined) {
      this.touchSeq(sessionId, seq)
      if (firstCoveredSeq > 1) {
        this.publish(sessionId, { control: 'seq-gap' })
      }
      return
    }
    if (seq <= previous) return
    this.touchSeq(sessionId, seq)
    if (firstCoveredSeq > previous + 1) {
      this.publish(sessionId, { control: 'seq-gap' })
    }
  }

  private touchSeq(sessionId: string, seq: number): void {
    this.lastSeqBySession.delete(sessionId)
    this.lastSeqBySession.set(sessionId, seq)
    if (this.lastSeqBySession.size <= this.trackedSeqSessionLimit) return
    const oldest = this.lastSeqBySession.keys().next().value
    if (oldest !== undefined) this.lastSeqBySession.delete(oldest)
  }

  private isDuplicate(envelope: AgentStreamEnvelope): boolean {
    if (!('event' in envelope)) return false
    const key = eventIdentity(envelope.event.payload)
    if (key === undefined) return false

    let dedup = this.dedupBySession.get(envelope.sessionId)
    if (!dedup) {
      dedup = { seen: new Set(), order: [] }
      this.dedupBySession.set(envelope.sessionId, dedup)
    }
    if (dedup.seen.has(key)) return true
    dedup.seen.add(key)
    dedup.order.push(key)
    if (dedup.order.length > this.dedupLimit) {
      const evicted = dedup.order.shift()
      if (evicted !== undefined) dedup.seen.delete(evicted)
    }
    return false
  }

  private teardownSession(sessionId: string): void {
    const topic = conversationTopicForSession(sessionId)
    this.targetsBySession.delete(sessionId)
    this.sessionByTopic.delete(topic)
    this.dedupBySession.delete(sessionId)
    this.lastSeqBySession.delete(sessionId)
    this.subscribedTopics.delete(topic)
    this.unsubscribe([topic])
  }

  private subscribeTopic(topic: string, options?: AgentWatchOptions): void {
    if (this.subscribedTopics.has(topic)) return
    this.subscribedTopics.add(topic)
    try {
      const topicContexts = options?.shareId
        ? { [topic]: { share_id: options.shareId } }
        : undefined
      const subscription = topicContexts
        ? this.transport.subscribe([topic], { topicContexts })
        : this.transport.subscribe([topic])
      void Promise.resolve(subscription).catch((error) => {
        this.logger?.warn('Failed to register Agent realtime topic', { topic, error })
      })
    } catch (error) {
      this.logger?.warn('Failed to register Agent realtime topic', { topic, error })
    }
  }

  private unsubscribe(topics: string[]): void {
    try {
      void Promise.resolve(this.transport.unsubscribe(topics)).catch((error) => {
        this.logger?.warn('Failed to unregister Agent realtime topics', { topics, error })
      })
    } catch (error) {
      this.logger?.warn('Failed to unregister Agent realtime topics', { topics, error })
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sessionFromThread(threadId: string): string {
  return threadId.startsWith(CONVERSATION_THREAD_PREFIX)
    ? threadId.slice(CONVERSATION_THREAD_PREFIX.length)
    : threadId
}

function eventIdentity(payload: Record<string, unknown>): string | number | undefined {
  if (typeof payload.event_id === 'string' && payload.event_id) return payload.event_id
  return Number.isSafeInteger(payload.arrival_seq) ? payload.arrival_seq as number : undefined
}

function isAgentCommandType(type: string): type is AgentCommandType {
  return COMMAND_TYPES.has(type)
}
