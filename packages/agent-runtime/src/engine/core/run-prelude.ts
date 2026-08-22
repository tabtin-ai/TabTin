/**
 * Run 前置领域（ 批次 6c，自 query.ts 收编）——初始装填 / pairing 修复 /
 * historical 标记 / 审批恢复（crash resume，经 `deps.interrupt.resumePending`）/
 * 主 user 事件 / 环境上下文补发。
 *
 * 协作对象形态：构造时注入一次 RunContext；环境上下文补发的两个游标
 * （pendingEnvContextSeq / envContextPersistEmitted）由本类持有——那是
 * 前置域的续发状态，不是主循环状态机的一部分。
 */
import type { StreamEvent, SystemNoticeEvent } from '../contracts/wire-protocol.js';
import type { RunContext } from './run-context.js';
import {
  emitMainUserEventPhase,
  emitPendingEnvironmentContextPhase,
  emitPendingAgentProfilePhase,
  prepareInitialMessages,
  restorePendingApprovalsPhase,
} from './run-prelude-phases.js';
import type { EnvironmentContextEmitState } from './run-prelude-phases.js';
import type { MessageOversizedIncompressible } from '../guards/message-size-budget.js';
export {
  markHistoricalContextMessages,
  markHistoricalAgentProfileMessages,
  repairMessagePairingInState,
} from './run-prelude-phases.js';

export class RunPrelude {
  /** 主 user 事件与环境上下文补发的续发游标（前置域状态）。 */
  private readonly environmentState: EnvironmentContextEmitState = {
    pendingEnvContextSeq: null,
    envContextPersistEmitted: false,
  };

  constructor(
    private readonly ctx: RunContext,
    private readonly preDeeplyNestedRef: { current: MessageOversizedIncompressible[] },
  ) {}

  /** 初始消息装填：historical 标记 / 动态工具恢复 / pairing 修复 / 压缩 force 标记。 */
  applyInitialMessages(): void {
    prepareInitialMessages({
      ctx: this.ctx,
      preDeeplyNestedRef: this.preDeeplyNestedRef,
    });
  }

  /** crash resume：未决审批快照恢复（经 `deps.interrupt.resumePending`）。 */
  async *restorePendingApprovals(): AsyncGenerator<SystemNoticeEvent, void, undefined> {
    yield* restorePendingApprovalsPhase(this.ctx);
  }

  /** 主 user 事件（fork / resume 装填路径按 clientMessageId 判定是否补发）。 */
  *emitMainUserEvent(): Generator<StreamEvent, void, undefined> {
    yield* emitMainUserEventPhase({
      ctx: this.ctx,
      environmentState: this.environmentState,
    });
  }

  /**
   * 环境上下文补发：主 user 事件之后、首轮 LLM 请求之前，把 context-injector
   * 注入的 environment 块以独立 USER 事件补发一次（arrival_seq 用主 user 事件
   * 时预留的游标，保证时间线顺序在真 user 消息之后）。
   */
  *emitPendingEnvironmentContext(): Generator<StreamEvent, void, undefined> {
    yield* emitPendingEnvironmentContextPhase({
      ctx: this.ctx,
      environmentState: this.environmentState,
    });
  }

  /** ：本 run 若重新注入了 agent-profile，落库为独立 USER 事件。 */
  *emitPendingAgentProfile(): Generator<StreamEvent, void, undefined> {
    yield* emitPendingAgentProfilePhase(this.ctx);
  }
}
