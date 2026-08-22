/**
 * Compact 路径——短兜底文案 + 占位 builder（资源化集中地）。
 *
 * SSoT 由本文件持有。来源：
 *   - `CHUNK_TOO_LARGE_MARKER`：旧 `compact/compact.ts:553` 的内联字符串；
 *   - `buildPrunePlaceholder`：旧 `compact/layered-prune.ts:94-96` 的私有函数
 *     （阶段 5.2 资源化搬入）；
 *   - emergency / soft-trim summary 三条：旧 `compact/auto-compact.ts:171/220/267`
 *     的内联兜底文案（阶段 5.2 资源化搬入）。
 * 按宪法 v0.1 §3.1（"极短文案 < 100 字符" / "动态 builder 函数"硬条件）资源化。
 *
 * 用途：compact 链路在 chunk 超限 / 分层裁剪 / 紧急硬裁剪 / 软裁剪兜底等路径下，
 * 用这些占位文案兜底拼回——让 LLM 与后续轮次知道这部分被压缩 / 跳过而不是
 * 静默丢失。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化；compact 链路整体中文化，见宪法 §3.6 修订）。
 */

/** chunkedCompact 单 chunk 自身仍超 token 上限时的兜底 marker。 */
export const CHUNK_TOO_LARGE_MARKER = '[区块过大无法摘要，已裁剪]';

/**
 * layered-prune 清空老 tool_use 输出后，填入 tool_result 的占位文案。
 * `toolName` 为空时回退到通用 'tool'。
 */
export function buildPrunePlaceholder(toolName: string): string {
  return `[已压缩：${toolName || 'tool'} 的输出已清除——仅保留最近的输出]`;
}

/**
 * emergency 路径：layered-prune 已释放足够空间、跳过 LLM 摘要时的 summary 文案。
 */
export function buildEmergencyLayeredPruneSummary(freedTokens: number): string {
  return `[紧急分层裁剪释放了约 ${freedTokens} tokens——已跳过 LLM 摘要]`;
}

/** emergency 硬裁剪后 LLM 摘要仍不可用时的兜底 summary。 */
export const EMERGENCY_HARD_TRIM_FALLBACK = '[紧急硬裁剪——LLM 摘要不可用]';

/** 普通路径 LLM 摘要失败、走 softTrim 兜底时的 summary。 */
export const SOFT_TRIM_FALLBACK = '[软裁剪兜底——LLM 摘要不可用]';
