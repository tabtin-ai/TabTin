/**
 * W-H②（父 turn abort 误判 failed）+ W-H③（budget 耗尽 drain 假激活绕过并发上限）
 * 回归测试（2026-05-30）。
 *
 * W-H②：父 turn 整体 abort（context.abortSignal.aborted）时，旧逻辑 catch 把子
 *   归 'failed'（wasCancelled 只看 activeChildren、isTimeout 又被 `!context
 *   .abortSignal.aborted` 排除）。但 fork-query 落盘按 signal.aborted 记的是
 *   'cancelled' → live 事件与持久化 trace 自相矛盾。修后父 abort 归 'cancelled'。
 *
 * W-H③：budget 耗尽时 BudgetTracker._drainQueue 调 _flushQueueCallbacks，只
 *   resolve queued 子的 await callback、**不**把它加进 activeChildren。旧逻辑
 *   下 agent-tool 检测不到 → 误走 active 路径假激活（emit SUBAGENT_STARTED +
 *   真跑 forkQuery），绕过并发上限。修后用 isActiveChild 识别假唤醒，走取消分支。
 */

import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
} from '../src/engine/contracts/model-llm.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  } as ToolContext;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('W-H②: 父 turn abort 时子 Agent 归 cancelled（不是 failed）', () => {
  it('父 abort 中断运行中的子 → SUBAGENT_FAILED.error_kind=cancelled', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 5 });
    const events: StreamEvent[] = [];
    const parentController = new AbortController();

    // 用 barrier 确定性地让子 Agent「卡在运行中」：provider 先吐一个 chunk 让子真正
    // 进入 running（发 SUBAGENT_STARTED / SUBAGENT_STREAM_EVENT），然后阻塞在
    // blockPromise——这样子既不会提前完成、也不依赖流式 checkAbort 时序。测试 abort
    // 父 turn 后释放 barrier，provider 抛错 → 子 query 抛 → executeChildAgent catch
    // 命中 parentAborted 分支。（即便内层 timeoutController abort 已让 query 提前抛
    // ABORT，结果一致：catch 都看到 context.abortSignal.aborted=true。）
    let releaseBlock!: () => void;
    const blockPromise = new Promise<void>((resolve) => { releaseBlock = resolve; });

    const blockingProvider: LLMProvider = {
      async *createStream() {
        yield { type: 'text_delta' as const, text: 'working' };
        await blockPromise;
        throw new Error('upstream interrupted');
      },
    };

    const tool = createAgentTool({
      provider: blockingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-wh2', threadId: 'sess-wh2' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      childTimeoutMs: 10_000, // 充足，确保不是内层超时抢先
    });

    const promise = tool.execute(
      { prompt: '会被父 turn 取消' },
      makeContext({
        abortSignal: parentController.signal,
        emitStreamEvent: (e: StreamEvent) => events.push(e),
      }),
    );

    // 等子 Agent 进入 running（SUBAGENT_STARTED 同步早于 forkQuery，onParentAbort
    // 监听此时已挂上），再 abort 父 turn。
    await waitFor(() => events.some((e) => e.type === StreamEvents.SUBAGENT_STARTED));
    parentController.abort();
    // 让 abort 先传播（onParentAbort → timeoutController.abort），再释放 barrier
    // 确保子一定抛错退出（不依赖 callModel 是否自动中断 await）。
    await new Promise((r) => setTimeout(r, 20));
    releaseBlock();

    const result = await promise;

    expect(result.isError).toBe(true);
    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed, '应发 SUBAGENT_FAILED').toBeTruthy();
    const payload = failed!.payload as { error_kind?: string; cancelled?: boolean };
    expect(payload.error_kind, '父 abort 应归 cancelled（修前为 failed）').toBe('cancelled');
    expect(payload.cancelled).toBe(true);
    // LLM 看到的 content 也应是 cancelled 文案，不是 "Sub-agent failed: ..."
    expect(String(result.content)).toContain('cancelled');
    expect(String(result.content)).not.toContain('Sub-agent failed');
  });
});

describe('W-H③: budget 耗尽 drain 不假激活绕过并发上限', () => {
  it('排队子在 budget 耗尽 flush 唤醒后走取消分支，不 emit SUBAGENT_STARTED', async () => {
    // maxConcurrentChildren=1 + 可耗尽的 token 预算
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5, maxTotalTokens: 200 });
    bt.trySubmit({ speakerId: 'occupier' }); // 占满唯一 active 槽

    const events: StreamEvent[] = [];

    // provider 若被调用就说明假激活了——本测试期望它**永不被调用**。
    let providerCalled = false;
    const guardProvider: LLMProvider = {
      async *createStream() {
        providerCalled = true;
        yield { type: 'text_delta' as const, text: 'should-not-run' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider: guardProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-wh3', threadId: 'sess-wh3' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      childTimeoutMs: 10_000,
    });

    const promise = tool.execute(
      { prompt: '排队时撞上 budget 耗尽' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    // 等子进入排队
    await waitFor(() => events.some((e) => e.type === StreamEvents.SUBAGENT_QUEUED));

    // 排队期间耗尽预算（150+60=210 >= 200）
    bt.recordUsage(150, 60);

    // 释放占位 active 槽 → _drainQueue 发现 isExhausted → _flushQueueCallbacks
    // 只 resolve callback 不 add active → 子被"假唤醒"
    bt.releaseChildAgent('occupier');

    const result = await promise;

    // 关键不变量：
    expect(result.isError, '应返回错误（取消/预算耗尽）').toBe(true);
    expect(providerCalled, '不得假激活真跑 forkQuery（绕过并发上限）').toBe(false);
    expect(
      events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED),
      '不得 emit SUBAGENT_STARTED（那是假激活的标志）',
    ).toBeUndefined();
    // 走的是取消分支，并带 budget 语义文案
    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed).toBeTruthy();
    expect((failed!.payload as { error_kind?: string }).error_kind).toBe('cancelled');
    expect(String(result.content)).toContain('预算');
  });
});
