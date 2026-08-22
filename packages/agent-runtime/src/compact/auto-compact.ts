/**
 * Auto-compact — pressure-based decision layer.
 *
 * Decision tree:
 *   pressure < 0.85  → no-op
 *   0.85 ≤ p < 0.95  → LLM summary compaction
 *   p ≥ 0.95         → emergency hard trim + LLM summary fallback
 *
 * W1（压缩路径简化）：删除原本的 layered prune 优先级链。
 * 那是 TabTin 自创的"按层次裁剪老 tool_result content"算法，
 * 该档位由 cached microcompact + cache_edits（W7 接入），
 * 不做"事后改写历史 tool_result"。删完后 0.85 ≤ p < 0.95 的中间档统一走
 * LLM summary compaction，避免与既有约定 的语义偏离。
 *
 * Auto-compacts when pressure crosses threshold.
 */

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
  SummaryReuseFallbackReason,
} from '../engine/contracts/context-capability.js';
import {
  estimateTokens,
  estimateFullContextTokens,
  computeMessagesTargetFromFullTarget,
  softTrim,
  hardTrim,
  TokenEstimator,
} from '../engine/context/token-budget.js';
import type { UsageAnchor } from '../engine/context/token-budget.js';
import { compactConversation } from './compact.js';
import type { ForkCompactConfig } from './compact.js';
import { layeredPrune } from './layered-prune.js';
import {
  buildEmergencyLayeredPruneSummary,
  EMERGENCY_HARD_TRIM_FALLBACK,
  SOFT_TRIM_FALLBACK,
} from '../prompts/compact/fallbacks.js';
import { buildTruncationTaskStateSection } from '../prompts/compact/truncation-task-state.js';
import { deriveActiveTodoBatch } from '../todo/todo-replay.js';

// ─── Pressure thresholds ─────────────────────────────────────────────

const PRESSURE_LLM_SUMMARY = 0.85;
const PRESSURE_EMERGENCY = 0.95;
const TARGET_AFTER_COMPACT = 0.7;

const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;
const COMPACT_COOLDOWN_MS = 60_000;

/**
 *  第二波·部分压缩：normal 档保尾条数下限（旧固定值，退化场景兜底）。
 * emergency 档仍固定保尾 `EMERGENCY_KEEP_LAST_N`（空间紧张时保守）。
 */
const NORMAL_MIN_KEEP_LAST_N = 6;
const EMERGENCY_KEEP_LAST_N = 4;
/** 尾部预算需给摘要输出留的余量（对齐 compact.ts SUMMARY_MAX_OUTPUT_TOKENS）。 */
const SUMMARY_OUTPUT_RESERVE_TOKENS = 8192;
/** 保证至少有这么多条头部消息可摘（低于此数部分压缩退化为固定保尾）。 */
const MIN_MESSAGES_TO_SUMMARIZE = 4;

/**
 *  第二波·部分压缩：按"压缩后压力回到 `targetAfterCompact`"反推 normal
 * 档的保尾条数——尾部保留原文的部分尽可能大（正在干的活不失真），只把
 * 更早的前半段交给摘要。
 *
 * 与旧固定 `keepLastN=6` 的差异：200k 窗口 / target=0.70 时尾部预算约 13 万
 * token，可保几十条消息原文；旧值把 0.85 压到 ~0.1，尾部现场全被摘要重写，
 * 长任务忘事的主要来源。
 *
 * 口径：`computeMessagesTargetFromFullTarget` 把"含 system + tools 的 full
 * 目标"换算成 messages-only 预算（W4.2 修复的同款口径），再扣摘要输出预留。
 * 小窗口模型换算后预算可能归零——回落 `NORMAL_MIN_KEEP_LAST_N`，行为与旧
 * 实现一致。
 */
