import { describe, expect, it } from 'vitest';
import { StreamEvents } from '../contracts/stream-events.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../contracts/model-llm.js';
import {
  SYSTEM_SECTION_NAMES,
  type StreamEvent,
} from '../contracts/wire-protocol.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
} from '../contracts/conversation.js';
import type { EngineConfig, EngineState, ContextManager, QueryDeps } from '../contracts/kernel.js';
import type { Tool, ToolProvider } from '../contracts/tools.js';
import type { EnginePermissionHandler } from '../contracts/hitl.js';
import { DEFAULT_CONTEXT_BUDGET } from '../contracts/context-capability.js';
import { HookRunner } from '../core/hook-runner.js';
import {
  buildDefaultPolicyPostStages,
  type DefaultPolicyRunState,
} from '../core/default-policy-hooks.js';
import { buildThreadNotificationsInjectorHook } from '../policy-hooks/thread-notifications-injector.js';
import { createRetryState } from '../core/retry-state.js';
import type { RunContext } from '../core/run-context.js';
import { TokenEstimator } from '../context/token-budget.js';
import {
  CompactionController,
  type CompactHookPort,
} from '../context/compaction-controller.js';
import {
  emitMainUserEventPhase,
  emitPendingEnvironmentContextPhase,
  markHistoricalContextMessages,
  prepareInitialMessages,
  type EnvironmentContextEmitState,
} from '../core/run-prelude-phases.js';
import {
  createPromptAssembly,
  materializePrompt,
} from '../context/prompt-section-assembler.js';
import {
  applyToolResultPolicy,
  buildToolResultBlockSets,
} from '../tooling/tool-policies.js';

function makeState(): EngineState {
  return {
    messages: [],
    systemPrompt: 'base',
    model: 'test-model',
    iteration: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    _cachedInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalReasoningTokens: 0,
    compactInputTokens: 0,
    compactOutputTokens: 0,
    contextPressure: 0,
    creditsCharged: 0,
    abortController: new AbortController(),
  };
}

function makeTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({ content: 'ok' }),
  };
}

