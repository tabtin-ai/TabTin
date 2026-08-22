/**
 * CH-34 · Agent 对话时间线多源分裂 · 子 harness A
 *
 * 复现 `messages.jsonl` 双源写入导致按 daemon message_id 查计数为 0 的分裂形态。
 *
 * **live 复测后修正（2026-06-25）**：harness A 复现的「双源并存」是**潜在形态**——
 * 主循环 6 件套事件实际不走 `appendStreamEvent`（只走 `eventStorage.append` 写
 * `events.jsonl` + `relayBuffer.push` 推 Django），`messages.jsonl` 的 6 件套路径
 * 只在子 Agent / interceptor 路径触发。但 `recordAssistantMessage` 老路径确实用
 * `local-...` message_id 写 `messages.jsonl`——如果未来 interceptor 路径被启用
 * （譬如修 CH-9 query 外事件覆盖时），双源分裂会立即可见。本 harness 锁住该
 * 潜在分裂，避免后续修复时引入。
 *
 * 验证目标：
 *   1. 复现分裂——同一段 assistant turn 在 messages.jsonl 里有两组 message_start/stop，
 *      一组用 daemon message_id，一组用 local-... message_id
 *   2. restoreMessages() 还原出 2 条 assistant Message（一条来自 6 件套、一条 local）
 *   3. 断言「按 daemon message_id 查 message_stop 计数」== 1（6 件套路径写入成功）
 *
 * 修复方向（待确认后实施）：
 *   - recordAssistantMessage 不应自己生成 local-... message_id
 *   - 或移除老路径，让 6 件套唯一落盘
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentBlockEvents, PROTOCOL_VERSION_V2 } from '../../src/engine/contracts/stream-events.js';
import { SessionStorage } from '../../src/session/storage.js';
import type {
  StreamEvent,
} from '../../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../../src/engine/contracts/conversation.js';
import type {
  TranscriptEntry,
} from '../../src/engine/contracts/context-capability.js';

let tmpRoot: string;
let storage: SessionStorage;
const sessionId = 'sess_ch34_a';

function readJsonlLines(filePath: string): TranscriptEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-ch34-a-'));
  storage = new SessionStorage({ sessionDir: tmpRoot, threadId: sessionId });
});

afterEach(async () => {
  try { await storage.dispose(); } catch { /* ignore */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * 构造 daemon emit 的 6 件套（assistant message + tool_use block），
 * message_id 用真实 UUID 形态（模拟 daemon envelope-emitter.nodeRandomUUID()）。
 */
function buildDaemonSixPiece(
  messageId: string,
  opts: {
    text: string;
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    traceId?: string;
  },
): StreamEvent[] {
  const baseEnvelope = {
    protocol_version: PROTOCOL_VERSION_V2,
    min_compatible_version: PROTOCOL_VERSION_V2,
    trace_id: opts.traceId ?? 'trace-ch34',
    thread_id: sessionId,
  };
  return [
    {
      type: ContentBlockEvents.MESSAGE_START,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.MESSAGE_START,
        _seq: 0,
        message_id: messageId,
        role: 'assistant',
        model_id: 'claude-sonnet-4',
        model_name: 'Claude Sonnet 4',
        started_at: new Date().toISOString(),
        run_id: 'run-ch34',
        message_kind: 'llm',
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.CONTENT_BLOCK_START,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.CONTENT_BLOCK_START,
        _seq: 1,
        message_id: messageId,
        index: 0,
        block_id: 'b0',
        block: { type: 'text', text: '' },
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
        _seq: 2,
        message_id: messageId,
        index: 0,
        delta: { type: 'text_delta', text: opts.text },
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.CONTENT_BLOCK_STOP,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
        _seq: 3,
        message_id: messageId,
        index: 0,
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.CONTENT_BLOCK_START,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.CONTENT_BLOCK_START,
        _seq: 4,
        message_id: messageId,
        index: 1,
        block_id: 'b1',
        block: { type: 'tool_use', id: opts.toolUseId, name: opts.toolName, input: {} },
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
        _seq: 5,
        message_id: messageId,
        index: 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(opts.toolInput) },
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.CONTENT_BLOCK_STOP,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
        _seq: 6,
        message_id: messageId,
        index: 1,
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.MESSAGE_DELTA,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.MESSAGE_DELTA,
        _seq: 7,
        message_id: messageId,
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 100, output_tokens: 50 },
      } as Record<string, unknown>,
    },
    {
      type: ContentBlockEvents.MESSAGE_STOP,
      payload: {
        ...baseEnvelope,
        event_type: ContentBlockEvents.MESSAGE_STOP,
        _seq: 8,
        message_id: messageId,
      } as Record<string, unknown>,
    },
  ];
}

