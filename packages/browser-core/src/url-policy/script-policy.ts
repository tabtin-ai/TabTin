/**
 * 脚本安全策略 — Agent 执行脚本的受限 API 检测
 *
 * 从 Electron content-ops.ts 提取的黑名单模式，跨端统一。
 * 阻止 Agent 通过 executeScript 访问 cookie/localStorage/sessionStorage/indexedDB。
 */

const BLOCKED_SCRIPT_PATTERNS: readonly RegExp[] = [
  /document\.cookie/i,
  /localStorage\s*\.\s*(getItem|setItem|removeItem|clear)/i,
  /sessionStorage\s*\.\s*(getItem|setItem|removeItem|clear)/i,
  /indexedDB/i,
];

/**
 * 检查脚本是否包含受限浏览器存储 API 调用。
 * 两端的 executeScript 入口均应调用此函数。
 */
export function isBlockedScript(script: string): boolean {
  return BLOCKED_SCRIPT_PATTERNS.some((p) => p.test(script));
}

export { BLOCKED_SCRIPT_PATTERNS };
