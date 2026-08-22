/**
 * AuditCap 单测 —— W2.2.3。
 *
 * 覆盖：
 *   1. type / category 静态契约（'audit' / 'governance'）
 *   2. tools() 返回空数组（hooks-only 模板特征）
 *   3. instructions() 已下线（阶段 2.3，Capability.instructions?() 整接口删除）
 *   4. required_capability_types() 空集
 *   5. 未注入 writer 时 hooks() 返回 null（不挂钩 + 不抛错）
 *   6. 注入 writer 时 hooks() 6 个钩子全部挂上
 *   7. agent_start / agent_end 调用顺序 + payload model / iteration
 *   8. iteration_start / iteration_end 含 iteration 号 + messageCount
 *   9. tool_start / tool_end 一对，tool_end 含 durationMs（≥ start_ts 间隔）
 *  10. seq 单调递增（从 0 开始，每个 emit ++）
 *  11. writer 抛错被 catch 不冒泡到 hook（console.warn 兜底）
 *  12. level=minimal 时 payload 不含 input/output
 *  13. level=standard 时 tool_start payload 含 inputKeys 不含 input 全文
 *  14. level=verbose 时 tool_end payload 含 input + output 摘要（截断 cap）
 *  15. clone() 后 _seq 重置 0 + _toolStartTs 重建空 Map
 *  16. payload 中 sessionId 来自 _session.sessionId（bind 后）
 *  17. 多 tool 并发场景下 _toolStartTs key 隔离（不串扰）
 *  18. unserializable 入参不抛错（_toolKey 内部 fallback）
 */

import { describe, expect, it, vi } from 'vitest';
import { AuditCap, type AuditEvent, type AuditWriter } from '../audit.js';
import {
  makeFakeSession,
  makeIterationCtx,
  makeRunCtx,
  makeToolCtx,
} from '../../__tests__/fixtures/fake-capabilities.js';
import type {
  Tool,
  ToolResult,
} from '../../../engine/contracts/tools.js';
import type {
  EngineState,
} from '../../../engine/contracts/kernel.js';

// ─── helpers ────────────────────────────────────────────────────────

function makeRecordingWriter(opts?: { throwOnPhase?: AuditEvent['phase'] }): {
  writer: AuditWriter;
  events: AuditEvent[];
} {
  const events: AuditEvent[] = [];
  const writer: AuditWriter = {
    async write(event: AuditEvent): Promise<void> {
      events.push(event);
      if (opts?.throwOnPhase && event.phase === opts.throwOnPhase) {
        throw new Error(`mock writer throw at phase=${event.phase}`);
      }
    },
  };
  return { writer, events };
}

function makeMinimalState(overrides?: Partial<EngineState>): EngineState {
  // 测试只用到极少字段，不构造完整 EngineState（含 abortController 等）。
  // cast 让 TS 不抱怨，运行时只读取我们关心的 5 字段（model / iteration /
  // messages / totalInputTokens / totalOutputTokens / creditsCharged /
  // contextPressure）。
  return {
    model: 'claude-3-5-sonnet',
    iteration: 0,
    messages: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    creditsCharged: 0,
    contextPressure: 0,
    ...overrides,
  } as unknown as EngineState;
}

function makeFakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: { type: 'object', properties: {} } as unknown as Tool['inputSchema'],
    isReadOnly: true,
    execute: async () => ({ content: 'ok' }),
  };
}

// ─── 静态契约 ────────────────────────────────────────────────────────

describe('AuditCap · 静态契约', () => {
  it('type = "audit"', () => {
    const cap = new AuditCap();
    expect(cap.type).toBe('audit');
  });

  it('category = "governance"', () => {
    const cap = new AuditCap();
    expect(cap.category).toBe('governance');
  });

  it('tools() 返回空数组（hooks-only 模板）', () => {
    const cap = new AuditCap();
    expect(cap.tools()).toEqual([]);
  });

  it('required_capability_types() 空集', () => {
    const cap = new AuditCap();
    expect(Array.from(cap.required_capability_types())).toEqual([]);
  });
});

// ─── hooks() 装配 ────────────────────────────────────────────────────