describe('CH-34 · messages.jsonl 双源 message_id 分裂', () => {
  it('复现：6 件套路径 + recordAssistantMessage 路径写出两组不同 message_id', async () => {
    // 模拟 daemon emit 的真实 message_id（UUID 形态）
    const daemonMessageId = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

    // ── 路径 1：6 件套经 appendStreamEvent 落盘（interceptor 路径） ──
    const sixPieceEvents = buildDaemonSixPiece(daemonMessageId, {
      text: 'I will read the file.',
      toolUseId: 'toolu_001',
      toolName: 'read_file',
      toolInput: { path: 'foo.py' },
    });
    for (const ev of sixPieceEvents) {
      await storage.appendStreamEvent(ev);
    }

    // ── 路径 2：afterIteration hook 经 recordAssistantMessage 落盘 ──
    // 模拟 runtime state.messages 末尾的 assistant Message（含同样 text + tool_use）
    const assistantMessage: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the file.' },
        { type: 'tool_use', id: 'toolu_001', name: 'read_file', input: { path: 'foo.py' } },
      ],
    };
    await storage.recordAssistantMessage(assistantMessage);

    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());

    // ── 断言 1：message_start 出现两组，message_id 不同（分裂） ──
    const messageStarts = entries.filter((e) => e.type === ContentBlockEvents.MESSAGE_START);
    expect(messageStarts.length).toBe(2);

    const messageIds = messageStarts.map(
      (e) => (e.payload as { message_id: string }).message_id,
    );
    expect(messageIds).toContain(daemonMessageId);
    const localId = messageIds.find((id) => id !== daemonMessageId);
    expect(localId).toBeDefined();
    expect(localId?.startsWith('local-')).toBe(true); // recordAssistantMessage 生成 local-... 前缀

    // ── 断言 2：按 daemon message_id 查 message_stop 计数 == 1 ──
    const daemonStops = entries.filter(
      (e) =>
        e.type === ContentBlockEvents.MESSAGE_STOP
        && (e.payload as { message_id: string }).message_id === daemonMessageId,
    );
    expect(daemonStops.length).toBe(1);

    // ── 断言 3：按 local-... message_id 查 message_stop 计数 == 1 ──
    const localStops = entries.filter(
      (e) =>
        e.type === ContentBlockEvents.MESSAGE_STOP
        && (e.payload as { message_id: string }).message_id === localId,
    );
    expect(localStops.length).toBe(1);

    // ── 断言 4：restoreMessages 还原出 2 条 assistant Message ──
    const restored = await storage.restoreMessages();
    expect(restored.length).toBe(2);
    expect(restored.every((m) => m.role === 'assistant')).toBe(true);
  });

  it('单源基准：仅 6 件套路径写入时，按 daemon message_id 查计数为 1', async () => {
    const daemonMessageId = 'b2c3d4e5-f6a7-4889-bcde-f01234567890';
    const sixPieceEvents = buildDaemonSixPiece(daemonMessageId, {
      text: 'Only 6-piece path.',
      toolUseId: 'toolu_002',
      toolName: 'read_file',
      toolInput: { path: 'bar.py' },
    });
    for (const ev of sixPieceEvents) {
      await storage.appendStreamEvent(ev);
    }
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const messageStarts = entries.filter((e) => e.type === ContentBlockEvents.MESSAGE_START);
    expect(messageStarts.length).toBe(1);
    expect((messageStarts[0].payload as { message_id: string }).message_id).toBe(daemonMessageId);

    const restored = await storage.restoreMessages();
    expect(restored.length).toBe(1);
  });

  it('单源基准：仅 recordAssistantMessage 路径写入时，message_id 以 local- 开头', async () => {
    const assistantMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Only recordAssistantMessage path.' }],
    };
    await storage.recordAssistantMessage(assistantMessage);
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const messageStarts = entries.filter((e) => e.type === ContentBlockEvents.MESSAGE_START);
    expect(messageStarts.length).toBe(1);
    const messageId = (messageStarts[0].payload as { message_id: string }).message_id;
    expect(messageId.startsWith('local-')).toBe(true);
  });
});
