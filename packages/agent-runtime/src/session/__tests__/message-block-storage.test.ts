import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MessageBlockStorage,
  reconstructMessagesFromBlockRecords,
  blockRecordsToTranscriptMessages,
} from '../message-block-storage.js';
import type { MessageBlockRecord } from '../message-block-storage.js';
import { SessionStorage } from '../storage.js';
import { reconstructMessagesFromTranscriptEntries } from '../reconstruct-transcript-messages.js';
import { StreamEvents } from '../../engine/contracts/stream-events.js';
import type { Message, ContentBlock } from '../../engine/contracts/conversation.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-block-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function record(overrides: Partial<MessageBlockRecord> & { message_id: string }): MessageBlockRecord {
  return {
    v: 1,
    recorded_at: new Date().toISOString(),
    role: 'user',
    message_kind: 'llm',
    blocks_json: [{ type: 'text', text: 'hi' } as ContentBlock],
    ...overrides,
  };
}

describe('MessageBlockStorage ', () => {
  it('append + load 往返一致', async () => {
    const storage = new MessageBlockStorage(tmpDir, 't1');
    await storage.append(record({ message_id: 'u1' }));
    await storage.append(record({
      message_id: 'a1',
      role: 'assistant',
      blocks_json: [
        { type: 'text', text: 'answer' } as ContentBlock,
        { type: 'tool_use', id: 'tc1', name: 'shell', input: { command: 'ls' } } as ContentBlock,
        { type: 'tool_result', tool_use_id: 'tc1', content: 'ok' } as ContentBlock,
      ],
      stop_reason: 'tool_use',
    }));
    const loaded = await storage.load();
    expect(loaded.map((r) => r.message_id)).toEqual(['u1', 'a1']);
    expect(loaded[1].blocks_json).toHaveLength(3);
    expect(loaded[1].stop_reason).toBe('tool_use');
  });

  it('同 message_id upsert：保留时间轴位置、内容取最新', async () => {
    const storage = new MessageBlockStorage(tmpDir, 't2');
    await storage.append(record({ message_id: 'u1' }));
    await storage.append(record({ message_id: 'a1', role: 'assistant' }));
    await storage.append(record({
      message_id: 'a1',
      role: 'assistant',
      blocks_json: [{ type: 'text', text: 'revised' } as ContentBlock],
    }));
    const loaded = await storage.load();
    expect(loaded.map((r) => r.message_id)).toEqual(['u1', 'a1']);
    expect((loaded[1].blocks_json[0] as { text: string }).text).toBe('revised');
  });

  it('truncateFrom 按 recorded_at 截断（回退对称删）', async () => {
    const storage = new MessageBlockStorage(tmpDir, 't3');
    const early = new Date(Date.now() - 60_000).toISOString();
    const late = new Date(Date.now() + 60_000).toISOString();
    await storage.append(record({ message_id: 'keep', recorded_at: early }));
    await storage.append(record({ message_id: 'drop', recorded_at: late }));
    await storage.truncateFrom(Date.now());
    const loaded = await storage.load();
    expect(loaded.map((r) => r.message_id)).toEqual(['keep']);
  });

  it('坏行跳过，不阻塞后续解析', async () => {
    const storage = new MessageBlockStorage(tmpDir, 't4');
    await storage.append(record({ message_id: 'u1' }));
    await storage.flushPendingWrites();
    fs.appendFileSync(storage.filePath, '{broken json\n');
    await storage.append(record({ message_id: 'u2' }));
    const loaded = await storage.load();
    expect(loaded.map((r) => r.message_id)).toEqual(['u1', 'u2']);
  });
});

