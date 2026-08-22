/**
 * @tabtin/agent-runtime — JSONL Session Storage（Wave 2 envelope-based 重写）
 *
 * 落盘形态：`{sessionDir}/{sessionId}/messages.jsonl`，每行一个 JSON 对象，
 * 形态严格遵循 `TranscriptEntry` schema（详见 `engine/types.ts` 同名 interface）：
 *
 *   {
 *     uuid: "<sessionId>:<seq>",       // 会话链表唯一 ID
 *     parentUuid: "<sessionId>:<seq-1>" | null,
 *     timestamp: "2026-05-11T...",      // ISO8601
 *     sessionId: "<thread_id>",
 *     version: <monotonic local seq>,   // 与 envelope.payload._seq 不同
 *     type: "agent.stream.message_start" | ...,  // envelope event_type
 *     payload: {                        // envelope payload 完整体（含 _seq /
 *       ...,                            //   protocol_version / message_id 等）
 *     },
 *     cwd?: "/abs/path",                // 仅首条 message_start
 *     runtimeVersion?: "tabtin-runtime-v2",
 *   }
 *
 * 与老 TranscriptEntry 的关系：API 形态不变（`recordUserMessage` /
 * `recordAssistantMessage` / `recordToolUse` / `recordToolResult` /
 * `recordCompaction` / `recordError`），但内部全部翻译成 envelope events
 * 序列再写入。这样宿主代码（ElectronAgentHost / DaemonAgentHost）的 record*
 * 调用零修改，但落盘形态切到新协议。
 *
 * **Wave 2 关键决策**：
 *   1. 不留 v1 兼容读路径：构造时检测旧 jsonl（首行带 `type: 'user' |
 *      'assistant' | 'tool_use' | ...` 但无 `payload` / `uuid` / `parentUuid`）
 *      → truncate 重建。"温柔过渡全是技术债"。
 *   2. 元事件白名单不写 messages.jsonl：仅 6 件套（message_* + content_block_*）
 *      落盘——messages.jsonl 只承担"对话内容时间轴"职责。元事件（lifecycle /
 *      done / system_notice / step / llm_request / billing 等）由
 *      `eventStorage`（debug-obs 通道）单独落盘。
 *   3. record_compaction / record_error 这两个老 API 仍保留——内部翻译为
 *      compaction / lifecycle:error envelope event 写入 jsonl（虽然按 (2) 这
 *      两类不属 6 件套；但它们恰好是 LLM history 还原必需的边界标记，例外
 *      处理）。
 *   4. dispose() 兜底：若有 active message（host 通过 appendStreamEvent 写了
 *      message_start 但 daemon crash 导致 message_stop 没 emit），追加一条
 *      `message_stop` 让 restore 阶段能正常 close 那条不完整 message。
 *
 * Write serialisation 仍走 Promise queue + buffer flush（500 ms / 10 行）；
 * fsync 由底层 `appendFile` 决定，不强制每行 fsync——dogfood 阶段优先性能。
 *
 * 详见 `docs/agent-runtime/wire-protocol.md` §4。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import {
  CompactionRecordEvent,
  RewindMarkEvent,
} from '../event/events/compaction-events.js';
import { RuntimeLifecycleEvent } from '../event/events/observability-events.js';
import { StoredContentEvent } from '../event/events/content-events.js';
import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../engine/contracts/conversation.js';
import type {
  TranscriptEntry,
  SessionConfig,
  CompactResult,
} from '../engine/contracts/context-capability.js';
import { ContentBlockEvents, StreamEvents, PROTOCOL_VERSION_V2 } from '../engine/contracts/stream-events.js';
import {
  projectTerminalToolResult,
  type TerminalToolProjectionBlock,
} from '../projection/terminal-tool-projector.js';
import {
  reconstructMessagesFromTranscriptEntries,
  computeRewindCommitPrefixLength,
} from './reconstruct-transcript-messages.js';
import {
  MessageBlockStorage,
  reconstructMessagesFromBlockRecords,
} from './message-block-storage.js';
import type {
  MessageBlockRecord,
} from './message-block-storage.js';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — triggers onCompact hint
const TAIL_SCAN_BYTES = 64 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

const RUNTIME_VERSION_TAG = 'tabtin-runtime-v2';

export interface ModelProjectionRecord {
  version: number;
  recorded_at: string;
  projection_type: 'tool';
  tool_call_id: string;
  tool_name: string;
  projection: TerminalToolProjectionBlock;
}

export interface TimelineRewindTarget {
  messageId?: string;
  role?: 'user' | 'assistant';
  content?: string;
  /** 1-based occurrence among non-context messages with the same role/content. */
  occurrenceIndex?: number;
}

export interface ApplyTimelineRewindInput {
  target: TimelineRewindTarget;
  mode: 'rollback' | 'editAndResend';
  fallbackKeepMessageCount?: number;
}

export interface TimelineRewindMessageRef {
  messageId?: string;
  role: 'user' | 'assistant';
  messageKind?: string;
}

export interface ApplyTimelineRewindResult {
  applied: boolean;
  keepMessageCount: number | null;
  visibleMessages: TimelineRewindMessageRef[];
  hiddenMessages: TimelineRewindMessageRef[];
}

function readCommandFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim().length > 0 ? command.trim() : undefined;
}

function normaliseText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function textFromContentBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function isRuntimeContextInjection(content: string, messageKind: string | undefined): boolean {
  if (
    messageKind === 'environment_context'
    || messageKind === 'agent_profile_context'
    || messageKind === 'system_prompt_context'
    || messageKind === 'external_archive_context'
  ) return true;
  const trimmed = content.trim();
  return trimmed.startsWith('<context type="environment"')
    || trimmed.startsWith("<context type='environment'")
    || trimmed.startsWith('<context type="agent-profile"')
    || trimmed.startsWith("<context type='agent-profile'");
}

function isTimelineMessageContextInjection(message: { blocks: ContentBlock[]; messageKind?: string }): boolean {
  return isRuntimeContextInjection(textFromContentBlocks(message.blocks), message.messageKind);
}

function toTimelineRewindMessageRef(message: {
  messageId?: string;
  role: 'user' | 'assistant' | 'system';
  messageKind?: string;
}): TimelineRewindMessageRef {
  return {
    ...(message.messageId ? { messageId: message.messageId } : {}),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    ...(message.messageKind ? { messageKind: message.messageKind } : {}),
  };
}

function extractTailEntryState(parsed: TranscriptEntry): {
  version?: number;
  uuid?: string | null;
  type?: string | null;
  seq?: number;
} {
  const payloadSeq = (parsed.payload as { _seq?: unknown } | undefined)?._seq;
  return {
    ...(typeof parsed.version === 'number' ? { version: parsed.version } : {}),
    ...(typeof parsed.uuid === 'string' ? { uuid: parsed.uuid } : { uuid: null }),
    ...(typeof parsed.type === 'string' ? { type: parsed.type } : { type: null }),
    ...(typeof payloadSeq === 'number' ? { seq: payloadSeq } : {}),
  };
}

function parseTailLineState(line: string): ReturnType<typeof extractTailEntryState> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as TranscriptEntry;
    return parsed ? extractTailEntryState(parsed) : null;
  } catch {
    // skip malformed
    return null;
  }
}

function resolveTimelineTargetIndex(
  messages: Array<{
    messageId?: string;
    role: 'user' | 'assistant' | 'system';
    blocks: ContentBlock[];
    messageKind?: string;
  }>,
  target: TimelineRewindTarget,
): number {
  if (target.messageId) {
    const byId = messages.findIndex((message) => message.messageId === target.messageId);
    if (byId >= 0) return byId;
  }

  if (!target.role || !target.content) return -1;
  const targetText = normaliseText(target.content);
  if (!targetText) return -1;

  const occurrenceIndex = typeof target.occurrenceIndex === 'number' && target.occurrenceIndex > 0
    ? Math.floor(target.occurrenceIndex)
    : undefined;
  let seen = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate.role !== target.role) continue;
    if (isTimelineMessageContextInjection(candidate)) continue;
    if (normaliseText(textFromContentBlocks(candidate.blocks)) !== targetText) continue;
    seen += 1;
    if (occurrenceIndex === undefined || seen === occurrenceIndex) return index;
  }
  return -1;
}

