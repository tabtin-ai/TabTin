/**
 * SessionStorage 读路径测试（Wave 2 envelope-based 重写）。
 *
 * Wave 2 改造：messages.jsonl 每行从老 TranscriptEntry（含 type:'user'/
 * 'assistant'/'compact' + message 对象）改成 W1 ContentBlock 三件套 envelope
 * （agent.stream.message_start / .message_delta / .message_stop /
 * .content_block_start / .content_block_delta / .content_block_stop），外加
 * 会话链表兼容字段（uuid / parentUuid / timestamp / sessionId / cwd / version）。
 *
 * 老格式 jsonl 在 SessionStorage 构造期被静默 TRUNCATE（产品未上线，按总控
 * §六 "不留老 jsonl 兼容" 硬性要求）。
 *
 * 主要覆盖：
 *   1. recordUserMessage / recordAssistantMessage / recordToolResult /
 *      recordCompaction 写出符合 W1 envelope schema 的 6 件套序列
 *   2. restoreMessages 从 envelope 序列重组 Message[]（含 compact 前缀截断）
 *   3. _loadTailState 从尾部 64 KB 反向扫描恢复 version + lastUuid + storageSeq
 *   4. _truncateLegacyJsonlIfNeeded 删旧 TranscriptEntry 形态 jsonl
 *   5. 大文件（>64KB）下 version 仍能正确恢复
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentBlockEvents, PROTOCOL_VERSION_V2 } from '../src/engine/contracts/stream-events.js';
import { SessionStorage } from '../src/session/storage.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  TranscriptEntry,
} from '../src/engine/contracts/context-capability.js';

let sessionDir: string;
const sessionId = 'test-session';

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'sess-load-'));
});

afterEach(() => {
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sessionFilePath(): string {
  return join(sessionDir, sessionId, 'messages.jsonl');
}

function readJsonl(): TranscriptEntry[] {
  const text = readFileSync(sessionFilePath(), 'utf-8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as TranscriptEntry);
}

function writeRaw(content: string): string {
  mkdirSync(join(sessionDir, sessionId), { recursive: true });
  const filePath = sessionFilePath();
  writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

/** 构造一条最小合法 envelope（用于测试 _loadTailState）。 */
function makeEnvelopeEntry(version: number, type: string, payload: Record<string, unknown>): TranscriptEntry {
  return {
    uuid: `${sessionId}:${version}`,
    parentUuid: version > 1 ? `${sessionId}:${version - 1}` : null,
    timestamp: new Date(1_700_000_000_000 + version).toISOString(),
    sessionId,
    version,
    type,
    payload,
  };
}

function envelopeMessageStart(seq: number, messageId: string, role: 'user' | 'assistant' = 'user'): Record<string, unknown> {
  return {
    protocol_version: PROTOCOL_VERSION_V2,
    min_compatible_version: PROTOCOL_VERSION_V2,
    trace_id: sessionId,
    _seq: seq,
    thread_id: sessionId,
    event_type: ContentBlockEvents.MESSAGE_START,
    message_id: messageId,
    role,
    model_id: 'host-recorded',
    model_name: 'host-recorded',
    started_at: new Date().toISOString(),
    run_id: sessionId,
  };
}

