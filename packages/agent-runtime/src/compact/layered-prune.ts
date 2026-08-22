/**
 * Layered Prune — replace old tool outputs with placeholders before
 * resorting to LLM summarisation.
 *
 * Strategy (ref: Django compaction_coordinator._try_layered_prune):
 *   1. Walk messages from newest to oldest, accumulating token estimates.
 *   2. Protect the most recent ~20% of context window (with min/max bounds).
 *   3. Beyond the protection window, replace old tool_result content with
 *      a metadata-rich placeholder (includes tool name).
 *   4. If total freed tokens < minimum threshold, abort (not worth it).
 *   5. freedTokens is computed via estimateTokens() for consistency with
 *      the main pressure pipeline.
 *
 * Protection window uses token-based accumulation (via estimateTokens)
 * for CJK-aware accuracy — earlier versions used a fixed ×4 char multiplier
 * that under-protected Chinese/Japanese/Korean conversations by ~3x.
 */

import type {
  Message,
  ContentBlock,
  ToolResultBlock,
} from '../engine/contracts/conversation.js';
import { estimateTokens, TokenEstimator } from '../engine/context/token-budget.js';
import { buildPrunePlaceholder } from '../prompts/compact/fallbacks.js';

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_PROTECT_RATIO = 0.20;
const MIN_PROTECT_TOKENS = 8_000;
const MAX_PROTECT_TOKENS = 60_000;
const DEFAULT_MINIMUM_TOKENS = 10_000;

const MIN_BLOCK_CHARS_TO_PRUNE = 50;

/**
 * Tools whose outputs should never be pruned.
 *
 * WA-F 紧急修复（2026-04-19）：真机测试时 Moonshot / OpenAI 返回 HTTP 400
 * "function name is invalid" —— 它们的 schema 要求 `^[a-zA-Z0-9_-]+$`，
 * 不允许点号。Wave A · M8 曾把仓库原版下划线命名改成点号"修复" bug，
 * 反而导致整条链路被上游拒绝。现在回归**下划线 + 与工具注册名对齐**：
 *   - `packages/agent-runtime/src/tools/skills-tools.ts` 注册名就是
 *     `skills_read` / `skills_search`，`PROTECTED_TOOLS` 直接命中。
 *   - 云端（Django）对应的工具名也是下划线（`skills_read` / `skills_search`），
 *     两端跨 provider 兼容。
 *
 * canonical key 里的冒号（如 `user:code-style-check`）是 `skills_read`
 * 的**参数值**，不是 function name，与本集合无关。
 */
// `ask_choice` / `request_approval` 已下架（后者见 ），保留在保护集里
// 是为了 resume 的历史消息不被裁剪。
const PROTECTED_TOOLS = new Set([
  'todo',
  'ask_user',
  'ask_choice',
  'ask_form',
  'request_approval',
  'skills_read',
  'skills_search',
]);

// ─── Helpers ─────────────────────────────────────────────────────────

function isToolResultMessage(msg: Message): boolean {
  if (msg.role !== 'user' || typeof msg.content === 'string') return false;
  return msg.content.some((b) => b.type === 'tool_result');
}

function estimateBlockChars(content: string | ContentBlock[]): number {
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text') chars += block.text.length;
    else if (block.type === 'thinking') chars += block.thinking.length;
    else if (block.type === 'image') chars += 200;
    else if (block.type === 'tool_use') {
      try { chars += JSON.stringify(block.input ?? {}).length; } catch { /* noop */ }
      chars += block.name.length;
    } else if (block.type === 'tool_result') {
      chars += estimateBlockChars(block.content);
    }
  }
  return chars;
}

function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

// ─── Public API ──────────────────────────────────────────────────────

export interface LayeredPruneResult {
  messages: Message[];
  freedTokens: number;
}

export interface LayeredPruneOptions {
  /** Context window in tokens — used to compute proportional protect window */
  contextWindowTokens?: number;
  /** Override protect tokens directly (takes precedence over ratio) */
  protectTokens?: number;
  /** Minimum tokens to free for prune to be worthwhile */
  minimumTokens?: number;
  /** Additional tool names whose outputs should never be pruned */
  additionalProtectedTools?: string[];
  /** Token estimator for calibrated estimation (CJK-aware, model-aware) */
  estimator?: TokenEstimator;
}

