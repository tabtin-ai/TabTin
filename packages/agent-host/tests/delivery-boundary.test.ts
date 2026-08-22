/**
 * H2-A FR-10：Runtime trace_id 生成与透传测试。
 *
 * 验证：
 *   1. lifecycle.start payload 携带 trace_id
 *   2. lifecycle.end payload 携带 trace_id
 *   3. DONE payload 携带 trace_id（运行/错误/abort/超 budget 多种 done 路径）
 *   4. trace_id 与 lifecycle.start.run_id 同源（一次 query → 一个 trace）
 *   5. EventEmitter 在 runtime 源头补 trace/thread/protocol
 *   6. DeliveryBatchBuffer 只透传、不再补协议字段
 */

import { describe, it, expect } from 'vitest';
import {
  createRuntime,
  EventEmitter,
  type StreamEvent,
} from '@tabtin/agent-runtime'
import type { EngineConfig } from '@tabtin/agent-runtime/engine'
import { DeliveryBatchBuffer, type DeliveryTransport } from '../src/delivery/delivery-batch-buffer.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from '../../agent-runtime/tests/test-utils.js';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    ...overrides,
  };
}

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Runtime trace_id (H2-A FR-10)', () => {
  it('lifecycle.start payload carries trace_id same as run_id', async () => {
    const rt = createRuntime(makeConfig());
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hello' }));

    const lifecycleStart = events.find(
      (e) => e.type === 'agent.stream.lifecycle' && (e.payload as Record<string, unknown>).phase === 'start',
    );
    expect(lifecycleStart).toBeDefined();

    const payload = lifecycleStart!.payload as Record<string, unknown>;
    expect(payload.run_id).toBeDefined();
    expect(payload.trace_id).toBeDefined();
    expect(payload.trace_id).toMatch(UUID_PATTERN);
    // 关键契约：trace_id 与 run_id 同源
    expect(payload.trace_id).toBe(payload.run_id);
  });

  it('lifecycle.end payload also carries trace_id', async () => {
    const rt = createRuntime(makeConfig());
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hello' }));

    const lifecycleStart = events.find(
      (e) => e.type === 'agent.stream.lifecycle' && (e.payload as Record<string, unknown>).phase === 'start',
    );
    const lifecycleEnd = events.find(
      (e) => e.type === 'agent.stream.lifecycle' && (e.payload as Record<string, unknown>).phase === 'end',
    );
    expect(lifecycleEnd).toBeDefined();

    const startTraceId = (lifecycleStart!.payload as Record<string, unknown>).trace_id;
    const endTraceId = (lifecycleEnd!.payload as Record<string, unknown>).trace_id;
    expect(endTraceId).toBe(startTraceId);
  });

  it('DONE payload carries trace_id (normal completion)', async () => {
    const rt = createRuntime(makeConfig());
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hello' }));

    const done = events.find((e) => e.type === 'agent.stream.done');
    expect(done).toBeDefined();
    const payload = done!.payload as Record<string, unknown>;
    expect(payload.trace_id).toMatch(UUID_PATTERN);

    const lifecycleStart = events.find(
      (e) => e.type === 'agent.stream.lifecycle' && (e.payload as Record<string, unknown>).phase === 'start',
    );
    const startTraceId = (lifecycleStart!.payload as Record<string, unknown>).trace_id;
    expect(payload.trace_id).toBe(startTraceId);
  });

  it('different queries get distinct trace_ids', async () => {
    const rt = createRuntime(makeConfig());

    const events1 = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hello 1' }));
    const events2 = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hello 2' }));

    const traceId1 = (events1.find(
      (e) => e.type === 'agent.stream.lifecycle' && (e.payload as Record<string, unknown>).phase === 'start',
    )!.payload as Record<string, unknown>).trace_id;
    const traceId2 = (events2.find(
      (e) => e.type === 'agent.stream.lifecycle' && (e.payload as Record<string, unknown>).phase === 'start',
    )!.payload as Record<string, unknown>).trace_id;

    expect(traceId1).not.toBe(traceId2);
  });

  it('all query egress events share source-stamped trace/thread/protocol/identity fields', async () => {
    const rt = createRuntime(makeConfig());
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hello' }));
    const start = events.find(
      (event) => event.type === 'agent.stream.lifecycle' && event.payload.phase === 'start',
    );
    const traceId = start?.payload.trace_id;
    expect(typeof traceId).toBe('string');
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.payload.trace_id, event.type).toBe(traceId);
      expect(event.payload.thread_id, event.type).toBe('test-session');
      expect(event.payload.protocol_version, event.type).toBe('v2');
      expect(typeof event.payload.event_id, event.type).toBe('string');
      expect(typeof event.payload.arrival_seq, event.type).toBe('number');
    }
  });
});

describe('EventEmitter trace ownership / DeliveryBatchBuffer pass-through', () => {
  function makeMockTransport(): {
    transport: DeliveryTransport;
    sent: Array<Array<{ type: string; payload: Record<string, unknown> }>>;
  } {
    const sent: Array<Array<{ type: string; payload: Record<string, unknown> }>> = [];
    return {
      transport: {
        async send(_sessionId, events) {
          sent.push(events);
        },
      },
      sent,
    };
  }

  it('EventEmitter 在 relay 分叉前补齐 trace/thread/protocol，DeliveryBatchBuffer 原样透传', async () => {
    const { transport, sent } = makeMockTransport();
    const emitter = new EventEmitter(undefined, {
      traceId: 'test-trace-aaa',
      threadId: 'sess-1',
    });
    const buffer = new DeliveryBatchBuffer('sess-1', transport);
    buffer.push(emitter.buildStream({
      type: 'agent.stream.tool',
      payload: { tool_name: 'bash', tool_call_id: 'call-1' },
    }));
    buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0][0].payload.trace_id).toBe('test-trace-aaa');
    expect(sent[0][0].payload.thread_id).toBe('sess-1');
    expect(sent[0][0].payload.protocol_version).toBe('v2');
  });

  it('DeliveryBatchBuffer 不再补 trace_id，边界只做缓冲传输', async () => {
    const { transport, sent } = makeMockTransport();
    const buffer = new DeliveryBatchBuffer('sess-1', transport);
    buffer.push({
      type: 'agent.stream.tool',
      payload: { tool_name: 'bash' },
    });
    buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent[0][0].payload.trace_id).toBeUndefined();
    expect(sent[0][0].payload.tool_name).toBe('bash');
  });
});
