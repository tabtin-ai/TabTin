/**
 * SubagentManager S3-S5 单测（W4a PR2，2026-05-30）。
 *
 * 覆盖 PR2 给 Manager 新增的能力：
 *   S3：rebindLiveDeps / resolveLiveDeps / getLiveDeps —— live 依赖重绑 + 失败语义。
 *   S4：spawnBackground / hasBackgroundRuns —— 后台子登记 + carry-forward 判据。
 *   S5：notifyCompleted —— 完成回调投递句柄。
 */

import { describe, it, expect, vi } from 'vitest';
import { SubagentManager } from '../src/session/subagent-manager.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  SubagentLiveDeps,
  SubagentCompletionInfo,
} from '../src/session/subagent-manager.js';

function makeLiveDeps(over: Partial<SubagentLiveDeps> = {}): SubagentLiveDeps {
  return {
    budgetTracker: new BudgetTracker(),
    emitStreamEvent: vi.fn(),
    waitForUserInput: vi.fn(async () => ({})),
    userInteractiveChannel: { requestApprovalsBatch: vi.fn() } as unknown as SubagentLiveDeps['userInteractiveChannel'],
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: vi.fn() } as never,
    }),
    osErrorBlacklist: { has: vi.fn() } as unknown as SubagentLiveDeps['osErrorBlacklist'],
    ...over,
  };
}

function completionInfo(over: Partial<SubagentCompletionInfo> = {}): SubagentCompletionInfo {
  return {
    subagent_run_id: 'child-1',
    label: '后台调研',
    status: 'completed',
    summary: '已完成',
    duration_ms: 1234,
    step_count: 3,
    ...over,
  };
}

// ─── S3：rebindLiveDeps / resolveLiveDeps / getLiveDeps ───────────────

describe('SubagentManager S3: live 依赖重绑定', () => {
  it('rebindLiveDeps 后 resolveLiveDeps 返回 {ok,deps}；getLiveDeps 同源', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    const deps = makeLiveDeps();
    mgr.rebindLiveDeps(deps);

    const r = mgr.resolveLiveDeps();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deps).toBe(deps);
    expect(mgr.getLiveDeps()).toBe(deps);
  });

  it('未 rebind（未 dispose）→ resolveLiveDeps {ok:true, deps:undefined}（回落 config）', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    const r = mgr.resolveLiveDeps();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deps).toBeUndefined();
    expect(mgr.getLiveDeps()).toBeUndefined();
  });

  it('dispose 后 resolveLiveDeps → {ok:false}（显式报错，禁止 fail-closed deny）', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    mgr.rebindLiveDeps(makeLiveDeps());
    mgr.dispose();

    const r = mgr.resolveLiveDeps();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('会话环境已失效');
    expect(mgr.getLiveDeps()).toBeUndefined();
  });

  it('rebindLiveDeps after dispose 是 no-op', () => {
    const mgr = new SubagentManager({ parentThreadId: 't', log: () => {} });
    mgr.dispose();
    mgr.rebindLiveDeps(makeLiveDeps());
    expect(mgr.getLiveDeps()).toBeUndefined();
    expect(mgr.resolveLiveDeps().ok).toBe(false);
  });

  it('rebindLiveDeps 跨重建覆盖旧依赖（换新 budgetTracker）', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    const bt1 = new BudgetTracker();
    const bt2 = new BudgetTracker();
    mgr.rebindLiveDeps(makeLiveDeps({ budgetTracker: bt1 }));
    expect(mgr.getLiveDeps()?.budgetTracker).toBe(bt1);
    // runtime 重建 → 新 tracker 重绑
    mgr.rebindLiveDeps(makeLiveDeps({ budgetTracker: bt2 }));
    expect(mgr.getLiveDeps()?.budgetTracker).toBe(bt2);
  });
});

// ─── S4：spawnBackground / hasBackgroundRuns ──────────────────────────

describe('SubagentManager S4: 后台子登记', () => {
  it('spawnBackground 登记 background=true；hasBackgroundRuns 反映', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    const ctl = new AbortController();
    mgr.spawnBackground('bg-1', ctl, { label: '后台', startedAt: 1 });

    expect(mgr.has('bg-1')).toBe(true);
    expect(mgr.getStatus('bg-1')?.background).toBe(true);
    expect(mgr.hasBackgroundRuns()).toBe(true);
  });

  it('前台 registerRun 不计入 hasBackgroundRuns', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    mgr.registerRun('fg-1', new AbortController());
    expect(mgr.getStatus('fg-1')?.background).toBeUndefined();
    expect(mgr.hasBackgroundRuns()).toBe(false);
  });

  it('后台子注销后 hasBackgroundRuns 回 false', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    const unregister = mgr.spawnBackground('bg-1', new AbortController());
    expect(mgr.hasBackgroundRuns()).toBe(true);
    unregister();
    expect(mgr.hasBackgroundRuns()).toBe(false);
  });

  it('dispose 取消后台子的 controller（host.stop / reset 真销毁场景）', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    const ctl = new AbortController();
    mgr.spawnBackground('bg-1', ctl);
    mgr.dispose();
    expect(ctl.signal.aborted).toBe(true);
  });
});

