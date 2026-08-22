/**
 * W4 (2026-05-26)：agent-tool trySubmit + onActivate + 排队语义集成测试。
 *
 * 覆盖：
 *   1. active 槽位有空：直接 'active' 路径 → 真启动子 runtime
 *   2. active 满 + queue 有空位：'queued' 路径 → emit SUBAGENT_QUEUED →
 *      等 onActivate → release 后激活 → emit SUBAGENT_STARTED
 *   3. queue 也满：reject queue_full → 中文文案 + isError + SUBAGENT_SPAWN_BLOCKED notice
 *   4. budget 耗尽：reject budget_exhausted → 中文文案 + telemetry
 *   5. queued 子被父 abort：onActivate 回调触发但 abortSignal.aborted → 不真启动
 *      → emit SUBAGENT_FAILED { cancelled: true }
 *
 * 哲学对齐：
 *   - C3 派任务总是被接住：默认排队，error 是罕见兜底
 *   - D3 主 LLM 不感知 queued 中间态：await activation 让 tool_result 等到子完成
 *   - D3a queued 期间不计入超时（另文件 agent-tool-queued-timeout.test.ts 覆盖）
 */

import { describe, it, expect } from 'vitest';
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
import type {
  Tool,
} from '../src/engine/contracts/tools.js';

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

