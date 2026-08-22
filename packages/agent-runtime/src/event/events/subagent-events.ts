/**
 * 子 Agent 状态与嵌套流包装事件。
 *
 * `SubagentStreamEvent` 把被包装 child event 的 event_id / arrival_seq 作为
 * `AgentEvent.inherited` 搬到 wrapper 顶层；基类负责序列化继承身份，egress emitter
 * 发现已有身份后不重造，保证 IPC wrapper 与 WS 原始回声可按同一 event_id 去重。
 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import type { StreamEvent } from '../../engine/contracts/wire-protocol.js';
import { AgentEvent, type InheritedIdentity } from '../agent-event.js';

type SubagentStatusEventType =
  | typeof StreamEvents.SUBAGENT_QUEUED
  | typeof StreamEvents.SUBAGENT_STARTED
  | typeof StreamEvents.SUBAGENT_PROGRESS
  | typeof StreamEvents.SUBAGENT_COMPLETED
  | typeof StreamEvents.SUBAGENT_FAILED;

export class SubagentStatusEvent extends AgentEvent {
  constructor(
    readonly type: SubagentStatusEventType,
    private readonly payload: Record<string, unknown>,
  ) {
    super();
  }

  protected data(): Record<string, unknown> {
    return { ...this.payload };
  }
}

export class SubagentStreamEvent extends AgentEvent {
  readonly type = StreamEvents.SUBAGENT_STREAM_EVENT;

  constructor(
    private readonly payload: {
      run_id?: string;
      subagent_run_id: string;
      parent_run_id: string | null;
      subagent_chain: string[];
      child_event: StreamEvent;
    },
    readonly inherited?: InheritedIdentity,
  ) {
    super();
  }

  protected data(): Record<string, unknown> {
    return { ...this.payload };
  }
}
