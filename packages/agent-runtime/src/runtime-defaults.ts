/**
 * Browser-safe product defaults shared by runtime hosts and renderer UI.
 *
 * Keep this module free of Node-only imports. Renderer code imports it directly
 * to avoid pulling the agent-runtime root barrel into the browser bundle.
 */

/**
 * 启用「执行限制」时的推荐最大迭代轮数（UI 初值 / 建议值）。
 *
 * 与 UI「执行限制」推荐值及 Django `ExecutionProfile.max_iterations`
 * （conversational/task）对齐。
 *
 * ：本常量**不再**作为「未配置时引擎必套」的硬墙；未启用执行限制 /
 * 未显式传入 `maxTurns` 时引擎不限制轮次。
 */
export const DEFAULT_MAX_TURNS = 500;

/**
 * 启用「执行限制」时的推荐最大 credits 消费（UI 初值 / 建议值）。
 *
 * 与 UI「执行限制」推荐值及 Django
 * `ExecutionProfile.default_max_run_credits`（conversational=1000）对齐。
 *
 * ：本常量**不再**作为 CostCap「未配置必套」的硬墙；未启用执行限制 /
 * 未显式配置 `max_credits_per_run` 时不设 credits 墙。
 */
export const DEFAULT_MAX_CREDITS_PER_RUN = 1000;

/**
 * Context window 兜底值（tokens）——config.resolveContextWindow /
 * contextWindowTokens 均缺省时使用。#3945 自 query.ts 内部常量提出，
 * query.ts 与 hooks/context-overflow-recovery.ts 共享单一 SSoT。
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * PTL（prompt too long / 413）恢复阶段数：0=autoCompact, 1=truncateHead,
 * 2=hardTrim。值 = 阶段总数；`retryState.ptlRecoveryAttempts` 达到该值后
 * 恢复宣告失败（core 发 CONTEXT_OVERFLOW DONE）。#3945 自 query.ts 提出。
 */
export const MAX_413_RECOVERY_ATTEMPTS = 3;