describe('agent-tool W4 trySubmit + queue 集成', () => {
  it('active 有空：trySubmit 直接 active，正常跑完', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 5 });
    const events: StreamEvent[] = [];

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-active' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    const result = await tool.execute(
      { prompt: '正常单子 Agent' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBeFalsy();
    // 直接 active → 应该有 SUBAGENT_STARTED 但无 SUBAGENT_QUEUED
    const started = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    const queued = events.find((e) => e.type === StreamEvents.SUBAGENT_QUEUED);
    expect(started).toBeTruthy();
    expect(queued).toBeUndefined();
    // 槽位最终被回收
    expect(bt.getActiveChildrenCount()).toBe(0);
  });

  it('active 满 + queue 有空：emit SUBAGENT_QUEUED + await activation', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    // 占住唯一 active 槽位
    bt.trySubmit({ speakerId: 'pre-occupied' });

    const events: StreamEvent[] = [];

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-queued' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    // 派发——此时 active 满，应进 queue
    const promise = tool.execute(
      { prompt: '排队子任务' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    // 让 trySubmit + onActivate 注册先完成
    await new Promise((r) => setTimeout(r, 10));

    // 此时应该已 emit SUBAGENT_QUEUED 但还未 SUBAGENT_STARTED
    const queued = events.find((e) => e.type === StreamEvents.SUBAGENT_QUEUED);
    expect(queued, 'SUBAGENT_QUEUED 已 emit').toBeTruthy();
    const queuedPayload = queued!.payload as Record<string, unknown>;
    expect(queuedPayload.task).toBe('排队子任务');
    expect(queuedPayload.active_count).toBe(1);
    expect(queuedPayload.max_active).toBe(1);

    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED), 'STARTED 还没发').toBeUndefined();

    // 释放占用 → 触发 drainQueue + onActivate callback
    bt.releaseChildAgent('pre-occupied');

    const result = await promise;
    expect(result.isError).toBeFalsy();

    // 激活后应有 SUBAGENT_STARTED
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED), 'STARTED 已发').toBeTruthy();
  });

  it('active 满 + queue 满：reject queue_full + 中文文案', async () => {
    // maxConcurrentChildren=1 + maxQueueSize=0（禁用排队）让"满即拒"
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 0 });
    bt.trySubmit({ speakerId: 'pre-occupied' });

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-full' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    const result = await tool.execute(
      { prompt: '满了应该拒' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBe(true);
    // D2 中文文案 + 行动建议
    expect(result.content).toContain('任务队列已满');
    expect(result.content).toContain('多轮发送');
    // W1-M3 守门：spawn_blocked（队列满 return）是「无执行状态的子」——绝不回传
    // [子 Agent ID]（根本没起跑、没有可 resume 的 session）。
    expect(result.content).not.toMatch(/子 Agent ID/);

    // SYSTEM_NOTICE 带 reason='queue_full'
    const notice = events.find((e) => e.type === StreamEvents.SYSTEM_NOTICE);
    expect(notice).toBeTruthy();
    expect((notice!.payload as { reason?: string }).reason).toBe('queue_full');
  });

  it('budget 耗尽：reject budget_exhausted + 中文文案', async () => {
    const bt = new BudgetTracker({ maxTotalTokens: 100 });
    bt.recordUsage(60, 50); // 110 > 100

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-budget' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    const result = await tool.execute(
      { prompt: '没钱了' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('账单余额不足');
    // W1-M3 守门：budget_exhausted（spawn_blocked 的另一支）同样无执行状态 → 不回传 id。
    expect(result.content).not.toMatch(/子 Agent ID/);

    const notice = events.find((e) => e.type === StreamEvents.SYSTEM_NOTICE);
    expect((notice!.payload as { reason?: string }).reason).toBe('budget_exhausted');
  });

  // P0-1 修复回归测试（2026-05-26 三视角 review 抓出）：
  //
  // 修前：cancelSubagent 只查 activeChildren，queued 子 Agent 的 childId 此时
  // 还没 set 进 activeChildren → 返回 false → store 不 markCancelled →
  // BudgetTracker 槽位释放后子 Agent 醒来正常跑下去。用户：「我明明点了取消，
  // 怎么过会儿又跑起来了？」违背哲学 C5 "取消有明确语义"。
  //
  // 修后：cancelSubagent 双查 active + queued；命中 queued 时调
  // budgetTracker.cancelQueued() 主动触发 onActivate callback resolve，
  // 让 await Promise unblock + abortSignal 检测命中 → emit SUBAGENT_FAILED
  // { cancelled: true } + 不真启动。
  it('P0-1 修复：cancelSubagent 能取消 queued 子 Agent（不再是空头按钮）', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'pre-occupied' });

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-cancel-single' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    const promise = tool.execute(
      { prompt: '排队中要被 cancelSubagent 取消' },
      makeContext({
        emitStreamEvent: (e: StreamEvent) => events.push(e),
      }),
    );

    // 等 SUBAGENT_QUEUED emit + queuedChildren 登记完成
    await new Promise((r) => setTimeout(r, 10));
    const queuedEvt = events.find((e) => e.type === StreamEvents.SUBAGENT_QUEUED);
    expect(queuedEvt).toBeTruthy();
    const childId = (queuedEvt!.payload as { subagent_run_id: string }).subagent_run_id;

    // 验证 queuedChildren 真的登记了（getQueuedSubagentIds 是 P0-1 修复加的导出）
    const { getQueuedSubagentIds, cancelSubagent } = await import('../src/subagent/agent-tool.js');
    expect(getQueuedSubagentIds()).toContain(childId);

    // 调 cancelSubagent —— 修前必返 false（只查 active），修后命中 queued 返 true
    const ok = cancelSubagent(childId);
    expect(ok).toBe(true);

    const result = await promise;
    expect(result.isError).toBe(true);
    // W4 review P1-H：cancelled-before-activation 文案中文化
    expect(result.content).toContain('排队等待时被取消');
    // W1-M3 守门：queued-cancel（排队中被取消 return）——子 Agent 从未真正起跑、
    // 没有可 resume 的执行状态，绝不回传 [子 Agent ID]。
    expect(result.content).not.toMatch(/子 Agent ID/);

    // SUBAGENT_STARTED 不应该出现（子 Agent 真没启动）
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBeUndefined();
    // SUBAGENT_FAILED { cancelled: true, error_kind: 'cancelled' }
    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed).toBeTruthy();
    const failedPayload = failed!.payload as { cancelled?: boolean; error_kind?: string };
    expect(failedPayload.cancelled).toBe(true);
    expect(failedPayload.error_kind).toBe('cancelled');

    // queuedChildren 应已清理（不留死字段）
    expect(getQueuedSubagentIds()).not.toContain(childId);
  });

  // P0-1 关联回归：cancel 一个 queued 后，BudgetTracker queue 应能继续 drain
  // 下一个等待者（pre-occupied 完成时）
  it('P0-1 修复：cancelSubagent 取消 queued 后不影响 queue 后续 drain', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'occupant' });
    bt.trySubmit({ speakerId: 'cancelled-one' });
    bt.trySubmit({ speakerId: 'survivor' });

    let survivorActivated = false;
    bt.onActivate('survivor', () => { survivorActivated = true; });

    // 取消中间那个 queued
    const cancelOk = bt.cancelQueued('cancelled-one');
    expect(cancelOk).toBe(true);
    expect(survivorActivated).toBe(false); // 不应该把 survivor 拉起来

    // active 释放 → drain → survivor 入 active
    bt.releaseChildAgent('occupant');
    expect(survivorActivated).toBe(true);
  });

  //  死锁回归（2026-07-06）：嵌套 fork「父占槽等子、子排队等槽」。
  //
  // 修前：并发槽位全树单池——L1（depth=1）占满池后前台 await 它 fork 的 L2
  // （depth=2），L2 trySubmit 进 queue 等 L1 释放槽，而 L1 要等 L2 跑完才释放
  // → 循环等待，本用例会一直挂到 testTimeout。
  // 修后：槽位按深度分池，L2 直接 active，整条链正常完成。
  it('#3300: L1 占满池后前台 fork L2 不死锁（分池后 L2 直接跑完）', async () => {
    // maxConcurrentChildren=1：单个 L1 即占满 depth-1 池，最小死锁配置
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    const events: StreamEvent[] = [];

    // 工具集包含 agent 工具自身，让 L1 能再 fork L2（生产同构：子 Agent 继承
    // 含 agent 的完整工具集，depth>=2 才结构性剔除）
    const toolList: Tool[] = [];
    const tools = { getTools: () => toolList };
    // LLM 调用时序：L1 首轮 fork L2 → L2 首轮出文本结束 → L1 次轮出文本结束
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-nested-1', name: 'agent', input: { prompt: '第二层子任务' } } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'L2 done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'L1 done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const tool = createAgentTool({
      provider,
      tools,
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-nested-deadlock' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });
    toolList.push(tool);

    const result = await tool.execute(
      { prompt: '第一层：再 fork 一个第二层子并等它完成' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBeFalsy();
    // L2 不应经历排队（分池后 depth-2 池有空位直接 active）。L1 的 STARTED 直发
    // parentEmitter；L2 的 STARTED 由 L1 的 agent-tool wrap 成 SUBAGENT_STREAM_EVENT
    // 上抛——两条链路都不该出现 QUEUED。
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_QUEUED)).toBeUndefined();
    // 整棵树完成后所有槽位归还
    expect(bt.getActiveChildrenCount()).toBe(0);
  }, 30_000);

  it('queued 期间被父 abort：emit SUBAGENT_FAILED { cancelled: true } + 不真启动', async () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'pre-occupied' });

    const events: StreamEvent[] = [];
    const ac = new AbortController();

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'sess-cancel' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    const promise = tool.execute(
      { prompt: '排队中要被取消' },
      makeContext({
        emitStreamEvent: (e: StreamEvent) => events.push(e),
        abortSignal: ac.signal,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_QUEUED)).toBeTruthy();

    // 父 abort → cancelAllByParent 也会触发 onActivate callback
    ac.abort();
    bt.cancelAllByParent();

    const result = await promise;
    expect(result.isError).toBe(true);
    // W4 review P1-H：cancelled-before-activation 文案中文化
    expect(result.content).toContain('排队等待时被取消');
    // W1-M3 守门：父 abort 取消 queued 子同样无执行状态 → 不回传 [子 Agent ID]。
    expect(result.content).not.toMatch(/子 Agent ID/);

    // 不应该走 SUBAGENT_STARTED；应该有 SUBAGENT_FAILED { cancelled: true }
    expect(events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBeUndefined();
    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed).toBeTruthy();
    expect((failed!.payload as { cancelled?: boolean }).cancelled).toBe(true);
  });
});
