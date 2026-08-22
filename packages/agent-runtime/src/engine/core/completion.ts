/**
 * 完成 / 终止判定领域（ 批次 6f，自 query.ts 收编）。
 *
 * **DONE 协议 payload 拼装的唯一领域对象**：grace 收尾、no-tool 完成、
 * continuation、conversation-termination、硬停、共享预算 / credits、
 * max-turns（`state.iteration++` 已拆回主循环——迭代计数是状态机推进）、
 * force-final、context-overflow failed、network partial、abort / error catch。
 *
 * 方法只返回布尔 / 三态信号，控制流决策（continue / break）仍在主循环。
 */
import { MAX_413_RECOVERY_ATTEMPTS } from '../../runtime-defaults.js';
import { TelemetryEvents } from '../../telemetry/events.js';
import type {
  DoneEvent,
  StreamEvent,
} from '../contracts/wire-protocol.js';
import type {
  ContentBlock,
  Message,
  ToolUseBlock,
} from '../contracts/conversation.js';
import type {
  LLMResponseChunk,
} from '../contracts/model-llm.js';
import type {
  AgentErrorCode,
} from '../contracts/kernel.js';
import type { TodoCompletionNudgeProvider } from '../contracts/todo-completion-nudge.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  setInternalMarker,
} from '../contracts/conversation.js';
import {
  AgentError,
} from '../contracts/kernel.js';
import type { RunContext } from './run-context.js';
import { getTotalTokensSoFar } from '../guards/budget-state-sync.js';
import type { ClassifiedError } from '../errors/error-classifier.js';
import { classifyError } from '../errors/error-classifier.js';
import { isAbortError } from './abort.js';
import {
  DEFAULT_ITERATION_BUDGET,
  evaluateIterationBudget,
  buildBudgetGraceToolBlockedNoticeContent,
  budgetTriggerToErrorClass,
} from '../guards/iteration-budget.js';
import type {
  IterationBudgetEvaluation,
  IterationBudgetTrigger,
} from '../guards/iteration-budget.js';
import {
  buildUsagePayload,
  buildPersistMessageEvent,
  buildErrorDonePayload,
  buildBudgetExhaustedDonePayload,
  buildHardStopDonePayload,
  buildHardStopMessageStopErrorInfo,
  buildBudgetExceededMessageStopErrorInfo,
  buildAbortMessageStopErrorInfo,
  buildMappedErrorMessageStopErrorInfo,
  buildClassifiedTerminalErrorInfo,
  mapBudgetReasonToErrorClass,
} from '../wire/done-payloads.js';
import { closeEnvelopeForTerminalError } from '../wire/envelope-emitter.js';
import { nextArrivalSeq } from '../../event/event-emitter.js';
import { buildToolErrorResultBlock } from '../tooling/tool-error.js';
import type { ToolErrorKind } from '../tooling/tool-error.js';
import {
  buildOrphanToolResults,
  extractTerminalOrphanToolUses,
} from '../context/orphan-tool-results.js';
import { extractLatestActionableTodos } from '../../todo/todo-replay.js';
import { RuntimeDoneEvent } from '../../event/events/done-events.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';

const MAX_CONTINUATIONS = 3;
const MAX_TODO_COMPLETION_NUDGES = 2;

export type NoToolUseCompletionResult = 'continue' | 'continue_todo' | 'break' | 'none';

type FinalAssistantPersistArgs = {
  assistantMessage: Message;
  currentLLMMessageId: string;
  stopReason: LLMResponseChunk['stopReason'] | undefined;
};

export type PendingHardStop = {
  source: 'tool_failure' | 'tool_repetition' | 'text_repetition';
} | null;

/** 已落库助手消息的完整快照；终态用同一 message_id 幂等升级 stop/error 语义。 */
export interface AssistantPersistSnapshot {
  messageId: string;
  blocks: ContentBlock[];
}

export interface BudgetSnapshot {
  budgetEval: IterationBudgetEvaluation;
  totalTokensSoFar: number;
  tokenBudgetMax: number;
}

export { getTotalTokensSoFar };

function metricForBudgetTrigger(
  budgetEval: IterationBudgetEvaluation,
  trigger: IterationBudgetTrigger,
  field: 'current' | 'threshold' | 'percent' | 'max',
): number {
  return trigger === 'iteration'
    ? budgetEval.iteration[field]
    : budgetEval.token[field];
}

/**
 * RunTerminator —— 各类终止 / 完成路径的 DONE 协议单点。
 * 构造时注入一次 RunContext；方法内经 accessor 读 run 内可变项。
 */
