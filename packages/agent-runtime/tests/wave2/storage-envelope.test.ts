/**
 * Wave 2 — SessionStorage envelope-based jsonl 单测
 *
 * 覆盖：
 *   1. record* API 翻译为 envelope 序列写入 messages.jsonl
 *   2. loadTranscript 流式读回 entries（uuid 链表 / version 单调）
 *   3. restoreMessages 从 envelope 重建 Message[]（处理 cb_start/delta/stop 累积）
 *   4. 老 v1 jsonl truncate（不留兼容路径）
 *   5. dispose 兜底 message_stop（active message 没 close）
 *   6. appendStreamEvent 过滤白名单（仅 6 件套 + compaction + lifecycle:error）
 *   7. compaction 边界后只重建后续 message
 *   8. tool_use input_json_delta 累积后 JSON.parse 回原 input
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { ContentBlockEvents, StreamEvents, PROTOCOL_VERSION_V2 } from '../../src/engine/contracts/stream-events.js';
import { SessionStorage } from '../../src/session/storage.js';
import type {
  StreamEvent,
} from '../../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../../src/engine/contracts/conversation.js';
import type {
  TranscriptEntry,
  CompactResult,
} from '../../src/engine/contracts/context-capability.js';

let tmpRoot: string;
let storage: SessionStorage;
const sessionId = 'sess_test_w2';

function readJsonlLines(filePath: string): TranscriptEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-storage-w2-'));
  storage = new SessionStorage({ sessionDir: tmpRoot, threadId: sessionId });
});

afterEach(async () => {
  try { await storage.dispose(); } catch { /* ignore */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SessionStorage — record* translates to envelope sequence', () => {
  it('recordUserMessage emits message_start + content_block (text) + message_stop', async () => {
    const userMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
    };
    await storage.recordUserMessage(userMsg);
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const types = entries.map((e) => e.type);

    expect(types).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_STOP,
    ]);

    expect((entries[0].payload as { role: string }).role).toBe('user');
    const blockStart = entries[1].payload as { block: { type: string; text: string } };
    expect(blockStart.block.type).toBe('text');
    expect(blockStart.block.text).toBe(''); // shell

    const delta = entries[2].payload as { delta: { type: string; text: string } };
    expect(delta.delta.type).toBe('text_delta');
    expect(delta.delta.text).toBe('hello world');
  });

  it('recordToolUse emits envelope with tool_use block intact in cb_start', async () => {
    await storage.recordToolUse('shell', 'toolu_abc123', { cmd: 'ls' });
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const cbStart = entries.find((e) => e.type === ContentBlockEvents.CONTENT_BLOCK_START);
    expect(cbStart).toBeDefined();
    const block = (cbStart!.payload as { block: { type: string; id: string; name: string; input: unknown } }).block;
    expect(block.type).toBe('tool_use');
    expect(block.id).toBe('toolu_abc123'); // **关键**：upstream id 保留不重生
    expect(block.name).toBe('shell');
    expect(block.input).toEqual({}); // shell

    const cbDelta = entries.find((e) => e.type === ContentBlockEvents.CONTENT_BLOCK_DELTA);
    const delta = (cbDelta!.payload as { delta: { type: string; partial_json: string } }).delta;
    expect(delta.type).toBe('input_json_delta');
    expect(delta.partial_json).toBe('{"cmd":"ls"}'); // 一次性完整 JSON，**不切片**
  });

  it('recordToolResult emits user-role envelope wrapping tool_result block', async () => {
    await storage.recordToolResult('toolu_xxx', 'ok', false);
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    expect((entries[0].payload as { role: string }).role).toBe('user');
    const cbStart = entries.find((e) => e.type === ContentBlockEvents.CONTENT_BLOCK_START);
    const block = (cbStart!.payload as { block: { type: string; tool_use_id: string; content: string } }).block;
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('toolu_xxx');
    expect(block.content).toBe('ok');
  });

  it('recordTerminalToolProjection writes hidden model projection sidecar without changing raw messages', async () => {
    const rawStdout = 'RAW_TERMINAL_STDOUT_SHOULD_STAY_OUT_OF_PROJECTION '.repeat(200);
    await storage.recordToolResult('toolu_projection', rawStdout, false);
    await storage.recordTerminalToolProjection(
      'toolu_projection',
      { command: 'tabtin table import 36kr.json' },
      {
        status: 'completed',
        exit_code: 0,
        stdout: rawStdout,
        stdout_truncated: true,
        full_output_path: '/tmp/tabtin-tool-results/sess_test_w2/stdout.log',
      },
      false,
    );
    await storage.dispose();

    const rawEntries = readJsonlLines(storage.getFilePath());
    const rawSerialized = JSON.stringify(rawEntries);
    expect(rawSerialized).toContain('RAW_TERMINAL_STDOUT_SHOULD_STAY_OUT_OF_PROJECTION');

    const projections = await storage.loadModelProjections();
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      projection_type: 'tool',
      tool_call_id: 'toolu_projection',
      tool_name: 'run_terminal_command',
    });
    expect(projections[0].projection.text).toContain('Tool Projection (run_terminal_command)');
    expect(projections[0].projection.text).toContain('raw_ref=tool-log://sess_test_w2/toolu_projection');
    expect(projections[0].projection.text).not.toContain('RAW_TERMINAL_STDOUT_SHOULD_STAY_OUT_OF_PROJECTION');
    expect(fs.existsSync(storage.getProjectionFilePath())).toBe(true);
  });

  it('recordTerminalToolProjection reuses input remembered from the start notice', async () => {
    storage.rememberToolInputForProjection('toolu_cached_input', {
      command: 'tabtin table import cached.json',
    });
    await storage.recordTerminalToolProjection(
      'toolu_cached_input',
      undefined,
      { status: 'completed', exit_code: 0, stdout: '{"ok":true}' },
      false,
    );
    await storage.dispose();

    const projections = await storage.loadModelProjections();
    expect(projections).toHaveLength(1);
    expect(projections[0].projection.text).toContain('Command: tabtin table import cached.json');
  });

  it('recordCompaction writes single COMPACTION envelope', async () => {
    const compactResult: CompactResult = {
      compactedMessages: [],
      summary: 'condensed history',
      tokensFreed: 1234,
      mode: 'auto',
    };
    await storage.recordCompaction(compactResult);
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    // dispose 不会再追加 stop（compaction 不是 message_start）
    const compaction = entries.find((e) => e.type === StreamEvents.COMPACTION);
    expect(compaction).toBeDefined();
    const p = compaction!.payload as { phase: string; summary: string; tokens_freed: number; mode: string };
    expect(p.phase).toBe('done');
    expect(p.summary).toBe('condensed history');
    expect(p.tokens_freed).toBe(1234);
    expect(p.mode).toBe('auto');
  });

  it('recordError writes single LIFECYCLE error envelope', async () => {
    await storage.recordError('boom');
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const err = entries.find((e) => e.type === StreamEvents.LIFECYCLE);
    expect(err).toBeDefined();
    const p = err!.payload as { phase: string; status: string; error_message: string };
    expect(p.phase).toBe('error');
    expect(p.status).toBe('error');
    expect(p.error_message).toBe('boom');
  });
});

