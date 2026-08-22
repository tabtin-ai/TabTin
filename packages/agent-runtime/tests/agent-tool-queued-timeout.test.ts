/**
 * W4 D3a (2026-05-26)：queued 期间不计入子的超时窗口。
 *
 * 设计意图：之前 acquireChildSlot 路径在进入 executeChildAgent 就启动
 * `childTimeoutMs` 计时器；trySubmit 切到队列后，如果子任务在 queue 里
 * 等了 3 分钟才被激活，加上自己跑 2 分钟 → 总 5 分钟正好撞超时——这是
 * 冤枉的，因为它在 queue 期间根本没消耗 LLM。
 *
 * D3a 决策：timer 从 activation 启动，而非 trySubmit 启动。本测试验证
 * 这条不变量：queued 期间过的时间不计入超时。
 *
 * 实现位置：`agent-tool.ts` 把 `setTimeout(() => timeoutController.abort(), timeoutMs)`
 * 移到 "// 到这里 state === 'active'：开始跑 forkQuery" 之后。
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import { createAgentTool } from '../src/subagent/agent-tool.js';
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
} from '../src/engine/contracts/conversation.js';

function makeContext(overrides = {}) {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('agent-tool W4 D3a: queued 期间不计入超时', () => {
  it('在 queue 等很久后激活仍能正常完成（不被 stale timer abort）', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'pre-occupied' });

    const events: StreamEvent[] = [];

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-timeout' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      // 极短超时（50ms）——如果 timer 从 trySubmit 启动，下面 200ms 等待早就超时了
      childTimeoutMs: 50,
    });

    const promise = tool.execute(
      { prompt: '在 queue 里等 200ms 后才激活' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    // 等 200ms 模拟在 queue 里长时间等待（远超 childTimeoutMs=50ms）
    await new Promise((r) => setTimeout(r, 200));

    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_QUEUED), '已进入 queue').toBeTruthy();
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED), '尚未启动').toBeUndefined();

    // 释放 active 槽位 → 触发激活
    bt.releaseChildAgent('pre-occupied');

    const result = await promise;

    // 关键断言：queued 期间的 200ms 不应导致超时（如果 timer 从 trySubmit 启动，
    // 这里早就 SUBAGENT_FAILED + "Sub-agent timed out" 了）
    expect(result.isError, 'queued 期间不计入超时 → 正常完成').toBeFalsy();

    // 应该有 SUBAGENT_STARTED 表示真激活了
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBeTruthy();
  });

  it('缺省不设置子 Agent 执行墙钟', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const bt = new BudgetTracker({ maxConcurrentChildren: 5 });
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-no-runtime-limit' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    const resultPromise = tool.execute({ prompt: '缺省不应自动停止' }, makeContext());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.isError).toBeFalsy();
    expect(
      setTimeoutSpy.mock.calls.some(([, delay]) => delay === 30 * 60 * 1000),
      '不得再注册 30 分钟的默认执行墙钟',
    ).toBe(false);
  });

  it('显式配置 childTimeoutMs 时，激活后仍可启用执行时限', async () => {
    // 不进 queue 路径（active 有空），但用极短超时 + 慢 provider 触发真超时
    const bt = new BudgetTracker({ maxConcurrentChildren: 5 });
    const events: StreamEvent[] = [];

    // 慢 provider：模拟子 LLM 跑 200ms 才出结果
    let firstChunk = true;
    const slowProvider = {
      async *streamMessages() {
        if (firstChunk) {
          firstChunk = false;
          await new Promise((r) => setTimeout(r, 200));
        }
        yield { type: 'text_delta' as const, text: '太慢了' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider: slowProvider as never,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-real-timeout' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      childTimeoutMs: 50,
    });

    const result = await tool.execute(
      { prompt: '应该超时' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    // active 路径下 50ms 超时是合理的（跟激活时间无关）
    expect(result.isError, 'active 路径下 timer 正常生效').toBe(true);
  });
});
