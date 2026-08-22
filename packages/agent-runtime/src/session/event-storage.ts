/**
 * @tabtin/agent-runtime — JSONL Event Storage
 *
 * Append-only JSONL file: {sessionDir}/{sessionId}/events.jsonl
 * Records the complete event stream for offline replay / audit.
 *
 * Payload reduction rules（W2 envelope-based 后）：
 * - `agent.stream.content_block_delta` text_delta：只存 `{ type, text_chars }`，
 *   不存 token 级原文（offline replay 拼回 message 时按 cb_start.block + 各 delta 累积）
 * - `agent.stream.content_block_start` 含 `block.type === 'tool_result'` 且
 *   `block.content` > 10 KB：替换为 placeholder 指向 tool-logs/*.md。
 *   完整内容永远落在 tool-logs/{sessionId}/{tool_call_id}.md（tool I/O 的 SSoT），
 *   events.jsonl 只做时序索引，placeholder 即可。
 * - `agent.stream.llm_request` / `agent.stream.llm_snapshot`：仍按原 reduce 规则存关键字段
 *
 * **2026-05-10 history**：旧版做 `output.slice(0, 5K) + "\\n[…truncated N
 * chars…]\\n" + output.slice(-2K)`。对 FR-09 fence-wrapped outputs（read_file /
 * grep_search 等）会切断 JSON body 并插入裸 LF+省略号——offline replay 跑
 * `JSON.parse` 必炸。当前 placeholder 策略更短、不破坏 JSON、自描述。
 *
 * **W2 silent-bypass 修复**：原版按老协议 `agent.stream.assistant`(delta) /
 * `agent.stream.tool`(end) 路径 reduce——在 W2 envelope-based 协议下这两类事件
 * runtime 已 0 emit，reduce 永不命中。重写 reducer 走新 6 件套协议。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContentBlockEvents, StreamEvents } from '../engine/contracts/stream-events.js';

const TOOL_OUTPUT_MAX_CHARS = 10 * 1024;

export interface EventStorageEntry {
  type: string;
  payload: unknown;
  timestamp: number;
}

export class EventStorage {
  /**
   * 落盘文件绝对路径（SSoT）。caller 需要"events 文件在哪"时直接读这里，
   * 不要外部再 `path.join(sessionDir, sessionId, 'events.jsonl')`——避免哪
   * 天本类改文件名 / 目录布局时外部静默漂移。
   */
  readonly filePath: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_THRESHOLD = 20;

  constructor(sessionDir: string, sessionId: string) {
    const dir = path.join(sessionDir, sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, 'events.jsonl');
  }

  async append(event: EventStorageEntry): Promise<void> {
    const reduced = this._reducePayload(event);
    const line = JSON.stringify(reduced) + '\n';
    this.buffer.push(line);

    if (this.buffer.length >= EventStorage.FLUSH_THRESHOLD) {
      this.writeQueue = this.writeQueue.then(() => this._flush());
      await this.writeQueue;
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.writeQueue = this.writeQueue.then(() => this._flush());
      }, EventStorage.FLUSH_INTERVAL_MS);
    }
  }

  async dispose(): Promise<void> {
    await this._flush();
  }

  /**
   * ：物理截断 events.jsonl，删除 `timestamp >= cutTs` 的所有事件。
   * 宿主在 `SessionStorage.commitRewind()` 裁切 messages.jsonl 后对称调用；
   * relay-reconcile 随后读到的即已反映回退的干净 event log。
   */
  async truncateFrom(cutTs: number): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this._flush());
    await this.writeQueue;

    if (!fs.existsSync(this.filePath)) return;

    const raw = await fs.promises.readFile(this.filePath, 'utf-8');
    const kept: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as EventStorageEntry;
        if (typeof entry.timestamp === 'number' && entry.timestamp < cutTs) {
          kept.push(line + '\n');
        }
      } catch {
        kept.push(line + '\n');
      }
    }
    await fs.promises.writeFile(this.filePath, kept.join(''), { mode: 0o600 });
  }

  private _reducePayload(event: EventStorageEntry): EventStorageEntry {
    const p = event.payload as Record<string, unknown> | undefined;
    if (!p) return event;

    // ── W2 协议：text 流式增量按字符数压缩，不存原文 ──
    if (event.type === ContentBlockEvents.CONTENT_BLOCK_DELTA) {
      return reduceContentBlockDeltaEvent(event, p);
    }

    // ── W2 协议：tool_result block 长 content 替换为 placeholder ──
    if (event.type === ContentBlockEvents.CONTENT_BLOCK_START) {
      return reduceContentBlockStartEvent(event, p);
    }

    if (event.type === StreamEvents.LLM_REQUEST || event.type === StreamEvents.LLM_SNAPSHOT) {
      return reduceLlmSnapshotEvent(event, p);
    }

    if (event.type === StreamEvents.LLM_USAGE) {
      return reduceLlmUsageEvent(event, p);
    }

    return event;
  }

  private async _flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.join('');
    this.buffer = [];

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      await fs.promises.appendFile(this.filePath, batch, { mode: 0o600 });
    } catch (err) {
      // 阶段 8 Review fix：与 SnapshotStorage 对称——_flush 失败不再静默 throw。
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[event-storage] flush failed for ${this.filePath}: ${(err as Error)?.message ?? err}`,
        );
      } catch { /* ignore log error */ }
    }
  }
}

function reduceContentBlockDeltaEvent(
  event: EventStorageEntry,
  payload: Record<string, unknown>,
): EventStorageEntry {
  const delta = payload.delta as { type?: string; text?: string; partial_json?: string } | undefined;
  if (delta?.type === 'text_delta') {
    const text = typeof delta.text === 'string' ? delta.text : '';
    return {
      type: event.type,
      timestamp: event.timestamp,
      payload: {
        ...payload,
        delta: { type: 'text_delta', text_chars: text.length },
      },
    };
  }
  if (delta?.type !== 'input_json_delta') return event;

  const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
  if (partial.length <= TOOL_OUTPUT_MAX_CHARS) return event;
  return {
    type: event.type,
    timestamp: event.timestamp,
    payload: {
      ...payload,
      delta: {
        type: 'input_json_delta',
        partial_json_chars: partial.length,
        truncated_in_event_storage: true,
      },
    },
  };
}

function reduceContentBlockStartEvent(
  event: EventStorageEntry,
  payload: Record<string, unknown>,
): EventStorageEntry {
  const block = payload.block as { type?: string; content?: unknown; tool_use_id?: string } | undefined;
  if (block?.type !== 'tool_result' || typeof block.content !== 'string') return event;
  if (block.content.length <= TOOL_OUTPUT_MAX_CHARS) return event;

  const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : 'unknown';
  return {
    type: event.type,
    timestamp: event.timestamp,
    payload: {
      ...payload,
      block: {
        ...block,
        content: `[event-storage truncated: ${block.content.length} chars; full content in tool-logs/${toolCallId}.md]`,
        content_truncated_in_event_storage: true,
        original_content_length: block.content.length,
      },
    },
  };
}

function reduceLlmSnapshotEvent(
  event: EventStorageEntry,
  payload: Record<string, unknown>,
): EventStorageEntry {
  return {
    type: event.type,
    timestamp: event.timestamp,
    payload: {
      runId: payload.runId,
      iterationId: payload.iterationId,
      phase: payload.phase,
      iteration: payload.iteration,
      model: payload.model,
      providerChannel: payload.providerChannel,
      isByokMode: payload.isByokMode,
      contextTierId: payload.contextTierId,
      reasoningEffort: payload.reasoningEffort,
      serviceTier: payload.serviceTier,
      messageCount: payload.messageCount,
      toolCount: payload.toolCount,
      systemCharCount: (payload.system as Record<string, unknown> | undefined)?.charCount,
      responseCharCount: (payload.response as Record<string, unknown> | undefined)?.charCount,
    },
  };
}

function reduceLlmUsageEvent(
  event: EventStorageEntry,
  payload: Record<string, unknown>,
): EventStorageEntry {
  return {
    type: event.type,
    timestamp: event.timestamp,
    payload: {
      runId: payload.runId,
      iterationId: payload.iterationId,
      iteration: payload.iteration,
      model: payload.model,
      requestSource: payload.requestSource,
      providerChannel: payload.providerChannel,
      isByokMode: payload.isByokMode,
      contextTierId: payload.contextTierId,
      reasoningEffort: payload.reasoningEffort,
      serviceTier: payload.serviceTier,
      durationMs: payload.durationMs,
      messageCount: payload.messageCount,
      toolCount: payload.toolCount,
      input_tokens: payload.input_tokens,
      output_tokens: payload.output_tokens,
      cache_read_input_tokens: payload.cache_read_input_tokens,
      cache_creation_input_tokens: payload.cache_creation_input_tokens,
      reasoning_tokens: payload.reasoning_tokens,
      credits_charged: payload.credits_charged,
      last_input_tokens: payload.last_input_tokens,
      last_cache_read_input_tokens: payload.last_cache_read_input_tokens,
      last_cache_creation_input_tokens: payload.last_cache_creation_input_tokens,
      by_model: payload.by_model,
    },
  };
}