describe('SessionStorage — TranscriptEntry chain integrity', () => {
  it('first entry has parentUuid=null, subsequent chain via parentUuid → previous uuid', async () => {
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    expect(entries[0].parentUuid).toBeNull();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].parentUuid).toBe(entries[i - 1].uuid);
    }
  });

  it('version is monotonic across entries', async () => {
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'a' }] });
    await storage.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: 'b' }] });
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].version).toBe(entries[i - 1].version + 1);
    }
  });

  it('cwd + runtimeVersion only on first message_start', async () => {
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'a' }] });
    await storage.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: 'b' }] });
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const messageStarts = entries.filter((e) => e.type === ContentBlockEvents.MESSAGE_START);
    expect(messageStarts.length).toBeGreaterThanOrEqual(2);
    expect(messageStarts[0].cwd).toBeDefined();
    expect(messageStarts[0].runtimeVersion).toBe('tabtin-runtime-v2');
    expect(messageStarts[1].cwd).toBeUndefined();
    expect(messageStarts[1].runtimeVersion).toBeUndefined();
  });
});

describe('SessionStorage — restoreMessages from envelope stream', () => {
  it('reconstructs Message[] from envelope events (text + tool_use)', async () => {
    const userMsg: Message = { role: 'user', content: [{ type: 'text', text: 'foo' }] };
    const assistantMsg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'sure' },
        { type: 'tool_use', id: 'toolu_1', name: 'shell', input: { cmd: 'ls -la' } } as never,
      ],
    };
    await storage.recordUserMessage(userMsg);
    await storage.recordAssistantMessage(assistantMsg);
    await storage.dispose();

    const restored = await storage.restoreMessages();
    expect(restored).toHaveLength(2);

    expect(restored[0].role).toBe('user');
    expect(restored[0].content).toEqual([{ type: 'text', text: 'foo' }]);

    expect(restored[1].role).toBe('assistant');
    const blocks = restored[1].content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe('sure');
    expect(blocks[1].type).toBe('tool_use');
    expect(blocks[1].id).toBe('toolu_1');
    expect(blocks[1].name).toBe('shell');
    expect(blocks[1].input).toEqual({ cmd: 'ls -la' }); // input_json_delta 累积后 parse 回 object
  });

  it('honours compaction:done boundary (drops messages before it)', async () => {
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'msg-1' }] });
    await storage.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: 'reply-1' }] });
    await storage.recordCompaction({
      compactedMessages: [],
      summary: 'compacted',
      tokensFreed: 100,
      mode: 'auto',
    });
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'msg-2' }] });
    await storage.dispose();

    const restored = await storage.restoreMessages();
    expect(restored).toHaveLength(1);
    expect(restored[0].role).toBe('user');
    expect((restored[0].content as Array<{ text: string }>)[0].text).toBe('msg-2');
  });

  it('skips lifecycle:error entries (do not enter LLM history)', async () => {
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'a' }] });
    await storage.recordError('mid-error');
    await storage.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: 'b' }] });
    await storage.dispose();

    const restored = await storage.restoreMessages();
    expect(restored).toHaveLength(2);
    expect(restored.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('SessionStorage — appendStreamEvent (host bridge channel)', () => {
  it('persists 6 ContentBlock envelope events to messages.jsonl', async () => {
    const baseEnvelope = {
      protocol_version: PROTOCOL_VERSION_V2,
      min_compatible_version: PROTOCOL_VERSION_V2,
      trace_id: 't',
      thread_id: sessionId,
    };
    const events: StreamEvent[] = [
      {
        type: ContentBlockEvents.MESSAGE_START,
        payload: {
          ...baseEnvelope,
          event_type: ContentBlockEvents.MESSAGE_START,
          _seq: 0,
          message_id: 'm1',
          role: 'assistant',
          model_id: 'claude',
          model_name: 'Claude',
          started_at: new Date().toISOString(),
          run_id: 'r',
        } as Record<string, unknown>,
      },
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          ...baseEnvelope,
          event_type: ContentBlockEvents.CONTENT_BLOCK_START,
          _seq: 1,
          message_id: 'm1',
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
          message_id: 'm1',
          index: 0,
          delta: { type: 'text_delta', text: 'streamed' },
        } as Record<string, unknown>,
      },
      {
        type: ContentBlockEvents.CONTENT_BLOCK_STOP,
        payload: {
          ...baseEnvelope,
          event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
          _seq: 3,
          message_id: 'm1',
          index: 0,
        } as Record<string, unknown>,
      },
      {
        type: ContentBlockEvents.MESSAGE_DELTA,
        payload: {
          ...baseEnvelope,
          event_type: ContentBlockEvents.MESSAGE_DELTA,
          _seq: 4,
          message_id: 'm1',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as Record<string, unknown>,
      },
      {
        type: ContentBlockEvents.MESSAGE_STOP,
        payload: {
          ...baseEnvelope,
          event_type: ContentBlockEvents.MESSAGE_STOP,
          _seq: 5,
          message_id: 'm1',
        } as Record<string, unknown>,
      },
    ];

    for (const ev of events) {
      await storage.appendStreamEvent(ev);
    }
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.type)).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_DELTA,
      ContentBlockEvents.MESSAGE_STOP,
    ]);

    // restoreMessages 应能从这 6 条 envelope 还原出 1 条 Message
    const restored = await storage.restoreMessages();
    expect(restored).toHaveLength(1);
    expect(restored[0].role).toBe('assistant');
    expect((restored[0].content as Array<{ text: string }>)[0].text).toBe('streamed');
  });

  it('drops non-whitelisted events (DONE / SYSTEM_NOTICE / etc.)', async () => {
    await storage.appendStreamEvent({
      type: StreamEvents.DONE,
      payload: { ok: true } as Record<string, unknown>,
    });
    await storage.appendStreamEvent({
      type: StreamEvents.SYSTEM_NOTICE,
      payload: { msg: 'hint' } as Record<string, unknown>,
    });
    await storage.appendStreamEvent({
      type: StreamEvents.STEP,
      payload: {} as Record<string, unknown>,
    });
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    // 全部被 drop —— 仅元事件，不该写到 messages.jsonl
    expect(entries.filter((e) => e.type === StreamEvents.DONE)).toHaveLength(0);
    expect(entries.filter((e) => e.type === StreamEvents.SYSTEM_NOTICE)).toHaveLength(0);
    expect(entries.filter((e) => e.type === StreamEvents.STEP)).toHaveLength(0);
  });
});

