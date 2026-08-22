/**
 * FR-03 — Unified Message Normalization entry point.
 *
 * Runs once per ReAct iteration — after `enforceMessageSizeBudget`
 * (FR-04) and right before `llmRequest.messages` is constructed — to
 * guarantee structural correctness of the conversation array that
 * finally reaches the LLM. Without a single normalization choke point
 * subtle invariant violations (orphan `tool_use` / consecutive
 * `user` turns / thinking-only assistant messages) leak through micro
 * compact + reactive compact + FR-04 truncation and produce opaque
 * API 400s that users see as "the agent just broke for no reason".
 *
 * ### Scope
 *
 * **In scope** (structural, no LLM call):
 *   1. `validateToolPairing` — every `tool_use` has a matching
 *      `tool_result` (extracted from `compact.ts`, now public so the
 *      compact path and the main loop share one definition).
 *   2. `repairOrphanToolCalls` — drop `tool_result` blocks whose
 *      `tool_use` is gone (safe); insert synthetic
 *      `[Tool result missing due to internal error]` for `tool_use`
 *      blocks that never got a matching `tool_result` (otherwise the
 *      API rejects the whole turn).
 *   3. `filterOrphanedThinkingOnlyMessages` — drop assistant
 *      messages that carry only `thinking` blocks. Anthropic rejects
 *      thinking-only turns; they typically appear when compaction
 *      slices away the text/tool_use sibling between a failed stream
 *      and its retry.
 *   4. `mergeConsecutiveMessages` — fold neighbouring same-role
 *      messages into one. Runtimes that proxy to Bedrock-style
 *      backends hard-fail on `user, user` pairs; the Proxy itself is
 *      lenient but downstream cache-key logic gets confused when the
 *      same turn spans two entries.
 *   5. `ensureNonEmptyContent` (conservative cleanup) — after block
 *      stripping any message whose content went empty is dropped.
 *      Prevents "assistant: []" 400s from `role must not be empty`.
 *
 * **Out of scope**:
 *   - LLM summarisation (`compact.ts`).
 *   - Token budget enforcement (`FR-04 enforceMessageSizeBudget` /
 *     `auto-compact`).
 *   - Unicode cleanup of tool inputs (`sanitizeToolInput`, tool layer).
 *   - System prompt handling (`query.ts` + `H1-A` owned).
 *
 * ### Levels
 *
 * `off`            — skip structural cleanup, but still run
 *                    agent-profile keep-latest (LLM product gate).
 * `conservative`   — default; steps 1–5 above. Every step is
 *                    structurally safe (never changes semantic content,
 *                    only removes API-illegal shapes).
 * `full`           — `conservative` + two experimental cleanups:
 *                      (a) `filterWhitespaceOnlyAssistantMessages` —
 *                          drop assistant messages whose every text /
 *                          thinking block is whitespace-only.
 *                      (b) `stripTrailingThinkingFromLastAssistant` —
 *                          strip a lone trailing thinking block from
 *                          the tail assistant. (Some providers reject
 *                          tool-use turns that end on a bare thinking
 *                          signature that's no longer reproducible in
 *                          the next call.)
 *
 * ### Design invariants
 *
 * - **Pure**. Does not emit telemetry, does not mutate input.
 *   The caller (`query.ts`) inspects `changes` and emits
 *   `TelemetryEvents.MESSAGE_NORMALIZED` only when something was
 *   actually rewritten, keeping noise off the dashboard.
 * - **Spread-preserving**. `{ ...prev, content: ... }` is used when
 *   merging, so any future `Message` fields (e.g. `id`, `timestamp`)
 *   from the first-in-pair survive. `Message` today only has
 *   `role` + `content`, but this is cheap insurance for forward
 *   compatibility (per PRD FR-03 wording "保留 message.id").
 * - **Idempotent**. Running `normalizeMessages` twice on the same
 *   input yields the same output with `hasAnyChange(changes) === false`
 *   on the second pass. Tests lock this property.
 */

import type {
  ContentBlock,
  InternalMessageMarker,
  Message,
  NormalizationLevel,
  ToolResultBlock,
  ToolUseBlock,
} from '../contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '../contracts/conversation.js';

// Re-export from types.ts (SSoT) so consumers can `import { NormalizationLevel }`
// from this module for co-located ergonomics, without introducing a second
// definition. See `engine/AGENTS.md` "共享契约".
export type { NormalizationLevel };

export const DEFAULT_NORMALIZATION_LEVEL: NormalizationLevel = 'conservative';

/**
 * Content of the synthetic `tool_result` inserted by
 * `repairOrphanToolCalls` when an assistant `tool_use` has no matching
 * `tool_result`. Kept exported so the compact path / validation code
 * can recognise it (e.g. to avoid re-repairing what we already repaired).
 * Matches the canonical unpaired-tool-result placeholder string.
 */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]';

export interface NormalizeChanges {
  /** Pairs of adjacent user messages that were folded into one. */
  merged_user: number;
  /** Pairs of adjacent assistant messages that were folded into one. */
  merged_assistant: number;
  /** Number of `tool_use` blocks that got a synthetic error `tool_result`. */
  orphan_tool_use_fixed: number;
  /** Number of `tool_result` blocks whose `tool_use` was missing, so the block was dropped. */
  orphan_tool_result_fixed: number;
  /** Number of assistant messages whose entire content was thinking-only and got dropped. */
  thinking_filtered: number;
  /** Number of messages whose content became empty after block-level stripping and got dropped. */
  empty_dropped: number;
  /** Number of assistant messages whose every block was whitespace-only and got dropped (full only). */
  whitespace_dropped: number;
  /** 1 if a trailing thinking block was stripped from the last assistant, else 0 (full only). */
  trailing_thinking_stripped: number;
  /** Number of remaining pairing violations after normalization — 0 is the happy path. */
  pairing_violations: number;
  /**
   * ：丢弃的较旧 agent-profile 条数（历史多份 / 历史+本轮 fresh 并存时
   * 只留最新一份）。计入 hasAnyChange，避免「只丢 profile」时写回被跳过。
   */
  agent_profile_dropped: number;
}

function emptyChanges(): NormalizeChanges {
  return {
    merged_user: 0,
    merged_assistant: 0,
    orphan_tool_use_fixed: 0,
    orphan_tool_result_fixed: 0,
    thinking_filtered: 0,
    empty_dropped: 0,
    whitespace_dropped: 0,
    trailing_thinking_stripped: 0,
    pairing_violations: 0,
    agent_profile_dropped: 0,
  };
}

export interface NormalizeOptions {
  /** Defaults to `'conservative'`. `'off'` 跳过结构清理，仍做 agent-profile keep-latest。 */
  level?: NormalizationLevel;
  /**
   * Optional logger for anomaly warnings (e.g. deep repair applied).
   * Never called on the happy path. Kept optional so pure unit tests
   * don't need to stub it.
   */
  logger?: { warn(message: string): void };
}

