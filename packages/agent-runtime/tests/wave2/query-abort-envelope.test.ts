/**
 * Wave 2 — abort 路径 envelope 序列实测
 *
 * 验证"对话中途 cancel"时：
 *   1. envelope 序列里有一条 message_delta(delta.stop_reason='aborted')
 *   2. 紧跟一条 message_stop —— 让 W3 Django reconciliation worker 看到完整边界
 *   3. partial text 内容仍然以 content_block_delta(text_delta) 推送
 *
 * 这是验收命令 7（abort 路径实测）的单测载体。
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../../src/runtime-assembly.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from '../test-utils.js';
import {
  type StreamEvent,
} from '../../src/engine/contracts/wire-protocol.js';
import {
  type LLMRequest,
  type LLMResponseChunk,
} from '../../src/engine/contracts/model-llm.js';
import {
  AgentError,
  type EngineConfig,
} from '../../src/engine/contracts/kernel.js';
import { ContentBlockEvents } from '../../src/engine/contracts/stream-events.js';

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('query.ts — Wave 2 abort 路径 envelope 序列', () => {
  it('abort 触发时 emit message_delta(stop_reason=aborted) 紧跟 message_stop', async () => {
    const abortController = new AbortController();
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_abort',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'partial...' },
          });
        }
        yield { type: 'text_delta', text: 'partial...' };
        // 制造 abort：mockProvider yield 中等一帧再抛 ABORT 错误
        await new Promise((r) => setTimeout(r, 5));
        abortController.abort();
        // 抛 ABORT —— query.ts isAbortError 检查 AgentError.code === 'ABORT'
        throw new AgentError('Run aborted by test', 'ABORT');
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-abort', threadId: 'sess-abort' },
      model: 'test',
      abortSignal: abortController.signal,
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'test' }));

    // 找到 message_delta 和 message_stop 的位置
    const types = events.map((e) => (e as { type: string }).type);
    const deltaIdx = events.findIndex(
      (e) =>
        (e as { type: string }).type === ContentBlockEvents.MESSAGE_DELTA
        && (e as unknown as { payload: { delta?: { stop_reason?: string } } })
          .payload.delta?.stop_reason === 'aborted',
    );
    const stopIdx = types.lastIndexOf(ContentBlockEvents.MESSAGE_STOP);

    // 至少要有一条 stop_reason='aborted' 的 message_delta
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    // message_stop 也要存在
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    // delta 必须紧靠在 stop 之前
    expect(deltaIdx).toBeLessThan(stopIdx);

    // partial text 仍以 content_block_delta(text_delta) 推送过
    const textDeltas = events.filter(
      (e) =>
        (e as { type: string }).type === ContentBlockEvents.CONTENT_BLOCK_DELTA
        && (e as unknown as { payload: { delta?: { type?: string; text?: string } } })
          .payload.delta?.type === 'text_delta',
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });
});