describe('SessionStorage — dispose fallback message_stop', () => {
  it('emits fallback message_stop when active message_start was never closed', async () => {
    await storage.appendStreamEvent({
      type: ContentBlockEvents.MESSAGE_START,
      payload: {
        event_type: ContentBlockEvents.MESSAGE_START,
        _seq: 0,
        message_id: 'msg_orphan',
        role: 'assistant',
      } as Record<string, unknown>,
    });
    // 模拟 daemon crash —— 没 emit message_stop 直接 dispose
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const stops = entries.filter((e) => e.type === ContentBlockEvents.MESSAGE_STOP);
    expect(stops).toHaveLength(1);
    expect((stops[0].payload as { message_id: string }).message_id).toBe('msg_orphan');
  });

  it('does NOT emit fallback when message_stop already received', async () => {
    await storage.appendStreamEvent({
      type: ContentBlockEvents.MESSAGE_START,
      payload: {
        event_type: ContentBlockEvents.MESSAGE_START,
        _seq: 0,
        message_id: 'msg_clean',
        role: 'assistant',
      } as Record<string, unknown>,
    });
    await storage.appendStreamEvent({
      type: ContentBlockEvents.MESSAGE_STOP,
      payload: {
        event_type: ContentBlockEvents.MESSAGE_STOP,
        _seq: 1,
        message_id: 'msg_clean',
      } as Record<string, unknown>,
    });
    await storage.dispose();

    const entries = readJsonlLines(storage.getFilePath());
    const stops = entries.filter((e) => e.type === ContentBlockEvents.MESSAGE_STOP);
    expect(stops).toHaveLength(1); // 没多写一条
  });
});