export function computePartialKeepLastN(params: {
  messages: Message[];
  systemPrompt: string;
  tools?: ToolParam[];
  contextWindowTokens: number;
  targetAfterCompact: number;
  estimator?: TokenEstimator;
}): number {
  const { messages, systemPrompt, tools, contextWindowTokens, targetAfterCompact, estimator } = params;

  const fullTarget = Math.floor(contextWindowTokens * targetAfterCompact);
  const messagesTarget = computeMessagesTargetFromFullTarget(
    fullTarget,
    systemPrompt,
    tools,
    estimator,
  );
  const tailBudget = messagesTarget - SUMMARY_OUTPUT_RESERVE_TOKENS;
  if (tailBudget <= 0) return NORMAL_MIN_KEEP_LAST_N;

  let accumulated = 0;
  let keep = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens([messages[i]], estimator);
    if (accumulated + tokens > tailBudget) break;
    accumulated += tokens;
    keep++;
  }

  // 保证头部至少留 MIN_MESSAGES_TO_SUMMARIZE 条可摘——否则压缩空转
  // （compactConversation 对 messages.length <= keepLastN + 1 直接 no-op）。
  const maxKeep = Math.max(NORMAL_MIN_KEEP_LAST_N, messages.length - MIN_MESSAGES_TO_SUMMARIZE);
  return Math.min(Math.max(NORMAL_MIN_KEEP_LAST_N, keep), maxKeep);
}

/**
 * Session-level compact failure tracking.
 * Stored in EngineState to avoid cross-session pollution.
 */
export interface CompactTracking {
  consecutiveFailures: number;
  lastFailureTime: number;
}

export function initCompactTracking(): CompactTracking {
  return { consecutiveFailures: 0, lastFailureTime: 0 };
}

// ─── Public API ──────────────────────────────────────────────────────

export function calculateContextPressure(
  messages: Message[],
  contextWindowTokens: number,
  estimator?: TokenEstimator,
): number {
  if (contextWindowTokens <= 0) return 0;
  return Math.min(estimateTokens(messages, estimator) / contextWindowTokens, 1.0);
}

function shouldSkipForCompactCooldown(tracking: CompactTracking): boolean {
  if (tracking.consecutiveFailures < MAX_CONSECUTIVE_COMPACT_FAILURES) {
    return false;
  }
  if (Date.now() - tracking.lastFailureTime < COMPACT_COOLDOWN_MS) {
    return true;
  }
  tracking.consecutiveFailures = 0;
  return false;
}

/**
 * Automatically compact if context pressure warrants it.
 *
 * Priority chain: LLM summary → soft/hard trim fallback.
 *
 * `tracking` is session-level mutable state for failure counting.
 * If not provided, a temporary tracking object is created (no persistence).
 */
