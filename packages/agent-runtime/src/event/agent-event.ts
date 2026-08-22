/**
 * AgentEvent —— agent-runtime 出站 stream 事件的**构造基类**（事件系统深度重构 · 第 1 层）。
 *
 * 背景：历史上事件以裸对象字面量 `{ type: StreamEvents.X, payload: {...} }` 散落在
 * completion / shell / permissions / agent-tool 等 ~90 处构造，公共约定（event_id 身份、
 * arrival_seq 排序、_seq 重组、trace/thread envelope）由 stamp-event / envelope-emitter /
 * DeliveryBatchBuffer 各补一块。本重构把「构造」收敛到 AgentEvent 子类、「发射 + 约定盖章」收敛到
 * `EventEmitter`（见 event-emitter.ts），成为约定的唯一所有者。
 *
 * 约束（wire 不变）：序列化出站仍是 `{ type: string, payload: Record<string, unknown> }`；
 * 基类只做**构造期**封装，不改字段命名、不改 wire JSON 形状。身份/排序/trace/_seq 等
 * envelope 约定字段**不在** `data()` 里写——由 `EventEmitter` 在发射出口统一盖，保证
 * 「一次发射一次身份、wrap 只搬运」的去重契约集中在一处。
 */

import type { StreamEvent } from '../engine/contracts/wire-protocol.js';

/** wrap 场景（SUBAGENT_STREAM_EVENT 等）携带的被包装事件身份——EventEmitter 据此不重造。 */
export interface InheritedIdentity {
  event_id?: string;
  arrival_seq?: number;
  trace_id?: string;
  run_id?: string;
  thread_id?: string;
}

export abstract class AgentEvent {
  /** wire 事件类型（`agent.stream.*` 字面量，与 StreamEvents / ContentBlockEvents 兼容）。 */
  abstract readonly type: string;

  /**
   * 领域 payload —— 只含本事件的业务字段，**不含** event_id / arrival_seq / _seq /
   * trace_id / thread_id / protocol_version 等 envelope 约定字段（由 EventEmitter 盖）。
   */
  protected abstract data(): Record<string, unknown>;

  /**
   * 是否需要 query 内单调 `_seq`（6 件套流式重组键）。默认 false——多数业务事件按
   * 全局 `arrival_seq` 排序即可；仅 message/content_block 六件套需要 query 内重组。
   */
  readonly needsSeq: boolean = false;

  /**
   * wrap 时携带被包装事件的身份键（inheritStreamIdentity 语义）：EventEmitter 发现
   * 已继承身份时不再 mint 新 event_id/arrival_seq，保证「同一逻辑发射多传输副本同 id」。
   */
  readonly inherited?: InheritedIdentity;

  /** 组装成裸 StreamEvent（仅领域字段）；envelope 约定字段由 EventEmitter 出口盖。 */
  toStreamEvent(): StreamEvent {
    return {
      type: this.type,
      payload: {
        ...this.data(),
        ...(this.inherited?.event_id ? { event_id: this.inherited.event_id } : {}),
        ...(typeof this.inherited?.arrival_seq === 'number'
          ? { arrival_seq: this.inherited.arrival_seq }
          : {}),
        ...(this.inherited?.trace_id ? { trace_id: this.inherited.trace_id } : {}),
        ...(this.inherited?.run_id ? { run_id: this.inherited.run_id } : {}),
        ...(this.inherited?.thread_id ? { thread_id: this.inherited.thread_id } : {}),
      },
    };
  }
}

/**
 * 复用既有 public wire interface 的 typed 事件实现。
 *
 * `wire-protocol.ts` 里的 `LifecycleEvent` / `CompactionEvent` / `SystemNoticeEvent`
 * 等接口继续作为跨包契约；构造侧用本类把接口的 `type` 与 `payload` 绑定起来，
 * 避免重新抄一份字段定义，也避免迁移成 class 后丢掉原有 `satisfies` 类型检查。
 */
export class TypedAgentEvent<TEvent extends StreamEvent> extends AgentEvent {
  readonly type: TEvent['type'];

  constructor(
    type: TEvent['type'],
    private readonly payload: TEvent['payload'],
    readonly inherited?: InheritedIdentity,
    override readonly needsSeq: boolean = false,
  ) {
    super();
    this.type = type;
  }

  protected data(): TEvent['payload'] {
    return this.payload;
  }

  override toStreamEvent(): TEvent {
    return {
      type: this.type,
      payload: {
        ...this.data(),
        ...(this.inherited?.event_id ? { event_id: this.inherited.event_id } : {}),
        ...(typeof this.inherited?.arrival_seq === 'number'
          ? { arrival_seq: this.inherited.arrival_seq }
          : {}),
        ...(this.inherited?.trace_id ? { trace_id: this.inherited.trace_id } : {}),
        ...(this.inherited?.run_id ? { run_id: this.inherited.run_id } : {}),
        ...(this.inherited?.thread_id ? { thread_id: this.inherited.thread_id } : {}),
      },
    } as TEvent;
  }
}