export interface NormalizeResult {
  messages: Message[];
  changes: NormalizeChanges;
}

/**
 * Returns true iff `changes` describes any actual rewrite **or** leaves
 * residual pairing violations worth surfacing.
 *
 * `pairing_violations > 0` is included so that a corrupt input that
 * could not be repaired (e.g. tool_result whose tool_use was also
 * synthesised in the same round) still triggers telemetry — otherwise
 * the main loop's "emit only when something changed" gate would
 * swallow it and leave operators in the dark.
 */
export function hasAnyChange(changes: NormalizeChanges): boolean {
  return (
    changes.merged_user > 0 ||
    changes.merged_assistant > 0 ||
    changes.orphan_tool_use_fixed > 0 ||
    changes.orphan_tool_result_fixed > 0 ||
    changes.thinking_filtered > 0 ||
    changes.empty_dropped > 0 ||
    changes.whitespace_dropped > 0 ||
    changes.trailing_thinking_stripped > 0 ||
    changes.pairing_violations > 0 ||
    changes.agent_profile_dropped > 0
  );
}

// ─── validateToolPairing (extracted from compact.ts) ─────────────────

/**
 * Shared scan that produces the minimum state needed for both
 * `validateToolPairing` (boolean) and `countPairingViolations`
 * (number). Kept internal — consumers should pick the wrapper that
 * matches their call site.
 *
 * **Known limitation**: duplicate `tool_use` ids are collapsed into
 * one entry by the `Set`. If the same id appears twice in distinct
 * assistant turns, the API's "tool_use_id must be unique" 400 is not
 * surfaced by this check. Tracked as a potential extension — adding
 * dup detection here would catch more 400s at the cost of making a
 * simple happy-path check O(n) memory for the same bucket. Deferred
 * until real dup-id incidents are observed in telemetry.
 */
function collectToolPairingState(messages: Message[]): {
  violations: number;
} {
  const useIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') useIds.add(block.id);
      if (block.type === 'tool_result') resultIds.add(block.tool_use_id);
    }
  }

  let violations = 0;
  for (const id of resultIds) if (!useIds.has(id)) violations++;
  for (const id of useIds) if (!resultIds.has(id)) violations++;
  return { violations };
}

/**
 * Every `tool_use` id has a matching `tool_result.tool_use_id`, and
 * vice versa. Identical semantics to the previously private
 * `validateToolPairing` in `compact.ts` (which now re-exports this
 * implementation so both paths share one definition).
 */
export function validateToolPairing(messages: Message[]): boolean {
  return collectToolPairingState(messages).violations === 0;
}

/**
 * Count raw pairing violations. Distinct from `validateToolPairing`
 * which is boolean — this lets the normalizer surface the remaining
 * count via `NormalizeChanges.pairing_violations`.
 */
function countPairingViolations(messages: Message[]): number {
  return collectToolPairingState(messages).violations;
}

// ─── mergeConsecutiveMessages ────────────────────────────────────────

/**
 * 判断一条 user message 的"语义类别"——用于跨轮 / 跨 hook 的 user 误合并保护
 * （见 `mergeConsecutiveMessages` 函数注释里的 dogfood bug 复现路径）。
 *
 * - `tool_result_only`（W4.3）：content 是数组且**全部** block 都是 tool_result
 *   家族（`tool_result` / `server_tool_result` / `mcp_tool_result`）。
 *   工具执行结果消息——是 LLM 工具调用的语义回执，不是用户输入。
 * - `context_injection`（W4.3.2）：带 `INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION`
 *   marker 的 user message——由 `hooks/context-injector.ts` 在每轮 beforeIteration
 *   prepend 到 state.messages。它跟用户真实输入语义截然不同，合并后 LLM 会把
 *   "<context>...</context>" 跟下一条用户文本拼成一条 user message，触发
 *   "用户同时请求两件事"误解（dogfood W4 第二轮 thinking 显形 bug）。
 * - `continuation`（W4.3.2）：带 `INTERNAL_MESSAGE_MARKERS.CONTINUATION` marker 的
 *   user message——由 `query.ts` max_tokens 截断 continuation 路径补出（"Continue
 *   exactly..."）。它是引擎自己塞给 LLM 让它接续输出的指令，不是用户意图，跟
 *   下一轮用户真正的 user 不能合并。
 * - `memory_recall`（阶段 6 议题 2）：带 `INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION`
 *   的 user message——由 `hooks/memory-injector.ts` 每轮注入 `<context type="memory-recall">`
 *   召回包。语义上是引擎自动加料而非用户输入，跟相邻真用户 user 合并会让 LLM
 *   把召回的 memo 误解为用户当前请求的一部分。
 * - `lsp_diagnostics`（阶段 6 议题 2）：带 `INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION`
 *   的 user message——edit/write_file 后下一轮注入的 `<system-reminder><new-diagnostics>...`
 *   或新形态 `<context type="lsp-diagnostic">`。注入时机紧贴下次 LLM call，跟用户输入合并
 *   会让 LLM 误以为"用户正在汇报代码错误"，但实际是 runtime 自动收集的诊断。
 * - `tool_eviction_notice`（阶段 6 议题 2）：带 `INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE`
 *   的 user message——`query.ts` 在 `dynamicToolManager.evictStale` 触发时 push 的
 *   `[system] 以下工具已因长时间未使用被自动回收` notice。dogfood W4 撞过的 P0 同型
 *   契约漏洞（旧实现完全无 marker，归入 'other' 兜底）。
 * - `mode_reminder`（Phase 2）：带 `INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION`
 *   的 user message——`hooks/mode-reminder-injector.ts` 每轮注入 ask/plan sparse
 *   reminder。跟相邻真用户 user 合并会让 LLM 把模式约束误解为用户新指令（W4 同型）。
 * - `mode_transition_reminder`（Phase 3）：带 `INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER`
 *   的 user message——`hooks/mode-reminder-injector.ts` 在用户批准 switch_mode 退出
 *   plan 后于下一轮 iteration 0 **一次性**注入，紧挨最后一条真实 user message 之后。
 *   历史 bug（2026-05-29 修）：本 marker 漏注册 → 落 'other' → 跟相邻真用户输入合并，
 *   且 `query.ts` 写回 state.messages 永久污染历史、reminder 永不消失。与 dogfood
 *   W4 P0 同型。修复即本分支。
 * - `project_rules`（AGENTS.md MVP）：带 `INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION`
 *   的 user message——`hooks/rules-injector.ts` 每轮注入工作目录根部 `AGENTS.md`
 *   渲染的 `<project_rules>` 段（unshift 到 messages 最前）。语义是"跟着代码库走的
 *   项目规约"而非用户输入，跟相邻真用户 user 合并会让 LLM 把规约误当用户当前请求。
 * - `other`：上述都不是的 user message——string content / 普通用户文本 /
 *   混合内容（含 text + tool_result 等）。代表用户的真实输入。
 *
 * **检测顺序**：marker 优先（强检测），再看 tool_result-only（结构性检测）。
 * marker 是 hook / engine 私有约定，比 content 启发式更稳。所有 marker 互斥
 * （任何 hook 不该同时打两个），实现按 CONTEXT_INJECTION → MEMORY_INJECTION
 * → LSP_DIAGNOSTICS_INJECTION → TOOL_EVICTION_NOTICE → MODE_REMINDER_INJECTION
 * → MODE_TRANSITION_REMINDER → PROJECT_RULES_INJECTION → CONTINUATION 顺序检测——
 * 若未来真出现 marker 同时存在，按前者优先（实际上更早的 hook 顺序）。
 *
 * **机器约束（2026-05-29）**：本函数必须覆盖 `INTERNAL_MESSAGE_MARKERS` 里每一个
 * "注入合成 user message" 的 marker。`tests/engine-message-normalizer.test.ts` 的
 * "marker 注册契约" 用例会遍历全集断言无遗漏——新增 marker 漏注册即 CI 红，
 * 把"靠人记注释"升级为"机器拦截"（根治 mode_transition_reminder / tool_eviction 这类反复漏注册）。
 *
 * **维护契约（W4.3.2 三视角 review P1-2 + 阶段 6 议题 2 收口）**：凡向
 * `state.messages` 注入「合成 user message」（即 role === 'user' 但内容不来自
 * 人类输入）的路径——hook / continuation / tool eviction / 未来某种重试逻辑——
 * 都必须登记到 `UserMessageKind`：要么扩 `INTERNAL_MESSAGE_MARKERS` + 在创建处
 * `setInternalMarker`，要么补结构检测分支。否则会落到 `'other'` 兜底，
 * 跟相邻真用户 user 仍判同 kind 被合并——重蹈 dogfood W4 第二轮 P0 覆辙。
 *
 * 这是私有判定函数，仅 mergeConsecutiveMessages 用。
 */
