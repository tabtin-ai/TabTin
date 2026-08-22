/**
 * Tool System — registry, sanitization, execution.
 *
 * Manages tool lifecycle: registration → input sanitization → execution
 * with timeout / cancellation. Converts Zod schemas to JSON Schema for
 * LLM consumption without external dependencies.
 */

import type {
  ContentBlock,
} from '../contracts/conversation.js';
import type {
  Tool,
  ToolProvider,
  ToolContext,
  ToolResult,
} from '../contracts/tools.js';
import {
  AgentError,
} from '../contracts/kernel.js';

// ─── Tool Registry ──────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  loadTools(provider: ToolProvider): void {
    for (const tool of provider.getTools()) {
      this.tools.set(tool.name, tool);
    }
  }

  async refreshTools(provider: ToolProvider): Promise<void> {
    if (provider.refreshTools) {
      await provider.refreshTools();
    }
    this.tools.clear();
    this.loadTools(provider);
  }

  findTool(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  /**
   * FR-08 — Lookup with `did_you_mean` suggestions.
   *
   * When `name` exists, returns it with an empty suggestions list (the
   * caller can short-circuit on `tool != null`). When it doesn't, the
   * registry computes:
   *
   *   1. **Common-name suggestion hit** — manually curated `TOOL_NAME_ALIASES` covers the
   *      most common LLM hallucinations we've seen in practice
   *      (`shell` → `run_terminal_command`, `google_search` → `web_search`, etc.).
   *      These aliases are suggestions for unknown-tool recovery, not registered
   *      current capabilities. Alias matches rank first because they encode intent rather
   *      than spelling. See `TOOL_NAME_ALIASES` below for the authoritative
   *      current map (W2.3 / W11 PRD 08 修订后的最新对照)。
   *   2. **Levenshtein top 3** — distance ≤ `max(2, ⌈len/5⌉)` against
   *      every registered name, sorted ascending. Deduped with alias
   *      hits.
   *
   * Suggestions are bounded to 3 items so the model gets a focused
   * `did_you_mean` payload, not a noisy long list. Empty array when
   * nothing came within the threshold — caller falls back to the
   * generic "Unknown tool" message.
   *
   * Performance: O(N · L²) where N = registered tools (≤ ~30 in
   * practice) and L = name length (≤ ~30). The whole lookup sits well
   * under 1 ms even on cold startups; FR-08 fires only on the unhappy
   * path (model hallucinated a tool name) which is rare to begin with,
   * so we don't bother caching distances.
   */
  findToolWithSuggestions(name: string): {
    tool: Tool | null;
    suggestions: string[];
  } {
    const exact = this.tools.get(name);
    if (exact) return { tool: exact, suggestions: [] };

    const trimmed = name.trim();
    const suggestions: string[] = [];

    // 1. Alias table — direct mapping wins.
    const aliasTarget = lookupAlias(trimmed);
    if (aliasTarget && this.tools.has(aliasTarget)) {
      suggestions.push(aliasTarget);
    }

    // 2. Levenshtein top 3 within threshold.
    const threshold = Math.max(2, Math.ceil(trimmed.length / 5));
    const ranked: Array<{ candidate: string; distance: number }> = [];
    for (const candidate of this.tools.keys()) {
      // Skip candidates we already added via alias table.
      if (suggestions.includes(candidate)) continue;
      const distance = levenshteinDistance(trimmed.toLowerCase(), candidate.toLowerCase());
      if (distance <= threshold) {
        ranked.push({ candidate, distance });
      }
    }
    ranked.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.candidate.localeCompare(b.candidate);
    });

    for (const { candidate } of ranked) {
      if (suggestions.length >= 3) break;
      suggestions.push(candidate);
    }

    return { tool: null, suggestions };
  }

  getToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  get size(): number {
    return this.tools.size;
  }

  /** Test/debug helper — list all registered tool names. */
  listToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

// ─── FR-08 Alias Table ──────────────────────────────────────────────
// Curated map of common LLM hallucinations → canonical tool names.
// This map only feeds `did_you_mean` suggestions after an unknown-tool miss;
// it does not register retired tool names as callable FCs.
// Always rank above Levenshtein hits because aliases encode *intent*.
//
// Maintenance: add an entry here when production telemetry shows the
// model repeatedly tries a non-existent name. Aliases are intentionally
// **target-name** based — if a target tool gets renamed, find/replace
// catches all aliases pointing at it. Conversely, multiple aliases can
// point at the same target (`shell` / `run_command` / `terminal`
// all → `run_terminal_command`).

