/**
 * CompactionOrchestrator — single entry point for all context compaction
 * decisions in the ReAct main loop.
 *
 * **W3 (2026-05-10) — pipeline simplified after dropping auto-condense**:
 *   1. Reactive compact — consume `pendingCondenseSummary` if any tool
 *      decided to push one through `ToolResultSignals.pendingCondense`
 *      (the channel is kept as a generic signal port; no built-in tool
 *      currently fires it after `summarize_context` was deleted).
 *   2. Pressure estimation (full context: messages + system + tools + anchor).
 *   3. Time-based microcompact (pressure-gated; default no-op until W7
 *      wires `EngineConfig.timeBasedMicroCompact` through query.ts).
 *   4. Auto-compact (LLM summary → emergency hard trim).
 *   5. Blocking guard (terminate if critically full after compaction).
 *
 * **What W3 removed**:
 *   - The "Step 3 auto-condense" arm that injected a system prompt
 *     telling the LLM to call `summarize_context` and dynamically added
 *     the tool to `toolParams`. The tool itself was deleted in W3
 *     (dogfood proved LLM-driven self-condensation
 *     hurts more than it helps once `auto-compact` exists), so the trigger /
 *     wait / force / cleanup loop was a no-op pointing at a missing tool.
 *   - `condenseSystemInjection` field on `CompactionPhaseResult`.
 *   - `toolParamsDelta` field on `CompactionPhaseResult`.
 *   - `_condenseInProgress` / `_condenseStartedIteration` /
 *     `_condenseConsecutiveFailures` state fields (also removed from
 *     `EngineState`).
 *
 * Pressure estimation still uses estimateFullContextTokens (messages + system
 * + tools) for accurate threshold comparison; all mutable state lives in
 * `CompactionOrchestratorState` (session-level).
 */

import type {
  StreamEvent,
  CompactionEvent,
  ContextPressureEvent,
  SystemNoticeEvent,
} from '../engine/contracts/wire-protocol.js';
import {
  RuntimeCompactionEvent,
  RuntimeContextPressureEvent,
} from '../event/events/compaction-events.js';
import { RuntimeSystemNoticeEvent } from '../event/events/observability-events.js';
import type {
  Message,
  ToolParam,
} from '../engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../engine/contracts/model-llm.js';
import type {
  AutoCompactParams,
  CompactResult,
  ContextBudget,
  SummaryJudgeFn,
  SummaryReuseEntry,
  SummaryReuseStats,
} from '../engine/contracts/context-capability.js';
import {
  DEFAULT_SUMMARY_REUSE_JUDGE_SAMPLE_RATE,
  DEFAULT_SUMMARY_REUSE_JUDGE_THRESHOLD,
  DEFAULT_SUMMARY_REUSE_JUDGE_WINDOW_SIZE,
} from '../engine/contracts/context-capability.js';
import { countToolUses, estimateFullContextTokens, estimateTokens, TokenEstimator } from '../engine/context/token-budget.js';
import type { UsageAnchor } from '../engine/context/token-budget.js';
import { initCompactTracking } from './auto-compact.js';
import type { CompactTracking } from './auto-compact.js';
import { TelemetryEvents } from '../telemetry/events.js';
import { emitTelemetryEvent } from '../telemetry/emitter.js';
import {
  appendJudgeScoreAndCheckFallback,
  judgeSummaryQuality,
  recordJudgeFailure,
  shouldSampleJudge,
} from './summary-judge.js';
import {
  resolvePressureThresholds,
  shouldRunTimeBasedMicrocompact,
  computePressureStage,
} from './pressure-router.js';
import type { PressureThresholds, PressureStage } from './pressure-router.js';
import { maybeTimeBasedMicrocompact } from './time-based-microcompact.js';
import type { TimeBasedMCConfig } from './time-based-microcompact.js';
import { getActivePlanRef } from '../state/active-plan-tracker.js';

// ─── Helpers (FR-11 stats) ───────────────────────────────────────────

/**
 * FR-11：统计消息数组里残留的 `tool_use` 块数量。
 *
 * 用于 `CompactionStats.tool_uses_retained`，让消费者区分：
 * - reactive：通常 retain 较多（保留尾部 assistant 直到上轮）；
 * - auto：LLM summarize，retain 中等；
 * - emergency_blocking：保留极少（保 head + 必要 pairing）；
 * - recovery_413 / hard_trim：query.ts 走 413 恢复路径时也复用此 helper。
 *
 * 注意：每个 `tool_use` 都计 1，不去重 id（同一会话不会重复 id，但
 * 子 Agent 转嫁场景可能出现，本 metric 不必判去重）。
 *
 *  批次 3：本体迁至 `engine/context/token-budget.ts`（纯消息机制归内核），
 * 此处 re-export 保住既有 import 路径与"所有 compaction mode 同口径"约定。
 */
export { countToolUses };

// ─── Orchestrator State (session-level) ──────────────────────────────

export interface CompactionOrchestratorState {
  compactTracking: CompactTracking;
  lastCompactIteration: number;
  lastPressureStage?: PressureStage;
  /**
   * FR-16：summary reuse 的前次摘要缓存。
   *
   *  批次 8：原 `EngineState._lastSummary` —— 压缩记忆是 compact 子系统
   * 的私有状态，随 orchestrator state（= ContextManager 实例 = run）生命周期，
   * 不再寄生在内核 EngineState 上。子 Agent / 新 run 起新实例，缓存自然隔离。
   */
  lastSummary?: SummaryReuseEntry;
  /**
   * FR-16 H3-B：LLM judge 评分滑动窗口 + fallback 状态。
   * 原 `EngineState._summaryReuseStats`，同上迁入（ 批次 8）。
   */
  reuseStats?: SummaryReuseStats;
  /**
   * ：emergency_blocking 连续「压了但一个 token 都没省」的次数。
   *
   * 独立于 `compactTracking.consecutiveFailures`——后者由 `autoCompact` 内部
   * 自管（摘要/prune 成功即 reset 0），若复用它计 no-progress，会被下一轮
   * autoCompact 的成功 reset 立刻清掉、永远累积不到冷却阈值。故单独持有。
   * 达 `MAX_EMERGENCY_NO_PROGRESS` 连续无进展即诚实终止（真溢出无法压回）。
   */
  emergencyNoProgressStreak: number;
}

export function initOrchestratorState(): CompactionOrchestratorState {
  return {
    compactTracking: initCompactTracking(),
    lastCompactIteration: -999,
    emergencyNoProgressStreak: 0,
  };
}

/**
 * ：emergency 连续无进展的终止阈值。live 取证死循环是连续 6 轮 freed=0；
 * 取 2 —— 允许一次瞬时无进展（下一轮可能真省），连续 2 次即判定真溢出压不回，
 * 诚实终止（不再无限重砍同一批消息）。
 */
const MAX_EMERGENCY_NO_PROGRESS = 2;

// ─── Orchestrator Result ─────────────────────────────────────────────

