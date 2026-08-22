import { describe, it, expect } from 'vitest';
import { stampEgressEvent, EventEmitter } from '../src/event/event-emitter.js';
import { AgentEvent, type InheritedIdentity } from '../src/event/agent-event.js';
import { RuntimeLlmSnapshotEvent } from '../src/event/events/llm-events.js';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';

// 事件系统深度重构 · 第 1 层：event_id / arrival_seq 约定所有权移入 event 模块
// （吸收原 wire/stamp-event.ts）。行为与旧 stampEgressEvent 等价 + 新增 EventEmitter。

describe('stampEgressEvent（egress 盖章：排序键 arrival_seq + 身份键 event_id）', () => {
  it('裸事件盖章后同时有 arrival_seq(number) 与 event_id(string)', () => {
    const out = stampEgressEvent({ type: 'agent.stream.lifecycle', payload: { phase: 'start' } });
    const p = out.payload as Record<string, unknown>;
    expect(typeof p.arrival_seq).toBe('number');
    expect(typeof p.event_id).toBe('string');
    expect((p.event_id as string).length).toBeGreaterThan(0);
  });

  it('幂等：两键都在时原样返回（不重造、不换引用）', () => {
    const ev: StreamEvent = {
      type: 'agent.stream.content_block_delta',
      payload: { message_id: 'm1', arrival_seq: 12345, event_id: 'nonce-abc' },
    };
    const out = stampEgressEvent(ev);
    expect(out).toBe(ev);
    expect((out.payload as Record<string, unknown>).arrival_seq).toBe(12345);
    expect((out.payload as Record<string, unknown>).event_id).toBe('nonce-abc');
  });

  it('只缺一键时补齐、保留已有键', () => {
    const out = stampEgressEvent({ type: 'agent.stream.step', payload: { arrival_seq: 777 } });
    const p = out.payload as Record<string, unknown>;
    expect(p.arrival_seq).toBe(777);
    expect(typeof p.event_id).toBe('string');
  });

  it('空字符串 event_id 视为缺失，补新 id', () => {
    const out = stampEgressEvent({ type: 'agent.stream.step', payload: { arrival_seq: 1, event_id: '' } });
    expect((out.payload as Record<string, unknown>).event_id).not.toBe('');
  });

  it('不 mutate 入参（补值时返回新对象 + 新 payload）', () => {
    const payload = { phase: 'end' };
    const out = stampEgressEvent({ type: 'agent.stream.done', payload });
    expect(out.payload).not.toBe(payload);
    expect((payload as Record<string, unknown>).arrival_seq).toBeUndefined();
    expect((payload as Record<string, unknown>).event_id).toBeUndefined();
  });

  it('连续补值：arrival_seq 严格单调、event_id 唯一', () => {
    const a = stampEgressEvent({ type: 'agent.stream.step', payload: {} });
    const b = stampEgressEvent({ type: 'agent.stream.step', payload: {} });
    const ap = a.payload as Record<string, unknown>;
    const bp = b.payload as Record<string, unknown>;
    expect(bp.arrival_seq as number).toBeGreaterThan(ap.arrival_seq as number);
    expect(ap.event_id).not.toBe(bp.event_id);
  });

  it('wrap 顶层已带身份时幂等保留（IPC 包装副本与 WS 回声同 id）', () => {
    const wrapper: StreamEvent = {
      type: 'agent.stream.subagent_stream_event',
      payload: {
        event_id: 'child-emission-42',
        arrival_seq: 999,
        subagent_run_id: 'run-1',
        child_event: { type: 'agent.stream.content_block_delta', payload: { event_id: 'child-emission-42' } },
      },
    };
    const out = stampEgressEvent(wrapper);
    const p = out.payload as Record<string, unknown>;
    expect(p.event_id).toBe('child-emission-42');
    expect(p.arrival_seq).toBe(999);
  });
});

class TestEvent extends AgentEvent {
  readonly type = 'agent.stream.step';
  constructor(private readonly d: Record<string, unknown>, readonly inherited?: InheritedIdentity) {
    super();
  }
  protected data(): Record<string, unknown> { return this.d; }
}

