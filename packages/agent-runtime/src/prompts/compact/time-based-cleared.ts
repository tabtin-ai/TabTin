/**
 * Compact 路径——time-based microcompact 清理后填入 tool_result 的占位字符串。
 *
 * SSoT 由本文件持有。来源为旧 `compact/time-based-microcompact.ts:153` 的
 * `TIME_BASED_MC_CLEARED_MESSAGE` inline 常量；按宪法 v0.1 §3.1（"含 marker
 * 字符串"硬条件——time-based-microcompact 自身用相等比较检测幂等）资源化。
 *
 * **TIME_BASED_MC_CLEARED_MESSAGE 是单一 SSoT**：
 * - time-based-microcompact 用 `block.content === TIME_BASED_MC_CLEARED_MESSAGE`
 *   做幂等判定（已清理过的 block 不重复清理）；
 * - extractFileAttachments 的 PLACEHOLDER_PATTERNS 也认这个字符串作占位；
 * - 这个字符串**只能在本文件定义一次**——重复定义会让幂等判定漏掉变体。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化；本 marker 被 compact.ts PLACEHOLDER_PATTERNS
 * 正则 + time-based-microcompact === 幂等判定引用，中文化已同步两处，见宪法 §3.6 修订）。
 */

export const TIME_BASED_MC_CLEARED_MESSAGE = '[旧工具结果内容已清除]';
