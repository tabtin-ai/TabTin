/**
 * FR-06 — 错误归因结构化（error_class / suggested_action / trace_id）。
 *
 * 验证 8 个 `done.error: true` 路径都按 `AgentErrorCode` 写入 `error_class`，
 * 同时确认 `suggested_action` 中文文案非空、`trace_id` 与 lifecycle.run_id 同源。
 *
 * PRD §5.2 FR-06 要求覆盖"5 类典型错误"（LLM 超时 / abort / tool timeout /
 * API 400 / 权限拒绝），实操中：
 *   - LLM 超时 / API 400 → catch 分支统一包装为 `LLM_ERROR`
 *   - abort → 单独 ABORT 分支
 *   - TOOL_TIMEOUT / 权限拒绝 → 工具级失败（tool_result.is_error=true），
 *     不会进 query catch；done event 不带 error
 *
 * 因此 5 类典型 done.error 分支选择更具代表性的 5 个：
 *   1. LLM_ERROR（provider 抛 Error）
 *   2. ABORT（abort signal）
 *   3. INTERNAL（provider 抛非 Error 类型，包装为 INTERNAL）
 *   4. CONTEXT_OVERFLOW（413 recovery exhausted）
 *   5. MAX_TURNS_EXCEEDED（maxTurns 达上限）
 *   + 6. MAX_CREDITS_EXCEEDED（额度超限，对照 budget 路径）
 *   + 7. DOOM_LOOP_DETECTED（middleware terminate 路径）
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  AgentError,
} from '../src/engine/contracts/kernel.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';

async function collectEventsSafe(
  gen: AsyncGenerator<StreamEvent>,
): Promise<{ events: StreamEvent[]; error?: Error }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of gen) {
      events.push(event);
    }
  } catch (e) {
    return { events, error: e as Error };
  }
  return { events };
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    // Hosts must wire toolRiskPolicy（ fail-closed）；测试桩放行。
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: async () => undefined } as never,
    }),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session-error-class' },
    model: 'test-model',
    ...overrides,
  };
}

function makeTool(
  name: string,
  opts: { isReadOnly?: boolean; result?: string; execute?: Tool['execute'] } = {},
): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: { arg: { type: 'string' } } },
    isReadOnly: opts.isReadOnly ?? true,
    execute: opts.execute ?? (async () => ({ content: opts.result ?? 'ok' })),
  };
}

function findDone(events: StreamEvent[]): Record<string, unknown> {
  const done = events.find((e) => e.type === 'agent.stream.done');
  if (!done) throw new Error('no DONE event');
  return done.payload as Record<string, unknown>;
}

function findTerminalPersist(
  events: StreamEvent[],
  errorClass: string,
): Record<string, unknown> {
  const event = events.find((candidate) => {
    if (candidate.type !== 'agent.stream.persist_message') return false;
    const payload = candidate.payload as Record<string, unknown>;
    const errorInfo = payload.error_info_json as Record<string, unknown> | undefined;
    return payload.stop_reason === 'error' && errorInfo?.error_class === errorClass;
  });
  if (!event) throw new Error(`no terminal persist for '${errorClass}'`);
  return event.payload as Record<string, unknown>;
}

function findLifecycleStart(events: StreamEvent[]): Record<string, unknown> {
  const start = events.find(
    (e) => e.type === 'agent.stream.lifecycle' && (e.payload as Record<string, unknown>).phase === 'start',
  );
  if (!start) throw new Error('no lifecycle start');
  return start.payload as Record<string, unknown>;
}

describe('FR-06 — error_class / suggested_action / trace_id', () => {
  it('LLM_ERROR — provider 抛 Error 时 catch 分支写 LLM_ERROR', async () => {
    const provider = {
      async *createStream() {
        throw new Error('LLM unavailable');
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('LLM_ERROR');
    expect(typeof done.suggested_action).toBe('string');
    expect((done.suggested_action as string).length).toBeGreaterThan(0);
    expect(typeof done.trace_id).toBe('string');
    expect((done.trace_id as string).length).toBeGreaterThan(0);

    // 验证 trace_id 与 lifecycle.start.run_id 同源（H2-A 接通 AdminDash 用）
    const lifecycle = findLifecycleStart(events);
    expect(done.trace_id).toBe(lifecycle.run_id);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('LLM_ERROR');
  });

  it('网络错误无模型正文时持久化可共享重试的错误卡', async () => {
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw new AgentError('unreachable', 'LLM_ERROR', {
          retryable: true,
          details: { networkError: true },
        });
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'network-run', prompt: 'Hi' }));
    const terminalPersist = findTerminalPersist(events, 'LLM_ERROR');

    expect(terminalPersist.message_kind).toBe('error_envelope');
    expect(terminalPersist.blocks_json).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('[LLM_ERROR]') }),
    ]);
  });

  it('LLM_ERROR (API 400) — provider 抛带 status=400 的 AgentError 时归类为 LLM_ERROR', async () => {
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw new AgentError(
          'invalid_request: messages must alternate user/assistant',
          'LLM_ERROR',
          { statusCode: 400 },
        );
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('LLM_ERROR');
    expect((done.suggested_action as string).length).toBeGreaterThan(0);
    expect(typeof done.trace_id).toBe('string');
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('LLM_ERROR');
  });

  it('LLM_ERROR — provider 抛非 Error 类型时内层 catch 包装为 LLM_ERROR', async () => {
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw 'string-thrown-not-error';
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('LLM_ERROR');
    expect(typeof done.suggested_action).toBe('string');
    expect((done.suggested_action as string).length).toBeGreaterThan(0);
    expect(typeof done.trace_id).toBe('string');
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('LLM_ERROR');
  });

  it('INTERNAL — provider 抛 AgentError(INTERNAL) 时保留原始 error code', async () => {
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw new AgentError('manual internal failure', 'INTERNAL');
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('INTERNAL');
    const terminalPersist = findTerminalPersist(events, 'INTERNAL');
    expect(terminalPersist.message_kind).toBe('error_envelope');
    expect(terminalPersist.blocks_json).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('[INTERNAL]') }),
    ]);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('INTERNAL');
  });

  it('ABORT — abort signal 触发时写 ABORT', async () => {
    const ac = new AbortController();
    const rt = createRuntime(
      makeConfig({
        provider: createMockProvider([
          [
            { type: 'tool_use', toolUse: { id: 'c1', name: 'aborter', input: { arg: 'x' } } },
            { type: 'stop', stopReason: 'tool_use' },
          ],
        ]),
        tools: createMockToolProvider([
          makeTool('aborter', {
            execute: async () => {
              ac.abort();
              return { content: 'done' };
            },
          }),
        ]),
      }),
    );

    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Go', signal: ac.signal }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('ABORT');
    // Wave 3 协议演进：suggested_action 改为机器枚举（ABORT 类没有用户自助
    // 操作 → 'none'）。中文文案改由前端 i18n 渲染（errorClass.ABORT.suggestion）。
    expect(done.suggested_action).toBe('none');
    expect(typeof done.trace_id).toBe('string');
  });

  it('CONTEXT_OVERFLOW — 413 recovery 用尽时写 CONTEXT_OVERFLOW', async () => {
    let callCount = 0;
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        callCount++;
        throw new AgentError('prompt is too long', 'CONTEXT_OVERFLOW', {
          statusCode: 413,
        });
      },
    };

    const rt = createRuntime(makeConfig({ provider, maxTurns: 5 }));
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Long prompt' }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('CONTEXT_OVERFLOW');
    expect(done.content).toBeUndefined();
    expect(findTerminalPersist(events, 'CONTEXT_OVERFLOW').blocks_json).toEqual([]);
    // Wave 3 协议演进：suggested_action 机器枚举（'shorten_context' → 前端
    // ACTION_LABELS 渲染"新建对话"按钮）。
    expect(done.suggested_action).toBe('shorten_context');
    expect(typeof done.trace_id).toBe('string');
    expect(callCount).toBeGreaterThanOrEqual(2);
    //  follow-up：不再叠 recovery_413_failed 蓝条（DONE 黄卡已覆盖）
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice'
          && (e.payload as { notice_type?: string }).notice_type === 'recovery_413_failed',
      ),
    ).toHaveLength(0);
  });

  it('MAX_TURNS_EXCEEDED — 到达 maxTurns 时写 MAX_TURNS_EXCEEDED', async () => {
    const toolChunks: LLMResponseChunk[] = [
      { type: 'tool_use', toolUse: { id: 'c', name: 't', input: { arg: 'x' } } },
      { type: 'stop', stopReason: 'tool_use' },
    ];

    const rt = createRuntime(
      makeConfig({
        provider: createMockProvider([toolChunks, toolChunks, toolChunks]),
        tools: createMockToolProvider([makeTool('t')]),
        maxTurns: 2,
      }),
    );
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Loop' }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('MAX_TURNS_EXCEEDED');
    // Wave 3 协议演进：suggested_action 机器枚举（'none'——MAX_TURNS_EXCEEDED
    // 路径产品决策"用户继续发消息让 Agent 继续"，不需要专门按钮）。
    expect(done.suggested_action).toBe('none');
    expect(typeof done.trace_id).toBe('string');
    const maxTurnsPersist = findTerminalPersist(events, 'MAX_TURNS_EXCEEDED');
    expect(maxTurnsPersist.blocks_json).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use' }),
      expect.objectContaining({ type: 'tool_result' }),
    ]));
    //  follow-up：不再叠 max_turns / tool_error SYSTEM_NOTICE
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice'
          && ['max_turns', 'tool_error'].includes(
            String((e.payload as { notice_type?: string }).notice_type),
          ),
      ),
    ).toHaveLength(0);
  });

  it('MAX_CREDITS_EXCEEDED — credits 超额时写 MAX_CREDITS_EXCEEDED', async () => {
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'noop', input: {} } },
        {
          type: 'usage',
          usage: { input_tokens: 10, output_tokens: 5, cost_usd: 999 },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'should not reach' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([makeTool('noop')]),
        maxRunCredits: 1, // < cost_usd 999 → 立即触发
      }),
    );
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Use credits' }));

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('MAX_CREDITS_EXCEEDED');
    // Wave 3 协议演进：suggested_action 机器枚举（'check_billing' →
    // ACTION_LABELS 渲染"去充值"按钮）。
    expect(done.suggested_action).toBe('check_billing');
    expect(typeof done.trace_id).toBe('string');
    const creditsPersist = findTerminalPersist(events, 'MAX_CREDITS_EXCEEDED');
    expect(creditsPersist.blocks_json).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use' }),
      expect.objectContaining({ type: 'tool_result' }),
    ]));
    //  follow-up：不再叠 credits_exceeded 蓝条（DONE 黄卡已覆盖）
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice'
          && (e.payload as { notice_type?: string }).notice_type === 'credits_exceeded',
      ),
    ).toHaveLength(0);
  });

  // W2.3 (D-tech-6)：原 `DOOM_LOOP_DETECTED — middleware terminate 时写 DOOM_LOOP_DETECTED`
  // 测试已删除——`createDoomLoopGuard` 整段下线，doom_loop terminate 路径
  // 不再有写入者。归后续 Harness 治理专题（届时由 DoomLoopCap.hooks() 重建
  // 并恢复本测试）。`AgentErrorCode.DOOM_LOOP_DETECTED` 文案保留以维持 H1
  // 已固化的错误枚举不变。

  it('成功 done — error 字段缺省，trace_id 仍存在', async () => {
    const provider = createMockProvider([
      [
        { type: 'text_delta', text: 'Hello!' },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(makeConfig({ provider }));
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    const done = findDone(events);
    expect(done.error).toBeUndefined();
    expect(done.error_class).toBeUndefined();
    expect(done.suggested_action).toBeUndefined();
    // 成功 done 仍带 trace_id（H2-A 协同——AdminDash 取 trace_id 不区分成功失败）
    expect(typeof done.trace_id).toBe('string');
  });

  it('trace_id 在多个 query 之间隔离', async () => {
    const provider = createMockProvider([
      [
        { type: 'text_delta', text: 'one' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(makeConfig({ provider }));

    const r1 = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'q1' }));
    const r2 = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'q2' }));

    const done1 = findDone(r1.events);
    const done2 = findDone(r2.events);

    expect(done1.trace_id).not.toBe(done2.trace_id);
  });
});

/**
 * 工具结果层的 `code` 字段（FR-06 表达一致性）。
 *
 * PRD §5.2 把 "tool timeout / 权限拒绝" 列入 5 类典型错误。这两类错误**不**进
 * `done.error_class`（因为它们是工具级失败、由模型在下一轮自行纠正），
 * 但工具结果 JSON 必须带 `code: AgentErrorCode` 让模型 / 前端能做结构化分支。
 *
 * 验证三处：
 *   1. TOOL_TIMEOUT — `executeTool` 抛 AgentError('TOOL_TIMEOUT') →
 *      `errorToToolResult` 写入 `code` 字段。
 *   2. PERMISSION_DENIED — concurrent 路径（runReadOnlyConcurrent）。
 *   3. PERMISSION_DENIED — single-tool 路径（executeSingleTool）。
 */
