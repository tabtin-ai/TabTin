/**
 * 上下文压缩事件族。
 *
 * public wire 契约继续由 `wire-protocol.ts` 的接口定义；这里提供唯一构造入口，
 * 同时区分 runtime 流事件（phase=start/end）与 transcript 内部历史记录
 * （历史 phase=done），避免同一个裸 type 字符串被不同语义随意拼装。
 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import type {
  CompactionEvent,
  ContextPressureEvent,
} from '../../engine/contracts/wire-protocol.js';
import { TypedAgentEvent } from '../agent-event.js';

/** 对外 runtime compaction 流事件（phase=start/end）。 */
export class RuntimeCompactionEvent extends TypedAgentEvent<CompactionEvent> {
  constructor(payload: CompactionEvent['payload']) {
    super(StreamEvents.COMPACTION, payload);
  }
}

/** 对外上下文压力事件。 */
export class RuntimeContextPressureEvent extends TypedAgentEvent<ContextPressureEvent> {
  constructor(payload: ContextPressureEvent['payload']) {
    super(StreamEvents.CONTEXT_PRESSURE, payload);
  }
}

/** SessionStorage 内部 compaction 完成记录（历史契约 phase=done，不对外发射）。 */
export class CompactionRecordEvent extends TypedAgentEvent<{
  type: 'agent.stream.compaction';
  payload: {
    phase: 'done';
    summary: string;
    tokens_freed: number;
    mode: string;
  } & Record<string, unknown>;
}> {
  constructor(payload: {
    summary: string;
    tokens_freed: number;
    mode: string;
  }) {
    super(StreamEvents.COMPACTION, { phase: 'done', ...payload });
  }
}

/** 对话回退软标记（SessionStorage 内部 transcript 事件）。 */
export class RewindMarkEvent extends TypedAgentEvent<{
  type: 'agent.stream.rewind';
  payload: {
    phase: 'mark';
    keep_message_count: number;
  } & Record<string, unknown>;
}> {
  constructor(keepMessageCount: number) {
    super(StreamEvents.REWIND, {
      phase: 'mark',
      keep_message_count: keepMessageCount,
    });
  }
}