export interface CompactionPhaseResult {
  messages: Message[];
  events: StreamEvent[];
  skipAutoCompact: boolean;
  terminate: boolean;
  invalidateAnchor: boolean;
  // W3 (2026-05-10): `toolParamsDelta` and `condenseSystemInjection` removed
  // alongside the auto-condense / `summarize_context` mechanism. The
  // orchestrator no longer mutates the LLM's tool list nor injects "please
  // call summarize_context" prompts.
  /**
   * W3-fix P1-1: compact 路径 LLM 调用的累计 usage（auto + emergency）。
   * orchestrator 不再直写 EngineState token 字段，由 query.ts 统一经
   * BudgetTracker.recordRequest → syncStateFromTracker 写入。
   */
  compactUsage?: { input_tokens: number; output_tokens: number; model?: string };
}

// ─── Orchestrator Config ─────────────────────────────────────────────

export interface CompactionOrchestratorConfig {
  budget: ContextBudget;
  resolveContextWindow?: (model: string) => number;
  contextWindowTokens?: number;
  sessionDir?: string;
  sessionId?: string;
  /** Current tool schemas — included in full context token estimation */
  tools?: ToolParam[];
  /** Output token reserve subtracted from context window for pressure calculation (default 16384) */
  maxOutputTokens?: number;
  estimator?: TokenEstimator;
  /**
   * FR-16 H3-B：reuse 总开关。`undefined` 等价于 true（默认开启，对齐 PRD §5.2 + Q4）。
   * orchestrator 透传给 `autoCompact` 与"是否启用 judge 采样"的判定。
   */
  enableSummaryReuse?: boolean;
  /** FR-16 H3-B：LLM judge 采样率，默认 0.05。 */
  summaryReuseJudgeSampleRate?: number;
  /** FR-16 H3-B：滑动窗口大小，默认 100。 */
  summaryReuseJudgeWindowSize?: number;
  /** FR-16 H3-B：触发 fallback 的窗口平均分阈值，默认 0.85。 */
  summaryReuseJudgeThreshold?: number;
  /** FR-16 H3-B：previousSummary 最大年龄（ms）。`undefined` 不限。 */
  summaryReuseMaxAgeMs?: number;
  /** FR-16 H3-B：触发 reuse 的最小新增消息条数；默认 3，防止短消息高频负收益。 */
  summaryReuseMinAddedMessages?: number;
  /**
   * FR-16 H3-B：注入 LLM judge 实现。`undefined` 走默认 `judgeSummaryQuality`。
   * 仅当 `enableSummaryReuse !== false` 且采样率 > 0 时调用。
   */
  summaryReuseJudgeFn?: SummaryJudgeFn;
  /**
   * FR-16 H3-B：reuse 路径需要发独立 LLM 调用做 judge——orchestrator 自身不持有
   * provider，由调用方（query-deps）注入。无该字段时 judge 直接 skip。
   */
  callModel?: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  /** 当前模型 id，judge 调用复用同 model；无该字段时 judge skip。 */
  model?: string;
  /**
   * FR-16 H3-B：判定本次是否采样 judge 用的随机源。仅测试需要覆盖；生产使用
   * `Math.random` 默认值。
   */
  randomSource?: () => number;
  /**
   * 连续对话成熟化 · 事 8：按压力比例分档路由的阈值（可选覆盖默认）。
   *
   * `Partial` 字段缺省由 `resolvePressureThresholds` 回落 `DEFAULT_PRESSURE_THRESHOLDS`。
   * query.ts 从 `EngineConfig.pressureThresholds` 透传过来。
   *
   * 详见 `compact/pressure-router.ts`。
   */
  pressureThresholds?: Partial<PressureThresholds>;
  /**
   * 连续对话成熟化 · 事 3：time-based microcompact 配置。
   *
   * 由 `EngineConfig.timeBasedMicroCompact` 透传。默认 `undefined` → 不触发。
   */
  timeBasedMicroCompact?: TimeBasedMCConfig;
  /**
   * 连续对话成熟化 · 事 3：最后一条 assistant 消息时间戳（ms epoch）。
   *
   * time-based microcompact 需要此信号判定 gap；host 通常从 session /
   * transcript 侧读出传入。`Message` 类型本身不带 timestamp，没有其他
   * 可靠来源。
   *
   * 未传时 `evaluateTimeBasedTrigger` 返回 `reason='no_timestamp'` 不触发
   * （保守默认——漏触发好于错触发把老结果清了）。
   */
  lastAssistantTimestamp?: number;
  /** 测试 / 诊断：当前时间 override。默认 `Date.now()`。 */
  now?: () => number;
  /**
   * Wave 8：压缩后注入文件内容 attachment 的 token 预算。
   * 透传给 `autoCompact` → `compactConversation`。
   * `undefined` 时用 `POST_COMPACT_ATTACHMENT_BUDGET`(20k)。
   */
  postCompactAttachmentBudget?: number;
}

interface CompactionRunState {
  messages: Message[];
  model: string;
  systemPrompt: string;
  iteration: number;
  pendingCondenseSummary?: string;
  _lastUsageAnchor?: UsageAnchor;
  _compactionForce?: boolean;
}

type AutoCompactFn = (params: AutoCompactParams & {
  tracking?: CompactTracking;
  tools?: ToolParam[];
  compactThreshold?: number;
  emergencyThreshold?: number;
  targetAfterCompact?: number;
  estimator?: TokenEstimator;
}) => Promise<CompactResult | null>;

/**
 * Run the pre-LLM compaction phase.
 */
