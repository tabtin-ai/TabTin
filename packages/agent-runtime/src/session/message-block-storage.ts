/**
 * @tabtin/agent-runtime — Message Block Storage（ message block 权威）
 *
 * Append-only JSONL：`{sessionDir}/{threadId}/message-blocks.jsonl`，每行一条
 * **完整消息**（拼好的 ContentBlock[]），与 Django `chat_message.content_blocks_json`
 * 同 payload、同 message_id——本地权威与云端副本天然同构。
 *
 * 记录来源（由 `SessionStorage` 路由，宿主零新增接线）：
 *   - `agent.stream.persist_message`（assistant 整包，含 co-locate 的 tool_result）
 *     → `appendStreamEvent` 分支写入；
 *   - `recordUserMessage`（真 user / environment_context）→ 同步写入；
 *   - `agent.stream.compaction`（phase=end 且带 summary）→ 写 compaction 边界记录
 *     （`message_kind='compaction_summary'` + `compaction_boundary=true`）。
 *
 * 与 `messages.jsonl`（六件套事件流）的关系：六件套降级为流式传输编码 + 调试
 * 留档；跨轮 LLM 历史与前端历史渲染的权威是本文件。存量会话无本文件时，
 * `SessionStorage.restoreMessages()` 回落六件套重放（零回归）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { ContentBlock, Message } from '../engine/contracts/conversation.js';
import { stripUserContextWrappers } from '../engine/context/user-message.js';
import { EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS } from '../history/types.js';

const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * message-blocks.jsonl 单行实体。
 *
 * 字段名与 wire `PersistMessageEventPayloadSchema` 对齐（`blocks_json` 等），
 * 让「本地记录 ↔ relay payload ↔ ChatMessage 行」三者可以按同名字段直接对账。
 * 本地附加字段：`v`（记录版本）、`recorded_at`（落盘时刻，回退截断锚点）、
 * `compaction_boundary`（压缩边界标记，重建时截断此前历史）。
 */
export interface MessageBlockRecord {
  v: 1;
  recorded_at: string;
  message_id: string;
  role: 'user' | 'assistant' | 'system';
  /** llm / environment_context / compaction_summary / hitl_interaction / … */
  message_kind: string;
  blocks_json: ContentBlock[];
  arrival_seq?: number;
  stop_reason?: string;
  subagent_run_id?: string;
  partial?: boolean;
  metadata?: Record<string, unknown>;
  error_info_json?: Record<string, unknown>;
  /** 压缩边界：重建 LLM 历史时丢弃此前记录，以本记录的摘要为新起点。 */
  compaction_boundary?: boolean;
}

export class MessageBlockStorage {
  /** 落盘文件绝对路径（SSoT）——外部不要自行拼路径。 */
  readonly filePath: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_THRESHOLD = 10;

  constructor(sessionDir: string, threadId: string) {
    this.filePath = path.join(sessionDir, threadId, 'message-blocks.jsonl');
  }