type UserMessageKind =
  | 'tool_result_only'
  | 'context_injection'
  | 'memory_recall'
  | 'agent_profile'
  | 'lsp_diagnostics'
  | 'tool_eviction_notice'
  | 'mode_reminder'
  | 'mode_transition_reminder'
  | 'active_todos'
  | 'todo_completion_nudge'
  | 'project_rules'
  | 'relevant_recall'
  | 'continuation'
  | 'tool_injected'
  | 'other';

/** Exported for hooks that need merge-safe user classification (e.g. mode-reminder-injector). */
export function classifyUserMessageForMerge(msg: Message): UserMessageKind {
  return classifyUserMessage(msg);
}

function classifyUserMessage(msg: Message): UserMessageKind {
  // 1. marker 检测（W4.3.2 + 阶段 6 议题 2）：marker 是 hook / engine 私有约定，
  //    比 content 启发式更稳。任何带 marker 的 user message 都跟普通 user 不同
  //    语义，后续 mergeConsecutiveMessages 用 "kind 不同 → 不合并" 一条规则保护。
  const markerKind = classifyUserMessageByMarker(msg);
  if (markerKind) return markerKind;

  // 2. 结构检测（W4.3）：tool_result-only 跟普通用户输入语义不同。
  if (typeof msg.content === 'string') return 'other';
  if (msg.content.length === 0) return 'other';
  for (const block of msg.content) {
    const t = (block as { type?: string }).type;
    if (
      t !== 'tool_result' &&
      t !== 'server_tool_result' &&
      t !== 'mcp_tool_result'
    ) {
      return 'other';
    }
  }
  return 'tool_result_only';
}

const USER_MESSAGE_MARKER_KINDS: Array<{
  marker: InternalMessageMarker;
  kind: UserMessageKind;
}> = [
  { marker: INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION, kind: 'context_injection' },
  // ：历史里已落库的 environment context 块——与 fresh CONTEXT_INJECTION 同
  // 语义（都是 context wrapper），归同一 kind 防止与相邻真 user 合并。
  { marker: INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT, kind: 'context_injection' },
  { marker: INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION, kind: 'memory_recall' },
  { marker: INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION, kind: 'agent_profile' },
  // ：历史落库重建的 agent-profile——与 fresh 同 kind，防止与相邻真 user 合并
  // （漏登记会拼成「用户话\\n\\n<context type="agent-profile">」，keep-latest 也识别失败）。
  { marker: INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE, kind: 'agent_profile' },
  { marker: INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION, kind: 'lsp_diagnostics' },
  { marker: INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE, kind: 'tool_eviction_notice' },
  { marker: INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION, kind: 'mode_reminder' },
  { marker: INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER, kind: 'mode_transition_reminder' },
  { marker: INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION, kind: 'active_todos' },
  { marker: INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE, kind: 'todo_completion_nudge' },
  { marker: INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION, kind: 'project_rules' },
  // ：相关能力召回块（`<relevant_*>`）从 context-injector 拆出为独立 fresh 块。
  { marker: INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION, kind: 'relevant_recall' },
  { marker: INTERNAL_MESSAGE_MARKERS.CONTINUATION, kind: 'continuation' },
  { marker: INTERNAL_MESSAGE_MARKERS.TOOL_INJECTED, kind: 'tool_injected' },
];

function classifyUserMessageByMarker(msg: Message): UserMessageKind | null {
  for (const entry of USER_MESSAGE_MARKER_KINDS) {
    if (hasInternalMarker(msg, entry.marker)) return entry.kind;
  }
  return null;
}

/** 取首段 text（避免依赖 injection-position，防循环 import）。 */
function firstTextFromMessage(msg: Message): string | null {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return null;
  for (const block of msg.content) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}

/**
 * ：识别 runtime Message 上的 agent-profile（fresh / 历史 marker，或 content 兜底）。
 */
export function isAgentProfileRuntimeMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false;
  if (hasInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION)) return true;
  if (hasInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE)) return true;
  const text = firstTextFromMessage(msg);
  if (!text) return false;
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<context type="agent-profile"')
    || trimmed.startsWith("<context type='agent-profile'")
  );
}

/**
 * ：最终发给 LLM 的 messages 里多份 agent-profile 只留最新一份。
 *
 * 覆盖：历史多份、以及「历史最新 + 本轮 fresh 再注入」并存。须在
 * `mergeConsecutiveMessages` **之前**调用，避免两条同 kind 的 profile 先被合并
 * 成一条后再无法按条丢弃。
 */
export function keepLatestAgentProfileRuntimeMessages(
  messages: Message[],
): { messages: Message[]; dropped: number } {
  let latestIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (isAgentProfileRuntimeMessage(messages[i]!)) latestIndex = i;
  }
  if (latestIndex < 0) return { messages, dropped: 0 };

  const out: Message[] = [];
  let dropped = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (isAgentProfileRuntimeMessage(messages[i]!) && i !== latestIndex) {
      dropped += 1;
      continue;
    }
    out.push(messages[i]!);
  }
  return { messages: out, dropped };
}

