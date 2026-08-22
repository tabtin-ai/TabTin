/**
 * Tool Error — unified error construction for all "tool didn't run" scenarios.
 *
 * Every tool failure path in the runtime (unknown tool, schema reject, permission
 * deny, plan guard deny, abort, execute error) MUST produce a ToolResult via
 * `buildToolErrorResult`. The `<tool_use_error>` wrapper is the contract with the
 * model — it signals "this is a runtime error, not tool output" so the model can
 * self-correct on the next turn (follows our B1 §4.6).
 *
 * Consumers: tool-orchestration.ts, plan-mode-guard.ts, query.ts (pre-start catch).
 */

import type {
  ToolResultBlock,
} from '../contracts/conversation.js';
import type {
  ToolResult,
} from '../contracts/tools.js';

/**
 * Exhaustive error taxonomy — every "tool didn't run" scenario maps to exactly one kind.
 *
 * | Kind              | Trigger                                             |
 * |-------------------|-----------------------------------------------------|
 * | unknown_tool      | Model hallucinated a tool name not in the registry  |
 * | schema_invalid    | JSON Schema validation failed (strict mode)         |
 * | validate_input    | Business-semantic validation failed (future T-P2-1) |
 * | permission_denied | User / policy denied the tool call                  |
 * | plan_guard_deny   | Plan/Study/Ask mode guard rejected the call         |
 * | aborted           | AbortSignal fired (user cancel)                     |
 * | budget_skipped    | Budget grace period — tool execution skipped         |
 * | tool_timeout      | tool.execute() exceeded timeoutMs                   |
 * | execute_error     | tool.execute() threw (crash, etc.)                  |
 */
export type ToolErrorKind =
  | 'unknown_tool'
  | 'schema_invalid'
  | 'validate_input'
  | 'permission_denied'
  | 'plan_guard_deny'
  | 'aborted'
  | 'budget_skipped'
  | 'tool_timeout'
  | 'execute_error';

/**
 * Build a uniform error ToolResult with `<tool_use_error>` wrapper.
 *
 * The tag is deliberately XML-ish so the model treats the content as a structured
 * runtime signal rather than freeform tool output. All major LLM families
 * (Anthropic / OpenAI / Moonshot) parse this reliably in practice.
 *
 * Both `toolName` and `detail` are sanitized to prevent premature tag closure
 * (same class of issue as `tool-output-sanitizer.ts` fence wrapping).
 */
export function buildToolErrorResult(
  kind: ToolErrorKind,
  toolName: string,
  detail: string,
): ToolResult {
  const safeName = sanitizeForTag(toolName);
  const safeDetail = sanitizeForTag(detail);
  return {
    content: `<tool_use_error>\nkind: ${kind}\ntool: ${safeName}\n${safeDetail}\n</tool_use_error>`,
    isError: true,
  };
}

/**
 * Convenience wrapper: build a ToolResultBlock (API wire format) directly,
 * bundling the tool_use_id pairing in one call. Used by query.ts grace /
 * abort / catch paths where we need to push tool_result blocks into
 * state.messages rather than return a ToolResult to the orchestrator.
 */
export function buildToolErrorResultBlock(
  toolUseId: string,
  kind: ToolErrorKind,
  toolName: string,
  detail: string,
): ToolResultBlock {
  const { content } = buildToolErrorResult(kind, toolName, detail);
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    is_error: true,
  };
}

function sanitizeForTag(text: string): string {
  return text
    .replaceAll('<tool_use_error>', '&lt;tool_use_error&gt;')
    .replaceAll('</tool_use_error>', '&lt;/tool_use_error&gt;');
}