describe('SessionStorage Wave 2 — envelope-based read path', () => {
  // ────── 不存在 / 空 ──────

  it('returns empty + version 0 when file does not exist', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(storage.getVersion()).toBe(0);
    expect(await storage.loadTranscript()).toEqual([]);
    expect(await storage.restoreMessages()).toEqual([]);
  });

  // ────── W6read-after-write 一致性 ──────

  it('restoreMessages 读到刚写入但仍在 buffer（未达刷盘阈值）的消息', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    // 单条消息 ~5 个 envelope 条目，远低于 FLUSH_THRESHOLD(10) —— 写后仍在内存
    // buffer、未落盘。修复前 loadTranscript 直接读磁盘会读到空/陈旧；修复后
    // loadTranscript 先 flushPendingWrites，保证读到。
    await storage.recordUserMessage({ role: 'user', content: '现在的页面是什么' });

    const restored = await storage.restoreMessages();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.role).toBe('user');
  });

  it('跨「轮」连续写入后 restoreMessages 返回完整历史（不丢中间 buffer 内容）', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    // 复刻 ：user1 → env context → assistant → user2，均低于阈值留在 buffer，
    // 每次 restoreMessages 都应看到此前全部，不漏中间的 context / assistant。
    await storage.recordUserMessage({ role: 'user', content: '现在的页面是什么' });
    await storage.recordUserMessage({ role: 'user', content: '<context type="environment">\nfocused: 文档X\n</context>' });
    await storage.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: '你在看文档X' }] });
    await storage.recordUserMessage({ role: 'user', content: '现在呢？' });

    const restored = await storage.restoreMessages();
    expect(restored).toHaveLength(4);
    expect(restored.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
  });

  it('returns empty + version 0 for a zero-byte file', async () => {
    writeRaw('');
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(storage.getVersion()).toBe(0);
    expect(await storage.loadTranscript()).toEqual([]);
  });

  // ────── 老格式 jsonl 直接 truncate ──────

  it('truncates legacy TranscriptEntry jsonl on construction (Wave 2 hard requirement)', async () => {
    // 模拟老格式：第一行是 type='user' 的 TranscriptEntry，不带 envelope payload
    const legacyLine =
      JSON.stringify({
        type: 'user',
        timestamp: 1_000_000,
        sessionId,
        version: 1,
        message: { role: 'user', content: 'legacy' },
      }) + '\n';
    writeRaw(legacyLine);
    expect(statSync(sessionFilePath()).size).toBeGreaterThan(0);

    // 构造 SessionStorage 应当 TRUNCATE
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(statSync(sessionFilePath()).size).toBe(0);
    expect(storage.getVersion()).toBe(0);
    expect(await storage.loadTranscript()).toEqual([]);
  });

  it('keeps a valid Wave 2 envelope jsonl on construction', async () => {
    const entry = makeEnvelopeEntry(1, ContentBlockEvents.MESSAGE_START, envelopeMessageStart(0, 'msg_1'));
    writeRaw(JSON.stringify(entry) + '\n');
    expect(statSync(sessionFilePath()).size).toBeGreaterThan(0);

    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(storage.getVersion()).toBe(1);
    expect((await storage.loadTranscript()).length).toBe(1);
  });

  // ────── recordUserMessage 写 5 行 envelope（msg_start / cb_start / cb_delta / cb_stop / msg_stop） ──────

  it('recordUserMessage writes a complete 5-event envelope sequence', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordUserMessage({ role: 'user', content: 'hello world' } as Message);
    await storage.dispose();

    const entries = readJsonl();
    expect(entries.length).toBe(5);
    expect(entries[0].type).toBe(ContentBlockEvents.MESSAGE_START);
    expect(entries[1].type).toBe(ContentBlockEvents.CONTENT_BLOCK_START);
    expect(entries[2].type).toBe(ContentBlockEvents.CONTENT_BLOCK_DELTA);
    expect(entries[3].type).toBe(ContentBlockEvents.CONTENT_BLOCK_STOP);
    expect(entries[4].type).toBe(ContentBlockEvents.MESSAGE_STOP);

    // delta 携带完整 text（不切片）
    const delta = entries[2].payload.delta as { type: string; text: string };
    expect(delta.type).toBe('text_delta');
    expect(delta.text).toBe('hello world');

    // 全程 message_id 一致
    const msgId = entries[0].payload.message_id;
    for (const e of entries) expect(e.payload.message_id).toBe(msgId);

    // protocol_version / trace_id / thread_id / _seq 单调
    let prevSeq = -1;
    for (const e of entries) {
      expect(e.payload.protocol_version).toBe(PROTOCOL_VERSION_V2);
      expect(e.payload.trace_id).toBe(sessionId);
      expect(e.payload.thread_id).toBe(sessionId);
      expect(e.payload._seq).toBeGreaterThan(prevSeq);
      prevSeq = e.payload._seq as number;
    }

    // 会话链表字段：uuid / parentUuid 链
    expect(entries[0].uuid).toBe(`${sessionId}:1`);
    expect(entries[0].parentUuid).toBeNull();
    expect(entries[1].parentUuid).toBe(entries[0].uuid);
    expect(entries[4].parentUuid).toBe(entries[3].uuid);

    // 首条注入 cwd / runtimeVersion
    expect(entries[0].cwd).toBeDefined();
    expect(entries[0].runtimeVersion).toBe('tabtin-runtime-v2');
    expect(entries[1].cwd).toBeUndefined();
  });

  it('recordToolResult writes envelope with tool_result block', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordToolResult('tool-call-123', 'output text', false);
    await storage.dispose();

    const entries = readJsonl();
    // tool_result block 不会 emit content_block_delta（结构型 block 内容已在 start.block 里）
    // 序列：msg_start + cb_start + cb_stop + msg_stop = 4 行
    expect(entries.length).toBe(4);
    expect(entries[0].type).toBe(ContentBlockEvents.MESSAGE_START);
    expect(entries[1].type).toBe(ContentBlockEvents.CONTENT_BLOCK_START);
    expect(entries[2].type).toBe(ContentBlockEvents.CONTENT_BLOCK_STOP);
    expect(entries[3].type).toBe(ContentBlockEvents.MESSAGE_STOP);

    const cbStart = entries[1].payload as { block: { type: string; tool_use_id: string; content: string } };
    expect(cbStart.block.type).toBe('tool_result');
    expect(cbStart.block.tool_use_id).toBe('tool-call-123');
    expect(cbStart.block.content).toBe('output text');

    expect((entries[0].payload as { role: string }).role).toBe('user');
  });

  it('recordToolUse writes envelope with tool_use block + complete input_json_delta', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordToolUse('shell_exec', 'tool-call-456', { command: 'ls' });
    await storage.dispose();

    const entries = readJsonl();
    expect(entries.length).toBe(5);
    expect(entries[2].type).toBe(ContentBlockEvents.CONTENT_BLOCK_DELTA);

    const delta = entries[2].payload.delta as { type: string; partial_json: string };
    expect(delta.type).toBe('input_json_delta');
    expect(JSON.parse(delta.partial_json)).toEqual({ command: 'ls' });

    expect((entries[0].payload as { role: string }).role).toBe('assistant');
  });

  // ────── restoreMessages 从 envelope 重组 Message[] ──────

  it('restoreMessages rebuilds a single user message from envelope sequence', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordUserMessage({ role: 'user', content: 'hello' } as Message);
    await storage.dispose();

    const reopened = new SessionStorage({ sessionDir, threadId: sessionId });
    const messages = await reopened.restoreMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('user');
    const blocks = messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe('hello');
  });

  it('restoreMessages rebuilds tool_use input correctly', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordToolUse('search', 'tu-1', { query: 'test', limit: 5 });
    await storage.dispose();

    const reopened = new SessionStorage({ sessionDir, threadId: sessionId });
    const messages = await reopened.restoreMessages();
    expect(messages.length).toBe(1);
    const blocks = messages[0].content as Array<{ type: string; input?: unknown; name?: string }>;
    expect(blocks[0].type).toBe('tool_use');
    expect(blocks[0].name).toBe('search');
    expect(blocks[0].input).toEqual({ query: 'test', limit: 5 });
  });

  it('restoreMessages truncates at last compaction marker', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordUserMessage({ role: 'user', content: 'before-1' } as Message);
    await storage.recordAssistantMessage({ role: 'assistant', content: 'before-2' } as Message);
    await storage.recordCompaction({
      compactedMessages: [],
      summary: 'summary-of-1-2',
      tokensFreed: 0,
      mode: 'auto',
    });
    await storage.recordUserMessage({ role: 'user', content: 'after-1' } as Message);
    await storage.recordAssistantMessage({ role: 'assistant', content: 'after-2' } as Message);
    await storage.dispose();

    const reopened = new SessionStorage({ sessionDir, threadId: sessionId });
    const messages = await reopened.restoreMessages();
    // compaction 之后的 2 条 message
    expect(messages.length).toBe(2);
    const after1Blocks = messages[0].content as Array<{ type: string; text?: string }>;
    expect(after1Blocks[0].text).toBe('after-1');
    const after2Blocks = messages[1].content as Array<{ type: string; text?: string }>;
    expect(after2Blocks[0].text).toBe('after-2');
  });

  it('restoreMessages keeps everything when no compaction', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordUserMessage({ role: 'user', content: 'a' } as Message);
    await storage.recordAssistantMessage({ role: 'assistant', content: 'b' } as Message);
    await storage.recordUserMessage({ role: 'user', content: 'c' } as Message);
    await storage.dispose();

    const reopened = new SessionStorage({ sessionDir, threadId: sessionId });
    const messages = await reopened.restoreMessages();
    expect(messages.length).toBe(3);
  });

  // ────── 损坏行兜底 ──────

  it('skips malformed lines silently in loadTranscript', async () => {
    const goodEntry = makeEnvelopeEntry(1, ContentBlockEvents.MESSAGE_START, envelopeMessageStart(0, 'msg_1'));
    const badLine = '{this-is-not-json';
    const goodEntry2 = makeEnvelopeEntry(2, ContentBlockEvents.MESSAGE_STOP, {
      protocol_version: PROTOCOL_VERSION_V2,
      min_compatible_version: PROTOCOL_VERSION_V2,
      trace_id: sessionId,
      _seq: 1,
      thread_id: sessionId,
      event_type: ContentBlockEvents.MESSAGE_STOP,
      message_id: 'msg_1',
    });
    writeRaw([JSON.stringify(goodEntry), badLine, JSON.stringify(goodEntry2)].join('\n') + '\n');

    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(storage.getVersion()).toBe(2);

    const entries = await storage.loadTranscript();
    expect(entries.length).toBe(2);
  });

  // ────── 大文件 + tail scan ──────

  it('recovers state from a >64KB envelope-based file via tail scan', async () => {
    // 写入 ~1500 条小 envelope 让总大小 > 64 KB
    const lines: string[] = [];
    let parentUuid: string | null = null;
    for (let v = 1; v <= 1500; v++) {
      const e: TranscriptEntry = {
        uuid: `${sessionId}:${v}`,
        parentUuid,
        timestamp: new Date(1_700_000_000_000 + v).toISOString(),
        sessionId,
        version: v,
        type: ContentBlockEvents.MESSAGE_STOP,
        payload: {
          protocol_version: PROTOCOL_VERSION_V2,
          min_compatible_version: PROTOCOL_VERSION_V2,
          trace_id: sessionId,
          _seq: v - 1,
          thread_id: sessionId,
          event_type: ContentBlockEvents.MESSAGE_STOP,
          message_id: `msg_${v}`,
        },
      };
      lines.push(JSON.stringify(e));
      parentUuid = e.uuid;
    }
    const filePath = writeRaw(lines.join('\n') + '\n');
    expect(statSync(filePath).size).toBeGreaterThan(64 * 1024);

    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(storage.getVersion()).toBe(1500);

    // 继续 append——version 单调递增；追加的 5 条 envelope 让 version 增到 1505
    await storage.recordUserMessage({ role: 'user', content: 'next' } as Message);
    await storage.dispose();

    const reopened = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(reopened.getVersion()).toBe(1505);
  });

  it('handles a tail window that starts mid-entry (split first line)', async () => {
    // 构造场景：尾部 64KB 的第一行是被切断的——通过先写一条 80KB envelope
    const longText = 'a'.repeat(80 * 1024);
    const entries: TranscriptEntry[] = [
      {
        uuid: `${sessionId}:1`,
        parentUuid: null,
        timestamp: new Date(1_700_000_000_001).toISOString(),
        sessionId,
        version: 1,
        type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
        payload: {
          protocol_version: PROTOCOL_VERSION_V2,
          min_compatible_version: PROTOCOL_VERSION_V2,
          trace_id: sessionId,
          _seq: 0,
          thread_id: sessionId,
          event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
          message_id: 'msg_1',
          index: 0,
          delta: { type: 'text_delta', text: longText },
        },
      },
      makeEnvelopeEntry(2, ContentBlockEvents.MESSAGE_START, envelopeMessageStart(1, 'msg_2')),
      makeEnvelopeEntry(3, ContentBlockEvents.MESSAGE_STOP, {
        protocol_version: PROTOCOL_VERSION_V2,
        min_compatible_version: PROTOCOL_VERSION_V2,
        trace_id: sessionId,
        _seq: 2,
        thread_id: sessionId,
        event_type: ContentBlockEvents.MESSAGE_STOP,
        message_id: 'msg_2',
      }),
    ];
    writeRaw(entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    // 尾部 64KB 一定包含 version 2 和 3，第一行是被切断的不会 parse 成功
    expect(storage.getVersion()).toBe(3);
  });

  it('does not throw when last line is a partial write without newline', async () => {
    const goodEntry = makeEnvelopeEntry(1, ContentBlockEvents.MESSAGE_START, envelopeMessageStart(0, 'msg_1'));
    writeRaw(JSON.stringify(goodEntry) + '\n' + '{"type":"agent.stream.message_start","payload":{');

    expect(() => new SessionStorage({ sessionDir, threadId: sessionId })).not.toThrow();
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    const entries = await storage.loadTranscript();
    expect(entries.length).toBe(1);
    expect(entries[0].version).toBe(1);
  });

  // ────── 不会泄漏文件描述符 ──────

  it('does not throw on repeated loadTranscript calls (no fd leak smoke test)', async () => {
    const e = makeEnvelopeEntry(1, ContentBlockEvents.MESSAGE_START, envelopeMessageStart(0, 'msg_1'));
    writeRaw(JSON.stringify(e) + '\n');

    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    for (let i = 0; i < 200; i++) {
      const entries = await storage.loadTranscript();
      expect(entries.length).toBe(1);
    }
  });

  // ────── filePath 暴露 ──────

  it('exposes file path correctly', () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    expect(storage.getFilePath()).toBe(join(sessionDir, sessionId, 'messages.jsonl'));
    expect(existsSync(join(sessionDir, sessionId))).toBe(true);
  });

  // ────── parentUuid 链表跨重启延续 ──────

  it('continues parentUuid chain after reopen', async () => {
    const storage = new SessionStorage({ sessionDir, threadId: sessionId });
    await storage.recordUserMessage({ role: 'user', content: 'first' } as Message);
    await storage.dispose();

    const before = readJsonl();
    const lastBeforeUuid = before[before.length - 1].uuid;

    const reopened = new SessionStorage({ sessionDir, threadId: sessionId });
    await reopened.recordUserMessage({ role: 'user', content: 'second' } as Message);
    await reopened.dispose();

    const after = readJsonl();
    // 重启后第一条 entry 的 parentUuid 应当延续之前的 lastUuid
    const firstAfterRestart = after[before.length];
    expect(firstAfterRestart.parentUuid).toBe(lastBeforeUuid);
    // 重启后不再写 cwd / runtimeVersion meta（仅首条注入）
    expect(firstAfterRestart.cwd).toBeUndefined();
    expect(firstAfterRestart.runtimeVersion).toBeUndefined();
  });
});