/**
 * Fold adjacent same-role messages into one.
 *
 * Merge semantics:
 *   - string + string   → `"first\n\nsecond"`
 *   - array  + array    → concatenated
 *   - string + array    → `[TextBlock(first), ...second]`
 *   - array  + string   → `[...first, TextBlock(second)]`
 *
 * **W4.3 / W4.3.2 跨语义 user 合并保护**（dogfood W4 第二/三轮 thinking
 * "用户同时请求两件事" 显形 bug 的真正根因）：
 *
 * 当 `role === 'user'` 且相邻两条 user message 的 `classifyUserMessage`
 * 分类**不同**时**不合并**——四类（`tool_result_only` / `context_injection` /
 * `continuation` / `other`）两两间语义都截然不同，合并会让 LLM 把不同来源
 * 的内容拼到同一条 user message 里读，误解上下文。
 *
 * 复现路径 A（W4.3 - tool_result_only vs other）：
 * cross-turn-memory `expandAssistantFromBlocks` 把含 tool_use 的 assistant
 * 展开为 `[assistant tool_use, user tool_result]`，下一轮 user prompt 拼到
 * 末尾后形态 `[..., user tool_result, user "新一轮请求"]` —— 旧实现合并成
 * `user [tool_result, TextBlock("新一轮请求")]`，LLM 把"新一轮请求"当作
 * turn N 的延续。
 *
 * 复现路径 B（W4.3.2 - context_injection vs other）：
 * `hooks/context-injector.ts` 在 beforeIteration 时 prepend
 * `{role:'user', content:[<context>...</context>]}` 到 state.messages 起首；
 * 这条 user 跟"用户真实输入"在旧 W4.3 二分类眼里都是 `'other'`，被合并成
 * `user [<context>, TextBlock("ls 列出来"), TextBlock("那你阅读")]` —— LLM
 * thinking 输出"用户想要我：1. 列出 2. 阅读"。
 *
 * 仍合并的情况（保持原行为）：
 * - 两条 user **同 kind**（都 `tool_result_only` / 都 `other` / …）
 * - role === 'assistant'（assistant 没有"工具结果"语义二分，按原行为合并）
 *
 * Anthropic Messages API 接受 consecutive `user` 消息（与 Bedrock 严格交
 * 替不同），所以保留多条不合并对发 API 是安全的；`ensureToolResultPairing`
 * 在送 provider 前还会做最末一刻配对闸 + 兜底。
 *
 * Returns a new array; input is untouched. The preserved message is
 * the first in each adjacent pair — spread-based so any future
 * non-content fields (id / timestamp / …) carry through from the
 * earlier turn. Counts the number of "merge operations" performed
 * (each fold reduces the array length by one).
 */
export function mergeConsecutiveMessages(
  messages: Message[],
  role: 'user' | 'assistant',
): { messages: Message[]; merged: number } {
  if (messages.length < 2) return { messages, merged: 0 };

  const out: Message[] = [];
  let merged = 0;

  for (const msg of messages) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev && prev.role === role && msg.role === role) {
      // W4.3 / W4.3.2 user 跨语义保护：任意两 kind 不同都不合并
      if (role === 'user') {
        const prevKind = classifyUserMessage(prev);
        const nextKind = classifyUserMessage(msg);
        if (prevKind !== nextKind) {
          out.push(msg);
          continue;
        }
      }
      out[out.length - 1] = mergePair(prev, msg);
      merged++;
    } else {
      out.push(msg);
    }
  }

  return { messages: out, merged };
}

/**
 * **同 kind 合并的字段保留语义（W4.3.2 review P1-3）**：
 *
 * 实现是 `{ ...prev, content: ... }`——继承 `prev` 的顶层字段（含未来可能加的
 * `id` / `timestamp` / 内部 marker 等），**`next` 上的非 content 字段被静默丢弃**。
 *
 * 当前 use case 不受影响：
 * - 同 kind 的 marker（如两条都是 `CONTEXT_INJECTION`）保留 prev 的 marker，语义
 *   一致（marker 表达"这一类合成 user"，不挂数据）；
 * - `tool_result_only` 合并仅关心 content 内的 tool_result blocks 拼接。
 *
 * 若未来想在 user message 上挂"非 marker 的 in-memory 元数据"（如 client_event_id /
 * trace 信息），且需要在合并时保留 next 侧的字段，请改 `mergePair` 的 spread 策略
 * （考虑 `{ ...prev, ...next, content: merged }` 或定制 merge 函数），并补单测覆盖
 * 元数据保留预期。
 */
function mergePair(prev: Message, next: Message): Message {
  const prevIsStr = typeof prev.content === 'string';
  const nextIsStr = typeof next.content === 'string';

  if (prevIsStr && nextIsStr) {
    // Two plain-string turns. Anthropic string content is treated as a
    // single text block, so a double newline separator is the closest
    // lossless concat. Empty-string cases degenerate to the non-empty
    // side — avoids a leading "\n\n" on otherwise-empty messages.
    const prevStr = prev.content as string;
    const nextStr = next.content as string;
    if (prevStr.length === 0) return { ...prev, content: nextStr };
    if (nextStr.length === 0) return prev;
    return { ...prev, content: `${prevStr}\n\n${nextStr}` };
  }

  const prevBlocks = prevIsStr
    ? toTextBlocks(prev.content as string)
    : ((prev.content as ContentBlock[]) ?? []);
  const nextBlocks = nextIsStr
    ? toTextBlocks(next.content as string)
    : ((next.content as ContentBlock[]) ?? []);

  return { ...prev, content: [...prevBlocks, ...nextBlocks] };
}

function toTextBlocks(text: string): ContentBlock[] {
  if (text.length === 0) return [];
  return [{ type: 'text', text }];
}

// ─── filterOrphanedThinkingOnlyMessages ──────────────────────────────

/**
 * Drop assistant messages whose content is non-empty **and** consists
 * entirely of `thinking` blocks.
 *
 * Rationale: API 400 "Content blocks that only contain thinking are
 * not allowed" fires on these; they typically appear when compaction
 * slices away the text/tool_use sibling that originally accompanied
 * the thinking block, or when a streamed response failed after only
 * the thinking phase.
 *
 * Messages with plain-string content are never touched (string implies
 * a single text block, which is by definition not thinking-only).
 * Messages with mixed content (`thinking` + anything else) are left
 * intact — thinking siblings are legal, it's only lone thinking that
 * the API rejects.
 */
export function filterOrphanedThinkingOnlyMessages(
  messages: Message[],
): { messages: Message[]; filtered: number } {
  let filtered = 0;
  const out: Message[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') {
      out.push(msg);
      continue;
    }
    const blocks = msg.content;
    if (blocks.length === 0) {
      // Empty array is a different failure mode — handled by
      // `ensureNonEmptyContent` later. Leave to that pass so the two
      // counters stay distinguishable on the dashboard.
      out.push(msg);
      continue;
    }
    const isThinkingOnly = blocks.every((b) => b.type === 'thinking');
    if (isThinkingOnly) {
      filtered++;
      continue;
    }
    out.push(msg);
  }

  return { messages: out, filtered };
}

