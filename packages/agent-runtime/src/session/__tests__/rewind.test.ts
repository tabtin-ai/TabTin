import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStorage } from '../storage.js';
import {
  reconstructMessagesFromTranscriptEntries,
  computeRewindCommitPrefixLength,
} from '../reconstruct-transcript-messages.js';
import { StreamEvents } from '../../engine/contracts/stream-events.js';
import type {
  Message,
} from '../../engine/contracts/conversation.js';
import type {
  TranscriptEntry,
} from '../../engine/contracts/context-capability.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function asstMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function texts(messages: Message[]): string[] {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
      : String(m.content),
  );
}

describe('SessionStorage rewind ', () => {
  it('软标记后 restoreMessages 立刻截断被回退轮次（不删行）', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-aaa' });
    await ss.recordUserMessage(userMsg('q1'));
    await ss.recordAssistantMessage(asstMsg('a1'));
    await ss.recordUserMessage(userMsg('q2'));
    await ss.recordAssistantMessage(asstMsg('a2'));
    await ss.recordUserMessage(userMsg('q3'));
    await ss.recordAssistantMessage(asstMsg('a3'));

    // 回退到保留前 4 条（q1 a1 q2 a2）
    await ss.recordRewindMark(4);
    expect(ss.hasPendingRewind()).toBe(true);

    const restored = await ss.restoreMessages();
    expect(texts(restored)).toEqual(['q1', 'a1', 'q2', 'a2']);

    // 软标记：行仍在盘上（含被回退轮次 + 标记）
    const entries = await ss.loadTranscript();
    const stops = entries.filter((e) => e.type === 'agent.stream.message_stop').length;
    expect(stops).toBe(6);
    expect(entries.some((e) => e.type === StreamEvents.REWIND)).toBe(true);
    await ss.dispose();
  });

  it('commitRewind 物理截断到边界并丢弃标记', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-bbb' });
    await ss.recordUserMessage(userMsg('q1'));
    await ss.recordAssistantMessage(asstMsg('a1'));
    await ss.recordUserMessage(userMsg('q2'));
    await ss.recordAssistantMessage(asstMsg('a2'));
    await ss.recordRewindMark(2);

    await ss.commitRewind();
    expect(ss.hasPendingRewind()).toBe(false);

    const entries = await ss.loadTranscript();
    expect(entries.some((e) => e.type === StreamEvents.REWIND)).toBe(false);
    const restored = await ss.restoreMessages();
    expect(texts(restored)).toEqual(['q1', 'a1']);

    // commit 后继续 append 新轮次，不会再带回旧内容
    await ss.recordUserMessage(userMsg('q3'));
    await ss.recordAssistantMessage(asstMsg('a3'));
    const after = await ss.restoreMessages();
    expect(texts(after)).toEqual(['q1', 'a1', 'q3', 'a3']);
    await ss.dispose();
  });

  it('#6154 withdraw unanswered：editAndResend + 立即 commitRewind 物理去掉未答 user', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-withdraw' });
    await ss.recordUserMessage(userMsg('older'));
    await ss.recordAssistantMessage(asstMsg('reply'));
    const unanswered = userMsg('发错了请撤回');
    await ss.recordUserMessage(unanswered);

    const applied = await ss.applyTimelineRewind({
      target: { messageId: unanswered.id, role: 'user', content: '发错了请撤回' },
      mode: 'editAndResend',
    });
    expect(applied.applied).toBe(true);
    expect(applied.keepMessageCount).toBe(2);

    const cutTs = await ss.commitRewind();
    expect(cutTs).not.toBeNull();
    expect(ss.hasPendingRewind()).toBe(false);
    expect(texts(await ss.restoreMessages())).toEqual(['older', 'reply']);
    await ss.dispose();
  });

  it('commitRewind 返回回退边界 cut_ts（被截断的第一条消息时间）#2725', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-cut' });
    await ss.recordUserMessage(userMsg('q1'));
    await ss.recordAssistantMessage(asstMsg('a1'));
    await ss.recordUserMessage(userMsg('q2')); // 被回退的第一条
    await ss.recordAssistantMessage(asstMsg('a2'));
    await ss.recordRewindMark(2);

    const before = await ss.loadTranscript();
    const prefixLen = computeRewindCommitPrefixLength(before);
    expect(prefixLen).not.toBeNull();
    const expectedCut = Date.parse(before[prefixLen!]!.timestamp);

    const cutTs = await ss.commitRewind();
    expect(cutTs).toBe(expectedCut);
    await ss.dispose();
  });

  it('commitRewind 无待 commit 标记时返回 null ', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-cut2' });
    await ss.recordUserMessage(userMsg('q1'));
    const cutTs = await ss.commitRewind();
    expect(cutTs).toBeNull();
    await ss.dispose();
  });

  it('clearRewind 撤销回退恢复全部轮次', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-ccc' });
    await ss.recordUserMessage(userMsg('q1'));
    await ss.recordAssistantMessage(asstMsg('a1'));
    await ss.recordUserMessage(userMsg('q2'));
    await ss.recordAssistantMessage(asstMsg('a2'));
    await ss.recordRewindMark(2);
    expect(texts(await ss.restoreMessages())).toEqual(['q1', 'a1']);

    await ss.clearRewind();
    expect(ss.hasPendingRewind()).toBe(false);
    expect(texts(await ss.restoreMessages())).toEqual(['q1', 'a1', 'q2', 'a2']);
    await ss.dispose();
  });

  it('resolveRewindKeepCount 按 assistant message_id 命中（不依赖 checkpoint）', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-id1' });
    // 用 appendStreamEvent 写带已知 message_id 的 assistant 6 件套（模拟流式落盘，
    // message_start.message_id === DB ChatMessage.id）。
    async function writeAsst(id: string, text: string) {
      await ss.appendStreamEvent({ type: 'agent.stream.message_start', payload: { message_id: id, role: 'assistant' } });
      await ss.appendStreamEvent({ type: 'agent.stream.content_block_start', payload: { message_id: id, index: 0, block: { type: 'text', text: '' } } });
      await ss.appendStreamEvent({ type: 'agent.stream.content_block_delta', payload: { message_id: id, index: 0, delta: { type: 'text_delta', text } } });
      await ss.appendStreamEvent({ type: 'agent.stream.content_block_stop', payload: { message_id: id, index: 0 } });
      await ss.appendStreamEvent({ type: 'agent.stream.message_stop', payload: { message_id: id } });
    }
    await ss.recordUserMessage(userMsg('q1'));
    await writeAsst('asst-1', 'a1');
    await ss.recordUserMessage(userMsg('q2'));
    await writeAsst('asst-2', 'a2');
    await ss.recordUserMessage(userMsg('q3'));
    await writeAsst('asst-3', 'a3');

    // 「回退到此版本」到 asst-2：保留 asst-2 本身、仅移除其后 → 保留 q1 a1 q2 a2 = 4 条
    expect(await ss.resolveRewindKeepCount('asst-2', 'assistant', undefined)).toBe(4);
    // 「回退到此位置」asst-1：保留 asst-1 本身、仅移除其后 → 保留 q1 a1 = 2 条
    expect(await ss.resolveRewindKeepCount('asst-1', 'assistant', undefined)).toBe(2);

    const keep = await ss.resolveRewindKeepCount('asst-2', 'assistant', undefined);
    await ss.recordRewindMark(keep!);
    expect(texts(await ss.restoreMessages())).toEqual(['q1', 'a1', 'q2', 'a2']);
    await ss.dispose();
  });

  it('resolveRewindKeepCount 未命中 id 时回退 fallback', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-id2' });
    await ss.recordUserMessage(userMsg('q1'));
    await ss.recordAssistantMessage(asstMsg('a1'));
    const keep = await ss.resolveRewindKeepCount('not-exist', 'assistant', 1);
    expect(keep).toBe(1);
    const keepNull = await ss.resolveRewindKeepCount('not-exist', 'assistant', undefined);
    expect(keepNull).toBeNull();
    await ss.dispose();
  });

  it('applyTimelineRewind 以 runtime timeline 为权威，回退首条真实 user 时不保留 environment_context ', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-runtime-authority' });
    async function writeUser(id: string, text: string, messageKind?: string) {
      await ss.appendStreamEvent({
        type: 'agent.stream.message_start',
        payload: { message_id: id, role: 'user', ...(messageKind ? { message_kind: messageKind } : {}) },
      });
      await ss.appendStreamEvent({
        type: 'agent.stream.content_block_start',
        payload: { message_id: id, index: 0, block: { type: 'text', text: '' } },
      });
      await ss.appendStreamEvent({
        type: 'agent.stream.content_block_delta',
        payload: { message_id: id, index: 0, delta: { type: 'text_delta', text } },
      });
      await ss.appendStreamEvent({
        type: 'agent.stream.content_block_stop',
        payload: { message_id: id, index: 0 },
      });
      await ss.appendStreamEvent({
        type: 'agent.stream.message_stop',
        payload: { message_id: id },
      });
    }
    await writeUser('ctx-1', '<context type="environment">hidden</context>', 'environment_context');
    await writeUser('server-user-1', 'nihao');
    await ss.recordAssistantMessage(asstMsg('hello'));

    const result = await ss.applyTimelineRewind({
      target: {
        messageId: 'db-user-id-that-is-not-in-transcript',
        role: 'user',
        content: 'nihao',
      },
      mode: 'editAndResend',
    });

    expect(result.applied).toBe(true);
    expect(result.keepMessageCount).toBe(0);
    expect(result.visibleMessages).toHaveLength(0);
    expect(result.hiddenMessages).toHaveLength(3);
    expect(texts(await ss.restoreMessages())).toEqual([]);
    await ss.dispose();
  });

  it('applyTimelineRewind 用 occurrenceIndex 区分重复 user 内容 ', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-runtime-duplicate' });
    await ss.recordUserMessage(userMsg('repeat'));
    await ss.recordAssistantMessage(asstMsg('a1'));
    await ss.recordUserMessage(userMsg('repeat'));
    await ss.recordAssistantMessage(asstMsg('a2'));

    const result = await ss.applyTimelineRewind({
      target: {
        role: 'user',
        content: 'repeat',
        occurrenceIndex: 1,
      },
      mode: 'editAndResend',
    });

    expect(result.applied).toBe(true);
    expect(result.keepMessageCount).toBe(0);
    expect(texts(await ss.restoreMessages())).toEqual([]);
    await ss.dispose();
  });

  it('pending rewind 跨实例（重启）恢复', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-ddd' });
    await ss.recordUserMessage(userMsg('q1'));
    await ss.recordAssistantMessage(asstMsg('a1'));
    await ss.recordUserMessage(userMsg('q2'));
    await ss.recordRewindMark(2);
    await ss.dispose();

    const ss2 = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-session-ddd' });
    expect(ss2.hasPendingRewind()).toBe(true);
    expect(texts(await ss2.restoreMessages())).toEqual(['q1', 'a1']);
    await ss2.dispose();
  });
});