// ─── S5：notifyCompleted ──────────────────────────────────────────────

describe('SubagentManager S5: 完成回调投递', () => {
  it('notifyCompleted 调 host 注入的 enqueueNotification，传 info，返回其结果', () => {
    const enqueueNotification = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification });
    const info = completionInfo();
    expect(mgr.notifyCompleted(info)).toBe(true);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification).toHaveBeenCalledWith(info);
  });

  it('未注入 enqueueNotification → no-op 返 false', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    expect(mgr.notifyCompleted(completionInfo())).toBe(false);
  });

  it('dispose 后 notifyCompleted → false（句柄随 session 失效）', () => {
    const enqueueNotification = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification });
    mgr.dispose();
    expect(mgr.notifyCompleted(completionInfo())).toBe(false);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('enqueueNotification 抛错被吞 → false（不外抛）', () => {
    const mgr = new SubagentManager({
      parentThreadId: 't',
      log: () => {},
      enqueueNotification: () => { throw new Error('queue down'); },
    });
    expect(() => mgr.notifyCompleted(completionInfo())).not.toThrow();
    expect(mgr.notifyCompleted(completionInfo())).toBe(false);
  });

  it('rebindLiveDeps 可刷新 enqueueNotification（reuse 同 Manager 跨重建）', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification: first });
    mgr.rebindLiveDeps(makeLiveDeps(), second);
    mgr.notifyCompleted(completionInfo());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('SubagentManager: 后台完成等待屏障', () => {
  it('全部子任务终态前暂存通知，齐备后按登记顺序一次性释放', () => {
    const enqueueNotification = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification });
    mgr.spawnBackground('child-1', new AbortController());
    mgr.spawnBackground('child-2', new AbortController());
    expect(mgr.hasCompletionBarriers()).toBe(false);

    expect(mgr.armCompletionBarrier(['child-1', 'child-2'])).toEqual({
      ok: true,
      waitToolCallId: '__legacy_wait_tool_call__',
      childIds: ['child-1', 'child-2'],
      pendingChildIds: ['child-1', 'child-2'],
      completions: [],
    });
    expect(mgr.hasCompletionBarriers()).toBe(true);
    expect(mgr.notifyCompleted(completionInfo({
      subagent_run_id: 'child-2',
      summary: '第二项',
    }))).toBe(true);
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(mgr.hasCompletionBarriers()).toBe(true);

    expect(mgr.notifyCompleted(completionInfo({
      subagent_run_id: 'child-1',
      summary: '第一项',
    }))).toBe(true);
    expect(mgr.hasCompletionBarriers()).toBe(false);
    expect(enqueueNotification).toHaveBeenCalledTimes(2);
    expect(enqueueNotification.mock.calls.map(([info]) => info.subagent_run_id)).toEqual([
      'child-1',
      'child-2',
    ]);
  });

  it('已终态目标视为满足，只把仍运行目标写入 pending', () => {
    const enqueueNotification = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification });
    const unregister1 = mgr.spawnBackground('child-1', new AbortController());
    mgr.spawnBackground('child-2', new AbortController());
    const completed = completionInfo({
      subagent_run_id: 'child-1',
      summary: '第一项已提前完成',
    });

    expect(mgr.notifyCompleted(completed)).toBe(true);
    unregister1();

    expect(mgr.armCompletionBarrier(['child-2', 'child-1'])).toEqual({
      ok: true,
      waitToolCallId: '__legacy_wait_tool_call__',
      childIds: ['child-1', 'child-2'],
      pendingChildIds: ['child-2'],
      completions: [completed],
    });
    expect(mgr.isAwaitingCompletion('child-1')).toBe(false);
    expect(mgr.isAwaitingCompletion('child-2')).toBe(true);
  });

  it('目标均已终态时立即满足，不留下活动屏障', () => {
    const enqueueNotification = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification });
    const unregister1 = mgr.spawnBackground('child-1', new AbortController());
    const unregister2 = mgr.spawnBackground('child-2', new AbortController());
    const first = completionInfo({ subagent_run_id: 'child-1' });
    const second = completionInfo({ subagent_run_id: 'child-2' });

    mgr.notifyCompleted(first);
    unregister1();
    mgr.notifyCompleted(second);
    unregister2();

    expect(mgr.armCompletionBarrier(['child-2', 'child-1'])).toEqual({
      ok: true,
      waitToolCallId: '__legacy_wait_tool_call__',
      childIds: ['child-1', 'child-2'],
      pendingChildIds: [],
      completions: [first, second],
    });
    expect(mgr.isAwaitingCompletion('child-1')).toBe(false);
    expect(mgr.cancelCompletionBarrier()).toBe(false);
  });

  it('活动屏障缓存非目标完成，目标齐备后按目标优先顺序一起释放', () => {
    const enqueueNotification = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification });
    mgr.spawnBackground('child-a', new AbortController());
    mgr.spawnBackground('child-b', new AbortController());
    mgr.spawnBackground('child-c', new AbortController());

    expect(mgr.armCompletionBarrier(['child-b', 'child-a']).ok).toBe(true);
    mgr.notifyCompleted(completionInfo({ subagent_run_id: 'child-c' }));
    mgr.notifyCompleted(completionInfo({ subagent_run_id: 'child-b' }));
    expect(enqueueNotification).not.toHaveBeenCalled();

    mgr.notifyCompleted(completionInfo({ subagent_run_id: 'child-a' }));

    expect(enqueueNotification.mock.calls.map(([info]) => info.subagent_run_id)).toEqual([
      'child-a',
      'child-b',
      'child-c',
    ]);
  });

  it('同一目标集合顺序不同仍命中幂等屏障', () => {
    const mgr = new SubagentManager({
      parentThreadId: 't',
      enqueueNotification: () => true,
    });
    mgr.spawnBackground('child-a', new AbortController());
    mgr.spawnBackground('child-b', new AbortController());

    expect(mgr.armCompletionBarrier(['child-a', 'child-b']).ok).toBe(true);
    expect(mgr.armCompletionBarrier(['child-b', 'child-a'])).toMatchObject({
      ok: true,
      childIds: ['child-a', 'child-b'],
      pendingChildIds: ['child-a', 'child-b'],
    });
  });

  it('未提交挂起时撤销屏障，释放缓存并恢复后续逐条通知', () => {
    const enqueueNotification = vi.fn(() => true);
    const mgr = new SubagentManager({ parentThreadId: 't', enqueueNotification });
    mgr.spawnBackground('child-a', new AbortController());
    mgr.spawnBackground('child-c', new AbortController());
    mgr.armCompletionBarrier(['child-a']);
    expect(mgr.hasCompletionBarriers()).toBe(true);
    mgr.notifyCompleted(completionInfo({ subagent_run_id: 'child-c' }));

    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(mgr.cancelCompletionBarrier()).toBe(true);
    expect(mgr.hasCompletionBarriers()).toBe(false);
    expect(enqueueNotification.mock.calls.map(([info]) => info.subagent_run_id)).toEqual([
      'child-c',
    ]);

    mgr.notifyCompleted(completionInfo({ subagent_run_id: 'child-a' }));
    expect(enqueueNotification.mock.calls.map(([info]) => info.subagent_run_id)).toEqual([
      'child-c',
      'child-a',
    ]);
  });

  it('拒绝不存在、前台或同一等待工具调用内冲突的子任务，但允许不同等待并存', () => {
    const mgr = new SubagentManager({
      parentThreadId: 't',
      enqueueNotification: () => true,
    });
    mgr.registerRun('foreground', new AbortController());
    mgr.spawnBackground('background-1', new AbortController());
    mgr.spawnBackground('background-2', new AbortController());

    expect(mgr.armCompletionBarrier(['missing']).ok).toBe(false);
    expect(mgr.armCompletionBarrier(['foreground']).ok).toBe(false);
    expect(mgr.armCompletionBarrier('wait-a', ['background-1']).ok).toBe(true);
    expect(mgr.armCompletionBarrier('wait-a', ['background-2'])).toMatchObject({
      ok: false,
      reason: '当前等待工具调用已经绑定另一组后台子 Agent，请等待现有完成通知。',
    });
    expect(mgr.armCompletionBarrier('wait-b', ['background-2'])).toMatchObject({
      ok: true,
      waitToolCallId: 'wait-b',
      childIds: ['background-2'],
      pendingChildIds: ['background-2'],
    });
  });

  it('宿主没有完成通知队列时拒绝进入等待，避免永久挂起', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    mgr.spawnBackground('background-1', new AbortController());

    expect(mgr.armCompletionBarrier(['background-1'])).toEqual({
      ok: false,
      reason: '当前宿主未配置子任务完成通知，无法进入后台等待。',
    });
  });
});
