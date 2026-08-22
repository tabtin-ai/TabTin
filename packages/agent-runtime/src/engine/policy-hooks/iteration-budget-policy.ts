/**
 * Iteration Budget Policy Hook —— FR-15 三档预算治理（warn → grace →
 * terminate）策略（，Wave 4）。
 *
 * **历史背景**：本策略原内联在 `query.ts`：QueryRun 每轮 `evaluateBudget` +
 * `applyIterationBudgetPhase`——按 iteration / token 双通路评估，warn 档注入
 * system 段、grace 档注入段 + 本轮关工具、terminate 档发 notice + telemetry
 * 后终止 run。#3939 策略迁移把整段挂到新一代 `beforeModel` 扩展点。
 *
 * **行为不变**：
 *   - 评估口径（normalizeIterationBudgetConfig / evaluateIterationBudget）、
 *     单调升级判定（isStageUpgrade）、notice / telemetry 字段、
 *     `budget_warn_system` / `budget_grace_system` 段名与文案全部不变；
 *   - grace 关工具经 `ctx.setGraceTurn()` 信号（core buildRequest 据此
 *     tools=undefined）；terminate 经 `ctx.requestTerminate()`——DONE payload
 *     （budget-exhausted）仍由 core 拼装，协议归主循环；
 *   -  批次 9：持久档位（stage / trigger）收进工厂闭包；每轮评估经
 *     `ctx.setBudgetEvaluation` outcome 通道回传，core 的 grace completion
 *     （handleGraceCompletion / telemetry）从 RunContext 快照读，不再经
 *     `state.__iterationBudget*` 黑板字段。
 *
 * **栈序契约**：本 hook 在 message-governance 之后、tool-loop-guard 的
 * nudge 消费之前（grace turn 丢弃 nudge 的交互依赖此序）。
 */

import {
  buildBudgetGraceNoticeContent,
  buildBudgetGraceSystemInjection,
  buildBudgetTerminateNoticeContent,
  buildBudgetWarnNoticeContent,
  buildBudgetWarnSystemInjection,
  evaluateIterationBudget,
  isStageUpgrade,
} from '../guards/iteration-budget.js';
import type {
  IterationBudgetConfig,
  IterationBudgetEvaluation,
} from '../guards/iteration-budget.js';
import { TelemetryEvents } from '../../telemetry/events.js';
import {
  SYSTEM_SECTION_NAMES,
} from '../contracts/wire-protocol.js';
import type {
  SystemNoticeEvent,
} from '../contracts/wire-protocol.js';
import type {
  BeforeModelContext,
  EngineHooks,
  ObserveFn,
} from '../contracts/kernel.js';
import type { BudgetTracker } from '../guards/budget-tracker.js';
import { getTotalTokensSoFar } from '../guards/budget-state-sync.js';

// ─── notice / telemetry（原 query.ts budgetMetric 家族，行为不变）─────

function budgetMetric(
  budgetEval: IterationBudgetEvaluation,
  field: 'current' | 'threshold' | 'percent' | 'max',
): number {
  const metric = budgetEval.trigger === 'iteration'
    ? budgetEval.iteration
    : budgetEval.token;
  return metric[field];
}

function buildBudgetNoticePayload(
  content: string,
  noticeType: string,
  budgetEval: IterationBudgetEvaluation,
): SystemNoticeEvent['payload'] {
  return {
    content,
    notice_type: noticeType,
    trigger: budgetEval.trigger ?? 'iteration',
    percent: budgetMetric(budgetEval, 'percent'),
  };
}