describe('reconstruct rewind pure helpers ', () => {
  function entry(type: string, payload: Record<string, unknown>, v: number): TranscriptEntry {
    return {
      uuid: `t:${v}`,
      parentUuid: v > 1 ? `t:${v - 1}` : null,
      timestamp: new Date().toISOString(),
      threadId: 't',
      version: v,
      type,
      payload,
    };
  }

  function msgGroup(role: string, text: string, base: number): TranscriptEntry[] {
    return [
      entry('agent.stream.message_start', { role, message_id: `${role}-${base}` }, base),
      entry('agent.stream.content_block_start', { index: 0, block: { type: 'text', text: '' } }, base + 1),
      entry('agent.stream.content_block_delta', { index: 0, delta: { type: 'text_delta', text } }, base + 2),
      entry('agent.stream.content_block_stop', { index: 0 }, base + 3),
      entry('agent.stream.message_stop', { message_id: `${role}-${base}` }, base + 4),
    ];
  }

  it('行内 rewind 标记截断重建消息', () => {
    const entries: TranscriptEntry[] = [
      ...msgGroup('user', 'q1', 1),
      ...msgGroup('assistant', 'a1', 6),
      ...msgGroup('user', 'q2', 11),
      ...msgGroup('assistant', 'a2', 16),
      entry(StreamEvents.REWIND, { phase: 'mark', keep_message_count: 2 }, 21),
    ];
    const msgs = reconstructMessagesFromTranscriptEntries(entries);
    expect(msgs.length).toBe(2);
  });

  it('computeRewindCommitPrefixLength 返回正确前缀', () => {
    const entries: TranscriptEntry[] = [
      ...msgGroup('user', 'q1', 1), // idx 0..4
      ...msgGroup('assistant', 'a1', 6), // idx 5..9
      ...msgGroup('user', 'q2', 11), // idx 10..14
      entry(StreamEvents.REWIND, { phase: 'mark', keep_message_count: 2 }, 16), // idx 15
    ];
    // 保留 2 条消息 = 前 10 个 entry（q1 5 + a1 5），丢标记
    expect(computeRewindCommitPrefixLength(entries)).toBe(10);
  });

  it('标记后已有新消息时 commit no-op（返回 null）', () => {
    const entries: TranscriptEntry[] = [
      ...msgGroup('user', 'q1', 1),
      entry(StreamEvents.REWIND, { phase: 'mark', keep_message_count: 1 }, 6),
      ...msgGroup('user', 'q2', 7), // 标记后又来了新消息
    ];
    expect(computeRewindCommitPrefixLength(entries)).toBeNull();
  });
});
