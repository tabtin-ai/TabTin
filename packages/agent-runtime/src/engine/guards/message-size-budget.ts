/**
 * FR-04 · Per-message size budget（OOM backstop）纯函数底座。
 *
 * **历史背景（，Wave 2）**：本函数族原内联在 `engine/query.ts`
 * （H1-B1 落地）。#3939 策略迁移把「消息治理」编排层迁到
 * `hooks/message-governance.ts` 时，将这批纯函数原样搬到独立模块——
 * **逻辑零改动**，只解决 hook 模块 → query.ts 的循环 import。
 *
 * 默认上限 ~1 MB 字符 / 消息；per-tool 与 per-block 截断
 * （MAX_TOOL_RESULT_CHARS=10k、enforceToolOutputBudget=150k 等）仍然生效，
 * 平均用量远低于此天花板。本预算是针对病理输入（如模型回贴 5 MB 日志
 * 附件）的最后防线。可经 `EngineConfig.maxMessageChars` 覆盖。
 */

import type {
  ContentBlock,
  Message,
} from '../contracts/conversation.js';

// Exported so hosts (ElectronAgentHost / DaemonAgentHost) can use the
// same default when they wire `EngineConfig.maxMessageChars` from env
// or config — keeping one source of truth for the "1 MB backstop" value.
export const DEFAULT_MAX_MESSAGE_CHARS = 1_000_000;

/**
 * `EngineConfig.maxMessageChars` 的解析单点（ 批次 12 自
 * message-governance hook 迁入）：非法值（0 / 负 / NaN / undefined）回落默认
 * 上限。装配层（default-policy-hooks.ts）调用后把已解析值闭包给 governance
 * hook，策略内部不再直读 config。
 */
export function resolveMaxMessageChars(rawMaxMessageChars: number | undefined): number {
  return Number.isFinite(rawMaxMessageChars) && rawMaxMessageChars! > 0
    ? rawMaxMessageChars!
    : DEFAULT_MAX_MESSAGE_CHARS;
}

// ─── FR-04 helpers: per-message hard-truncate to MAX_MESSAGE_CHARS ────

/**
 * Max nested-block recursion depth for message character measurement.
 * Guards against pathological / adversarial inputs that nest
 * `tool_result.content: ContentBlock[]` past reasonable depths.
 *
 * When a nested tree **exceeds** this depth, the measurement context
 * sets `ctx.depthExceeded = true`. Callers (see
 * `enforceMessageSizeBudget`) treat depth-exceeded messages as
 * structurally oversized (reason: `deeply_nested`) rather than trusting
 * the (now under-estimated) character count. Previous behaviour
 * silently returned `0` for over-depth subtrees, which could cause the
 * OOM backstop to **miss** pathological inputs — the opposite of its
 * intent. H1-B1 Review P0 fix.
 */
const MESSAGE_MEASURE_MAX_DEPTH = 16;

/** Shared accumulator for a single `measureMessageChars` call. */
export interface MeasureContext {
  depthExceeded: boolean;
}

/**
 * Total character footprint of a single message's content.
 *
 * `image` blocks count their base64 payload / URL length — they are
 * rarely the dominant source but still contribute to the budget. Nested
 * `tool_result` content recurses (bounded by
 * `MESSAGE_MEASURE_MAX_DEPTH`) so a 5 MB string inside a `tool_result`
 * block is measured accurately. Trees deeper than the bound flip
 * `ctx.depthExceeded` so the caller can safely classify the message as
 * structurally oversized instead of trusting the truncated measurement.
 */
export function measureMessageChars(
  content: Message['content'],
  ctx: MeasureContext,
): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const block of content) {
    total += blockCharCount(block, 0, ctx);
  }
  return total;
}

