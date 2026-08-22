import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStorage } from '../event-storage.js';
import { ContentBlockEvents, StreamEvents } from '../../engine/contracts/stream-events.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-storage-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function readEventLines(sessionId: string): Promise<unknown[]> {
  const filePath = path.join(tmpDir, sessionId, 'events.jsonl');
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('EventStorage._reducePayload (W2 envelope-based)', () => {
  // 2026-05-10 dogfood 修复回归 + W2 silent-bypass 修复：旧实现按
  // `agent.stream.tool` end / `agent.stream.assistant` delta 路径 reduce，
  // 在 W2 envelope 协议下两类事件 runtime 已 0 emit。重写按新 6 件套（
  // content_block_start with tool_result block / content_block_delta with
  // text_delta or input_json_delta）路径 reduce。
  it('large tool_result block content is replaced with a JSON-safe placeholder (does not break JSON.parse)', async () => {
    const sessionId = 'sess-large';
    const storage = new EventStorage(tmpDir, sessionId);

    const longContent = 'A'.repeat(20_000); // > 10KB
    await storage.append({
      type: ContentBlockEvents.CONTENT_BLOCK_START,
      timestamp: 1,
      payload: {
        message_id: 'm1',
        index: 0,
        block_id: 'b0',
        block: {
          type: 'tool_result',
          tool_use_id: 'rf-1',
          content: longContent,
        },
      },
    });
    await storage.dispose();

    const lines = await readEventLines(sessionId);
    expect(lines.length).toBe(1);
    const entry = lines[0] as { payload: Record<string, unknown> };
    const block = entry.payload.block as Record<string, unknown>;
    const reducedContent = block.content as string;

    // 1) 占位字符串本身合法、可被任何 JSON.parse 链路接续
    expect(typeof reducedContent).toBe('string');
    expect(reducedContent).toContain('[event-storage truncated:');
    expect(reducedContent).toContain('tool-logs/rf-1.md');

    // 2) 关键：不再含裸 LF / U+2026（旧实现的 marker 是这两个非法字符）
    expect(reducedContent).not.toMatch(/[\x00-\x1f]/); // 无控制字符
    expect(reducedContent).not.toContain('\u2026'); // 无单字符省略号

    // 3) 元数据保留以便观测
    expect(block.content_truncated_in_event_storage).toBe(true);
    expect(block.original_content_length).toBe(longContent.length);

    // 4) 反向不变量：占位 + 整条 entry 都能被 JSON.parse
    expect(() => JSON.stringify(reducedContent)).not.toThrow();
  });

  it('tool_result block below threshold is preserved as-is (no truncation)', async () => {
    const sessionId = 'sess-small';
    const storage = new EventStorage(tmpDir, sessionId);

    const smallContent = 'A'.repeat(500); // 远小于 10KB
    await storage.append({
      type: ContentBlockEvents.CONTENT_BLOCK_START,
      timestamp: 1,
      payload: {
        message_id: 'm2',
        index: 0,
        block_id: 'b0',
        block: {
          type: 'tool_result',
          tool_use_id: 'rf-2',
          content: smallContent,
        },
      },
    });
    await storage.dispose();

    const lines = await readEventLines(sessionId);
    const entry = lines[0] as { payload: Record<string, unknown> };
    const block = entry.payload.block as Record<string, unknown>;
    expect(block.content).toBe(smallContent);
    expect(block.content_truncated_in_event_storage).toBeUndefined();
  });

  it('tool_use cb_start (no content field) is unaffected', async () => {
    const sessionId = 'sess-tooluse';
    const storage = new EventStorage(tmpDir, sessionId);

    await storage.append({
      type: ContentBlockEvents.CONTENT_BLOCK_START,
      timestamp: 1,
      payload: {
        message_id: 'm3',
        index: 0,
        block_id: 'b0',
        block: {
          type: 'tool_use',
          id: 'rf-3',
          name: 'read_file',
          input: {},
        },
      },
    });
    await storage.dispose();

    const lines = await readEventLines(sessionId);
    const entry = lines[0] as { payload: Record<string, unknown> };
    const block = entry.payload.block as Record<string, unknown>;
    expect(block.type).toBe('tool_use');
    expect(block.id).toBe('rf-3');
  });

  it('text_delta payload is reduced to char count only (regression)', async () => {
    const sessionId = 'sess-text';
    const storage = new EventStorage(tmpDir, sessionId);

    await storage.append({
      type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      timestamp: 1,
      payload: {
        message_id: 'm4',
        index: 0,
        delta: { type: 'text_delta', text: 'A'.repeat(5000) },
      },
    });
    await storage.dispose();

    const lines = await readEventLines(sessionId);
    const entry = lines[0] as { payload: Record<string, unknown> };
    const delta = entry.payload.delta as Record<string, unknown>;
    expect(delta.type).toBe('text_delta');
    expect(delta.text_chars).toBe(5000);
    expect(delta.text).toBeUndefined();
  });

  it('truncateFrom 删除 timestamp >= cutTs 的被回退事件（ commitRewind 对称截断）', async () => {
    const sessionId = 'sess-truncate';
    const storage = new EventStorage(tmpDir, sessionId);

    await storage.append({
      type: StreamEvents.USER,
      timestamp: 100,
      payload: { client_event_id: 'u-keep', content: '保留' },
    });
    await storage.append({
      type: StreamEvents.USER,
      timestamp: 210,
      payload: { client_event_id: 'u-reverted', content: '被回退' },
    });
    // commitRewind 在 recordUserMessage 之前执行，此时尚无回退后新消息
    await storage.truncateFrom(210);
    await storage.append({
      type: StreamEvents.USER,
      timestamp: 310,
      payload: { client_event_id: 'u-new', content: '新消息' },
    });
    await storage.dispose();

    const lines = await readEventLines(sessionId);
    const ids = lines.map((entry) => {
      const payload = (entry as { payload: Record<string, unknown> }).payload;
      return payload.client_event_id;
    });
    expect(ids).toEqual(['u-keep', 'u-new']);
  });

  it('input_json_delta with very long partial_json is summarised', async () => {
    const sessionId = 'sess-inputjson';
    const storage = new EventStorage(tmpDir, sessionId);

    const longArgs = 'X'.repeat(20_000);
    await storage.append({
      type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      timestamp: 1,
      payload: {
        message_id: 'm5',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: longArgs },
      },
    });
    await storage.dispose();

    const lines = await readEventLines(sessionId);
    const entry = lines[0] as { payload: Record<string, unknown> };
    const delta = entry.payload.delta as Record<string, unknown>;
    expect(delta.type).toBe('input_json_delta');
    expect(delta.partial_json_chars).toBe(longArgs.length);
    expect(delta.truncated_in_event_storage).toBe(true);
    expect(delta.partial_json).toBeUndefined();
  });

  it('llm_usage event keeps per-iteration usage and request metadata', async () => {
    const sessionId = 'sess-usage';
    const storage = new EventStorage(tmpDir, sessionId);

    await storage.append({
      type: StreamEvents.LLM_USAGE,
      timestamp: 1,
      payload: {
        runId: 'run-1',
        iterationId: 'run-1:0',
        iteration: 0,
        model: 'gpt-test',
        requestSource: '_main_chat',
        providerChannel: 'local_codex',
        reasoningEffort: 'high',
        serviceTier: 'priority',
        durationMs: 123,
        messageCount: 4,
        toolCount: 2,
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 1,
        reasoning_tokens: 2,
        credits_charged: 0,
        last_input_tokens: 10,
        by_model: {
          'gpt-test': { input_tokens: 10, output_tokens: 3 },
        },
        noisyLargeField: 'not persisted',
      },
    });
    await storage.dispose();

    const lines = await readEventLines(sessionId);
    const entry = lines[0] as { payload: Record<string, unknown> };
    expect(entry.payload).toEqual({
      runId: 'run-1',
      iterationId: 'run-1:0',
      iteration: 0,
      model: 'gpt-test',
      requestSource: '_main_chat',
      providerChannel: 'local_codex',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      durationMs: 123,
      messageCount: 4,
      toolCount: 2,
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 1,
      reasoning_tokens: 2,
      credits_charged: 0,
      last_input_tokens: 10,
      by_model: {
        'gpt-test': { input_tokens: 10, output_tokens: 3 },
      },
    });
  });
});
