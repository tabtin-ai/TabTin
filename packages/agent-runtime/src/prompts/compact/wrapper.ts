/**
 * Compact 路径——压缩 summary 包装为 user message 的 builder + marker。
 *
 * SSoT 由本文件持有。来源为旧 `compact/compact.ts:251-280, 722` 中
 * `buildCompactedMessages` 的 summary 拼装逻辑 + `RECENT_CONVERSATION_MARKER`
 * inline 常量；按宪法 v0.1 §3.1（"含 marker 字符串"硬条件）资源化。
 *
 * **RECENT_CONVERSATION_MARKER 是单一 SSoT**：
 * - 文件 attachment 注入时通过 `String.includes(RECENT_CONVERSATION_MARKER)`
 *   判定插入位置；
 * - 这个字符串**只能在本文件定义一次**——重复定义会让 attachment 注入位置错位。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化；marker 单点 SSoT，中文化后
 * includes/replace 判定自动跟随；compaction-orchestrator.ts 影子复制已同步，见宪法 §3.6 修订）。
 */

/** Marker placed at the end of the summary user message; attachment injection looks for this. */
export const RECENT_CONVERSATION_MARKER = '\n\n[最近对话如下]';

/** 压缩 summary 的开头标识。 */
const SUMMARY_HEADER = '[对话摘要]';
const SUMMARY_FOOTER = '[摘要结束]';

/**
 * 拼装压缩 summary 为单条 user message 的字符串。
 *
 * 结构：
 * ```
 * [Conversation Summary]
 *
 * <summary>
 *
 * [End of summary]
 *
 * [可选] ---
 * Full conversation transcript: <transcriptPath>
 * Note: ...
 *
 * [Recent conversation follows]
 * ```
 *
 * 调用方拿到字符串后包成 `{ role: 'user', content }` 并与 messagesToKeep 拼接。
 */
export function buildCompactedSummaryWrapper(
  summary: string,
  transcriptPath?: string,
): string {
  let content = `${SUMMARY_HEADER}\n\n${summary}\n\n${SUMMARY_FOOTER}`;

  if (transcriptPath) {
    content += '\n\n---';
    content += `\n完整对话记录：${transcriptPath}`;
    content += '\n注：该文件为 JSONL 格式（每行一条记录），可能非常长。';
    content += '\n请用搜索工具查找特定内容，或用 offset/limit 分段读取。';
  }

  content += RECENT_CONVERSATION_MARKER;
  return content;
}

/**
 * 判定一条消息是否是压缩 summary（用于 attachment 注入位置定位）。
 * 调用方应在 user message 上检查 `content.includes(SUMMARY_HEADER_MARKER)`。
 */
export const SUMMARY_HEADER_MARKER = SUMMARY_HEADER;