  async append(record: MessageBlockRecord): Promise<void> {
    this.buffer.push(`${JSON.stringify(record)}\n`);
    if (this.buffer.length >= MessageBlockStorage.FLUSH_THRESHOLD) {
      this.writeQueue = this.writeQueue.then(() => this._flush());
      await this.writeQueue;
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.writeQueue = this.writeQueue.then(() => this._flush());
      }, MessageBlockStorage.FLUSH_INTERVAL_MS);
    }
  }

  /** 文件是否已有内容（restore 路径据此决定 block 权威 vs 六件套回放）。 */
  hasRecords(): boolean {
    try {
      return fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0;
    } catch {
      return false;
    }
  }

  /**
   * 逐行读取全部记录（读前 flush 内存 buffer，保证 read-after-write 一致）。
   * 同一 `message_id` 出现多次时保留**最后一条**（与 Django persist upsert 语义
   * 一致——重发/修正覆盖旧值），保留首次出现的时间轴位置。
   */
  async load(): Promise<MessageBlockRecord[]> {
    await this.flushPendingWrites();
    if (!fs.existsSync(this.filePath)) return [];

    const records: MessageBlockRecord[] = [];
    const indexByMessageId = new Map<string, number>();
    const stream = fs.createReadStream(this.filePath, {
      encoding: 'utf-8',
      highWaterMark: STREAM_CHUNK_BYTES,
    });
    try {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: MessageBlockRecord;
        try {
          parsed = JSON.parse(trimmed) as MessageBlockRecord;
        } catch {
          continue; // skip malformed lines
        }
        if (!isValidRecord(parsed)) continue;

        const existingIdx = indexByMessageId.get(parsed.message_id);
        if (existingIdx !== undefined) {
          records[existingIdx] = parsed; // upsert：保留原时间轴位置，内容取最新
          continue;
        }
        records.push(parsed);
        indexByMessageId.set(parsed.message_id, records.length - 1);
      }
    } finally {
      if (!stream.destroyed) stream.destroy();
    }
    return records;
  }

  /**
   * 回退物理截断：删除 `recorded_at >= cutTs` 的所有记录。与
   * `SessionStorage.commitRewind()`（messages.jsonl）、`EventStorage.truncateFrom()`
   * （events.jsonl）同锚点（回退边界总在对话轮次之间，时间对齐安全，见 ）。
   */
  async truncateFrom(cutTs: number): Promise<void> {
    await this.flushPendingWrites();
    if (!fs.existsSync(this.filePath)) return;

    const raw = await fs.promises.readFile(this.filePath, 'utf-8');
    const kept: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as MessageBlockRecord;
        const ts = Date.parse(record.recorded_at);
        if (Number.isFinite(ts) && ts < cutTs) kept.push(`${line}\n`);
      } catch {
        kept.push(`${line}\n`); // 坏行保守保留
      }
    }
    await fs.promises.writeFile(this.filePath, kept.join(''), { mode: 0o600 });
  }

  async flushPendingWrites(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this._flush());
    await this.writeQueue;
  }

  async dispose(): Promise<void> {
    await this.flushPendingWrites();
  }

  private async _flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    //  同款竞态防护：await 期间并发 append 的新行不能被整体清空丢弃。
    const flushCount = this.buffer.length;
    const batch = this.buffer.slice(0, flushCount).join('');
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.appendFile(this.filePath, batch, { mode: 0o600 });
      this.buffer.splice(0, flushCount);
    } catch (err) {
      // 失败保留 buffer 下次重试；不 throw 保住 writeQueue 链路存活。
      try {

        console.warn(
          `[message-block-storage] flush failed; ${this.buffer.length} records kept for retry: `
            + `${(err as Error)?.message ?? err}`,
        );
      } catch { /* ignore log error */ }
    }
  }
}

function isValidRecord(record: MessageBlockRecord): boolean {
  return !!record
    && typeof record.message_id === 'string'
    && record.message_id.length > 0
    && (record.role === 'user' || record.role === 'assistant' || record.role === 'system')
    && Array.isArray(record.blocks_json);
}

/**
 * 把 block 记录序列重建成喂 LLM 的 `Message[]`（与 live `state.messages` 推进
 * 同构）：
 *   - `compaction_boundary` → 清空已累积历史，以边界记录的摘要 user 消息为新起点
 *     （对齐 live 压缩后 `state.messages = [summaryMessage, …]` 的语义；kept tail
 *     的字节级复刻见  后续项）；
 *   - assistant 记录 → assistant 消息（text/thinking/tool_use）+ 紧随的 user 消息
 *     （co-locate 的 tool_result 块）——与 live 的
 *     `state.messages.push({role:'user', content: toolResultBlocks})` 对齐；
 *   - user 记录 → user 消息原样。
 */
/**
 * 把 block 记录转成 UI 冷启动读取形态（与六件套重放的
 * `ReconstructedTranscriptMessage` 同 shape）——renderer 的
 * `adaptTranscriptToChatMessages` 零改动即可消费。
 *
 * 与 LLM 重建（`reconstructMessagesFromBlockRecords`）的差别：
 *   - 不拆 tool_result（UI 期望 tool_use 与 tool_result co-locate 在同一消息）；
 *   - 不截断 compaction 之前的历史（UI 要完整时间轴），compaction_summary
 *     记录原样透传（前端 MessageBubble 按 message_kind 渲染成压缩分隔，与
 *     DB 冷读口径一致）；
 *   - 保留 subagent 记录（渲染层按现有口径自行处理）。
 */
