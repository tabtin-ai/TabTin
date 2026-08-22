/**
 * Tool Loop Guard Hook —— 工具循环治理（失败 streak + 成功复读）策略
 * （，Wave 3）。挂在 `afterToolResult`，按失败 streak / 成功复读升级治理。
 *
 * **历史背景**：本策略原内联在 `query.ts`：QueryRun 持有
 * `toolFailureTracker` / `toolRepetitionTracker` 两个实例，
 * `evaluateToolBudgetStops` 在每轮工具执行后记录 + 评估，按
 * notice → nudge → terminate 三档升级发 SYSTEM_NOTICE / telemetry /
 * 写 nudge 注入信号。#3939 策略迁移把整段挂到新一代
 * `afterToolResult` 扩展点，tracker 实例转入工厂闭包（随 run 生命周期，
 * forkQuery 子 runtime 自建新栈、不与父共享计数）。
 *
 * **行为不变**：
 *   - 三档升级判定（isToolFailureStageUpgrade / isToolRepetitionStageUpgrade）、
 *     notice / nudge 文案、telemetry 事件与字段全部不变；
 *   -  批次 9：stage / pending-nudge 四个信号从 `EngineState.__*` 字段
 *     收进本工厂闭包——写者与读者都只有本 hook（beforeModel 消费 nudge、
 *     afterToolResult 记录/评估），跨轮状态随 hook 实例（= 随 run）生命周期；
 *   - 工具失败始终作为可恢复结果返回模型；只有成功调用的复读可触发硬停；
 *   - nudge 的 system prompt 注入消费（consumeStallNudge /
 *     consumeRepetitionNudge）**仍留在 core**——它与 iteration budget 的
 *     grace turn 判定有交互（grace turn 丢弃 nudge），归 Wave 4 一并处理。
 *
 * 硬停收尾（DONE payload 拼装）仍由 QueryRun 的 handlePendingHardStop 完成
 * ——hook 只经 `ctx.requestHardStop(source)` 发信号。
 */

import {
  ToolFailureTracker,
  isToolFailureStageUpgrade,
  buildToolFailureNoticeContent,
  buildToolFailureNudgeContent,
  buildToolFailureNudgeSystemInjection,
} from '../guards/tool-failure-tracker.js';
import type {
  ToolFailureBudgetTrigger,
} from '../guards/tool-failure-tracker.js';
import {
  ToolRepetitionTracker,
  isToolRepetitionStageUpgrade,
  buildToolRepetitionNoticeContent,
  buildToolRepetitionNudgeContent,
  buildToolRepetitionNudgeSystemInjection,
} from '../guards/tool-repetition-tracker.js';
import type {
  ToolRepetitionTrigger,
} from '../guards/tool-repetition-tracker.js';
import { extractToolErrorCode } from '../tooling/tool-error-code.js';
import { TelemetryEvents } from '../../telemetry/events.js';
import {
  SYSTEM_SECTION_NAMES,
} from '../contracts/wire-protocol.js';
import type {
  BeforeModelContext,
  EngineConfig,
  EngineHooks,
  ObserveFn,
  ToolResultsHookContext,
} from '../contracts/kernel.js';

/**
 *  批次 12：工厂 options 只收自己需要的策略 knobs——tracker 配置覆盖 +
 * sessionId 由装配层（default-policy-hooks.ts）从 EngineConfig 摘出后注入，
 * 本 hook 不再直读整个 config。
 */
export interface ToolLoopGuardOptions {
  /** Tool-failure tracker 配置覆盖（= `EngineConfig.toolFailureTracker`）。 */
  toolFailureConfig?: EngineConfig['toolFailureTracker'];
  /** Tool-repetition tracker 配置覆盖（= `EngineConfig.toolRepetitionTracker`）。 */
  toolRepetitionConfig?: EngineConfig['toolRepetitionTracker'];
  /** telemetry session 标识（= `sessionConfig.threadId`，装配层解析）。 */
  sessionId: string;
  /** 观测出口（`QueryDeps.observe`）。 */
  observe: ObserveFn;
}

type HardStopSource = 'tool_failure' | 'tool_repetition';

/**
 * 闭包私有的跨轮信号（ 批次 9，原 EngineState `__toolFailureStage` /
 * `__toolRepetitionStage` / `__pendingStallNudgeInjection` /
 * `__pendingRepetitionNudgeInjection`）。
 */
interface ToolLoopGuardState {
  failureStage?: 'notice' | 'nudge' | 'terminate';
  repetitionStage?: 'notice' | 'nudge' | 'terminate';
  pendingStallNudge?: ToolFailureBudgetTrigger;
  pendingRepetitionNudge?: ToolRepetitionTrigger;
}

// ─── Failure 通道（原 recordToolFailureResults / evaluateToolFailurePhase）──