export async function runCompactionPhase(
  state: CompactionRunState,
  orchestratorState: CompactionOrchestratorState,
  config: CompactionOrchestratorConfig,
  autoCompact: AutoCompactFn,
): Promise<CompactionPhaseResult> {
  const result: CompactionPhaseResult = {
    messages: state.messages,
    events: [],
    skipAutoCompact: false,
    terminate: false,
    invalidateAnchor: false,
  };

  const resolvedWindow = config.resolveContextWindow?.(state.model)
    ?? config.contextWindowTokens
    ?? 200_000;
  const outputReserve = config.maxOutputTokens ?? 16_384;
  const effectiveWindow = Math.max(resolvedWindow - outputReserve, 1);

  const transcriptPath = config.sessionDir && config.sessionId
    ? `${config.sessionDir}/${config.sessionId}/messages.jsonl`
    : undefined;

  const telemetryCtx = config.sessionId ? { session_id: config.sessionId } : undefined;

  // ── Step 1: Reactive compact ──
  // W3: `pendingCondenseSummary` is a generic signal channel — any tool can
  // push a summary through `ToolResultSignals.pendingCondense` and we'll fold
  // it into the conversation here. After `summarize_context` was deleted in
  // W3 there is no built-in producer left, but the channel is preserved so
  // future tools (e.g. an integration that summarises an external system's
  // changelog into the active conversation) can opt in without re-adding the
  // self-condense framework.
  runReactiveCompact({
    state,
    orchestratorState,
    config,
    result,
    transcriptPath,
    telemetryCtx,
  });

  // ── Step 2: Full context pressure estimation ──
  // ：锚**不再按 invalidateAnchor 屏蔽**。坐标系失效（裁剪后
  // messageCount > messages.length）由 estimateFullContextTokens 内部判定：
  // 失效锚不走精确路径，但其 inputSide（上次整请求实报）仍作为估算上界钳制
  // 纯字符估算的结构性虚高（幻影压力：实报 30k 被估成 115k → 假 emergency
  // 死循环，live 取证见 ）。
  const anchor = state._lastUsageAnchor;
  const estimatedTokens = estimateFullContextTokens(
    state.messages,
    state.systemPrompt,
    config.tools,
    anchor,
    config.estimator,
  );
  emitPhantomPressureTelemetry({
    state,
    config,
    anchor,
    clampedEstimate: estimatedTokens,
    telemetryCtx,
  });
  const pressure = effectiveWindow > 0
    ? Math.min(estimatedTokens / effectiveWindow, 1.0)
    : 0;

  // 连续对话成熟化 · 事 8：按压力比例分档路由
  const pressureThresholds: PressureThresholds = resolvePressureThresholds(
    config.budget,
    config.pressureThresholds,
  );
  const pressureStage: PressureStage = computePressureStage(pressure, pressureThresholds);

  if (pressureStage !== orchestratorState.lastPressureStage) {
    orchestratorState.lastPressureStage = pressureStage;
    result.events.push(new RuntimeContextPressureEvent({
        pressure: Number(pressure.toFixed(3)),
        level: pressureStage,
        estimatedTokens,
        contextWindow: resolvedWindow,
        model: state.model,
    }).toStreamEvent());
  }

  // Consume `_compactionForce` so forced compactions only fire once. The
  // marker still exists for hosts that programmatically force a compact
  // before the next iteration; `auto-compact.ts` reads its own equivalent
  // via tracking state.
  if (state._compactionForce) {
    state._compactionForce = undefined;
  }

  // W3 (2026-05-10): legacy "Step 2b: clean up stale condense state" removed.
  // The auto-condense state machine (`_condenseInProgress` and friends) was
  // deleted alongside the `summarize_context` tool, and the
  // `condenseCooldownIterations` / `maxCondenseIterations` fields it used to
  // throttle have been removed from `ContextBudget` too. auto-compact's own
  // `compactTracking` throttle is the only remaining LLM-summary gate.

  // ── Step 2b-time: Time-based microcompact (pressure-gated) ──
  // 连续对话成熟化 · 事 3：当压力达到 microcompact 档位（默认 pressure >= 0.75）
  // 且 EngineConfig.timeBasedMicroCompact.enabled=true 时，清理白名单工具的
  // 旧 tool_result content——保 tool_use_id 配对不破，模型看到占位会自觉重跑。
  // 默认 `enabled=false` → 本段是空转，不改变 Wave H3 之前行为。
  // W3 (2026-05-10): the legacy `inCooldown` guard was removed alongside the
  // auto-condense / `summarize_context` mechanism — auto-compact's internal
  // `compactTracking` throttle is now the only gate that prevents repeat
  // LLM-summary churn within a window, and time-based MC is independent of
  // that throttle (it clears ephemeral tool_result content, not history).
  runTimeBasedMicrocompact({
    state,
    config,
    result,
    estimatedTokens,
    pressure,
    pressureThresholds,
    pressureStage,
    telemetryCtx,
  });

  // ── Step 2c: (removed) Session Memory Compact ──
  // W1（压缩路径简化）：删除原本在中间档跑的 session memory
  // 自创模块 —— TabTin 自创"中间档"，把旧 tool_result 替换成
  // "[Tool result: name — first line]"一行摘要、截断 assistant text、
  // 合并 system notice。命名误导（与既有约定 同名文件做的"经验沉淀
  // 到 disk"完全不同），且与同期删除的"按层次裁剪"自创模块语义重叠
  // （C1 §2.3 / §2.4）。删除后该档位由"什么都不做"代替——time-based MC
  // 已在 Step 2b 处理白名单工具的"过期"占位；高压走 LLM summary。
  //
  // pressure-router 的 `'sessionMemory'` 档位、`sessionMemoryStart`
  // 阈值与对应 should-run helper 已在本 Wave 一并清理（W7 接 cached MC
  // 时如需新档位再加回）。

  // ── Step 3: Auto-condense (REMOVED in W3 — see file header) ──
  // Pressure crossing `llmSummaryStart` now goes straight to Step 4
  // (auto-compact) instead of asking the LLM to call `summarize_context`.

  // ── Step 4: Auto-compact ──
  await runAutoCompactStage({
    state,
    orchestratorState,
    config,
    result,
    autoCompact,
    effectiveWindow,
    transcriptPath,
    estimatedTokens,
    pressureThresholds,
    pressure,
    pressureStage,
    telemetryCtx,
  });

  // ── Step 5: Blocking guard ──
  // Re-estimate pressure after Steps 1-4 by recomputing from current messages
  // （历史上曾读 __tokenWarningState，该字段已删——本处一直是重新估算，不依赖它）。
  // ：同 Step 2——失效锚经 estimateFullContextTokens 内部钳制，不屏蔽。
  // 旧行为在 Step 4 压缩后传 undefined → 裸估算虚高 → 永远 stillBlocking →
  // emergency 每轮重砍（死循环主因之一）。
  const postCompactTokens = estimateFullContextTokens(
    state.messages,
    state.systemPrompt,
    config.tools,
    state._lastUsageAnchor,
    config.estimator,
  );
  const blockingLimit = effectiveWindow - config.budget.blockingReserveTokens;
  const stillBlocking = postCompactTokens >= blockingLimit;

  if (stillBlocking) {
    await runEmergencyBlockingCompact({
      state,
      orchestratorState,
      config,
      result,
      autoCompact,
      effectiveWindow,
      postCompactTokens,
      pressureThresholds,
      telemetryCtx,
    });
  }

  //  批次 8：原「result.invalidateAnchor → state._cacheNeedsRebuild = true」
  // 已删——该字段全库只写不读（telemetry 区分 cache miss 原因的消费方从未接上），
  // 属死状态。anchor 失效语义由 `result.invalidateAnchor` 本身承载。

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function runReactiveCompact(params: {
  state: CompactionRunState;
  orchestratorState: CompactionOrchestratorState;
  config: CompactionOrchestratorConfig;
  result: CompactionPhaseResult;
  transcriptPath?: string;
  telemetryCtx: { session_id: string } | undefined;
}): void {
  const { state, orchestratorState, config, result, transcriptPath, telemetryCtx } = params;
  if (typeof state.pendingCondenseSummary !== 'string') return;

  const summary = state.pendingCondenseSummary;
  state.pendingCondenseSummary = undefined;

  result.events.push(new RuntimeCompactionEvent({
    phase: 'start',
    mode: 'reactive',
  }).toStreamEvent());

  const messagesBefore = result.messages.length;
  // 为埋点补 tokens_before（代理值）。FR-11 正式扩展 CompactResult 字段后可
  // 去掉这次估算，走精确数。这里的估算开销 < 1ms（走现有缓存）。
  const tokensBefore = estimateFullContextTokens(
    state.messages,
    state.systemPrompt,
    config.tools,
    undefined,
    config.estimator,
  );
  const summaryMessage = buildSummaryMessage(summary, transcriptPath);
  const keptTail = collectReactiveKeptTail(result.messages);

  result.messages = [summaryMessage, ...keptTail];
  result.invalidateAnchor = true;
  state.messages = result.messages;
  orchestratorState.lastCompactIteration = state.iteration;

  const tokensAfter = estimateFullContextTokens(
    state.messages,
    state.systemPrompt,
    config.tools,
    undefined,
    config.estimator,
  );
  const reactiveToolUsesRetained = countToolUses(result.messages);
  const reactiveTokensFreed = Math.max(0, tokensBefore - tokensAfter);

  result.events.push(new RuntimeCompactionEvent({
      phase: 'end',
      mode: 'reactive',
      // ：带上摘要正文，让 SessionStorage 能写 compaction 边界 block 记录
      // （auto 路径的 buildAutoCompactEndEvent 已有同字段）。
      summary: summary || undefined,
      stats: {
        messages_before: messagesBefore,
        messages_after: result.messages.length,
        tokens_before: tokensBefore,
        tokens_after: tokensAfter,
        tokens_freed: reactiveTokensFreed,
        tool_uses_retained: reactiveToolUsesRetained,
        summary_length: summary.length,
      },
  }).toStreamEvent());

  emitTelemetryEvent(
    TelemetryEvents.COMPACT_END,
    {
      mode: 'reactive',
      decision_reason: 'pending_condense_summary_consumed',
      messages_before: messagesBefore,
      messages_after: result.messages.length,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_freed: reactiveTokensFreed,
      tool_uses_retained: reactiveToolUsesRetained,
      summary_length: summary.length,
      iteration: state.iteration,
    },
    telemetryCtx,
  );

  // FR-16 H3-B：reactive 改写了 state.messages（[summary + 尾部]），
  // 之前由 compactConversation 写入的 lastSummary.msgsCovered 索引语义已失
  // 效——直接清缓存，让下一次 auto compact 重新建立 reuse 缓存。
  // H3-B Review fix：仅清 lastSummary，**保留** reuseStats。
  orchestratorState.lastSummary = undefined;
}

function collectReactiveKeptTail(messages: Message[]): Message[] {
  const keptTail: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    keptTail.unshift(messages[i]);
    if (messages[i].role === 'assistant') break;
  }
  return keptTail;
}