export async function autoCompactIfNeeded(
  params: AutoCompactParams & {
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
    forkConfig?: ForkCompactConfig;
    tracking?: CompactTracking;
    tools?: ToolParam[];
    compactThreshold?: number;
    emergencyThreshold?: number;
    targetAfterCompact?: number;
    estimator?: TokenEstimator;
    /**
     * FR-16 H3-B：上游已经决定本次必须走全量（通常因为 judge 窗口 fallback）。
     * 透传给 `compactConversation`，由它写入 `reuseInfo.fallbackReason` 让宿主
     * 统一发 `compact.fallback_full` 埋点。
     */
    forceFallbackReason?: SummaryReuseFallbackReason;
  },
): Promise<CompactResult | null> {
  const {
    messages,
    systemPrompt,
    model,
    contextWindowTokens,
    callModel,
    transcriptPath,
    usageAnchor,
    forkConfig,
    tools,
    previousSummary,
    enableSummaryReuse,
    summaryReuseMaxAgeMs,
    summaryReuseMinAddedMessages,
    forceFallbackReason,
    postCompactAttachmentBudget,
  } = params;
  const tracking = params.tracking ?? initCompactTracking();
  const thresholdLLM = params.compactThreshold ?? PRESSURE_LLM_SUMMARY;
  const thresholdEmergency = params.emergencyThreshold ?? PRESSURE_EMERGENCY;
  const targetPressure = params.targetAfterCompact ?? TARGET_AFTER_COMPACT;

  const estimatedTokens = estimateFullContextTokens(
    messages,
    systemPrompt,
    tools,
    usageAnchor as UsageAnchor | undefined,
    params.estimator,
  );
  const pressure = contextWindowTokens > 0
    ? Math.min(estimatedTokens / contextWindowTokens, 1.0)
    : 0;

  if (pressure < thresholdLLM) {
    return null;
  }

  if (shouldSkipForCompactCooldown(tracking)) return null;

  const tokensBefore = estimatedTokens;

  // ── Emergency path（ 语义保全阶梯重排）──
  //
  // 旧序「hardTrim 先砍 → LLM 摘要后补 → 摘要挂了裸截断」有两个致命点：
  //   1. hardTrim 先删头部，todo / 早期上下文在摘要跑之前就没了——
  //      摘要与 task-continuity 都只能看到删剩的尾巴；
  //   2. 摘要失败时产物 = 裸截断消息，任务锚全丢（live 取证 ）。
  // 新序：无损/占位手段优先，硬删垫底且必须钉「当前任务状态」锚：
  //   ① layeredPrune（无 LLM，裁旧 tool_result，结构保留）
  //   ② softTrim 占位改写（不删消息，todo 块原样保留）
  //   ③ LLM 摘要（输入是 ①② 的产物——task-continuity 仍能回放出待办）
  //   ④ 摘要失败 → hardTrim 兜底，截断告示钉任务状态锚
  if (pressure >= thresholdEmergency) {
    // 钉锚素材从**原始消息**回放（任何裁剪之前）——全量合并态（含已完成项，
    // 截断后没有摘要兜底，进度只能靠本段自证）。
    const anchorBatch = deriveActiveTodoBatch(messages);
    const taskStateNotice = buildTruncationTaskStateSection({
      todos: anchorBatch?.settled ? undefined : anchorBatch?.todos,
      plan: params.activePlanRef ?? null,
    }) || undefined;

    // ① layeredPrune：能把压力压回 emergency 阈值以下就直接返回。
    const pruneResult = layeredPrune(messages, {
      contextWindowTokens,
      estimator: params.estimator,
    });
    if (pruneResult) {
      const prunedFullTokens = estimateFullContextTokens(
        pruneResult.messages,
        systemPrompt,
        tools,
        usageAnchor as UsageAnchor | undefined,
        params.estimator,
      );
      const prunedPressure = contextWindowTokens > 0
        ? Math.min(prunedFullTokens / contextWindowTokens, 1.0)
        : 0;
      if (prunedPressure < thresholdEmergency) {
        tracking.consecutiveFailures = 0;
        return {
          compactedMessages: pruneResult.messages,
          summary: buildEmergencyLayeredPruneSummary(pruneResult.freedTokens),
          tokensFreed: pruneResult.freedTokens,
          mode: 'auto',
          summaryIsPlaceholder: true,
        };
      }
    }

    const emergencyFullTarget = Math.floor(contextWindowTokens * targetPressure);
    // W4.2 Bug 2 修复：full-target → messages-target 口径换算（见 helper 注释）。
    const messagesTarget = computeMessagesTargetFromFullTarget(
      emergencyFullTarget,
      systemPrompt,
      tools,
      params.estimator,
    );

    // ② softTrim 占位改写：把旧 tool_result 换占位符，消息结构（含 todo
    // 的 tool_use 块）原样保留——LLM 摘要与 task-continuity 回放都不受损。
    const afterPrune = pruneResult ? pruneResult.messages : messages;
    const squashed = softTrim(afterPrune, messagesTarget, params.estimator);

    // ③ LLM 摘要：输入是占位改写后的完整消息序列（头部语义仍在）。
    try {
      const result = await compactConversation({
        messages: squashed,
        systemPrompt,
        model,
        callModel,
        keepLastN: EMERGENCY_KEEP_LAST_N,
        transcriptPath,
        forkConfig,
        estimator: params.estimator,
        postCompactAttachmentBudget: 0,
        // ：任务连续性段极小（计划一行 + 待办若干行），emergency 也注入。
        activePlanRef: params.activePlanRef,
        // FR-16 H3-B：emergency 路径下消息已被 prune/softTrim 改写，
        // 旧 `previousSummary.msgsCovered` 索引语义不再对齐，故**不**透传
        // previousSummary——让 compactConversation 走全量。
      });
      tracking.consecutiveFailures = 0;
      return { ...result, mode: 'auto' };
    } catch {
      // ④ 摘要失败兜底：hardTrim 硬删，但截断告示钉「当前任务状态」锚
      // ——删的是消息，不删任务真相。
      tracking.consecutiveFailures++;
      tracking.lastFailureTime = Date.now();
      const trimmed = hardTrim(squashed, messagesTarget, params.estimator, taskStateNotice);
      const tokensAfter = estimateFullContextTokens(trimmed, systemPrompt, tools, undefined, params.estimator);
      return {
        compactedMessages: trimmed,
        summary: EMERGENCY_HARD_TRIM_FALLBACK,
        tokensFreed: Math.max(0, tokensBefore - tokensAfter),
        mode: 'auto',
        summaryIsPlaceholder: true,
      };
    }
  }

  // ── Normal path: LLM summary compaction（ 第二波：部分压缩语义）──
  // W1：删除原本的"按层次裁剪老 tool_result content"自创优先链
  // （C1 §2.3），破坏 prompt cache & 跨轮 byte-identical。中间档
  // （0.85 ≤ p < 0.95）统一走 LLM summary。cache_edits 透传留 W7 接入。
  //
  // ：保尾条数从固定 6 改为按"压缩后压力回到 targetAfterCompact"反推
  // ——尾部（正在干的活）尽可能保留原文，只摘更早的前半段。三级优先里
  // 增量复用仍在 compactConversation 内部先判（reuse → 部分压缩式全量 →
  // chunked 兜底），本处只决定切分点位置。
  try {
    const result = await compactConversation({
      messages,
      systemPrompt,
      model,
      callModel,
      keepLastN: computePartialKeepLastN({
        messages,
        systemPrompt,
        tools,
        contextWindowTokens,
        targetAfterCompact: targetPressure,
        estimator: params.estimator,
      }),
      transcriptPath,
      forkConfig,
      estimator: params.estimator,
      previousSummary,
      enableSummaryReuse,
      summaryReuseMaxAgeMs,
      summaryReuseMinAddedMessages,
      forceFallbackReason,
      postCompactAttachmentBudget,
      activePlanRef: params.activePlanRef,
    });
    tracking.consecutiveFailures = 0;
    return { ...result, mode: 'auto' };
  } catch {
    tracking.consecutiveFailures++;
    tracking.lastFailureTime = Date.now();
    // W4.2 Bug 2 同类对齐：softTrim 内部也用 estimateTokens(messages) (messages-only),
    // 跟 hardTrim 同样的口径不一致问题——LLM summary 失败的回退路径在大窗口
    // 模型上同样会 noop。用 helper 把 fullTarget 转 messagesTarget 后再传 softTrim。
    const fullTarget = Math.floor(contextWindowTokens * targetPressure);
    const messagesTarget = computeMessagesTargetFromFullTarget(
      fullTarget,
      systemPrompt,
      tools,
      params.estimator,
    );
    const trimmed = softTrim(messages, messagesTarget, params.estimator);
    const tokensAfter = estimateFullContextTokens(trimmed, systemPrompt, tools, undefined, params.estimator);
    return {
      compactedMessages: trimmed,
      summary: SOFT_TRIM_FALLBACK,
      tokensFreed: Math.max(0, tokensBefore - tokensAfter),
      mode: 'auto',
      summaryIsPlaceholder: true,
    };
  }
}