describe('AuditCap · hooks() 装配', () => {
  it('未注入 writer 时 hooks() 返回 null', () => {
    const cap = new AuditCap();
    expect(cap.hooks()).toBeNull();
  });

  it('注入 writer 后 hooks() 6 个钩子全部挂上', () => {
    const { writer } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    const h = cap.hooks();
    expect(h).not.toBeNull();
    expect(typeof h?.beforeRun).toBe('function');
    expect(typeof h?.afterRun).toBe('function');
    expect(typeof h?.beforeIteration).toBe('function');
    expect(typeof h?.afterIteration).toBe('function');
    expect(typeof h?.beforeTool).toBe('function');
    expect(typeof h?.afterTool).toBe('function');
  });
});

// ─── 事件流 ──────────────────────────────────────────────────────────

describe('AuditCap · 事件流', () => {
  it('agent_start / agent_end 调用顺序 + payload', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    await cap.bind(makeFakeSession('sess-1'));
    const h = cap.hooks()!;
    const state = makeMinimalState({
      model: 'claude-opus-4',
      iteration: 5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      creditsCharged: 0.05,
    });
    await h.beforeRun!(makeRunCtx(state));
    await h.afterRun!(makeRunCtx(state));
    expect(events).toHaveLength(2);
    expect(events[0]!.phase).toBe('agent_start');
    expect(events[1]!.phase).toBe('agent_end');
    expect(events[0]!.payload.model).toBe('claude-opus-4');
    expect(events[0]!.payload.iteration).toBe(5);
    expect(events[0]!.payload.totalInputTokens).toBe(1000);
    expect(events[1]!.payload.totalOutputTokens).toBe(500);
  });

  it('iteration_start / iteration_end 含 iteration 号 + messageCount', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    await cap.bind(makeFakeSession('sess-2'));
    const h = cap.hooks()!;
    const state = makeMinimalState({
      messages: [
        { role: 'user', content: 'hi' } as unknown as EngineState['messages'][number],
        { role: 'assistant', content: 'hello' } as unknown as EngineState['messages'][number],
      ],
    });
    await h.beforeIteration!(makeIterationCtx(state, 3));
    await h.afterIteration!(makeIterationCtx(state, 3));
    expect(events).toHaveLength(2);
    expect(events[0]!.phase).toBe('iteration_start');
    expect(events[0]!.payload.iteration).toBe(3);
    expect(events[0]!.payload.messageCount).toBe(2);
    expect(events[1]!.phase).toBe('iteration_end');
  });

  it('tool_start / tool_end 一对，tool_end 含 durationMs', async () => {
    vi.useFakeTimers();
    try {
      const { writer, events } = makeRecordingWriter();
      const cap = new AuditCap({ writer });
      await cap.bind(makeFakeSession('sess-3'));
      const h = cap.hooks()!;
      const tool = makeFakeTool('echo');
      const input = { msg: 'hi' };
      const result: ToolResult = { content: 'ok' };

      vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
      await h.beforeTool!(makeToolCtx(makeMinimalState(), tool, input));
      vi.advanceTimersByTime(50); // 模拟工具执行 50ms
      await h.afterTool!(makeToolCtx(makeMinimalState(), tool, input, result));

      expect(events).toHaveLength(2);
      expect(events[0]!.phase).toBe('tool_start');
      expect(events[0]!.payload.toolName).toBe('echo');
      expect(events[1]!.phase).toBe('tool_end');
      expect(events[1]!.payload.toolName).toBe('echo');
      expect(events[1]!.payload.isError).toBe(false);
      expect(events[1]!.payload.durationMs).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('seq 单调递增（从 0 开始）', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    await cap.bind(makeFakeSession('sess-4'));
    const h = cap.hooks()!;
    const state = makeMinimalState();
    const tool = makeFakeTool('echo');

    await h.beforeRun!(makeRunCtx(state));
    await h.beforeIteration!(makeIterationCtx(state, 0));
    await h.beforeTool!(makeToolCtx(makeMinimalState(), tool, {}));
    await h.afterTool!(makeToolCtx(makeMinimalState(), tool, {}, { content: 'ok' }));
    await h.afterIteration!(makeIterationCtx(state, 0));
    await h.afterRun!(makeRunCtx(state));

    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cap.getSeq()).toBe(6);
  });

  it('payload 中 sessionId 来自 _session.sessionId', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    await cap.bind(makeFakeSession('my-session-id'));
    const h = cap.hooks()!;
    await h.beforeRun!(makeRunCtx(makeMinimalState()));
    expect(events[0]!.sessionId).toBe('my-session-id');
  });
});

// ─── writer 失败隔离 ────────────────────────────────────────────────