function runTimeBasedMicrocompact(params: {
  state: CompactionRunState;
  config: CompactionOrchestratorConfig;
  result: CompactionPhaseResult;
  estimatedTokens: number;
  pressure: number;
  pressureThresholds: PressureThresholds;
  pressureStage: PressureStage;
  telemetryCtx: { session_id: string } | undefined;
}): void {
  const { state, config, result, estimatedTokens, pressure, pressureThresholds, pressureStage, telemetryCtx } = params;
  const timeBasedConfig = config.timeBasedMicroCompact;
  if (
    !timeBasedConfig?.enabled
    || !shouldRunTimeBasedMicrocompact(pressure, pressureThresholds)
  ) {
    return;
  }

  const timeBasedResult = maybeTimeBasedMicrocompact(state.messages, {
    config: timeBasedConfig,
    lastAssistantTimestamp: resolveLastAssistantTimestamp(state, config),
    now: config.now ? config.now() : Date.now(),
  });
  if (timeBasedResult.clearedCount <= 0) return;

  state.messages = timeBasedResult.messages;
  result.messages = timeBasedResult.messages;
  result.invalidateAnchor = true;
  // 用 micro mode 打 telemetry 事件——time-based 归属 microcompact 档位，
  // `reason: 'time_based'`。W1 之前 query-deps 层还有一条不发 COMPACT_END
  // 的长度截断路径，现已删除；当前 micro mode 只对应 time-based。
  emitTelemetryEvent(
    TelemetryEvents.COMPACT_END,
    {
      mode: 'micro',
      decision_reason: 'time_gap_exceeded',
      messages_before: state.messages.length,
      messages_after: state.messages.length,
      tokens_before: estimatedTokens,
      tokens_after: estimateFullContextTokens(
        state.messages,
        state.systemPrompt,
        config.tools,
        undefined,
        config.estimator,
      ),
      tokens_freed: 0,
      tool_uses_retained: countToolUses(state.messages),
      pressure_before: Number(pressure.toFixed(3)),
      pressure_stage: pressureStage,
      micro_reason: 'time_based',
      cleared_count: timeBasedResult.clearedCount,
      gap_minutes: Number(timeBasedResult.gapMinutes.toFixed(2)),
      iteration: state.iteration,
    },
    telemetryCtx,
  );
}

/**
 *  幻影压力观测：锚坐标系失效（裁剪后）且裸估算比钳制后估算虚高 >2× 时
 * 发 `compact.phantom_pressure`。仅失效锚场景才做第二次估算（正常轮次零开销）。
 */
function emitPhantomPressureTelemetry(params: {
  state: CompactionRunState;
  config: CompactionOrchestratorConfig;
  anchor: UsageAnchor | undefined;
  clampedEstimate: number;
  telemetryCtx: { session_id: string } | undefined;
}): void {
  const { state, config, anchor, clampedEstimate, telemetryCtx } = params;
  if (!anchor || anchor.messageCount <= 0) return;
  if (anchor.messageCount <= state.messages.length) return;
  const rawEstimate = estimateFullContextTokens(
    state.messages,
    state.systemPrompt,
    config.tools,
    undefined,
    config.estimator,
  );
  if (rawEstimate <= clampedEstimate * 2) return;
  emitTelemetryEvent(
    TelemetryEvents.COMPACT_PHANTOM_PRESSURE,
    {
      raw_estimate: rawEstimate,
      clamped_estimate: clampedEstimate,
      inflation_ratio: Number((rawEstimate / Math.max(clampedEstimate, 1)).toFixed(2)),
      anchor_input_side: anchor.inputTokens
        + (anchor.cacheReadTokens ?? 0)
        + (anchor.cacheCreationTokens ?? 0),
      messages: state.messages.length,
      model: state.model,
      iteration: state.iteration,
    },
    telemetryCtx,
  );
}

function resolveLastAssistantTimestamp(
  state: CompactionRunState,
  config: CompactionOrchestratorConfig,
): number | undefined {
  // lastAssistantTimestamp 三级回退：
  //   1. 显式 config.lastAssistantTimestamp（测试 / 宿主主动注入）
  //   2. state._lastUsageAnchor.timestamp（上次 callModel 返回时间，是
  //      "最后一次 assistant 消息完成"的精确代理）
  //   3. undefined → evaluateTimeBasedTrigger 返回 reason='no_timestamp' 不触发
  if (typeof config.lastAssistantTimestamp === 'number') {
    return config.lastAssistantTimestamp;
  }
  const anchor = state._lastUsageAnchor;
  if (anchor && typeof anchor.timestamp === 'number' && Number.isFinite(anchor.timestamp)) {
    return anchor.timestamp;
  }
  return undefined;
}

