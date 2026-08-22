/**
 * EventEmitter —— agent-runtime 出站事件的**发射 + envelope 约定唯一所有者**
 * （事件系统深度重构 · 第 1 层）。
 *
 * 本模块吸收原 `wire/stamp-event.ts` 的 egress 盖章职责：所有离开 runtime 的事件
 * （两个出口：generator yield + `config.emitStreamEvent` 注入 sink）都经此补齐
 * **身份键 `event_id`（去重）** 与 **排序键 `arrival_seq`（时间线）**，幂等——
 * 已带的原样返回（wrap 透传的内层身份不被重造）。
 *
 * 本模块现统一拥有：event_id、arrival_seq、protocol_version、thread_id、run_id、
 * trace_id，以及 6 件套 query 内 `_seq`。DeliveryBatchBuffer 已降为纯缓冲/传输边界，
 * EnvelopeEmitter 只保留 message/hint 状态。
 *
 * 约束：唯一分配点仍是 `nextArrivalSeq()` / `nextEventId()`（低层计数器，单一来源）；
 * 本模块只负责「无则补、幂等、不 mutate 入参」，不引入第二个序号 / 身份源。
 */

import { PROTOCOL_VERSION_V2 } from '../engine/contracts/stream-events.js';
import type { StreamEvent } from '../engine/contracts/wire-protocol.js';
import type { AgentEvent } from './agent-event.js';

export interface EventEmitterContext {
  agentId?: string;
  traceId?: string;
  threadId?: string;
  runId?: string;
  subagentRunId?: string;
}

// ── event_id / arrival_seq 唯一分配源 ────────────────────────────────
// 约定与 emitter 同模块持有，避免身份/排序规则散落 wire helper。
const PROCESS_NONCE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
let eventIdCounter = 0;
let lastArrivalSeq = 0;

function nextEventId(): string {
  eventIdCounter += 1;
  return `${PROCESS_NONCE}-${eventIdCounter.toString(36)}`;
}

/** 显式需要预留时间线位置的领域事件（user/persist）也复用 emitter 的唯一序号源。 */
export function nextArrivalSeq(): number {
  const micros = Date.now() * 1000;
  lastArrivalSeq = micros > lastArrivalSeq ? micros : lastArrivalSeq + 1;
  return lastArrivalSeq;
}

/**
 * egress 盖章：补 `arrival_seq`（排序）+ `event_id`（身份/去重），幂等、返回新对象。
 *
 * 两个 runtime 出口（generator yield + emitStreamEvent sink）唯一盖章实现——取代
 * 原 `wire/stamp-event.ts` 的 `stampEgressEvent`（其逻辑已并入本函数，所有权在此）。
 */
export function stampEgressEvent(event: StreamEvent): StreamEvent {
  const payload = event.payload as Record<string, unknown> | undefined;
  const hasArrival = payload && typeof payload.arrival_seq === 'number';
  const hasEventId = payload && typeof payload.event_id === 'string' && payload.event_id;
  if (hasArrival && hasEventId) return event;
  return {
    ...event,
    payload: {
      ...(payload ?? {}),
      ...(hasArrival ? {} : { arrival_seq: nextArrivalSeq() }),
      ...(hasEventId ? {} : { event_id: nextEventId() }),
    },
  };
}

/**
 * 单个 runtime 出站发射器：持有目标 sink（宿主注入的 `emitStreamEvent`），把
 * `AgentEvent` 构造 + egress 盖章 + 投递收敛到一处。调用方只 `emit(new XEvent(...))`，
 * 不再手写 `{ type, payload }` 或散补 event_id/arrival_seq。
 */
export class EventEmitter {
  private sequence: number;
  private scopeActive = false;

  constructor(
    private readonly sink?: (event: StreamEvent) => void,
    private readonly context: EventEmitterContext = {},
    initialSeq = 0,
  ) {
    this.sequence = initialSeq;
  }

