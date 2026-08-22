/**
 * 从 messages.jsonl envelope 序列重建 Message 形态。
 *
 * `SessionStorage.restoreMessages()` 与 relay-reconcile 的 transcript 兜底
 * 共用本模块，避免 6 件套重放逻辑分叉。
 */

import { ContentBlockEvents, StreamEvents } from '../engine/contracts/stream-events.js';

import type {
  ContentBlock,
  ToolUseBlock,
} from '../engine/contracts/conversation.js';
import type {
  TranscriptEntry,
} from '../engine/contracts/context-capability.js';
import { EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS } from '../history/types.js';

export interface ReconstructedTranscriptMessage {
  role: 'user' | 'assistant' | 'system';
  messageId?: string;
  blocks: ContentBlock[];
  arrivalSeq?: number;
  subagentRunId?: string;
  messageKind?: string;
  stopReason?: string;
  /** message_start 的落盘时间（payload.started_at ?? entry.timestamp）；供渲染层排序 / created_at。 */
  timestamp?: string;
  /** 触发来源（push-notification 等）；渲染层据此还原收敛卡而非裸用户气泡。 */
  triggeredBy?: string;
  /** 注入来源（skill_invoke 等）；冷恢复时用于保留真实作者分类。 */
  source?: string;
}

export interface ReconstructTranscriptOptions {
  /** 默认保留全部持久化作者角色；模型装填由 SessionStorage.restoreMessages 投影。 */
  roles?: ReadonlyArray<'user' | 'assistant' | 'system'>;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 从最后一个 compaction:done 之后开始重建（与 restoreMessages 一致）。 */
export function findCompactionDoneStartIndex(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type === StreamEvents.COMPACTION) {
      const phase = (entry.payload as { phase?: string })?.phase;
      if (phase === 'done') return i + 1;
    }
  }
  return 0;
}

function readRewindKeepCount(entry: TranscriptEntry): number | null {
  if (entry.type !== StreamEvents.REWIND) return null;
  const keep = (entry.payload as { keep_message_count?: unknown })?.keep_message_count;
  if (typeof keep !== 'number' || !Number.isFinite(keep) || keep < 0) return null;
  return Math.floor(keep);
}

/**
 * 回退物理截断（ `commitRewind`）用：给定 transcript entries，算出「物理保留多少
 * 行」才能恰好对齐尾部 rewind 标记的 `keep_message_count`，并把标记本身丢掉。
 *
 * 返回保留的 entry 前缀长度；无尾部 rewind 标记时返回 null（调用方 no-op）。
 *
 * 计数口径与 `reconstructMessagesFromTranscriptEntries` 对齐：从最后一个
 * compaction:done 之后开始，按 user/assistant 的 message_stop 计一条消息。compaction
 * 边界之前的历史整体保留。
 */
export function computeRewindCommitPrefixLength(entries: TranscriptEntry[]): number | null {
  let markerIdx = -1;
  let keepCount = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const keep = readRewindKeepCount(entries[i]);
    if (keep !== null) {
      markerIdx = i;
      keepCount = keep;
      break;
    }
    // 尾部若已有真实消息（标记后又发了新轮次），说明已不在「待 commit」窗口，no-op。
    if (entries[i].type === ContentBlockEvents.MESSAGE_STOP) return null;
  }
  if (markerIdx < 0) return null;

  const startIdx = findCompactionDoneStartIndex(entries.slice(0, markerIdx));
  if (keepCount <= 0) return startIdx;

  let pendingRole: 'user' | 'assistant' | 'system' | null = null;
  let committed = 0;
  for (let i = startIdx; i < markerIdx; i += 1) {
    const entry = entries[i];
    if (entry.type === ContentBlockEvents.MESSAGE_START) {
      const role = (entry.payload as { role?: string })?.role;
      pendingRole = role === 'user' || role === 'assistant' || role === 'system' ? role : null;
      continue;
    }
    if (entry.type === ContentBlockEvents.MESSAGE_STOP) {
      if (pendingRole) {
        committed += 1;
        pendingRole = null;
        if (committed >= keepCount) return i + 1;
      }
    }
  }
  // 累计消息不足 keepCount：保留到标记前（丢标记即可）。
  return markerIdx;
}