function recordToolFailureResults(
  ctx: ToolResultsHookContext,
  toolFailureTracker: ToolFailureTracker,
): void {
  for (const er of ctx.results) {
    if (er.result.isError) {
      toolFailureTracker.recordFailure({
        tool: er.toolName,
        error_kind: extractToolErrorCode(er.result) ?? 'unknown_error_kind',
      });
    } else {
      toolFailureTracker.recordSuccess({ tool: er.toolName });
    }
  }
}

function evaluateToolFailurePhase(
  ctx: ToolResultsHookContext,
  guardState: ToolLoopGuardState,
  toolFailureTracker: ToolFailureTracker,
  sessionId: string,
  observe: ObserveFn,
): HardStopSource | null {
  const evaluation = toolFailureTracker.evaluate();
  if (evaluation.stage === 'normal') {
    guardState.failureStage = undefined;
    return null;
  }
  if (
    evaluation.trigger === null ||
    !isToolFailureStageUpgrade(guardState.failureStage, evaluation.stage)
  ) return null;
  const trigger: ToolFailureBudgetTrigger = evaluation.trigger;
  guardState.failureStage = evaluation.stage;
  const thresholds = toolFailureTracker.getConfig().thresholds;
  if (evaluation.stage === 'notice') {
    ctx.emitNotice({
      content: buildToolFailureNoticeContent(trigger),
      notice_type: 'tool_failure_notice',
      tool: trigger.tool,
      error_kind: trigger.error_kind,
      streak: trigger.streak,
      nudge_threshold: thresholds.nudge,
    });
    emitToolFailureTelemetry(TelemetryEvents.TOOL_FAILURE_NOTICE, trigger, thresholds, ctx.iteration, sessionId, observe);
    return null;
  }
  if (evaluation.stage === 'nudge') {
    ctx.emitNotice({
      content: buildToolFailureNudgeContent(trigger),
      notice_type: 'tool_failure_nudge',
      tool: trigger.tool,
      error_kind: trigger.error_kind,
      streak: trigger.streak,
      nudge_threshold: thresholds.nudge,
    });
    guardState.pendingStallNudge = {
      tool: trigger.tool,
      error_kind: trigger.error_kind,
      streak: trigger.streak,
    };
    emitToolFailureTelemetry(TelemetryEvents.TOOL_FAILURE_NUDGE, trigger, thresholds, ctx.iteration, sessionId, observe, true);
    return null;
  }
  // 工具失败是 Agent 可以观察并恢复的正常结果。即使达到最高阈值，
  // 也只停止本轮策略继续升级，不得把父会话收口为 tool_loop_terminated。
  return null;
}

function emitToolFailureTelemetry(
  event: (typeof TelemetryEvents)[keyof typeof TelemetryEvents],
  trigger: ToolFailureBudgetTrigger,
  thresholds: ReturnType<ToolFailureTracker['getConfig']>['thresholds'],
  iteration: number,
  sessionId: string,
  observe: ObserveFn,
  injectionPending?: boolean,
): void {
  observe(
    event,
    {
      tool: trigger.tool,
      error_kind: trigger.error_kind,
      streak: trigger.streak,
      ...(event === TelemetryEvents.TOOL_FAILURE_TERMINATE
        ? { terminate_threshold: thresholds.terminate }
        : { notice_threshold: thresholds.notice }),
      ...(event === TelemetryEvents.TOOL_FAILURE_NUDGE
        ? { nudge_threshold: thresholds.nudge, injection_pending: !!injectionPending }
        : {}),
      iteration_index: iteration,
    },
    { session_id: sessionId },
  );
}

// ─── Repetition 通道（原 recordToolRepetitionResults / evaluateToolRepetitionPhase）──

function recordToolRepetitionResults(
  ctx: ToolResultsHookContext,
  toolRepetitionTracker: ToolRepetitionTracker,
): void {
  for (const er of ctx.results) {
    if (!er.result.isError) {
      toolRepetitionTracker.recordSuccess({ tool: er.toolName, input: er.input });
    }
  }
}