describe('SessionStorage — legacy v1 jsonl truncation', () => {
  it('detects and deletes legacy v1 jsonl (no envelope payload structure)', async () => {
    await storage.dispose();

    // 直接写一份老 v1 jsonl 到目标路径
    const legacyContent = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'old' }] },
      timestamp: '2025-01-01T00:00:00Z',
    }) + '\n';
    fs.writeFileSync(storage.getFilePath(), legacyContent, { mode: 0o600 });

    // 重建 SessionStorage —— 构造时应检测到 legacy 并 truncate（保留文件本身，
    // 但 size 归零；后续 _writeEnvelopeEntry 会按 envelope 形态从头写）。
    const storage2 = new SessionStorage({ sessionDir: tmpRoot, threadId: sessionId });
    expect(fs.existsSync(storage2.getFilePath())).toBe(true);
    expect(fs.statSync(storage2.getFilePath()).size).toBe(0);
    await storage2.dispose();
  });

  it('preserves W2 envelope jsonl across reopen', async () => {
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'persist' }] });
    await storage.dispose();

    const sizeBefore = fs.statSync(storage.getFilePath()).size;
    expect(sizeBefore).toBeGreaterThan(0);

    const storage2 = new SessionStorage({ sessionDir: tmpRoot, threadId: sessionId });
    expect(fs.existsSync(storage2.getFilePath())).toBe(true);
    expect(fs.statSync(storage2.getFilePath()).size).toBe(sizeBefore);

    const restored = await storage2.restoreMessages();
    expect(restored).toHaveLength(1);
    expect((restored[0].content as Array<{ text: string }>)[0].text).toBe('persist');
    await storage2.dispose();
  });
});