// ─── repairOrphanToolCalls ───────────────────────────────────────────

interface RepairResult {
  messages: Message[];
  /** Total count — `orphan_tool_use_fixed + orphan_tool_result_fixed`. */
  fixed: number;
  orphan_tool_use_fixed: number;
  orphan_tool_result_fixed: number;
  empty_dropped: number;
}

/**
 * Repair two kinds of orphan structure:
 *
 *   1. `tool_result` with no matching `tool_use` — the `tool_use` was
 *      trimmed away by compaction / FR-04. The `tool_result` block is
 *      dropped (its content is no longer addressable). If dropping
 *      empties the user message, the whole message is discarded.
 *
 *      **Note on PRD wording**: the PRD v2.x draft phrases this as
 *      "orphan `tool_result` gets a stub `tool_use`". In practice
 *      inserting a back-dated stub `tool_use` is structurally risky
 *      (placement relative to role alternation, provider cache
 *      keying) and the reference normalize path also drops
 *      orphan results rather than stubbing. We adopt the drop
 *      strategy here — it satisfies the API structural check and
 *      keeps behaviour aligned with the reference. The
 *      `message.normalized` telemetry surfaces `orphan_tool_result_fixed`
 *      so operators can spot compaction pipeline regressions that
 *      produce orphans in the first place.
 *
 *   2. `tool_use` with no matching `tool_result` — the assistant
 *      produced a tool call whose response never made it into the
 *      array (abort, timeout, compaction edge). Insert a synthetic
 *      user turn right after the assistant with an `is_error: true`
 *      `tool_result` for each orphan id, so the conversation
 *      structurally passes the API's pairing check. The placeholder
 *      content is `SYNTHETIC_TOOL_RESULT_PLACEHOLDER` — matches the
 *      reference placeholder string so cross-project
 *      tooling recognises "synthetic" results.
 *
 * If the next message is already `user`, merge the synthetic
 * `tool_result` blocks into it instead of inserting — this avoids
 * introducing a fresh `user, user` pair that the subsequent
 * `mergeConsecutiveMessages` pass would just fold back together
 * anyway.
 *
 * **Mutation semantics**: the function never mutates the caller's
 * array or its existing message objects. Internally it builds a
 * `phase1` array and rewrites entries in `phase1` to fold synthetic
 * `tool_result` blocks into the following user turn. Because the
 * caller's input is shallow-copied into `phase1` up front, these
 * internal rewrites are invisible to the caller. Output messages
 * that were not altered may still share identity with corresponding
 * input messages (reference equality via `{ ...next, content: ... }`
 * when rewrite fires, original reference when not) — safe for all
 * downstream consumers because the engine treats `Message` as
 * read-only by convention.
 */
export function repairOrphanToolCalls(messages: Message[]): RepairResult {
  const { useIds, resultIds } = collectToolIds(messages);
  const afterResultDrop = dropOrphanToolResults(messages, useIds);
  const afterUseRepair = insertSyntheticToolResults(afterResultDrop.messages, resultIds);
  return {
    messages: afterUseRepair.messages,
    fixed: afterUseRepair.orphan_tool_use_fixed + afterResultDrop.orphan_tool_result_fixed,
    orphan_tool_use_fixed: afterUseRepair.orphan_tool_use_fixed,
    orphan_tool_result_fixed: afterResultDrop.orphan_tool_result_fixed,
    empty_dropped: afterResultDrop.empty_dropped,
  };
}

function collectToolIds(messages: Message[]): {
  useIds: Set<string>;
  resultIds: Set<string>;
} {
  const useIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') useIds.add(block.id);
      if (block.type === 'tool_result') resultIds.add(block.tool_use_id);
    }
  }
  return { useIds, resultIds };
}

function dropOrphanToolResults(messages: Message[], useIds: Set<string>): {
  messages: Message[];
  orphan_tool_result_fixed: number;
  empty_dropped: number;
} {
  // ── Phase 1: drop orphan tool_result blocks ──
  let orphan_tool_result_fixed = 0;
  let empty_dropped = 0;
  const phase1: Message[] = [];

  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') {
      phase1.push(msg);
      continue;
    }
    const filtered: ContentBlock[] = [];
    let droppedHere = 0;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && !useIds.has(block.tool_use_id)) {
        droppedHere++;
        continue;
      }
      filtered.push(block);
    }
    if (droppedHere === 0) {
      phase1.push(msg);
      continue;
    }
    orphan_tool_result_fixed += droppedHere;
    if (filtered.length === 0) {
      empty_dropped++;
      continue;
    }
    phase1.push({ ...msg, content: filtered });
  }
  return { messages: phase1, orphan_tool_result_fixed, empty_dropped };
}

function insertSyntheticToolResults(
  phase1: Message[],
  resultIds: Set<string>,
): {
  messages: Message[];
  orphan_tool_use_fixed: number;
} {
  // ── Phase 2: insert synthetic tool_result for orphan tool_use ──
  //
  // Walk the array; whenever an assistant has `tool_use` blocks whose
  // ids are NOT in `resultIds`, emit synthetic results. If the
  // immediately-following message is `user` we merge the stubs in;
  // otherwise we insert a new user turn right after the assistant.
  let orphan_tool_use_fixed = 0;
  const out: Message[] = [];

  for (let i = 0; i < phase1.length; i++) {
    const msg = phase1[i]!;
    out.push(msg);

    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

    const orphanUses: ToolUseBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_use' && !resultIds.has(block.id)) {
        orphanUses.push(block);
      }
    }
    if (orphanUses.length === 0) continue;

    orphan_tool_use_fixed += orphanUses.length;
    const stubBlocks: ContentBlock[] = orphanUses.map((u) => ({
      type: 'tool_result' as const,
      tool_use_id: u.id,
      content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }));

    // Mark the synthetic ids so nested loops don't double-repair them.
    for (const u of orphanUses) resultIds.add(u.id);

    const next = phase1[i + 1];
    if (next && next.role === 'user') {
      // Absorb into the next user turn so we don't introduce a new
      // user/user sandwich that `mergeConsecutiveMessages` would then
      // refold. Preserve any non-block content on the next user turn
      // by normalising its shape to blocks first.
      const nextBlocks: ContentBlock[] =
        typeof next.content === 'string'
          ? toTextBlocks(next.content)
          : next.content;
      phase1[i + 1] = {
        ...next,
        content: [...stubBlocks, ...nextBlocks],
      };
      continue;
    }

    // Otherwise synthesise a fresh user message right after this
    // assistant. We can't `push` into `out` mid-iteration for `phase1`
    // because subsequent iterations still read from `phase1`; push
    // directly to `out` instead and skip re-queuing on the next turn.
    out.push({ role: 'user', content: stubBlocks });
  }

  return {
    messages: out,
    orphan_tool_use_fixed,
  };
}

