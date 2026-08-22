/** HITL 实时卡片/终态事件（与持久化 HitlInteractionEvent 分工）。 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import { AgentEvent } from '../agent-event.js';

export type AskRequiredEventType =
  | typeof StreamEvents.ASK_USER_REQUIRED
  | typeof StreamEvents.ASK_FORM_REQUIRED
  | typeof StreamEvents.REQUEST_APPROVAL_REQUIRED;

/** 单 HITL kind → ask_* wire 事件类型（供 crash resume restorer 使用，避免新文件直引 agent-wire）。 */
export const HITL_KIND_TO_ASK_EVENT_TYPE = {
  ask_choice: StreamEvents.ASK_USER_REQUIRED,
  ask_form: StreamEvents.ASK_FORM_REQUIRED,
  permission_request: StreamEvents.REQUEST_APPROVAL_REQUIRED,
} as const satisfies Record<string, AskRequiredEventType>;

export class ApprovalRequestedEvent extends AgentEvent {
  readonly type = StreamEvents.APPROVAL_REQUESTED;
  constructor(private readonly payload: Record<string, unknown>) { super(); }
  protected data(): Record<string, unknown> { return { ...this.payload }; }
}

export class ApprovalResolvedEvent extends AgentEvent {
  readonly type = StreamEvents.APPROVAL_RESOLVED;
  constructor(private readonly payload: Record<string, unknown>) { super(); }
  protected data(): Record<string, unknown> { return { ...this.payload }; }
}

export class AskRequiredEvent extends AgentEvent {
  constructor(
    readonly type: AskRequiredEventType,
    private readonly payload: Record<string, unknown>,
  ) {
    super();
  }
  protected data(): Record<string, unknown> { return { ...this.payload }; }
}

export class SingleHitlResolvedEvent extends AgentEvent {
  readonly type = StreamEvents.SINGLE_HITL_RESOLVED;
  constructor(private readonly payload: Record<string, unknown>) { super(); }
  protected data(): Record<string, unknown> { return { ...this.payload }; }
}