function resolveProtectTokens(options?: LayeredPruneOptions): number {
  if (options?.protectTokens != null) {
    return options.protectTokens;
  }
  if (!options?.contextWindowTokens) {
    return MAX_PROTECT_TOKENS;
  }
  const proportional = Math.floor(options.contextWindowTokens * DEFAULT_PROTECT_RATIO);
  return Math.max(MIN_PROTECT_TOKENS, Math.min(MAX_PROTECT_TOKENS, proportional));
}

interface LayeredPruneCandidate {
  msgIdx: number;
  blockIdx: number;
  chars: number;
  toolName: string;
}

function collectLayeredPruneCandidates(params: {
  messages: Message[];
  protectTokens: number;
  protectedTools: Set<string>;
  toolNameMap: Map<string, string>;
  estimator?: TokenEstimator;
}): LayeredPruneCandidate[] {
  const { messages, protectTokens, protectedTools, toolNameMap, estimator } = params;
  let accumulatedTokens = 0;
  const candidates: LayeredPruneCandidate[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = estimateTokens([msg], estimator);

    if (!isToolResultMessage(msg)) {
      accumulatedTokens += msgTokens;
      continue;
    }

    if (accumulatedTokens < protectTokens) {
      accumulatedTokens += msgTokens;
      continue;
    }

    collectMessagePruneCandidates({
      msg,
      msgIdx: i,
      protectedTools,
      toolNameMap,
      candidates,
    });

    accumulatedTokens += msgTokens;
  }

  return candidates;
}

function collectMessagePruneCandidates(params: {
  msg: Message;
  msgIdx: number;
  protectedTools: Set<string>;
  toolNameMap: Map<string, string>;
  candidates: LayeredPruneCandidate[];
}): void {
  const { msg, msgIdx, protectedTools, toolNameMap, candidates } = params;
  if (typeof msg.content === 'string') return;
  for (let j = 0; j < msg.content.length; j++) {
    const block = msg.content[j];
    if (block.type !== 'tool_result') continue;

    const toolName = toolNameMap.get(block.tool_use_id) ?? '';
    if (protectedTools.has(toolName)) continue;

    const blockChars = estimateBlockChars(block.content);
    if (blockChars <= MIN_BLOCK_CHARS_TO_PRUNE) continue;

    candidates.push({ msgIdx, blockIdx: j, chars: blockChars, toolName });
  }
}

function cloneMessagesForPrune(messages: Message[]): Message[] {
  return messages.map((msg) =>
    typeof msg.content === 'string' ? msg : { ...msg, content: [...msg.content] },
  );
}

function applyLayeredPruneCandidates(
  messages: Message[],
  candidates: LayeredPruneCandidate[],
): Message[] {
  const newMessages = cloneMessagesForPrune(messages);

  for (const { msgIdx, blockIdx, toolName } of candidates) {
    const msg = newMessages[msgIdx];
    if (typeof msg.content === 'string') continue;
    const block = msg.content[blockIdx] as ToolResultBlock;
    msg.content[blockIdx] = { ...block, content: buildPrunePlaceholder(toolName) };
  }

  return newMessages;
}

/**
 * Attempt to free context space by replacing old tool outputs with placeholders.
 *
 * Protection window is proportional to context window (20%, clamped to 8k–60k).
 * Uses token-based accumulation for the protection window to ensure CJK and
 * multimodal content is accurately measured.
 * Returns null if insufficient tokens would be freed.
 */
export function layeredPrune(
  messages: Message[],
  options?: LayeredPruneOptions,
): LayeredPruneResult | null {
  if (messages.length < 8) return null;

  const protectedTools = new Set([
    ...PROTECTED_TOOLS,
    ...(options?.additionalProtectedTools ?? []),
  ]);
  const estimator = options?.estimator;
  const protectTokens = resolveProtectTokens(options);
  const minimumTokens = options?.minimumTokens ?? DEFAULT_MINIMUM_TOKENS;
  const toolNameMap = buildToolNameMap(messages);
  const candidates = collectLayeredPruneCandidates({
    messages,
    protectTokens,
    protectedTools,
    toolNameMap,
    estimator,
  });

  if (candidates.length === 0) return null;

  const tokensBefore = estimateTokens(messages, estimator);
  const newMessages = applyLayeredPruneCandidates(messages, candidates);
  const tokensAfter = estimateTokens(newMessages, estimator);
  const freedTokens = Math.max(0, tokensBefore - tokensAfter);

  if (freedTokens < minimumTokens) return null;

  return { messages: newMessages, freedTokens };
}