describe('AuditCap · writer 失败隔离', () => {
  it('writer 抛错被 catch，不冒泡到 hook 调用方', async () => {
    const { writer, events } = makeRecordingWriter({ throwOnPhase: 'tool_start' });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cap = new AuditCap({ writer });
      await cap.bind(makeFakeSession('sess-5'));
      const h = cap.hooks()!;
      const tool = makeFakeTool('echo');
      // 不应抛
      await expect(h.beforeTool!(makeToolCtx(makeMinimalState(), tool, {}))).resolves.toBeUndefined();
      // writer 已被调（推入 events 数组），但抛错被吞
      expect(events).toHaveLength(1);
      // console.warn 被调（兜底告警）
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const warnMsg = consoleWarnSpy.mock.calls[0]![0];
      expect(warnMsg).toContain('[AuditCap]');
      expect(warnMsg).toContain('phase=tool_start');
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});

// ─── level 控制 ──────────────────────────────────────────────────────

describe('AuditCap · level 控制 payload 详细程度', () => {
  it('level=minimal 时 payload 不含 input / output / token', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer, level: 'minimal' });
    await cap.bind(makeFakeSession('sess-6'));
    const h = cap.hooks()!;
    const tool = makeFakeTool('write_file');
    const input = { path: '/tmp/x', content: 'secret-token-abc' };

    await h.beforeRun!(makeRunCtx(makeMinimalState({ totalInputTokens: 999 })));
    await h.beforeTool!(makeToolCtx(makeMinimalState(), tool, input));
    await h.afterTool!(makeToolCtx(makeMinimalState(), tool, input, { content: 'success' }));

    // agent_start: 无 totalInputTokens
    expect(events[0]!.phase).toBe('agent_start');
    expect(events[0]!.payload.totalInputTokens).toBeUndefined();
    // tool_start: 无 input / inputKeys
    expect(events[1]!.phase).toBe('tool_start');
    expect(events[1]!.payload.input).toBeUndefined();
    expect(events[1]!.payload.inputKeys).toBeUndefined();
    // tool_end: 无 output / outputLength
    expect(events[2]!.phase).toBe('tool_end');
    expect(events[2]!.payload.output).toBeUndefined();
    expect(events[2]!.payload.outputLength).toBeUndefined();
  });

  it('level=standard 时 tool_start 含 inputKeys 不含 input 全文', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer }); // 默认 standard
    await cap.bind(makeFakeSession('sess-7'));
    const h = cap.hooks()!;
    const tool = makeFakeTool('write_file');
    const input = { path: '/tmp/x', content: 'secret' };

    await h.beforeTool!(makeToolCtx(makeMinimalState(), tool, input));
    await h.afterTool!(makeToolCtx(makeMinimalState(), tool, input, { content: 'ok' }));

    expect(events[0]!.payload.toolName).toBe('write_file');
    expect(events[0]!.payload.inputKeys).toEqual(['path', 'content']);
    expect(events[0]!.payload.input).toBeUndefined();
    expect(events[1]!.payload.outputLength).toBe(2); // 'ok' 长度
    expect(events[1]!.payload.output).toBeUndefined();
  });

  it('level=verbose 时 tool_end payload 含 input + output 完整摘要', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer, level: 'verbose' });
    await cap.bind(makeFakeSession('sess-8'));
    const h = cap.hooks()!;
    const tool = makeFakeTool('echo');
    const longContent = 'x'.repeat(5000);

    await h.beforeTool!(makeToolCtx(makeMinimalState(), tool, { msg: 'hello' }));
    await h.afterTool!(makeToolCtx(makeMinimalState(), tool, { msg: 'hello' }, { content: longContent }));

    expect(events[0]!.payload.input).toBe('{"msg":"hello"}');
    // 5000 char output 截断到 4000 + '[...truncated]'
    const output = events[1]!.payload.output as string;
    expect(output).toContain('[...truncated]');
    expect(output.startsWith('xxxx')).toBe(true);
  });

  it('standard 模式 inputKeys 超过 12 时截断 + truncated 标记', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    await cap.bind(makeFakeSession('sess-9'));
    const h = cap.hooks()!;
    const tool = makeFakeTool('big_input');
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) input[`k${i}`] = i;

    await h.beforeTool!(makeToolCtx(makeMinimalState(), tool, input));
    expect((events[0]!.payload.inputKeys as string[]).length).toBe(12);
    expect(events[0]!.payload.inputKeysTruncated).toBe(true);
  });
});

// ─── clone 行为 ──────────────────────────────────────────────────────

