/**
 * user 事件族（AgentEvent 子类）—— runtime yield 的「用户侧」消息事件
 * （事件系统深度重构 · 第 2 层）。
 *
 * 覆盖：本轮真实 user query、环境快照（message_kind='environment_context'）、
 * agent-profile 注入（message_kind='agent_profile_context'，）、
 * skill 注入（source='skill_invoke'）、push 通知注入（triggered_by='push-notification'）。
 * payload 半结构化（具名约定字段 + 各来源自带字段），wire 形状不变。
 *
 * `arrival_seq`：多数由调用方按语义显式给（如环境快照的 pending 序、真 user 的
 * nextArrivalSeq）；缺省时由 EventEmitter egress 盖。
 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import { AgentEvent } from '../agent-event.js';

export interface UserEventPayload {
  client_event_id?: string;
  message_id?: string;
  content?: string;
  source?: string;
  message_kind?: string;
  triggered_by?: string;
  arrival_seq?: number;
  [key: string]: unknown;
}

export class UserEvent extends AgentEvent {
  readonly type = StreamEvents.USER;
  constructor(private readonly payload: UserEventPayload) {
    super();
  }
  protected data(): Record<string, unknown> {
    return { ...this.payload };
  }
}