function blockCharCount(
  block: ContentBlock,
  depth: number,
  ctx: MeasureContext,
): number {
  if (depth >= MESSAGE_MEASURE_MAX_DEPTH) {
    // Do not silently return 0: that would let a pathological nested
    // `tool_result` slip past the per-message budget. Flag so the
    // caller can route this message to the `deeply_nested` incompressible
    // branch.
    ctx.depthExceeded = true;
    return 0;
  }
  switch (block.type) {
    case 'text':
      return block.text.length;
    case 'thinking':
      return block.thinking.length;
    case 'tool_use':
      try {
        return JSON.stringify(block.input ?? '').length;
      } catch {
        return String(block.input ?? '').length;
      }
    case 'tool_result':
      if (typeof block.content === 'string') return block.content.length;
      return block.content.reduce(
        (acc, b) => acc + blockCharCount(b, depth + 1, ctx),
        0,
      );
    case 'image':
      return block.source.type === 'base64'
        ? block.source.data.length
        : block.source.url?.length ?? 0;
    default:
      return 0;
  }
}

/** Convenience — measure without caring about the overflow flag. */
export function measureMessageCharsQuick(content: Message['content']): number {
  return measureMessageChars(content, { depthExceeded: false });
}

/**
 * Shrink a string so its final length is guaranteed `≤ targetLen`.
 *
 * Layout: `head (75% of content budget)` + `marker` + `tail`. The
 * marker cost is subtracted from the budget up front so the returned
 * string never exceeds `targetLen` — a must-have property when the
 * caller divides a global budget across multiple blocks and then sums
 * them.
 */
function truncateLongString(text: string, targetLen: number): string {
  if (targetLen <= 0) return '';
  if (text.length <= targetLen) return text;

  // Below ~100 chars we cannot afford a marker; just keep the head.
  if (targetLen < 100) {
    return text.slice(0, Math.max(1, targetLen));
  }
  // Upper bound on the marker itself:
  //   `\n\n[... truncated <N> chars ...]\n\n` ≈ 35 chars + digits of N.
  // 60 reserves comfortable headroom for even 10-digit N values.
  const markerReserve = 60;
  const contentBudget = targetLen - markerReserve;
  const headLen = Math.floor(contentBudget * 0.75);
  const tailLen = Math.max(0, contentBudget - headLen);
  const omitted = text.length - headLen - tailLen;
  const marker = `\n\n[... truncated ${omitted} chars ...]\n\n`;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(-tailLen) : '';
  const out = `${head}${marker}${tail}`;
  // Defensive clamp for extreme N (digit-count drift vs markerReserve).
  return out.length > targetLen ? out.slice(0, targetLen) : out;
}

/**
 * Return only the slice of content that is safely truncatable. `tool_use`
 * input is *not* compressible — touching it would corrupt tool_use_id
 * pairing. `image` base64 payload is likewise left alone (breaking base64
 * yields undecodable data).
 */
function compressibleBlockSize(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length;
    case 'thinking':
      return block.thinking.length;
    case 'tool_result':
      if (typeof block.content === 'string') return block.content.length;
      return 0; // Nested ContentBlock[] inside tool_result — leave alone
    default:
      return 0;
  }
}

function shrinkCompressibleBlock(block: ContentBlock, targetSize: number): ContentBlock {
  switch (block.type) {
    case 'text':
      return { ...block, text: truncateLongString(block.text, targetSize) };
    case 'thinking':
      return { ...block, thinking: truncateLongString(block.thinking, targetSize) };
    case 'tool_result':
      if (typeof block.content === 'string') {
        return { ...block, content: truncateLongString(block.content, targetSize) };
      }
      return block;
    default:
      return block;
  }
}

export interface MessageTruncation {
  index: number;
  originalLength: number;
  newLength: number;
}

export interface MessageOversizedIncompressible {
  index: number;
  originalLength: number;
  /**
   * Why the message could not be shrunk — purely informational. Helps
   * observers distinguish a 10 MB base64 image from a runaway
   * `tool_use` input without inspecting raw content.
   *
   * `deeply_nested` is set when `blockCharCount` hit the depth bound
   * (`MESSAGE_MEASURE_MAX_DEPTH`). The raw character count is
   * under-estimated in that case, so we fail safe by treating the
   * message as structurally oversized.
   */
  reason: 'image' | 'tool_use' | 'nested_tool_result' | 'deeply_nested' | 'mixed';
}