function computeRuntimeKeepMessageCount(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; blocks: ContentBlock[]; messageKind?: string }>,
  targetIdx: number,
  mode: 'rollback' | 'editAndResend',
): number {
  const target = messages[targetIdx];
  // 「回退到此位置」：assistant 目标**保留**这条回复本身（keep = targetIdx + 1，
  // 仅移除其后），与后端 _build_revert_visible_message_filter 的 assistant id__lte
  // 可见边界一致（ 姊妹缺陷：曾用 targetIdx 剔除该 assistant 目标）。
  if (target.role === 'assistant' && mode === 'rollback') return targetIdx + 1;

  for (let index = targetIdx - 1; index >= 0; index -= 1) {
    if (!isTimelineMessageContextInjection(messages[index])) return index + 1;
  }
  return 0;
}

export class SessionStorage {
  private readonly filePath: string;
  /** Phase 2: per-session subdirectory ({sessionDir}/{sessionId}/) */
  readonly sessionSubDir: string;
  /**
   *  message block 权威：消息级 block 存储（message-blocks.jsonl）。
   * persist_message / recordUserMessage / compaction 边界在此落盘，跨轮 LLM
   * 历史与本机前端渲染优先读它；六件套 messages.jsonl 降级为流式编码 + 调试留档。
   */
  readonly blockStorage: MessageBlockStorage;
  private version = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_THRESHOLD = 10;

  /** Wave 2: 链表化 parentUuid —— 上一条 entry 的 uuid。首条为 null。 */
  private lastUuid: string | null = null;

  /**
   * Wave 2: dispose 兜底用——追踪 host 通过 appendStreamEvent 写入的最后一条
   * message_start 的 message_id。message_stop 出现时清零；非空时 dispose 必须
   * 补一条 fallback message_stop 让消费方 reconcile 不会卡住"等 stop 永远等不到"。
   */
  private activeMessageId: string | null = null;
  private readonly pendingProjectionInputs = new Map<string, unknown>();

  /** Wave 2: 标识首条 message_start 已写入，决定是否要写 cwd / runtimeVersion。 */
  private firstMessageStartWritten = false;

  /**
   *  回退两段式：尾部存在未 commit 的 rewind 软标记时为 true。构造时从尾部
   * 扫描恢复，`recordRewindMark` 置 true，`commitRewind` / `clearRewind` 置 false。
   * 让宿主在发下一条消息前能廉价判断是否需要 `commitRewind`（避免每条消息都读盘）。
   */
  private _pendingRewind = false;

  /**
   * Wave 2 P1 修复：避免 _checkFileSize 每写必 statSync。
   * 构造时从真实 statSync 取一次 baseline；每次 _writeEnvelopeEntry 累加 byte 数。
   */
  private _estimatedFileSize = 0;

  /**
   * Wave 2: storage 内部自造的 envelope 的 _seq 起点。
   *
   * 与 query.ts 的 EnvelopeEmitter._seq 解耦——record* 路径下 storage 自己
   * 生成 envelope（host 调 recordUserMessage / recordToolResult 时），需要补
   * `_seq` 让消费端能按 _seq 排序。重启后从尾部最大 _seq 恢复，避免重复。
   */
  private storageSeq = 0;

  constructor(private readonly config: SessionConfig) {
    this.sessionSubDir = path.join(config.sessionDir, config.threadId);
    this.filePath = this._migrateToSubDir();
    this._ensureDir();
    this._truncateLegacyJsonlIfNeeded();
    this._loadStateFromTail();
    this.blockStorage = new MessageBlockStorage(config.sessionDir, config.threadId);
  }

  /**
   * Phase 2 backward-compatible migration:
   * - Old flat file exists AND subdirectory does NOT exist → move file into subdirectory
   * - Subdirectory already exists → use new path directly
   * - Neither exists (fresh session) → use new path (dir created by _ensureDir)
   */
  private _migrateToSubDir(): string {
    const oldFlat = path.join(this.config.sessionDir, `${this.config.threadId}.jsonl`);
    const newPath = path.join(this.sessionSubDir, 'messages.jsonl');

    if (fs.existsSync(oldFlat) && !fs.existsSync(this.sessionSubDir)) {
      fs.mkdirSync(this.sessionSubDir, { recursive: true });
      try {
        fs.renameSync(oldFlat, newPath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EXDEV') {
          fs.copyFileSync(oldFlat, newPath);
          fs.unlinkSync(oldFlat);
        } else if (code === 'ENOENT') {
          // Already migrated by a concurrent process — no-op
        } else {
          throw err;
        }
      }
    }

    return newPath;
  }

