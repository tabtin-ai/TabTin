import { describe, it, expect } from 'vitest';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { forwardSubagentStreamToParent } from '../src/subagent/agent-tool.js';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';

/**
 * ：子 Agent 正文与主 Agent 同构。forward 后仍是原 type，
 * 只盖 `subagent_run_id`；身份键留在同一条 payload 上。
 */
describe('forwardSubagentStreamToParent 同构投影 ', () => {
  function capture(): { emitted: StreamEvent[]; emitter: (e: StreamEvent) => void } {
    const emitted: StreamEvent[] = [];
    return { emitted, emitter: (e) => emitted.push(e) };
  }

  it('叶子子事件：type 保持 content_block_delta，payload 带同一 event_id', () => {
    const { emitted, emitter } = capture();
    const child: StreamEvent = {
      type: 'agent.stream.content_block_delta',
      payload: { event_id: 'emission-X', arrival_seq: 123, message_id: 'm1' },
    };
    forwardSubagentStreamToParent(emitter, 'child-1', child);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('agent.stream.content_block_delta');
    const p = emitted[0].payload as Record<string, unknown>;
    expect(p.event_id).toBe('emission-X');
    expect(p.arrival_seq).toBe(123);
    expect(p.message_id).toBe('m1');
    expect(p.subagent_run_id).toBe('child-1');
    expect(p.parent_run_id).toBeNull();
    expect(p.subagent_chain).toEqual(['child-1']);
    expect(p.child_event).toBeUndefined();
  });

  it('嵌套旧包装：解包后 type 是内层事件，chain prepend 当前 childId', () => {
    const { emitted, emitter } = capture();
    const nested: StreamEvent = {
      type: StreamEvents.SUBAGENT_STREAM_EVENT,
      payload: {
        event_id: 'emission-X',
        arrival_seq: 123,
        subagent_run_id: 'grandchild-1',
        subagent_chain: ['grandchild-1'],
        child_event: {
          type: 'agent.stream.content_block_delta',
          payload: { event_id: 'emission-X', message_id: 'm1' },
        },
      },
    };
    forwardSubagentStreamToParent(emitter, 'child-1', nested);
    expect(emitted[0].type).toBe('agent.stream.content_block_delta');
    const p = emitted[0].payload as Record<string, unknown>;
    expect(p.event_id).toBe('emission-X');
    expect(p.subagent_run_id).toBe('grandchild-1');
    expect(p.subagent_chain).toEqual(['child-1', 'grandchild-1']);
    expect(p.message_id).toBe('m1');
  });

  it('被包装事件无 event_id（老 daemon）时不造假 id', () => {
    const { emitted, emitter } = capture();
    const child: StreamEvent = {
      type: 'agent.stream.content_block_delta',
      payload: { message_id: 'm1' },
    };
    forwardSubagentStreamToParent(emitter, 'child-1', child);
    const p = emitted[0].payload as Record<string, unknown>;
    expect(p.event_id).toBeUndefined();
    expect(p.subagent_run_id).toBe('child-1');
  });
});
