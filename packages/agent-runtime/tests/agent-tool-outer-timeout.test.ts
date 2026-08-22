/**
 * W-H①（2026-05-30）：agent 子 Agent 工具的外层墙钟分叉根治回归测试。
 *
 * 背景：tool-orchestration 的外层墙钟从「工具派发时刻」起算。早先 agent 工具
 * 声明 `executionTimeoutMs = DEFAULT_CHILD_TIMEOUT_MS + 1s`（301s 有限值），
 * 大 fan-out 下子先排队、排队期间 LLM 没跑，但外层把排队时间也算进去 → 排队
 * 久的子被外层 TOOL_TIMEOUT 冤杀（违背 D3a）。
 *
 * 已有的 `agent-tool-queued-timeout.test.ts` 直接调 `tool.execute`，**绕过了
 * runTools / executeTool 外层墙钟**，覆盖不到这条链路——本测试补上「经 runTools
 * → executeTool → resolveExecutionTimeoutMs 全链路」的回归。
 *
 * 修法：agent 工具声明 `executionTimeoutMs = AGENT_TOOL_OUTER_TIMEOUT_BACKSTOP_MS`
 * （24h「极大值」），让外层墙钟在真实排队与执行窗口内不成为产品级停止条件。
 * 子 Agent 缺省不设激活后的执行时限；Host 显式配置时才由内层
 * timeoutController 从 activation 起算。保留有限外层值是为了让 generator 无法
 * settle 时仍能解锁父 turn，而不是永久挂起。
 *
 * 关键不变量：外层兜底必须 >> 任何真实排队+跑窗口（这里用 runTools 的极小
 * fallback timeoutMs 作对照——agent 工具的自声明值必须压过它，否则排队就被冤杀）。
 */

import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import { createAgentTool, AGENT_TOOL_NAME } from '../src/subagent/agent-tool.js';
import { ToolRegistry } from '../src/engine/tooling/tool-system.js';
import { runTools, resolveExecutionTimeoutMs, type ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'agent-call-0',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  } as ToolContext;
}

function makeAgentBlock(input: unknown): ToolUseBlock {
  return { type: 'tool_use', id: 'agent-call-0', name: AGENT_TOOL_NAME, input };
}

async function drainToResult(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<ToolExecutionResult[]> {
  let n = await gen.next();
  while (!n.done) n = await gen.next();
  return n.value;
}

function buildAgentTool(bt: BudgetTracker): Tool {
  return createAgentTool({
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test-wh1-outer', threadId: 'sess-wh1' },
    model: 'claude-sonnet-4-20250514',
    budgetTracker: bt,
    // 内层窗口充足——本测试只验证「外层不冤杀」，不验证内层超时（那条由
    // agent-tool-queued-timeout.test.ts 覆盖）。
    childTimeoutMs: 10_000,
  });
}

describe('W-H①: agent 工具外层墙钟用极大值兜底（全链路）', () => {
  it('contract: resolveExecutionTimeoutMs 对 agent 工具返回极大值，压过外层 fallback', () => {
    const tool = buildAgentTool(new BudgetTracker({ maxConcurrentChildren: 1 }));
    // 即便 orchestration 传一个很小的 fallback，agent 工具的自声明极大值都压过它，
    // 排队等待绝不会撞外层兜底。同时仍是有限值（保留 Promise.race 硬兜底）。
    const resolved = resolveExecutionTimeoutMs(tool, {}, 60_000);
    expect(Number.isFinite(resolved)).toBe(true);
    // 远超任何真实排队与执行窗口；只作为工具编排层故障兜底
    expect(resolved).toBeGreaterThan(60 * 60 * 1000); // > 1h
    // 不被极小 fallback 覆盖
    expect(resolveExecutionTimeoutMs(tool, {}, 1)).toBe(resolved);
  });

  it('普通工具仍走 fallback / 自声明有限值（确保 Infinity 分支没误伤其它工具）', () => {
    const finiteTool: Tool = {
      name: 'finite_tool',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      executionTimeoutMs: 5_000,
      execute: async () => ({ content: 'ok' }),
    };
    const noDeclTool: Tool = {
      name: 'no_decl_tool',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: async () => ({ content: 'ok' }),
    };
    expect(resolveExecutionTimeoutMs(finiteTool, {}, 60_000)).toBe(5_000);
    expect(resolveExecutionTimeoutMs(noDeclTool, {}, 60_000)).toBe(60_000);
  });

  it('排队久的子 Agent 不被外层墙钟冤杀（经 runTools/executeTool 全链路）', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'occupier' }); // 占满唯一 active 槽，逼 agent 子排队

    const tool = buildAgentTool(bt);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    const events: StreamEvent[] = [];
    const ctx = makeContext({
      agentRunId: 'agent-run-wh1',
      emitStreamEvent: (e: StreamEvent) => events.push(e),
    });

    // 关键：给 runTools 一个**极小**的外层 fallback timeoutMs（30ms）。若 agent
    // 工具没退出外层墙钟，这个 30ms（或被 clamp 的 1ms）会在排队期间触发，把
    // 排队子冤杀成 tool_timeout。
    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [makeAgentBlock({ prompt: '排队很久后才激活' })],
      registry,
      context: ctx,
      permissionHandler: createMockPermissionHandler(),
      timeoutMs: 30,
    });

    const resultPromise = drainToResult(gen);

    // 排队 150ms（远超外层 30ms）模拟大 fan-out 下的长时间排队
    await new Promise((r) => setTimeout(r, 150));
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_QUEUED), '应已进入排队').toBeTruthy();
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED), '尚未激活').toBeUndefined();

    // 释放槽位 → 子真激活，内层窗口 10s 充足 → 正常完成
    bt.releaseChildAgent('occupier');

    const results = await resultPromise;
    expect(results[0].result.isError, '排队 150ms 后激活仍正常完成（未被外层冤杀）').toBeFalsy();
    expect(String(results[0].result.content)).not.toContain('timed out');
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED), '已真激活').toBeTruthy();
  });
});