  /**
   * Wave 2: 检测旧 v1 jsonl（首行带 `type: 'user' | 'assistant' | 'tool_use' |
   * 'tool_result' | 'compact' | 'error'` 但缺 envelope 字段如 `payload` /
   * `uuid` / `parentUuid`）→ 直接 truncate。
   *
   * 不写 read-only adapter，不留 .v1.bak —— 产品没上线，旧数据丢失可接受。
   * 这是 W2 plan 的明确铁律（"温柔过渡全是技术债"）。
   *
   * **检测策略**：用字符串子串探测（不强制 JSON.parse 整段），避免单条
   * 超大 entry（如 80 KB tool_result）让首行 read window 不到完整 JSON
   * 时被误判为"损坏 jsonl"误删。规则：
   *
   *   1. 文件不存在 / 空 → 不动
   *   2. 64 KB 首段含子串 `"type":"agent.stream.` → 视为合法 envelope，不动
   *   3. 64 KB 首段含子串 `"type":"user"` / `"type":"assistant"` 等老枚举
   *      → 老 v1 jsonl，truncate
   *   4. 都不含 → 损坏，truncate
   */
  private _truncateLegacyJsonlIfNeeded(): void {
    if (!fs.existsSync(this.filePath)) return;
    let fd: number | null = null;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size === 0) return;
      const readSize = Math.min(STREAM_CHUNK_BYTES, stat.size);
      const buf = Buffer.allocUnsafe(readSize);
      fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buf, 0, readSize, 0);
      const text = buf.toString('utf-8');

      // 检测 envelope 子串——首段含此即视为 W2 jsonl
      const isEnvelope = text.includes('"type":"agent.stream.');
      if (isEnvelope) return;

      // 检测老 v1 枚举子串（带 quote 防误伤业务字段名）
      const legacyPatterns = [
        '"type":"user"',
        '"type":"assistant"',
        '"type":"tool_use"',
        '"type":"tool_result"',
        '"type":"compact"',
        '"type":"system"',
        '"type":"error"',
      ];
      const isLegacy = legacyPatterns.some((p) => text.includes(p));

      if (isLegacy) {
        try { fs.closeSync(fd); fd = null; } catch { /* ignore */ }
        // 用 truncate 把文件清空到 0 字节（保留文件本身），让上层 mkdir/append
        // 路径不需要重建文件元信息——比 unlink + 重建语义更轻。
        fs.truncateSync(this.filePath, 0);
        return;
      }

      // 既不是 envelope 也不是 legacy —— 半行损坏 / 极特殊场景。保守不删，
      // 后续 loadTranscript 会跳过坏行，新写入照常 append。
    } catch {
      // 任何 IO 错误都不阻塞构造 —— 后续 _writeEnvelopeEntry 自己会重建文件。
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  // ── Public record helpers ──────────────────────────────────────────

  /**
   * 记录 user 消息（六件套写 messages.jsonl，历史行为不变）。
   *
   * `opts.messageId`：宿主传入与 relay `client_event_id` 一致的最终 id
   * （ id 收口——message_start.message_id 与 Django ChatMessage 同 id，
   * 回退定位 / 消息级对账都能按 id 命中）；缺省时生成 local-* id（存量行为）。
   *
   * ：本方法**不**写 message-blocks.jsonl——block 记录是流水线产物
   * （persist_message / 宿主显式 `appendUserBlockRecord`），record* API 保持
   * 六件套语义，避免 record*-only 消费方产出「只有 user 没有 assistant」的
   * 半截 block 文件误当权威。
   */
  async recordUserMessage(
    message: Message,
    opts?: { messageId?: string; triggeredBy?: string; source?: string },
  ): Promise<void> {
    const role = persistedRoleForPayload({
      ...(opts?.triggeredBy ? { triggered_by: opts.triggeredBy } : {}),
      ...(opts?.source ? { source: opts.source } : {}),
    });
    await this._appendMessageEnvelope(role, message, opts?.messageId, undefined, {
      ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      ...(opts?.source ? { source: opts.source } : {}),
    });
  }

  async recordSystemMessage(
    message: Message,
    opts?: {
      messageId?: string;
      messageKind?: string;
      triggeredBy?: string;
      source?: string;
    },
  ): Promise<void> {
    await this._appendMessageEnvelope('system', message, opts?.messageId, undefined, {
      ...(opts?.messageKind ? { messageKind: opts.messageKind } : {}),
      ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      ...(opts?.source ? { source: opts.source } : {}),
    });
  }

  async recordAssistantMessage(message: Message): Promise<void> {
    await this._appendMessageEnvelope('assistant', message);
  }

  async recordToolUse(
    toolName: string,
    toolCallId: string,
    input: unknown,
  ): Promise<void> {
    const message: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolCallId, name: toolName, input } as ToolUseBlock,
      ],
    };
    await this._appendMessageEnvelope('assistant', message);
  }

  async recordToolResult(
    toolCallId: string,
    content: string,
    isError?: boolean,
  ): Promise<void> {
    const message: Message = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolCallId,
          content,
          ...(isError ? { is_error: true } : {}),
        } as ToolResultBlock,
      ],
    };
    await this._appendMessageEnvelope('user', message);
  }

  rememberToolInputForProjection(toolCallId: string, input: unknown): void {
    this.pendingProjectionInputs.set(toolCallId, input);
  }

  async recordTerminalToolProjection(
    toolCallId: string,
    input: unknown,
    output: unknown,
    isError?: boolean,
  ): Promise<void> {
    const cachedInput = this.pendingProjectionInputs.get(toolCallId);
    this.pendingProjectionInputs.delete(toolCallId);
    const projectionInput = input ?? cachedInput;
    const command = readCommandFromToolInput(projectionInput);
    const projection = projectTerminalToolResult({
      toolCallId,
      command,
      output,
      isError,
      sessionId: this.config.threadId,
    });
    await this._appendModelProjection({
      version: 1,
      recorded_at: new Date().toISOString(),
      projection_type: 'tool',
      tool_call_id: toolCallId,
      tool_name: 'run_terminal_command',
      projection,
    });
  }

  async recordCompaction(result: CompactResult): Promise<void> {
    const truncatedSummary = this._truncateStringForStorage(result.summary);
    const compactionEvent = new CompactionRecordEvent({
      summary: truncatedSummary,
      tokens_freed: result.tokensFreed,
      mode: result.mode,
    }).toStreamEvent();
    await this._writeEnvelopeEntry(compactionEvent);
  }

  async recordError(error: string): Promise<void> {
    const truncatedError = this._truncateStringForStorage(error);
    const errorEvent = new RuntimeLifecycleEvent({
      phase: 'error',
      status: 'error',
      error_message: truncatedError,
    }).toStreamEvent();
    await this._writeEnvelopeEntry(errorEvent);
  }

  // ──  对话回退：transcript 软回退（rewind）─────────────────────────

  /** 尾部是否存在未 commit 的 rewind 软标记（宿主发消息前据此决定是否 commit）。 */
  hasPendingRewind(): boolean {
    return this._pendingRewind;
  }

  /**
   * ：把回退目标（DB message_id + role）解析成 transcript 重建后的「保留消息条数」。
   *
   * 流式 assistant 落盘的 message_start.message_id === DB ChatMessage.id，故 assistant
   * 目标可直接按 id 命中——**不依赖 checkpoint_state_index**（纯对话轮次没有 checkpoint，
   * revert_state_index 为空，这是本方法存在的根因）。rollback 边界：assistant 目标
   * keep=index+1（**保留**该 assistant 回复、仅剔除其后，对齐后端 id__lte 可见边界）；
   * user 目标 keep=index（剔除该 user 及其后）。
   * 未命中回退到 fallbackKeepCount（= revert_state_index，可能缺），都没有则返回 null。
   */
  async resolveRewindKeepCount(
    targetMessageId: string | undefined,
    targetRole: 'user' | 'assistant' | undefined,
    fallbackKeepCount?: number,
  ): Promise<number | null> {
    if (targetMessageId) {
      await this.flushPendingWrites();
      const entries = await this.loadTranscript();
      const messages = reconstructMessagesFromTranscriptEntries(entries);
      const idx = messages.findIndex((m) => m.messageId === targetMessageId);
      // assistant 目标保留其本身（keep = idx + 1，仅移除其后）；user 目标移除该
      // user 及其后（keep = idx）。对齐后端可见边界与 UI。
      if (idx >= 0) return targetRole === 'assistant' ? idx + 1 : idx;
    }
    return typeof fallbackKeepCount === 'number' && fallbackKeepCount >= 0
      ? Math.floor(fallbackKeepCount)
      : null;
  }

  /**
   * Runtime-authoritative rollback boundary resolution.
   *
   * UI and Django may carry different message id namespaces for user messages
   * (server UUID / client_event_id / local transcript id). The runtime timeline is
   * the only source that can decide what the LLM will actually see, so rollback
   * requests should pass a target ref here and let transcript reconstruction
   * decide the keep boundary before any follow-up send or relay reconcile.
   */
  async applyTimelineRewind(input: ApplyTimelineRewindInput): Promise<ApplyTimelineRewindResult> {
    await this.flushPendingWrites();
    const entries = await this.loadTranscript();
    const messages = reconstructMessagesFromTranscriptEntries(entries);
    const targetIdx = resolveTimelineTargetIndex(messages, input.target);
    if (targetIdx < 0) {
      if (typeof input.fallbackKeepMessageCount === 'number' && input.fallbackKeepMessageCount >= 0) {
        const keep = Math.floor(input.fallbackKeepMessageCount);
        await this.recordRewindMark(keep);
        return {
          applied: true,
          keepMessageCount: keep,
          visibleMessages: messages.slice(0, keep).map(toTimelineRewindMessageRef),
          hiddenMessages: messages.slice(keep).map(toTimelineRewindMessageRef),
        };
      }
      return {
        applied: false,
        keepMessageCount: null,
        visibleMessages: messages.map(toTimelineRewindMessageRef),
        hiddenMessages: [],
      };
    }

    const keepMessageCount = computeRuntimeKeepMessageCount(messages, targetIdx, input.mode);
    await this.recordRewindMark(keepMessageCount);
    return {
      applied: true,
      keepMessageCount,
      visibleMessages: messages.slice(0, keepMessageCount).map(toTimelineRewindMessageRef),
      hiddenMessages: messages.slice(keepMessageCount).map(toTimelineRewindMessageRef),
    };
  }

  /**
   * 写入回退软标记（不删行，可 unrevert）。`keepMessageCount` = 重建后保留的
   * user/assistant 消息条数（对齐 Django `revert_state_index`）。重建时
   * `reconstructMessagesFromTranscriptEntries` 行内识别此标记并截断上下文，故写完
   * 即生效；物理截断由 `commitRewind` 在发下一条消息前完成。
   */
  async recordRewindMark(keepMessageCount: number): Promise<void> {
    const keep = Number.isFinite(keepMessageCount) && keepMessageCount > 0
      ? Math.floor(keepMessageCount)
      : 0;
    await this._writeEnvelopeEntry(new RewindMarkEvent(keep).toStreamEvent());
    this._pendingRewind = true;
  }

  /**
   * 物理截断：把 transcript 落盘内容裁到尾部 rewind 标记定义的边界，并丢弃标记本身。
   * 与 Django `cleanup_reverted_messages` 两段式对称，由宿主在 `recordUserMessage`
   * 之前调用。无待 commit 标记时 no-op。
   *
   * 返回**回退边界时间 `cut_ts`**（被截断掉的第一条 entry 的 timestamp，epoch ms）：
   * 宿主据此物理截断 `events.jsonl`，删除回退区间内的 user/persist_message，
   * 不把被回退删除的消息当"落库丢失"重放复活。
   * messages.jsonl 与 events.jsonl 消息标识不同源（前者 record* 造
   * local-id，后者流式 id），无法按 message_id 跨文件对齐，故锚点落到时间轴——回退
   * 边界总在对话轮次之间（秒级间隔），时间对齐安全。无截断 / 无可定位边界时返回 null。
   */
  async commitRewind(): Promise<number | null> {
    if (!this._pendingRewind) return null;
    await this.flushPendingWrites();
    const entries = await this.loadTranscript();
    const prefixLen = computeRewindCommitPrefixLength(entries);
    if (prefixLen === null) {
      // 尾部已无待 commit 标记（已被新消息覆盖）——清掉内存 flag 即可。
      this._pendingRewind = false;
      return null;
    }
    // 被截断掉的第一条 entry 的时间 = 回退边界 cut_ts。prefixLen 指向保留前缀之后的
    // 第一条（被删的第一条消息 message_start，或累计不足时的 rewind 标记本身）。
    const cutEntry = entries[prefixLen];
    const cutTs = cutEntry ? Date.parse(cutEntry.timestamp) : Number.NaN;
    await this._rewriteEntries(entries.slice(0, prefixLen));
    this._pendingRewind = false;
    if (Number.isFinite(cutTs)) {
      // ：message-blocks.jsonl 与 messages.jsonl / events.jsonl 同锚点物理
      // 截断，回退后 block 权威不残留被回退轮次（与  三层对称删同理）。
      try {
        await this.blockStorage.truncateFrom(cutTs);
      } catch (err) {
        try {

          console.warn(
            `[storage] message-block rewind truncate failed: ${(err as Error)?.message ?? err}`,
          );
        } catch { /* ignore log error */ }
      }
      return cutTs;
    }
    return null;
  }

  /**
   * 撤销回退（unrevert）：移除尾部那条 rewind 软标记，让被回退的轮次重新可见。
   * 仅当标记仍处于「待 commit」（其后无新消息）时有效；否则 no-op。
   */
  async clearRewind(): Promise<void> {
    if (!this._pendingRewind) return;
    await this.flushPendingWrites();
    const entries = await this.loadTranscript();
    let markerIdx = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].type === StreamEvents.REWIND) { markerIdx = i; break; }
      if (entries[i].type === ContentBlockEvents.MESSAGE_STOP) break;
    }
    if (markerIdx < 0) {
      this._pendingRewind = false;
      return;
    }
    const kept = entries.filter((_, idx) => idx !== markerIdx);
    await this._rewriteEntries(kept);
    this._pendingRewind = false;
  }

  /**
   * 用给定 entries 整体重写 messages.jsonl，并把内部写状态（version / lastUuid /
   * storageSeq / 文件大小估算）按重写后内容复位。经 writeQueue 串行，避免与在途
   * append 交错。
   */
  private async _rewriteEntries(entries: TranscriptEntry[]): Promise<void> {
    const historyText = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
    this.writeQueue = this.writeQueue.then(async () => {
      this._ensureDir();
      //  buffer 清空竞态：调用方（commitRewind / clearRewind）在 loadTranscript
      // 时已 flush，进入时 buffer 通常为空；但 writeQueue 的 await 会让出事件循环，
      // 期间并发的 _writeEnvelopeEntry 可能追加**回退边界之后**的新条目（尚未落盘、
      // 不在 entries 内，如并发 environment context 记录）。原实现事后 `this.buffer = []`
      // 会把这些新内容无声丢弃——这正是 rewind 标记 / 消息闭合事件消失的机制之一。
      // 改为把 buffer 里这些新条目 splice 出来接在截断历史之后一起原子写入：它们的
      // version/_seq 由 append 时的 live 计数器递增分配，恒大于 entries 中的历史版本，
      // 拼接后仍单调，且成为文件新尾部，下方 _loadStateFromTail 据此复位状态、链路连续。
      const pending = this.buffer.splice(0).join('');
      await fs.promises.writeFile(this.filePath, historyText + pending, { mode: 0o600 });
    });
    await this.writeQueue;
    this.activeMessageId = null;
    this._loadStateFromTail();
  }

  // ── 新协议：直接 append envelope event（host 桥用） ─────────────────

  /**
   * Wave 2 host bridge 通道：直接 append 一条 StreamEvent。
   *
   * 适用场景：ElectronAgentHost / DaemonAgentHost 把 query 流出的所有 envelope
   * event（含 6 件套 + 元事件）落盘到 messages.jsonl，让 daemon crash 后能完整
   * 还原 message stream（不仅是 record* 抽象出的 Message 形态）。
   *
   * `event` 必须是已经带完整公共字段的 envelope event（`event_type` /
   * `protocol_version` / `_seq` / `trace_id` / `thread_id` / `message_id`）。
   * 本方法不再补这些字段；如缺失会在 restoreMessages 时被识别为"不完整"丢弃。
   *
   * **过滤策略**：本方法只接受 6 件套（message_* + content_block_*）+
   * compaction / lifecycle:error（边界标记）—— 元事件（done / system_notice /
   * step / llm_request 等）会被静默 drop，不写 messages.jsonl（它们由
   * `eventStorage` debug-obs 通道单独落盘）。
   *
   * **Active message 跟踪**：监听 message_start / message_stop 维护
   * `activeMessageId`，用于 dispose 兜底——daemon crash 时如果仍有 active
   * message 没 close，dispose 追加一条 fallback `message_stop`，
   * 让 restore 阶段能正常关闭那条不完整 message。
   */
  async appendStreamEvent(event: StreamEvent): Promise<void> {
    // ：persist_message（消息完整边界的 blocks_json 整包）不进 messages.jsonl，
    // 原样落到 message-blocks.jsonl——与 Django `_write_persist_messages` 同 payload。
    if (event.type === StreamEvents.PERSIST_MESSAGE) {
      await this._appendPersistBlockRecord(event);
      return;
    }
    if (!this._isPersistableEnvelope(event)) return;
    await this._writeEnvelopeEntry(event);
    this._trackActiveMessageId(event);
  }

  // ──  message block 权威：block 记录写入 ───────────────────────

  /**
   * 宿主显式写 user block 记录（与 `recordUserMessage` 六件套配对调用）。
   *
   * 为什么不并进 `recordUserMessage`：block 文件只有在「user + assistant 全量
   * 经流水线写入」时才配当权威。assistant 记录来自 persist_message 事件路由，
   * record* API（含测试 / 遗留消费方）不发 persist——若 recordUserMessage 隐式
   * 写 block，会产出只有 user 的半截文件并被 restore 误当权威。宿主生产链路
   * 两条都接（recordUserMessage + 本方法 / persist 路由），才形成完整文件。
   */
  async appendUserBlockRecord(
    rawMessage: Message,
    opts?: {
      messageId?: string;
      messageKind?: string;
      triggeredBy?: string;
      source?: string;
      role?: 'user' | 'system';
    },
  ): Promise<void> {
    const message = this._truncateMessageForStorage(rawMessage);
    const blocks: ContentBlock[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content } as ContentBlock]
      : message.content;
    await this._appendBlockRecord({
      v: 1,
      recorded_at: new Date().toISOString(),
      message_id: opts?.messageId
        ?? `local-${this.config.threadId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: opts?.role ?? persistedRoleForPayload({
        message_kind: opts?.messageKind,
        triggered_by: opts?.triggeredBy,
        source: opts?.source,
      }),
      message_kind: opts?.messageKind ?? 'llm',
      blocks_json: blocks,
      // push 通知等 host 内部触发的消息把触发来源落进 block 记录 metadata，
      // 让优先恢复源（message-blocks.jsonl）重载后仍能渲染成收敛卡。
      ...(opts?.triggeredBy || opts?.source
        ? {
            metadata: {
              ...(opts.triggeredBy ? { triggered_by: opts.triggeredBy } : {}),
              ...(opts.source ? { source: opts.source } : {}),
            },
          }
        : {}),
    });
  }

  /**
   * 存量会话一次性 backfill：block 文件为空而六件套有历史时，把六件套重放结果
   * 物化成 block 记录，保证「block 权威」切换后老会话历史不丢。
   *
   * `recorded_at` 沿用六件套消息的原始时间——回退截断（truncateFrom(cutTs)）
   * 按时间锚点删行，backfill 记录若统一盖当前时间会被误删/误留。
   * 宿主在每轮 query 写入本轮 user 之前调用（幂等：已有记录即 no-op）。
   */
  async ensureBlockBackfillFromTranscript(): Promise<void> {
    if (this.blockStorage.hasRecords()) return;
    const entries = await this.loadTranscript();
    if (entries.length === 0) return;
    const reconstructed = reconstructMessagesFromTranscriptEntries(entries);
    for (const message of reconstructed) {
      if (message.blocks.length === 0) continue;
      await this._appendBlockRecord({
        v: 1,
        recorded_at: message.timestamp ?? new Date().toISOString(),
        message_id: message.messageId
          ?? `backfill-${this.config.threadId.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}`,
        role: message.role,
        message_kind: message.messageKind ?? 'llm',
        blocks_json: message.blocks,
        ...(typeof message.arrivalSeq === 'number' ? { arrival_seq: message.arrivalSeq } : {}),
        ...(message.stopReason ? { stop_reason: message.stopReason } : {}),
        ...(message.subagentRunId ? { subagent_run_id: message.subagentRunId } : {}),
        // ：六件套回放若带 triggeredBy，backfill 必须透传到 blocks，否则
        // 切会话后永久丢失 push 收敛卡标记。
        ...(message.triggeredBy || message.source
          ? { metadata: {
              ...(message.triggeredBy ? { triggered_by: message.triggeredBy } : {}),
              ...(message.source ? { source: message.source } : {}),
            } }
          : {}),
      });
    }
    await this.blockStorage.flushPendingWrites();
  }

  private async _appendPersistBlockRecord(event: StreamEvent): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const messageId = typeof payload.message_id === 'string' ? payload.message_id : '';
    const role = payload.role === 'assistant'
      ? 'assistant'
      : persistedRoleForPayload(payload) === 'system'
        ? 'system'
        : 'user';
    const blocks = Array.isArray(payload.blocks_json)
      ? (payload.blocks_json as unknown as ContentBlock[])
      : [];
    const messageKind = typeof payload.message_kind === 'string' ? payload.message_kind : 'llm';
    const errorInfoJson = payload.error_info_json && typeof payload.error_info_json === 'object'
      ? payload.error_info_json as Record<string, unknown>
      : undefined;
    // hitl_interaction 是纯 metadata 消息（无内容块，面板由 metadata.hitl 驱动）——
    // 放行空块记录（Django ChatMessage 同样允许 content_blocks_json=[]）。其余 kind
    // 仍要求非空块，避免半截 message_start 落成空记录。
    if (!messageId) return;
    if (blocks.length === 0 && messageKind !== 'hitl_interaction' && !errorInfoJson) return;
    await this._appendBlockRecord({
      v: 1,
      recorded_at: new Date().toISOString(),
      message_id: messageId,
      role,
      message_kind: messageKind,
      blocks_json: blocks,
      // 压缩检查点（CompactionController 发的 persist_message，DB 侧同一行落
      // ChatMessage kind=compaction_summary）：block 重建以它为历史截断边界。
      ...(messageKind === 'compaction_summary' ? { compaction_boundary: true } : {}),
      ...(typeof payload.arrival_seq === 'number' ? { arrival_seq: payload.arrival_seq } : {}),
      ...(typeof payload.stop_reason === 'string' ? { stop_reason: payload.stop_reason } : {}),
      ...(typeof payload.subagent_run_id === 'string'
        ? { subagent_run_id: payload.subagent_run_id }
        : {}),
      ...(payload.partial === true ? { partial: true } : {}),
      ...(payload.metadata && typeof payload.metadata === 'object'
        ? { metadata: payload.metadata as Record<string, unknown> }
        : {}),
      ...(errorInfoJson ? { error_info_json: errorInfoJson } : {}),
    });
  }

  private async _appendBlockRecord(record: MessageBlockRecord): Promise<void> {
    try {
      await this.blockStorage.append(record);
    } catch (err) {
      // block 记录失败不阻塞六件套主链路；restore 侧会回落六件套重放。
      try {

        console.warn(
          `[storage] message-block append failed: ${(err as Error)?.message ?? err}`,
        );
      } catch { /* ignore log error */ }
    }
  }

  // ── Load / Restore ─────────────────────────────────────────────────

  /**
   * Wave 2: 流式逐行解析 envelope events。返回 TranscriptEntry[]（W2 envelope
   * 形态）—— 调用方按 entry.type 分发处理（content_block_* / message_* / 等）。
   *
   * 老 `loadTranscript()` 现在是 `loadEnvelopeStream` 的 alias。原"返回老
   * TranscriptEntry"的语义已无（老 schema 删除）。
   */
  async loadTranscript(): Promise<TranscriptEntry[]> {
    // W6：读盘前先把内存 buffer 落盘，保证 read-after-write 一致。
    // 写入路径（recordUserMessage / appendStreamEvent → _writeEnvelopeEntry）带
    // 500ms 缓冲：未达 FLUSH_THRESHOLD 时只塞进 this.buffer + 起定时器就立即返回，
    // 数据尚未落盘。restoreMessages 把本方法读到的磁盘内容当跨轮历史权威源（W6），
    // 若不先 flush，会读到「上一轮刚写、还在 buffer 里」的消息缺失的陈旧历史
    // ——表现为下一轮看不到上一轮的 assistant 回复 / environment context。
    await this.flushPendingWrites();
    if (!fs.existsSync(this.filePath)) return [];

    const entries: TranscriptEntry[] = [];
    const stream = fs.createReadStream(this.filePath, {
      encoding: 'utf-8',
      highWaterMark: STREAM_CHUNK_BYTES,
    });
    try {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as TranscriptEntry;
          if (
            parsed
            && typeof parsed.type === 'string'
            && typeof parsed.uuid === 'string'
            && parsed.payload !== undefined
          ) {
            entries.push(parsed);
          }
        } catch {
          // skip malformed lines
        }
      }
    } finally {
      if (!stream.destroyed) stream.destroy();
    }
    return entries;
  }

  /**
   * 从 envelope events 序列重建 Message[]，喂给 LLM 做 history。
   *
   * 重建逻辑：
   *   - message_start (role) → 开新 active message
   *   - content_block_start → push block 到 active.blocks（已 structuredClone
   *     防止 delta 累积污染原 envelope payload）
   *   - content_block_delta → 按 delta.type 累积到对应 block 字段
   *     （text_delta / thinking_delta / signature_delta / input_json_delta）
   *   - content_block_stop → 若是 tool_use 块，把累积的 partial_json parse
   *     成 JSON 写入 block.input
   *   - message_stop → 完成 active message，push 到 messages[]
   *   - compaction:done → **清空之前的 messages[]**，从下一条 message 开始重建
   *   - lifecycle:error → 跳过（不影响 LLM history）
   *
   * **配对约束保留**（W2 plan §六 兼容点）：tool_use 与 tool_result 通过
   * envelope 中的 `tool_use_id` 对应；上层（select-recent-history.ts /
   * filterUnresolvedToolUses）若发现配对断裂会兜底剔除 —— 本函数不强制
   * 配对，纯按落盘顺序重放。
   */
  async restoreMessages(): Promise<Message[]> {
    //  message block 权威：block 文件有内容时优先从消息级记录重建——
    // 无需六件套重放，直接就是 `{role, content: blocks}`，且遵守 compaction 边界。
    //
    // 两个回落条件（零回归护栏）：
    //   1. 存量会话无 block 文件 → 六件套重放；
    //   2. 有未 commit 的 rewind 软标记 → 六件套重放（标记语义按六件套消息数
    //      计数，reconstruct 行内处理；block 文件的物理截断在 commitRewind 完成）。
    //
    if (!this._pendingRewind) {
      // hasRecords 是同步探盘——先 flush 内存 buffer，保证 read-after-write 一致
      // （与 loadTranscript 的 flushPendingWrites 同理）。
      await this.blockStorage.flushPendingWrites();
    }
    if (!this._pendingRewind && this.blockStorage.hasRecords()) {
      const records = await this.blockStorage.load();
      if (records.length > 0) {
        return reconstructMessagesFromBlockRecords(records);
      }
    }
    const entries = await this.loadTranscript();
    const reconstructed = reconstructMessagesFromTranscriptEntries(entries);
    return reconstructed.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.blocks,
    }));
  }

  /**
   * 读取 message-blocks 记录。失败或无文件时返回 []。
   */
  async loadBlockRecords(): Promise<MessageBlockRecord[]> {
    await this.blockStorage.flushPendingWrites();
    if (!this.blockStorage.hasRecords()) return [];
    return this.blockStorage.load();
  }

  getVersion(): number {
    return this.version;
  }

  getFilePath(): string {
    return this.filePath;
  }

  getProjectionFilePath(): string {
    return path.join(this.sessionSubDir, 'model-projections.jsonl');
  }

  async loadModelProjections(): Promise<ModelProjectionRecord[]> {
    const filePath = this.getProjectionFilePath();
    if (!fs.existsSync(filePath)) return [];

    const records: ModelProjectionRecord[] = [];
    const stream = fs.createReadStream(filePath, {
      encoding: 'utf-8',
      highWaterMark: STREAM_CHUNK_BYTES,
    });
    try {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as ModelProjectionRecord;
          if (
            parsed
            && parsed.projection_type === 'tool'
            && typeof parsed.tool_call_id === 'string'
            && parsed.projection?.kind === 'model_projection'
          ) {
            records.push(parsed);
          }
        } catch {
          // skip malformed projection lines; raw archive remains authoritative
        }
      }
    } finally {
      if (!stream.destroyed) stream.destroy();
    }
    return records;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private _ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async _appendModelProjection(record: ModelProjectionRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const filePath = this.getProjectionFilePath();
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(filePath, line, 'utf-8');
    });
    await this.writeQueue;
  }

  /**
   * Wave 2: 从尾部窗口扫描 envelope entries 恢复 `version` + `lastUuid` +
   * `firstMessageStartWritten` 状态。
   *
   * `firstMessageStartWritten` 不能简单 100% 恢复（首条 entry 可能在尾部窗口
   * 之外），保守取 true（只要 jsonl 非空就视为已写过 —— 极少数会让重启后第二
   * 条 message_start 漏 cwd/runtimeVersion，可接受）。
   */
  private _loadStateFromTail(): void {
    if (!fs.existsSync(this.filePath)) {
      this._resetLoadedState();
      return;
    }

    try {
      const stat = fs.statSync(this.filePath);
      const fileSize = stat.size;
      this._estimatedFileSize = fileSize;
      if (fileSize === 0) {
        this.version = 0;
        this.lastUuid = null;
        this.firstMessageStartWritten = false;
        return;
      }
      this.firstMessageStartWritten = true;

      this._applyTailState(this._readTailLines(fileSize));
    } catch {
      this._resetLoadedState();
    }
  }

  private _readTailLines(fileSize: number): { lines: string[]; startIdx: number } {
    const readSize = Math.min(TAIL_SCAN_BYTES, fileSize);
    const offset = fileSize - readSize;
    const buf = Buffer.allocUnsafe(readSize);
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buf, 0, readSize, offset);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    return {
      lines: buf.toString('utf-8').split('\n'),
      startIdx: offset === 0 ? 0 : 1,
    };
  }

  private _applyTailState(input: { lines: string[]; startIdx: number }): void {
    let maxVersion = 0;
    let maxUuid: string | null = null;
    let maxSeq = -1;
    let lastEntryType: string | null = null;
    for (let i = input.startIdx; i < input.lines.length; i++) {
      const parsedState = parseTailLineState(input.lines[i]);
      if (!parsedState) continue;
      if (parsedState.version !== undefined && parsedState.version > maxVersion) {
        maxVersion = parsedState.version;
        maxUuid = parsedState.uuid ?? null;
        lastEntryType = parsedState.type ?? null;
      }
      if (parsedState.seq !== undefined && parsedState.seq > maxSeq) maxSeq = parsedState.seq;
    }
    this.version = maxVersion;
    this.lastUuid = maxUuid;
    this.storageSeq = maxSeq + 1;
    this._pendingRewind = lastEntryType === StreamEvents.REWIND;
  }

  private _resetLoadedState(): void {
    this.version = 0;
    this.lastUuid = null;
    this.firstMessageStartWritten = false;
    this._estimatedFileSize = 0;
  }

  private static readonly MAX_CONTENT_CHARS = 50_000;

  /**
   *  canonical result 契约：tool_result 在工具边界已限长一次（终端
   * canonical envelope ≤ shell.ts EXEC_RESULT_MAX_CHARS=150K），落盘必须无损
   * 保存同一形态——否则「本轮模型所见 ≠ 落盘 ≠ 下轮恢复」，跨轮字节稳定与
   * 前缀缓存会被落盘层这套二次改写打破（旧 50K 头5000+尾2000 挖空还会把
   * JSON envelope 切碎，下轮 slim 投影 parse 失败）。400K 仅作灾难保护，
   * 正常路径永不触发。
   */
  private static readonly TOOL_RESULT_STORAGE_MAX_CHARS = 400_000;

  /**
   * Flush buffered writes and release timer. Call on shutdown.
   *
   * Wave 2 兜底：若有 active message（host 通过 appendStreamEvent 写了
   * message_start 但 daemon crash 导致 message_stop 没 emit），追加一条
   * `message_stop`，让 restore 阶段能正常 close 那条不完整 message。
   */
  async dispose(): Promise<void> {
    if (this.activeMessageId !== null) {
      // Wave 2 P1 修复：补完整的 abort 边界——message_delta(stop_reason='aborted') +
      // message_stop。
      // 仅 message_stop 时消费方无法区分"crash 中断"vs"正常结束"，加 stop_reason
      // 让 W3 Django reconciliation / Renderer UI 都能正确显示中断标记。
      await this._writeEnvelopeEntry(new StoredContentEvent(
        ContentBlockEvents.MESSAGE_DELTA,
        {
          event_type: ContentBlockEvents.MESSAGE_DELTA,
          message_id: this.activeMessageId,
          delta: { stop_reason: 'aborted' },
        },
      ).toStreamEvent());
      await this._writeEnvelopeEntry(new StoredContentEvent(
        ContentBlockEvents.MESSAGE_STOP,
        {
          event_type: ContentBlockEvents.MESSAGE_STOP,
          message_id: this.activeMessageId,
        },
      ).toStreamEvent());
      this.activeMessageId = null;
    }
    await this._flush();
    await this.blockStorage.dispose().catch(() => undefined);
  }

  /**
   * 把内存 buffer 里尚未落盘的写入排进 writeQueue 并等待其完成。
   *
   * 写入路径有 500ms / FLUSH_THRESHOLD 缓冲（见 `_writeEnvelopeEntry`），`await
   * recordUserMessage` 返回时数据可能仍在 buffer 里。任何「读盘当权威」的消费方
   * （loadTranscript / restoreMessages / relay-reconcile）读之前必须先调本方法，
   * 否则会读到陈旧的半截历史（W6 ）。通过共享 writeQueue 串行化，保证与
   * 在途写入的顺序一致、不并发刷盘。
   */
  async flushPendingWrites(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this._flush());
    await this.writeQueue;
  }

  private _isPersistableEnvelope(event: StreamEvent): boolean {
    switch (event.type) {
      case ContentBlockEvents.MESSAGE_START:
      case ContentBlockEvents.MESSAGE_DELTA:
      case ContentBlockEvents.MESSAGE_STOP:
      case ContentBlockEvents.CONTENT_BLOCK_START:
      case ContentBlockEvents.CONTENT_BLOCK_DELTA:
      case ContentBlockEvents.CONTENT_BLOCK_STOP:
      case StreamEvents.COMPACTION:
      case StreamEvents.LIFECYCLE:
        return true;
      default:
        return false;
    }
  }

  /**
   * 把单条 Message 翻译成 envelope event 序列（5 件套：message_start +
   * content_block_start/[delta]/stop * N + message_stop），落盘并更新 version。
   */
  private async _appendMessageEnvelope(
    role: 'user' | 'assistant' | 'system',
    rawMessage: Message,
    presetMessageId?: string,
    writeOpts?: { timestampOverride?: string; cwdOverride?: string | null },
    envelopeOpts?: { messageKind?: string; triggeredBy?: string; source?: string },
  ): Promise<void> {
    const message = this._truncateMessageForStorage(rawMessage);
    const messageId = presetMessageId
      ?? `local-${this.config.threadId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const startEvent = new StoredContentEvent(
      ContentBlockEvents.MESSAGE_START,
      {
        event_type: ContentBlockEvents.MESSAGE_START,
        message_id: messageId,
        role,
        ...(envelopeOpts?.messageKind
          ? { message_kind: envelopeOpts.messageKind }
          : {}),
        ...(envelopeOpts?.triggeredBy
          ? { triggered_by: envelopeOpts.triggeredBy }
          : {}),
        ...(envelopeOpts?.source ? { source: envelopeOpts.source } : {}),
      },
    ).toStreamEvent();
    await this._writeEnvelopeEntry(startEvent, writeOpts);

    const content = message.content;
    const blocks: ContentBlock[] = typeof content === 'string'
      ? [{ type: 'text', text: content } as ContentBlock]
      : content;

    for (let idx = 0; idx < blocks.length; idx++) {
      const block = blocks[idx];
      const blockId = `local-blk-${idx}-${Math.random().toString(36).slice(2, 8)}`;

      // cb_start 写"空壳"（按 Anthropic 协议设计：start.block 仅含 type +
      // 初始值；完整内容应通过 delta 累积）。tool_use / image / document /
      // tool_result 等结构型 block 直接整体放 cb_start.block —— 它们没有
      // 自然 delta 累积语义（input_json_delta 是 partial JSON，但 record*
      // 路径下我们一次性完整 emit）。
      const shellBlock = makeStartBlockShell(block);
      const startBlockEvent = new StoredContentEvent(
        ContentBlockEvents.CONTENT_BLOCK_START,
        {
          event_type: ContentBlockEvents.CONTENT_BLOCK_START,
          message_id: messageId,
          index: idx,
          block_id: blockId,
          block: shellBlock,
        },
      ).toStreamEvent();
      await this._writeEnvelopeEntry(startBlockEvent, writeOpts);

      // 一次性完整 delta —— 不切 N 段（prompt 明确禁止"假流式切片"）。
      // 仅对内容型 block 写 delta（text / thinking / tool_use 三类）；
      // 结构型 block（tool_result / image / document / 等）整体内容已经
      // 在 cb_start.block 里，跳过 delta。
      const delta = makeFullDeltaFromBlock(block);
      if (delta) {
        const deltaEvent = new StoredContentEvent(
          ContentBlockEvents.CONTENT_BLOCK_DELTA,
          {
            event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            message_id: messageId,
            index: idx,
            delta,
          },
        ).toStreamEvent();
        await this._writeEnvelopeEntry(deltaEvent, writeOpts);
      }

      const stopBlockEvent = new StoredContentEvent(
        ContentBlockEvents.CONTENT_BLOCK_STOP,
        {
          event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
          message_id: messageId,
          index: idx,
        },
      ).toStreamEvent();
      await this._writeEnvelopeEntry(stopBlockEvent, writeOpts);
    }

    const stopEvent = new StoredContentEvent(
      ContentBlockEvents.MESSAGE_STOP,
      {
        event_type: ContentBlockEvents.MESSAGE_STOP,
        message_id: messageId,
      },
    ).toStreamEvent();
    await this._writeEnvelopeEntry(stopEvent, writeOpts);
  }

  /**
   * R5: Truncate oversized message content before writing to JSONL.
   * Keeps head + tail so context is not completely lost.
   */
  private _truncateMessageForStorage(msg: Message): Message {
    const contentStr =
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    if (contentStr.length <= SessionStorage.MAX_CONTENT_CHARS) return msg;

    if (typeof msg.content === 'string') {
      return {
        ...msg,
        content: this._truncateStringForStorage(msg.content),
      };
    }

    return {
      ...msg,
      content: (msg.content as ContentBlock[]).map((block) => {
        if (
          block.type === 'tool_result' &&
          typeof block.content === 'string' &&
          block.content.length > SessionStorage.TOOL_RESULT_STORAGE_MAX_CHARS
        ) {
          // 灾难保护：保头 + 尾注（不做中段挖空）。注意：若内容是 JSON envelope，
          // 截断产物不是合法 JSON（下轮 slim 投影会 parse 失败并原样保留）——
          // 正常路径受工具边界 150K 上限保护，永不触发；仅作极端兜底，
          // 不为不可能场景实现结构化截断。
          return {
            ...block,
            content:
              block.content.slice(0, SessionStorage.TOOL_RESULT_STORAGE_MAX_CHARS) +
              `\n[... tool result truncated for storage (${block.content.length} chars) ...]`,
          };
        }
        return block;
      }),
    };
  }

  private _truncateStringForStorage(text: string): string {
    if (text.length <= SessionStorage.MAX_CONTENT_CHARS) return text;
    return (
      text.slice(0, 5000) +
      '\n\n[... content truncated for storage (' +
      text.length +
      ' chars) ...]\n\n' +
      text.slice(-2000)
    );
  }

  /**
   * 单条 envelope event 落盘：补 TranscriptEntry 链表化字段（uuid /
   * parentUuid / timestamp / sessionId / version / 可选 cwd / runtimeVersion）+
   * payload 公共字段（protocol_version / trace_id / thread_id / _seq）+
   * JSON.stringify + buffer + flush 调度。
   *
   * **公共字段策略**：
   *   - 6 件套 envelope（message_* / content_block_*）：按 W1 schema 必须
   *     带 protocol_version / trace_id / thread_id / _seq —— record* 路径
   *     补全；appendStreamEvent 路径下 caller 自己已补（保留原 payload）。
   *   - 元事件（compaction / lifecycle）：W1 schema 不要求这些字段，但仍补
   *     `protocol_version` / `trace_id` 让消费端按统一规则解析（不影响 schema
   *     校验，多余字段 zod 默认 strip）。
   */
  private async _writeEnvelopeEntry(
    event: StreamEvent,
    opts?: { timestampOverride?: string; cwdOverride?: string | null },
  ): Promise<void> {
    this.version += 1;
    const uuid = `${this.config.threadId}:${this.version}`;
    const parentUuid = this.lastUuid;

    // 补 payload 公共字段——若 caller 已写则保留 caller 值（appendStreamEvent
    // 路径下 query.ts 的 envelope-emitter 已经填好 _seq / protocol_version 等）。
    const payload = this._buildEnvelopePayload(event);

    const entry: TranscriptEntry = {
      uuid,
      parentUuid,
      // 可选 timestampOverride（测试 / 特殊写入）；常规路径用当前时钟。
      timestamp: opts?.timestampOverride ?? new Date().toISOString(),
      threadId: this.config.threadId,
      version: this.version,
      type: event.type,
      payload,
    };

    this._attachFirstMessageStartMetadata(entry, event, opts?.cwdOverride);

    const serialised = JSON.stringify(entry) + '\n';
    this.buffer.push(serialised);
    this.lastUuid = uuid;
    // Wave 2 P1：估算字节数（避免 _checkFileSize 每写都 statSync）
    this._estimatedFileSize += Buffer.byteLength(serialised, 'utf8');

    await this._scheduleFlushIfNeeded();

    if (this.config.onWrite) {
      try {
        this.config.onWrite(entry);
      } catch {
        // hook 失败不阻塞落盘
      }
    }
    this._checkFileSize();
  }

  private _buildEnvelopePayload(event: StreamEvent): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...(event.payload ?? {}) };
    if (payload.protocol_version === undefined) payload.protocol_version = PROTOCOL_VERSION_V2;
    if (payload.min_compatible_version === undefined) payload.min_compatible_version = PROTOCOL_VERSION_V2;
    if (payload.trace_id === undefined) payload.trace_id = this.config.threadId;
    if (payload.thread_id === undefined) payload.thread_id = this.config.threadId;
    this._syncStorageSeq(payload);
    return payload;
  }

  private _syncStorageSeq(payload: Record<string, unknown>): void {
    if (payload._seq === undefined) {
      payload._seq = this.storageSeq;
      this.storageSeq += 1;
      return;
    }
    if (typeof payload._seq === 'number' && payload._seq >= this.storageSeq) {
      // caller 自带 _seq 时同步推进 storageSeq —— 避免 record* 与
      // appendStreamEvent 混用时 _seq 冲突
      this.storageSeq = payload._seq + 1;
    }
  }

  private _attachFirstMessageStartMetadata(
    entry: TranscriptEntry,
    event: StreamEvent,
    cwdOverride?: string | null,
  ): void {
    if (this.firstMessageStartWritten || event.type !== ContentBlockEvents.MESSAGE_START) return;
    if (cwdOverride !== undefined) {
      // 导入写入模式：显式注入会话真实 cwd（非 process.cwd()）。
      // cwdOverride 为 null / 空 = 源会话无 cwd（如目录已删/归默认 Workspace）——
      // 此时不落 process.cwd()（那是 Electron 主进程 cwd，对导入会话毫无意义）。
      if (cwdOverride) entry.cwd = cwdOverride;
    } else {
      try {
        entry.cwd = process.cwd();
      } catch { /* node ENV 限制时跳过 */ }
    }
    entry.runtimeVersion = RUNTIME_VERSION_TAG;
    this.firstMessageStartWritten = true;
  }

  private async _scheduleFlushIfNeeded(): Promise<void> {
    if (this.buffer.length >= SessionStorage.FLUSH_THRESHOLD) {
      this.writeQueue = this.writeQueue.then(() => this._flush());
      await this.writeQueue;
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.writeQueue = this.writeQueue.then(() => this._flush());
      }, SessionStorage.FLUSH_INTERVAL_MS);
    }
  }

  private _trackActiveMessageId(event: StreamEvent): void {
    if (event.type === ContentBlockEvents.MESSAGE_START) {
      const payload = (event.payload ?? {}) as { message_id?: string };
      this.activeMessageId = payload.message_id ?? null;
    } else if (event.type === ContentBlockEvents.MESSAGE_STOP) {
      this.activeMessageId = null;
    }
  }

  /**
   * Wave 2 P1 修复：
   *   1. **数据保留**：`buffer` 只在 appendFile 成功后才清空——磁盘满 / 写失败
   *      时数据保留在 buffer 内，下一次 flush 重试。原版本 "buffer = [] 在 try
   *      之前" 导致写失败一次就永久丢失当批数据。
   *   2. **writeQueue 死链恢复**：异常向上抛会让 writeQueue 进入永久 rejected
   *      状态、后续所有 `.then(() => _flush())` 链全部 reject。这里 catch 兜底
   *      不再 throw —— 让 writeQueue 永远是 fulfilled，buffer 内剩余条目下一
   *      次 _flush 时再尝试。失败信息走 onWriteError hook（默认 console.warn）
   *      告诉调用方但不阻塞下一次写。
   *
   * 默认 mode 0o600（仅 owner 可读写）—— session 数据敏感，避免 multi-user 系统
   * 上其他用户读到。
   */
  private async _flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    //  buffer 清空竞态：appendFile 的 await 会让出事件循环，期间并发的
    // _writeEnvelopeEntry 会继续往 this.buffer 追加新条目。成功后只能移除本次已
    // 写盘的 flushCount 条（splice），绝不能 `this.buffer = []` 整清空——否则 await
    // 窗口内新 push 的条目（如同一 storage 上并发记录的 user 消息 content_block_stop
    // / message_stop、rewind 标记）会被无声丢弃，导致上下文重建丢消息、回退失效。
    const flushCount = this.buffer.length;
    const batch = this.buffer.slice(0, flushCount).join('');

    try {
      await fs.promises.appendFile(this.filePath, batch, { mode: 0o600 });
      this.buffer.splice(0, flushCount); // 只移除已写盘的这批，保留 await 期间新增
    } catch (err1) {
      // 第一次失败：尝试 ensureDir 再写一次
      try {
        this._ensureDir();
        await fs.promises.appendFile(this.filePath, batch, { mode: 0o600 });
        this.buffer.splice(0, flushCount); // ensureDir 重试成功后只移除已写盘的这批
      } catch (err2) {
        // 第二次也失败：buffer 保留，下一次 _flush 会再试
        // 不向上 throw —— 保住 writeQueue 链路存活
        try {

          console.warn(
            `[storage] flush failed; ${this.buffer.length} entries kept for retry: `
              + `${(err2 as Error)?.message ?? err1}`,
          );
        } catch { /* ignore log error */ }
      }
    }
  }

  /**
   * Wave 2 P1 修复：
   *
   * 原版本每次 _writeEnvelopeEntry 都同步 `fs.statSync()` —— 200 tok/s 高
   * 流式场景下累积 ~100ms/s event loop 阻塞。
   *
   * 现版本：内存 byte counter `_estimatedFileSize`（构造时从真实 statSync
   * 取 1 次 baseline，写入时累加每条 entry 的字节数）。仅当 counter 超阈值
   * 时再做一次真实 statSync 校准（防止跨进程并发写入估算偏移过大）。
   *
   * 校准触发频率：≈ 写入超过 MAX_FILE_SIZE_BYTES 时一次（即每 GB / 每天 1-2
   * 次量级），event loop 阻塞总成本可忽略。
   */
  private _checkFileSize(): void {
    if (this._estimatedFileSize <= MAX_FILE_SIZE_BYTES) return;
    try {
      const stat = fs.statSync(this.filePath);
      // 真实大小校准 —— 跨进程写入时估算可能偏移
      this._estimatedFileSize = stat.size;
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        this.config.onCompact?.({
          compactedMessages: [],
          summary: '',
          tokensFreed: 0,
          mode: 'auto',
        });
      }
    } catch {
      // statSync 失败不影响主流（下次写入达 threshold 再试）
    }
  }
}

