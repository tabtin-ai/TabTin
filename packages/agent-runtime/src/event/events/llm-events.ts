/** LLM 请求/快照与 provider capability 事件。 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import type {
  LLMUsageEvent,
  LLMRequestEvent,
  StreamEvent,
} from '../../engine/contracts/wire-protocol.js';
import { AgentEvent, TypedAgentEvent } from '../agent-event.js';

export class RuntimeLlmRequestEvent extends TypedAgentEvent<LLMRequestEvent> {
  constructor(payload: LLMRequestEvent['payload']) {
    super(StreamEvents.LLM_REQUEST, payload);
  }
}

export class RuntimeLlmSnapshotEvent extends AgentEvent {
  readonly type = StreamEvents.LLM_SNAPSHOT;
  constructor(private readonly payload: Record<string, unknown>) { super(); }
  protected data(): Record<string, unknown> {
    // snapshot 是独立发射：沿用 trace/run/thread 语义，但不能复用 llm_request 的
    // event_id / arrival_seq / _seq，否则跨源去重会把两个逻辑事件视为同一次发射。
    const {
      event_id: _eventId,
      arrival_seq: _arrivalSeq,
      _seq,
      ...rest
    } = this.payload;
    void _eventId;
    void _arrivalSeq;
    void _seq;
    return rest;
  }
}

export class RuntimeLlmUsageEvent extends TypedAgentEvent<LLMUsageEvent> {
  constructor(payload: LLMUsageEvent['payload']) {
    super(StreamEvents.LLM_USAGE, payload);
  }
}

/** provider 返回的内部 capability_event（非 StreamEvents 常量，但仍走统一事件系统）。 */
export class RuntimeCapabilityEvent extends AgentEvent {
  readonly type = 'agent.stream.capability_event';
  constructor(private readonly payload: StreamEvent['payload']) { super(); }
  protected data(): Record<string, unknown> { return { ...this.payload }; }
}
