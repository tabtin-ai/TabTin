/**
 * FR-16 H3-B — LLM-based summary quality judge.
 *
 * Reuse 路径每次命中后，按 `summaryReuseJudgeSampleRate` 概率采样一次评分：
 *   1. `judgeSummaryQuality` 同 LLM provider 发一次 judge 调用，让模型对比
 *      "前次 summary + 新增消息" 与 "本次 reuse 产出的 updated summary"，
 *      给出 0-1 评分。
 *   2. `appendJudgeScoreAndCheckFallback` 把评分写进 `CompactionOrchestratorState.reuseStats`
 *      的滑动窗口；窗口达到 `summaryReuseJudgeWindowSize` 且平均分
 *      < `summaryReuseJudgeThreshold` 时，标记 `fallbackTriggered=true` 并
 *      reset 窗口（"自动回退后下次再尝试"）。
 *
 * 设计要点：
 * - **永不抛**：judge LLM 抛错 / 返回非数字 / 越界都 swallow 掉返回 `null`，
 *   让上游决定"该样本作废"，不影响 reuse 主路径。
 * - **不依赖宿主**：仅消费 `LLMRequest` / `LLMResponseChunk` 协议；`EngineConfig`
 *   通过 `summaryReuseJudgeFn` 注入即可定制（测试 stub / 未来切便宜模型）。
 * - **轻量化**：judge prompt 故意短，不做多轮迭代；目标是"快速给个粗 score"，
 *   不是"严格语义评测"——后者交给 PRD §7 的 G1 真实样本对照（遗留项 L21）。
 */

import type {
  Message,
} from '../engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../engine/contracts/model-llm.js';
import type {
  SummaryJudgeFn,
  SummaryReuseStats,
} from '../engine/contracts/context-capability.js';
import { JUDGE_SYSTEM_PROMPT } from '../prompts/compact/judge-system.js';
import { buildJudgeUserPrompt } from '../prompts/compact/judge-user.js';

const JUDGE_MAX_OUTPUT_TOKENS = 256;
const JUDGE_TEMPERATURE = 0;

/**
 * 内置默认 judge 实现。
 *
 * 若 `EngineConfig.summaryReuseJudgeFn` 未注入，`runCompactionPhase` 会调用本函数。
 * 同 LLM provider 走一次 judge 调用，期望模型按上面 prompt 返回单 JSON 评分。
 *
 * 失败处理（统一返回 `null`）：
 *   - LLM 抛错 / abort
 *   - 响应为空 / 非 JSON
 *   - score 字段缺失 / 非数字 / NaN / Infinity
 *   - score < 0 或 > 1（视为非法响应）
 */
export const judgeSummaryQuality: SummaryJudgeFn = async ({
  previousSummary,
  newSummary,
  addedMessages,
  model,
  callModel,
}): Promise<number | null> => {
  try {
    const userPrompt = buildJudgeUserPrompt(previousSummary, newSummary, addedMessages);
    const request: LLMRequest = {
      model,
      messages: [{ role: 'user', content: userPrompt }],
      system: JUDGE_SYSTEM_PROMPT,
      maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
      temperature: JUDGE_TEMPERATURE,
      requestSource: '_summary_judge',
    };

    let text = '';
    for await (const chunk of callModel(request)) {
      if (chunk.type === 'text_delta' && chunk.text) {
        text += chunk.text;
      }
    }

    return parseJudgeScore(text);
  } catch {
    return null;
  }
};

/**
 * 健壮地从 LLM 文本响应里抽取 score：
 *   1. 优先解析整段为 JSON。
 *   2. 失败则在文本里 grep `"score":<数字>` 兜底——模型偶尔会把 JSON 包在
 *      ```json fence 或加前导解释里，我们容忍这些常见漂移。
 *
 * 任何非法 / 越界 / NaN 都返回 `null`。
 */