describe('EventEmitter.emit（构造 + 盖章 + 投递收敛一处）', () => {
  it('发射的事件带领域字段 + egress 盖章（arrival_seq + event_id）', () => {
    const out: StreamEvent[] = [];
    const emitter = new EventEmitter((e) => out.push(e));
    emitter.emit(new TestEvent({ note: 'hi' }));
    expect(out).toHaveLength(1);
    const p = out[0].payload as Record<string, unknown>;
    expect(out[0].type).toBe('agent.stream.step');
    expect(p.note).toBe('hi');
    expect(typeof p.arrival_seq).toBe('number');
    expect(typeof p.event_id).toBe('string');
  });

  it('inherited 身份被搬运（wrap 只搬运、不重造）', () => {
    const out: StreamEvent[] = [];
    const emitter = new EventEmitter((e) => out.push(e));
    emitter.emit(new TestEvent({ note: 'x' }, {
      event_id: 'inh-1',
      arrival_seq: 555,
      trace_id: 'child-trace',
      run_id: 'child-run',
      thread_id: 'child-thread',
    }));
    const p = out[0].payload as Record<string, unknown>;
    expect(p.event_id).toBe('inh-1');
    expect(p.arrival_seq).toBe(555);
    expect(p.trace_id).toBe('child-trace');
    expect(p.run_id).toBe('child-run');
    expect(p.thread_id).toBe('child-thread');
  });

  it('query lifecycle 与宿主预构造旁路共享 trace/run/thread scope', () => {
    const out: StreamEvent[] = [];
    const emitter = new EventEmitter((event) => out.push(event), { threadId: 'thread-1' });
    emitter.beginScope();
    // generator 首事件提供权威 run/trace。
    emitter.buildStream({
      type: 'agent.stream.lifecycle',
      payload: { phase: 'start', run_id: 'run-1', trace_id: 'trace-1' },
    });
    // 模拟 LocalPermissionHandler 等预构造组件捕获的稳定 emitStreamEvent。
    emitter.emitStream({
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'b1' },
    });
    emitter.endScope();

    expect(out).toHaveLength(1);
    expect(out[0].payload.trace_id).toBe('trace-1');
    expect(out[0].payload.run_id).toBe('run-1');
    expect(out[0].payload.thread_id).toBe('thread-1');
  });

  it('context.agentId 盖进 payload', () => {
    const out: StreamEvent[] = [];
    const emitter = new EventEmitter((event) => out.push(event), {
      threadId: 'thread-1',
      agentId: 'agent-uuid',
    });
    emitter.emitStream({
      type: 'agent.stream.persist_message',
      payload: { message_id: 'm1', role: 'assistant', blocks_json: [] },
    });
    expect(out[0].payload.agent_id).toBe('agent-uuid');
    expect(out[0].payload.agent_name).toBeUndefined();
  });

  it('同一 emitter 并发 query scope fail-fast，避免 trace 串线', () => {
    const emitter = new EventEmitter();
    emitter.beginScope();
    expect(() => emitter.beginScope()).toThrow(/concurrent query scopes/);
    emitter.endScope();
  });

  it('非 lifecycle.start 子/转发事件不能改写父 query trace scope', () => {
    const emitter = new EventEmitter(undefined, { threadId: 'parent-thread' });
    emitter.beginScope();
    emitter.buildStream({
      type: 'agent.stream.lifecycle',
      payload: { phase: 'start', trace_id: 'parent-trace', run_id: 'parent-run' },
    });
    emitter.buildStream({
      type: 'agent.stream.subagent_stream_event',
      payload: { trace_id: 'child-trace', run_id: 'child-run' },
    });
    const next = emitter.buildStream({
      type: 'agent.stream.step',
      payload: { step_type: 'thinking' },
    });
    expect(next.payload.trace_id).toBe('parent-trace');
    expect(next.payload.run_id).toBe('parent-run');
    emitter.endScope();
  });

  it('llm_snapshot 作为独立发射不复用 llm_request 的身份/排序键', () => {
    const emitter = new EventEmitter();
    const snapshot = emitter.build(new RuntimeLlmSnapshotEvent({
      run_id: 'run-1',
      trace_id: 'trace-1',
      event_id: 'request-event',
      arrival_seq: 123,
      _seq: 7,
    }));
    expect(snapshot.payload.event_id).not.toBe('request-event');
    expect(snapshot.payload.arrival_seq).not.toBe(123);
    expect(snapshot.payload._seq).toBeUndefined();
    expect(snapshot.payload.trace_id).toBe('trace-1');
  });
});