const TOOL_NAME_ALIASES: Record<string, string> = {
  // run_terminal_command family
  // 命令类常见叫法都指向 `run_terminal_command` 这一实际注册的 canonical 工具名。
  shell: 'run_terminal_command',
  run_command: 'run_terminal_command',
  exec: 'run_terminal_command',
  terminal: 'run_terminal_command',
  execute_command: 'run_terminal_command',
  cat: 'run_terminal_command',

  // `cat` 指向 run_terminal_command（见上），不进 parse_document——模型用
  // `cat` 时几乎肯定是想"打印这个文件"，走终端更贴意图。
  read: 'read_file',
  file_read: 'read_file',
  write: 'write_file',
  file_edit: 'edit_file',
  file_write: 'write_file',
  file_delete: 'delete_file',
  grep: 'grep_search',
  code_grep: 'grep_search',
  code_glob: 'glob_search',
  // C13 (2026-05-13)：read_lints / read_diagnostics alias **删除**。
  //
  // 诊断现在走 attachment 被动注入（buildLspDiagnosticInjectorHook），LLM 主动
  // 调用工具的产品形态已弃用（dogfood 真实数据：本机 messages.jsonl 中调用 0 次）。
  //
  // 完全删除 alias（而非保留指向自身或其他工具）的理由：
  //   - 指向自身会让 findToolWithSuggestions 的 `tools.has(aliasTarget)` 守护失败，
  //     suggestions 还是空，等同于不写 alias
  //   - 指向 read_file 会误导（read_file 不是诊断工具）
  //   - 删除最干净，与既有约定 "完全没 read_lints 工具" 的形态完全对齐
  //
  // LLM 万一调到 read_lints 会拿明确的 "tool not found" 错误；它从 messages
  // 历史中的 `<new-diagnostics>` attachment 会自然学到"诊断已被自动注入，不需
  // 要主动查"。
  document_read: 'parse_document',
  system_relaunch_app: 'relaunch_app',
  system_clear_os_error_blacklist: 'clear_os_error_blacklist',
  read_document: 'read_file',
  read_pdf: 'read_file',

  // web_fetch family — Wave 4a (2026-05-01) 已删除：FC `web_fetch` 按 D4
  // 全删后，fetch / curl / browse / scrape 等模型可能想到的别名应**不再
  // 重定向到 FC**——Agent 抓静态正文走 `tabtin fetch <url>` /
  // 已打开 tab / JS 动态页走 `tabtin browser print --save <path>` 等 CLI；保留这些 alias
  // 反而会让 fuzzy match 把 LLM 调用拉回不存在的 web_fetch FC，触发 "tool
  // not found" 死循环。

  // web_search family
  search: 'web_search',
  google: 'web_search',
  google_search: 'web_search',
  bing_search: 'web_search',
  search_web: 'web_search',
  duckduckgo: 'web_search',

  // think 工具已于 Wave 4.5（2026-05-10）下线。
  // LLM 原生 thinking block 已 cover "内部反思"语义，故移除 reflect / reasoning / scratchpad 等
  // alias —— 保留它们会让 fuzzy match 把 LLM 调用拉回不存在的 think FC，触发 "tool not found"
  // 死循环。

  // todo family
  // 包含 `plan` 别名 — Wave 5 R1 复核（2026-05-10）回滚决策：
  //   harness 第一版 R1 把 `plan` 改向 `plan_create`，理由是 honest fail。
  //   独立 code-validator 反证（`agent-modes/contract.ts:96-141` +
  //   `ElectronToolProvider.ts:315-320`）：`plan_create` 仅在 plan/study
  //   模式注册，agent 模式（默认）调 `plan` → alias hit `plan_create`
  //   → target 未注册 → fuzzy match Levenshtein 距离也超阈值 → 返回
  //   "no close match exists" 真 dead end。旧行为 `plan → todo`
  //   在 agent 模式下要么 schema 匹配成功（LLM 实际想要 todo），要么
  //   schema 不匹配 fail（LLM 想要 plan_create 但模式不对）—— 两者都是
  //   honest fail，没有 silent corruption。回滚保留旧映射。
  //   未来若要按"模式分流 alias"（agent → todo，plan/study → plan_create），
  //   是 alias 系统架构升级，独立设计 + 评审，不在 R1 scope。
  todo: 'todo',
  todos: 'todo',
  plan: 'todo',
  update_todos: 'todo',
  set_todos: 'todo',

  // ask_question / ask_choice 是历史 alias，统一指向 ask_user（兼容 ask_choice 场景）。
  // 注意：ask_form 是真存在的工具，**不**在 alias 表里——LLM 直接调 ask_form 会走
  // 真实 execute 路径而不是 alias 引导。`request_approval`（ 下架）**不**做
  // alias——它的 schema（rationale / risk_level）与 ask_user 不同构，直接 alias 会
  // 撞 schema 校验；改走 tool-orchestration 的 LEGACY_ASK_NAMES 引导重发。
  ask_question: 'ask_user',
  ask: 'ask_user',
  ask_choice: 'ask_user',
  prompt_user: 'ask_user',
  user_input: 'ask_form', // 多字段输入意图 → ask_form 更合适

  // present_to_user family
  show: 'present_to_user',
  display: 'present_to_user',
  render: 'present_to_user',
  show_to_user: 'present_to_user',

  // W3 (2026-05-10): `summarize_context` / `retrieve_tool_result` aliases
  // removed alongside the tools themselves. Did_you_mean for `summarize` /
  // `condense` / `retrieve` / `get_tool_result` etc. would now point at
  // tools that no longer exist; LLM should rely on runtime auto-compact +
  // `read_file` for the file path printed in `<persisted-output>` banners.

  // agent (sub-agent) family
  spawn_agent: 'agent',
  delegate: 'agent',
  subagent: 'agent',
  sub_agent: 'agent',

  // common pluralisation / glob hallucinations
  // W2.3：run_terminal_command 路径接住所有 ls / find / glob 类的 LLM 幻觉。
  glob_files: 'run_terminal_command',
  find_files: 'run_terminal_command',
  list_files: 'run_terminal_command',
  ls: 'run_terminal_command',
};