type ActiveMessage = {
  role: 'user' | 'assistant' | 'system';
  messageId?: string;
  blocks: ContentBlock[];
  partialJsonByIndex: Map<number, string>;
  arrivalSeq?: number;
  subagentRunId?: string;
  messageKind?: string;
  stopReason?: string;
  timestamp?: string;
  triggeredBy?: string;
  source?: string;
};

function commitActiveMessage(active: ActiveMessage): ReconstructedTranscriptMessage {
  const dropIndices = new Set(active.partialJsonByIndex.keys());
  const finalBlocks = dropIndices.size === 0
    ? active.blocks
    : active.blocks.filter((_, blockIdx) => !dropIndices.has(blockIdx));
  return {
    role: active.role,
    messageId: active.messageId,
    blocks: finalBlocks,
    arrivalSeq: active.arrivalSeq,
    subagentRunId: active.subagentRunId,
    messageKind: active.messageKind,
    stopReason: active.stopReason,
    timestamp: active.timestamp,
    ...(active.triggeredBy ? { triggeredBy: active.triggeredBy } : {}),
    ...(active.source ? { source: active.source } : {}),
  };
}

function startActiveMessage(
  payload: Record<string, unknown>,
  allowedRoles: Set<'user' | 'assistant' | 'system'>,
  entryTimestamp?: string,
): ActiveMessage | null {
  const rawRole = payload.role as 'user' | 'assistant' | 'system' | undefined;
  const role = rawRole === 'user' || rawRole === 'system' ? rawRole : 'assistant';
  if (!allowedRoles.has(role)) return null;
  const triggeredBy = readNonEmptyString(payload.triggered_by);
  const source = readNonEmptyString(payload.source);
  return {
    role,
    messageId: readNonEmptyString(payload.message_id),
    blocks: [],
    partialJsonByIndex: new Map(),
    arrivalSeq: typeof payload.arrival_seq === 'number' ? payload.arrival_seq : undefined,
    subagentRunId: readNonEmptyString(payload.subagent_run_id),
    messageKind: readNonEmptyString(payload.message_kind),
    timestamp: readNonEmptyString(payload.started_at) ?? readNonEmptyString(entryTimestamp),
    ...(triggeredBy ? { triggeredBy } : {}),
    ...(source ? { source } : {}),
  };
}

function applyRewind(entry: TranscriptEntry, messages: ReconstructedTranscriptMessage[]): void {
  const keep = readRewindKeepCount(entry);
  if (keep !== null && keep < messages.length) {
    messages.length = keep;
  }
}

function appendContentBlockStart(active: ActiveMessage, payload: Record<string, unknown>): void {
  const block = payload.block as ContentBlock | undefined;
  if (block) active.blocks.push(structuredClone(block));
}

type TranscriptBlockDelta = {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  partial_json?: string;
};

function applyTextDelta(block: ContentBlock, delta: TranscriptBlockDelta): void {
  if (block.type === 'text' && typeof delta.text === 'string') {
    block.text = (block.text ?? '') + delta.text;
  }
}

function applyThinkingDelta(block: ContentBlock, delta: TranscriptBlockDelta): void {
  if (block.type === 'thinking' && typeof delta.thinking === 'string') {
    const tb = block as { type: 'thinking'; thinking: string };
    tb.thinking = (tb.thinking ?? '') + delta.thinking;
  }
}

function applySignatureDelta(block: ContentBlock, delta: TranscriptBlockDelta): void {
  if (block.type === 'thinking' && typeof delta.signature === 'string') {
    const tb = block as { type: 'thinking'; thinking: string; signature?: string };
    tb.signature = delta.signature;
  }
}

function applyInputJsonDelta(
  active: ActiveMessage,
  idx: number,
  block: ContentBlock,
  delta: TranscriptBlockDelta,
): void {
  if (block.type !== 'tool_use' || typeof delta.partial_json !== 'string') return;
  const prev = active.partialJsonByIndex.get(idx) ?? '';
  active.partialJsonByIndex.set(idx, prev + delta.partial_json);
}

