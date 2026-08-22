/**
 * ：入站 stream / WS resume 回放分片 drain。
 *
 * resume 一次可回放数千条 agent.stream.*；若在单个 onmessage 同步打穿 handler，
 * 渲染主线程被占满 → 点击无响应，但思考区仍在更新（同一条同步路径）。
 *
 * 本模块把事件入队，按帧让出主线程；同一切片内 text/thinking delta
 * （含包在 `subagent_stream_event` 里的子 Agent delta，）合并为一条，
 * 降低 reduce 次数。
 */

import {
  cancelFrame,
  scheduleFrame,
} from '@/stores/chat/messages/actions/sendMessageFrameScheduler'
import { StreamEvents } from '@tabtin/agent-wire'
import type { AgentStreamMessage } from '@/stores/chat/stream/handlers/streamMessageHandler'

/** 每帧最多处理的原始入队条数（合批前）。约 60fps × 80 ≈ 4800/s 上限，仍可响应输入。 */
export const INBOUND_DRAIN_MAX_PER_SLICE = 80

/** 有待审批交互时降速，为点击/输入保留主线程时间片（ Intel 审批卡死）。 */
export const INBOUND_DRAIN_MAX_PER_SLICE_DURING_HITL = 12

const HIGH_PRIORITY_INBOUND_TYPES = new Set<string>([
  StreamEvents.APPROVAL_REQUESTED,
  StreamEvents.APPROVAL_RESOLVED,
  StreamEvents.SINGLE_HITL_RESOLVED,
  StreamEvents.ASK_USER_REQUIRED,
  StreamEvents.ASK_FORM_REQUIRED,
  StreamEvents.REQUEST_APPROVAL_REQUIRED,
])

export function isHighPriorityInboundMessage(message: AgentStreamMessage): boolean {
  return HIGH_PRIORITY_INBOUND_TYPES.has(message.type)
}

export interface InboundEventDrainOptions {
  /** HITL / ask 等需立即落地，不走 drain 排队（与 ipc-main 捷径对齐）。 */
  isHighPriority?: (message: AgentStreamMessage) => boolean
  /** 审批交互窗口内缩小每帧预算。 */
  getMaxPerSlice?: () => number
}

type ProcessFn = (message: AgentStreamMessage) => void

