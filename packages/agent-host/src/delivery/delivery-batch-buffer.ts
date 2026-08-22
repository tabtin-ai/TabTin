import type { StreamEvent } from '@tabtin/agent-runtime'
import { parseRelayFailureFromError } from './relay-transport.js'
import {
  CONTENT_BLOCK_DELTA_TYPE,
  coalesceRelayBatch,
  tryAppendCoalescedDelta,
  type RelayBatchEvent,
} from './relay-delta-coalesce.js'

const RELAY_FLUSH_INTERVAL_MS = 150
const RELAY_FLUSH_THRESHOLD = 15
/** 等待批折叠上限，低于 Electron WS 出站 900_000，避免超限帧堵死串行队列。 */
const RELAY_OUTBOUND_FOLD_MAX_CHARS = 800_000
/**
 * 重试预算：transport.send 失败时按指数退避重试该次 batch 的次数。
 *
 * 设计动机：之前重试只挑 critical 子集，导致 user/assistant/tool_* 等
 * **持久化事件**在网络抖动 / Django 短暂不可用时被永久丢弃——后果是
 * ChatSession.input_tokens 累加成功（done 在 critical 里被重试），但对应
 * 的 ChatMessage 永远没落库（事故复现：dogfood session f9cb61f6，778K
 * 累计但消息表只有 1 条 user）。
 *
 * 修复方案：catch 后**整批重试**（relay_events 是幂等的——按
 * client_event_id 去重，重发零副作用，参见 relay_message_writer
 * `_upsert_chat_message` 的 IntegrityError 兜底）。
 */
const RELAY_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 12_000]
const RELAY_CRITICAL_TYPES: ReadonlySet<string> = new Set([
  'agent.stream.lifecycle',
  'agent.stream.done',
  // W4 R3 (2026-05-11)：ask 三件套并存（B 报告 §六），三个事件都是 critical
  // ——dogfood f9cb61f6 messages-as-truth 事故根因之一是关键事件被批量丢失。
  'agent.stream.ask_user_required',
  'agent.stream.ask_form_required',
  'agent.stream.request_approval_required',
  // v0.4 W1.5：批量审批新事件加入 critical（修移动端弱网丢事件 bug）
  'agent.stream.approval_requested',
  'agent.stream.approval_resolved',
  // 2026-05-10：messages-as-truth 事故根因修复——user / assistant 事件
  // 必须 critical 立即 flush 且失败可重试。之前只在攒满 15 条 / 150ms
  // 闲置 / 下一个 critical 顺带 flush 时才发出，假如那批 send 失败 →
  // 旧 catch 只挑 critical 重试 → user/assistant **永久丢失**。
  // 现在两件事一起做：①加入 critical 立即 flush，②catch 整批重试。
  // 注意：assistant 事件 phase 有 partial/delta/final 等多种，**push 路径
  // 用 `isPersistableMessageEvent` 判断只对 phase=final 触发立即 flush**；
  // 其他 phase 仍按累积 / 闲置 flush 走，避免 partial chunk 触发 flush
  // 风暴。
  'agent.stream.user',
  'agent.stream.assistant',
  // ：persist_message 是 assistant 落库唯一权威（Django CRITICAL_EVENT_TYPES
  // 已含），客户端却只靠攒批顺带 flush——两侧身份不对称。提升 critical：
  // 立即 flush + 失败整批重试，与「消息完整边界即落库」的语义对齐。
  'agent.stream.persist_message',
])

/** 与落库权威事件同批会拖垮 WS ACK 的胖观测事件（ dogfood）。 */
const RELAY_BULKY_OBSERVABILITY_TYPES: ReadonlySet<string> = new Set([
  'agent.stream.llm_snapshot',
  'agent.stream.llm_request',
])

type RelayBatch = RelayBatchEvent[]

function batchHasBulkyObservability(events: RelayBatch): boolean {
  return events.some(event => RELAY_BULKY_OBSERVABILITY_TYPES.has(event.type))
}

function isLiveRelayBatch(events: RelayBatch): boolean {
  return events.length > 0 && events.every(event => event.type === CONTENT_BLOCK_DELTA_TYPE)
}