export function parseJudgeScore(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // Path 1: full JSON parse — happy path when model behaves.
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const score = extractScore(parsed);
    if (score !== null) return score;
  } catch {
    /* fall through to regex */
  }

  // Path 2: regex fallback for "score": <number> inside surrounding noise
  // (markdown fences, leading explanations, etc.).
  const match = /"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)/.exec(trimmed);
  if (match) {
    const score = Number(match[1]);
    return clampScore(score);
  }

  return null;
}

function extractScore(obj: Record<string, unknown>): number | null {
  const raw = obj.score;
  if (typeof raw !== 'number') return null;
  return clampScore(raw);
}

function clampScore(score: number): number | null {
  if (!Number.isFinite(score)) return null;
  if (score < 0 || score > 1) return null;
  return score;
}

// ─── Window stats (滑动窗口 + fallback 判定) ─────────────────────────

export interface AppendJudgeScoreParams {
  stats: SummaryReuseStats | undefined;
  score: number;
  windowSize: number;
  threshold: number;
}

export interface AppendJudgeScoreResult {
  /** 更新后的 stats 对象（永远是新对象，便于宿主感知 mutation）。 */
  stats: SummaryReuseStats;
  /** 是否触发 fallback（窗口满 + 平均分 < 阈值）；触发后窗口在内部已 reset。 */
  fallbackTriggered: boolean;
  /** 当前窗口平均分（达到 windowSize 时才有意义；否则返回最近窗口的实际均值）。 */
  averageScore: number;
}

/**
 * 把一次 judge 评分追加到 `reuseStats` 滑动窗口；窗口满到
 * `windowSize` 且平均分 < `threshold` 时把 `fallbackTriggered=true` 并 reset。
 *
 * 入参 `stats` 为 `undefined` 时自动初始化。**不会原地修改**入参，便于上游
 * 在事务失败时丢弃。
 */
export function appendJudgeScoreAndCheckFallback(
  params: AppendJudgeScoreParams,
): AppendJudgeScoreResult {
  const { score, windowSize, threshold } = params;
  const previous = params.stats ?? createEmptyReuseStats();

  const scores = [...previous.scores, score];
  // Cap at windowSize so we keep memory bounded.
  while (scores.length > windowSize) scores.shift();

  const averageScore =
    scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;

  const windowFull = scores.length >= windowSize;
  if (windowFull && averageScore < threshold) {
    return {
      stats: {
        scores: [],
        fallbackTriggered: true,
        consecutiveFailures: previous.consecutiveFailures,
      },
      fallbackTriggered: true,
      averageScore,
    };
  }

  return {
    stats: {
      scores,
      fallbackTriggered: false,
      consecutiveFailures: previous.consecutiveFailures,
    },
    fallbackTriggered: false,
    averageScore,
  };
}

/**
 * judge LLM 调用本身失败（返回 `null`）时记 `consecutiveFailures`——本期不消费
 * 该字段（PRD 没强约束行为），但留出口让未来策略接上"连续 N 次 judge 调用失败
 * 直接关掉采样窗口避免噪声"。
 *
 * 与 `appendJudgeScoreAndCheckFallback` 一样不原地修改入参。
 */
export function recordJudgeFailure(
  stats: SummaryReuseStats | undefined,
): SummaryReuseStats {
  const previous = stats ?? createEmptyReuseStats();
  return {
    scores: previous.scores,
    fallbackTriggered: previous.fallbackTriggered,
    consecutiveFailures: previous.consecutiveFailures + 1,
  };
}

export function createEmptyReuseStats(): SummaryReuseStats {
  return { scores: [], fallbackTriggered: false, consecutiveFailures: 0 };
}

/**
 * 决定本次是否要采样 judge。`Math.random()` < rate 即采样；rate <= 0 永不
 * 采样；rate >= 1 每次都采样（开发者调试用）。
 *
 * 抽出独立函数便于单测注入 / patch `Math.random`。
 */
export function shouldSampleJudge(rate: number, rng: () => number = Math.random): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return rng() < rate;
}

// 重新导出 helper 让 compact/index.ts 一处聚合
export type { LLMRequest, LLMResponseChunk };
