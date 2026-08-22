/**
 * Context Overflow Recovery Hook —— LLM 413 / prompt-too-long 的三段式
 * 自动恢复策略（，Wave 5）。挂新一代 `onModelError` 扩展点。
 *
 * **历史背景**：本策略原内联在 `query.ts`（recoverContextOverflow 及
 * tryCompact / truncateHead / hardTrim 三段）。#3939 策略迁移把恢复段挂到
 * onModelError；**attempts 耗尽后的 failed 收尾（envelope 关闭 + CONTEXT_OVERFLOW
 * DONE）留在 core**——那是协议操作，hook 返回 undefined 落回 core 处理。
 *
 * **行为不变**：
 *   - 三段推进（ptlRecoveryAttempts：0=autoCompact → 1=truncateHead →
 *     2=hardTrim），COMPACTION start/end 事件、recovery notice 文案、
 *     ERROR_PTL_* telemetry 全部不变；
 *   - 每段成功后 state.iteration++ → 返回 'retry'（原 'continue'）。
 */

import { MAX_413_RECOVERY_ATTEMPTS } from '../../runtime-defaults.js';
import {
  computeMessagesTargetFromFullTarget,
  hardTrim,
  truncateHead,
} from '../context/token-budget.js';
import type { TokenEstimator } from '../context/token-budget.js';
import { countToolUses } from '../context/token-budget.js';
import { deriveActiveTodoBatch } from '../../todo/todo-replay.js';
import { buildTruncationTaskStateSection } from '../../prompts/compact/truncation-task-state.js';
import { parseTokenGap } from '../errors/error-classifier.js';
import { syncStateFromTracker } from '../guards/budget-state-sync.js';
import { TelemetryEvents } from '../../telemetry/events.js';
import type {
  CompactionEvent,
} from '../contracts/wire-protocol.js';
import { RuntimeCompactionEvent } from '../../event/events/compaction-events.js';
import type {
  ToolParam,
} from '../contracts/conversation.js';
import type {
  ContextManager,
  EngineHooks,
  EngineState,
  ModelErrorContext,
  ModelErrorDirective,
  ObserveFn,
} from '../contracts/kernel.js';
import type { BudgetTracker } from '../guards/budget-tracker.js';
import type { RetryState } from '../core/retry-state.js';

// ─── 记账与事件（原 query.ts 同名函数，事件改经 ctx 队列）─────────────

function snapshotRecoveryStats(
  state: EngineState,
  tokenEstimator: TokenEstimator,
): { messages: number; tokens: number } {
  return {
    messages: state.messages.length,
    tokens: tokenEstimator.estimateMessages(state.messages),
  };
}

function recordCompactUsage(
  state: EngineState,
  budget: { budgetTracker?: BudgetTracker; budgetScope?: string },
  compactUsage: { input_tokens: number; output_tokens: number; model?: string } | undefined,
): void {
  if (!compactUsage) return;
  budget.budgetTracker?.recordRequest({
    inputTokens: compactUsage.input_tokens,
    outputTokens: compactUsage.output_tokens,
    model: compactUsage.model ?? state.model,
    source: 'compact',
  }, budget.budgetScope);
  if (syncStateFromTracker(state, budget)) return;
  state.compactInputTokens += compactUsage.input_tokens;
  state.compactOutputTokens += compactUsage.output_tokens;
  state.totalInputTokens += compactUsage.input_tokens;
  state.totalOutputTokens += compactUsage.output_tokens;
}

function buildRecoveryEndEvent(
  mode: 'recovery_413' | 'truncate_head' | 'hard_trim',
  before: { messages: number; tokens: number },
  state: EngineState,
  tokenEstimator: TokenEstimator,
  tokensFreed: number,
): CompactionEvent {
  return new RuntimeCompactionEvent({
      phase: 'end',
      mode,
      stats: {
        messages_before: before.messages,
        messages_after: state.messages.length,
        tokens_before: before.tokens,
        tokens_after: tokenEstimator.estimateMessages(state.messages),
        tokens_freed: tokensFreed,
        tool_uses_retained: countToolUses(state.messages),
      },
  }).toStreamEvent();
}