export class RunTerminator {
  constructor(private readonly ctx: RunContext) {}

  private get usage() {
    return buildUsagePayload(this.ctx.state, this.ctx.config.budgetTracker);
  }

  /**
   * 终态消息的唯一持久化出口。有已落库快照时幂等 upsert 原消息；
   * 模型调用前即终止时，用 assistant client event id 创建空正文错误载体。
   */
  private *persistTerminalMessage(args: {
    stopReason?: 'aborted' | 'error';
    errorInfoJson?: Record<string, unknown>;
    snapshot?: AssistantPersistSnapshot;
    inflightText?: string;
    toolResultBlocks?: ContentBlock[];
    allowSyntheticMessage?: boolean;
    messageKind?: string;
  }): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    const messageId = this.terminalMessageId(args.snapshot, args.allowSyntheticMessage);
    if (!messageId) return;
    const agentRunId = typeof ctx.runId === 'string' ? ctx.runId.trim() : '';
    if (!agentRunId) return;

    const blocks = this.terminalBlocks(args);
    if (blocks.length === 0 && !args.errorInfoJson) return;
    const modelId = typeof ctx.state.model === 'string' ? ctx.state.model.trim() : '';
    yield buildPersistMessageEvent({
      messageId,
      role: 'assistant',
      blocks,
      agentRunId,
      arrivalSeq: nextArrivalSeq(),
      subagentRunId: ctx.config.subagentRunId,
      stopReason: args.stopReason ?? 'error',
      partial: true,
      ...(args.messageKind ? { messageKind: args.messageKind } : {}),
      ...(args.errorInfoJson ? { errorInfoJson: args.errorInfoJson } : {}),
      ...(modelId ? { modelId, modelName: modelId } : {}),
    });
  }

  /**
   * ：预算评估已迁 iteration-budget-policy hook；#4019 批次 9 起经
   * beforeModel outcome 通道回传（`RunContext.getBudgetSnapshot`），不再翻
   * state 黑板字段。#4019 批次 12：快照带齐评估输入（totalTokensSoFar /
   * tokenBudgetMax），内核不再二次解析 `config.iterationBudget`（策略 knob
   * 解析单点在装配层）；hook 未挂载（理论不可达）时按内置默认阈值兜底重算。
   */
  resolveBudgetSnapshot(iteration: number): BudgetSnapshot {
    const ctx = this.ctx;
    const snapshot = ctx.getBudgetSnapshot();
    if (snapshot) {
      return {
        budgetEval: snapshot.budgetEval,
        totalTokensSoFar: snapshot.totalTokensSoFar,
        tokenBudgetMax: snapshot.tokenBudgetMax,
      };
    }
    const tokenBudgetMax = ctx.config.budgetTracker?.getMaxTotalTokens() ?? Infinity;
    const totalTokensSoFar = getTotalTokensSoFar(
      ctx.state,
      ctx.config.budgetTracker,
      ctx.config.budgetScope,
    );
    const budgetEval = evaluateIterationBudget({
      iteration,
      maxTurns: ctx.maxTurns,
      totalTokens: totalTokensSoFar,
      maxTotalTokens: tokenBudgetMax,
      config: DEFAULT_ITERATION_BUDGET,
    });
    return { budgetEval, totalTokensSoFar, tokenBudgetMax };
  }

  *budgetExhaustedBeforeModel(): Generator<StreamEvent, void, undefined> {
    const snapshot = this.ctx.getBudgetSnapshot();
    const trigger: IterationBudgetTrigger =
      snapshot?.budgetEval.trigger
      ?? snapshot?.trigger
      ?? 'iteration';
    const errorInfo = buildBudgetExceededMessageStopErrorInfo(
      budgetTriggerToErrorClass(trigger),
    );
    yield* this.persistTerminalMessage({
      errorInfoJson: { ...errorInfo },
      allowSyntheticMessage: true,
    });
    yield new RuntimeDoneEvent(buildBudgetExhaustedDonePayload({
        trigger,
        finalContent: '',
        usage: this.usage,
        traceId: this.ctx.traceId,
        clientEventId: this.ctx.getAssistantClientEventId(),
    })).toStreamEvent();
  }

  /**
   * 后台子 Agent 等待屏障：非错误结束当前 query，释放 run queue。
   *
   * 子任务全部终态后，SubagentManager 才会把聚合完成通知投入
   * NotificationQueue；现有 idle drain 随后重新激活父 Agent。DONE metadata
   * 让宿主 / UI 能区分“等待中”与真正完成，同时保持旧消费者按 happy path 收尾。
   */
  buildSuspendedDoneEvent(args: {
    reason: 'awaiting_subagents';
    pendingSubagentIds: string[];
  }): DoneEvent {
    return new RuntimeDoneEvent({
      content: '',
      error: false,
      usage: this.usage,
      trace_id: this.ctx.traceId,
      metadata: {
        run_state: 'awaiting_subagents',
        suspension_reason: args.reason,
        pending_subagent_ids: args.pendingSubagentIds,
      },
    }).toStreamEvent();
  }

  /**
   * 安全宿主交接：当前 query 已成功结束，宿主可在终态持久化后
   * 重建执行环境并发起后续 turn。reason 对 runtime 不透明。
   */
  buildHostHandoffDoneEvent(reason: string): DoneEvent {
    return new RuntimeDoneEvent({
      content: '',
      error: false,
      usage: this.usage,
      trace_id: this.ctx.traceId,
      metadata: {
        run_state: 'host_handoff',
        handoff_reason: reason,
      },
    }).toStreamEvent();
  }

  /** grace call turn 的收尾：blocked 工具占位 + telemetry + budget-exhausted DONE。 */
  *graceCompletion(args: {
    isGraceCallTurn: boolean;
    toolUseBlocks: ToolUseBlock[];
    budgetEval: IterationBudgetEvaluation;
    iteration: number;
    totalTokensSoFar: number;
    tokenBudgetMax: number;
    fullText: string;
    sessionId: string;
  }): Generator<StreamEvent, boolean, undefined> {
    if (!args.isGraceCallTurn) return false;
    const ctx = this.ctx;
    yield* this.graceToolBlocks(args);
    const trigger: IterationBudgetTrigger =
      ctx.getBudgetSnapshot()?.trigger ?? args.budgetEval.trigger ?? 'iteration';
    const terminalErrorInfo = buildBudgetExceededMessageStopErrorInfo(
      budgetTriggerToErrorClass(trigger),
    );
    yield* this.persistTerminalMessage({
      errorInfoJson: { ...terminalErrorInfo },
      inflightText: args.fullText,
    });
    ctx.clearInflightAssistantText();
    // ：预算墙关信封写入 error_info，与 DONE.error_class 对齐落库。
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    ctx.deps.observe(
      TelemetryEvents.ITERATION_BUDGET_TERMINATE,
      {
        trigger,
        current: metricForBudgetTrigger(args.budgetEval, trigger, 'current'),
        threshold: metricForBudgetTrigger(args.budgetEval, trigger, 'threshold'),
        percent: metricForBudgetTrigger(args.budgetEval, trigger, 'percent'),
        max: metricForBudgetTrigger(args.budgetEval, trigger, 'max'),
        iteration_index: args.iteration,
        iteration_max: ctx.maxTurns,
        total_tokens: args.totalTokensSoFar,
        max_total_tokens: args.tokenBudgetMax,
        tools_disabled: true,
        final_message_present: args.fullText.length > 0,
        previous_stage: 'grace',
      },
      { session_id: args.sessionId },
    );
    yield new RuntimeDoneEvent(buildBudgetExhaustedDonePayload({
        trigger,
        finalContent: args.fullText,
        usage: this.usage,
        traceId: ctx.traceId,
        clientEventId: ctx.getAssistantClientEventId(),
    })).toStreamEvent();
    return true;
  }

  private *graceToolBlocks(args: {
    toolUseBlocks: ToolUseBlock[];
    budgetEval: IterationBudgetEvaluation;
    iteration: number;
    sessionId: string;
  }): Generator<StreamEvent, void, undefined> {
    if (args.toolUseBlocks.length === 0) return;
    const ctx = this.ctx;
    yield new RuntimeSystemNoticeEvent({
        content: buildBudgetGraceToolBlockedNoticeContent(args.toolUseBlocks.length),
        notice_type: 'iteration_budget_grace_tool_blocked',
        tool_count: args.toolUseBlocks.length,
    }).toStreamEvent();
    ctx.deps.observe(
      TelemetryEvents.ITERATION_BUDGET_GRACE_TOOL_BLOCKED,
      {
        trigger: ctx.getBudgetSnapshot()?.trigger ?? args.budgetEval.trigger ?? 'iteration',
        tool_count: args.toolUseBlocks.length,
        iteration_index: args.iteration,
      },
      { session_id: args.sessionId },
    );
    const graceDetail = 'Budget grace period — tool execution skipped';
    ctx.state.messages.push({
      role: 'user',
      content: args.toolUseBlocks.map((tu) =>
        buildToolErrorResultBlock(tu.id, 'budget_skipped', tu.name, graceDetail),
      ),
    });
    // 不再对每个 skipped tool 发 tool_error SYSTEM_NOTICE——聚合条
    // iteration_budget_grace_tool_blocked + 工具卡/envelope 已够用。
  }

  /** 无工具调用的完成路径：continuation（max_tokens 截断）或最终 DONE。 */
  *noToolUseCompletion(args: {
    toolUseBlocks: ToolUseBlock[];
    stopReason: LLMResponseChunk['stopReason'] | undefined;
    continuationCount: number;
    todoCompletionNudgeCount: number;
    assistantMessage: Message;
    currentLLMMessageId: string;
    fullText: string;
  }): Generator<StreamEvent, NoToolUseCompletionResult, undefined> {
    const ctx = this.ctx;
    if (args.toolUseBlocks.length > 0) return 'none';
    if (args.stopReason === 'max_tokens' && args.continuationCount < MAX_CONTINUATIONS) {
      yield* this.emitContinuationRequest(args.continuationCount + 1);
      return 'continue';
    }

    const nudgeProvider = ctx.config.todoCompletionNudgeProvider;
    const modeEnabled = nudgeProvider?.isEnabledForMode?.(ctx.config.agentMode) ?? false;
    const unfinished = modeEnabled
      ? extractLatestActionableTodos(ctx.state.messages)
      : [];
    if (
      unfinished.length > 0 &&
      args.todoCompletionNudgeCount < MAX_TODO_COMPLETION_NUDGES &&
      nudgeProvider
    ) {
      yield* this.emitTodoCompletionNudge(unfinished, nudgeProvider, args);
      return 'continue_todo';
    }

    ctx.clearInflightAssistantText();
    for (const ev of ctx.envelopeEmitter.flushHints()) yield ev;
    yield ctx.envelopeEmitter.endMessage();
    yield* this.emitFinalAssistantPersist(args);
    yield new RuntimeDoneEvent({
        content: args.fullText,
        usage: this.usage,
        trace_id: ctx.traceId,
        client_event_id: ctx.getAssistantClientEventId(),
    }).toStreamEvent();
    return 'break';
  }

  private *emitContinuationRequest(
    continuationCount: number,
  ): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    yield new RuntimeSystemNoticeEvent({
        content: `输出被截断（max_tokens）。继续中…（${continuationCount}/${MAX_CONTINUATIONS}）`,
        notice_type: 'continuation',
    }).toStreamEvent();
    ctx.state.messages.push(
      setInternalMarker(
        {
          role: 'user',
          content: '你的回复被截断了。请从中断处精确继续，不要重复任何已有内容。',
        },
        INTERNAL_MESSAGE_MARKERS.CONTINUATION,
      ),
    );
    for (const ev of ctx.envelopeEmitter.flushHints()) yield ev;
    yield ctx.envelopeEmitter.endMessage();
    ctx.state.iteration++;
  }

  private *emitTodoCompletionNudge(
    unfinished: ReturnType<typeof extractLatestActionableTodos>,
    nudgeProvider: TodoCompletionNudgeProvider,
    assistantPersistArgs: FinalAssistantPersistArgs,
  ): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    // 仅注入 LLM 内部 nudge，不向用户弹 system_notice（待办状态未变时 UI 已如实展示）
    ctx.state.messages.push(
      setInternalMarker(
        {
          role: 'user',
          content: nudgeProvider.buildNudgeBody(unfinished),
        },
        INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE,
      ),
    );
    for (const ev of ctx.envelopeEmitter.flushHints()) yield ev;
    yield ctx.envelopeEmitter.endMessage();
    yield* this.emitFinalAssistantPersist(assistantPersistArgs);
    ctx.state.iteration++;
  }

  private *emitFinalAssistantPersist(args: FinalAssistantPersistArgs): Generator<StreamEvent, void, undefined> {
    const finalBlocks: ContentBlock[] = Array.isArray(args.assistantMessage.content)
      ? args.assistantMessage.content
      : (args.assistantMessage.content
          ? [{ type: 'text', text: String(args.assistantMessage.content) } as ContentBlock]
          : []);
    if (finalBlocks.length === 0) return;
    const modelId = typeof this.ctx.state.model === 'string' ? this.ctx.state.model.trim() : '';
    yield buildPersistMessageEvent({
      messageId: args.currentLLMMessageId,
      role: 'assistant',
      blocks: finalBlocks,
      agentRunId: this.ctx.runId,
      arrivalSeq: nextArrivalSeq(),
      subagentRunId: this.ctx.config.subagentRunId,
      stopReason: typeof args.stopReason === 'string' ? args.stopReason : 'end_turn',
      ...(modelId ? { modelId, modelName: modelId } : {}),
    });
  }

  /** 工具信号触发的会话终止（end_conversation）。 */
  *conversationTermination(args: {
    shouldEndConversation: boolean;
    terminationReason: string;
    fullText: string;
  }): Generator<StreamEvent, boolean, undefined> {
    if (!args.shouldEndConversation) return false;
    // 不再发 conversation_terminated SYSTEM_NOTICE——DONE.termination_reason 已够。
    yield new RuntimeDoneEvent({
        content: args.fullText,
        termination_reason: args.terminationReason,
        usage: this.usage,
        trace_id: this.ctx.traceId,
    }).toStreamEvent();
    return true;
  }

  /** afterToolResult 钩子的硬停信号收尾（tool_failure / tool_repetition）。 */
  *pendingHardStop(
    pendingHardStop: PendingHardStop,
    snapshot: AssistantPersistSnapshot,
  ): Generator<StreamEvent, boolean, undefined> {
    if (!pendingHardStop) return false;
    const ctx = this.ctx;
    // ：工具硬停此前只发 DONE、跳过 emitToolResultAndIterationEnd，
    // 助手信封未关 → 无 error_info_json。DONE 前关信封写入与 DONE 对齐的 class。
    const terminalErrorInfo = buildHardStopMessageStopErrorInfo(pendingHardStop.source);
    yield* this.persistTerminalMessage({
      errorInfoJson: { ...terminalErrorInfo },
      snapshot,
    });
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    yield new RuntimeDoneEvent(buildHardStopDonePayload({
        source: pendingHardStop.source,
        usage: this.usage,
        traceId: ctx.traceId,
    })).toStreamEvent();
    return true;
  }

  /**
   * ：流式文本复读硬停。中途掐断 LLM 流后调用——先关 envelope，
   * 再静默 DONE（与  同哲学，不向用户塞「已自动停止」文案）。
   * ：error_class 与 DONE 对齐为 text_loop_terminated（不再写 DOOM_LOOP_DETECTED）。
   */
  *textRepetitionHardStop(): Generator<StreamEvent, boolean, undefined> {
    const ctx = this.ctx;
    const terminalErrorInfo = buildHardStopMessageStopErrorInfo('text_repetition');
    yield* this.persistTerminalMessage({ errorInfoJson: { ...terminalErrorInfo } });
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    ctx.clearInflightAssistantText();
    yield new RuntimeDoneEvent(buildHardStopDonePayload({
        source: 'text_repetition',
        usage: this.usage,
        traceId: ctx.traceId,
    })).toStreamEvent();
    return true;
  }

  *sharedBudgetExhausted(
    snapshot: AssistantPersistSnapshot,
  ): Generator<StreamEvent, boolean, undefined> {
    const tracker = this.ctx.config.budgetTracker;
    if (!tracker?.isExhausted()) return false;
    // 不再发 budget_exhausted SYSTEM_NOTICE——DONE MAX_CREDITS_EXCEEDED 黄卡已覆盖。
    const terminalErrorInfo = buildBudgetExceededMessageStopErrorInfo('MAX_CREDITS_EXCEEDED');
    yield* this.persistTerminalMessage({ errorInfoJson: { ...terminalErrorInfo }, snapshot });
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: this.ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        'MAX_CREDITS_EXCEEDED',
        'Shared agent-tree budget exhausted.',
        this.usage,
        this.ctx.traceId,
    )).toStreamEvent();
    return true;
  }

  *runCreditsExceeded(
    snapshot: AssistantPersistSnapshot,
  ): Generator<StreamEvent, boolean, undefined> {
    const ctx = this.ctx;
    if (
      typeof ctx.config.maxRunCredits !== 'number' ||
      ctx.config.maxRunCredits <= 0 ||
      ctx.state.creditsCharged < ctx.config.maxRunCredits
    ) return false;
    // 不再发 credits_exceeded SYSTEM_NOTICE——DONE MAX_CREDITS_EXCEEDED 黄卡已覆盖。
    const terminalErrorInfo = buildBudgetExceededMessageStopErrorInfo('MAX_CREDITS_EXCEEDED');
    yield* this.persistTerminalMessage({ errorInfoJson: { ...terminalErrorInfo }, snapshot });
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        'MAX_CREDITS_EXCEEDED',
        'Max run credits exceeded.',
        this.usage,
        ctx.traceId,
    )).toStreamEvent();
    return true;
  }

  /**
   * 最大迭代数收尾。注意：`state.iteration++`（状态机推进）已拆回主循环——
   * 本方法只做「已越界 → DONE」判定，无副作用。
   */
  *maxTurnsExceeded(
    snapshot: AssistantPersistSnapshot,
  ): Generator<StreamEvent, boolean, undefined> {
    const ctx = this.ctx;
    if (ctx.state.iteration < ctx.maxTurns) return false;
    // 不再发 max_turns SYSTEM_NOTICE——DONE MAX_TURNS_EXCEEDED 黄卡已覆盖。
    const terminalErrorInfo = buildMappedErrorMessageStopErrorInfo({
      errorClass: 'MAX_TURNS_EXCEEDED',
      category: 'budget_exceeded',
    });
    yield* this.persistTerminalMessage({ errorInfoJson: { ...terminalErrorInfo }, snapshot });
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        'MAX_TURNS_EXCEEDED',
        `Max turns exceeded (${ctx.maxTurns}).`,
        this.usage,
        ctx.traceId,
    )).toStreamEvent();
    return true;
  }

  /** budget guard 的 force-final 信号收尾。 */
  *forceFinal(
    snapshot: AssistantPersistSnapshot,
  ): Generator<StreamEvent, boolean, undefined> {
    const ctx = this.ctx;
    //  Phase 2：force_final 信号改读 RunContext 显式通道
    // （原 `state.__force_final__` / `state.__budgetExceeded` 黑板已删）。
    const ff = ctx.getForceFinal();
    if (!ff) return false;
    const budgetReason = ff.reason;
    const errorClass = mapBudgetReasonToErrorClass(budgetReason);
    // 不再发 credits_exceeded / tokens_exceeded / force_final SYSTEM_NOTICE——
    // 用户引导只由 MAX_CREDITS_EXCEEDED 统一提示卡承载。
    const terminalErrorInfo = buildMappedErrorMessageStopErrorInfo({
      errorClass,
      category: 'budget_exceeded',
    });
    yield* this.persistTerminalMessage({ errorInfoJson: { ...terminalErrorInfo }, snapshot });
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        errorClass,
        `Terminated by run guard: ${budgetReason ?? 'guard'}`,
        this.usage,
        ctx.traceId,
        undefined,
        {
          client_event_id: ctx.getAssistantClientEventId(),
          error_metadata: {
            isErrorMessage: true,
            errorCategory: 'budget_exceeded',
            errorClass,
          },
        },
    )).toStreamEvent();
    return true;
  }

  /** 413 三段恢复 attempts 耗尽的 failed 收尾（envelope 关闭 + CONTEXT_OVERFLOW DONE）。 */
  *contextOverflowRecoveryFailed(
    classified: ClassifiedError,
  ): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    // 不再发 recovery_413_failed SYSTEM_NOTICE——DONE CONTEXT_OVERFLOW 黄卡已覆盖。
    const terminalErrorInfo = buildMappedErrorMessageStopErrorInfo({
      errorClass: 'CONTEXT_OVERFLOW',
      category: 'runtime_failed',
    });
    yield* this.persistTerminalMessage({ errorInfoJson: { ...terminalErrorInfo } });
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        'CONTEXT_OVERFLOW',
        `Prompt too long after ${MAX_413_RECOVERY_ATTEMPTS} recovery attempts.`,
        this.usage,
        ctx.traceId,
        classified,
        {
          client_event_id: ctx.getAssistantClientEventId(),
          error_metadata: {
            isErrorMessage: true,
            errorCategory: 'context_overflow',
            suggestedAction: 'shorten_context',
          },
        },
    )).toStreamEvent();
  }

  /** 网络类错误 + 已有部分输出：partial DONE 收尾。 */
  *networkPartialDone(args: {
    fullText: string;
    errorMsg: string;
    classified: ClassifiedError;
  }): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    const terminalErrorInfo = buildMappedErrorMessageStopErrorInfo({
      errorClass: 'LLM_ERROR',
      category: 'runtime_failed',
      partialReason: 'stream_interrupted',
    });
    yield* this.persistTerminalMessage({
      errorInfoJson: { ...terminalErrorInfo },
      inflightText: args.fullText,
    });
    ctx.clearInflightAssistantText();
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: {
        errorInfo: terminalErrorInfo,
      },
    });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        'LLM_ERROR',
        `Stream stalled with partial output: ${args.errorMsg}`,
        this.usage,
        ctx.traceId,
        args.classified,
        {
          content: args.fullText,
          client_event_id: ctx.getAssistantClientEventId(),
          is_partial_content: true,
          error_metadata: {
            isErrorMessage: true,
            errorCategory: 'network',
            suggestedAction: 'retry_later',
            isPartialContent: true,
          },
        },
    )).toStreamEvent();
  }

  toLlmAgentError(error: unknown, classified: ClassifiedError, errorMsg: string): AgentError {
    const llmFallbackCode: AgentErrorCode = classified.code === 'INTERNAL' ? 'LLM_ERROR' : classified.code;
    return new AgentError(
      `LLM call failed: ${errorMsg}`,
      llmFallbackCode,
      { statusCode: classified.statusCode, details: { originalError: String(error) } },
    );
  }

  // ── run catch 收尾（abort / runtime error）──────────────────────────

  *handleRunCatch(args: {
    error: unknown;
    emitToolErrorEnvelope: (args: {
      toolUseId: string;
      errDetail: string;
      errorKind: string;
      aborted?: boolean;
    }) => Generator<StreamEvent, void, undefined>;
  }): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    const errKind: ToolErrorKind = isAbortError(args.error) ? 'aborted' : 'execute_error';
    const errDetail = isAbortError(args.error) ? 'Run aborted by user' : 'Run terminated due to error';
    const orphanToolUses = extractTerminalOrphanToolUses(
      ctx.state.messages,
      ctx.getInflightAssistantBlocks(),
    );
    ctx.state.messages.push(...buildOrphanToolResults(ctx.state.messages, errDetail, errKind));
    // 不再对孤儿 tool 发 tool_error SYSTEM_NOTICE——envelope / 工具卡 + DONE 已够。
    if (isAbortError(args.error)) {
      yield* this.handleAbortRunCatch({ ...args, errDetail, errKind, orphanToolUses });
      return;
    }
    yield* this.handleErrorRunCatch({ ...args, errDetail, errKind, orphanToolUses });
  }

  private *emitOrphanToolErrorEnvelopes(args: {
    orphanToolUses: ToolUseBlock[];
    errDetail: string;
    errKind: ToolErrorKind;
    aborted?: boolean;
    emitToolErrorEnvelope: (args: {
      toolUseId: string;
      errDetail: string;
      errorKind: string;
      aborted?: boolean;
    }) => Generator<StreamEvent, void, undefined>;
  }): Generator<StreamEvent, void, undefined> {
    for (const tu of args.orphanToolUses) {
      yield* args.emitToolErrorEnvelope({
        toolUseId: tu.id,
        errDetail: args.errDetail,
        errorKind: args.errKind,
        aborted: args.aborted,
      });
    }
  }

  private *handleAbortRunCatch(args: {
    errDetail: string;
    errKind: ToolErrorKind;
    orphanToolUses: ToolUseBlock[];
    emitToolErrorEnvelope: (args: {
      toolUseId: string;
      errDetail: string;
      errorKind: string;
      aborted?: boolean;
    }) => Generator<StreamEvent, void, undefined>;
  }): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    const abortContent = ctx.getInflightAssistantText();
    // ：closeEnvelope 前先 partial persist（messageId 仍有效）
    yield* this.persistTerminalMessage({
      stopReason: 'aborted',
      inflightText: abortContent,
      toolResultBlocks: args.orphanToolUses.map((toolUse) =>
        buildToolErrorResultBlock(
          toolUse.id,
          args.errKind,
          toolUse.name,
          args.errDetail,
        )),
    });
    ctx.clearInflightAssistantText();
    // ：ABORT 补 error_class，勿落英文兜底文案到 message_stop（徽标路径）。
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'aborted',
      errorInfo: { errorInfo: buildAbortMessageStopErrorInfo() },
    });
    yield* this.emitOrphanToolErrorEnvelopes({ ...args, aborted: true });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        'ABORT',
        'Run aborted by user.',
        this.usage,
        ctx.traceId,
        undefined,
        abortContent.length > 0
          ? {
              content: abortContent,
              client_event_id: ctx.getAssistantClientEventId(),
              is_partial_content: true,
              aborted: true,
              error_metadata: {
                isErrorMessage: true,
                errorCategory: 'aborted',
                errorClass: 'ABORT',
                aborted: true,
                suggestedAction: 'retry_later',
                isPartialContent: true,
              },
            }
          : undefined,
    )).toStreamEvent();
  }

  private *handleErrorRunCatch(args: {
    error: unknown;
    errDetail: string;
    errKind: ToolErrorKind;
    orphanToolUses: ToolUseBlock[];
    emitToolErrorEnvelope: (args: {
      toolUseId: string;
      errDetail: string;
      errorKind: string;
      aborted?: boolean;
    }) => Generator<StreamEvent, void, undefined>;
  }): Generator<StreamEvent, void, undefined> {
    const ctx = this.ctx;
    const outerClassified = classifyError(args.error);
    const agentErr = args.error instanceof AgentError
      ? args.error
      : new AgentError(
          args.error instanceof Error ? args.error.message : String(args.error),
          outerClassified.code,
          { statusCode: outerClassified.statusCode },
        );
    // ：DONE / error_info / 外抛统一以 classified 为准，避免 AgentError
    // 仍是 LLM_ERROR（英文 burst 原文）时黄卡落「网络连接异常」。
    const wireErrorClass = outerClassified.code;
    const wireErrorMessage = outerClassified.userMessage.trim().length > 0
      ? outerClassified.userMessage
      : agentErr.message;
    const terminalErr = agentErr.code === wireErrorClass
      && agentErr.message === wireErrorMessage
      ? agentErr
      : new AgentError(wireErrorMessage, wireErrorClass, {
          statusCode: outerClassified.statusCode ?? agentErr.statusCode,
          retryable: outerClassified.retryable,
          retryAfterMs: outerClassified.retryAfterMs,
          details: {
            ...(agentErr.details ?? {}),
            original_error_code: agentErr.code,
            original_error_message: agentErr.message,
          },
        });
    // 计费/业务终态不要先用 stream_interrupted 伪装成网络中断，否则 UI 会先闪
    // 「网络问题」再切到余额/结算卡片。仅真实网络类错误保留 stream_interrupted。
    const terminalPartialReason = outerClassified.category === 'network'
      ? 'stream_interrupted' as const
      : 'message_stop_fallback' as const;
    const terminalErrorInfo = buildClassifiedTerminalErrorInfo({
      classified: outerClassified,
      errorClass: wireErrorClass,
      errorMessage: wireErrorMessage,
      partialReason: terminalPartialReason,
    });
    const inflightText = ctx.getInflightAssistantText();
    const needsTerminalErrorEnvelope = inflightText.trim().length === 0
      && args.orphanToolUses.length === 0;
    // ：error 终态对称补 partial persist
    yield* this.persistTerminalMessage({
      stopReason: 'error',
      inflightText: needsTerminalErrorEnvelope
        ? `[${wireErrorClass}] ${wireErrorMessage}`
        : inflightText,
      ...(needsTerminalErrorEnvelope ? { messageKind: 'error_envelope' } : {}),
      errorInfoJson: { ...terminalErrorInfo },
      toolResultBlocks: args.orphanToolUses.map((toolUse) =>
        buildToolErrorResultBlock(
          toolUse.id,
          args.errKind,
          toolUse.name,
          args.errDetail,
        )),
    });
    ctx.clearInflightAssistantText();
    yield* closeEnvelopeForTerminalError({
      envelopeEmitter: ctx.envelopeEmitter,
      stopReason: 'error',
      errorInfo: { errorInfo: terminalErrorInfo },
    });
    yield* this.emitOrphanToolErrorEnvelopes(args);
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        wireErrorClass,
        wireErrorMessage,
        this.usage,
        ctx.traceId,
        outerClassified,
        {
          client_event_id: ctx.getAssistantClientEventId(),
          error_metadata: {
            isErrorMessage: true,
            errorCategory: outerClassified.category,
            errorClass: wireErrorClass,
            suggestedAction: outerClassified.suggestedAction,
          },
        },
    )).toStreamEvent();
    throw terminalErr;
  }

  private terminalMessageId(
    snapshot: AssistantPersistSnapshot | undefined,
    allowSyntheticMessage: boolean | undefined,
  ): string {
    return snapshot?.messageId
      ?? this.ctx.envelopeEmitter.messageId
      ?? (allowSyntheticMessage ? this.ctx.getAssistantClientEventId() : '');
  }

  private terminalBlocks(args: {
    snapshot?: AssistantPersistSnapshot;
    inflightText?: string;
    toolResultBlocks?: ContentBlock[];
  }): ContentBlock[] {
    if (args.snapshot) return args.snapshot.blocks;
    const toolResultBlocks = args.toolResultBlocks ?? [];
    const inflightBlocks = this.ctx.getInflightAssistantBlocks();
    if (inflightBlocks.length > 0) return [...inflightBlocks, ...toolResultBlocks];
    const fallbackText = args.inflightText ?? this.ctx.getInflightAssistantText();
    return fallbackText.trim().length > 0
      ? [{ type: 'text', text: fallbackText }, ...toolResultBlocks]
      : [...toolResultBlocks];
  }
}
