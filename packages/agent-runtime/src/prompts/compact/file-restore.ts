/**
 * Compact 路径——压缩后注入文件内容 attachment 的 builder。
 *
 * SSoT 由本文件持有。来源为旧 `compact/compact.ts:738-742`
 * `injectFileAttachmentsIntoSummary` 内嵌的字符串拼装逻辑；
 * 按宪法 v0.1 §3.1（"动态 builder 函数"硬条件）资源化。
 *
 * 用途：Wave 8 设计——压缩后把"压缩前出现过的文件 read result"重新注入到
 * summary user message 末尾，让 Agent 不需要"压缩后第一件事是重新 read_file"
 * 才能继续工作。详见 `extractFileAttachments` 在 compact.ts 内的实现。
 *
 * 语言：中文（2026-05-20 决策 4 全中文化；header 是注入 marker，单点 SSoT）。
 */

/** Section header marker used by injection logic. */
const RESTORED_FILES_HEADER = '[已恢复的文件上下文——这些文件当时正在处理]';

export interface RestoredFileEntry {
  /** 绝对路径或相对路径。 */
  path: string;
  /** 文件被 read 还是 modified——在 header 里展示给 Agent。 */
  action: 'read' | 'modified';
  /** 文件内容（已截断到合适长度由调用方负责）。 */
  content: string;
}

/**
 * 拼接"压缩后恢复文件上下文"的 markdown 段。
 *
 * 输出结构：
 * ```
 *
 * ---
 *
 * [Restored file contexts — these files were being worked on]
 *
 * [<action>: <path>]
 * ```
 * <content>
 * ```
 *
 * [<action>: <path>]
 * ...
 * ```
 *
 * 调用方拿到字符串后插入到 summary user message 中（通常在
 * `RECENT_CONVERSATION_MARKER` 之前）。空数组返回空字符串——上游应自行短路。
 */
export function buildRestoredFileContext(attachments: RestoredFileEntry[]): string {
  if (attachments.length === 0) return '';

  const sections = attachments.map(
    (att) => `\n[${att.action}: ${att.path}]\n\`\`\`\n${att.content}\n\`\`\``,
  );

  return `\n\n---\n\n${RESTORED_FILES_HEADER}\n${sections.join('\n')}`;
}