function emitRecoveryNotice(ctx: ModelErrorContext, content: string): void {
  ctx.emitNotice({ content, notice_type: 'recovery_413' });
}

// ─── 三段恢复（原 query.ts 同名函数，行为不变）────────────────────────

interface RecoveryDeps {
  ctx: ModelErrorContext;
  retryState: RetryState;
  options: ContextOverflowRecoveryOptions;
  contextManager: ContextManager;
  tokenEstimator: TokenEstimator;
  toolParams: ToolParam[];
}

async function tryCompactForContextOverflow(
  r: RecoveryDeps,
  recoveryCtxWindow: number,
): Promise<boolean> {
  const state = r.ctx.state;
  r.retryState.ptlRecoveryAttempts = 1;
  try {
    const compactResult = await r.contextManager.autoCompact({
      messages: state.messages,
      systemPrompt: state.systemPrompt,
      model: state.model,
      contextWindowTokens: recoveryCtxWindow,
      // activePlanRef 由 ContextManager 实现按 sessionId 统一解析（ 同口径）。
      enableSummaryReuse: false,
      postCompactAttachmentBudget: 0,
    });
    if (!compactResult) return false;
    const before = snapshotRecoveryStats(state, r.tokenEstimator);
    state.messages = compactResult.compactedMessages;
    r.contextManager.invalidateSummaryCache();
    recordCompactUsage(state, r.options, compactResult.compactUsage);
    r.ctx.emitEvent(buildRecoveryEndEvent('recovery_413', before, state, r.tokenEstimator, compactResult.tokensFreed));
    emitRecoveryNotice(r.ctx, '上下文过长，已自动压缩并重新请求');
    r.options.observe(TelemetryEvents.ERROR_PTL_RECOVERY, {
      stage: 'compact',
      model: state.model,
    });
    state.iteration++;
    return true;
  } catch {
    return false;
  }
}

/**
 *  钉锚截断：硬删前从**当前完整消息**回放「当前任务状态」段
 * （活跃 todo 全量合并态；已 settled 或从未建 todo 返回 undefined，
 * 调用方保持裸告示）。413 路径拿不到 activePlanRef（那是 orchestrator
 * 按 sessionId 解析的 compact 层输入），todo 合并态是这里的核心锚。
 */
function buildRecoveryTaskStateNotice(r: RecoveryDeps): string | undefined {
  const batch = deriveActiveTodoBatch(r.ctx.state.messages);
  if (!batch || batch.settled) return undefined;
  return buildTruncationTaskStateSection({ todos: batch.todos }) || undefined;
}

function truncateHeadForContextOverflow(r: RecoveryDeps): void {
  const state = r.ctx.state;
  r.retryState.ptlRecoveryAttempts = 2;
  const before = snapshotRecoveryStats(state, r.tokenEstimator);
  const tokenGap = parseTokenGap(r.ctx.errorMessage);
  state.messages = truncateHead(
    state.messages,
    tokenGap,
    r.tokenEstimator,
    buildRecoveryTaskStateNotice(r),
  );
  r.contextManager.invalidateSummaryCache();
  const afterTokens = r.tokenEstimator.estimateMessages(state.messages);
  r.ctx.emitEvent(buildRecoveryEndEvent(
    'truncate_head',
    before,
    state,
    r.tokenEstimator,
    Math.max(0, before.tokens - afterTokens),
  ));
  emitRecoveryNotice(r.ctx, '自动压缩效果不足，已移除部分早期对话以继续');
  r.options.observe(TelemetryEvents.ERROR_PTL_TRUNCATE_HEAD, {
    tokensBefore: before.tokens,
    tokensAfter: afterTokens,
    tokenGap: tokenGap ?? null,
    model: state.model,
  });
  state.iteration++;
}