function emitBudgetTelemetry(args: {
  event: (typeof TelemetryEvents)[keyof typeof TelemetryEvents];
  budgetEval: IterationBudgetEvaluation;
  iteration: number;
  maxTurns: number;
  totalTokensSoFar: number;
  tokenBudgetMax: number;
  previousStage?: string;
  sessionId: string;
  toolsDisabled?: boolean;
  finalMessagePresent?: boolean;
  observe: ObserveFn;
}): void {
  args.observe(
    args.event,
    {
      trigger: args.budgetEval.trigger,
      current: budgetMetric(args.budgetEval, 'current'),
      threshold: budgetMetric(args.budgetEval, 'threshold'),
      percent: budgetMetric(args.budgetEval, 'percent'),
      max: budgetMetric(args.budgetEval, 'max'),
      iteration_index: args.iteration,
      iteration_max: args.maxTurns,
      total_tokens: args.totalTokensSoFar,
      max_total_tokens: args.tokenBudgetMax,
      ...(args.toolsDisabled ? { tools_disabled: true } : {}),
      ...(args.finalMessagePresent !== undefined
        ? { final_message_present: args.finalMessagePresent }
        : {}),
      previous_stage: args.previousStage ?? 'normal',
    },
    { session_id: args.sessionId },
  );
}

// ─── 三档处理 ─────────────────────────────────────────────────────────

function handleTerminate(args: {
  ctx: BeforeModelContext;
  budgetEval: IterationBudgetEvaluation;
  isUpgrade: boolean;
  previousStage?: string;
  stageState: BudgetStageState;
  maxTurns: number;
  totalTokensSoFar: number;
  tokenBudgetMax: number;
  sessionId: string;
  observe: ObserveFn;
}): void {
  const { ctx, budgetEval } = args;
  if (args.isUpgrade) {
    args.stageState.stage = 'terminate';
    args.stageState.trigger = budgetEval.trigger ?? 'iteration';
  }
  ctx.emitNotice(buildBudgetNoticePayload(
    buildBudgetTerminateNoticeContent(budgetEval),
    'iteration_budget_terminate',
    budgetEval,
  ));
  emitBudgetTelemetry({
    event: TelemetryEvents.ITERATION_BUDGET_TERMINATE,
    budgetEval,
    iteration: ctx.iteration,
    maxTurns: args.maxTurns,
    totalTokensSoFar: args.totalTokensSoFar,
    tokenBudgetMax: args.tokenBudgetMax,
    previousStage: args.previousStage,
    sessionId: args.sessionId,
    toolsDisabled: true,
    finalMessagePresent: false,
    observe: args.observe,
  });
  // DONE payload（budget-exhausted）由 core 在钩子点 flush 后拼装。
  ctx.requestTerminate();
}

function handleUpgradeNotice(args: {
  ctx: BeforeModelContext;
  budgetEval: IterationBudgetEvaluation;
  previousStage?: string;
  stageState: BudgetStageState;
  maxTurns: number;
  totalTokensSoFar: number;
  tokenBudgetMax: number;
  sessionId: string;
  observe: ObserveFn;
}): void {
  const { ctx, budgetEval } = args;
  args.stageState.stage = budgetEval.stage as 'warn' | 'grace';
  args.stageState.trigger = budgetEval.trigger!;
  const isWarn = budgetEval.stage === 'warn';
  ctx.emitNotice(buildBudgetNoticePayload(
    isWarn
      ? buildBudgetWarnNoticeContent(budgetEval)
      : buildBudgetGraceNoticeContent(budgetEval),
    isWarn ? 'iteration_budget_warn' : 'iteration_budget_grace',
    budgetEval,
  ));
  emitBudgetTelemetry({
    event: isWarn ? TelemetryEvents.ITERATION_BUDGET_WARN : TelemetryEvents.ITERATION_BUDGET_GRACE,
    budgetEval,
    iteration: ctx.iteration,
    maxTurns: args.maxTurns,
    totalTokensSoFar: args.totalTokensSoFar,
    tokenBudgetMax: args.tokenBudgetMax,
    previousStage: args.previousStage,
    sessionId: args.sessionId,
    toolsDisabled: budgetEval.stage === 'grace',
    observe: args.observe,
  });
}

