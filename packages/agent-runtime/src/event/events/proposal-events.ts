/**
 * proposal / todo 事件族（AgentEvent 子类）—— Agent 自身任务状态与待用户拍板的方案
 * （事件系统深度重构 · 第 2 层）。
 *
 * 取代 plan-tools / mode-tools / core-tools 里的内联构造，把事件类型 + payload 形状
 * 收进 typed 类；wire 形状不变。
 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import { AgentEvent } from '../agent-event.js';

/** TODO 列表事件（core-tools `todo`，）。 */
export class TodoEvent extends AgentEvent {
  readonly type = StreamEvents.TODO;
  constructor(
    private readonly args: {
      action: string
      todos: unknown[]
      closed: boolean
    },
  ) {
    super();
  }
  protected data(): Record<string, unknown> {
    return {
      action: this.args.action,
      todos: this.args.todos,
      closed: this.args.closed,
    };
  }
}

/** 方案卡片事件（plan-tools）——正文快照供移动端即时展示（不落库）。 */
export class PlanProposalEvent extends AgentEvent {
  readonly type = StreamEvents.PLAN_PROPOSAL;
  constructor(private readonly args: {
    planDocumentId: string;
    planRef: unknown;
    revision: unknown;
    sessionId?: string;
    planName: unknown;
    overview: unknown;
    todos: unknown;
    descriptionMarkdown: unknown;
  }) {
    super();
  }
  protected data(): Record<string, unknown> {
    const a = this.args;
    return {
      plan_document_id: a.planDocumentId,
      plan_ref: a.planRef,
      revision: a.revision,
      session_id: a.sessionId,
      plan_name: a.planName,
      overview: a.overview,
      todos: a.todos,
      description_markdown: a.descriptionMarkdown,
    };
  }
}

/** 模式切换提案事件（mode-tools）——interrupt 挂起等用户确认。 */
export class ModeSwitchProposalEvent extends AgentEvent {
  readonly type = StreamEvents.MODE_SWITCH_PROPOSAL;
  constructor(private readonly args: {
    proposalId: string;
    fromModeId: string;
    targetModeId: string;
    reason: unknown;
    sessionId: string;
  }) {
    super();
  }
  protected data(): Record<string, unknown> {
    const a = this.args;
    return {
      proposal_id: a.proposalId,
      from_mode_id: a.fromModeId,
      target_mode_id: a.targetModeId,
      reason: a.reason,
      session_id: a.sessionId,
    };
  }
}
