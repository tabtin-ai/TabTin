/**
 * SubagentManager 单测（W4a S1，2026-05-30）。
 *
 * 覆盖（plan S1 验收）：
 *   1. registerRun / getStatus / list / has / size 基础登记视图。
 *   2. cancel(childId)：abort controller + onCancel + 移除；未命中返 false。
 *   3. **按 session 隔离 cancel**：两个 Manager 实例（= 两个 session），
 *      cancel 一个不影响另一个。
 *   4. **dispose 取消子**：abort 全部登记中 controller + 清表 + 标 disposed；
 *      dispose 后 registerRun no-op。
 *   5. unregister 句柄引用比对：只删本次登记，不误删同 childId 的重登记。
 *   6. 双写集成：createAgentTool 传入 Manager 时 active 子被登记 / 注销；
 *      模块级 cancelSubagent（W0 链路）行为不受 Manager 影响（回归不变）。
 */

import { describe, it, expect, vi } from 'vitest';
import { SubagentManager } from '../src/session/subagent-manager.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import { createAgentTool, cancelSubagent, getActiveSubagentIds } from '../src/subagent/agent-tool.js';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { createMockPermissionHandler, createMockToolProvider } from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';

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

// ─── 1. 基础登记视图 ──────────────────────────────────────────────────

describe('SubagentManager: 登记视图', () => {
  it('registerRun → list / getStatus / has / size 反映', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1', spaceId: 'space-1' });
    const ctl = new AbortController();
    mgr.registerRun('child-a', ctl, {
      label: '调研',
      startedAt: 111,
      state: 'active',
      parentToolCallId: 'toolu_1',
      resumed: false,
    });

    expect(mgr.size()).toBe(1);
    expect(mgr.has('child-a')).toBe(true);
    expect(mgr.has('child-z')).toBe(false);

    const status = mgr.getStatus('child-a');
    expect(status).toMatchObject({
      childId: 'child-a',
      state: 'active',
      label: '调研',
      startedAt: 111,
      parentToolCallId: 'toolu_1',
      resumed: false,
      cancelled: false,
    });

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.childId).toBe('child-a');
  });

  it('getStatus 未登记 → undefined；cancelled 反映 controller.signal.aborted', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1' });
    expect(mgr.getStatus('nope')).toBeUndefined();

    const ctl = new AbortController();
    mgr.registerRun('child-a', ctl);
    expect(mgr.getStatus('child-a')?.cancelled).toBe(false);
    ctl.abort();
    expect(mgr.getStatus('child-a')?.cancelled).toBe(true);
  });

  it('暴露 parentThreadId / spaceId / budgetTracker 引用', () => {
    const bt = new BudgetTracker();
    const mgr = new SubagentManager({ parentThreadId: 'thread-1', spaceId: 'space-9', budgetTracker: bt });
    expect(mgr.parentThreadId).toBe('thread-1');
    expect(mgr.parentScopeThreadIds).toEqual(['thread-1']);
    expect(mgr.spaceId).toBe('space-9');
    expect(mgr.budgetTracker).toBe(bt);
  });

  it('registerRun 触发 onChildThreadScope，注销 / dispose / 重登记正确释放', () => {
    const onChildThreadScope = vi.fn((input: { childId: string; childThreadId: string }) => {
      expect(input.childThreadId).toBe(`agent-${input.childId}`);
      const release = vi.fn();
      return release;
    });
    const mgr = new SubagentManager({
      parentThreadId: 'parent-session',
      parentScopeThreadIds: ['chat-session-parent', 'parent-session'],
      onChildThreadScope,
    });

    const ctlA = new AbortController();
    const unregisterA = mgr.registerRun('child-a', ctlA);
    expect(onChildThreadScope).toHaveBeenCalledTimes(1);
    const releaseA = onChildThreadScope.mock.results[0]?.value as ReturnType<typeof vi.fn>;

    const ctlB = new AbortController();
    const unregisterB = mgr.registerRun('child-a', ctlB);
    expect(onChildThreadScope).toHaveBeenCalledTimes(2);
    expect(releaseA).toHaveBeenCalledTimes(1);
    const releaseB = onChildThreadScope.mock.results[1]?.value as ReturnType<typeof vi.fn>;

    unregisterA();
    expect(releaseB).not.toHaveBeenCalled();

    unregisterB();
    expect(releaseB).toHaveBeenCalledTimes(1);

    mgr.dispose();
    expect(releaseB).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. cancel ────────────────────────────────────────────────────────

describe('SubagentManager: cancel', () => {
  it('cancel 命中 → abort controller + onCancel + 移除 + 返 true', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1' });
    const ctl = new AbortController();
    const onCancel = vi.fn();
    mgr.registerRun('child-a', ctl, { onCancel });

    const ok = mgr.cancel('child-a');
    expect(ok).toBe(true);
    expect(ctl.signal.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mgr.has('child-a')).toBe(false);
    expect(mgr.size()).toBe(0);
  });

  it('cancel 未命中 → false，不抛', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1' });
    expect(mgr.cancel('ghost')).toBe(false);
  });

  it('onCancel 抛错被吞，不阻断 abort + 移除', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1', log: () => {} });
    const ctl = new AbortController();
    mgr.registerRun('child-a', ctl, { onCancel: () => { throw new Error('boom'); } });
    expect(() => mgr.cancel('child-a')).not.toThrow();
    expect(ctl.signal.aborted).toBe(true);
    expect(mgr.has('child-a')).toBe(false);
  });
});