// ─── ensureNonEmptyContent ───────────────────────────────────────────

function isBlankUserContent(content: Message['content']): boolean {
  if (typeof content === 'string') return content.trim().length === 0;
  if (!Array.isArray(content) || content.length === 0) return true;
  return content.every((block) => {
    if (block.type === 'text') return block.text.trim().length === 0;
    return false;
  });
}

/**
 * Drop empty-array messages, and drop user turns that are only blank
 * text. Empty assistant strings stay — pairing repairs still use them.
 */
function ensureNonEmptyContent(messages: Message[]): {
  messages: Message[];
  empty_dropped: number;
} {
  let empty_dropped = 0;
  const out: Message[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content) && msg.content.length === 0) {
      empty_dropped++;
      continue;
    }
    if (msg.role === 'user' && isBlankUserContent(msg.content)) {
      empty_dropped++;
      continue;
    }
    out.push(msg);
  }
  return { messages: out, empty_dropped };
}

// ─── Full-level extras ───────────────────────────────────────────────

/**
 * Whitespace-only text/thinking block detection. Returns true for
 * blocks that are entirely `\s*`; returns false for tool_use,
 * tool_result and image blocks (they're never "whitespace" in the
 * semantic sense, so messages containing them should survive).
 */
function isWhitespaceOnlyBlock(block: ContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return /^\s*$/.test(block.text);
    case 'thinking':
      return /^\s*$/.test(block.thinking);
    default:
      return false;
  }
}

/**
 * Drop assistant messages whose every block is whitespace-only.
 * Leaves plain-string messages untouched (empty-string is already the
 * `ensureNonEmptyContent` branch's concern).
 *
 * Guarded behind `level: 'full'` — there's no API rule against
 * whitespace blocks, but some providers / our proxy cache keying
 * behaves better without them, and they're invariably a sign of
 * something upstream malforming output.
 */
function filterWhitespaceOnlyAssistantMessages(
  messages: Message[],
): { messages: Message[]; whitespace_dropped: number } {
  let whitespace_dropped = 0;
  const out: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') {
      out.push(msg);
      continue;
    }
    if (msg.content.length > 0 && msg.content.every(isWhitespaceOnlyBlock)) {
      whitespace_dropped++;
      continue;
    }
    out.push(msg);
  }
  return { messages: out, whitespace_dropped };
}

/**
 * Strip a lone trailing `thinking` block from the final assistant
 * message if (and only if) there is at least one non-thinking block
 * preceding it — i.e. the thinking trails the real content.
 *
 * Rationale: tool-use turns that stream thinking → tool_use →
 * thinking (retry marker) produce a trailing thinking whose signature
 * is no longer reproducible on the next round-trip, which some
 * providers reject as "mismatched thinking signature". Dropping the
 * trailing fragment is lossless for the conversation — `fullReasoning`
 * has already been surfaced to the user via `REASONING` events.
 *
 * Guarded behind `level: 'full'`; the last assistant shape here is
 * unusual enough that silently stripping reasoning on every run is
 * too eager for conservative default behaviour.
 */
function stripTrailingThinkingFromLastAssistant(
  messages: Message[],
): { messages: Message[]; trailing_thinking_stripped: number } {
  if (messages.length === 0) return { messages, trailing_thinking_stripped: 0 };

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx]!;
  if (last.role !== 'assistant' || typeof last.content === 'string') {
    return { messages, trailing_thinking_stripped: 0 };
  }
  const blocks = last.content;
  if (blocks.length < 2) return { messages, trailing_thinking_stripped: 0 };
  const tail = blocks[blocks.length - 1]!;
  if (tail.type !== 'thinking') return { messages, trailing_thinking_stripped: 0 };
  const hasNonThinkingBefore = blocks
    .slice(0, -1)
    .some((b) => b.type !== 'thinking');
  if (!hasNonThinkingBefore) return { messages, trailing_thinking_stripped: 0 };

  const out = messages.slice();
  out[lastIdx] = { ...last, content: blocks.slice(0, -1) };
  return { messages: out, trailing_thinking_stripped: 1 };
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Apply normalization per the configured level. See module docstring
 * for the exact step list per level.
 *
 * Invariants:
 * - `level: 'off'` skips structural cleanup but still runs
 *   agent-profile keep-latest；无 profile 可丢时 `messages` 可为原引用、
 *   `changes` 全零。
 * - Output `messages` is always a new array (never the input reference)
 *   when `level !== 'off'`, even if no changes were applied. This
 *   simplifies equality assertions in tests.
 * - `changes.pairing_violations` is the count *after* normalization.
 *   In the happy path this is 0; a non-zero value means an orphan
 *   survived repair (e.g. a `tool_result` whose `tool_use` is now
 *   synthetic) and is surfaced via telemetry for root-cause tracking.
 */