describe('SessionStorage — version recovery from tail scan', () => {
  it('continues version counter across reopen', async () => {
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'a' }] });
    await storage.dispose();
    const ver1 = storage.getVersion();
    expect(ver1).toBeGreaterThan(0);

    const storage2 = new SessionStorage({ sessionDir: tmpRoot, threadId: sessionId });
    expect(storage2.getVersion()).toBe(ver1);
    await storage2.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'b' }] });
    expect(storage2.getVersion()).toBeGreaterThan(ver1);
    await storage2.dispose();
  });
});

describe('SessionStorage — flush buffer 清空竞态回归', () => {
  it('并发 recordUserMessage 不丢失任何消息的闭合事件', async () => {
    // 复现「user 消息 + environment context 同轮并发写同一 storage」场景：
    // 多条 record 并发时会反复跨过 FLUSH_THRESHOLD，每次 flush 的 appendFile
    // await 期间其他 record 继续 push；旧实现 flush 后 `this.buffer = []` 会把
    // await 窗口内新 push 的 content_block_stop / message_stop 无声丢弃，导致
    // 重建时该消息被后续 message_start 覆盖丢弃、上下文缺消息。
    const total = 24;
    const msgs: Message[] = Array.from({ length: total }, (_, i) => ({
      role: 'user',
      content: [{ type: 'text', text: `concurrent-${i}` }],
    }));

    await Promise.all(msgs.map((m) => storage.recordUserMessage(m)));
    await storage.flushPendingWrites();

    // 方案 A 的精确保证：每个 message_start 都有配对的 message_stop（按 message_id
    // 校验），await 窗口内 push 的闭合事件不再被 flush 无声丢弃。原缺陷下部分消息
    // 的 content_block_stop / message_stop（seq 被跳过）不落盘，此处 startIds 与
    // stopIds 会不相等。
    const entries = readJsonlLines(storage.getFilePath());
    const midOf = (e: TranscriptEntry) => (e.payload as { message_id?: string }).message_id;
    const startIds = entries
      .filter((e) => e.type === ContentBlockEvents.MESSAGE_START)
      .map(midOf);
    const stopIds = new Set(
      entries.filter((e) => e.type === ContentBlockEvents.MESSAGE_STOP).map(midOf),
    );
    expect(startIds.length).toBe(total);
    for (const id of startIds) {
      expect(stopIds.has(id)).toBe(true);
    }

    await storage.dispose();
  });

  it('rewind commit 期间并发写入的新条目不被丢弃', async () => {
    // commitRewind → _rewriteEntries 整体重写文件；旧实现事后 `this.buffer = []`
    // 会丢弃重写 await 期间并发 push 的、回退边界之后的新条目。
    await storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'keep-1' }] });
    await storage.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: 'drop-me' }] });
    await storage.flushPendingWrites();

    // 标记回退到只保留第 1 条消息（keep-1）。
    await storage.recordRewindMark(1);

    // commitRewind 与一条并发新消息同时进行——新消息在回退边界之后，必须保留。
    await Promise.all([
      storage.commitRewind(),
      storage.recordUserMessage({ role: 'user', content: [{ type: 'text', text: 'concurrent-new' }] }),
    ]);

    const restored = await storage.restoreMessages();
    const texts = restored.map((m) =>
      (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join(''),
    );
    expect(texts).toContain('keep-1');
    expect(texts).toContain('concurrent-new');
    expect(texts).not.toContain('drop-me');

    await storage.dispose();
  });
});
