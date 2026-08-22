/**
 * H1-E: emitTelemetryEvent / setTelemetrySink 行为单测。
 *
 * 关键契约验证：
 *   1. 未注入 sink 时 no-op，不抛异常
 *   2. 注入 sink 后 emit 能送达 record，含 event_name / timestamp / payload
 *   3. emit 传入 options 时，session_id / agent_id / trace_id 正确落位
 *   4. sink 抛异常被吞掉，emit 不向外冒泡
 *   5. resetTelemetrySink 恢复为 no-op
 *   6. 多次 setTelemetrySink(null) / sink 交替切换工作正常
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitTelemetryEvent,
  setTelemetrySink,
  resetTelemetrySink,
  setTelemetryDebug,
  type TelemetryRecord,
} from '../src/telemetry/index.js';

describe('telemetry emitter', () => {
  beforeEach(() => {
    resetTelemetrySink();
  });

  it('no-op sink: 未注入时 emit 不抛', () => {
    expect(() => {
      emitTelemetryEvent('test.noop', { key: 'value' });
    }).not.toThrow();
  });

  it('sink 能接收 record，含基础字段', () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((r) => captured.push(r));

    const before = Date.now();
    emitTelemetryEvent('persona.applied', { persona_len: 42 });
    const after = Date.now();

    expect(captured).toHaveLength(1);
    const rec = captured[0]!;
    expect(rec.event_name).toBe('persona.applied');
    expect(rec.payload).toEqual({ persona_len: 42 });
    expect(rec.timestamp).toBeGreaterThanOrEqual(before);
    expect(rec.timestamp).toBeLessThanOrEqual(after);
    expect(rec.session_id).toBeUndefined();
    expect(rec.agent_id).toBeUndefined();
    expect(rec.trace_id).toBeUndefined();
  });

  it('options 携带的 session/agent/trace id 正确落位', () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((r) => captured.push(r));

    emitTelemetryEvent(
      'doom_loop.triggered',
      { level: 'warn' },
      { session_id: 's-1', agent_id: 'a-1', trace_id: 't-1' },
    );

    expect(captured[0]).toMatchObject({
      event_name: 'doom_loop.triggered',
      session_id: 's-1',
      agent_id: 'a-1',
      trace_id: 't-1',
      payload: { level: 'warn' },
    });
  });

  it('options 为空值时字段被跳过（而非落为 undefined 键）', () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((r) => captured.push(r));

    emitTelemetryEvent('persona.applied', { has_persona: true }, {
      session_id: 's-only',
    });

    const rec = captured[0]!;
    expect(Object.prototype.hasOwnProperty.call(rec, 'session_id')).toBe(true);
    expect(rec.session_id).toBe('s-only');
    // agent_id / trace_id 未显式传，不应落在 record 上
    expect('agent_id' in rec).toBe(false);
    expect('trace_id' in rec).toBe(false);
  });

  it('sink 抛异常时 emit 不向外冒泡', () => {
    setTelemetrySink(() => {
      throw new Error('sink boom');
    });

    expect(() => emitTelemetryEvent('api.error.400', { status: 400 })).not.toThrow();
  });

  it('debug 开启时异常会写 stderr（仅断言不抛）', () => {
    setTelemetrySink(() => {
      throw new Error('sink boom');
    });
    setTelemetryDebug(true);
    expect(() => emitTelemetryEvent('api.error.400', { status: 400 })).not.toThrow();
  });

  it('setTelemetrySink(null) 恢复为 no-op', () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((r) => captured.push(r));
    emitTelemetryEvent('e1', {});
    expect(captured).toHaveLength(1);

    setTelemetrySink(null);
    emitTelemetryEvent('e2', {});
    expect(captured).toHaveLength(1); // 未增加
  });

  it('sink 切换：老 sink 收不到新事件', () => {
    const first: TelemetryRecord[] = [];
    const second: TelemetryRecord[] = [];

    setTelemetrySink((r) => first.push(r));
    emitTelemetryEvent('e1', {});

    setTelemetrySink((r) => second.push(r));
    emitTelemetryEvent('e2', {});

    expect(first.map((r) => r.event_name)).toEqual(['e1']);
    expect(second.map((r) => r.event_name)).toEqual(['e2']);
  });

  it('payload 为空对象也合法', () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((r) => captured.push(r));

    emitTelemetryEvent('mttr.start', {}, { session_id: 's' });
    expect(captured[0]?.payload).toEqual({});
  });

  // ── 负面/边界行为（Review #8 补强）──────────────────────────────

  it('sink 做异步 I/O 但自行 .catch：不冒泡，也不阻塞后续 emit', () => {
    const captured: TelemetryRecord[] = [];
    const asyncFailures: Error[] = [];

    setTelemetrySink((r) => {
      captured.push(r);
      // 契约要求：sink 若做异步 I/O，必须自己 .catch 掉 rejection——
      // emitter 不 await（见 types.ts 的 TelemetrySink JSDoc），
      // 不被 catch 的 rejection 会成为全局 unhandled（生产事故）。
      Promise.reject(new Error('async sink fail'))
        .catch((err: unknown) => {
          asyncFailures.push(err as Error);
        });
    });

    expect(() => emitTelemetryEvent('persona.applied', { has_persona: true }))
      .not.toThrow();
    expect(() => emitTelemetryEvent('persona.applied', { has_persona: false }))
      .not.toThrow();
    expect(captured).toHaveLength(2);
    // 异步错误由 sink 自行处理，未冒泡也未污染全局 unhandled rejection
    // （其实际落地由 microtask 队列在本次测试结束前解决）。
  });

  it('sink 内调用 emitTelemetryEvent：emitter 本身无深度保护，递归需 sink 自行封顶（本用例用人工计数器示范）', () => {
    // 契约（TelemetrySink JSDoc）明确"不递归"，但 emitter 本身**不加**深度保护
    // ——否则会增加每次 emit 的开销。意外递归的防御完全由 sink 自己保证。
    //
    // 本用例模拟错误写法（sink 内再 emit），并用计数器手动封顶 3 次，
    // 以验证：
    //   1. emitter 不会因为递归调用而抛异常（外层 try/catch 仍然有效）
    //   2. 内层 emit 被当前生效的 sink 处理（activeSink 就地替换语义）
    //
    // 若去掉 `if (depth < 3)` 封顶，本测试会栈溢出——这正是"emitter 无自动保护"的证据。
    let depth = 0;
    setTelemetrySink((r) => {
      depth += 1;
      if (depth < 3) {
        emitTelemetryEvent('recursive.inner', { depth, parent: r.event_name });
      }
    });

    expect(() => emitTelemetryEvent('recursive.outer', {})).not.toThrow();
    expect(depth).toBe(3); // 外层 1 次 + 内层 2 次（depth=1→2→3 触发时退出）
  });

  it('emit 不会等待 sink 返回（fire-and-forget 语义）', async () => {
    // 用共享 timer 以便 afterEach 能精确清理（不依赖 resetTelemetrySink 副作用）。
    let sinkDoneAt = 0;
    let emitReturnedAt = 0;
    const timer = { id: undefined as NodeJS.Timeout | undefined };

    setTelemetrySink(() => {
      timer.id = setTimeout(() => {
        sinkDoneAt = Date.now();
      }, 40);
    });

    emitTelemetryEvent('lifecycle.test', {});
    emitReturnedAt = Date.now();

    // emit 同步返回，sink 内部 setTimeout 回调尚未执行
    expect(sinkDoneAt).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(sinkDoneAt).toBeGreaterThan(0);
    expect(emitReturnedAt).toBeLessThanOrEqual(sinkDoneAt);

    if (timer.id) clearTimeout(timer.id);
  });
});