function estimateRelayBatchChars(events: RelayBatch): number {
  try {
    return JSON.stringify(events).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * `agent.stream.assistant` 多 phase 事件中，哪些会被 Django 端
 * `_is_persistable_message` 真正落库。仅 phase=final 的 assistant 才进入
 * critical 立即 flush 路径，partial/delta 仍走原批量节流。
 */
function isPersistableMessageEvent(event: StreamEvent): boolean {
  if (event.type === 'agent.stream.user') return true
  if (event.type === 'agent.stream.assistant') {
    const phase = (event.payload as { phase?: unknown } | undefined)?.phase
    return phase === 'final'
  }
  return false
}

export interface DeliveryTransport {
  send(
    sessionId: string,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ): Promise<void>
}

export class DeliveryBatchBuffer {
  private buffer: RelayBatch = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()
  /** ：待发 outbound 队列；与 inFlight 一起保证同 session 单飞。 */
  private readonly outboundQueue: RelayBatch[] = []
  private inFlight = false
  private pendingDeliveries = 0
  private disposed = false
  private cancelled = false
  private settledNotified = false

  constructor(
    private readonly sessionId: string,
    private readonly transport: DeliveryTransport,
    /**
     * relay 持久化（治本）：内存重试 [2s/5s/12s] 全部耗尽后的兜底钩子。
     * 宿主注入 `→ RelayRetryQueue.persist({ sessionId, events })`，把这批
     * **本应永久丢失**的 relay event 落盘，启动/重连时 recover 重投。
     *
     * **未注入时行为完全不变**（仅 console.error 放弃）——降级安全，
     * relay 持久化是 opt-in 增强，不破坏现状。
     */
    private readonly onExhausted?: (
      sessionId: string,
      events: Array<{ type: string; payload: Record<string, unknown> }>,
    ) => void,
    private readonly onSettled?: () => void,
  ) {}

  push(event: StreamEvent): void {
    if (this.disposed) return

    // trace_id / thread_id / event_id / arrival_seq 已由 agent-runtime EventEmitter
    // 在 IPC / relay 分叉前统一盖章；DeliveryBatchBuffer 只负责缓冲与传输，不再补协议字段。

    //  persist 快车道：落库权威事件单独成批，不与已攒的
    // llm_snapshot / llm_request / system_notice 等捆在一起（百 KB 同批会
    // 把 Django ACK 拖到超时）。先冲掉已有 buffer，再单发本条。
    if (event.type === 'agent.stream.persist_message' || event.type === 'agent.stream.user') {
      if (this.buffer.length > 0) {
        this.flush()
      }
      this.buffer.push({ type: event.type, payload: event.payload as Record<string, unknown> })
      this.flush()
      return
    }

    // ：连续同键 content_block_delta 在 buffer 内合并（减 relay 事件数）。
    // 合并键含 message_id+index+delta.type，禁止跨消息/跨块；不改 IPC 侧已 emit 的对象。
    const incoming: RelayBatchEvent = {
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    }
    if (event.type === CONTENT_BLOCK_DELTA_TYPE && this.buffer.length > 0) {
      const last = this.buffer[this.buffer.length - 1]!
      const mergeResult = tryAppendCoalescedDelta(last, incoming)
      if (mergeResult === 'merged') {
        this.ensureIdleFlushTimer()
        return
      }
      // overflow / incompatible → 走下方正常入队（overflow 时另起一条）
    }

    this.buffer.push(
      event.type === CONTENT_BLOCK_DELTA_TYPE
        ? {
            type: event.type,
            payload: {
              ...incoming.payload,
              ...(incoming.payload.delta
                && typeof incoming.payload.delta === 'object'
                && !Array.isArray(incoming.payload.delta)
                ? { delta: { ...(incoming.payload.delta as Record<string, unknown>) } }
                : {}),
            },
          }
        : { type: event.type, payload: incoming.payload },
    )

    // 立即 flush 条件：
    //   1. event.type 本身是 critical（lifecycle / done / ask_* / approval_*）
    //   2. user / assistant phase=final（messages-as-truth 修复：必须立即落库）
    //   3. buffer 攒够 RELAY_FLUSH_THRESHOLD 条
    // assistant phase=partial/delta 不立即 flush——避免每个 stream chunk
    // 都触发一次 send（性能灾难）。
    const isImmediate =
      RELAY_CRITICAL_TYPES.has(event.type) && (
        // 非 user/assistant：critical 集合里其他类型一律立即
        (event.type !== 'agent.stream.user' && event.type !== 'agent.stream.assistant')
        || isPersistableMessageEvent(event)
      )

    if (isImmediate || this.buffer.length >= RELAY_FLUSH_THRESHOLD) {
      this.flush()
    } else {
      this.ensureIdleFlushTimer()
    }
  }

  private ensureIdleFlushTimer(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, RELAY_FLUSH_INTERVAL_MS)
  }

  /**
   * 闲置 / 满批 flush：若 buffer 混有胖观测事件与其它事件，拆成
   * 「非胖一批 + 胖事件各自一批」，避免单帧过大。
   */
  private flushSplitBulky(events: RelayBatch): void {
    if (events.length === 0) return
    const bulky = events.filter(e => RELAY_BULKY_OBSERVABILITY_TYPES.has(e.type))
    const rest = events.filter(e => !RELAY_BULKY_OBSERVABILITY_TYPES.has(e.type))
    if (rest.length > 0) {
      this.enqueueDelivery(rest)
    }
    for (const event of bulky) {
      this.enqueueDelivery([event])
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return

    // ：入队前再压一次相邻同键 delta（防御 push 路径未合并的交错场景）。
    const coalesced = coalesceRelayBatch(this.buffer)
    this.buffer = []

    // 单条（含 persist 快车道）直接入队；多条时拆出胖观测事件，避免巨帧。
    if (coalesced.length === 1) {
      this.enqueueDelivery(coalesced)
      return
    }
    this.flushSplitBulky(coalesced)
  }

  dispose(): void {
    this.disposed = true
    this.flush()
    this.notifyIfSettled()
  }

  cancel(): void {
    this.cancelled = true
    this.disposed = true
    this.buffer = []
    this.outboundQueue.length = 0
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    this.pendingDeliveries = 0
    this.inFlight = false
    this.notifyIfSettled()
  }

  /**
   * 入队后由 pump 发送。persist / done / HITL / user 仍单飞等 ACK
   *（含内存重试），避免 Django 同连接串行排队被 10s 超时 + 重试注水打成雪崩。
   *
   * 纯 live `content_block_delta` 写出即放行、失败不重试：停等 ACK 才是
   * 手机相对 Electron 线性落后的主因，重试才是乱序源。
   *
   * 在飞的 critical 批期间后续非胖观测批折进队尾：同键 delta 拼成一条。
   * 不改发送顺序，也不把 llm_snapshot / llm_request 捆进文本帧。
   */
  private enqueueDelivery(events: RelayBatch): void {
    if (this.cancelled || events.length === 0) return
    const last = this.outboundQueue[this.outboundQueue.length - 1]
    if (last && this.tryFoldIntoWaitingBatch(last, events)) {
      void this.pumpOutbound()
      return
    }
    this.pendingDeliveries += 1
    this.outboundQueue.push(events)
    void this.pumpOutbound()
  }

  private tryFoldIntoWaitingBatch(target: RelayBatch, incoming: RelayBatch): boolean {
    if (batchHasBulkyObservability(target) || batchHasBulkyObservability(incoming)) {
      return false
    }
    const folded = coalesceRelayBatch([...target, ...incoming])
    if (estimateRelayBatchChars(folded) > RELAY_OUTBOUND_FOLD_MAX_CHARS) {
      return false
    }
    target.splice(0, target.length, ...folded)
    return true
  }

  private async pumpOutbound(): Promise<void> {
    if (this.inFlight || this.cancelled) return
    const next = this.outboundQueue.shift()
    if (!next) return

    this.inFlight = true
    try {
      await this.deliverBatch(next)
    } finally {
      this.inFlight = false
      if (!this.cancelled) {
        void this.pumpOutbound()
      }
    }
  }

  private async deliverBatch(events: RelayBatch): Promise<void> {
    if (isLiveRelayBatch(events)) {
      this.settleDelivery()
      void this.transport.send(this.sessionId, events).catch(err => {
        if (this.cancelled) return
        if (this.dropNonRetryableRelayFailure(err, events)) return
        console.warn(
          '[DeliveryBatchBuffer] live relay send failed (no retry):',
          'session=%s events=%d types=%o err=%o',
          this.sessionId,
          events.length,
          events.map(e => e.type),
          err,
        )
      })
      return
    }

    try {
      await this.transport.send(this.sessionId, events)
      this.settleDelivery()
    } catch (err) {
      if (this.cancelled) {
        this.settleDelivery()
        return
      }
      if (this.dropNonRetryableRelayFailure(err, events)) {
        this.settleDelivery()
        return
      }
      // 整批重试（不再只挑 critical 子集）—— relay_events 是幂等的，
      // 用 client_event_id 去重，重发零副作用。之前的 silent 丢弃（catch
      // {} 吞错 + 只重试 critical 子集）是 dogfood session f9cb61f6 事故的
      // 直接根因：assistant final 事件被永久丢失，ChatSession.input_tokens
      // 累加成功（done 在 critical 里）但 ChatMessage 表里没记录。
      console.error(
        '[DeliveryBatchBuffer] transport.send failed (will retry batch):',
        'session=%s events=%d types=%o err=%o',
        this.sessionId,
        events.length,
        events.map(e => e.type),
        err,
      )
      await this.retryUntilDone(events, 0)
    }
  }

  /**
   * 失败重试：指数退避 [2s, 5s, 12s]，每次仍走整批重发。任何一次成功即
   * 退出；全部耗尽仍失败时记 console.error 并交 onExhausted。
   * 重试期间保持 inFlight，不放行 outbound 下一批。
   */
  private async retryUntilDone(events: RelayBatch, attempt: number): Promise<void> {
    if (this.cancelled) {
      this.settleDelivery()
      return
    }
    const delay = RELAY_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) {
      // 治本（relay 持久化）：内存重试耗尽不再静默丢弃——交宿主持久化队列落盘，
      // 启动/重连 recover 重投（relay_events 幂等，重投零副作用）。未注入
      // onExhausted 时退化为原行为（仅 console.error），降级安全。
      console.error(
        '[DeliveryBatchBuffer] in-memory retries exhausted after %d attempts; handing off to persist queue: '
          + 'session=%s events=%d types=%o',
        RELAY_RETRY_DELAYS_MS.length,
        this.sessionId,
        events.length,
        events.map(e => e.type),
      )
      try {
        this.onExhausted?.(this.sessionId, events)
      } catch (err) {
        console.error('[DeliveryBatchBuffer] onExhausted handoff threw (batch lost):', err)
      }
      this.settleDelivery()
      return
    }

    await this.sleep(delay)
    if (this.cancelled) {
      this.settleDelivery()
      return
    }

    try {
      await this.transport.send(this.sessionId, events)
      this.settleDelivery()
    } catch (err) {
      if (this.dropNonRetryableRelayFailure(err, events)) {
        this.settleDelivery()
        return
      }
      console.warn(
        '[DeliveryBatchBuffer] retry %d/%d failed: session=%s err=%o',
        attempt + 1,
        RELAY_RETRY_DELAYS_MS.length,
        this.sessionId,
        err,
      )
      await this.retryUntilDone(events, attempt + 1)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer)
        resolve()
      }, ms)
      this.retryTimers.add(timer)
    })
  }

  private dropNonRetryableRelayFailure(
    err: unknown,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ): boolean {
    const relayFailure = parseRelayFailureFromError(err)
    if (!relayFailure || relayFailure.retryable !== false || relayFailure.errorCode === 'unknown') {
      return false
    }
    console.warn(
      '[DeliveryBatchBuffer] non-retryable relay failure; dropping batch without retry: '
        + 'session=%s events=%d error=%s',
      this.sessionId,
      events.length,
      relayFailure.errorCode,
    )
    return true
  }

  private settleDelivery(): void {
    if (this.pendingDeliveries > 0) this.pendingDeliveries -= 1
    this.notifyIfSettled()
  }

  private notifyIfSettled(): void {
    if (this.settledNotified || !this.disposed || this.pendingDeliveries > 0) return
    this.settledNotified = true
    this.onSettled?.()
  }
}