function evaluateToolRepetitionPhase(
  ctx: ToolResultsHookContext,
  guardState: ToolLoopGuardState,
  toolRepetitionTracker: ToolRepetitionTracker,
  sessionId: string,
  observe: ObserveFn,
): HardStopSource | null {
  const evaluation = toolRepetitionTracker.evaluate();
  if (evaluation.stage === 'normal') {
    guardState.repetitionStage = undefined;
    return null;
  }
  if (
    evaluation.trigger === null ||
    !isToolRepetitionStageUpgrade(guardState.repetitionStage, evaluation.stage)
  ) return null;
  const trigger: ToolRepetitionTrigger = evaluation.trigger;
  guardState.repetitionStage = evaluation.stage;
  const thresholds = toolRepetitionTracker.getConfig().thresholds;
  const windowMs = toolRepetitionTracker.getConfig().windowMs;
  if (evaluation.stage === 'notice') {
    ctx.emitNotice({
      content: buildToolRepetitionNoticeContent(trigger),
      notice_type: 'tool_repetition_notice',
      tool: trigger.tool,
      count: trigger.count,
      window_ms: windowMs,
      nudge_threshold: thresholds.nudge,
    });
    emitToolRepetitionTelemetry(TelemetryEvents.TOOL_REPETITION_NOTICE, trigger, thresholds, windowMs, ctx.iteration, sessionId, observe);
    return null;
  }
  if (evaluation.stage === 'nudge') {
    ctx.emitNotice({
      content: buildToolRepetitionNudgeContent(trigger),
      notice_type: 'tool_repetition_nudge',
      tool: trigger.tool,
      count: trigger.count,
      window_ms: windowMs,
      nudge_threshold: thresholds.nudge,
    });
    guardState.pendingRepetitionNudge = {
      tool: trigger.tool,
      inputDigest: trigger.inputDigest,
      count: trigger.count,
      windowMs: trigger.windowMs,
    };
    emitToolRepetitionTelemetry(TelemetryEvents.TOOL_REPETITION_NUDGE, trigger, thresholds, windowMs, ctx.iteration, sessionId, observe, true);
    return null;
  }
  emitToolRepetitionTelemetry(TelemetryEvents.TOOL_REPETITION_TERMINATE, trigger, thresholds, windowMs, ctx.iteration, sessionId, observe);
  return 'tool_repetition';
}

function emitToolRepetitionTelemetry(
  event: (typeof TelemetryEvents)[keyof typeof TelemetryEvents],
  trigger: ToolRepetitionTrigger,
  thresholds: ReturnType<ToolRepetitionTracker['getConfig']>['thresholds'],
  windowMs: number,
  iteration: number,
  sessionId: string,
  observe: ObserveFn,
  injectionPending?: boolean,
): void {
  observe(
    event,
    {
      tool: trigger.tool,
      count: trigger.count,
      ...(event === TelemetryEvents.TOOL_REPETITION_TERMINATE
        ? { terminate_threshold: thresholds.terminate }
        : { notice_threshold: thresholds.notice }),
      ...(event === TelemetryEvents.TOOL_REPETITION_NUDGE
        ? { nudge_threshold: thresholds.nudge, injection_pending: !!injectionPending }
        : {}),
      window_ms: windowMs,
      iteration_index: iteration,
    },
    { session_id: sessionId },
  );
}

// ─── Nudge 注入消费（原 QueryRun.consumeStallNudge / consumeRepetitionNudge）──
//
// （Wave 4）：随 iteration-budget-policy 迁入 beforeModel 后一并迁到
// 本 hook——语义不变：取出并清空 pending 信号；grace call turn 时丢弃
// （不注入，本轮模型只做纯文字收尾）。栈序保证本 hook 的 beforeModel 在
// iteration-budget-policy 之后执行，isGraceTurn() 已就绪。

function consumeNudgeInjections(ctx: BeforeModelContext, guardState: ToolLoopGuardState): void {
  const stallTrigger = guardState.pendingStallNudge;
  guardState.pendingStallNudge = undefined;
  if (stallTrigger && !ctx.isGraceTurn()) {
    ctx.appendSystemSection(
      SYSTEM_SECTION_NAMES.stall_detection,
      buildToolFailureNudgeSystemInjection(stallTrigger),
      'tool-failure-tracker',
    );
  }
  const repetitionTrigger = guardState.pendingRepetitionNudge;
  guardState.pendingRepetitionNudge = undefined;
  if (repetitionTrigger && !ctx.isGraceTurn()) {
    ctx.appendSystemSection(
      SYSTEM_SECTION_NAMES.repetition_detection,
      buildToolRepetitionNudgeSystemInjection(repetitionTrigger),
      'tool-repetition-tracker',
    );
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

export function buildToolLoopGuardHook(options: ToolLoopGuardOptions): EngineHooks {
  const { toolFailureConfig, toolRepetitionConfig, sessionId, observe } = options;
  const toolFailureTracker = new ToolFailureTracker({ config: toolFailureConfig });
  const toolRepetitionTracker = new ToolRepetitionTracker({ config: toolRepetitionConfig });
  const guardState: ToolLoopGuardState = {};
  return {
    async beforeModel(ctx): Promise<void> {
      consumeNudgeInjections(ctx, guardState);
    },
    async afterToolResult(ctx): Promise<void> {
      recordToolFailureResults(ctx, toolFailureTracker);
      evaluateToolFailurePhase(ctx, guardState, toolFailureTracker, sessionId, observe);
      recordToolRepetitionResults(ctx, toolRepetitionTracker);
      const repetitionStop = evaluateToolRepetitionPhase(ctx, guardState, toolRepetitionTracker, sessionId, observe);
      if (repetitionStop) ctx.requestHardStop(repetitionStop);
    },
  };
}