function persistedRoleForPayload(payload: Record<string, unknown>): 'user' | 'system' {
  const messageKind = typeof payload.message_kind === 'string' ? payload.message_kind : 'llm';
  if (
    messageKind === 'environment_context'
    || messageKind === 'agent_profile_context'
    || messageKind === 'system_prompt_context'
    || messageKind === 'compaction_summary'
    || messageKind === 'hitl_interaction'
    || messageKind === 'external_archive_context'
  ) return 'system';
  const metadata = payload.metadata && typeof payload.metadata === 'object'
    ? payload.metadata as Record<string, unknown>
    : undefined;
  if (payload.source === 'skill_invoke' || metadata?.source === 'skill_invoke') return 'system';
  const triggeredBy = payload.triggered_by ?? metadata?.triggered_by;
  if (triggeredBy === 'push-notification' || triggeredBy === 'parent_midflight') return 'system';
  return 'user';
}

// ── 模块级 helper ─────────────────────────────────────────────────────

/**
 * 把完整 ContentBlock 转成"空壳"形态——cb_start.block 字段。
 *
 * 按 Anthropic 协议设计意图：start.block 仅含 type + 必填字段的初始值（text=""
 * / input={}），完整内容由 delta 累积。但工具型 block（tool_use 的 id/name 是
 * 必填且不会变）+ 结构型 block（tool_result / image 等没有自然 delta 累积）
 * 直接全部塞 start.block —— 这是协议上明确允许的实现 wiggle room。
 */