// ─── 3. session 隔离 ──────────────────────────────────────────────────

describe('SubagentManager: session 隔离', () => {
  it('两个 Manager（两 session）：cancel 一个不影响另一个', () => {
    const mgrA = new SubagentManager({ parentThreadId: 'thread-A' });
    const mgrB = new SubagentManager({ parentThreadId: 'thread-B' });

    const ctlA = new AbortController();
    const ctlB = new AbortController();
    mgrA.registerRun('child-a', ctlA);
    mgrB.registerRun('child-b', ctlB);

    // session A 取消自己的子
    expect(mgrA.cancel('child-a')).toBe(true);
    expect(ctlA.signal.aborted).toBe(true);

    // session B 完全不受影响
    expect(ctlB.signal.aborted).toBe(false);
    expect(mgrB.has('child-b')).toBe(true);
    expect(mgrB.size()).toBe(1);

    // 在 A 里 cancel B 的 childId → 命不中（隔离）
    expect(mgrA.cancel('child-b')).toBe(false);
    expect(ctlB.signal.aborted).toBe(false);
  });

  it('dispose 一个 session 不波及另一个', () => {
    const mgrA = new SubagentManager({ parentThreadId: 'thread-A' });
    const mgrB = new SubagentManager({ parentThreadId: 'thread-B' });
    const ctlA = new AbortController();
    const ctlB = new AbortController();
    mgrA.registerRun('child-a', ctlA);
    mgrB.registerRun('child-b', ctlB);

    mgrA.dispose();
    expect(ctlA.signal.aborted).toBe(true);
    expect(mgrA.isDisposed).toBe(true);
    // B 不受影响
    expect(ctlB.signal.aborted).toBe(false);
    expect(mgrB.isDisposed).toBe(false);
    expect(mgrB.has('child-b')).toBe(true);
  });
});

// ─── 4. dispose ───────────────────────────────────────────────────────

describe('SubagentManager: dispose', () => {
  it('dispose 取消全部登记中子 + 清表 + 标 disposed', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1' });
    const ctl1 = new AbortController();
    const ctl2 = new AbortController();
    const onCancel2 = vi.fn();
    mgr.registerRun('c1', ctl1);
    mgr.registerRun('c2', ctl2, { onCancel: onCancel2 });

    mgr.dispose();
    expect(ctl1.signal.aborted).toBe(true);
    expect(ctl2.signal.aborted).toBe(true);
    expect(onCancel2).toHaveBeenCalledTimes(1);
    expect(mgr.size()).toBe(0);
    expect(mgr.isDisposed).toBe(true);
  });

  it('dispose 幂等', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1' });
    mgr.dispose();
    expect(() => mgr.dispose()).not.toThrow();
    expect(mgr.isDisposed).toBe(true);
  });

  it('dispose 后 registerRun no-op（返回空注销句柄）', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1', log: () => {} });
    mgr.dispose();
    const ctl = new AbortController();
    const unregister = mgr.registerRun('late', ctl);
    expect(mgr.has('late')).toBe(false);
    expect(mgr.size()).toBe(0);
    expect(() => unregister()).not.toThrow();
  });
});

// ─── 5. unregister 引用比对 ───────────────────────────────────────────