function makeConfig(): EngineConfig {
  const tools: ToolProvider = { getTools: () => [] };
  const permissionHandler: EnginePermissionHandler = {
    requestPermissionsBatch: async () => [],
  };
  return {
    provider: {
      async *createStream() {
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    },
    tools,
    permissionHandler,
    sessionConfig: { sessionDir: '/tmp/engine-hook-refactor', threadId: 'engine-hook-refactor' },
    model: 'test-model',
  };
}

function makeQueryDeps(): QueryDeps {
  return {
    async *callModel() {
      yield { type: 'stop', stopReason: 'end_turn' };
    },
    createContextManager: () =>
      ({
        ingest: () => {},
        getMessages: () => [],
      }) as unknown as ContextManager,
    observe: () => {},
    toolGate: {
      check: async () => ({ allowed: true }),
    } as QueryDeps['toolGate'],
    interrupt: {
      request: async () => ({ approved: true }),
    } as QueryDeps['interrupt'],
    generateUUID: () => 'hook-refactor-uuid',
  };
}

function makeDefaultPolicyRunState(): DefaultPolicyRunState {
  const tokenEstimator = new TokenEstimator();
  const retryState = createRetryState('test-model');
  return {
    getPreDeeplyNested: () => [],
    clearPreDeeplyNested: () => {},
    getMaxTurns: () => 10,
    getRetryState: () => retryState,
    getTokenEstimator: () => tokenEstimator,
    getToolParams: () => [],
    getContextManager: () =>
      ({
        ingest: () => {},
        getMessages: () => [],
      }) as unknown as ContextManager,
  };
}

function makeRunContextForPolicy(
  toolMap: Map<string, Tool>,
): RunContext {
  return {
    toolMap,
    toolResultStorage: undefined,
  } as RunContext;
}

function makeRunContextForPrelude(overrides: Partial<RunContext> = {}): RunContext {
  const state = makeState();
  const context: Partial<RunContext> = {
    params: {
      prompt: 'visible <context type="environment">hidden</context>',
      attachments: [],
      initialMessages: undefined,
      clientMessageId: 'client-1',
      displayMessage: 'visible',
      userMessageBlocks: undefined,
      replyTo: undefined,
      triggeredBy: undefined,
      skillSlashInvoke: undefined,
      pendingApprovalsSerialized: undefined,
    },
    state,
    config: makeConfig(),
    deps: {
      generateUUID: () => 'generated-id',
    },
    getToolParams: () => [],
    tokenEstimator: new TokenEstimator(),
    budget: DEFAULT_CONTEXT_BUDGET,
    dynamicToolManager: {
      recoverFromMessages: () => {},
    },
    staticToolNames: new Set(),
    toolMap: new Map(),
    toolRegistry: {
      getToolSchemas: () => [],
    },
    ...overrides,
  };
  return context as RunContext;
}

async function collect<T>(
  gen: AsyncGenerator<StreamEvent, T, undefined>,
): Promise<{ events: StreamEvent[]; result: T }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

describe('engine hook refactor contracts', () => {
  it('prompt section assembler owns canonical section ordering and materialization', () => {
    const assembly = createPromptAssembly('base prompt');
    assembly.dynamicSections.push({
      name: SYSTEM_SECTION_NAMES.convergence_hint,
      source: 'token-budget',
      content: 'convergence body',
      charCount: 'convergence body'.length,
    });
    assembly.staticSections.push({
      name: SYSTEM_SECTION_NAMES.cli_commands,
      source: 'cli',
      content: '<cli />',
      charCount: '<cli />'.length,
    });
    assembly.staticSections.push({
      name: SYSTEM_SECTION_NAMES.tool_call_metadata,
      source: 'agent-runtime',
      content: '<tool_call_metadata />',
      charCount: '<tool_call_metadata />'.length,
    });
    assembly.staticSections.push({
      name: SYSTEM_SECTION_NAMES.skills_index,
      source: 'skills',
      content: '<skills />',
      charCount: '<skills />'.length,
    });

    const materialized = materializePrompt(assembly);
    expect(materialized.sectionRegistry.map((section) => section.name)).toEqual([
      SYSTEM_SECTION_NAMES.base_prompt,
      SYSTEM_SECTION_NAMES.skills_index,
      SYSTEM_SECTION_NAMES.cli_commands,
      SYSTEM_SECTION_NAMES.tool_call_metadata,
      SYSTEM_SECTION_NAMES.convergence_hint,
    ]);
    const systemText = String(materialized.effectiveSystemPrompt);
    expect(systemText.indexOf('section:skills_index')).toBeLessThan(
      systemText.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY),
    );
    expect(systemText.indexOf('section:convergence_hint')).toBeGreaterThan(
      systemText.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY),
    );
  });

  it('tool hooks run through HookRunner and yield hook-emitted events', async () => {
    const tool = makeTool('read_file');
    const runner = new HookRunner([
      {
        beforeTool: async (ctx) => {
          ctx.emitNotice({ content: `before:${ctx.tool.name}`, notice_type: 'before_tool_seen' });
        },
        afterTool: async (ctx) => {
          ctx.emitNotice({ content: `after:${ctx.tool.name}`, notice_type: 'after_tool_seen' });
        },
      },
    ], makeState(), { identity: {}, forceFinalRef: { current: null } });

    const before = await collect(runner.runBeforeTool({ toolUseId: 'tu-before', tool, input: { path: 'a' } }));
    const after = await collect(runner.runAfterTool({
      toolUseId: 'tu-after',
      tool,
      input: { path: 'a' },
      result: { content: 'ok' },
    }));

    expect(before.events.map((event) => event.payload.notice_type)).toEqual(['before_tool_seen']);
    expect(after.events.map((event) => event.payload.notice_type)).toEqual(['after_tool_seen']);
  });

  it('tool hook failure is fail-soft and surfaces a hook_error notice', async () => {
    const runner = new HookRunner([
      {
        beforeTool: async () => {
          throw new Error('hook boom');
        },
      },
    ], makeState(), { identity: {}, forceFinalRef: { current: null } });

    const { events } = await collect(runner.runBeforeTool({
      toolUseId: 'tu-fail-soft',
      tool: makeTool('read_file'),
      input: {},
    }));

    expect(events.map((event) => event.payload.notice_type)).toEqual(['hook_error']);
    expect(String(events[0]!.payload.content)).toContain('beforeTool');
  });

  it('#6943 beforeModel stages are independently fail-soft: governance throw still allows budget setGraceTurn', async () => {
    let budgetRan = false;
    const runner = new HookRunner([
      {
        async beforeModel() {
          throw new Error('governance boom');
        },
      },
      {
        async beforeModel(ctx) {
          budgetRan = true;
          ctx.setGraceTurn();
        },
      },
    ], makeState(), { forceFinalRef: { current: null } });

    const { events, result: outcome } = await collect(runner.runBeforeModel({
      iteration: 90,
      appendSystemSection() {},
    }));

    expect(budgetRan).toBe(true);
    expect(outcome.graceTurn).toBe(true);
    expect(events.map((event) => event.payload.notice_type)).toEqual(['hook_error']);
    expect(String(events[0]!.payload.content)).toContain('governance boom');
  });

  it('#6943 buildDefaultPolicyPostStages returns independent stages (not one composeHooks blob)', async () => {
    const deps = makeQueryDeps();
    const runState = makeDefaultPolicyRunState();
    const stages = buildDefaultPolicyPostStages(makeConfig(), deps, runState);

    // 装配契约：必须是多段数组。若回退成 composeHooks 单段再包一层，
    // length===1，本测会红。登录/验证码墙已迁出本栈（Access Barrier HITL），
    // 现为 5 段：governance → budget → tool-loop-guard → overflow → fallback。
    expect(stages).toHaveLength(5);
    expect(new Set(stages).size).toBe(5);
    const beforeModels = stages.map((stage) => stage.beforeModel).filter(Boolean);
    expect(beforeModels.length).toBeGreaterThanOrEqual(3);
    expect(new Set(beforeModels).size).toBe(beforeModels.length);

    // 用真实装配产物接 HookRunner：毒化 governance 段后，后续段仍执行
    // （不仅 budget——guard 等也不连坐）。
    let laterStageCount = 0;
    const instrumented = stages.map((stage, index) => {
      if (index === 0) {
        return {
          async beforeModel() {
            throw new Error('governance boom');
          },
        };
      }
      return {
        ...stage,
        async beforeModel(ctx: Parameters<NonNullable<typeof stage.beforeModel>>[0]) {
          laterStageCount += 1;
          return stage.beforeModel?.(ctx);
        },
      };
    });

    const { events, result: outcome } = await collect(
      new HookRunner(instrumented, makeState(), { forceFinalRef: { current: null } })
        .runBeforeModel({
          iteration: 0,
          appendSystemSection() {},
        }),
    );

    expect(laterStageCount).toBe(stages.length - 1);
    expect(events.map((event) => event.payload.notice_type)).toEqual(['hook_error']);
    expect(String(events[0]!.payload.content)).toContain('governance boom');
    // 毒化的是 governance，不应误带上 grace（budget 在 iteration=0 为 normal）
    expect(outcome.graceTurn).toBe(false);
  });

  it('tool result policy keeps LLM view slim while canonical blocks use raw content', () => {
    const tool = makeTool('shell');
    tool.maxResultSizeChars = 1_000;
    const ctx = makeRunContextForPolicy(new Map([[tool.name, tool]]));
    const policyResult = applyToolResultPolicy({
      ctx,
      preStartedExecResults: [],
      runToolResults: [{
        toolUseId: 'tu-1',
        toolName: tool.name,
        result: {
          content: '{"status":"completed","stdout":"full","debug":"hidden"}',
          llmContextContent: '{"status":"completed","stdout":"slim"}',
          presentation: {
            kind: 'media_image_generation',
            data: { prompt: 'apple' },
          },
        },
      }],
    });

    const blocks = buildToolResultBlockSets({
      ctx,
      rawExecutionResults: policyResult.rawExecutionResults,
      executionResults: policyResult.executionResults,
    });

    expect(blocks.llmToolResultBlocks[0]!.content).toBe('{"status":"completed","stdout":"slim"}');
    expect(blocks.llmToolResultBlocks[0]).not.toHaveProperty('presentation');
    expect(blocks.canonicalToolResultBlocks[0]!.content).toBe(
      '{"status":"completed","stdout":"full","debug":"hidden"}',
    );
    expect(blocks.canonicalToolResultBlocks[0]!.presentation).toEqual({
      kind: 'media_image_generation',
      data: { prompt: 'apple' },
    });
  });

  it('tool result policy strips LLM-only keys before summary projection', () => {
    const tool = makeTool('json_tool');
    const ctx = makeRunContextForPolicy(new Map([[tool.name, tool]]));
    const policyResult = applyToolResultPolicy({
      ctx,
      preStartedExecResults: [],
      runToolResults: [{
        toolUseId: 'tu-1',
        toolName: tool.name,
        result: {
          content: '{"status":"ok","secret":"drop"}',
          llmStripKeys: ['secret'],
        },
      }],
    });

    const blocks = buildToolResultBlockSets({
      ctx,
      rawExecutionResults: policyResult.rawExecutionResults,
      executionResults: policyResult.executionResults,
    });

    expect(blocks.llmToolResultBlocks[0]!.content).toBe('{"status":"ok"}');
    expect(blocks.canonicalToolResultBlocks[0]!.content).toBe('{"status":"ok"}');
  });

  it('run prelude phases preserve initial message and visible user event behavior', () => {
    const preDeeplyNestedRef = { current: [] };
    const ctx = makeRunContextForPrelude();
    prepareInitialMessages({ ctx, preDeeplyNestedRef });

    expect(ctx.state.messages).toEqual([
      { role: 'user', content: 'visible <context type="environment">hidden</context>' },
    ]);

    const environmentState: EnvironmentContextEmitState = {
      pendingEnvContextSeq: null,
      envContextPersistEmitted: false,
    };
    const userEvents = Array.from(emitMainUserEventPhase({ ctx, environmentState }));
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]!.payload.content).toBe('visible');
    expect(environmentState.pendingEnvContextSeq).not.toBeNull();
  });

  it('#7533 push-notification yields USER even when initialMessages already loaded', () => {
    const ctx = makeRunContextForPrelude({
      params: {
        prompt: '<task-notification>shell done</task-notification>',
        clientMessageId: undefined,
        initialMessages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: 'bg started' },
          { role: 'user', content: '<task-notification>shell done</task-notification>' },
        ],
        triggeredBy: 'push-notification',
      },
    });
    const environmentState: EnvironmentContextEmitState = {
      pendingEnvContextSeq: null,
      envContextPersistEmitted: false,
    };
    const userEvents = Array.from(emitMainUserEventPhase({ ctx, environmentState }));
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]!.payload.triggered_by).toBe('push-notification');
    expect(String(userEvents[0]!.payload.content)).toContain('task-notification');
    const blocks = userEvents[0]!.payload.blocks_json as Array<{
      type: string
      text: string
      arrival_seq?: number
    }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: '<task-notification>shell done</task-notification>',
    })
    expect(typeof blocks[0]!.arrival_seq).toBe('number')
    expect(blocks[0]!.arrival_seq).toBe(userEvents[0]!.payload.arrival_seq)
  });

  it('#7985 thread notification USER event carries full text blocks for persistence', async () => {
    const events: StreamEvent[] = [];
    const hook = buildThreadNotificationsInjectorHook({
      drainThreadNotifications: async () => 'A background command completed\n\n<task-notification>shell done</task-notification>',
      generateUUID: () => 'push-message-id',
    });
    await hook.beforeModel?.({
      state: makeState(),
      emitEvent: (event: StreamEvent) => events.push(event),
      emitNotice: () => {},
    } as RunContext);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(StreamEvents.USER);
    expect(events[0]!.payload).toMatchObject({
      client_event_id: 'push-message-id',
      message_id: 'push-message-id',
      triggered_by: 'push-notification',
      blocks_json: [
        {
          type: 'text',
          text: 'A background command completed\n\n<task-notification>shell done</task-notification>',
        },
      ],
    });
  });

  it('fork/resume with history and no clientMessageId still skips USER event', () => {
    const ctx = makeRunContextForPrelude({
      params: {
        prompt: 'should-not-emit',
        clientMessageId: undefined,
        initialMessages: [
          { role: 'user', content: 'old' },
          { role: 'assistant', content: 'ok' },
        ],
        triggeredBy: undefined,
      },
    });
    const environmentState: EnvironmentContextEmitState = {
      pendingEnvContextSeq: null,
      envContextPersistEmitted: false,
    };
    const userEvents = Array.from(emitMainUserEventPhase({ ctx, environmentState }));
    expect(userEvents).toHaveLength(0);
  });

  it('run prelude marks historical environment context messages', () => {
    const messages = [{
      role: 'user' as const,
      content: '<context type="environment">\ncwd: /tmp\n</context>',
    }];

    markHistoricalContextMessages(messages);

    expect(hasInternalMarker(messages[0]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(true);
  });

  it('run prelude emits pending environment context once after main user event', () => {
    const state = makeState();
    state.messages.push(setInternalMarker({
      role: 'user',
      content: '<context type="environment">\ncwd: /tmp\n</context>',
    }, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION));
    const ctx = makeRunContextForPrelude({ state });
    const environmentState: EnvironmentContextEmitState = {
      pendingEnvContextSeq: 42,
      envContextPersistEmitted: false,
    };

    const first = Array.from(emitPendingEnvironmentContextPhase({ ctx, environmentState }));
    const second = Array.from(emitPendingEnvironmentContextPhase({ ctx, environmentState }));

    expect(first).toHaveLength(1);
    expect(first[0]!.payload.message_kind).toBe('environment_context');
    expect(first[0]!.payload.arrival_seq).toBe(42);
    expect(second).toHaveLength(0);
  });

  it('compaction controller owns usage accounting and overflow done event construction', async () => {
    const state = makeState();
    const beforeAfterStats: Array<Record<string, unknown> | undefined> = [];
    const contextManager: ContextManager = {
      beforeModelCall: async () => ({
        messages: [{ role: 'user', content: 'compacted' }],
        events: [{
          type: StreamEvents.SYSTEM_NOTICE,
          payload: { content: 'compact event', notice_type: 'compact_seen' },
        }],
        terminate: true,
        invalidateAnchor: true,
        compactUsage: { input_tokens: 7, output_tokens: 3, model: 'compact-model' },
      }),
      autoCompact: async () => null,
      invalidateSummaryCache: () => {},
    };
    const hooks: CompactHookPort = {
      async *runCompactHook(_hookName, stats) {
        beforeAfterStats.push(stats);
      },
    };
    const controller = new CompactionController({
      state,
      contextManager,
      budget: DEFAULT_CONTEXT_BUDGET,
      config: makeConfig(),
      getToolParams: () => [],
      tokenEstimator: new TokenEstimator(),
      traceId: 'trace-1',
      hooks,
    });

    const { events, result } = await collect(controller.runBeforeModelCall());

    expect(result).toBe(true);
    expect(state.messages).toEqual([{ role: 'user', content: 'compacted' }]);
    expect(state.totalInputTokens).toBe(7);
    expect(state.totalOutputTokens).toBe(3);
    expect(beforeAfterStats).toEqual([
      undefined,
      { messages_before: 0, messages_after: 1, terminated: true },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      StreamEvents.SYSTEM_NOTICE,
      StreamEvents.PERSIST_MESSAGE,
      StreamEvents.DONE,
    ]);
    expect(events[1]!.payload.blocks_json).toEqual([]);
    expect(events[1]!.payload.stop_reason).toBe('error');
    expect(events[1]!.payload.error_info_json).toEqual(expect.objectContaining({
      error_class: 'CONTEXT_OVERFLOW',
    }));
    expect(events[2]!.payload.error).toBe(true);
    expect(events[2]!.payload.error_class).toBe('CONTEXT_OVERFLOW');
  });
});