interface CoalesceKey {
  /** 顶层 delta 为空串；wrapped 子 Agent delta 为 `subagent_run_id`。 */
  runId: string
  messageId: string
  index: number
  deltaType: 'text_delta' | 'thinking_delta' | 'connector_text_delta'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function readSubagentRunId(message: AgentStreamMessage): string {
  const payload = isRecord(message.payload) ? message.payload : null
  return typeof payload?.subagent_run_id === 'string' ? payload.subagent_run_id : ''
}

function readInnerDeltaPayload(message: AgentStreamMessage): Record<string, unknown> | null {
  if (message.type === 'agent.stream.content_block_delta') {
    return isRecord(message.payload) ? message.payload : null
  }
  if (message.type !== StreamEvents.SUBAGENT_STREAM_EVENT) return null
  const payload = isRecord(message.payload) ? message.payload : null
  const child = payload?.child_event
  if (!isRecord(child) || child.type !== 'agent.stream.content_block_delta') return null
  return isRecord(child.payload) ? child.payload : null
}

function readDeltaCoalesceKey(message: AgentStreamMessage): CoalesceKey | null {
  const payload = readInnerDeltaPayload(message)
  if (!payload) return null
  if (message.type === StreamEvents.SUBAGENT_STREAM_EVENT && !readSubagentRunId(message)) {
    return null
  }
  const messageId = typeof payload.message_id === 'string' ? payload.message_id : ''
  const index = typeof payload.index === 'number' ? payload.index : NaN
  const delta = payload.delta
  if (!messageId || !Number.isFinite(index) || !isRecord(delta)) return null
  const deltaType = delta.type
  if (
    deltaType !== 'text_delta' &&
    deltaType !== 'thinking_delta' &&
    deltaType !== 'connector_text_delta'
  ) {
    return null
  }
  return { runId: readSubagentRunId(message), messageId, index, deltaType }
}

function sameCoalesceKey(a: CoalesceKey, b: CoalesceKey): boolean {
  return (
    a.runId === b.runId
    && a.messageId === b.messageId
    && a.index === b.index
    && a.deltaType === b.deltaType
  )
}

/**
 * 找可合批的前一条。顶层 delta 仍只合相邻；wrapped 子 Agent delta
 * 可越过其他 run 的事件，但不越过同一 run 的非同 key 事件（stop / 换块）。
 */
function findCoalesceTargetIndex(out: AgentStreamMessage[], key: CoalesceKey): number {
  for (let i = out.length - 1; i >= 0; i--) {
    const prevKey = readDeltaCoalesceKey(out[i])
    if (prevKey && sameCoalesceKey(prevKey, key)) return i
    if (!key.runId) return -1
    const prevRunId = prevKey?.runId || readSubagentRunId(out[i])
    if (prevRunId === key.runId) return -1
  }
  return -1
}

function appendDeltaText(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  deltaType: CoalesceKey['deltaType'],
): void {
  if (deltaType === 'text_delta') {
    const prev = typeof target.text === 'string' ? target.text : ''
    const next = typeof source.text === 'string' ? source.text : ''
    target.text = prev + next
    return
  }
  if (deltaType === 'thinking_delta') {
    const prev = typeof target.thinking === 'string' ? target.thinking : ''
    const next = typeof source.thinking === 'string' ? source.thinking : ''
    target.thinking = prev + next
    return
  }
  const prev = typeof target.connector_text === 'string' ? target.connector_text : ''
  const next = typeof source.connector_text === 'string' ? source.connector_text : ''
  target.connector_text = prev + next
}

function mergeDeltaPayloads(
  prevPayload: Record<string, unknown>,
  nextPayload: Record<string, unknown>,
  deltaType: CoalesceKey['deltaType'],
): Record<string, unknown> {
  const prevDelta = { ...(prevPayload.delta as Record<string, unknown>) }
  const nextDelta = nextPayload.delta as Record<string, unknown>
  appendDeltaText(prevDelta, nextDelta, deltaType)
  const merged: Record<string, unknown> = { ...prevPayload, delta: prevDelta }
  if (typeof nextPayload.seq === 'number') merged.seq = nextPayload.seq
  if (typeof nextPayload.arrival_seq === 'number') merged.arrival_seq = nextPayload.arrival_seq
  return merged
}

function mergeCoalescedMessage(
  prev: AgentStreamMessage,
  next: AgentStreamMessage,
  key: CoalesceKey,
): AgentStreamMessage {
  if (prev.type === StreamEvents.SUBAGENT_STREAM_EVENT) {
    const prevPayload = { ...(prev.payload as Record<string, unknown>) }
    const prevChild = { ...(prevPayload.child_event as Record<string, unknown>) }
    const nextChild = (next.payload as Record<string, unknown>).child_event as Record<string, unknown>
    prevChild.payload = mergeDeltaPayloads(
      prevChild.payload as Record<string, unknown>,
      nextChild.payload as Record<string, unknown>,
      key.deltaType,
    )
    prevPayload.child_event = prevChild
    const nextSeq = (next.payload as Record<string, unknown>).seq
    if (typeof nextSeq === 'number') prevPayload.seq = nextSeq
    const nextArrival = (next.payload as Record<string, unknown>).arrival_seq
    if (typeof nextArrival === 'number') prevPayload.arrival_seq = nextArrival
    if (typeof next.event_id === 'string') {
      return { ...prev, payload: prevPayload, event_id: next.event_id }
    }
    return { ...prev, payload: prevPayload }
  }

  const prevPayload = mergeDeltaPayloads(
    prev.payload as Record<string, unknown>,
    next.payload as Record<string, unknown>,
    key.deltaType,
  )
  if (typeof next.event_id === 'string') {
    return { ...prev, payload: prevPayload, event_id: next.event_id }
  }
  return { ...prev, payload: prevPayload }
}

/**
 * 跨源重复身份键（与 streamMessageHandler 入口去重对齐）：
 * 优先 `event_id`，否则 `arrival_seq`。同一键 = 同一条物理发射的副本
 * （ipc-main + ipc-bridge 同 channel 双订，或 IPC + WS 镜像）。
 *
 * 合批必须在「拼 text」之前识别副本——否则两路同 delta 会先被拼成
 * 「你好你好」，再进 handler 时只剩一条，event_id 去重也救不回来。
 */
function readStreamEventIdentity(message: AgentStreamMessage): string | number | undefined {
  const payload = message.payload && typeof message.payload === 'object'
    ? (message.payload as Record<string, unknown>)
    : null
  const payloadEventId = typeof payload?.event_id === 'string' && payload.event_id
    ? payload.event_id
    : undefined
  const topEventId = typeof message.event_id === 'string' && message.event_id
    ? message.event_id
    : undefined
  const eventId = payloadEventId ?? topEventId
  if (eventId !== undefined) return eventId
  if (typeof payload?.arrival_seq === 'number') return payload.arrival_seq
  return undefined
}

/**
 * 将同一切片内「同一 run/message/index/deltaType」的 text/thinking delta 合并为一条。
 *
 * 顶层 `content_block_delta` 仍只合相邻、不跨越中间其它事件。
 * 包在 `subagent_stream_event` 里的 delta 按 `subagent_run_id` 合批，可越过
 * 其它子 Agent 的交错事件，但不越过同一 run 的 stop / 换块。
 *
 * 同身份键的跨源副本只保留先到的一条，绝不拼接正文。
 */
export function coalesceStreamMessages(messages: AgentStreamMessage[]): AgentStreamMessage[] {
  if (messages.length <= 1) return messages
  const out: AgentStreamMessage[] = []
  for (const message of messages) {
    const key = readDeltaCoalesceKey(message)
    const targetIndex = key ? findCoalesceTargetIndex(out, key) : -1
    const prev = targetIndex >= 0 ? out[targetIndex] : undefined
    if (key && prev) {
      const prevIdentity = readStreamEventIdentity(prev)
      const nextIdentity = readStreamEventIdentity(message)
      // ipc-main / ipc-bridge（或 IPC / WS）同帧各投递一次：身份相同则丢后到副本
      if (
        prevIdentity !== undefined
        && nextIdentity !== undefined
        && prevIdentity === nextIdentity
      ) {
        continue
      }
      out[targetIndex] = mergeCoalescedMessage(prev, message, key)
      continue
    }
    out.push(message)
  }
  return out
}

/**
 * 入站分片 drain。持有 per-session 队列 + rAF 句柄 + disposed 生命周期，
 * class 化让这些实例态有明确宿主（取代原工厂闭包）。每个 SessionStreamHub 一个实例。
 */
export class InboundEventDrain {
  private readonly queue: AgentStreamMessage[] = []
  private frameId: number | null = null
  private disposed = false