describe('FR-06 — 工具结果层 code 字段（TOOL_TIMEOUT / PERMISSION_DENIED）', () => {
  function findToolResult(events: StreamEvent[], toolName: string): Record<string, unknown> {
    // W2 silent-bypass 修复：tool 生命周期改走 system_notice + notice_type='tool_completed/_failed'。
    const evt = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).tool_name === toolName &&
        ((e.payload as Record<string, unknown>).phase === 'error' ||
          (e.payload as Record<string, unknown>).phase === 'end'),
    );
    if (!evt) throw new Error(`no tool event for '${toolName}'`);
    return evt.payload as Record<string, unknown>;
  }

  it('TOOL_TIMEOUT — executeTool 超时时 errorToToolResult 产出 <tool_use_error> 格式', async () => {
    const slowTool = makeTool('slow', {
      isReadOnly: false,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { content: 'never reached' };
      },
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 't1', name: 'slow', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'recovered' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([slowTool]),
      }),
    );
    const { executeTool } = await import('../src/engine/tooling/tool-system.js');
    let captured: unknown;
    try {
      await executeTool(slowTool, {}, {
        threadId: 't',
        runtimeId: 's',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      }, 50);
    } catch (e) {
      captured = e;
    }
    const { AgentError: AE } = await import('../src/engine/contracts/kernel.js');
    expect(captured).toBeInstanceOf(AE);
    expect((captured as InstanceType<typeof AE>).code).toBe('TOOL_TIMEOUT');

    const { runTools } = await import('../src/engine/tooling/tool-orchestration.js');
    const { ToolRegistry } = await import('../src/engine/tooling/tool-system.js');
    const reg = new ToolRegistry();
    reg.loadTools(createMockToolProvider([slowTool]));
    const events: StreamEvent[] = [];
    const gen = runTools({
      toolUseBlocks: [{ type: 'tool_use', id: 't2', name: 'slow', input: {} }],
      registry: reg,
      context: {
        threadId: 't',
        runtimeId: 's',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
      permissionHandler: createMockPermissionHandler(),
      timeoutMs: 30,
      options: {
      allowLegacyPermissionFallback: true, outputScan: false },
    });
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    const results = next.value;
    expect(results).toHaveLength(1);
    const content = results[0].result.content as string;
    expect(content).toContain('<tool_use_error>');
    expect(content).toContain('kind: tool_timeout');
    expect(content).toContain('timed out');
    expect(results[0].result.isError).toBe(true);

    rt.abort();
  });

  it('PERMISSION_DENIED — concurrent 路径工具结果含 <tool_use_error> permission_denied', async () => {
    const readTool: Tool = {
      ...makeTool('readonly_a', { isReadOnly: false }),
      concurrencySafe: true,
    };

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'p1', name: 'readonly_a', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'no perm' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([readTool]),
        permissionHandler: createMockPermissionHandler('deny'),
        toolOutputScan: false,
      }),
    );
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'try' }));

    const toolEvt = findToolResult(events, 'readonly_a');
    const output = toolEvt.output as string;
    expect(output).toContain('<tool_use_error>');
    expect(output).toContain('kind: permission_denied');
    expect(output).toContain('Permission denied');
  });

  it('PERMISSION_DENIED — single-tool 路径（write tool）工具结果含 <tool_use_error> permission_denied', async () => {
    const writeTool = makeTool('write_x', { isReadOnly: false });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'p2', name: 'write_x', input: { arg: 'v' } } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'denied' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([writeTool]),
        permissionHandler: createMockPermissionHandler('deny'),
      }),
    );
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'try write' }));

    const toolEvt = findToolResult(events, 'write_x');
    const output = toolEvt.output as string;
    expect(output).toContain('kind: permission_denied');
  });

  it('AgentError 抛出时 errorToToolResult 产出 <tool_use_error> execute_error', async () => {
    const failTool = makeTool('failer', {
      isReadOnly: true,
      execute: async () => {
        const { AgentError: AE } = await import('../src/engine/contracts/kernel.js');
        throw new AE('boom', 'LLM_ERROR');
      },
    });
    const { runTools } = await import('../src/engine/tooling/tool-orchestration.js');
    const { ToolRegistry } = await import('../src/engine/tooling/tool-system.js');
    const reg = new ToolRegistry();
    reg.loadTools(createMockToolProvider([failTool]));
    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [{ type: 'tool_use', id: 'f1', name: 'failer', input: {} }],
      registry: reg,
      context: {
        threadId: 't',
        runtimeId: 's',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
      },
      permissionHandler: createMockPermissionHandler(),
    });
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const result = next.value[0];
    const content = result.result.content as string;
    expect(content).toContain('<tool_use_error>');
    expect(content).toContain('kind: execute_error');
    expect(content).toContain('boom');
    expect(result.result.isError).toBe(true);
  });
});