function lookupAlias(name: string): string | null {
  if (!name) return null;
  const direct = TOOL_NAME_ALIASES[name];
  if (direct) return direct;
  const lower = TOOL_NAME_ALIASES[name.toLowerCase()];
  if (lower) return lower;
  return null;
}

/**
 * Classic dynamic-programming Levenshtein, two-row variant so memory is
 * O(min(a, b)) and worst-case CPU is O(a · b). No early-exit pruning —
 * the inputs we feed it are short tool names (length ≤ ~30) and the
 * registry has < ~30 tools, so the full DP runs in single-digit
 * microseconds. Add a distance-bound cutoff if either of those
 * assumptions changes (e.g. the registry grows past hundreds).
 *
 * Exported for testing; `findToolWithSuggestions` consumes via the
 * registry.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `a` is the shorter string so the row arrays stay small.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  let prev = new Array(a.length + 1);
  let curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,        // deletion
        curr[i - 1] + 1,    // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length];
}

/** Test / inspection helper — exposed so tests can audit the curated alias map. */
export function listToolAliases(): Record<string, string> {
  return { ...TOOL_NAME_ALIASES };
}

// ─── Unicode Sanitization ───────────────────────────────────────────
// Strips invisible / zero-width / bidi-override characters that could
// be used for prompt injection via tool inputs.
// Mirrors Django's apps.services.common.unicode_security module.

const INVISIBLE_BMP_RE = new RegExp(
  '[' +
    '\u00AD' +         // soft hyphen
    '\u034F' +         // combining grapheme joiner
    '\u061C' +         // Arabic letter mark
    '\u180E' +         // Mongolian vowel separator
    '\u200B-\u200F' +  // zero-width + LRM/RLM
    '\u202A-\u202E' +  // bidi embedding / override
    '\u2060-\u206F' +  // word joiner + invisible separators
    '\uFEFF' +         // BOM / ZWNBSP
  ']',
  'g',
);

const TAG_CHARS_RE = /[\u{E0001}-\u{E007F}]/gu;

export function sanitizeToolInput(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.replace(INVISIBLE_BMP_RE, '').replace(TAG_CHARS_RE, '');
  }
  if (Array.isArray(input)) {
    return input.map(sanitizeToolInput);
  }
  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = sanitizeToolInput(value);
    }
    return result;
  }
  return input;
}

