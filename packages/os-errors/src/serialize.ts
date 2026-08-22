/**
 * OSError → OSToolError 序列化（给 Agent / 后端用的精简形态）
 *
 * Agent 真正读的是 llm_message —— 一段自包含的自然语言：
 *   {userGuidance}
 *   ┄┄┄
 *   约束：
 *   - {agentDirective 1}
 *   - {agentDirective 2}
 *   ┄┄┄
 *   可建议的快捷链接：
 *   - {label}: {deepLink}
 *
 * 这套格式已经在多个 LLM 上验证可读性 OK：分段清晰、不依赖 markdown 渲染、
 * 在系统/工具结果框里显示成等宽时仍然是合理的层次结构。
 */

import type { OSError, OSToolError } from './types.js';

/** 把 OSError 渲染成给 Agent 看的单段自然语言。 */
export function renderForAgent(err: OSError): string {
  const lines: string[] = [];
  // 头行加 platform（Wave 1 第二轮 Review S-8/顺-9）—— 让 LLM 不必从 userGuidance
  // 文字里 NLP 推断"这是 macOS 还是 Windows 的错误"，可结构化分支决策（如不要
  // 在 Linux 上提"系统设置"等 macOS 专有词）。
  lines.push(
    `[OS_ACCESS_ERROR] code=${err.code} category=${err.category} platform=${err.platform} path=${err.path}`,
  );
  lines.push('');
  lines.push(err.userGuidance);

  if (err.agentDirectives.length > 0) {
    lines.push('');
    lines.push('约束：');
    for (const d of err.agentDirectives) lines.push(`- ${d}`);
  }

  const linkActions = err.recoveryActions.filter((a) => !!a.deepLink);
  if (linkActions.length > 0) {
    lines.push('');
    lines.push('可建议的快捷链接：');
    for (const a of linkActions) lines.push(`- ${a.label}: ${a.deepLink}`);
  }

  return lines.join('\n');
}

/** 序列化成 IPC / HTTP 传输的 JSON 形态，跨进程时用。 */
export function toToolError(err: OSError): OSToolError {
  return {
    code: err.code,
    category: err.category,
    platform: err.platform,
    path: err.path,
    terminal: err.terminal,
    llm_message: renderForAgent(err),
    raw_detail: err.rawDetail,
  };
}

/** 反向：从 IPC 收到的 JSON 还原出最小可用的 OSError。 */
export function fromToolError(json: OSToolError): OSError {
  return {
    code: json.code,
    category: json.category,
    platform: json.platform,
    path: json.path,
    terminal: json.terminal,
    rawDetail: json.raw_detail,
    // 注意：IPC 反序列化后 userGuidance / agentDirectives / recoveryActions 不再可用，
    // 因为 llm_message 是单字段——但这正是设计意图：跨进程只传"该怎么告诉 Agent"
    // 这一段，不传内部结构。如需重新渲染请在生成端做。
    userGuidance: json.llm_message,
    agentDirectives: [],
    recoveryActions: [],
  };
}