describe('SubagentManager: unregister 句柄', () => {
  it('unregister 移除本次登记', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1' });
    const ctl = new AbortController();
    const unregister = mgr.registerRun('child-a', ctl);
    expect(mgr.has('child-a')).toBe(true);
    unregister();
    expect(mgr.has('child-a')).toBe(false);
  });

  it('同 childId 重登记后，旧 unregister 不误删新登记', () => {
    const mgr = new SubagentManager({ parentThreadId: 'thread-1' });
    const ctl1 = new AbortController();
    const ctl2 = new AbortController();
    const unregister1 = mgr.registerRun('child-a', ctl1);
    // 重登记同 childId（如 resume 复用 childId）
    mgr.registerRun('child-a', ctl2);
    // 旧句柄调用——不应删掉新登记（引用比对保护）
    unregister1();
    expect(mgr.has('child-a')).toBe(true);
    expect(mgr.getStatus('child-a')?.cancelled).toBe(false);
    // 现在 cancel 走的是新 controller
    mgr.cancel('child-a');
    expect(ctl2.signal.aborted).toBe(true);
    expect(ctl1.signal.aborted).toBe(false);
  });
});

// ─── 6. 双写集成（agent-tool ↔ Manager） + W0 回归 ────────────────────

function makeHangingProvider() {
  let resolveHang: (() => void) | undefined;
  let rejectHang: ((err: Error) => void) | undefined;
  const provider = {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      await new Promise<void>((resolve, reject) => {
        resolveHang = resolve;
        rejectHang = reject;
      });
      yield { type: 'text_delta' as const, text: 'done' };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return {
    provider,
    // 模拟子正常跑完
    release: () => resolveHang?.(),
    // 模拟 abort 传播到子（子工具 throw "aborted"）—— 与现有 cancel 测试同款
    abort: () => rejectHang?.(new Error('The operation was aborted')),
  };
}

describe('SubagentManager: 双写集成 + W0 回归', () => {
  it('active 子 spawn 时登记进 Manager；完成后注销', async () => {
    const events: StreamEvent[] = [];
    const { provider, release } = makeHangingProvider();
    const manager = new SubagentManager({ parentThreadId: 'test' });

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
      subagentManager: manager,
    });

    const execPromise = tool.execute(
      { prompt: 'long task', description: '后台调研' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const started = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    const childId = started!.payload.subagent_run_id as string;

    // 运行中：Manager 视图里有它
    expect(manager.has(childId)).toBe(true);
    const status = manager.getStatus(childId);
    expect(status?.state).toBe('active');
    expect(status?.label).toBe('后台调研');

    release();
    await execPromise;

    // 完成后：Manager 注销（与模块级 activeChildren 对称）
    expect(manager.has(childId)).toBe(false);
    expect(manager.size()).toBe(0);
  });

  it('W0 回归：Manager 在场时模块级 cancelSubagent 行为不变', async () => {
    const events: StreamEvent[] = [];
    const { provider, abort } = makeHangingProvider();
    const manager = new SubagentManager({ parentThreadId: 'test' });

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
      subagentManager: manager,
    });

    const execPromise = tool.execute(
      { prompt: 'cancel me' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    await new Promise((r) => setTimeout(r, 50));
    const childId = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED)!
      .payload.subagent_run_id as string;

    // 模块级 W0 取消路径仍生效（cancelSubagent 走 activeChildren，与 Manager 正交）
    expect(getActiveSubagentIds()).toContain(childId);
    expect(cancelSubagent(childId)).toBe(true);

    abort();
    const result = await execPromise;
    expect(result.isError).toBe(true);

    // 两个登记表都清掉了
    expect(getActiveSubagentIds()).not.toContain(childId);
    expect(manager.has(childId)).toBe(false);
  });

  it('manager.dispose() 取消运行中的后台子（active controller 被 abort）', async () => {
    const events: StreamEvent[] = [];
    const { provider, abort } = makeHangingProvider();
    const manager = new SubagentManager({ parentThreadId: 'test' });

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
      subagentManager: manager,
    });

    const execPromise = tool.execute(
      { prompt: 'dispose me' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    await new Promise((r) => setTimeout(r, 50));
    const childId = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED)!
      .payload.subagent_run_id as string;
    expect(manager.has(childId)).toBe(true);

    // dispose → abort 该子的 timeoutController → forkQuery 应被中断
    manager.dispose();
    expect(manager.isDisposed).toBe(true);
    // dispose 已从 Manager 登记表移除该子
    expect(manager.has(childId)).toBe(false);

    // 模拟 abort 传播到子工具（子 throw aborted）
    abort();
    const result = await execPromise;
    // 子被 abort → isError（终止）。error_kind 细分类属后续 PR（S4 按子 controller 判）。
    expect(result.isError).toBe(true);
  });
});