export function blockRecordsToTranscriptMessages(records: MessageBlockRecord[]): Array<{
  role: 'user' | 'assistant' | 'system';
  messageId?: string;
  blocks: ContentBlock[];
  arrivalSeq?: number;
  subagentRunId?: string;
  messageKind?: string;
  stopReason?: string;
  timestamp?: string;
  triggeredBy?: string;
  metadata?: Record<string, unknown>;
  errorInfoJson?: Record<string, unknown>;
}> {
  return records
    // hitl_interaction 是纯 metadata 消息（无内容块），面板由 metadata.hitl 驱动——
    // 保留空块记录；其余记录仍按「有块」过滤（丢半截空 message）。
    .filter((record) => record.blocks_json.length > 0
      || record.message_kind === 'hitl_interaction'
      || Boolean(record.error_info_json))
    .map((record) => {
      const triggeredBy = readTriggeredBy(record.metadata);
      return {
        role: record.role,
        messageId: record.message_id,
        blocks: toDisplayBlocks(record),
        ...(typeof record.arrival_seq === 'number' ? { arrivalSeq: record.arrival_seq } : {}),
        ...(record.subagent_run_id ? { subagentRunId: record.subagent_run_id } : {}),
        ...(record.message_kind ? { messageKind: record.message_kind } : {}),
        ...(record.stop_reason ? { stopReason: record.stop_reason } : {}),
        ...(record.recorded_at ? { timestamp: record.recorded_at } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
        // 非正文 metadata（hitl 面板事实等）随冷读透出，让 reconcile 能恢复面板。
        ...(record.metadata && typeof record.metadata === 'object' ? { metadata: record.metadata } : {}),
        ...(record.error_info_json ? { errorInfoJson: record.error_info_json } : {}),
      };
    });
}

/** 从 block 记录 metadata 读回触发来源（push 通知等 host 内部消息用它还原收敛卡）。 */
function readTriggeredBy(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.triggered_by;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * UI 展示形态：真 user query（kind=llm）的 text 块剥掉 `<context …>` wrapper。
 *
 * user block 记录存的是 **LLM 真相**（含附件 / 环境 context wrapper 全文，
 * 跨轮历史需要）；但 UI 冷读要与 DB 冷读（visible 文本）口径一致——带附件
 * 消息若直接渲染会冒出 wrapper 噪音。与 runtime 主 USER 事件的
 * `stripUserContextWrappers(prompt)` 同一函数，保证两条展示路径同字节。
 */
function toDisplayBlocks(record: MessageBlockRecord): ContentBlock[] {
  if (record.role !== 'user' || (record.message_kind || 'llm') !== 'llm') {
    return record.blocks_json;
  }
  let changed = false;
  const out = record.blocks_json.map((block) => {
    if (block.type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
      return block;
    }
    const text = (block as { text: string }).text;
    const stripped = stripUserContextWrappers(text);
    if (stripped === text) return block;
    changed = true;
    return { ...block, text: stripped } as ContentBlock;
  });
  return changed ? out : record.blocks_json;
}

/**
 * 从 message-blocks 重建 LLM 历史 Message[]。
 *
 * 只做结构还原（tool_result 拆分、compaction 边界、排除 kind），
 * 不根据任何生产者元数据改写消息内容或插入注解。
 */
export function reconstructMessagesFromBlockRecords(
  records: MessageBlockRecord[],
): Message[] {
  let messages: Message[] = [];

  for (const record of records) {
    // 子 Agent 消息不进主对话 LLM 历史（与 Django recovery 的 subagent_run_id
    // 空过滤同口径）；它们在 DB 侧仍是独立 ChatMessage 行。
    if (record.subagent_run_id) continue;
    //  / ：hitl_interaction、system_prompt_context 等绝不进 LLM 历史。
    if (EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS.has(record.message_kind)) continue;
    if (record.compaction_boundary) {
      messages = record.blocks_json.length > 0
        ? [{ role: 'user', content: record.blocks_json }]
        : [];
      continue;
    }

    if (record.role === 'assistant') {
      const toolResults = record.blocks_json.filter((block) => block.type === 'tool_result');
      const assistantBlocks = record.blocks_json.filter((block) => block.type !== 'tool_result');
      if (assistantBlocks.length > 0) {
        messages.push({
          role: 'assistant',
          content: assistantBlocks,
        });
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }
      continue;
    }

    if (record.blocks_json.length > 0) {
      messages.push({ role: 'user', content: record.blocks_json });
    }
  }

  return messages;
}