describe('FR-06 /  — burst 限流 DONE 用 classified，不发 LLM error 蓝条', () => {
  const BURST_EN =
    'System protection triggered by request burst. Please slow down traffic growth '
    + 'and increase requests gradually before retrying.';

  it('LLM_ERROR + burst 原文 → DONE/error_info 为 LLM_RATE_LIMIT + 中文，无 SYSTEM_NOTICE llm_error', async () => {
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw new AgentError(BURST_EN, 'LLM_ERROR', {
          statusCode: 400,
          details: {
            fromProxySSE: true,
            user_message: BURST_EN,
            error_type: 'upstream_error',
          },
        });
      },
    };

    const rt = createRuntime(makeConfig({
      provider,
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session-burst-8818' },
    }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run-burst-8818', prompt: 'Hi' }));

    const llmErrorNotices = events.filter((e) => {
      if (e.type !== 'agent.stream.system_notice') return false;
      const p = e.payload as { notice_type?: string; content?: string };
      return p.notice_type === 'llm_error'
        || (typeof p.content === 'string' && p.content.startsWith('LLM error:'));
    });
    expect(llmErrorNotices).toHaveLength(0);

    const done = findDone(events);
    expect(done.error).toBe(true);
    expect(done.error_class).toBe('LLM_RATE_LIMIT');
    expect(done.error_message).toBe('该模型暂无法使用，请稍后重试或更换模型');
    expect(done.suggested_action).toBe('switch_model');
    expect(done.error_category).toBe('rate_limit');

    const stopWithError = events.find((e) => {
      if (e.type !== 'agent.stream.message_stop') return false;
      const info = (e.payload as { error_info?: { error_class?: string } }).error_info;
      return Boolean(info?.error_class);
    });
    expect(stopWithError).toBeDefined();
    const errorInfo = (stopWithError!.payload as {
      error_info: { error_class: string; error_message: string };
    }).error_info;
    expect(errorInfo.error_class).toBe('LLM_RATE_LIMIT');
    expect(errorInfo.error_message).toBe('该模型暂无法使用，请稍后重试或更换模型');

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('LLM_RATE_LIMIT');
  });
});