describe('reconstructMessagesFromBlockRecords ', () => {
  it('assistant 记录拆 tool_result 为后续 user 消息（对齐 live state.messages）', () => {
    const messages = reconstructMessagesFromBlockRecords([
      record({ message_id: 'u1' }),
      record({
        message_id: 'a1',
        role: 'assistant',
        blocks_json: [
          { type: 'thinking', thinking: 't' } as ContentBlock,
          { type: 'tool_use', id: 'tc1', name: 'shell', input: {} } as ContentBlock,
          { type: 'tool_result', tool_use_id: 'tc1', content: 'out' } as ContentBlock,
        ],
      }),
    ]);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(messages[2].content.map((b) => b.type)).toEqual(['tool_result']);
  });

  it('compaction_boundary 截断此前历史并以摘要为新起点', () => {
    const messages = reconstructMessagesFromBlockRecords([
      record({ message_id: 'u1' }),
      record({ message_id: 'a1', role: 'assistant' }),
      record({
        message_id: 'compaction-x',
        message_kind: 'compaction_summary',
        compaction_boundary: true,
        blocks_json: [{ type: 'text', text: '[对话摘要]…' } as ContentBlock],
      }),
      record({ message_id: 'u2', blocks_json: [{ type: 'text', text: 'next' } as ContentBlock] }),
    ]);
    expect(messages).toHaveLength(2);
    expect((messages[0].content[0] as { text: string }).text).toContain('[对话摘要]');
    expect((messages[1].content[0] as { text: string }).text).toBe('next');
  });

  it('子 Agent 记录不进主对话历史', () => {
    const messages = reconstructMessagesFromBlockRecords([
      record({ message_id: 'u1' }),
      record({ message_id: 'sub-a1', role: 'assistant', subagent_run_id: 'run-1' }),
    ]);
    expect(messages).toHaveLength(1);
  });

  it('#8550：system_prompt_context 不进 LLM 历史重建', () => {
    const messages = reconstructMessagesFromBlockRecords([
      record({
        message_id: 'sys-1',
        message_kind: 'system_prompt_context',
        blocks_json: [{ type: 'text', text: '<identity>\nrules\n</identity>' } as ContentBlock],
      }),
      record({ message_id: 'u1', blocks_json: [{ type: 'text', text: '你好' } as ContentBlock] }),
      record({
        message_id: 'hitl-1',
        message_kind: 'hitl_interaction',
        blocks_json: [],
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect((messages[0].content[0] as { text: string }).text).toBe('你好');
  });

  it('reconstruct 只做结构还原，不插入身份注解', () => {
    const messages = reconstructMessagesFromBlockRecords([
      record({
        message_id: 'a1',
        role: 'assistant',
        blocks_json: [{ type: 'text', text: '我是上一轮的回答' } as ContentBlock],
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '我是上一轮的回答' }],
    });
    const text = JSON.stringify(messages);
    expect(text).not.toContain('system-reminder');
    expect(text).not.toContain('turn_identity');
  });
});

describe('blockRecordsToTranscriptMessages（UI 冷读形态）', () => {
  it('空正文终态错误仍保留结构化错误供统一卡片恢复', () => {
    const errorInfo = {
      error_class: 'LLM_BILLING_ERROR',
      category: 'organization_insufficient_credits',
    };
    const out = blockRecordsToTranscriptMessages([
      record({
        message_id: 'billing-error',
        role: 'assistant',
        blocks_json: [],
        stop_reason: 'error',
        error_info_json: errorInfo,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].blocks).toEqual([]);
    expect(out[0].errorInfoJson).toEqual(errorInfo);
  });

  it('tool_result 保持 co-locate、compaction 记录透传（前端按 kind 渲染分隔）', () => {
    const out = blockRecordsToTranscriptMessages([
      record({
        message_id: 'a1',
        role: 'assistant',
        blocks_json: [
          { type: 'tool_use', id: 'tc1', name: 'shell', input: {} } as ContentBlock,
          { type: 'tool_result', tool_use_id: 'tc1', content: 'out' } as ContentBlock,
        ],
        stop_reason: 'end_turn',
      }),
      record({
        message_id: 'compaction-x',
        compaction_boundary: true,
        message_kind: 'compaction_summary',
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].blocks.map((b) => b.type)).toEqual(['tool_use', 'tool_result']);
    expect(out[0].stopReason).toBe('end_turn');
    expect(out[0].messageId).toBe('a1');
    expect(out[1].messageKind).toBe('compaction_summary');
  });

  it('真 user query 的 context wrapper 在 UI 形态被剥掉（与 DB visible 口径一致）', () => {
    const out = blockRecordsToTranscriptMessages([
      record({
        message_id: 'u1',
        blocks_json: [{
          type: 'text',
          text: '帮我总结\n\n<context type="attached" filename="a.txt" stale_after_turn="x">\n文件正文\n</context>',
        } as ContentBlock],
      }),
      record({
        message_id: 'env-1',
        message_kind: 'environment_context',
        blocks_json: [{
          type: 'text',
          text: '<context type="environment">env</context>',
        } as ContentBlock],
      }),
    ]);
    expect((out[0].blocks[0] as { text: string }).text).toBe('帮我总结');
    // environment_context 不剥（它整体就是 context，前端按 kind 隐藏/折叠）
    expect((out[1].blocks[0] as { text: string }).text).toContain('<context');
  });

  it('#5592：metadata.triggered_by 透传到 triggeredBy（push 通知重载还原收敛卡）', () => {
    const out = blockRecordsToTranscriptMessages([
      record({
        message_id: 'push-1',
        blocks_json: [{ type: 'text', text: 'A background command completed…' } as ContentBlock],
        metadata: { triggered_by: 'push-notification' },
      }),
      record({ message_id: 'u-real' }), // 普通 user，无 metadata
    ]);
    expect(out[0].triggeredBy).toBe('push-notification');
    expect(out[1].triggeredBy).toBeUndefined();
  });

});

describe('SessionStorage × message block 集成 ', () => {
  function userMsg(text: string): Message {
    return { role: 'user', content: [{ type: 'text', text }] };
  }

  async function emitPersist(
    ss: SessionStorage,
    messageId: string,
    blocks: ContentBlock[],
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await ss.appendStreamEvent({
      type: StreamEvents.PERSIST_MESSAGE,
      payload: {
        message_id: messageId,
        client_event_id: messageId,
        role: 'assistant',
        blocks_json: blocks as unknown as Record<string, unknown>[],
        arrival_seq: Date.now() * 1000,
        message_kind: 'llm',
        ...extra,
      },
    });
  }

  it('空正文 persist_message 仅凭 error_info_json 也会落 block 文件', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-error-1' });
    await emitPersist(ss, 'asst-error', [], {
      stop_reason: 'error',
      partial: true,
      error_info_json: {
        error_class: 'LLM_BILLING_ERROR',
        category: 'organization_insufficient_credits',
      },
    });
    const records = await ss.blockStorage.load();
    expect(records).toHaveLength(1);
    expect(records[0].blocks_json).toEqual([]);
    expect(records[0].error_info_json?.error_class).toBe('LLM_BILLING_ERROR');
    await ss.dispose();
  });

  it('persist_message 路由进 block 文件，restoreMessages 优先从 block 重建', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-1' });
    await ss.recordUserMessage(userMsg('q1'), { messageId: 'user-1' });
    await ss.appendUserBlockRecord(userMsg('q1'), { messageId: 'user-1' });
    await emitPersist(ss, 'asst-1', [
      { type: 'text', text: 'a1' } as ContentBlock,
      { type: 'tool_use', id: 'tc1', name: 'shell', input: { command: 'ls' } } as ContentBlock,
      { type: 'tool_result', tool_use_id: 'tc1', content: 'files' } as ContentBlock,
    ], { stop_reason: 'tool_use' });

    const restored = await ss.restoreMessages();
    // block 权威：user + assistant(拆出 tool_result 的 user 载体)
    expect(restored.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const asstBlocks = restored[1].content as ContentBlock[];
    expect(asstBlocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
    // 六件套里没有 assistant（未走 recordAssistantMessage）——证明读的是 block 文件
    expect(fs.existsSync(ss.blockStorage.filePath)).toBe(true);
    await ss.dispose();
  });

  it('子代理历史恢复·方案 A：带 subagent_run_id 的 persist_message 落 block 文件，UI 冷读带出 subagentRunId、LLM 历史重建跳过', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-sub-1' });
    // 父 Agent 一条正常消息 + 子/孙代理各一条（模拟 setSubagentTraceWiring 把子/孙
    // 代理 persist_message 也路由进父会话 block 文件）。
    await ss.appendUserBlockRecord(userMsg('父问题'), { messageId: 'user-1' });
    await emitPersist(ss, 'main-a1', [{ type: 'text', text: '父回复' } as ContentBlock]);
    await emitPersist(ss, 'child-a1', [{ type: 'text', text: '子代理回复' } as ContentBlock], {
      subagent_run_id: 'run-child',
    });
    await emitPersist(ss, 'grand-a1', [{ type: 'text', text: '孙代理回复' } as ContentBlock], {
      subagent_run_id: 'run-grand',
    });

    const records = await ss.blockStorage.load();
    expect(records.find((r) => r.message_id === 'child-a1')?.subagent_run_id).toBe('run-child');
    expect(records.find((r) => r.message_id === 'grand-a1')?.subagent_run_id).toBe('run-grand');

    // UI 冷读：子/孙代理消息带出 subagentRunId（SubagentDetailPane 按它作用域过滤）。
    const cold = blockRecordsToTranscriptMessages(records);
    expect(cold.find((m) => m.messageId === 'child-a1')?.subagentRunId).toBe('run-child');
    expect(cold.find((m) => m.messageId === 'grand-a1')?.subagentRunId).toBe('run-grand');
    expect(cold.find((m) => m.messageId === 'main-a1')?.subagentRunId).toBeUndefined();

    // LLM 历史重建：子/孙代理消息不进主对话上下文，只保留父 user + 父 assistant。
    const llm = reconstructMessagesFromBlockRecords(records);
    expect(llm.map((m) => m.role)).toEqual(['user', 'assistant']);
    await ss.dispose();
  });

  it('#5592：appendUserBlockRecord triggeredBy 落进 block 记录 metadata，冷读带出 triggeredBy', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-push-1' });
    await ss.appendUserBlockRecord(userMsg('A background command completed…'), {
      messageId: 'push-1',
      triggeredBy: 'push-notification',
    });
    await ss.appendUserBlockRecord(userMsg('真用户输入'), { messageId: 'user-1' });
    const records = await ss.blockStorage.load();
    expect(records.find((r) => r.message_id === 'push-1')?.metadata?.triggered_by).toBe('push-notification');
    expect(records.find((r) => r.message_id === 'user-1')?.metadata).toBeUndefined();
    const cold = blockRecordsToTranscriptMessages(records);
    expect(cold.find((m) => m.messageId === 'push-1')?.triggeredBy).toBe('push-notification');
    expect(cold.find((m) => m.messageId === 'user-1')?.triggeredBy).toBeUndefined();
    await ss.dispose();
  });

  it('#9460：系统注入按 system 落 block，冷读保留 system，LLM 重建投影为 user', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-system-injection' });
    await ss.appendUserBlockRecord(userMsg('skill body'), {
      messageId: 'skill-1',
      role: 'system',
      source: 'skill_invoke',
    });
    await ss.appendUserBlockRecord(userMsg('background complete'), {
      messageId: 'push-1',
      triggeredBy: 'push-notification',
    });

    const records = await ss.blockStorage.load();
    expect(records.map((record) => record.role)).toEqual(['system', 'system']);
    expect(records[0]?.metadata?.source).toBe('skill_invoke');
    expect(records[1]?.metadata?.triggered_by).toBe('push-notification');

    const cold = blockRecordsToTranscriptMessages(records);
    expect(cold.map((message) => message.role)).toEqual(['system', 'system']);
    const llm = reconstructMessagesFromBlockRecords(records);
    expect(llm.map((message) => message.role)).toEqual(['user', 'user']);
    await ss.dispose();
  });

  it('#9460：系统注入在六件套保留 system，只有 LLM restore 投影为 user', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-system-envelope' });
    await ss.recordSystemMessage(userMsg('<context type="environment">workspace</context>'), {
      messageId: 'env-system-1',
      messageKind: 'environment_context',
    });

    const entries = await ss.loadTranscript();
    const start = entries.find((entry) => entry.type === 'agent.stream.message_start');
    expect(start?.payload).toMatchObject({
      message_id: 'env-system-1',
      role: 'system',
      message_kind: 'environment_context',
    });
    const cold = reconstructMessagesFromTranscriptEntries(entries);
    expect(cold).toHaveLength(1);
    expect(cold[0]).toMatchObject({
      messageId: 'env-system-1',
      role: 'system',
      messageKind: 'environment_context',
    });
    const llm = await ss.restoreMessages();
    expect(llm.map((message) => message.role)).toEqual(['user']);
    await ss.dispose();
  });

  it('compaction 检查点 persist（kind=compaction_summary）成为边界，restore 从摘要起', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-2' });
    await ss.appendUserBlockRecord(userMsg('old'), { messageId: 'user-old' });
    await emitPersist(ss, 'asst-old', [{ type: 'text', text: 'old-answer' } as ContentBlock]);
    // CompactionController 在压缩完成后 emit 的检查点 persist（role=user +
    // kind=compaction_summary）——storage persist 分支据 kind 打 boundary 标记。
    await ss.appendStreamEvent({
      type: StreamEvents.PERSIST_MESSAGE,
      payload: {
        message_id: 'compaction-ckpt-1',
        client_event_id: 'compaction-ckpt-1',
        role: 'user',
        blocks_json: [{ type: 'text', text: '[对话摘要]\n\n前情提要\n\n[摘要结束]' }],
        message_kind: 'compaction_summary',
        arrival_seq: Date.now() * 1000,
      },
    });
    await ss.appendUserBlockRecord(userMsg('new'), { messageId: 'user-new' });

    const records = await ss.blockStorage.load();
    expect(records.find((record) => record.message_id === 'compaction-ckpt-1')?.role).toBe('system');
    const restored = await ss.restoreMessages();
    expect(restored).toHaveLength(2);
    expect((restored[0].content as ContentBlock[])[0]).toMatchObject({ type: 'text' });
    expect(((restored[0].content as ContentBlock[])[0] as { text: string }).text).toContain('前情提要');
    expect(((restored[1].content as ContentBlock[])[0] as { text: string }).text).toBe('new');
    await ss.dispose();
  });

  it('commitRewind 同步截断 block 文件', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-3' });
    await ss.recordUserMessage(userMsg('q1'), { messageId: 'user-1' });
    await ss.appendUserBlockRecord(userMsg('q1'), { messageId: 'user-1' });
    await emitPersist(ss, 'asst-1', [{ type: 'text', text: 'a1' } as ContentBlock]);
    // 人为拉开时间，让回退边界（第二轮开始）与第一轮有可区分的时间戳
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ss.recordUserMessage(userMsg('q2'), { messageId: 'user-2' });
    await ss.appendUserBlockRecord(userMsg('q2'), { messageId: 'user-2' });
    await emitPersist(ss, 'asst-2', [{ type: 'text', text: 'a2' } as ContentBlock]);

    // 回退到只保留第一轮（六件套里只有 user 消息 → keep=1 保 q1）
    await ss.recordRewindMark(1);
    await ss.commitRewind();

    const records = await ss.blockStorage.load();
    expect(records.map((r) => r.message_id)).toEqual(['user-1', 'asst-1']);
    const restored = await ss.restoreMessages();
    expect(restored.map((m) => m.role)).toEqual(['user', 'assistant']);
    await ss.dispose();
  });

  it('pending rewind（未 commit）时回落六件套重放', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-4' });
    await ss.recordUserMessage(userMsg('q1'), { messageId: 'user-1' });
    await ss.appendUserBlockRecord(userMsg('q1'), { messageId: 'user-1' });
    await ss.recordUserMessage(userMsg('q2'), { messageId: 'user-2' });
    await ss.appendUserBlockRecord(userMsg('q2'), { messageId: 'user-2' });
    await ss.recordRewindMark(1);

    // 六件套行内 rewind 生效：只剩 q1；block 文件虽有 2 条但不被采用
    const restored = await ss.restoreMessages();
    expect(restored).toHaveLength(1);
    expect(((restored[0].content as ContentBlock[])[0] as { text: string }).text).toBe('q1');
    await ss.dispose();
  });

  it('ensureBlockBackfillFromTranscript 物化存量六件套历史（幂等）', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-5' });
    await ss.recordUserMessage(userMsg('q1'), { messageId: 'user-1' });
    await ss.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
    expect(ss.blockStorage.hasRecords()).toBe(false);

    await ss.ensureBlockBackfillFromTranscript();
    const records = await ss.blockStorage.load();
    expect(records.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(records[0].message_id).toBe('user-1');

    // 幂等：再调不重复
    await ss.ensureBlockBackfillFromTranscript();
    expect(await ss.blockStorage.load()).toHaveLength(2);
    await ss.dispose();
  });

  it('recordUserMessage 用宿主传入的 messageId 写六件套 message_start', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-6' });
    await ss.recordUserMessage(userMsg('q1'), { messageId: 'client-evt-1' });
    const entries = await ss.loadTranscript();
    const start = entries.find((e) => e.type === 'agent.stream.message_start');
    expect((start?.payload as { message_id?: string }).message_id).toBe('client-evt-1');
    await ss.dispose();
  });

  it('#5592：recordUserMessage 把 triggeredBy 写入 message_start，六件套回放带出', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-7' });
    await ss.recordUserMessage(userMsg('push done'), {
      messageId: 'push-1',
      triggeredBy: 'push-notification',
    });
    const entries = await ss.loadTranscript();
    const start = entries.find((e) => e.type === 'agent.stream.message_start');
    expect((start?.payload as { triggered_by?: string }).triggered_by).toBe('push-notification');

    const reconstructed = reconstructMessagesFromTranscriptEntries(entries);
    expect(reconstructed[0]?.triggeredBy).toBe('push-notification');
    await ss.dispose();
  });

  it('#5592：ensureBlockBackfillFromTranscript 透传 triggeredBy 到 blocks metadata', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-8' });
    await ss.recordUserMessage(userMsg('push done'), {
      messageId: 'push-1',
      triggeredBy: 'push-notification',
    });
    expect(ss.blockStorage.hasRecords()).toBe(false);

    await ss.ensureBlockBackfillFromTranscript();
    const records = await ss.blockStorage.load();
    expect(records).toHaveLength(1);
    expect(records[0]?.metadata?.triggered_by).toBe('push-notification');
    await ss.dispose();
  });

  it('#9460：系统触发的 recordUserMessage 六件套保存真实 system 作者', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-9' });
    await ss.recordUserMessage(userMsg('background done'), {
      messageId: 'push-system',
      triggeredBy: 'push-notification',
    });
    await ss.recordUserMessage(userMsg('parent guidance'), {
      messageId: 'parent-system',
      triggeredBy: 'parent_midflight',
    });
    await ss.recordUserMessage(userMsg('human'), {
      messageId: 'human-user',
      triggeredBy: 'user',
    });

    const reconstructed = reconstructMessagesFromTranscriptEntries(await ss.loadTranscript());
    expect(reconstructed.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    await ss.dispose();
  });

  it('#9460：Skill 六件套 backfill 保留 source 元数据', async () => {
    const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-blk-10' });
    await ss.recordSystemMessage(userMsg('skill body'), {
      messageId: 'skill-system',
      source: 'skill_invoke',
    });
    await ss.ensureBlockBackfillFromTranscript();

    const records = await ss.blockStorage.load();
    expect(records[0]?.role).toBe('system');
    expect(records[0]?.metadata?.source).toBe('skill_invoke');
    await ss.dispose();
  });
});
