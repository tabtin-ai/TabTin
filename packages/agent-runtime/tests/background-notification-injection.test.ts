/**
 *  — agent-runtime 后台任务完成「turn 内注入」路径单测。
 *
 * 验证 `EngineConfig.drainThreadNotifications`：
 *  1. 缺省时整路径 no-op，不污染 messages；
 *  2. 返回文本时，注入条目作为新 user message 进入下一轮 LLM 上下文，并 yield
 *     `background_notification_injected` SYSTEM_NOTICE；
 *  3. 返回 null / 空串时不注入、不 emit notice（peek 短路语义的运行时等价）；
 *  4. callback 抛错不打断 ReAct loop，仅 yield `background_notification_inject_error`。
 *
 * 与 `run-observation-injection.test.ts` 同构（两者共用同一注入槽）。
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMRequest,
  LLMResponseChunk,
  LLMProvider,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: async () => undefined } as never,
    }),
    sessionConfig: { sessionDir: '/tmp/bg-notify-test', threadId: 'test-session-bg' },
    model: 'test-model',
    ...overrides,
  };
}

function makeRecordingProvider(
  chunkSequences: LLMResponseChunk[][],
): { provider: LLMProvider; capturedRequests: LLMRequest[] } {
  const capturedRequests: LLMRequest[] = [];
  let idx = 0;
  const provider: LLMProvider = {
    async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
      capturedRequests.push({
        model: req.model,
        messages: JSON.parse(JSON.stringify(req.messages)),
        tools: req.tools,
        system: req.system,
        maxTokens: req.maxTokens,
      });
      const chunks = chunkSequences[idx++] ?? [
        { type: 'text_delta', text: 'fallback' },
        { type: 'stop', stopReason: 'end_turn' },
      ];
      for (const c of chunks) yield c;
    },
  };
  return { provider, capturedRequests };
}

function makeEchoTool(name: string, output: string): Tool {
  return {
    name,
    description: `echo ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({ content: output }),
  };
}

function makeWriteTool(name: string, output: string): Tool {
  return {
    ...makeEchoTool(name, output),
    isReadOnly: false,
  };
}

function makeSuspendTool(onDiscard?: () => void): Tool {
  return {
    name: 'wait_for_background_agents',
    description: 'suspend until background agents finish',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({
      content: 'waiting',
      signals: {
        suspendRun: {
          reason: 'awaiting_subagents',
          pendingSubagentIds: ['child-a', 'child-b'],
          ...(onDiscard ? { onDiscard } : {}),
        },
      },
    }),
  };
}

function makeEndConversationTool(): Tool {
  return {
    name: 'end_conversation',
    description: 'end current conversation',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({
      content: 'ending',
      signals: {
        endConversation: { reason: 'explicit test termination' },
      },
    }),
  };
}

const BG_INJECTION_TEXT =
  '<task-notification kind="subagent-completed">子 Agent「抓取竞品价格」已完成</task-notification>';

describe(' — 后台任务完成 turn 内注入 (drainThreadNotifications)', () => {
  it('callback 缺省时整路径 no-op：messages 不被污染', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      [
        { type: 'text_delta', text: 'hello' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const rt = createRuntime(makeConfig({ provider }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0]!.messages).toHaveLength(1);
    expect(capturedRequests[0]!.messages[0]!.role).toBe('user');
  });

  it('callback 返回文本时，注入成新 user message 进入下一轮 LLM 上下文 + yield notice', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      // 第 1 轮：LLM 调 echo 工具（模拟主 Agent 派完后台任务后还在干别的活）
      [
        { type: 'tool_use', toolUse: { id: 'tu-1', name: 'echo', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      // 第 2 轮：直接 final
      [
        { type: 'text_delta', text: 'acknowledged-and-done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    let drainCalls = 0;
    const drainThreadNotifications = async (): Promise<string | null> => {
      drainCalls += 1;
      // 第 1 轮无后台完成；第 2 轮后台任务完成 → 返回注入文本
      return drainCalls === 2 ? BG_INJECTION_TEXT : null;
    };

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([makeEchoTool('echo', 'echoed')]),
        drainThreadNotifications,
      }),
    );
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    // 每轮 ReAct 顶部调用一次，至少 2 次
    expect(drainCalls).toBeGreaterThanOrEqual(2);

    // 第 2 轮 LLM 请求里应该看到后台完成注入文案
    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const flatSecond = JSON.stringify(capturedRequests[1]!.messages);
    expect(flatSecond).toContain('子 Agent「抓取竞品价格」已完成');

    // 不再 emit 额外的 SYSTEM_NOTICE（与 push 气泡重复、英文噪音）——用户可见信号
    // 就是下面这条 push-notification USER 事件 + Agent 当轮接话。
    const notice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'background_notification_injected',
    );
    expect(notice).toBeUndefined();

    // 前端可见性：发出 push-notification USER 流事件（驱动「后台任务完成」提示框）
    const pushUserEvent = events.find(
      (e) =>
        e.type === 'agent.stream.user' &&
        (e.payload as Record<string, unknown>).triggered_by === 'push-notification',
    );
    expect(pushUserEvent).toBeDefined();
    const pushPayload = pushUserEvent!.payload as Record<string, unknown>;
    expect(pushPayload.content).toContain('子 Agent「抓取竞品价格」已完成');
    expect(pushPayload.blocks_json).toEqual([
      { type: 'text', text: pushPayload.content },
    ]);
    expect(typeof pushPayload.client_event_id).toBe('string');
    expect(typeof pushPayload.arrival_seq).toBe('number');
    // 单一身份：message_id 与 client_event_id 同值——Django 据此用作
    // ChatMessage.id，前端 live 副本也用 message_id 作 id → 全程同一个 id、不分裂。
    expect(typeof pushPayload.message_id).toBe('string');
    expect(pushPayload.message_id).toBe(pushPayload.client_event_id);
  });

  it('callback 返回 null 时不注入、不 emit notice', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const rt = createRuntime(
      makeConfig({
        provider,
        drainThreadNotifications: async () => null,
      }),
    );
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    // 仅 1 条 user prompt，无注入
    expect(capturedRequests[0]!.messages).toHaveLength(1);
    const notice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'background_notification_injected',
    );
    expect(notice).toBeUndefined();
    // 也不应发 push-notification USER 事件
    const pushUserEvent = events.find(
      (e) =>
        e.type === 'agent.stream.user' &&
        (e.payload as Record<string, unknown>).triggered_by === 'push-notification',
    );
    expect(pushUserEvent).toBeUndefined();
  });

  it('callback 抛错不打断 ReAct loop，仅 yield error notice', async () => {
    const { provider } = makeRecordingProvider([
      [
        { type: 'text_delta', text: 'finished' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        drainThreadNotifications: async () => {
          throw new Error('queue explosion');
        },
      }),
    );
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    // 主流程仍走完到 done
    expect(events.find((e) => e.type === 'agent.stream.done')).toBeDefined();
    const errNotice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'background_notification_inject_error',
    );
    expect(errNotice).toBeDefined();
    expect(JSON.stringify(errNotice!.payload)).toContain('queue explosion');
  });

  it('suspendRun 在工具结果落库后非错误结束，不再请求下一轮 LLM', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      [
        {
          type: 'tool_use',
          toolUse: { id: 'tu-wait', name: 'wait_for_background_agents', input: {} },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '不应调用第二轮' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([makeSuspendTool()]),
    }));
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: '等待两个后台任务' }));

    expect(capturedRequests).toHaveLength(1);
    const done = events.find((event) => event.type === 'agent.stream.done');
    expect(done?.payload.error).toBe(false);
    expect(done?.payload.metadata).toEqual({
      run_state: 'awaiting_subagents',
      suspension_reason: 'awaiting_subagents',
      pending_subagent_ids: ['child-a', 'child-b'],
    });
    const turnEnd = events.find(
      (event) =>
        event.type === 'agent.stream.lifecycle' &&
        event.payload.phase === 'turn_end',
    );
    expect(turnEnd?.payload.reason).toBe('awaiting_subagents');
    expect(events.some((event) => event.type === 'agent.stream.persist_message')).toBe(true);
  });

  it('host handoff 在工具结果落库后成功结束，不再请求下一轮模型', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      [
        {
          type: 'tool_use',
          toolUse: { id: 'tu-handoff', name: 'prepare_handoff', input: {} },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '不应调用第二轮' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([makeWriteTool('prepare_handoff', 'scheduled')]),
      hooks: {
        afterToolResult: async (ctx) => {
          expect(ctx.runId).toBe('run-handoff');
          ctx.requestStopAfterToolResults('test_handoff');
        },
      },
    }));

    const events = await collect(rt.query({ hostRunId: 'run-handoff', prompt: '交接' }));

    expect(capturedRequests).toHaveLength(1);
    const persistIndex = events.findIndex((event) => event.type === 'agent.stream.persist_message');
    const doneIndex = events.findIndex((event) => event.type === 'agent.stream.done');
    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(persistIndex);
    expect(events[doneIndex]?.payload).toMatchObject({
      error: false,
      metadata: {
        run_state: 'host_handoff',
        handoff_reason: 'test_handoff',
      },
    });
  });

  it('host handoff 优先于同轮 afterToolResult 硬停', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([[
      {
        type: 'tool_use',
        toolUse: { id: 'tu-handoff-hard-stop', name: 'prepare_handoff', input: {} },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ]]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([makeWriteTool('prepare_handoff', 'scheduled')]),
      hooks: {
        afterToolResult: async (ctx) => {
          ctx.requestHardStop('tool_failure');
          ctx.requestStopAfterToolResults('test_handoff');
        },
      },
    }));

    const events = await collect(rt.query({ hostRunId: 'run-handoff-hard-stop', prompt: '交接' }));
    const done = events.find((event) => event.type === 'agent.stream.done');

    expect(capturedRequests).toHaveLength(1);
    expect(done?.payload).toMatchObject({
      error: false,
      metadata: { run_state: 'host_handoff' },
    });
    expect(done?.payload.hard_stop_source).toBeUndefined();
  });

  it('host handoff 优先于同轮共享 token 预算耗尽', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([[
      {
        type: 'tool_use',
        toolUse: { id: 'tu-handoff-budget', name: 'prepare_handoff', input: {} },
      },
      { type: 'usage', usage: { input_tokens: 1, output_tokens: 0 } },
      { type: 'stop', stopReason: 'tool_use' },
    ]]);
    const budgetTracker = new BudgetTracker({ maxTotalTokens: 1 });
    const rt = createRuntime(makeConfig({
      provider,
      budgetTracker,
      tools: createMockToolProvider([makeWriteTool('prepare_handoff', 'scheduled')]),
      hooks: {
        afterToolResult: async (ctx) => {
          ctx.requestStopAfterToolResults('test_handoff');
        },
      },
    }));

    const events = await collect(rt.query({ hostRunId: 'run-handoff-budget', prompt: '交接' }));
    const done = events.find((event) => event.type === 'agent.stream.done');

    expect(budgetTracker.isExhausted()).toBe(true);
    expect(capturedRequests).toHaveLength(1);
    expect(done?.payload).toMatchObject({
      error: false,
      metadata: { run_state: 'host_handoff' },
    });
    expect(done?.payload.error_class).toBeUndefined();
  });

  it('host handoff 优先于同轮 run credits 耗尽', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([[
      {
        type: 'tool_use',
        toolUse: { id: 'tu-handoff-credits', name: 'prepare_handoff', input: {} },
      },
      {
        type: 'usage',
        usage: { input_tokens: 1, output_tokens: 0, cost_usd: 1 },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ]]);
    const rt = createRuntime(makeConfig({
      provider,
      maxRunCredits: 1,
      tools: createMockToolProvider([makeWriteTool('prepare_handoff', 'scheduled')]),
      hooks: {
        afterToolResult: async (ctx) => {
          ctx.requestStopAfterToolResults('test_handoff');
        },
      },
    }));

    const events = await collect(rt.query({ hostRunId: 'run-handoff-credits', prompt: '交接' }));
    const done = events.find((event) => event.type === 'agent.stream.done');

    expect(capturedRequests).toHaveLength(1);
    expect(done?.payload).toMatchObject({
      error: false,
      metadata: { run_state: 'host_handoff' },
    });
    expect(done?.payload.error_class).toBeUndefined();
  });

  it('beforeTool 可在每个工具临执行前跳过同批后续工具', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-first', name: 'first_write', input: {} } },
        { type: 'tool_use', toolUse: { id: 'tu-later', name: 'later_write', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '已重新规划' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    let hostTransitionPending = false;
    let laterExecutions = 0;
    const first: Tool = {
      ...makeWriteTool('first_write', 'scheduled'),
      execute: async () => {
        hostTransitionPending = true;
        return { content: 'scheduled' };
      },
    };
    const later: Tool = {
      ...makeWriteTool('later_write', 'should not run'),
      execute: async () => {
        laterExecutions += 1;
        return { content: 'unexpected' };
      },
    };
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([first, later]),
      hooks: {
        beforeTool: async (ctx) => {
          if (hostTransitionPending) ctx.skipCurrentTool('host_transition_pending');
        },
      },
    }));

    await collect(rt.query({ hostRunId: 'run-skip', prompt: '执行两个写工具' }));

    expect(laterExecutions).toBe(0);
    expect(capturedRequests).toHaveLength(2);
    expect(JSON.stringify(capturedRequests[1]?.messages)).toContain('host_transition_pending');
  });

  it('suspendRun 与 endConversation 同批时撤销未提交屏障', async () => {
    let discardCalls = 0;
    const { provider } = makeRecordingProvider([
      [
        {
          type: 'tool_use',
          toolUse: { id: 'tu-wait', name: 'wait_for_background_agents', input: {} },
        },
        {
          type: 'tool_use',
          toolUse: { id: 'tu-end', name: 'end_conversation', input: {} },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeSuspendTool(() => { discardCalls += 1; }),
        makeEndConversationTool(),
      ]),
    }));

    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: '等待后立即结束' }));

    expect(discardCalls).toBe(1);
    const done = events.find((event) => event.type === 'agent.stream.done');
    expect(done?.payload.termination_reason).toBe('explicit test termination');
    expect(done?.payload.metadata).toBeUndefined();
  });

  it('suspendRun 在 afterToolResult hard-stop 时撤销未提交屏障', async () => {
    let discardCalls = 0;
    const { provider } = makeRecordingProvider([
      [
        {
          type: 'tool_use',
          toolUse: { id: 'tu-wait', name: 'wait_for_background_agents', input: {} },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeSuspendTool(() => { discardCalls += 1; }),
      ]),
      hooks: {
        afterToolResult: async (ctx) => {
          ctx.requestHardStop('tool_failure');
        },
      },
    }));

    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: '等待后触发硬停' }));

    expect(discardCalls).toBe(1);
    const done = events.find((event) => event.type === 'agent.stream.done');
    expect(done?.payload.hard_stop_source).toBe('tool_failure');
    expect(done?.payload.metadata).toBeUndefined();
  });
});