function makeStartBlockShell(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: '' };
    case 'thinking': {
      // ThinkingBlock schema 中 signature 必填；record* 路径下 thinking 不切片，
      // 直接把 caller 提供的 signature 塞进 cb_start.block 让 restoreMessages
      // 一次拿到。delta 只补 thinking 文本（signature_delta 走 query.ts SSE
      // 真流式路径，不在这里）。
      const tb = block as { type: 'thinking'; thinking: string; signature?: string };
      return {
        type: 'thinking',
        thinking: '',
        signature: typeof tb.signature === 'string' ? tb.signature : '',
      } as ContentBlock;
    }
    case 'tool_use':
      // id / name 必填且贯穿 stream（Anthropic protocol），input 留空 {} 由 delta 填充
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: {},
      } as ContentBlock;
    case 'tool_result':
    case 'image':
    default:
      // 结构型 block 直接 deep clone 整体放 cb_start
      return JSON.parse(JSON.stringify(block)) as ContentBlock;
  }
}

/**
 * 把完整 ContentBlock 转成"一次性完整 delta"。
 *
 * 仅对内容型 block 返回 delta（text / thinking / tool_use 三类）；结构型 block
 * 返回 undefined，调用方跳过 cb_delta（block 整体已在 cb_start.block 里）。
 *
 * **不切片**（prompt 明确）：tool_use 的 input 是完整对象时，emit 1 个
 * input_json_delta(partial_json=完整 JSON.stringify(input)) + 1 个 cb_stop，
 * 不切成 N 个伪 delta。
 */
function makeFullDeltaFromBlock(
  block: ContentBlock,
): { type: string } & Record<string, unknown> | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text_delta', text: typeof block.text === 'string' ? block.text : '' };
    case 'thinking': {
      const tb = block as { type: 'thinking'; thinking: string };
      return { type: 'thinking_delta', thinking: typeof tb.thinking === 'string' ? tb.thinking : '' };
    }
    case 'tool_use': {
      const tu = block as ToolUseBlock;
      let partial: string;
      try {
        partial = JSON.stringify(tu.input ?? {});
      } catch {
        partial = '{}';
      }
      return { type: 'input_json_delta', partial_json: partial };
    }
    default:
      return undefined;
  }
}