  /**
   * 构造完整 envelope 公共字段。六件套的 `_seq` 只在这里分配；调用方不再自行维护。
   */
  envelopeFields(needsSeq = false): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION_V2,
      min_compatible_version: PROTOCOL_VERSION_V2,
      ...(this.context.traceId ? { trace_id: this.context.traceId } : {}),
      ...(this.context.threadId ? { thread_id: this.context.threadId } : {}),
      ...(this.context.runId ? { run_id: this.context.runId } : {}),
      ...(this.context.subagentRunId ? { subagent_run_id: this.context.subagentRunId } : {}),
      ...(this.context.agentId ? { agent_id: this.context.agentId } : {}),
      arrival_seq: nextArrivalSeq(),
      event_id: nextEventId(),
    };
    if (needsSeq) {
      fields._seq = this.sequence;
      this.sequence += 1;
    }
    return fields;
  }

  /** 新 query 开始：清 run/trace 与 query 内序号，thread 级上下文保留。 */
  beginScope(): void {
    if (this.scopeActive) {
      throw new Error('EventEmitter does not allow concurrent query scopes');
    }
    this.scopeActive = true;
    this.context.traceId = undefined;
    this.context.runId = undefined;
    this.sequence = 0;
  }

  /** 当前 query 结束；保留最后 trace 供 outlive query 的后台子事件使用。 */
  endScope(): void {
    this.scopeActive = false;
  }

  /** 只从父 query 权威 lifecycle.start 吸收 run / trace；子事件不得污染父 scope。 */
  private observeContext(event: StreamEvent): void {
    if (event.type !== 'agent.stream.lifecycle' || event.payload.phase !== 'start') return;
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.trace_id === 'string' && payload.trace_id) {
      this.context.traceId = payload.trace_id;
    }
    if (typeof payload.run_id === 'string' && payload.run_id) {
      this.context.runId = payload.run_id;
    }
  }

  /** 对已经由 AgentEvent 构造出的 StreamEvent 统一补上下文与 egress 约定。 */
  buildStream<TEvent extends StreamEvent = StreamEvent>(raw: TEvent): TEvent {
    const payload = raw.payload as Record<string, unknown>;
    this.observeContext(raw);
    const contextual: StreamEvent = {
      ...raw,
      payload: {
        ...(payload.protocol_version === undefined
          ? { protocol_version: PROTOCOL_VERSION_V2 }
          : {}),
        ...(payload.min_compatible_version === undefined
          ? { min_compatible_version: PROTOCOL_VERSION_V2 }
          : {}),
        ...(this.context.traceId && payload.trace_id === undefined
          ? { trace_id: this.context.traceId }
          : {}),
        ...(this.context.threadId && payload.thread_id === undefined
          ? { thread_id: this.context.threadId }
          : {}),
        ...(this.context.runId && payload.run_id === undefined
          ? { run_id: this.context.runId }
          : {}),
        ...(this.context.subagentRunId && payload.subagent_run_id === undefined
          ? { subagent_run_id: this.context.subagentRunId }
          : {}),
        ...(this.context.agentId && payload.agent_id === undefined
          ? { agent_id: this.context.agentId }
          : {}),
        ...payload,
      },
    };
    return stampEgressEvent(contextual) as TEvent;
  }

  /** 构造 + 补上下文/序号 + egress 盖章，但不投递（generator / EnvelopeEmitter 用）。 */
  build<TEvent extends StreamEvent = StreamEvent>(event: AgentEvent): TEvent {
    const raw = event.toStreamEvent();
    const payload = raw.payload as Record<string, unknown>;
    const contextual: StreamEvent = {
      ...raw,
      payload: {
        ...(this.context.traceId && payload.trace_id === undefined
          ? { trace_id: this.context.traceId }
          : {}),
        ...(this.context.threadId && payload.thread_id === undefined
          ? { thread_id: this.context.threadId }
          : {}),
        ...(this.context.runId && payload.run_id === undefined
          ? { run_id: this.context.runId }
          : {}),
        ...(this.context.subagentRunId && payload.subagent_run_id === undefined
          ? { subagent_run_id: this.context.subagentRunId }
          : {}),
        ...(event.needsSeq && payload._seq === undefined
          ? { _seq: this.sequence++ }
          : {}),
        ...payload,
      },
    };
    return this.buildStream(contextual) as TEvent;
  }

  /** 发射一个 AgentEvent：组装领域 payload → 继承身份（wrap）→ egress 盖章 → 投递。 */
  emit(event: AgentEvent): void {
    if (!this.sink) throw new Error('EventEmitter.emit requires a sink');
    this.sink(this.build(event));
  }

  /** 已由领域 AgentEvent 构造为 StreamEvent 的兼容出口（宿主预构造组件用）。 */
  emitStream(event: StreamEvent): void {
    if (!this.sink) throw new Error('EventEmitter.emitStream requires a sink');
    this.sink(this.buildStream(event));
  }

  /** 下一条 needsSeq 事件会使用的 query 内序号。 */
  get currentSeq(): number {
    return this.sequence;
  }
}
