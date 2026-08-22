/**
 * BudgetTracker → EngineState 用量同步（ 自 query.ts 原样搬出）。
 *
 * query.ts（usage chunk / grace 收尾）与 hooks/context-overflow-recovery.ts
 * （compact usage 记账）共用——逻辑零改动，只解 hook → query 循环 import。
 */

import type {
  EngineConfig,
  EngineState,
} from '../contracts/kernel.js';
import type { BudgetTracker } from './budget-tracker.js';

/**
 * IterationBudget token 分子。
 *
 * - 子 Agent（有 `budgetScope`）：读 per-scope 累计，与 `syncStateFromTracker`
 *   / CostCap 同口径，避免父/兄弟全树用量误杀子 run。
 * - 根 query：读已 sync 的 `state` 本 run 增量（勿再读 tracker 全树）。
 */
export function getTotalTokensSoFar(
  state: EngineState,
  tracker?: BudgetTracker,
  budgetScope?: string,
): number {
  if (tracker && budgetScope) {
    const acc = tracker.getUsageByScope(budgetScope);
    return acc.inputTokens + acc.outputTokens;
  }
  return state.totalInputTokens + state.totalOutputTokens;
}

/**
 * Wave 3: 从 BudgetTracker 同步完整 8 字段到 EngineState。
 * 子 Agent（有 budgetScope）用 per-scope 累计，根 query 用全树累计。
 * 返回 true 表示成功同步，false 表示无 tracker（调用方自行 fallback 旧逻辑）。
 *
 *  批次 12：参数收窄为 budgetTracker / budgetScope 二字段——策略 hook
 * 侧（context-overflow-recovery）不再持整个 EngineConfig，传 EngineConfig
 * 的调用点（model-stream 等）结构兼容不受影响。
 */
export function syncStateFromTracker(
  state: EngineState,
  config: Pick<EngineConfig, 'budgetTracker' | 'budgetScope'>,
): boolean {
  // 子 query（有 budgetScope）：per-scope 累计，childId 天然 per-run，直接用。
  if (config.budgetScope) {
    const acc = config.budgetTracker?.getUsageByScope(config.budgetScope);
    if (!acc) return false;
    state.totalInputTokens = acc.inputTokens;
    state.totalOutputTokens = acc.outputTokens;
    state.totalCacheReadTokens = acc.cacheReadTokens;
    state.totalCacheCreationTokens = acc.cacheCreationTokens;
    state.totalReasoningTokens = acc.reasoningTokens;
    state.compactInputTokens = acc.compactInputTokens;
    state.compactOutputTokens = acc.compactOutputTokens;
    state.creditsCharged = acc.credits;
    return true;
  }

  // 根 query：getAccumulated() 是 per-runtime 累计（跨 turn 单调递增）。减去本
  // run 起始基线（_budgetRunBaseline），得到「本 run 增量」，使 DONE.usage 回归
  // per-run 语义（方案A ）。基线缺省（旧 host / 复用旧 runtime 未写入）时
  // 退化为 0，行为与历史一致（累计值），不致硬失败。
  const acc = config.budgetTracker?.getAccumulated();
  if (!acc) return false;
  const base = state._budgetRunBaseline;
  const delta = (cur: number, b: number | undefined): number => Math.max(0, cur - (b ?? 0));
  state.totalInputTokens = delta(acc.inputTokens, base?.inputTokens);
  state.totalOutputTokens = delta(acc.outputTokens, base?.outputTokens);
  state.totalCacheReadTokens = delta(acc.cacheReadTokens, base?.cacheReadTokens);
  state.totalCacheCreationTokens = delta(acc.cacheCreationTokens, base?.cacheCreationTokens);
  state.totalReasoningTokens = delta(acc.reasoningTokens, base?.reasoningTokens);
  state.compactInputTokens = delta(acc.compactInputTokens, base?.compactInputTokens);
  state.compactOutputTokens = delta(acc.compactOutputTokens, base?.compactOutputTokens);
  state.creditsCharged = delta(acc.credits, base?.credits);
  return true;
}