describe('AuditCap · clone() 行为', () => {
  it('clone 后 _seq 重置 0', async () => {
    const { writer } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    await cap.bind(makeFakeSession('sess-10'));
    const h = cap.hooks()!;
    await h.beforeRun!(makeRunCtx(makeMinimalState()));
    await h.afterRun!(makeRunCtx(makeMinimalState()));
    expect(cap.getSeq()).toBe(2);

    const cloned = cap.clone();
    expect(cloned.getSeq()).toBe(0);
  });

  it('clone 后 _toolStartTs 重建为新 Map（不串扰）', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    await cap.bind(makeFakeSession('sess-11'));
    const h = cap.hooks()!;
    const tool = makeFakeTool('long_op');

    await h.beforeTool!(makeToolCtx(makeMinimalState(), tool, { x: 1 }));
    // 此时父 cap 的 _toolStartTs 有一条记录

    const cloned = cap.clone();
    await cloned.bind(makeFakeSession('sess-11-clone'));
    const clonedH = cloned.hooks()!;
    // cloned 的 afterTool 不应能算出 durationMs（它的 startTs map 是空的）
    await clonedH.afterTool!(makeToolCtx(makeMinimalState(), tool, { x: 1 }, { content: 'ok' }));

    // cloned 只发了一条 tool_end，且 durationMs 缺失
    const clonedEvents = events.filter((e) => e.sessionId === 'sess-11-clone');
    expect(clonedEvents).toHaveLength(1);
    expect(clonedEvents[0]!.phase).toBe('tool_end');
    expect(clonedEvents[0]!.payload.durationMs).toBeUndefined();
  });

  it('clone 后 _writer 仍指向原 writer（structuredClone fallback 共享引用）', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    const cloned = cap.clone();
    await cloned.bind(makeFakeSession('sess-12'));
    const h = cloned.hooks()!;
    await h.beforeRun!(makeRunCtx(makeMinimalState()));
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe('sess-12');
  });
});

// ─── 边界场景 ────────────────────────────────────────────────────────

describe('AuditCap · 边界场景', () => {
  it('多 tool 并发场景下 _toolStartTs key 隔离', async () => {
    vi.useFakeTimers();
    try {
      const { writer, events } = makeRecordingWriter();
      const cap = new AuditCap({ writer });
      await cap.bind(makeFakeSession('sess-13'));
      const h = cap.hooks()!;
      const toolA = makeFakeTool('a');
      const toolB = makeFakeTool('b');

      vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));
      await h.beforeTool!(makeToolCtx(makeMinimalState(), toolA, { id: 1 }));
      vi.advanceTimersByTime(10);
      await h.beforeTool!(makeToolCtx(makeMinimalState(), toolB, { id: 2 }));
      vi.advanceTimersByTime(20);
      // B 先结束（30ms 总）
      await h.afterTool!(makeToolCtx(makeMinimalState(), toolB, { id: 2 }, { content: 'b-done' }));
      vi.advanceTimersByTime(15);
      // A 后结束（45ms 总）
      await h.afterTool!(makeToolCtx(makeMinimalState(), toolA, { id: 1 }, { content: 'a-done' }));

      const toolEnds = events.filter((e) => e.phase === 'tool_end');
      expect(toolEnds).toHaveLength(2);
      const bEnd = toolEnds.find((e) => e.payload.toolName === 'b')!;
      const aEnd = toolEnds.find((e) => e.payload.toolName === 'a')!;
      expect(bEnd.payload.durationMs).toBe(20); // 10+20-10 = 20
      expect(aEnd.payload.durationMs).toBe(45); // 10+20+15 = 45
    } finally {
      vi.useRealTimers();
    }
  });

  it('unserializable 入参（含循环引用）不抛错', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer, level: 'verbose' });
    await cap.bind(makeFakeSession('sess-14'));
    const h = cap.hooks()!;
    const tool = makeFakeTool('echo');
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    // 不应抛
    await expect(h.beforeTool!(makeToolCtx(makeMinimalState(), tool, cyclic))).resolves.toBeUndefined();
    expect(events[0]!.payload.input).toBe('[unserializable]');
  });

  it('未 bind 时 sessionId 为 null（理论不应发生但防御性）', async () => {
    const { writer, events } = makeRecordingWriter();
    const cap = new AuditCap({ writer });
    // 故意不 bind
    const h = cap.hooks()!;
    await h.beforeRun!(makeRunCtx(makeMinimalState()));
    expect(events[0]!.sessionId).toBeNull();
  });
});