function hardTrimForContextOverflow(r: RecoveryDeps, recoveryCtxWindow: number): void {
  const state = r.ctx.state;
  r.retryState.ptlRecoveryAttempts = MAX_413_RECOVERY_ATTEMPTS;
  const before = snapshotRecoveryStats(state, r.tokenEstimator);
  const trimTarget = computeMessagesTargetFromFullTarget(
    Math.floor(recoveryCtxWindow * 0.5),
    state.systemPrompt,
    r.toolParams,
    r.tokenEstimator,
  );
  state.messages = hardTrim(
    state.messages,
    trimTarget,
    r.tokenEstimator,
    buildRecoveryTaskStateNotice(r),
  );
  r.contextManager.invalidateSummaryCache();
  const afterTokens = r.tokenEstimator.estimateMessages(state.messages);
  r.ctx.emitEvent(buildRecoveryEndEvent(
    'hard_trim',
    before,
    state,
    r.tokenEstimator,
    Math.max(0, before.tokens - afterTokens),
  ));
  emitRecoveryNotice(r.ctx, '仍然过长，已大幅缩减对话历史');
  r.options.observe(TelemetryEvents.ERROR_PTL_HARD_TRIM, {
    tokensBefore: before.tokens,
    tokensAfter: afterTokens,
    model: state.model,
  });
  state.iteration++;
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 *  批次 12：工厂 options 只收模型能力面与预算记账面的已解析子集——
 * `resolveRecoveryContextWindow` 由装配层闭包
 * `config.resolveContextWindow ?? config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW`
 * 三级兜底，本 hook 不再直读 EngineConfig。
 */
export interface ContextOverflowRecoveryOptions {
  /** 已闭包三级兜底的恢复窗口解析器（装配层构造，按错误时的当前模型解析）。 */
  resolveRecoveryContextWindow: (model: string) => number;
  /** 全树共享预算 tracker（compact usage 记账，宿主注入面透传）。 */
  budgetTracker?: BudgetTracker;
  /** per-child 用量归因 scope（= `EngineConfig.budgetScope`）。 */
  budgetScope?: string;
  /** 观测出口（`QueryDeps.observe`）。 */
  observe: ObserveFn;
  /** run 级 ContextManager 实例（autoCompact 能力从这里拿，不直连 compact/）。 */
  getContextManager: () => ContextManager;
  getRetryState: () => RetryState;
  getTokenEstimator: () => TokenEstimator;
  getToolParams: () => ToolParam[];
}

export function buildContextOverflowRecoveryHook(
  options: ContextOverflowRecoveryOptions,
): EngineHooks {
  const { getContextManager, getRetryState, getTokenEstimator, getToolParams } = options;
  return {
    async onModelError(ctx): Promise<ModelErrorDirective | undefined> {
      if (ctx.category !== 'context_overflow') return undefined;
      const retryState = getRetryState();
      // attempts 耗尽：返回 undefined 落回 core 的 failed 收尾
      // （envelope 关闭 + CONTEXT_OVERFLOW DONE，协议归主循环）。
      if (retryState.ptlRecoveryAttempts >= MAX_413_RECOVERY_ATTEMPTS) return undefined;
      ctx.emitEvent(new RuntimeCompactionEvent({
        phase: 'start',
        mode: 'recovery_413',
      }).toStreamEvent());
      const r: RecoveryDeps = {
        ctx,
        retryState,
        options,
        contextManager: getContextManager(),
        tokenEstimator: getTokenEstimator(),
        toolParams: getToolParams(),
      };
      const recoveryCtxWindow = options.resolveRecoveryContextWindow(ctx.state.model);
      if (retryState.ptlRecoveryAttempts === 0) {
        const compacted = await tryCompactForContextOverflow(r, recoveryCtxWindow);
        if (compacted) return 'retry';
      }
      if (retryState.ptlRecoveryAttempts === 1) {
        truncateHeadForContextOverflow(r);
        return 'retry';
      }
      hardTrimForContextOverflow(r, recoveryCtxWindow);
      return 'retry';
    },
  };
}