function applyContentBlockDelta(active: ActiveMessage, payload: Record<string, unknown>): void {
  const idx = typeof payload.index === 'number' ? payload.index : -1;
  const delta = payload.delta as TranscriptBlockDelta | undefined;
  const block = idx >= 0 ? active.blocks[idx] : undefined;
  if (!block || !delta) return;

  switch (delta.type) {
    case 'text_delta':
      applyTextDelta(block, delta);
      break;
    case 'thinking_delta':
      applyThinkingDelta(block, delta);
      break;
    case 'signature_delta':
      applySignatureDelta(block, delta);
      break;
    case 'input_json_delta':
      applyInputJsonDelta(active, idx, block, delta);
      break;
    default:
      break;
  }
}

function applyContentBlockStop(active: ActiveMessage, payload: Record<string, unknown>): void {
  const idx = typeof payload.index === 'number' ? payload.index : -1;
  const block = idx >= 0 ? active.blocks[idx] : undefined;
  const partial = active.partialJsonByIndex.get(idx);
  if (!block || block.type !== 'tool_use' || typeof partial !== 'string' || partial.length === 0) {
    return;
  }
  try {
    (block as ToolUseBlock).input = JSON.parse(partial);
    active.partialJsonByIndex.delete(idx);
  } catch {
    // 留在 partialJsonByIndex；message_stop 时过滤
  }
}

function applyMessageDelta(active: ActiveMessage, payload: Record<string, unknown>): void {
  const stopReason = readNonEmptyString(payload.stop_reason);
  if (stopReason) active.stopReason = stopReason;
}

function pushCommittedMessage(
  messages: ReconstructedTranscriptMessage[],
  active: ActiveMessage,
): void {
  //  / ：六件套回落路径也跳过绝不进 LLM 历史的 kind（block 权威路径
  // 在 reconstructMessagesFromBlockRecords 同口径过滤）。
  if (
    active.messageKind
    && EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS.has(active.messageKind)
  ) {
    return;
  }
  const committed = commitActiveMessage(active);
  if (committed.blocks.length > 0) messages.push(committed);
}

/**
 * 重放 transcript envelope 序列，产出结构化 message 列表。
 * 不完整 tool_use（partial JSON 无法解析）在 message_stop 时过滤掉。
 */
export function reconstructMessagesFromTranscriptEntries(
  entries: TranscriptEntry[],
  options: ReconstructTranscriptOptions = {},
): ReconstructedTranscriptMessage[] {
  const allowedRoles = new Set(
    options.roles ?? (['user', 'assistant', 'system'] as const),
  );
  const startIdx = findCompactionDoneStartIndex(entries);

  const messages: ReconstructedTranscriptMessage[] = [];
  let active: ActiveMessage | null = null;

  for (let i = startIdx; i < entries.length; i += 1) {
    const entry = entries[i];
    const evType = entry.type;
    const payload = (entry.payload ?? {}) as Record<string, unknown>;

    if (evType === ContentBlockEvents.MESSAGE_START) {
      active = startActiveMessage(payload, allowedRoles, entry.timestamp);
      continue;
    }

    // 回退边界：行内处理——把已累积的消息截断到 keep_message_count，
    // 让被回退的轮次不进入重建结果。放在 `if (!active) continue` 之前，因为标记
    // 总写在 message_stop 之后（此刻 active 为 null）。截断后丢弃任何 in-flight
    // 消息，后续真实消息（标记之后新发的轮次）照常追加。
    if (evType === StreamEvents.REWIND) {
      applyRewind(entry, messages);
      active = null;
      continue;
    }

    if (!active) continue;

    if (evType === ContentBlockEvents.CONTENT_BLOCK_START) {
      appendContentBlockStart(active, payload);
      continue;
    }

    if (evType === ContentBlockEvents.CONTENT_BLOCK_DELTA) {
      applyContentBlockDelta(active, payload);
      continue;
    }

    if (evType === ContentBlockEvents.CONTENT_BLOCK_STOP) {
      applyContentBlockStop(active, payload);
      continue;
    }

    if (evType === ContentBlockEvents.MESSAGE_DELTA) {
      applyMessageDelta(active, payload);
      continue;
    }

    if (evType === ContentBlockEvents.MESSAGE_STOP) {
      pushCommittedMessage(messages, active);
      active = null;
    }
  }

  // dispose 兜底：active message 未 close 时也 commit（与 restoreMessages 一致）
  if (active && active.blocks.length > 0) {
    pushCommittedMessage(messages, active);
  }

  return messages;
}
