/**
 * ToolResult → 稳定 `error_kind` 提取（ review 修复，自
 * tool-orchestration.ts 原样搬出）。
 *
 * **为什么独立成模块**：`hooks/tool-loop-guard.ts` 需要它计 streak，但
 * tool-orchestration.ts 又 import query.ts（splitToolOutputFence 既有环）
 * ——从 hook 直接 import tool-orchestration 会把新 hook 模块接进
 * `query → default-policy-hooks → tool-loop-guard → tool-orchestration →
 * query` 的循环。与 budget-state-sync.ts / orphan-tool-results.ts 同一
 * 断环纪律：纯函数搬出，tool-orchestration re-export 保住既有 import 路径。
 */

import type {
  ToolResult,
} from '../contracts/tools.js';

/**
 * `<tool_use_error>` 包装中 `kind: <name>` 行的提取正则。
 *
 * `buildToolErrorResult`（`tool-error.ts`）写出的 content 形态：
 * ```
 * <tool_use_error>
 * kind: tool_timeout
 * tool: parse_document
 * <detail>
 * </tool_use_error>
 * ```
 *
 * `^kind: ` 用 `m` 标志锚定行首避免被 detail 内的 "kind: foo" 字面量误命中。
 * 字符集 `[a-z_]+` 与 ToolErrorKind / runtime 顶层 catalog kind 命名约定
 * 一致（snake_case + 字母）；不匹配则不识别。
 */
const TOOL_USE_ERROR_KIND_RE = /^kind: ([a-z_]+)\b/m;

/**
 * 从 ToolResult 提取稳定语义的 `error_kind` —— `agent.stream.tool` payload
 * 顶层 `error_kind` 字段 + stall detector streak 计数都用同一来源。
 *
 * Wave 3：只认
 *   1. `parsed.error_kind`（jsonError metadata 字面量）
 *   2. `<tool_use_error>` XML 形态的 `kind: <name>` 行
 *
 * 不再双读 numeric / string `error_code`（数字 TabcodeErrorCode 与
 * stream 伪 error_code 轨已删除）。
 */
export function extractToolErrorCode(result: ToolResult): string | undefined {
  if (!result.isError || typeof result.content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(result.content);
    const kind = parsed?.error_kind;
    if (typeof kind === 'string' && kind.length > 0) {
      return kind;
    }
  } catch {
    const xmlMatch = TOOL_USE_ERROR_KIND_RE.exec(result.content);
    if (xmlMatch && xmlMatch[1]) {
      return xmlMatch[1];
    }
  }
  return undefined;
}
