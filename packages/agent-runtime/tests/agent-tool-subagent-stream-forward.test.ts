/**
 * agent-tool-subagent-stream-forward.test.ts — PRD §4.18 子 Agent 实时流 forward 回归
 *
 * 测什么：
 *   1. 直接子 Agent：每个 child envelope 原 type 转发给 parent emitter，并盖 subagent_run_id
 *   2. 路由字段：subagent_run_id = childId / parent_run_id = null / chain = [childId]
 *   3. 不再生成 child_event 包装
 *   4. 嵌套旧包装解包后仍是内层 type，chain prepend childId
 *   5. 既有 SUBAGENT_STARTED / PROGRESS / COMPLETED 仍正常 emit
 *
 * 测试策略：同 agent-tool-tool-history.test.ts，mock fork-query 喂人造 child events。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/subagent/fork-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/subagent/fork-query.js')>();
  return {
    ...actual,
    forkQuery: vi.fn(),
  };
});

import { StreamEvents, ContentBlockEvents } from '../src/engine/contracts/stream-events.js';
import { createAgentTool, type AgentToolConfig } from '../src/subagent/agent-tool.js';
import { forkQuery } from '../src/subagent/fork-query.js';
import type { ForkQueryConfig } from '../src/subagent/fork-query.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';

const PARENT_THREAD = 'parent-stream-forward-test';

function makeBaseConfig(): AgentToolConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/agent-tool-stream-forward', threadId: PARENT_THREAD },
    model: 'sonnet',
    systemPrompt: 'parent system prompt',
  };
}

interface ContextWithCollected extends ToolContext {
  __collected: StreamEvent[];
}

function makeContext(toolUseId: string): ContextWithCollected {
  const collected: StreamEvent[] = [];
  const ctx = {
    threadId: PARENT_THREAD,
    runtimeId: 'runtime-stream-forward',
    toolUseId,
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    emitStreamEvent: (e: StreamEvent) => { collected.push(e); },
    __collected: collected,
  };
  return ctx as unknown as ContextWithCollected;
}

function setupForkQueryMock(events: StreamEvent[]): void {
  vi.mocked(forkQuery).mockImplementation(((_config: ForkQueryConfig) => {
    async function* gen(): AsyncGenerator<StreamEvent, string> {
      for (const ev of events) yield ev;
      return 'mock summary';
    }
    return gen();
  }) as typeof forkQuery);
}

function pickForwardedTranscript(events: StreamEvent[]): StreamEvent[] {
  return events.filter((event) => {
    const runId = (event.payload as { subagent_run_id?: string } | undefined)?.subagent_run_id;
    if (typeof runId !== 'string' || !runId) return false;
    return !event.type.startsWith('agent.stream.subagent');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PRD §4.18 子 Agent 同构 stream forward ', () => {
  it('scheduled 父 Agent fork 子 Agent 时透传 runtimeMode', async () => {
    let capturedConfig: ForkQueryConfig | undefined;
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      capturedConfig = config;
      async function* gen(): AsyncGenerator<StreamEvent, string> { return 'mock summary'; }
      return gen();
    }) as typeof forkQuery);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_p_scheduled');
    ctx.runtimeMode = 'scheduled';
    await tool.execute({ prompt: 'ask child', description: 'child task' }, ctx);

    expect(capturedConfig?.runtimeMode).toBe('scheduled');
  });

  it('直接子 Agent：每个 child envelope 都按原 type forward，并盖 subagent_run_id', async () => {
    setupForkQueryMock([
      {
        type: ContentBlockEvents.MESSAGE_START,
        payload: { message_id: 'm-1', role: 'assistant', run_id: 'run-1', message_kind: 'main' },
      },
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          message_id: 'm-1',
          index: 0,
          block_id: 'b-1',
          block: { type: 'text', text: '' },
        },
      },
      {
        type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
        payload: { message_id: 'm-1', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_p_1');
    await tool.execute({ prompt: 'say hello', description: 'greet' }, ctx);

    const forwarded = pickForwardedTranscript(ctx.__collected);
    expect(forwarded).toHaveLength(3);
    expect(forwarded.map((event) => event.type)).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
    ]);

    const first = forwarded[0].payload as Record<string, unknown>;
    expect(typeof first.subagent_run_id).toBe('string');
    expect(first.parent_run_id).toBeNull();
    expect(Array.isArray(first.subagent_chain)).toBe(true);
    expect((first.subagent_chain as string[])).toHaveLength(1);
    expect((first.subagent_chain as string[])[0]).toBe(first.subagent_run_id);
    expect(first.message_id).toBe('m-1');
    expect(first.child_event).toBeUndefined();
  });

  it('所有转发正文共享同一个 childId（同一子 Agent 一次 query 内）', async () => {
    setupForkQueryMock([
      { type: ContentBlockEvents.MESSAGE_START, payload: { message_id: 'm-1', role: 'assistant', run_id: 'r1', message_kind: 'main' } },
      { type: ContentBlockEvents.CONTENT_BLOCK_START, payload: { message_id: 'm-1', index: 0, block: { type: 'text', text: '' } } },
      { type: ContentBlockEvents.CONTENT_BLOCK_DELTA, payload: { message_id: 'm-1', index: 0, delta: { type: 'text_delta', text: 'foo' } } },
      { type: ContentBlockEvents.MESSAGE_STOP, payload: { message_id: 'm-1' } },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_p_consistency');
    await tool.execute({ prompt: 'test', description: 'consistency' }, ctx);

    const forwarded = pickForwardedTranscript(ctx.__collected);
    const runIds = new Set(forwarded.map(e => (e.payload as { subagent_run_id: string }).subagent_run_id));
    expect(runIds.size).toBe(1);
  });

  // 2026-05-29 dogfood bug 2：嵌套孙 Agent 的 SUBAGENT_* metadata 必须经
  // childEmitter 透传到父 → renderer，否则孙 Agent 在子详情面板聚合卡永远「连接中」。
  it('嵌套孙 Agent 的 SUBAGENT_STARTED/COMPLETED metadata 经 childEmitter 透传给父', async () => {
    // mock forkQuery：模拟「子」runtime 内部经 emitStreamEvent（= 父的 childEmitter）
    // 发「孙」的生命周期 metadata + 一个应被屏蔽的子内部 raw 事件。
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      config.emitStreamEvent?.({
        type: StreamEvents.SUBAGENT_STARTED,
        payload: { subagent_run_id: 'grandchild-run', parent_tool_call_id: 'toolu_child_agent', task: 'reply 1' },
      });
      config.emitStreamEvent?.({
        type: StreamEvents.SUBAGENT_COMPLETED,
        payload: { subagent_run_id: 'grandchild-run', parent_tool_call_id: 'toolu_child_agent', summary: 'done' },
      });
      // 子内部 raw 元事件（message_delta）不在任何 forward 白名单 → childEmitter 应丢弃
      config.emitStreamEvent?.({
        type: ContentBlockEvents.MESSAGE_DELTA,
        payload: { message_id: 'm', delta: { stop_reason: 'end_turn' } },
      });
      async function* gen(): AsyncGenerator<StreamEvent, string> { return 'summary'; }
      return gen();
    }) as typeof forkQuery);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_p_nested_meta');
    await tool.execute({ prompt: 'child spawns grandchild', description: 'nested' }, ctx);

    // __collected 里此时有两类 SUBAGENT_STARTED：
    //   1. 本层 agent-tool 给「子」直接 emit 的（subagent_run_id = 随机 childId）
    //   2. 经 childEmitter 透传上来的「孙」的（subagent_run_id = 'grandchild-run'）
    // 取「孙」那条验证透传 + parentToolCallId 保留。
    const grandchildStarted = ctx.__collected.find(
      e => e.type === StreamEvents.SUBAGENT_STARTED
        && (e.payload as { subagent_run_id?: string }).subagent_run_id === 'grandchild-run',
    );
    expect(grandchildStarted).toBeTruthy();
    // parent_tool_call_id 必须保留（renderer 聚合卡按它反查孙 run；tool_use id 全局唯一）
    expect((grandchildStarted!.payload as { parent_tool_call_id?: string }).parent_tool_call_id).toBe('toolu_child_agent');
    const grandchildCompleted = ctx.__collected.find(
      e => e.type === StreamEvents.SUBAGENT_COMPLETED
        && (e.payload as { subagent_run_id?: string }).subagent_run_id === 'grandchild-run',
    );
    expect(grandchildCompleted).toBeTruthy();
    expect((grandchildCompleted!.payload as { parent_tool_call_id?: string }).parent_tool_call_id).toBe('toolu_child_agent');
    // 子内部 raw message_delta 不应作为裸事件透传给父（C1/C4：不洪水淹没父 UI）
    const rawDelta = ctx.__collected.find(e => e.type === ContentBlockEvents.MESSAGE_DELTA);
    expect(rawDelta).toBeFalsy();
  });

  it('嵌套旧包装：解包后仍是内层 type，chain prepend childId', async () => {
    // 模拟 grandchild → child（这一层 agent-tool）：fork-query yield 出的事件是
    // grandchild 透传上来的 SUBAGENT_STREAM_EVENT
    const grandchildRunId = 'grandchild-run-uuid';
    setupForkQueryMock([
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: grandchildRunId,
          parent_run_id: null,
          subagent_chain: [grandchildRunId],
          child_event: {
            type: ContentBlockEvents.MESSAGE_START,
            payload: { message_id: 'g-m-1', role: 'assistant' },
          },
        },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_nested');
    await tool.execute({ prompt: 'spawn nested', description: 'nested' }, ctx);

    const forwarded = pickForwardedTranscript(ctx.__collected);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].type).toBe(ContentBlockEvents.MESSAGE_START);

    const projected = forwarded[0].payload as Record<string, unknown>;
    expect(projected.subagent_run_id).toBe(grandchildRunId);
    expect(typeof projected.parent_run_id).toBe('string');
    expect(projected.parent_run_id).not.toBe(grandchildRunId);
    expect(projected.message_id).toBe('g-m-1');

    const chain = projected.subagent_chain as string[];
    expect(chain).toHaveLength(2);
    expect(chain[chain.length - 1]).toBe(grandchildRunId);
    expect(chain[0]).toBe(projected.parent_run_id);
    expect(projected.child_event).toBeUndefined();
  });

  // 根因回归（"孙代理消息没挂到卡片"）：孙 transcript 的 SUBAGENT_STREAM_EVENT
  // 是「子」的 agent-tool 经 `config.emitStreamEvent`（= 父的 childEmitter）**同步
  // sink** 发出的，不走 forkQuery yield。childEmitter 必须放行并 re-wrap，否则被
  // 白名单丢弃 → 孙 Agent 在子详情面板聚合卡里永远没有 transcript。
  it('孙 transcript 经 childEmitter sink 发出时也被同构透传（不被白名单丢弃）', async () => {
    const grandchildRunId = 'grandchild-sink-run';
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      // 模拟「子」runtime 里它的 agent-tool while 循环把孙 envelope wrap 后，经
      // context.emitStreamEvent（= 本层 childEmitter）同步发出（不是 yield）。
      config.emitStreamEvent?.({
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: grandchildRunId,
          parent_run_id: null,
          subagent_chain: [grandchildRunId],
          child_event: {
            type: ContentBlockEvents.MESSAGE_START,
            payload: { message_id: 'g-sink-m-1', role: 'assistant' },
          },
        },
      });
      async function* gen(): AsyncGenerator<StreamEvent, string> { return 'summary'; }
      return gen();
    }) as typeof forkQuery);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_sink_nested');
    await tool.execute({ prompt: 'child spawns grandchild', description: 'nested-sink' }, ctx);

    // 找到 subagent_run_id = grandchild 的那条透传（排除本层给「子」发的 transcript）。
    const forwarded = pickForwardedTranscript(ctx.__collected).find(
      e => (e.payload as { subagent_run_id?: string }).subagent_run_id === grandchildRunId,
    );
    expect(forwarded).toBeTruthy();
    expect(forwarded!.type).toBe(ContentBlockEvents.MESSAGE_START);
    const payload = forwarded!.payload as Record<string, unknown>;
    expect(payload.subagent_run_id).toBe(grandchildRunId);
    expect(typeof payload.parent_run_id).toBe('string');
    expect(payload.parent_run_id).not.toBe(grandchildRunId);
    expect(payload.message_id).toBe('g-sink-m-1');
    const chain = payload.subagent_chain as string[];
    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(payload.parent_run_id);
    expect(chain[chain.length - 1]).toBe(grandchildRunId);
    expect(payload.child_event).toBeUndefined();
  });

  it('既有 SUBAGENT_STARTED 仍正常 emit（forward 路径不破坏现有事件）', async () => {
    setupForkQueryMock([
      { type: ContentBlockEvents.MESSAGE_START, payload: { message_id: 'm-1', role: 'assistant' } },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_started');
    await tool.execute({ prompt: 'go', description: 'started' }, ctx);

    const startedEvents = ctx.__collected.filter(e => e.type === StreamEvents.SUBAGENT_STARTED);
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);

    const streamEvents = pickForwardedTranscript(ctx.__collected);
    expect(streamEvents.length).toBeGreaterThan(0);
    expect(ctx.__collected.some((event) => event.type === StreamEvents.SUBAGENT_STREAM_EVENT)).toBe(false);
  });

  it('既有 SUBAGENT_PROGRESS（tool_use cb_start 触发的）仍正常 emit', async () => {
    // CONTENT_BLOCK_START + tool_use 会同时触发：
    //   - SUBAGENT_STREAM_EVENT forward（PRD §4.18 新增）
    //   - SUBAGENT_PROGRESS（W6 toolHistory 旧逻辑）
    // 两条路径必须互不干扰。
    setupForkQueryMock([
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          message_id: 'm-1',
          index: 0,
          block_id: 'tu-1',
          block: { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: '/x' } },
        },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_progress');
    await tool.execute({ prompt: 'tool', description: 'progress' }, ctx);

    const progressEvents = ctx.__collected.filter(e => e.type === StreamEvents.SUBAGENT_PROGRESS);
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    const lastProgress = progressEvents[progressEvents.length - 1].payload as Record<string, unknown>;
    expect(lastProgress.latest_tool).toBe('read_file');
    expect(lastProgress.parent_tool_call_id).toBe('toolu_progress');

    const streamEvents = pickForwardedTranscript(ctx.__collected);
    expect(streamEvents.length).toBe(1);
  });
});