async function runAutoCompactStage(params: {
  state: CompactionRunState;
  orchestratorState: CompactionOrchestratorState;
  config: CompactionOrchestratorConfig;
  result: CompactionPhaseResult;
  autoCompact: AutoCompactFn;
  effectiveWindow: number;
  transcriptPath?: string;
  estimatedTokens: number;
  pressureThresholds: PressureThresholds;
  pressure: number;
  pressureStage: PressureStage;
  telemetryCtx: { session_id: string } | undefined;
}): Promise<void> {
  const {
    state,
    orchestratorState,
    config,
    result,
    autoCompact,
    effectiveWindow,
    transcriptPath,
    estimatedTokens,
    pressureThresholds,
    pressure,
    pressureStage,
    telemetryCtx,
  } = params;
  if (result.skipAutoCompact) return;

  const autoMessagesBefore = state.messages.length;
  // Step 2 已算过 estimatedTokens，可以直接当作 tokens_before（代理值）。
  const autoTokensBefore = estimatedTokens;
  // FR-16 H3-B：判定本轮是否走 fallback（窗口已 marked）+ snapshot prior summary
  // 给 judge 用（必须在 autoCompact 改写 state 之前 snapshot）。
  const reuseFallbackForced = consumePendingReuseFallback(orchestratorState);
  const reuseSnapshot = snapshotForReuseSideEffects(orchestratorState, state);
  const originalMessages = state.messages;
  const compactResult = await autoCompact({
    messages: state.messages,
    systemPrompt: state.systemPrompt,
    model: state.model,
    contextWindowTokens: effectiveWindow,
    transcriptPath,
    //  第二波·任务连续性：按会话查 active plan 指针，压缩后与未完成
    // 待办一起重注入 summary（tracker 以 threadId 为 key，与 config.sessionId
    // 同源——见 query.ts `sessionId: config.sessionConfig?.threadId`）。
    activePlanRef: resolveActivePlanForCompact(config.sessionId),
    // ：失效锚由 estimateFullContextTokens 内部钳制，不再按
    // invalidateAnchor 屏蔽（与 Step 2 / Step 5 同口径）。
    usageAnchor: state._lastUsageAnchor,
    tracking: orchestratorState.compactTracking,
    tools: config.tools,
    // ：LLM 摘要 / 紧急压缩的实际触发线用解析后的 pressureThresholds，
    // 与上方分档（computePressureStage）同一 SSoT——让 AdminDash 云端 / env 旋钮
    // 覆盖的 llmSummaryStart / emergencyStart 真正作用于触发时机，而非仅改分档展示。
    // 无 override 时 resolvePressureThresholds 回落 budget.compactThreshold /
    // emergencyThreshold，行为与历史一致。
    compactThreshold: pressureThresholds.llmSummaryStart,
    emergencyThreshold: pressureThresholds.emergencyStart,
    targetAfterCompact: config.budget.targetAfterCompact,
    estimator: config.estimator,
    previousSummary: orchestratorState.lastSummary,
    enableSummaryReuse: config.enableSummaryReuse !== false,
    summaryReuseMaxAgeMs: config.summaryReuseMaxAgeMs,
    summaryReuseMinAddedMessages: config.summaryReuseMinAddedMessages,
    forceFallbackReason: reuseFallbackForced ? 'judge_window_fallback' : undefined,
    postCompactAttachmentBudget: config.postCompactAttachmentBudget,
  });
  if (!compactResult) return;

  result.messages = compactResult.compactedMessages;
  result.invalidateAnchor = true;
  orchestratorState.lastCompactIteration = state.iteration;
  addCompactUsage(result, compactResult.compactUsage);

  const autoTokensAfter = Math.max(0, autoTokensBefore - compactResult.tokensFreed);
  const autoToolUsesRetained = countToolUses(result.messages);
  result.events.push(buildAutoCompactEndEvent({
    compactResult,
    originalMessages,
    autoMessagesBefore,
    autoTokensBefore,
    autoTokensAfter,
    autoToolUsesRetained,
    messagesAfter: result.messages,
  }));
  state.messages = result.messages;

  emitAutoCompactTelemetry({
    state,
    compactResult,
    result,
    autoMessagesBefore,
    autoTokensBefore,
    autoTokensAfter,
    autoToolUsesRetained,
    effectiveWindow,
    pressure,
    pressureStage,
    telemetryCtx,
  });

  await applyReuseSideEffects({
    state,
    orchestratorState,
    config,
    compactResult,
    messagesAfter: result.messages,
    telemetryCtx,
    snapshot: reuseSnapshot,
  });
}

function addCompactUsage(
  result: CompactionPhaseResult,
  usage: CompactResult['compactUsage'],
): void {
  // W3-fix P1-1: 累加到 result.compactUsage，由 query.ts 统一写 BudgetTracker
  if (!usage) return;
  if (!result.compactUsage) {
    result.compactUsage = { input_tokens: 0, output_tokens: 0 };
  }
  result.compactUsage.input_tokens += usage.input_tokens;
  result.compactUsage.output_tokens += usage.output_tokens;
  result.compactUsage.model = usage.model;
}