  constructor(
    private readonly process: ProcessFn,
    private readonly options?: InboundEventDrainOptions,
  ) {}

  private resolveMaxPerSlice(): number {
    return Math.max(1, this.options?.getMaxPerSlice?.() ?? INBOUND_DRAIN_MAX_PER_SLICE)
  }

  private readonly runSlice = (): void => {
    this.frameId = null
    if (this.disposed || this.queue.length === 0) return
    const raw = this.queue.splice(0, this.resolveMaxPerSlice())
    const batch = coalesceStreamMessages(raw)
    for (const message of batch) {
      try {
        this.process(message)
      } catch (err) {
        console.error('[InboundEventDrain] process failed:', err)
      }
    }
    if (this.queue.length > 0) this.schedule()
  }

  private schedule(): void {
    if (this.disposed || this.frameId !== null) return
    this.frameId = scheduleFrame(this.runSlice)
  }

  private isHighPriority(message: AgentStreamMessage): boolean {
    return this.options?.isHighPriority?.(message) ?? isHighPriorityInboundMessage(message)
  }

  enqueue(message: AgentStreamMessage): void {
    if (this.disposed) {
      this.process(message)
      return
    }
    if (this.isHighPriority(message)) {
      try {
        this.process(message)
      } catch (err) {
        console.error('[InboundEventDrain] high-priority process failed:', err)
      }
      return
    }
    this.queue.push(message)
    this.schedule()
  }

  /** 同步排空队列（detach / 测试）。 */
  flushSync(): void {
    if (this.frameId !== null) {
      cancelFrame(this.frameId)
      this.frameId = null
    }
    const maxPerSlice = this.resolveMaxPerSlice()
    while (this.queue.length > 0) {
      const raw = this.queue.splice(0, maxPerSlice)
      const batch = coalesceStreamMessages(raw)
      for (const message of batch) {
        try {
          this.process(message)
        } catch (err) {
          console.error('[InboundEventDrain] process failed:', err)
        }
      }
    }
  }

  get pendingCount(): number {
    return this.queue.length
  }

  dispose(): void {
    this.flushSync()
    this.disposed = true
  }
}
