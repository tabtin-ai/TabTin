import {
  ASK_USER_REQUIRED_EVENT,
  ASK_FORM_REQUIRED_EVENT,
  REQUEST_APPROVAL_REQUIRED_EVENT,
  ActionRequiredEventData,
  ChatClientOptions,
  StreamCallbacks,
} from '../types'
import { WsGateway } from '../core/ws-gateway'
import { t } from '../i18n'
import {
  ACTION_CAPABILITY,
  actionEventType,
  actionTopic,
  canonicalizeEventType,
  streamEventType,
  streamTopic,
} from '../core/namespace'

/**
 * 用户级事件命名空间前缀（``agent.user.*``）。
 *
 * 与 packages/agent-wire 的 `USER_PREFIX` 同义——chat-client 是 standalone 包不引入
 * agent-wire 依赖，按 namespace.ts 内嵌 STREAM_PREFIX 的同样做法在此本地维护一个
 * 常量。两边语义必须一致：W2 用户级事件治理把 title_updated / notification.new /
 * permission.changed 全部归到该前缀（详见 agent-wire/src/events.ts 的 UserEvents）。
 */
const USER_EVENT_PREFIX = 'agent.user.'
import { trackStreamTelemetry } from '../utils/stream-observability'

export interface AbortWaitResult {
  cancelRequested: boolean
  cancelCompleted: boolean
}

export type SlotPhase = 'active' | 'review_paused' | 'suspended' | 'completed'

export type ProbeResult = {
  status: 'running' | 'completed' | 'failed' | 'waiting_for_review' | 'waiting_for_input' | 'unknown'
  pendingInteraction?: Record<string, unknown>
}

/**
 * Per-session streaming state. Each concurrent stream occupies one slot.
 */
export interface StreamSlot {
  sessionId: string
  threadId: string
  runId: string | null
  lastSeq: number | null
  topics: string[]
  callbacks: StreamCallbacks
  fullContent: string
  lastChunkAt: number
  lastEnvelopeAt: number
  timeoutTimer: ReturnType<typeof setInterval> | null
  isRemoteRuntime: boolean
  phase: SlotPhase
  suspendedAt: number | null
}

/**
 * Multi-stream manager.
 *
 * Maintains a `Map<sessionId, StreamSlot>` so that multiple chat sessions can
 * stream concurrently over a single shared `WsGateway` connection.  Each slot
 * subscribes to its own set of WS topics (`agent.stream.{threadId}`) and
 * receives events routed by `thread_id` in the envelope.
 */
export class StreamManager {
  private chatBaseURL: string
  private getToken: () => string | Promise<string>
  private onError?: (error: Error) => void
  private clientType?: string
  private wsGateway: WsGateway
  private probeRun?: ChatClientOptions['probeRun']

  /** Active slots keyed by sessionId */
  private slots: Map<string, StreamSlot> = new Map()

  /** SessionIds currently in the process of connecting (guard against double-start) */
  private connectingSessionIds: Set<string> = new Set()

  /** Single WS listener that routes envelopes to the correct slot */
  private routerHandler: ((envelope: any) => void) | null = null

  /** Single reconnection handler that re-subscribes all active slots */
  private reconnectHandler: (() => void) | null = null

  /** Per-session abort promises to prevent concurrent abort for the same session */
  private pendingAbortBySession: Map<string, Promise<AbortWaitResult>> = new Map()

  private streamTimeoutMs: number
  private remoteRuntimeTimeoutMs: number
  private chunkSilenceWarningMs: number
  private streamingChecker?: (sessionId: string) => boolean

  private static readonly DEFAULT_STREAM_TIMEOUT_MS = 90_000
  private static readonly DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS = 600_000
  private static readonly DEFAULT_CHUNK_SILENCE_WARNING_MS = 180_000
  private static readonly SUBSCRIBE_RETRY_DELAY_MS = 500
  private static readonly STALE_SCAN_INTERVAL_MS = 30_000
  private static readonly STALE_THRESHOLD_MS = 5 * 60_000

  /** Periodic scanner that cleans up slots with no envelope activity for 5 min. */
  private staleScanTimer: ReturnType<typeof setInterval> | null = null

  private _onReconnected?: (activeSessionIds: string[]) => void