// ─── Strip Internal Keys ────────────────────────────────────────────
// Tools can declare `llmStripKeys` to remove verbose/debug fields
// from the result before it enters the LLM context window.
// Mirrors Django's __llm_strip__ mechanism.
//
// Two key forms are supported:
//   1. **Top-level key** — e.g. `"_blocks"` deletes `parsed._blocks`.
//      Used by `present_to_user` (`['_blocks', '_title']`) and the
//      current `show_widget` (`['_block']`) to drop bulky payloads.
//   2. **Nested dot path** — e.g. `"_block.code"` deletes
//      `parsed._block.code` while keeping the rest of `_block`.
//      Reserved for callers that want to keep lightweight fields
//      (widget_id / kind / summary) visible to the LLM while
//      stripping only the heavyweight ones (SVG `code`, `image_url`).
//      Mirrors the dot-path syntax used by Django's
//      `__llm_strip__: ['_block.code', '_block.image_url']`.
//
// Widget Wave 2 added the nested form so future tools (and a Python
// `__llm_strip__` consumer when it lands) can opt into precise
// stripping without changing this contract again.

function stripNestedPath(obj: Record<string, unknown>, path: string[]): void {
  if (path.length === 0) return;
  if (path.length === 1) {
    delete obj[path[0]];
    return;
  }
  const head = path[0];
  const next = obj[head];
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    stripNestedPath(next as Record<string, unknown>, path.slice(1));
  }
}

export function stripKeysFromResult(result: ToolResult): string | ContentBlock[] {
  const { content, llmStripKeys } = result;
  if (!llmStripKeys || llmStripKeys.length === 0) return content;
  if (typeof content !== 'string') return content;

  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return content;
    }
    const cleaned = parsed as Record<string, unknown>;
    for (const key of llmStripKeys) {
      if (key.includes('.')) {
        stripNestedPath(cleaned, key.split('.'));
      } else {
        delete cleaned[key];
      }
    }
    return JSON.stringify(cleaned);
  } catch {
    return content;
  }
}

/**
 * Apply `llmStripKeys` to a tool result **before** budget enforcement /
 * truncation. Keeps `llmStripKeys` on the returned object so
 * `summarizeToolOutput` → `stripKeysFromResult` remains an idempotent no-op.
 *
 * UI / rich-content paths already emitted the full `content` during
 * `runTools`; this only shapes the LLM-facing copy.
 */
export function applyLlmStripKeys(result: ToolResult): ToolResult {
  if (result.llmContextContent !== undefined) return result;
  if (!result.llmStripKeys || result.llmStripKeys.length === 0) return result;
  const stripped = stripKeysFromResult(result);
  if (stripped === result.content) return result;
  return { ...result, content: stripped };
}

// ─── Execute Single Tool ────────────────────────────────────────────
// Wraps tool.execute() with input sanitization, timeout via
// Promise.race, and external AbortSignal forwarding.

export async function executeTool(
  tool: Tool,
  input: unknown,
  context: ToolContext,
  timeoutMs?: number,
): Promise<ToolResult> {
  const sanitizedInput = sanitizeToolInput(input);

  if (context.abortSignal.aborted) {
    throw new AgentError('Tool execution aborted', 'ABORT');
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(context.abortSignal.reason);
  context.abortSignal.addEventListener('abort', forwardAbort, { once: true });

  const executeContext: ToolContext = {
    ...context,
    abortSignal: controller.signal,
  };

  const executePromise = Promise.resolve().then(() => tool.execute(sanitizedInput, executeContext));

  if (!timeoutMs || timeoutMs <= 0) {
    try {
      return await executePromise;
    } finally {
      context.abortSignal.removeEventListener('abort', forwardAbort);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      executePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutError = new AgentError(
            `Tool '${tool.name}' timed out after ${timeoutMs}ms`,
            'TOOL_TIMEOUT',
            { toolName: tool.name, timeoutMs },
          );
          controller.abort(timeoutError);
          reject(
            timeoutError,
          );
        }, timeoutMs);

        onAbort = () => {
          if (timer !== undefined) clearTimeout(timer);
          controller.abort(context.abortSignal.reason);
          reject(new AgentError('Tool execution aborted', 'ABORT'));
        };
        context.abortSignal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) {
      context.abortSignal.removeEventListener('abort', onAbort);
    }
    context.abortSignal.removeEventListener('abort', forwardAbort);
  }
}

// Zod → JSON Schema conversion removed (B3 fix).
// Tool.inputSchema is now a plain JSON Schema object — no conversion needed.
