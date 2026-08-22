import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { HitlInteractionEvent, hitlMessageId } from '../src/event/events/persist-events.js';
import type { HitlInteractionArgs } from '../src/event/events/persist-events.js';

// 事件深改后 HITL 走 HitlInteractionEvent 类；本地适配保持用例主体不变。
const buildHitlInteractionPersistEvent = (a: HitlInteractionArgs) => new HitlInteractionEvent(a).toStreamEvent();
import { SessionStorage } from '../src/session/storage.js';
import {
  blockRecordsToTranscriptMessages,
  reconstructMessagesFromBlockRecords,
} from '../src/session/message-block-storage.js';

// HITL 走与其它 persist 同一条链路（buildPersistMessageEvent）；这里锁定：
//   1. message_id 与 Python `uuid.uuid5(HITL_MESSAGE_NAMESPACE, "hitl:{kind}:{key}")` 逐字节一致
//      （否则 runtime 已死时 Django 终态翻转命中另一行 → 重复卡）；
//   2. persist 事件形态（message_kind / metadata.hitl / 空 blocks）；
//   3. 空块 hitl 记录能落 message-blocks.jsonl、冷读带出 metadata、且不进 LLM 历史。
describe('HITL persist（单一 persist 链路）', () => {
  it('hitlMessageId 与 Python uuid5 golden 逐字节一致', () => {
    // golden 由 `python3 -c "import uuid; ..."` 生成（namespace 与 Django 同值）。
    expect(hitlMessageId('tool_approval', 'batch-1')).toBe('2c07a4d6-60fb-54af-8491-786b724e100c');
    expect(hitlMessageId('ask_choice', 'req-9')).toBe('b0dd24d9-10ae-5a36-8823-5dee303b6b28');
  });

  it('pending / resolved 用同一 message_id（upsert 同一行）', () => {
    const pending = buildHitlInteractionPersistEvent({
      kind: 'tool_approval', requestKey: 'b1', status: 'pending', agentRunId: 'run-hitl', payload: { batch_id: 'b1' },
    });
    const resolved = buildHitlInteractionPersistEvent({
      kind: 'tool_approval', requestKey: 'b1', status: 'resolved', agentRunId: 'run-hitl', payload: {}, result: { ok: true },
    });
    const pid = (pending.payload as { message_id: string }).message_id;
    const rid = (resolved.payload as { message_id: string }).message_id;
    expect(pid).toBe(rid);
    expect(pid).toBe(hitlMessageId('tool_approval', 'b1'));
  });

  it('persist 事件形态：PERSIST_MESSAGE + message_kind=hitl_interaction + 空 blocks + metadata.hitl', () => {
    const ev = buildHitlInteractionPersistEvent({
      kind: 'ask_choice', requestKey: 'q1', status: 'pending', agentRunId: 'run-hitl',
      payload: { request_id: 'q1', questions: [{ id: 'x' }] }, expiresAtMs: 123,
    });
    expect(ev.type).toBe(StreamEvents.PERSIST_MESSAGE);
    const p = ev.payload as Record<string, unknown>;
    expect(p.message_kind).toBe('hitl_interaction');
    expect(p.agent_run_id).toBe('run-hitl');
    expect(p.blocks_json).toEqual([]);
    const hitl = (p.metadata as { hitl: Record<string, unknown> }).hitl;
    expect(hitl.kind).toBe('ask_choice');
    expect(hitl.request_key).toBe('q1');
    expect(hitl.status).toBe('pending');
    expect(hitl.expires_at).toBe(123);
    expect((hitl.payload as { request_id: string }).request_id).toBe('q1');
  });

  describe('SessionStorage 空块 hitl round-trip', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-')); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('hitl persist（空 blocks）落 message-blocks.jsonl，冷读带出 metadata.hitl，LLM 历史跳过', async () => {
      const ss = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-hitl-1' });
      // 一条正常 assistant（有块）+ 一条 hitl（空块）。
      await ss.appendStreamEvent({
        type: StreamEvents.PERSIST_MESSAGE,
        payload: {
          message_id: 'a1', client_event_id: 'a1', role: 'assistant',
          blocks_json: [{ type: 'text', text: 'hi' }], message_kind: 'llm',
          agent_run_id: 'run-hitl', arrival_seq: 1,
        },
      });
      await ss.appendStreamEvent(buildHitlInteractionPersistEvent({
        kind: 'tool_approval', requestKey: 'b1', status: 'pending', agentRunId: 'run-hitl',
        payload: { batch_id: 'b1', action_requests: [{ tool_name: 'shell' }] }, expiresAtMs: 999,
      }));

      const records = await ss.blockStorage.load();
      const hitlRec = records.find((r) => r.message_kind === 'hitl_interaction');
      expect(hitlRec).toBeTruthy();
      expect(hitlRec!.blocks_json).toEqual([]);
      expect((hitlRec!.metadata as { hitl: { status: string } }).hitl.status).toBe('pending');

      // UI 冷读：hitl 记录保留（空块不被过滤）+ metadata 带出。
      const cold = blockRecordsToTranscriptMessages(records);
      const coldHitl = cold.find((m) => m.messageKind === 'hitl_interaction');
      expect(coldHitl).toBeTruthy();
      expect((coldHitl!.metadata as { hitl: { request_key: string } }).hitl.request_key).toBe('b1');

      // LLM 历史：hitl 不进上下文，只留正常 assistant。
      const llm = reconstructMessagesFromBlockRecords(records);
      expect(llm).toHaveLength(1);
      expect(llm[0].role).toBe('assistant');
      await ss.dispose();
    });
  });
});
