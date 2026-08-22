/**
 * Compact 路径——极短 inline ack 文案。
 *
 * SSoT 由本文件持有。来源为旧 `compact/compact.ts` 多处用到的内联字符串：
 *   - `'Continuing.'`（compact.ts:230, 608, 1048）
 *   - `'Understood. Continuing from recent context.'`（compact.ts:277）
 *
 * 按宪法 v0.1 §3.1（必须 inline 在 .ts 的硬条件之"极短文案 < 100 字符"）资源化。
 *
 * 用途：拼装 LLM 调用消息时维持 user/assistant role alternation——当被压缩
 * 段最末是 user 消息时插入 `CONTINUING_ACK`，buildCompactedMessages 在 summary
 * 与 messagesToKeep 之间插入 `UNDERSTOOD_ACK` 维持 role alternation。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化；这些 ack 注入到 assistant role，
 * 按决策 4 统一中文，见宪法 §3.6 修订）。
 */

/** 拼装压缩调用消息时的临时 assistant 占位文本，用于 user role 后强制插入空 assistant。 */
export const CONTINUING_ACK = '继续。';

/** buildCompactedMessages 插入 summary 后的 assistant ack，维持 role alternation。 */
export const UNDERSTOOD_ACK = '明白，从最近的上下文继续。';