  constructor(options: ChatClientOptions, wsGateway: WsGateway) {
    this.chatBaseURL = options.baseURL.replace(/\/$/, '')
    this.getToken = options.getToken
    this.onError = options.onError
    this.clientType = options.role === 'electron' ? 'electron' : undefined
    this.wsGateway = wsGateway

    this.streamTimeoutMs = options.streamTimeoutMs ?? StreamManager.DEFAULT_STREAM_TIMEOUT_MS
    this.remoteRuntimeTimeoutMs = options.remoteRuntimeTimeoutMs ?? StreamManager.DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
    this.chunkSilenceWarningMs = options.chunkSilenceWarningMs ?? StreamManager.DEFAULT_CHUNK_SILENCE_WARNING_MS
    this.probeRun = options.probeRun
    this.streamingChecker = options.streamingChecker
  }

  /**
   * Register a callback invoked after WS reconnection.
   * Receives the list of sessionIds that had active streaming slots.
   */
  setOnReconnected(handler: (activeSessionIds: string[]) => void): void {
    this._onReconnected = handler
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  async stream(
    sessionId: string,
    message: string,
    callbacks: StreamCallbacks,
    options?: {
      modelId?: string
      agentName?: string
      blocks?: Array<Record<string, unknown>>
      agentMode?: string
      clientMessageId?: string
    }
  ): Promise<void> {
    if (this.connectingSessionIds.has(sessionId)) {
      console.warn('[StreamManager] ⚠️ 连接正在建立中，跳过重复请求', { sessionId })
      trackStreamTelemetry('stream.skip.connecting', { sessionId }, 'stream.skip.connecting')
      return
    }

    const existingSlot = this.slots.get(sessionId)
    if (existingSlot) {
      if (existingSlot.phase === 'completed' || existingSlot.phase === 'suspended' || this.isSlotStale(existingSlot)) {
        this.cleanupSlot(sessionId)
      } else {
        console.warn('[StreamManager] ⚠️ WS 连接已存在，跳过重复连接', { sessionId })
        trackStreamTelemetry('stream.skip.duplicate', { sessionId }, 'stream.skip.duplicate')
        return
      }
    }

    this.connectingSessionIds.add(sessionId)

    const _st0 = performance.now()
    const token = await this.getToken()
    const _st1 = performance.now()
    console.log(`[TTFT][StreamManager] getToken: ${Math.round(_st1 - _st0)}ms`)

    const threadId = this.normalizeThreadId(sessionId)
    const now = Date.now()

    const slot: StreamSlot = {
      sessionId,
      threadId,
      runId: null,
      lastSeq: null,
      topics: [],
      callbacks,
      fullContent: '',
      lastChunkAt: now,
      lastEnvelopeAt: now,
      timeoutTimer: null,
      isRemoteRuntime: false,
      phase: 'active',
      suspendedAt: null,
    }

    trackStreamTelemetry('stream.start', { sessionId, threadId }, 'stream.start')

    try {
      const _st2 = performance.now()
      const connected = await this.wsGateway.connect()
      const _st3 = performance.now()
      console.log(`[TTFT][StreamManager] ws.connect: ${Math.round(_st3 - _st2)}ms`)
      if (!connected) {
        throw new Error(t('errors.wsConnectFailed'))
      }

      const _st4 = performance.now()
      slot.topics = await this.subscribeTopics(threadId)
      const _st5 = performance.now()
      console.log(`[TTFT][StreamManager] subscribe: ${Math.round(_st5 - _st4)}ms`)

      this.slots.set(sessionId, slot)
      this.ensureGlobalHandlers()

      if (callbacks.onOpen) {
        callbacks.onOpen()
      }
      if (callbacks.onConnected) {
        callbacks.onConnected(threadId)
      }

      this.startSlotTimeout(slot)

      const _st6 = performance.now()
      const sendResult = await this.sendMessage(sessionId, message, token, options?.modelId, options?.agentName, options?.blocks, options?.agentMode, options?.clientMessageId)
      const _st7 = performance.now()
      console.log(`[TTFT][StreamManager] sendMessage(POST): ${Math.round(_st7 - _st6)}ms`)
      console.log(`[TTFT][StreamManager] 总计: ${Math.round(_st7 - _st0)}ms (token:${Math.round(_st1 - _st0)} ws:${Math.round(_st3 - _st2)} sub:${Math.round(_st5 - _st4)} post:${Math.round(_st7 - _st6)})`)

      if (sendResult?.error_category && this.slots.has(sessionId)) {
        const messageId = sendResult.message_id || ''
        const content = sendResult.reply || ''
        trackStreamTelemetry('stream.precheck.error', {
          sessionId,
          errorCategory: sendResult.error_category,
        }, 'stream.precheck.error')
        callbacks.onDone?.(messageId, content, { error_category: sendResult.error_category })
        this.cleanupSlot(sessionId)
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      trackStreamTelemetry('stream.start.failed', { sessionId, message: err.message }, 'stream.start.failed')
      callbacks.onError?.(err.message)
      this.onError?.(err)
      this.cleanupSlot(sessionId)
    } finally {
      this.connectingSessionIds.delete(sessionId)
    }
  }

  /**
   * Abort a specific session's stream and cancel its backend run.
   */
  async abortSession(sessionId: string, timeoutMs = 3_000): Promise<AbortWaitResult> {
    const existing = this.pendingAbortBySession.get(sessionId)
    if (existing) return existing

    const promise = this._doAbortSession(sessionId, timeoutMs)
    this.pendingAbortBySession.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.pendingAbortBySession.delete(sessionId)
    }
  }

  /**
   * Abort all active streams.
   */
  async abortAll(timeoutMs = 3_000): Promise<void> {
    const ids = [...this.slots.keys()]
    await Promise.allSettled(ids.map(id => this.abortSession(id, timeoutMs)))
  }

  /** Backward-compatible fire-and-forget abort (aborts ALL streams). */
  abort(): void {
    void this.abortAll()
  }

  /** Backward-compatible awaitable abort (aborts ALL streams). */
  async abortAndWait(timeoutMs = 3_000): Promise<AbortWaitResult> {
    const ids = [...this.slots.keys()]
    if (ids.length === 0) {
      return { cancelRequested: false, cancelCompleted: false }
    }
    const results = await Promise.allSettled(ids.map(id => this.abortSession(id, timeoutMs)))
    let cancelRequested = false
    let cancelCompleted = true
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.cancelRequested) cancelRequested = true
        if (!r.value.cancelCompleted) cancelCompleted = false
      }
    }
    return { cancelRequested, cancelCompleted: cancelRequested ? cancelCompleted : false }
  }

  /**
   * Pause a specific session's stream (for human-in-the-loop interrupt).
   * Does NOT cancel the backend run.
   */
  pauseSession(sessionId: string): void {
    this.cleanupSlot(sessionId, false)
  }

  /**
   * Pause for review / ask-user: keep the slot alive and WS topics subscribed so
   * that the backend can still dispatch frontend actions (e.g. execute_in_terminal)
   * and push the final result via WS after resume.
   * Only stops the timeout timer to prevent stale cleanup during review.
   */
  pauseForReview(sessionId: string): void {
    const slot = this.slots.get(sessionId)
    if (!slot) return
    if (slot.timeoutTimer) {
      clearInterval(slot.timeoutTimer)
      slot.timeoutTimer = null
    }
    slot.phase = 'review_paused'
  }

  /** Backward-compatible pause — pauses ALL sessions. */
  pause(): void {
    for (const id of [...this.slots.keys()]) {
      this.pauseSession(id)
    }
  }

  /**
   * Reset `lastEnvelopeAt` on all active/suspended slots to `Date.now()`.
   *
   * Call this after system sleep/wake to prevent the envelope-silence
   * timeout from firing immediately (JS timers are frozen during sleep,
   * so the gap appears much larger than the real idle time).
   */
  refreshAllSlotTimers(): void {
    const now = Date.now()
    for (const slot of this.slots.values()) {
      if (slot.phase === 'completed') continue
      slot.lastEnvelopeAt = now
      slot.lastChunkAt = now
      if (slot.phase === 'suspended') {
        slot.phase = 'active'
        slot.suspendedAt = null
      }
    }
  }

  /**
   * v0.4 W1.5（PRD 05 §7.8.2 选项 A）：判定当前是否仍在 streaming。
   *
   * 优先调用宿主注入的 `streamingChecker`（譬如 Renderer 把
   * `useChatStore.streamingBySessionId` 作为 SSoT 注入进来）——这是为了消除
   * "本地 IPC 主路径下不建 StreamSlot → isStreaming 永远 false → 上层 watchdog
   * 误判 stream 已关"的伪警告（dogfood 81f13c08）。
   *
   * 注入缺失时回退到 StreamManager 内部 slot.phase 判定（旧路径，保持 web /
   * mobile 等未注入回调的环境的原有行为）。
   *
   * 不带 sessionId 的全局查询不能消费 streamingChecker（checker 是按 session
   * 维度查询），仍按 slot 集合判断。
   */
  isStreaming(sessionId?: string): boolean {
    if (sessionId !== undefined) {
      if (this.streamingChecker) {
        return this.streamingChecker(sessionId) || this.connectingSessionIds.has(sessionId)
      }
      const slot = this.slots.get(sessionId)
      return (slot != null && slot.phase !== 'completed') || this.connectingSessionIds.has(sessionId)
    }
    if (this.connectingSessionIds.size > 0) return true
    for (const slot of this.slots.values()) {
      if (slot.phase !== 'completed') return true
    }
    return false
  }

  destroy(): void {
    this.abort()
  }

  /** Expose the active session id for legacy single-stream callers */
  get currentSessionId(): string | null {
    if (this.slots.size === 0) return null
    return this.slots.keys().next().value ?? null
  }

  /** All active session IDs */
  get activeSessionIds(): string[] {
    return [...this.slots.keys()]
  }

  // ────────────────────────────────────────────────────────────
  // Event routing
  // ────────────────────────────────────────────────────────────

  private routeEnvelope(envelope: any): void {
    const threadId: string | undefined = envelope?.thread_id
    const rawType = String(envelope?.type ?? '').toLowerCase()

    // user-level envelope（``agent.user.*``）由 chatApi.ts::handleUserLevelEnvelope
    // 与 useNotificationEventStream 各自路由，**不进 StreamManager slot 分发**——
    // 后端 `publish_to_user` 投递的 envelope 没有顶层 thread_id 也没有 _topic，
    // 单 active slot 路径会兜底落到 `handleSlotEnvelope` default 分支误调
    // `callbacks.onMessage`。在入口直接短路最干净（W2 用户级事件治理）。
    if (rawType.startsWith(USER_EVENT_PREFIX)) {
      return
    }

    if (threadId) {
      for (const slot of this.slots.values()) {
        if (slot.threadId === threadId) {
          if (slot.phase === 'suspended') {
            slot.phase = 'active'
            slot.suspendedAt = null
          }
          if (this.slots.has(slot.sessionId)) {
            this.handleSlotEnvelope(slot, envelope)
          }
          return
        }
      }
      return
    }

    // 传输层心跳常不带 thread_id，无需告警也不必落入业务 slot
    if (rawType === 'pong' || rawType === 'ping') {
      return
    }

    // Multi-slot: try topic matching before giving up
    if (this.slots.size > 1) {
      const topic: string | undefined = envelope._topic
      if (topic) {
        for (const slot of this.slots.values()) {
          if (slot.topics.includes(topic)) {
            this.handleSlotEnvelope(slot, envelope)
            return
          }
        }
      }
      console.warn('[StreamManager] routeEnvelope: no thread_id and no topic match, dropping', {
        type: envelope?.type,
        _topic: topic,
        slotCount: this.slots.size,
      })
      return
    }

    // Fallback: single active slot — apply topic check consistent with multi-slot branch
    if (this.slots.size === 1) {
      const slot = this.slots.values().next().value
      if (slot) {
        const topic: string | undefined = envelope._topic
        if (topic) {
          if (slot.topics.includes(topic)) {
            this.handleSlotEnvelope(slot, envelope)
          } else {
            console.warn('[StreamManager] routeEnvelope: single slot topic mismatch, dropping', {
              type: envelope?.type,
              _topic: topic,
              slotTopics: slot.topics,
              sessionId: slot.sessionId,
            })
          }
        } else {
          console.debug('[StreamManager] routeEnvelope: envelope missing both thread_id and _topic, routing to single slot', {
            type: envelope?.type,
            sessionId: slot.sessionId,
          })
          this.handleSlotEnvelope(slot, envelope)
        }
      }
    }
  }

  private handleSlotEnvelope(slot: StreamSlot, envelope: any): void {
    const eventType = canonicalizeEventType(envelope?.type || '')
    const payload = envelope?.payload || {}
    const callbacks = slot.callbacks

    if (payload.run_id && !slot.runId) {
      slot.runId = payload.run_id
    }

    if (!slot.isRemoteRuntime && payload.source === 'runtime') {
      slot.isRemoteRuntime = true
    }

    slot.lastEnvelopeAt = Date.now()
    const rawSeq = payload?._seq
    const seq = typeof rawSeq === 'number' ? rawSeq : undefined
    if (seq !== undefined) {
      const rawCoalescedCount = payload?.coalesced_count
      const coalescedCount = Number.isSafeInteger(rawCoalescedCount)
        && rawCoalescedCount > 0
        && rawCoalescedCount <= seq
        ? rawCoalescedCount
        : 1
      const firstCoveredSeq = seq - coalescedCount + 1
      const lastSeq = slot.lastSeq
      if (lastSeq !== null && firstCoveredSeq > lastSeq + 1) {
        callbacks.onSeqGap?.({
          expectedSeq: lastSeq + 1,
          actualSeq: seq,
          gap: firstCoveredSeq - lastSeq - 1,
        })
      }
      if (lastSeq === null || seq > lastSeq) {
        slot.lastSeq = seq
      }
    }
    if (slot.phase === 'review_paused') {
      slot.phase = 'active'
      this.startSlotTimeout(slot)
    }

    switch (eventType) {
      case streamEventType('chunk'): {
        const chunk = payload.content
        if (chunk) {
          slot.lastChunkAt = Date.now()
          slot.fullContent += chunk
          callbacks.onChunk?.(chunk, slot.fullContent)
        }
        break
      }
      case streamEventType('done'): {
        const messageId = payload.message_id || payload.messageId || ''
        const content = payload.content || slot.fullContent
        const doneMetadata = payload.metadata as Record<string, unknown> | undefined
        callbacks.onDone?.(messageId, content, doneMetadata)
        slot.runId = null
        slot.phase = 'completed'
        if (slot.isRemoteRuntime) {
          setTimeout(() => this.cleanupSlot(slot.sessionId), 5_000)
        } else {
          this.cleanupSlot(slot.sessionId)
        }
        break
      }
      case streamEventType('message_persisted'): {
        const persistedId = payload.message_id || payload.messageId || ''
        if (persistedId) {
          callbacks.onDone?.(persistedId, payload.content || slot.fullContent)
        }
        slot.phase = 'completed'
        this.cleanupSlot(slot.sessionId)
        break
      }
      case streamEventType('message'): {
        callbacks.onMessage?.({
          type: payload.type,
          content: payload.content,
        })
        break
      }
      case streamEventType('assistant'): {
        const phase = payload.phase
        if (phase === 'delta') {
          const chunk = payload.content
          if (chunk) {
            slot.lastChunkAt = Date.now()
            slot.fullContent += chunk
            callbacks.onChunk?.(chunk, slot.fullContent)
          }
        } else if (phase === 'final') {
          const messageId = payload.message_id || ''
          const content = payload.content || slot.fullContent
          const metadata = payload.metadata as Record<string, unknown> | undefined
          callbacks.onDone?.(messageId, content, metadata)
          slot.runId = null
          slot.phase = 'completed'
          this.cleanupSlot(slot.sessionId)
        }
        break
      }
      case streamEventType('approval_requested'): {
        // v0.4 W1.5（PRD §7.4 / §7.5）：runtime 端 emit `approval_requested` batch 形态，
        // 旧 `review_required` 不再 emit（按 D6 一刀切删除分支）。
        callbacks.onApprovalRequested?.(payload)
        break
      }
      case streamEventType('approval_resolved'): {
        callbacks.onApprovalResolved?.(payload)
        break
      }
      case streamEventType(ASK_USER_REQUIRED_EVENT):
      case streamEventType(ASK_FORM_REQUIRED_EVENT):
      case streamEventType(REQUEST_APPROVAL_REQUIRED_EVENT): {
        // W4 R3 (2026-05-11): ask 三件套并存 — chat-client 把三类 event 都
        // 路由到同一个 onAskUserRequired callback；下游（Electron）按 event.type
        // 区分 kind（choice / form / approval）。
        callbacks.onAskUserRequired?.(payload)
        break
      }
      case streamEventType('tool'):
      case streamEventType('step'):
      case streamEventType('lifecycle'):
      case streamEventType('todo'):
      case streamEventType('compaction'):
      case streamEventType('subagent_started'):
      case streamEventType('subagent_progress'):
      case streamEventType('subagent_failed'):
      case streamEventType('subagent_completed'): {
        callbacks.onMessage?.({ type: eventType, payload })
        break
      }
      case streamEventType('persist_error'): {
        const messageId = payload.message_id || payload.messageId || ''
        const content = payload.content || slot.fullContent
        const meta: Record<string, unknown> = {
          error_category: 'persist_error',
          ...(payload.metadata || {}),
        }
        trackStreamTelemetry('stream.persist_error', {
          sessionId: slot.sessionId,
          threadId: slot.threadId,
        }, 'stream.persist_error')
        callbacks.onDone?.(messageId, content, meta)
        slot.phase = 'completed'
        this.cleanupSlot(slot.sessionId)
        break
      }
      case streamEventType('heartbeat'): {
        callbacks.onHeartbeat?.()
        break
      }
      case actionEventType('request'): {
        if (callbacks.onActionRequired) {
          const action: ActionRequiredEventData = {
            action: payload.action || payload.type,
            thread_id: payload.thread_id || slot.threadId || undefined,
            task_id: payload.task_id,
            params: payload.params || {},
            description: payload.description,
            trace_id: payload.trace_id ?? undefined,
            sandbox_policy: payload.sandbox_policy ?? undefined,
          }
          void callbacks.onActionRequired(action, payload.task_id)
        }
        break
      }
      case 'error': {
        const errorMsg = payload?.message || payload?.content || payload?.error || t('errors.unknownError')
        const errorCategory = payload?.error_category || 'unknown'
        trackStreamTelemetry('stream.error.event', { errorMsg, errorCategory }, 'stream.error.event')
        callbacks.onError?.(errorMsg, errorCategory)
        this.cleanupSlot(slot.sessionId)
        break
      }
      case streamEventType('content_reset'): {
        slot.fullContent = ''
        slot.lastChunkAt = Date.now()
        callbacks.onContentReset?.()
        callbacks.onMessage?.({ type: eventType, payload })
        break
      }
      default: {
        callbacks.onMessage?.({
          type: eventType,
          content: payload?.content || '',
          payload,
        })
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Global handler lifecycle
  // ────────────────────────────────────────────────────────────

  /**
   * Lazily attach the global router + reconnect handlers when the first slot
   * is created.  Remove them when the last slot is cleaned up.
   */
  private ensureGlobalHandlers(): void {
    if (!this.routerHandler) {
      this.routerHandler = (envelope: any) => this.routeEnvelope(envelope)
      this.wsGateway.addListener(this.routerHandler)
    }
    if (!this.reconnectHandler) {
      this.reconnectHandler = () => { void this.handleReconnect() }
      this.wsGateway.onReconnectedEvent(this.reconnectHandler)
    }
    if (!this.staleScanTimer) {
      this.staleScanTimer = setInterval(() => this.sweepStaleSlots(), StreamManager.STALE_SCAN_INTERVAL_MS)
    }
  }

  private removeGlobalHandlersIfEmpty(): void {
    if (this.slots.size > 0) return
    if (this.routerHandler) {
      this.wsGateway.removeListener(this.routerHandler)
      this.routerHandler = null
    }
    if (this.reconnectHandler) {
      this.wsGateway.offReconnectedEvent(this.reconnectHandler)
      this.reconnectHandler = null
    }
    if (this.staleScanTimer) {
      clearInterval(this.staleScanTimer)
      this.staleScanTimer = null
    }
  }

  private isSlotStale(slot: StreamSlot): boolean {
    if (slot.phase === 'review_paused') return false
    const threshold = slot.isRemoteRuntime
      ? this.remoteRuntimeTimeoutMs
      : StreamManager.STALE_THRESHOLD_MS
    return Date.now() - slot.lastEnvelopeAt > threshold
  }

  /**
   * Periodic sweep: auto-clean slots that haven't received any envelope
   * beyond the tiered threshold (5 min for normal, 10 min for external agent).
   */
  private static readonly SUSPENDED_HARD_TIMEOUT_VISIBLE_MS = 30 * 60_000
  private static readonly SUSPENDED_HARD_TIMEOUT_HIDDEN_MS = 8 * 60 * 60_000

  private getSuspendedHardTimeout(): number {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return StreamManager.SUSPENDED_HARD_TIMEOUT_HIDDEN_MS
    }
    return StreamManager.SUSPENDED_HARD_TIMEOUT_VISIBLE_MS
  }

  private sweepStaleSlots(): void {
    const hardTimeoutMs = this.getSuspendedHardTimeout()
    for (const [sessionId, slot] of this.slots) {
      if (slot.phase === 'completed') continue
      if (this.isSlotStale(slot)) {
        if (slot.phase !== 'suspended') {
          slot.phase = 'suspended'
          slot.suspendedAt = Date.now()
          slot.callbacks.onSuspended?.()
        } else if (
          slot.suspendedAt &&
          Date.now() - slot.suspendedAt > hardTimeoutMs
        ) {
          if (slot.phase !== 'suspended') continue
          console.warn('[StreamManager] 🧹 Suspended slot exceeded hard limit, cleaning up', {
            sessionId,
            suspendedMs: Date.now() - slot.suspendedAt,
          })
          if (slot.runId) {
            slot.callbacks.onRunCompleted?.(slot.runId, 'unknown')
          }
          this.cleanupSlot(sessionId, false)
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Reconnection
  // ────────────────────────────────────────────────────────────

  private async handleReconnect(): Promise<void> {
    const entries = [...this.slots.values()]
    const now = Date.now()

    const subscribePromises = entries.map(slot => {
      if (slot.phase !== 'suspended') {
        slot.lastEnvelopeAt = now
        slot.lastChunkAt = now
      }
      return this.subscribeTopics(slot.threadId)
        .then(topics => { slot.topics = topics })
        .catch(error => {
          const err = error instanceof Error ? error : new Error(String(error))
          trackStreamTelemetry('stream.resubscribe.failed', {
            threadId: slot.threadId,
            message: err.message,
          }, 'stream.resubscribe.failed')
          slot.callbacks.onError?.(t('errors.wsSubscribeFailed'), 'resubscribe_failed')
        })
    })

    await Promise.allSettled(subscribePromises)

    void this.wsGateway.sendResume()
    void this.probeSuspendedSlots(entries)

    if (this._onReconnected && entries.length > 0) {
      const activeSessionIds = entries.map(s => s.sessionId)
      try {
        this._onReconnected(activeSessionIds)
      } catch (err) {
        /* non-critical */
      }
    }
  }

  private async probeSuspendedSlots(entries: StreamSlot[]): Promise<void> {
    for (const slot of entries) {
      if (slot.phase !== 'suspended') continue
      const result = await this.probeRunStatus(slot)
      if (!this.slots.has(slot.sessionId)) continue
      if (slot.phase !== 'suspended') continue
      if (result.status === 'completed' || result.status === 'failed') {
        if (slot.runId) {
          slot.callbacks.onRunCompleted?.(slot.runId, result.status)
        }
        this.cleanupSlot(slot.sessionId, false)
      } else if (result.status === 'running') {
        slot.phase = 'active'
        slot.suspendedAt = null
        slot.callbacks.onRunStillRunning?.()
      } else if (
        (result.status === 'waiting_for_review' || result.status === 'waiting_for_input')
        && result.pendingInteraction
      ) {
        slot.phase = 'active'
        slot.suspendedAt = null
        slot.callbacks.onHitlRestored?.(result.pendingInteraction)
      }
    }
  }

  private async probeRunStatus(slot: StreamSlot): Promise<ProbeResult> {
    if (!slot.runId) return { status: 'unknown' }

    if (!this.probeRun) {
      // M5.Y 后不再提供 HTTP fallback（/orchestration/runs 已下线）。
      // 宿主若关心 run 状态恢复，必须注入 probeRun 回调。
      return { status: 'unknown' }
    }

    try {
      const data = await this.probeRun(slot.runId)
      return {
        status: (data.status as ProbeResult['status']) ?? 'unknown',
        pendingInteraction: data.pending_interaction,
      }
    } catch {
      return { status: 'unknown' }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Slot cleanup helpers
  // ────────────────────────────────────────────────────────────

  /**
   * Clean up a slot: stop timeout, unsubscribe topics, remove from map.
   *
   * M5.Y 后不再有 HTTP `/orchestration/runs/*` 取消端点，后端 run 的取消完全
   * 依赖 WS 通道（本地 Runtime 直接中止 query，云端 external Agent 通过
   * Gateway 发送 cancel）。`cancelRun` 参数保留以兼容历史签名，但本 manager
   * 不再发起任何 HTTP 请求。
   */
  private cleanupSlot(sessionId: string, _cancelRun = false): void {
    const slot = this.slots.get(sessionId)
    if (!slot) return

    if (slot.timeoutTimer) {
      clearInterval(slot.timeoutTimer)
      slot.timeoutTimer = null
    }

    if (slot.topics.length > 0) {
      void this.wsGateway.request('unsubscribe', { topics: slot.topics }).catch(() => {})
    }

    this.slots.delete(sessionId)
    this.removeGlobalHandlersIfEmpty()
  }

  private async _doAbortSession(sessionId: string, _timeoutMs: number): Promise<AbortWaitResult> {
    const slot = this.slots.get(sessionId)
    if (!slot) {
      return { cancelRequested: false, cancelCompleted: false }
    }

    if (slot.timeoutTimer) {
      clearInterval(slot.timeoutTimer)
      slot.timeoutTimer = null
    }

    if (slot.topics.length > 0) {
      void this.wsGateway.request('unsubscribe', { topics: slot.topics }).catch(() => {})
    }

    const runId = slot.runId
    const threadId = slot.threadId

    this.slots.delete(sessionId)
    this.removeGlobalHandlersIfEmpty()

    trackStreamTelemetry('stream.abort', {
      sessionId,
      cancelRequested: false,
      cancelCompleted: false,
      cancelMethod: runId ? 'run_id' : (threadId ? 'thread_id' : 'none'),
    }, 'stream.abort')

    // M5.Y：不再通过 HTTP 取消后端 run。主叫方若需要真正中断执行，
    // 应走本地 Runtime IPC（`window.tabtin.agentEngine.abort`）或 Daemon
    // WS cancel。此处只解除本地监听和 WS 订阅。
    return {
      cancelRequested: false,
      cancelCompleted: false,
    }
  }

  // ────────────────────────────────────────────────────────────
  // Per-slot timeout
  // ────────────────────────────────────────────────────────────

  private startSlotTimeout(slot: StreamSlot): void {
    slot.lastChunkAt = Date.now()
    slot.lastEnvelopeAt = Date.now()
    if (slot.timeoutTimer) clearInterval(slot.timeoutTimer)

    slot.timeoutTimer = setInterval(() => {
      if (!this.slots.has(slot.sessionId)) {
        if (slot.timeoutTimer) clearInterval(slot.timeoutTimer)
        return
      }
      const now = Date.now()
      const envelopeSilence = now - slot.lastEnvelopeAt
      const chunkSilence = now - slot.lastChunkAt

      const effectiveTimeout = slot.isRemoteRuntime ? this.remoteRuntimeTimeoutMs : this.streamTimeoutMs
      if (envelopeSilence > effectiveTimeout) {
        if (slot.phase === 'active') {
          slot.phase = 'suspended'
          slot.suspendedAt = Date.now()
          trackStreamTelemetry('stream.suspended', {
            sessionId: slot.sessionId,
            category: 'stream_timeout',
          }, 'stream.suspended')
          slot.callbacks.onSuspended?.()
        }
        return
      }

      if (chunkSilence > this.chunkSilenceWarningMs) {
        trackStreamTelemetry('stream.chunk.stall', {
          sessionId: slot.sessionId,
          chunkSilenceMs: chunkSilence,
        }, 'stream.chunk.stall')
        slot.callbacks.onHeartbeat?.()
      }
    }, 5_000)
  }

  // ────────────────────────────────────────────────────────────
  // Shared helpers (unchanged)
  // ────────────────────────────────────────────────────────────

  private async subscribeTopics(threadId: string, attempt = 1): Promise<string[]> {
    const maxAttempts = 2
    const topics: string[] = [streamTopic(threadId)]
    if (this.wsGateway.hasCapability(ACTION_CAPABILITY)) {
      topics.push(actionTopic(threadId))
    }

    const response = await this.wsGateway.subscribe(topics)
    if (!response.ok) {
      const detail = response.error
        ? `[${response.error.code}] ${response.error.message}`
        : `type=${response.type}`

      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, StreamManager.SUBSCRIBE_RETRY_DELAY_MS))
        return this.subscribeTopics(threadId, attempt + 1)
      }
      throw new Error(`${t('errors.wsSubscribeFailed')}: ${detail}`)
    }
    return topics
  }

  private async sendMessage(
    sessionId: string,
    message: string,
    token: string,
    modelId?: string,
    agentName?: string,
    blocks?: Array<Record<string, unknown>>,
    agentMode?: string,
    clientMessageId?: string,
  ): Promise<{ error_category?: string; reply?: string; message_id?: string } | null> {
    if (sessionId.startsWith('browser-')) return null

    const url = `${this.chatBaseURL}/sessions/${sessionId}/messages`
    const body: Record<string, unknown> = {
      message,
      model_id: modelId,
      stream: true,
    }
    if (agentName) body.agent_name = agentName
    if (blocks && blocks.length > 0) body.blocks = blocks
    if (agentMode) body.agent_mode = agentMode
    if (clientMessageId) body.client_message_id = clientMessageId

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(this.clientType ? { 'X-Client-Type': this.clientType } : {}),
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        errorData.message ||
        errorData.error ||
        t('errors.httpStatus', { status: response.status, statusText: response.statusText })
      )
    }

    const json = await response.json().catch(() => null)
    return json?.data ?? null
  }

  private normalizeThreadId(sessionId: string): string {
    const normalized = sessionId.trim()
    const allowedPrefix = /^(chat-session-|tin-|browser-)/
    if (allowedPrefix.test(normalized)) return normalized
    return `chat-session-${normalized}`
  }
}
