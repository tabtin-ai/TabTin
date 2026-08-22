/**
 * agent-tool-w0-regression.test.ts — 总控 §六 W0 端到端回归
 *
 * 锁住两个 W0 改动不被回退：
 *
 *   - **W0-1**：`agent-tool.ts::execute` 必须把 `context.toolUseId` 透传给
 *     `executeChildAgent({ parentToolCallId })`，让 `SUBAGENT_STARTED`
 *     的 `parent_tool_call_id` payload 和 `subagents.jsonl.parentToolCallId`
 *     真有值（之前一直 undefined）。
 *
 *   - **W0-5**：`agent-tool.ts::execute` 调 `forkQuery({ inheritMode })`
 *     时必须传 `'filtered'`（D12 / 总控 §六 W0：与 PRD 06 `default_inherit_mode`
 *     对齐，省 token + 改善父子 prompt cache 命中）。**不能**回退到 `'full'`。
 *
 * 测试策略：
 *   - `vi.mock` 替换 `fork-query.ts::forkQuery`，让它只记录入参后立刻
 *     yield 完 + return 'mock summary'，不真的跑子 runtime（聚焦"agent-tool
 *     的入参打包"行为，避开 SnapshotStorage / EventStorage / 子 LLM 等副作用）。
 *   - 同时断言 `SUBAGENT_STARTED.parent_tool_call_id`（emit 链路）
 *     与 `forkQuery.parentToolCallId`（fork 链路）一致，覆盖 W0-1 双层契约。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/subagent/fork-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/subagent/fork-query.js')>();
  return {
    ...actual,
    forkQuery: vi.fn(),
  };
});

import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { createAgentTool, type AgentToolConfig } from '../src/subagent/agent-tool.js';
import { forkQuery } from '../src/subagent/fork-query.js';
import type {
  ForkQueryConfig,
} from '../src/subagent/fork-query.js';
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

const PARENT_THREAD = 'parent-thread-w0';

function makeBaseConfig(): AgentToolConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/agent-tool-w0-regression', threadId: PARENT_THREAD },
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
    runtimeId: 'runtime-w0-regression',
    toolUseId,
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    emitStreamEvent: (e: StreamEvent) => { collected.push(e); },
    __collected: collected,
  };
  return ctx as unknown as ContextWithCollected;
}

/**
 * 设置 forkQuery mock：记录最后一次入参 + yield 完成立即 return mock summary。
 *
 * 返回 lastCall accessor，便于断言时拿到入参。
 */
function setupForkQueryMock(): { lastCall: () => ForkQueryConfig | undefined } {
  let lastConfig: ForkQueryConfig | undefined;
  vi.mocked(forkQuery).mockImplementation(
    ((config: ForkQueryConfig) => {
      lastConfig = config;
      async function* gen(): AsyncGenerator<StreamEvent, string> {
        // 直接 return 'mock summary'，不 yield 任何 event
        // → agent-tool 的 while loop 第一次 next() 即 done=true
        return 'mock summary';
      }
      return gen();
    }) as typeof forkQuery,
  );
  return { lastCall: () => lastConfig };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent-tool W0 端到端回归（总控 §六 W0-1 + W0-5）', () => {
  it('W0-1：context.toolUseId 透传到 SUBAGENT_STARTED.parent_tool_call_id + forkQuery.parentToolCallId', async () => {
    const tracker = setupForkQueryMock();
    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_w0_1_abc123');

    await tool.execute(
      { prompt: 'do W0-1 thing', description: 'w0-1 regression test' },
      ctx,
    );

    // 父级 emit 链路：UI 卡片靠这个事件展示
    const started = ctx.__collected.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    expect(started, 'SUBAGENT_STARTED 必须被 emit').toBeDefined();
    const payload = started!.payload as { parent_tool_call_id?: string };
    expect(payload.parent_tool_call_id).toBe('toolu_w0_1_abc123');

    // fork 链路：SubagentIndexWriter.recordStart 靠这个字段写 subagents.jsonl
    const fp = tracker.lastCall();
    expect(fp, 'forkQuery 必须被调').toBeDefined();
    expect(fp!.parentToolCallId).toBe('toolu_w0_1_abc123');
  });

  it('W0-5：inheritMode 恒 "none"（2026-07-04 决策：子 Agent 不继承父上下文），不是 "filtered"/"full"', async () => {
    const tracker = setupForkQueryMock();
    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_w0_5_xyz789');

    await tool.execute({ prompt: 'do W0-5 thing' }, ctx);

    const fp = tracker.lastCall();
    expect(fp, 'forkQuery 必须被调').toBeDefined();
    expect(fp!.inheritMode).toBe('none');
    expect(fp!.inheritMode).not.toBe('filtered');
    expect(fp!.inheritMode).not.toBe('full');
  });
});