export function normalizeMessages(
  messages: Message[],
  options?: NormalizeOptions,
): NormalizeResult {
  const level = options?.level ?? DEFAULT_NORMALIZATION_LEVEL;

  if (level === 'off') {
    // ：off 仍做 agent-profile keep-latest——这是发给 LLM 的产品门禁，
    // 不是结构美化；否则「历史多份 / 再注入」会原样进模型。
    const keptOff = keepLatestAgentProfileRuntimeMessages(messages);
    const changesOff = emptyChanges();
    changesOff.agent_profile_dropped = keptOff.dropped;
    return { messages: keptOff.messages, changes: changesOff };
  }

  const changes = emptyChanges();

  // 1. Drop orphan-thinking-only assistants first. Keeping them across
  //    the other steps would let merge fold them into a neighbour and
  //    re-hide the API-invalid shape.
  const afterThinkingFilter = filterOrphanedThinkingOnlyMessages(messages);
  changes.thinking_filtered = afterThinkingFilter.filtered;
  let current = afterThinkingFilter.messages;

  // 2. Repair orphans BEFORE merging. Merging would hide orphans by
  //    colocating mismatched `tool_use` + `tool_result` in the same
  //    message — we want the repair decision made against the pre-merge
  //    topology.
  const afterRepair = repairOrphanToolCalls(current);
  changes.orphan_tool_use_fixed = afterRepair.orphan_tool_use_fixed;
  changes.orphan_tool_result_fixed = afterRepair.orphan_tool_result_fixed;
  changes.empty_dropped += afterRepair.empty_dropped;
  current = afterRepair.messages;

  // 2b. ：agent-profile keep-latest（在 user merge 之前，避免同 kind 合并）。
  const afterProfileKeep = keepLatestAgentProfileRuntimeMessages(current);
  changes.agent_profile_dropped = afterProfileKeep.dropped;
  current = afterProfileKeep.messages;

  // 3. Merge consecutive user turns first (repair may have inserted
  //    synthetic user turns adjacent to an existing user).
  const afterUserMerge = mergeConsecutiveMessages(current, 'user');
  changes.merged_user = afterUserMerge.merged;
  current = afterUserMerge.messages;

  // 4. Merge consecutive assistant turns.
  const afterAssistantMerge = mergeConsecutiveMessages(current, 'assistant');
  changes.merged_assistant = afterAssistantMerge.merged;
  current = afterAssistantMerge.messages;

  // 5. Drop anything that became content-empty after the above steps.
  //    This runs last so earlier passes see the original shape.
  const afterEmpty = ensureNonEmptyContent(current);
  changes.empty_dropped += afterEmpty.empty_dropped;
  current = afterEmpty.messages;

  // ── Full-level extras ──
  if (level === 'full') {
    const afterWhitespace = filterWhitespaceOnlyAssistantMessages(current);
    changes.whitespace_dropped = afterWhitespace.whitespace_dropped;
    current = afterWhitespace.messages;

    const afterTrailing = stripTrailingThinkingFromLastAssistant(current);
    changes.trailing_thinking_stripped = afterTrailing.trailing_thinking_stripped;
    current = afterTrailing.messages;

    // Re-run empty drop in case `whitespace_dropped` or trailing strip
    // left a content-less assistant. Trailing strip guarantees ≥ 1
    // remaining block (only fires when `hasNonThinkingBefore`), but
    // whitespace filter + a concurrent upstream trim may produce
    // edge cases worth catching.
    const afterFinalEmpty = ensureNonEmptyContent(current);
    changes.empty_dropped += afterFinalEmpty.empty_dropped;
    current = afterFinalEmpty.messages;
  }

  changes.pairing_violations = countPairingViolations(current);

  // Surface residual pairing violations — happens when a synthetic
  // repair was intentionally skipped (e.g. a tool_result whose
  // tool_use was also synthesised in the same round) so the operator
  // can track it in the dashboard. Never throws.
  if (changes.pairing_violations > 0 && options?.logger) {
    options.logger.warn(
      `[message-normalizer] ${changes.pairing_violations} tool pairing ` +
        'violation(s) remain after normalization; request may be rejected ' +
        'by the LLM provider. Increase telemetry `MESSAGE_NORMALIZED` ' +
        'payload to investigate.',
    );
  }

  // When level !== 'off' we always return a fresh array. This is cheap
  // (≤ length of the input) and lets callers compare by reference to
  // cheaply skip downstream work when there were no changes.
  return { messages: current, changes };
}

// ─── ensureToolResultPairing (provider 调用前最末一刻配对闸) ──────────
//
// `repairOrphanToolCalls` / `normalizeMessages` 在轮首跑（compact /
// FR-04 截断后），但到构造 `llmRequest` 之间还可能有（未来可能增的）
// 操作再造孤儿；同时 `repairOrphanToolCalls` **仅覆盖**单 assistant 内
// 孤儿 tool_use 与 user 孤儿 tool_result，**不覆盖**：
//
//   (a) **跨 assistant 的 tool_use.id 重复**——`normalizeMessagesForAPI`
//       按 message.id 合并或 session resume 补洞，可能把同一 id 的
//       tool_use 搬到两条 assistant 里。Anthropic API 会以 400 "tool_use
//       ids must be unique" 拒绝（CC-1212 事故）。
//   (b) **同 user message 内重复 tool_result**——resume 补洞时典型形态
//       `[asst X, user trX, asst X, user trX]` 合并后变
//       `[asst([X,X]), user([trX,trX])]`，去重 tool_use 的 X 后还得去重
//       同 id 的 trX，否则 API 同样 400。
//   (c) **`server_tool_use` / `mcp_tool_use` 无对应 `*_tool_result`**——
//       这两类 block 只能由 **assistant 自己内部配 `server_tool_result`
//       / `mcp_tool_result`**（而非下一条 user），形态不同于普通
//       tool_use。如果 stream 在 use 后被打断，use 无对应 result 则
//       Anthropic API 以 400 拒绝。
//
// 规范化 API 消息配对，覆盖上述
// (a)/(b)/(c)，同时重用 `repairOrphanToolCalls` 的现有能力：单 assistant
// 的 orphan tool_use 补合成 `[Tool result missing due to internal error]`
// 占位、orphan tool_result 删块。
//
// **调用时机**：`query.ts` 在构造 `llmRequest: LLMRequest` 之前最后一刻
// 调用一次——这是"发 provider 前最末一刻"的标准点（之后就直接
// `deps.callModel(llmRequest)` 发出请求，不再改 messages）。
//
// **纯函数契约**：不 mutate 输入；不 emit telemetry；不抛（strict 模式
// 留给将来 HFI 场景再加）。
//
// 与 `normalizeMessages` 的区别：
//   - `normalizeMessages` 做**结构规范化全家桶**（合并相邻同角色、过滤
//     thinking-only、丢空内容等），是轮首全量 pass。
//   - `ensureToolResultPairing` 只处理**配对不变量的硬性闸**，成本低
//     可以在每轮发 API 前都跑一次作为 defense-in-depth。

/**
 * `ensureToolResultPairing` 的结果。`repaired` 为 true 表示至少有一个
 * 修复动作发生；`messages` 是修复后的新数组（未动原输入）。
 */
export interface EnsureToolResultPairingResult {
  messages: Message[];
  /** 是否有任何修复动作 */
  repaired: boolean;
  /** 跨 assistant tool_use.id 去重删掉的 block 数量 */
  cross_message_dup_tool_use_dropped: number;
  /** 同 user message 内重复 tool_result 去重删掉的 block 数量 */
  duplicate_tool_result_dropped: number;
  /** server_tool_use / mcp_tool_use orphan 删掉的 block 数量 */
  orphan_server_tool_use_dropped: number;
  /** repairOrphanToolCalls 路径补出的合成 tool_result 数量（复用 Phase2） */
  synthetic_tool_result_added: number;
  /** repairOrphanToolCalls 路径删掉的 orphan tool_result 数量（复用 Phase1） */
  orphan_tool_result_dropped: number;
  /**
   * tool_use-family 缺 `id`（或 id 非字符串）导致整块删除的数量。
   *
   * 历史数据损坏 / 上游适配器异常 / provider 返回奇形都会让 tool_use 块
   * 没有 id——无法参与配对、会在 Anthropic API 400。Review B P1 防御：
   * 主动删掉这类畸形 block 而不是让它原样透传。
   */
  malformed_tool_use_dropped: number;
}

/**
 * block 是否是"tool use 家族"（`tool_use` / `server_tool_use` / `mcp_tool_use`）。
 * 客户端类型声明里只有 `tool_use` 一种，但历史消息里可能被 proxy 透传过来
 * 带 `server_tool_use` / `mcp_tool_use` 字面量 type 的 block，所以用 string
 * 比较而非 `block.type === 'tool_use'` switch。
 */
function isToolUseFamilyBlock(block: ContentBlock): block is ToolUseBlock {
  const t = (block as { type?: string }).type;
  return t === 'tool_use' || t === 'server_tool_use' || t === 'mcp_tool_use';
}