function classifyIncompressibleReason(
  content: Message['content'],
  depthExceeded: boolean,
): MessageOversizedIncompressible['reason'] {
  // Over-depth nesting is its own category. It shadows the usual
  // per-block classification because the measurement itself is
  // untrusted — surfacing a different reason would mislead operators.
  if (depthExceeded) return 'deeply_nested';
  if (typeof content === 'string') return 'mixed';
  const categories = new Set<'image' | 'tool_use' | 'nested_tool_result' | 'other'>();
  const probeCtx: MeasureContext = { depthExceeded: false };
  for (const block of content) {
    if (blockCharCount(block, 0, probeCtx) === 0) continue;
    if (block.type === 'image') categories.add('image');
    else if (block.type === 'tool_use') categories.add('tool_use');
    else if (block.type === 'tool_result' && typeof block.content !== 'string') {
      categories.add('nested_tool_result');
    } else {
      categories.add('other');
    }
  }
  if (categories.size === 1) {
    const only = [...categories][0]!;
    return only === 'other' ? 'mixed' : only;
  }
  return 'mixed';
}

function pushDeeplyNestedMessage(
  oversizedIncompressible: MessageOversizedIncompressible[],
  index: number,
  originalLength: number,
): void {
  oversizedIncompressible.push({
    index,
    originalLength,
    reason: 'deeply_nested',
  });
}

function shrinkLargestCompressibleBlocks(
  blocks: ContentBlock[],
  originalLength: number,
  targetLen: number,
): number {
  let remaining = originalLength;
  // At most N iterations of picking the largest compressible block;
  // bounded to avoid any pathological loop — in practice one round is
  // enough when a single huge tool_result dominates.
  const MAX_ROUNDS = 32;
  for (let round = 0; round < MAX_ROUNDS && remaining > targetLen; round++) {
    let largestIdx = -1;
    let largestSize = 0;
    for (let i = 0; i < blocks.length; i++) {
      const size = compressibleBlockSize(blocks[i]!);
      if (size > largestSize) {
        largestSize = size;
        largestIdx = i;
      }
    }
    if (largestIdx < 0 || largestSize <= 0) break;

    const overflow = remaining - targetLen;
    // Leave at least ~200 chars worth of signal in any shrunken block.
    const shrinkBy = Math.min(overflow, Math.max(0, largestSize - 200));
    if (shrinkBy <= 0) break;

    const newSize = largestSize - shrinkBy;
    blocks[largestIdx] = shrinkCompressibleBlock(blocks[largestIdx]!, newSize);
    remaining -= shrinkBy;
  }
  return remaining;
}

function proportionallyShrinkCompressibleBlocks(
  blocks: ContentBlock[],
  remaining: number,
  effectiveMax: number,
  targetLen: number,
): number {
  if (remaining <= effectiveMax) return remaining;
  const compressibleTotal = blocks.reduce(
    (sum, b) => sum + compressibleBlockSize(b),
    0,
  );
  if (compressibleTotal <= 0) return remaining;

  const incompressible = remaining - compressibleTotal;
  const allowance = Math.max(0, targetLen - incompressible);
  if (allowance >= compressibleTotal) return remaining;

  const ratio = allowance / compressibleTotal;
  for (let i = 0; i < blocks.length; i++) {
    const size = compressibleBlockSize(blocks[i]!);
    if (size <= 0) continue;
    // Math.max(1, ...) keeps the block non-empty but may be extreme;
    // `truncateLongString` guarantees output <= newSize.
    const newSize = Math.max(1, Math.floor(size * ratio));
    blocks[i] = shrinkCompressibleBlock(blocks[i]!, newSize);
  }
  return measureMessageCharsQuick(blocks);
}

/**
 * Enforce a per-message character ceiling.
 *
 * Strategy (preserves structural correctness — tool_use IDs, image
 * payloads, block ordering):
 *   1. Measure total chars per message.
 *   2. For each over-limit message, repeatedly find the largest
 *      compressible block (text / thinking / tool_result with string
 *      content) and shrink it with head+tail truncation until the
 *      message is ≤ 80% of the budget or no further compression is
 *      possible.
 *
 * Returns the (possibly new) message array, a truncation manifest for
 * successful shrinks, and an incompressible manifest listing messages
 * that remained over the ceiling because every block was structural
 * (tool_use input, image payload, nested tool_result). The caller emits
 * one SYSTEM_NOTICE per entry in each manifest — using distinct
 * `notice_type` values so observers know whether the OOM backstop
 * engaged cleanly or leaked through.
 */