function getSourceMessageIds(messages: Message[]): string[] {
  return messages
    .map(message => (message as Message & { __sourceMessageId?: string }).__sourceMessageId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function computeCompactedUpToMessageId(
  originalMessages: Message[],
  compactedMessages: Message[],
): string | undefined {
  const sourceIdsBefore = getSourceMessageIds(originalMessages);
  const firstKeptSourceId = getSourceMessageIds(compactedMessages)[0];
  const firstKeptIndex = firstKeptSourceId ? sourceIdsBefore.indexOf(firstKeptSourceId) : -1;
  return firstKeptIndex > 0
    ? sourceIdsBefore[firstKeptIndex - 1]
    : sourceIdsBefore[sourceIdsBefore.length - 1];
}

function buildAutoCompactEndEvent(params: {
  compactResult: CompactResult;
  originalMessages: Message[];
  autoMessagesBefore: number;
  autoTokensBefore: number;
  autoTokensAfter: number;
  autoToolUsesRetained: number;
  messagesAfter: Message[];
}): CompactionEvent {
  const {
    compactResult,
    originalMessages,
    autoMessagesBefore,
    autoTokensBefore,
    autoTokensAfter,
    autoToolUsesRetained,
    messagesAfter,
  } = params;
  return new RuntimeCompactionEvent({
      phase: 'end',
      mode: compactResult.mode,
      summary: compactResult.summary || undefined,
      compacted_up_to_message_id: computeCompactedUpToMessageId(
        originalMessages,
        compactResult.compactedMessages,
      ),
      stats: {
        messages_before: autoMessagesBefore,
        messages_after: messagesAfter.length,
        tokens_before: autoTokensBefore,
        tokens_after: autoTokensAfter,
        tokens_freed: compactResult.tokensFreed,
        tool_uses_retained: autoToolUsesRetained,
      },
  }).toStreamEvent();
}

function emitAutoCompactTelemetry(params: {
  state: CompactionRunState;
  compactResult: CompactResult;
  result: CompactionPhaseResult;
  autoMessagesBefore: number;
  autoTokensBefore: number;
  autoTokensAfter: number;
  autoToolUsesRetained: number;
  effectiveWindow: number;
  pressure: number;
  pressureStage: PressureStage;
  telemetryCtx: { session_id: string } | undefined;
}): void {
  const {
    state,
    compactResult,
    result,
    autoMessagesBefore,
    autoTokensBefore,
    autoTokensAfter,
    autoToolUsesRetained,
    effectiveWindow,
    pressure,
    pressureStage,
    telemetryCtx,
  } = params;
  emitTelemetryEvent(
    TelemetryEvents.COMPACT_END,
    {
      mode: compactResult.mode,
      decision_reason: 'pressure_above_llm_threshold',
      messages_before: autoMessagesBefore,
      messages_after: result.messages.length,
      tokens_before: autoTokensBefore,
      tokens_after: autoTokensAfter,
      tokens_freed: compactResult.tokensFreed,
      tool_uses_retained: autoToolUsesRetained,
      pressure_before: Number(pressure.toFixed(3)),
      //  第一波度量基线：补压缩后压力与有效窗口，让"压缩把压力
      // 打回多少"可以直接查询，不用拿 tokens_after 除窗口二次推算
      // （emergency_blocking 路径此前已带 effective_window，口径对齐）。
      pressure_after: effectiveWindow > 0
        ? Number(Math.min(autoTokensAfter / effectiveWindow, 1.0).toFixed(3))
        : 0,
      effective_window: effectiveWindow,
      pressure_stage: pressureStage,
      iteration: state.iteration,
      attachments_injected: compactResult.attachmentsInjected ?? 0,
      attachment_tokens: compactResult.attachmentTokens ?? 0,
      //  第二波度量：尾部保留原文条数——部分压缩（动态保尾）与退化
      // 全量（固定保尾 6）在同一字段上可区分；兜底截断路径无此值。
      kept_tail_count: compactResult.keptTailCount ?? -1,
      summary_reused: compactResult.reuseInfo?.reused ?? false,
    },
    telemetryCtx,
  );
}

async function runEmergencyBlockingCompact(params: {
  state: CompactionRunState;
  orchestratorState: CompactionOrchestratorState;
  config: CompactionOrchestratorConfig;
  result: CompactionPhaseResult;
  autoCompact: AutoCompactFn;
  effectiveWindow: number;
  postCompactTokens: number;
  pressureThresholds: PressureThresholds;
  telemetryCtx: { session_id: string } | undefined;
}): Promise<void> {
  const {
    state,
    orchestratorState,
    config,
    result,
    autoCompact,
    effectiveWindow,
    postCompactTokens,
    pressureThresholds,
    telemetryCtx,
  } = params;
  const emergencyMessagesBefore = state.messages.length;
  // FR-16 H3-B：emergency_blocking 在 step 4 之后，lastSummary 可能
  // 已经被刚才那一轮 reuse / 全量更新过；同样判定 fallback 标记位。
  const emergencyReuseFallbackForced = consumePendingReuseFallback(orchestratorState);
  const emergencyReuseSnapshot = snapshotForReuseSideEffects(orchestratorState, state);
  const emergencyResult = await autoCompact({
    messages: state.messages,
    systemPrompt: state.systemPrompt,
    model: state.model,
    contextWindowTokens: effectiveWindow,
    // 任务连续性重注入对 emergency 同样成立（甚至更关键——阻塞压缩往往
    // 发生在长任务中段），与 Step 4 口径一致。
    activePlanRef: resolveActivePlanForCompact(config.sessionId),
    // ：emergency 内部压力判定同样要吃到失效锚钳制——旧实现漏传
    // usageAnchor，autoCompactIfNeeded 裸估算虚高后必然越过 emergency 阈值。
    usageAnchor: state._lastUsageAnchor,
    tracking: orchestratorState.compactTracking,
    tools: config.tools,
    // ：与 Step 4 同口径——emergency 兜底压缩的触发线同样用解析后的
    // pressureThresholds（AdminDash 云端 / env 旋钮 > runtime 默认），不再锚死
    // budget 原始值。
    compactThreshold: pressureThresholds.llmSummaryStart,
    emergencyThreshold: pressureThresholds.emergencyStart,
    targetAfterCompact: config.budget.targetAfterCompact,
    estimator: config.estimator,
    previousSummary: orchestratorState.lastSummary,
    enableSummaryReuse: config.enableSummaryReuse !== false,
    summaryReuseMaxAgeMs: config.summaryReuseMaxAgeMs,
    summaryReuseMinAddedMessages: config.summaryReuseMinAddedMessages,
    forceFallbackReason: emergencyReuseFallbackForced ? 'judge_window_fallback' : undefined,
    postCompactAttachmentBudget: 0,
  });

  if (!emergencyResult) {
    // autoCompact 返回 null：压力未达触发线 / cooldown。小窗下偶发与
    // blocking 绝对线错位——只有仍超 emergency 压力时才诚实 terminate。
    const emergencyTokenFloor = effectiveWindow * pressureThresholds.emergencyStart;
    if (postCompactTokens >= emergencyTokenFloor) {
      pushContextOverflowNotice(result);
    }
    return;
  }

  //  防抖：emergency 跑了但一个 token 都没省（live 取证 freed=0 连续 6 轮
  // 重砍同一批消息）——用独立计数累积（见 emergencyNoProgressStreak 注释：
  // 不能复用 compactTracking，会被 autoCompact 成功 reset 清掉）。有进展即清零。
  if (emergencyResult.tokensFreed <= 0) {
    orchestratorState.emergencyNoProgressStreak += 1;
  } else {
    orchestratorState.emergencyNoProgressStreak = 0;
  }

  result.messages = emergencyResult.compactedMessages;
  result.invalidateAnchor = true;
  // W3-fix P1-1: emergency compact usage 也累加到 result.compactUsage
  addCompactUsage(result, emergencyResult.compactUsage);

  // 连续无进展达阈值 → 真溢出压不回，诚实终止（保留已应用的 messages，
  // 但本轮不再喂 LLM，走 CONTEXT_OVERFLOW DONE），终结无限重砍死循环。
  if (orchestratorState.emergencyNoProgressStreak >= MAX_EMERGENCY_NO_PROGRESS) {
    pushContextOverflowNotice(result);
  }

  const emergencyTokensAfter = Math.max(0, postCompactTokens - emergencyResult.tokensFreed);
  const emergencyToolUsesRetained = countToolUses(result.messages);
  result.events.push(buildEmergencyCompactEndEvent({
    state,
    result,
    emergencyResult,
    emergencyMessagesBefore,
    postCompactTokens,
    emergencyTokensAfter,
    emergencyToolUsesRetained,
    effectiveWindow,
  }));
  state.messages = result.messages;

  emitEmergencyCompactTelemetry({
    state,
    result,
    emergencyResult,
    emergencyMessagesBefore,
    postCompactTokens,
    emergencyTokensAfter,
    emergencyToolUsesRetained,
    effectiveWindow,
    telemetryCtx,
  });

  await applyReuseSideEffects({
    state,
    orchestratorState,
    config,
    compactResult: emergencyResult,
    messagesAfter: result.messages,
    telemetryCtx,
    snapshot: emergencyReuseSnapshot,
  });
}

function pushContextOverflowNotice(result: CompactionPhaseResult): void {
  result.terminate = true;
  result.events.push(new RuntimeSystemNoticeEvent({
      content: 'Context window critically full after compaction attempts. Cannot continue.',
      notice_type: 'context_overflow',
  }).toStreamEvent());
}

function buildEmergencyCompactEndEvent(params: {
  state: CompactionRunState;
  result: CompactionPhaseResult;
  emergencyResult: CompactResult;
  emergencyMessagesBefore: number;
  postCompactTokens: number;
  emergencyTokensAfter: number;
  emergencyToolUsesRetained: number;
  effectiveWindow: number;
}): CompactionEvent {
  const {
    state,
    result,
    emergencyResult,
    emergencyMessagesBefore,
    postCompactTokens,
    emergencyTokensAfter,
    emergencyToolUsesRetained,
    effectiveWindow,
  } = params;
  return new RuntimeCompactionEvent({
      phase: 'end',
      mode: 'emergency_blocking',
      // ：与 reactive / auto 路径同字段——compaction 边界 block 记录来源。
      summary: emergencyResult.summary || undefined,
      stats: {
        messages_before: emergencyMessagesBefore,
        messages_after: result.messages.length,
        tokens_before: postCompactTokens,
        tokens_after: emergencyTokensAfter,
        tokens_freed: emergencyResult.tokensFreed,
        tool_uses_retained: emergencyToolUsesRetained,
        // ：曝光 blocking 判定所依据的有效窗口 + 模型，便于与 host 端
        // "catalog miss → 回落 32k" 告警关联，诊断"大窗口模型为何提前 blocking"。
        effective_window: effectiveWindow,
        model: state.model,
      },
  }).toStreamEvent();
}

function emitEmergencyCompactTelemetry(params: {
  state: CompactionRunState;
  result: CompactionPhaseResult;
  emergencyResult: CompactResult;
  emergencyMessagesBefore: number;
  postCompactTokens: number;
  emergencyTokensAfter: number;
  emergencyToolUsesRetained: number;
  effectiveWindow: number;
  telemetryCtx: { session_id: string } | undefined;
}): void {
  const {
    state,
    result,
    emergencyResult,
    emergencyMessagesBefore,
    postCompactTokens,
    emergencyTokensAfter,
    emergencyToolUsesRetained,
    effectiveWindow,
    telemetryCtx,
  } = params;
  emitTelemetryEvent(
    TelemetryEvents.COMPACT_END,
    {
      mode: 'emergency_blocking',
      decision_reason: 'pressure_above_blocking_limit_after_compact',
      messages_before: emergencyMessagesBefore,
      messages_after: result.messages.length,
      tokens_before: postCompactTokens,
      tokens_after: emergencyTokensAfter,
      tokens_freed: emergencyResult.tokensFreed,
      tool_uses_retained: emergencyToolUsesRetained,
      iteration: state.iteration,
      // ：结构化字段，让"按 fallback 32k 误触发 blocking"可查询可归因。
      effective_window: effectiveWindow,
      model: state.model,
    },
    telemetryCtx,
  );
}

/**
 *  第二波：把 active-plan-tracker 的 PlanRef 映射为 compact 层的
 * 任务连续性指针。sessionId 缺失 / 无活跃计划返回 undefined。
 * 导出给 query.ts 的 413 recovery autoCompact 复用，三条压缩路径同口径。
 */
export function resolveActivePlanForCompact(
  sessionId: string | undefined,
): { kind: 'file' | 'document'; target: string } | undefined {
  if (!sessionId) return undefined;
  const ref = getActivePlanRef(sessionId);
  if (!ref) return undefined;
  return ref.kind === 'file'
    ? { kind: 'file', target: ref.path }
    : { kind: 'document', target: ref.document_id };
}

// ─── FR-16 H3-B reuse helpers ────────────────────────────────────────

/**
 * 读 `reuseStats.fallbackTriggered`，并在读到 true 时清除它。
 * 调用方据此把 `forceFallbackReason='judge_window_fallback'` 透传给
 * `compactConversation`——下一次 reuse 会重新进入累积阶段（"自动回退后下次再尝试"）。
 *
 * 单一函数封装"读 + 清"原子操作，避免主循环在两处忘记 reset 出现死锁。
 */
function consumePendingReuseFallback(orchestratorState: CompactionOrchestratorState): boolean {
  const stats = orchestratorState.reuseStats;
  if (!stats?.fallbackTriggered) return false;
  orchestratorState.reuseStats = {
    scores: [],
    fallbackTriggered: false,
    consecutiveFailures: stats.consecutiveFailures,
  };
  return true;
}

interface ReusePreCompactSnapshot {
  /** 调用 autoCompact 前的 `lastSummary` 拷贝；reuse 后用作 judge 的 PRIOR_SUMMARY。 */
  priorSummary: SummaryReuseEntry | undefined;
  /** 调用 autoCompact 前的 `state.messages` 拷贝；reuse 后用作 judge 的 NEW_MESSAGES 切片源。 */
  messagesBefore: Message[];
}

function snapshotForReuseSideEffects(
  orchestratorState: CompactionOrchestratorState,
  state: CompactionRunState,
): ReusePreCompactSnapshot {
  return {
    priorSummary: orchestratorState.lastSummary
      ? { ...orchestratorState.lastSummary }
      : undefined,
    // shallow copy 即可——messages 自身是 read-only by convention（见 message-normalizer 设计 invariant）
    messagesBefore: state.messages.slice(),
  };
}

interface ApplyReuseSideEffectsParams {
  state: CompactionRunState;
  orchestratorState: CompactionOrchestratorState;
  config: CompactionOrchestratorConfig;
  compactResult: CompactResult;
  messagesAfter: Message[];
  telemetryCtx: { session_id: string } | undefined;
  snapshot: ReusePreCompactSnapshot;
}

function updateLastSummaryCache(params: ApplyReuseSideEffectsParams): void {
  const { orchestratorState, config, compactResult, messagesAfter, snapshot } = params;
  const reuseInfo = compactResult.reuseInfo;

  if (
    !compactResult.summary ||
    compactResult.summary.trim().length === 0 ||
    compactResult.summaryIsPlaceholder
  ) {
    return;
  }

  const tokensCovered = estimateTokens(messagesAfter, config.estimator);
  const msgsCovered = typeof compactResult.keptTailCount === 'number'
    ? Math.max(0, messagesAfter.length - compactResult.keptTailCount)
    : reuseInfo?.coveredMsgsAfter ?? Math.max(
        0,
        snapshot.messagesBefore.length - (messagesAfter.length - 1),
      );
  orchestratorState.lastSummary = {
    content: compactResult.summary,
    generatedAt: Date.now(),
    msgsCovered,
    tokensCovered,
  };
}

function emitReuseOutcomeTelemetry(params: ApplyReuseSideEffectsParams): void {
  const { state, compactResult, telemetryCtx } = params;
  const reuseInfo = compactResult.reuseInfo;

  if (reuseInfo?.reused) {
    emitTelemetryEvent(
      TelemetryEvents.COMPACT_SUMMARY_REUSED,
      {
        previous_summary_age_ms: reuseInfo.previousAgeMs ?? 0,
        msgs_added: reuseInfo.msgsAdded ?? 0,
        tokens_saved: reuseInfo.tokensSaved ?? 0,
        covered_msgs_before: reuseInfo.coveredMsgsBefore ?? 0,
        covered_msgs_after: reuseInfo.coveredMsgsAfter ?? 0,
        iteration: state.iteration,
      },
      telemetryCtx,
    );
    return;
  }

  if (
    reuseInfo &&
    !reuseInfo.reused &&
    reuseInfo.fallbackReason &&
    // no_previous_summary 是首次 compact 的常态；不发避免噪声。
    reuseInfo.fallbackReason !== 'no_previous_summary'
  ) {
    emitTelemetryEvent(
      TelemetryEvents.COMPACT_FALLBACK_FULL,
      {
        reason: reuseInfo.fallbackReason,
        iteration: state.iteration,
      },
      telemetryCtx,
    );
  }
}

function shouldRunReuseJudge(params: ApplyReuseSideEffectsParams): boolean {
  const { config, compactResult, snapshot } = params;
  const reuseInfo = compactResult.reuseInfo;
  if (!reuseInfo?.reused) return false;
  if (config.enableSummaryReuse === false) return false;
  const sampleRate = config.summaryReuseJudgeSampleRate ?? DEFAULT_SUMMARY_REUSE_JUDGE_SAMPLE_RATE;
  if (!shouldSampleJudge(sampleRate, config.randomSource)) return false;
  if (!config.callModel || !config.model) return false; // 没 LLM 入口就不能跑 judge
  if (!snapshot.priorSummary || snapshot.priorSummary.content.trim().length === 0) return false;
  return true;
}

function recordReuseJudgeFailure(
  orchestratorState: CompactionOrchestratorState,
  iteration: number,
  telemetryCtx: { session_id: string } | undefined,
): void {
  orchestratorState.reuseStats = recordJudgeFailure(orchestratorState.reuseStats);
  // H3-B Review fix：发 compact.judge_failed 事件让运维能感知 judge 通道异常，
  // 否则只看到 compact.judge_score 数 = 0 难以分辨"采样率 0"还是"judge 全失败"。
  emitTelemetryEvent(
    TelemetryEvents.COMPACT_JUDGE_FAILED,
    {
      consecutive_failures: orchestratorState.reuseStats?.consecutiveFailures ?? 0,
      iteration,
    },
    telemetryCtx,
  );
}

function recordReuseJudgeScore(params: {
  orchestratorState: CompactionOrchestratorState;
  iteration: number;
  config: CompactionOrchestratorConfig;
  score: number;
  telemetryCtx: { session_id: string } | undefined;
}): void {
  const { orchestratorState, iteration, config, score, telemetryCtx } = params;
  const windowSize =
    config.summaryReuseJudgeWindowSize ?? DEFAULT_SUMMARY_REUSE_JUDGE_WINDOW_SIZE;
  const threshold =
    config.summaryReuseJudgeThreshold ?? DEFAULT_SUMMARY_REUSE_JUDGE_THRESHOLD;

  const updated = appendJudgeScoreAndCheckFallback({
    stats: orchestratorState.reuseStats,
    score,
    windowSize,
    threshold,
  });
  orchestratorState.reuseStats = updated.stats;

  emitTelemetryEvent(
    TelemetryEvents.COMPACT_JUDGE_SCORE,
    {
      score,
      sample_id: makeSampleId(),
      fallback_triggered: updated.fallbackTriggered,
      window_size: windowSize,
      threshold,
      iteration,
    },
    telemetryCtx,
  );
}

async function runReuseJudge(params: ApplyReuseSideEffectsParams): Promise<void> {
  const { state, orchestratorState, config, compactResult, telemetryCtx, snapshot } = params;
  const reuseInfo = compactResult.reuseInfo;
  if (!shouldRunReuseJudge(params) || !reuseInfo || !snapshot.priorSummary || !config.callModel || !config.model) {
    return;
  }

  const judgeFn = config.summaryReuseJudgeFn ?? judgeSummaryQuality;
  const addedMessagesForJudge = snapshot.messagesBefore.slice(
    snapshot.priorSummary.msgsCovered,
    reuseInfo.coveredMsgsAfter,
  );

  let score: number | null;
  try {
    score = await judgeFn({
      previousSummary: snapshot.priorSummary.content,
      newSummary: compactResult.summary,
      addedMessages: addedMessagesForJudge,
      model: config.model,
      callModel: config.callModel,
    });
  } catch {
    score = null;
  }

  if (score === null) {
    recordReuseJudgeFailure(orchestratorState, state.iteration, telemetryCtx);
    return;
  }

  recordReuseJudgeScore({ orchestratorState, iteration: state.iteration, config, score, telemetryCtx });
}

/**
 * compact 完成后执行的所有 reuse 相关副作用：
 *   1. 更新 `orchestratorState.lastSummary`：成功产出非空**真实** summary 即缓存（无论
 *      reuse / 全量）；兜底占位文案（`summaryIsPlaceholder`）不缓存。
 *   2. 根据 `compactResult.reuseInfo` 发埋点：
 *      - `reused=true` → `compact.summary_reused`
 *      - `reused=false && fallbackReason !== 'no_previous_summary'` → `compact.fallback_full`
 *        （首次 compact 没缓存是常态，跳过避免噪声）
 *   3. reuse 命中时按 `summaryReuseJudgeSampleRate` 采样 LLM judge：
 *      - judge 成功 → 写 `reuseStats.scores` + 发 `compact.judge_score`
 *      - judge 失败 → `recordJudgeFailure`，不写 score，不发 score 事件
 *      - 窗口满 + avg < threshold → 标记 `fallbackTriggered=true`（下轮 consume）
 *
 * 永不抛——judge / telemetry 任何失败都被 swallowed，避免污染主流程。
 *
 * `snapshot` 是调 autoCompact 之前的 prior summary + messages 拷贝——judge 必须
 * 用旧值才有意义（顺序：snapshot → autoCompact → updateCache → judge with snapshot）。
 */
async function applyReuseSideEffects(params: ApplyReuseSideEffectsParams): Promise<void> {
  // ── (1) Update lastSummary cache ──
  // 仅在 LLM 真的产出了 summary 时缓存（兜底/空 summary 不写）。
  //
  //  第二波·坐标系修复：`msgsCovered` 必须用**压缩后新数组的坐标**——
  // 下一轮压缩的 splitIdx 是在新数组（[summary(, ack)?, ...保留尾部, ...新增]）
  // 上算的。旧实现存的是压缩前坐标（reuse 路径 coveredMsgsAfter=旧 splitIdx、
  // 全量路径 messagesBefore-based 推算），新旧坐标相减得到负数 → 永远命中
  // `no_new_messages` 回落全量——单次长任务内第二次及以后的压缩事实上从未
  // 走过增量复用。
  //
  // 新坐标下"已被摘要覆盖的前缀" = 新数组头部的 summary 消息（+ 可选 ack）
  // = `messagesAfter.length - keptTailCount`。下一轮增量 = 上次保留的尾部 +
  // 之后新增的消息——这些确实都没被上次摘要覆盖，语义正确。
  // `keptTailCount` 缺失（宿主注入的旧 mock / 兜底截断路径）时回退旧公式，
  // 行为不比从前差。
  //  review 修复（P2-5）：兜底占位文案（layeredPrune / hardTrim / softTrim）
  // 不是真实摘要，写进缓存会在下一轮增量复用时被当作 PRIOR_SUMMARY 拼进新摘要。
  updateLastSummaryCache(params);

  // ── (2) Emit compact.summary_reused / compact.fallback_full ──
  emitReuseOutcomeTelemetry(params);

  // ── (3) LLM judge sampling on reuse hits ──
  await runReuseJudge(params);
}

function makeSampleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sample-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSummaryMessage(summary: string, transcriptPath?: string): Message {
  let content = `[对话摘要]\n\n${summary}\n\n[摘要结束]`;

  if (transcriptPath) {
    content += '\n\n---';
    content += `\n完整对话记录：${transcriptPath}`;
    content += '\n注：该文件为 JSONL 格式（每行一条记录），可能非常长。';
    content += '\n请用搜索工具查找特定内容，或用 offset/limit 分段读取。';
  }

  content += '\n\n[最近对话如下]';

  return { role: 'user' as const, content };
}