/**
 * block 是否是"tool result 家族"的 result 侧（`tool_result` / `server_tool_result`
 * / `mcp_tool_result`）。与 `isToolUseFamilyBlock` 对称——用于（c）判定。
 */
function isToolResultFamilyBlock(block: ContentBlock): block is ToolResultBlock {
  const t = (block as { type?: string }).type;
  return (
    t === 'tool_result' || t === 'server_tool_result' || t === 'mcp_tool_result'
  );
}

/**
 * 发 Provider 前最末一刻的 tool 配对闸。
 *
 * 步骤：
 *   Phase A. **跨 assistant 的 tool_use.id 去重**：扫所有 assistant，同一个
 *            id 第二次出现的 tool_use-family block 删除（保留最早出现的）。
 *   Phase B. **同一条 assistant 内 server/mcp_tool_use orphan 处理**：若
 *            同 assistant 内没有对应的 `server_tool_result` / `mcp_tool_result`，
 *            删掉 use block（无配对 result 时）。
 *   Phase C. **同一条 user message 内重复 tool_result 去重**：保留首次出现，
 *            其余同 tool_use_id 的 tool_result 删。
 *   Phase D. **复用 repairOrphanToolCalls**：补 orphan tool_use 合成占位 +
 *            删跨消息孤儿 tool_result（这两件事 `repairOrphanToolCalls`
 *            已有完整实现，调用即可）。
 *
 * @param messages 输入消息（通常来自 `state.messages` 在 normalize + FR-04
 *   budget 之后的样子）
 * @returns 修复后的新消息数组 + 修复计数。若无修复则 messages 可能与输入引用
 *   不同但内容等价。
 */
export function ensureToolResultPairing(
  messages: Message[],
): EnsureToolResultPairingResult {
  const out: EnsureToolResultPairingResult = {
    messages,
    repaired: false,
    cross_message_dup_tool_use_dropped: 0,
    duplicate_tool_result_dropped: 0,
    orphan_server_tool_use_dropped: 0,
    synthetic_tool_result_added: 0,
    orphan_tool_result_dropped: 0,
    malformed_tool_use_dropped: 0,
  };

  if (!Array.isArray(messages) || messages.length === 0) return out;

  // ── Phase A+B: 对 assistant 做"跨消息去重 + 同消息 server/mcp orphan 删块" ──
  const phase1 = filterAssistantToolUseBlocks(messages, out);

  // ── Phase C: 同 user message 内重复 tool_result 去重 ──
  const phase2 = dedupeUserToolResults(phase1, out);

  // ── Phase D: 复用 repairOrphanToolCalls 兜底 orphan tool_use / tool_result ──
  const repairResult = repairOrphanToolCalls(phase2);
  out.synthetic_tool_result_added = repairResult.orphan_tool_use_fixed;
  out.orphan_tool_result_dropped = repairResult.orphan_tool_result_fixed;

  out.messages = repairResult.messages;
  out.repaired =
    out.cross_message_dup_tool_use_dropped > 0
    || out.duplicate_tool_result_dropped > 0
    || out.orphan_server_tool_use_dropped > 0
    || out.synthetic_tool_result_added > 0
    || out.orphan_tool_result_dropped > 0
    || out.malformed_tool_use_dropped > 0;

  return out;
}

function filterAssistantToolUseBlocks(
  messages: Message[],
  out: EnsureToolResultPairingResult,
): Message[] {
  const allSeenToolUseIds = new Set<string>();
  const phase1: Message[] = [];
  for (const msg of messages) {
    phase1.push(filterAssistantMessageToolUses(msg, allSeenToolUseIds, out));
  }
  return phase1;
}

function filterAssistantMessageToolUses(
  msg: Message,
  allSeenToolUseIds: Set<string>,
  out: EnsureToolResultPairingResult,
): Message {
  if (msg.role !== 'assistant' || typeof msg.content === 'string') return msg;

  const serverResultIds = collectServerResultIds(msg.content);
  let changedHere = false;
  const filtered: ContentBlock[] = [];
  for (const block of msg.content) {
    const decision = shouldKeepToolUseBlock(block, allSeenToolUseIds, serverResultIds, out);
    if (!decision.keep) {
      changedHere = true;
      continue;
    }
    filtered.push(block);
  }
  if (!changedHere) return msg;

  const finalContent: ContentBlock[] = filtered.length > 0
    ? filtered
    : [{ type: 'text', text: '[Tool use interrupted]' }];
  return { ...msg, content: finalContent };
}

function collectServerResultIds(blocks: ContentBlock[]): Set<string> {
  const serverResultIds = new Set<string>();
  for (const block of blocks) {
    const t = (block as { type?: string }).type;
    if (t === 'server_tool_result' || t === 'mcp_tool_result') {
      const tid = (block as { tool_use_id?: string }).tool_use_id;
      if (typeof tid === 'string' && tid.length > 0) serverResultIds.add(tid);
    }
  }
  return serverResultIds;
}

function shouldKeepToolUseBlock(
  block: ContentBlock,
  allSeenToolUseIds: Set<string>,
  serverResultIds: Set<string>,
  out: EnsureToolResultPairingResult,
): { keep: boolean } {
  if (!isToolUseFamilyBlock(block)) return { keep: true };
  const t = (block as { type?: string }).type;
  const id = (block as { id?: string }).id;
  if (typeof id !== 'string' || id.length === 0) {
    out.malformed_tool_use_dropped++;
    return { keep: false };
  }
  if (allSeenToolUseIds.has(id)) {
    out.cross_message_dup_tool_use_dropped++;
    return { keep: false };
  }
  allSeenToolUseIds.add(id);
  if (t !== 'tool_use' && !serverResultIds.has(id)) {
    out.orphan_server_tool_use_dropped++;
    return { keep: false };
  }
  return { keep: true };
}

function dedupeUserToolResults(
  messages: Message[],
  out: EnsureToolResultPairingResult,
): Message[] {
  return messages.map((msg) => dedupeUserMessageToolResults(msg, out));
}

function dedupeUserMessageToolResults(
  msg: Message,
  out: EnsureToolResultPairingResult,
): Message {
  if (msg.role !== 'user' || typeof msg.content === 'string') return msg;
  const seen = new Set<string>();
  let changedHere = false;
  const deduped: ContentBlock[] = [];
  for (const block of msg.content) {
    if (isDuplicateToolResult(block, seen)) {
      out.duplicate_tool_result_dropped++;
      changedHere = true;
      continue;
    }
    deduped.push(block);
  }
  return changedHere ? { ...msg, content: deduped } : msg;
}

function isDuplicateToolResult(block: ContentBlock, seen: Set<string>): boolean {
  if (!isToolResultFamilyBlock(block)) return false;
  const tid = (block as { tool_use_id?: string }).tool_use_id;
  if (typeof tid === 'string' && seen.has(tid)) return true;
  if (typeof tid === 'string' && tid.length > 0) seen.add(tid);
  return false;
}