function applySystemInjection(ctx: BeforeModelContext, budgetEval: IterationBudgetEvaluation): void {
  if (budgetEval.stage === 'warn') {
    ctx.appendSystemSection(
      SYSTEM_SECTION_NAMES.budget_warn_system,
      buildBudgetWarnSystemInjection(budgetEval),
      'iteration-budget',
    );
    return;
  }
  if (budgetEval.stage !== 'grace') return;
  ctx.appendSystemSection(
    SYSTEM_SECTION_NAMES.budget_grace_system,
    buildBudgetGraceSystemInjection(budgetEval),
    'iteration-budget',
  );
  ctx.setGraceTurn();
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * 闭包私有的单调升级档位（ 批次 9，原 `EngineState.__iterationBudgetStage`
 * / `__iterationBudgetTrigger`）。随 hook 实例（= 随 run）生命周期。
 */
interface BudgetStageState {
  stage?: 'warn' | 'grace' | 'terminate';
  trigger?: 'iteration' | 'token';
}

/**
 *  批次 12：工厂 options 只收已解析的策略 knobs——`iterationBudgetConfig`
 * 由装配层（default-policy-hooks.ts）调 `normalizeIterationBudgetConfig` 解析后
 * 闭包注入，本 hook 不再直读 EngineConfig（消除双解析点漂移风险）。
 */
export interface IterationBudgetPolicyOptions {
  /** 已 normalize 的预算配置（装配层 `normalizeIterationBudgetConfig` 产物）。 */
  iterationBudgetConfig: IterationBudgetConfig;
  /** 全树共享预算 tracker（宿主注入面，装配层透传）。 */
  budgetTracker?: BudgetTracker;
  /**
   * ：子 Agent 的 per-run scope（= childId）。有值时 token 分子读
   * `getUsageByScope`，与 CostCap / syncStateFromTracker 对齐。
   */
  budgetScope?: string;
  /** telemetry session 标识（= `sessionConfig.threadId`，装配层解析）。 */
  sessionId: string;
  /** 本 run 的最大迭代数（params.maxTurns ?? config.maxTurns ?? 默认，QueryRun 已解析）。 */
  getMaxTurns: () => number;
  /** 观测出口（`QueryDeps.observe`）。 */
  observe: ObserveFn;
}

export function buildIterationBudgetPolicyHook(
  options: IterationBudgetPolicyOptions,
): EngineHooks {
  const {
    iterationBudgetConfig,
    budgetTracker,
    budgetScope,
    sessionId,
    getMaxTurns,
    observe,
  } = options;
  // 单调升级档位：闭包私有，随 run 生命周期（forkQuery 子 runtime 自建新栈）。
  const stageState: BudgetStageState = {};
  return {
    async beforeModel(ctx): Promise<void> {
      const maxTurns = getMaxTurns();
      const tokenBudgetMax = budgetTracker?.getMaxTotalTokens() ?? Infinity;
      const totalTokensSoFar = getTotalTokensSoFar(ctx.state, budgetTracker, budgetScope);
      const budgetEval = evaluateIterationBudget({
        iteration: ctx.iteration,
        maxTurns,
        totalTokens: totalTokensSoFar,
        maxTotalTokens: tokenBudgetMax,
        config: iterationBudgetConfig,
      });
      const previousStage = stageState.stage;
      const isUpgrade = isStageUpgrade(previousStage, budgetEval.stage);
      const shouldTerminate = budgetEval.stage === 'terminate' && budgetEval.trigger !== null;
      const shouldNotice = budgetEval.stage !== 'normal' && budgetEval.trigger !== null;
      if (shouldTerminate) {
        handleTerminate({
          ctx, budgetEval, isUpgrade, previousStage, stageState,
          maxTurns, totalTokensSoFar, tokenBudgetMax, sessionId, observe,
        });
      } else if (shouldNotice) {
        if (isUpgrade) {
          handleUpgradeNotice({
            ctx, budgetEval, previousStage, stageState,
            maxTurns, totalTokensSoFar, tokenBudgetMax, sessionId, observe,
          });
        }
        applySystemInjection(ctx, budgetEval);
      }
      // outcome 通道：每轮（含 normal）回传快照——core 的 grace completion /
      // budget-exhausted DONE / telemetry 读同一份评估（含评估输入），不再翻
      // state、也不二次解析 iterationBudget 配置。
      ctx.setBudgetEvaluation({
        budgetEval,
        stage: stageState.stage,
        trigger: stageState.trigger,
        totalTokensSoFar,
        tokenBudgetMax,
      });
    },
  };
}