export function enforceMessageSizeBudget(
  messages: Message[],
  maxChars: number,
): {
  messages: Message[];
  truncations: MessageTruncation[];
  oversizedIncompressible: MessageOversizedIncompressible[];
} {
  // Normalise pathological configs (0 / negative / NaN) to the default
  // ceiling — a misconfigured host should still get OOM protection
  // rather than silently disabling the whole safety net.
  const effectiveMax =
    Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_MESSAGE_CHARS;
  const out = messages.slice();
  const truncations: MessageTruncation[] = [];
  const oversizedIncompressible: MessageOversizedIncompressible[] = [];
  const targetLen = Math.floor(effectiveMax * 0.8);

  for (let idx = 0; idx < out.length; idx++) {
    const msg = out[idx]!;
    // Measure once with an overflow-aware context so we can distinguish
    // "genuinely huge payload" from "adversarially deep nesting that
    // slipped past the depth bound". Deeply nested trees cannot be
    // trusted to report accurate lengths, so we fail safe by routing
    // them straight to the `oversizedIncompressible` branch.
    const measureCtx: MeasureContext = { depthExceeded: false };
    const rawLength = measureMessageChars(msg.content, measureCtx);
    if (measureCtx.depthExceeded) {
      // Record an incompressible hit; leave the message content alone
      // (we cannot safely rewrite a tree we could not fully measure).
      pushDeeplyNestedMessage(oversizedIncompressible, idx, rawLength);
      continue;
    }
    const originalLength = rawLength;
    if (originalLength <= effectiveMax) continue;

    if (typeof msg.content === 'string') {
      out[idx] = { ...msg, content: truncateLongString(msg.content, targetLen) };
      truncations.push({
        index: idx,
        originalLength,
        newLength: measureMessageCharsQuick(out[idx]!.content),
      });
      continue;
    }

    const blocks = [...msg.content];
    let remaining = shrinkLargestCompressibleBlocks(blocks, originalLength, targetLen);

    // Cap enforcement: if the per-block strategy did not bring us below
    // the hard ceiling (e.g. many similarly-sized compressible blocks
    // after 32 rounds), apply a proportional shrink across every
    // compressible block so the final message respects `effectiveMax`.
    // Incompressible blocks (tool_use / image) are left alone.
    //
    // Note: unlike the per-block loop above — which preserves ~200
    // chars of signal per shrunken block — this fallback prioritises
    // the hard cap over readability. Individual blocks can end up as
    // short as a single character; that is deliberate so we never ship
    // an over-budget request to the LLM.
    remaining = proportionallyShrinkCompressibleBlocks(
      blocks,
      remaining,
      effectiveMax,
      targetLen,
    );

    const newLength = measureMessageCharsQuick(blocks);
    if (newLength < originalLength) {
      out[idx] = { ...msg, content: blocks };
      truncations.push({ index: idx, originalLength, newLength });
      // If even the proportional shrink path could not bring us under
      // the ceiling, surface an incompressible warning too — the
      // remaining chars come from structurally protected blocks.
      if (newLength > effectiveMax) {
        oversizedIncompressible.push({
          index: idx,
          originalLength: newLength,
          reason: classifyIncompressibleReason(blocks, false),
        });
      }
    } else {
      // Pure incompressible (e.g. single huge base64 image or oversized
      // tool_use input). Preserve the message verbatim — fidelity beats
      // a misleading "truncated" label — but warn the observer channel
      // so operators know the OOM backstop leaked through for this
      // particular message.
      oversizedIncompressible.push({
        index: idx,
        originalLength,
        reason: classifyIncompressibleReason(msg.content, false),
      });
    }
  }

  return { messages: out, truncations, oversizedIncompressible };
}

export function collectDeeplyNestedMessages(messages: Message[]): MessageOversizedIncompressible[] {
  const deeplyNested: MessageOversizedIncompressible[] = [];
  for (let i = 0; i < messages.length; i++) {
    const depthCtx: MeasureContext = { depthExceeded: false };
    const rawLen = measureMessageChars(messages[i]!.content, depthCtx);
    if (depthCtx.depthExceeded) {
      deeplyNested.push({ index: i, originalLength: rawLen, reason: 'deeply_nested' });
    }
  }
  return deeplyNested;
}
