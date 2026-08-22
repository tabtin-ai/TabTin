/**
 * Core Capability 共享工具函数 —— W2.2.1 三视角 Review (R2 P1) 抽取。
 *
 * **设计意图**：FileSystemCap / ShellCap 等 tool handler 共用：
 *   - 把错误信息打包成 ToolResult 的 JSON 错误包装
 *   - 把异常对象抠出 Node fs error code 给 LLM
 *
 * **下划线前缀 _utils**：与 capability/index.ts barrel 显式区隔——
 * 这些 helper **不是** Core Capability 的公共 API（不被宿主消费），仅
 * Cap 实现内部用。barrel 不 re-export 它们。
 */

import type {
  ToolResult,
} from '../../engine/contracts/tools.js';

/**
 * 把人类可读错误信息打包成 ToolResult 的"标准错误响应"。
 *
 * **L-25（W12 收口）**：所有 capability 错误返回都走本函数。`metadata`
 * 用于附加结构化字段（如 `errorCode` / `blocked_by` / `error_kind` /
 * `cwd` / `data` 等业务上下文），与 `error` 文案并列。LLM 通过解析
 * content 拿结构化信号；hosts / observability 拿一致 shape。
 *
 * **L-35（W13 收口）**：本函数不再仅是 capability 内部 helper —— `src/tools/`
 * 下的工具错误形态也被收口到同一构造方式（`{ content: JSON.stringify(...),
 * isError: true }` 散落写法全部消失）。tools/ 下从 `'../capability/core/_utils.js'`
 * import 本函数，与 capability 共用同一 shape。配套 `engine/error-kinds.ts`
 * 提供 `error_kind` 字面量集合，`tool-orchestration::extractToolErrorCode`
 * 把 metadata.error_kind 升格成 `agent.stream.tool` payload 顶层 `error_kind`。
 * 前端按 error_kind 走 `TOOL_ERROR_CATALOG` + i18n 翻译，把 raw envelope 变
 * 成语义化中文文案。
 *
 * **协议**（与全仓 capability 错误返回一致）：
 *   - `content` 是 JSON 字符串，最外层是 `{ success: false, ...metadata, error }`
 *   - `isError = true`
 *
 * 字段顺序：`success` → metadata → `error`。`error` 放最后兜底——避免
 * metadata 中含同名字段（误传）覆盖人类可读 message。
 *
 * **典型用法**：
 * ```ts
 * // 简单错误
 * return jsonError('Missing required path', {
 *   error_kind: MISSING_REQUIRED_PARAM,
 *   hint: 'Pass path before calling this tool.',
 * });
 *
 * // 携带业务码 / 业务字段
 * return jsonError('document was modified', {
 *   error_kind: VERSION_CONFLICT,
 *   hint: 'Re-read the document and retry with the latest version.',
 *   data: { latest_version: 7 },
 * });
 *
 * // 拦截理由 + pattern
 * return jsonError(`Command blocked by security policy: ${desc}`, {
 *   error_kind: COMMAND_BLOCKED_BY_POLICY,
 *   blocked_by: 'security_policy_hardline',
 *   pattern: hardlinePattern,
 *   description: desc,
 *   hint: 'Choose a non-destructive command or ask the user to perform this manually.',
 * });
 * ```
 */
export function jsonError(
  message: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return {
    content: JSON.stringify({
      success: false,
      ...(metadata ?? {}),
      error: message,
    }),
    isError: true,
  };
}

/**
 * 把异常对象转成可读字符串，保留 Node fs / spawn 的 error code 上下文。
 *
 * 典型 case：
 *   - `Error('no such file or directory')` + `code: 'ENOENT'`
 *     → `"[ENOENT] no such file or directory"`
 *   - 普通 Error → `error.message`
 *   - 非 Error（字符串 / Symbol / 数字）→ `String(err)`
 *
 * 让 LLM 看到结构化错误码方便它做"自我诊断"（如看到 ENOENT 就知道
 * 该 mkdir 父目录或换路径），不必依赖 grep error message 文本。
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  return String(err);
}
