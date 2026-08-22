/**
 * PRD §5.1.3：BudgetTracker scheduler 扩展——trySubmit / onActivate /
 * releaseChildAgent / cancelAllByParent / getSchedulerStats 测试。
 *
 * 覆盖：
 *   1. trySubmit → active / queued / rejected 三种状态
 *   2. releaseChildAgent 后 queue 里的下一个被激活
 *   3. cancelAllByParent 清空 active + queue + 触发 pending callback
 *   4. getSchedulerStats 正确
 *   5. trySubmit 幂等（重复 speakerId）
 *   6. budget exhausted 时 rejected + queue flush
 *   7. Infinity 模式下 trySubmit 始终 active
 *   8. maxQueueSize 默认值（W4: 95）与边界
 *   9. releaseChildAgent 从 queue 移除（非 active）
 *
 * W4 (2026-05-26) 删除：「旧 acquireChildSlot / releaseChildSlot 行为兼容」
 * 三个用例随 deprecated API 一起清掉（C6 不留兼容）；trySubmit 已是唯一入口。
 */

import { describe, expect, it, vi } from 'vitest';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';

describe('BudgetTracker scheduler (PRD §5.1.3)', () => {
  // ─── trySubmit 三种状态 ─────────────────────────────────────────

  it('trySubmit: active 当 active pool 有空位', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 3, maxQueueSize: 5 });
    const r = bt.trySubmit({ speakerId: 'a1' });
    expect(r.accepted).toBe(true);
    expect(r.state).toBe('active');
  });

  it('trySubmit: queued 当 active pool 满但 queue 有空位', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 2, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    const r = bt.trySubmit({ speakerId: 'a3' });
    expect(r.accepted).toBe(true);
    expect(r.state).toBe('queued');
  });

  it('trySubmit: rejected (queue_full) 当 active 和 queue 都满', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 1 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    const r = bt.trySubmit({ speakerId: 'a3' });
    expect(r.accepted).toBe(false);
    expect(r.state).toBe('rejected');
    expect(r.reason).toBe('queue_full');
  });

  it('trySubmit: rejected (budget_exhausted) 当 token 耗尽', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 100, maxConcurrentChildren: 5 });
    bt.recordUsage(60, 50);
    const r = bt.trySubmit({ speakerId: 'a1' });
    expect(r.accepted).toBe(false);
    expect(r.state).toBe('rejected');
    expect(r.reason).toBe('budget_exhausted');
  });

  it('trySubmit: rejected (budget_exhausted) 当 credits 耗尽', () => {
    const bt = new BudgetTracker({ maxCredits: 1.0, maxConcurrentChildren: 5 });
    bt.recordRequest({ inputTokens: 10, outputTokens: 10, costUsd: 1.5 });
    const r = bt.trySubmit({ speakerId: 'a1' });
    expect(r.accepted).toBe(false);
    expect(r.state).toBe('rejected');
    expect(r.reason).toBe('budget_exhausted');
  });

  // ─── trySubmit 幂等 ─────────────────────────────────────────────

  it('trySubmit: 同一 speakerId 重复提交到 active 幂等', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 2, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    const r = bt.trySubmit({ speakerId: 'a1' });
    expect(r.accepted).toBe(true);
    expect(r.state).toBe('active');
    expect(bt.getSchedulerStats().activeCount).toBe(1);
  });

  it('trySubmit: 同一 speakerId 重复提交到 queue 幂等', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    const r = bt.trySubmit({ speakerId: 'a2' });
    expect(r.accepted).toBe(true);
    expect(r.state).toBe('queued');
    expect(bt.getSchedulerStats().queuedCount).toBe(1);
  });

  // ─── releaseChildAgent + queue drain ────────────────────────────

  it('releaseChildAgent 后 queue 里的下一个被激活', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.trySubmit({ speakerId: 'a3' });

    const cb2 = vi.fn();
    const cb3 = vi.fn();
    bt.onActivate('a2', cb2);
    bt.onActivate('a3', cb3);

    bt.releaseChildAgent('a1');
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).not.toHaveBeenCalled();
    expect(bt.getSchedulerStats().activeCount).toBe(1);
    expect(bt.getSchedulerStats().queuedCount).toBe(1);

    bt.releaseChildAgent('a2');
    expect(cb3).toHaveBeenCalledOnce();
    expect(bt.getSchedulerStats().activeCount).toBe(1);
    expect(bt.getSchedulerStats().queuedCount).toBe(0);
  });

  it('releaseChildAgent: queue 为空时不报错', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 2, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.releaseChildAgent('a1');
    expect(bt.getSchedulerStats().activeCount).toBe(0);
    expect(bt.getSchedulerStats().queuedCount).toBe(0);
  });

  it('releaseChildAgent: 释放不存在的 speakerId 是 no-op', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 2, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.releaseChildAgent('non-existent');
    expect(bt.getSchedulerStats().activeCount).toBe(1);
  });

  it('releaseChildAgent: 从 queue 移除非 active 的 speakerId', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.trySubmit({ speakerId: 'a3' });
    expect(bt.getSchedulerStats().queuedCount).toBe(2);

    bt.releaseChildAgent('a2');
    expect(bt.getSchedulerStats().queuedCount).toBe(1);
    expect(bt.getSchedulerStats().activeCount).toBe(1);
  });

  // ─── W4 三视角 review P0-A 回归（2026-05-26）────────────────────
  //
  // 历史 bug：releaseChildAgent 在 queue 命中路径只 delete callback 不 invoke
  // → agent-tool `await new Promise<void>((resolve) => onActivate(id, resolve))`
  // 永远 pending → tool execute hang。修复后语义：queued speaker 被
  // releaseChildAgent 时同样 invoke callback 让 await resolve（与 cancelQueued
  // 对 queued 的行为一致）。

  it('releaseChildAgent on queued speaker invokes callback (W4 P0-A)', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.trySubmit({ speakerId: 'a3' });

    const cb2 = vi.fn();
    const cb3 = vi.fn();
    bt.onActivate('a2', cb2);
    bt.onActivate('a3', cb3);

    bt.releaseChildAgent('a2');
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).not.toHaveBeenCalled();
    expect(bt.getSchedulerStats().activeCount).toBe(1);
    expect(bt.getSchedulerStats().queuedCount).toBe(1);
  });

  it('releaseChildAgent on active speaker 仍然 drainQueue（不影响 active 路径行为）', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });

    const cb2 = vi.fn();
    bt.onActivate('a2', cb2);

    bt.releaseChildAgent('a1');
    expect(cb2).toHaveBeenCalledOnce();
    expect(bt.getSchedulerStats().activeCount).toBe(1);
  });

  // ─── cancelAllByParent ──────────────────────────────────────────

  it('cancelAllByParent 清空 active + queue', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.trySubmit({ speakerId: 'a3' });

    bt.cancelAllByParent();

    const stats = bt.getSchedulerStats();
    expect(stats.activeCount).toBe(0);
    expect(stats.queuedCount).toBe(0);
  });

  it('cancelAllByParent 触发 pending onActivate 回调（避免 Promise 永挂）', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });

    const cb = vi.fn();
    bt.onActivate('a2', cb);

    bt.cancelAllByParent();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('cancelAllByParent 后可以重新 trySubmit', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 2 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.trySubmit({ speakerId: 'a3' });
    expect(bt.trySubmit({ speakerId: 'a4' }).state).toBe('rejected');

    bt.cancelAllByParent();

    const r = bt.trySubmit({ speakerId: 'b1' });
    expect(r.accepted).toBe(true);
    expect(r.state).toBe('active');
  });

  // ─── budget exhausted 后 queue flush ────────────────────────────

  it('budget 耗尽后 drain 触发 queue 全部 callback 并清空', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 200, maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.trySubmit({ speakerId: 'a3' });

    const cb2 = vi.fn();
    const cb3 = vi.fn();
    bt.onActivate('a2', cb2);
    bt.onActivate('a3', cb3);

    bt.recordUsage(150, 60);

    bt.releaseChildAgent('a1');
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).toHaveBeenCalledOnce();
    expect(bt.getSchedulerStats().queuedCount).toBe(0);
    expect(bt.getSchedulerStats().activeCount).toBe(0);
  });

  // ─── isActiveChild（W-H③，2026-05-30）────────────────────────────
  //
  // agent-tool 的 queued 子在 `await onActivate` resolve 后用 isActiveChild 区分
  // "真激活"（_drainQueue 先 add active 再 resolve → true）与"budget 耗尽假唤醒"
  // （_flushQueueCallbacks 只 resolve 不 add → false）。

  it('isActiveChild: active 子返回 true，queued 子返回 false', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' }); // active
    bt.trySubmit({ speakerId: 'a2' }); // queued
    expect(bt.isActiveChild('a1')).toBe(true);
    expect(bt.isActiveChild('a2')).toBe(false);
    expect(bt.isActiveChild('never-seen')).toBe(false);
  });

  it('isActiveChild: 真激活（drain 正常分支）后队首变 true', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.onActivate('a2', () => {});
    expect(bt.isActiveChild('a2')).toBe(false);
    bt.releaseChildAgent('a1'); // drain（未耗尽）→ a2 真激活
    expect(bt.isActiveChild('a2'), 'drain 正常分支应先 add active').toBe(true);
  });

  it('isActiveChild: budget 耗尽 flush 唤醒后队列子仍为 false（假唤醒可检测）', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5, maxTotalTokens: 200 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    let woke = false;
    bt.onActivate('a2', () => { woke = true; });

    bt.recordUsage(150, 60); // 耗尽
    bt.releaseChildAgent('a1'); // drain → isExhausted → _flushQueueCallbacks

    expect(woke, 'flush 应 resolve callback 让 await unblock').toBe(true);
    expect(bt.isActiveChild('a2'), 'flush 唤醒不算真激活 → 仍 false').toBe(false);
  });

  // ─── getSchedulerStats ──────────────────────────────────────────

  it('getSchedulerStats 返回正确值', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 3, maxQueueSize: 10 });
    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    bt.trySubmit({ speakerId: 'a3' });
    bt.trySubmit({ speakerId: 'a4' });

    const stats = bt.getSchedulerStats();
    expect(stats.activeCount).toBe(3);
    expect(stats.queuedCount).toBe(1);
    expect(stats.maxActive).toBe(3);
    expect(stats.maxQueue).toBe(10);
  });

  // ─── Infinity 模式 ─────────────────────────────────────────────

  it('Infinity 模式下 trySubmit 始终 active', () => {
    const bt = new BudgetTracker();
    for (let i = 0; i < 100; i++) {
      const r = bt.trySubmit({ speakerId: `s-${i}` });
      expect(r.accepted).toBe(true);
      expect(r.state).toBe('active');
    }
    expect(bt.getSchedulerStats().activeCount).toBe(0);
    expect(bt.getSchedulerStats().queuedCount).toBe(0);
  });

  it('Infinity 模式下 releaseChildAgent 是 no-op', () => {
    const bt = new BudgetTracker();
    bt.trySubmit({ speakerId: 'a1' });
    bt.releaseChildAgent('a1');
    expect(bt.getSchedulerStats().activeCount).toBe(0);
  });

  // ─── maxQueueSize 默认值与边界 ──────────────────────────────────

  it('maxQueueSize 默认 95 (W4)', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1 });
    expect(bt.getSchedulerStats().maxQueue).toBe(95);
  });

  it('maxQueueSize 负值 fallback 95 (W4)', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: -1 });
    expect(bt.getSchedulerStats().maxQueue).toBe(95);
  });

  it('maxQueueSize=0 允许零队列', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 0 });
    bt.trySubmit({ speakerId: 'a1' });
    const r = bt.trySubmit({ speakerId: 'a2' });
    expect(r.state).toBe('rejected');
    expect(r.reason).toBe('queue_full');
  });

  // ─── ：并发槽位按嵌套深度分池（防父占槽等子死锁）──────
  //
  // 修前：全树单池——5 个 L1（depth=1）占满 5 槽后前台 await 各自的 L2
  // （depth=2），L2 全部 queued 等 L1 释放槽 → 循环等待永久死锁。
  // 修后：depth 1 / depth 2 各一池（各 maxConcurrentChildren 上限），父等子
  // 不与子竞争槽位；depth 缺省归池 1（旧调用方行为不变，上方全部用例即证）。

  it('#3300: depth-1 池满时 depth-2 提交仍直接 active（不排队）', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 5, maxQueueSize: 95 });
    for (let i = 0; i < 5; i++) {
      expect(bt.trySubmit({ speakerId: `L1-${i}`, depth: 1 }).state).toBe('active');
    }
    // 死锁场景还原：5 个 L1 各再提交 1 个 L2——修前全 queued，修后全 active
    for (let i = 0; i < 5; i++) {
      expect(bt.trySubmit({ speakerId: `L2-${i}`, depth: 2 }).state).toBe('active');
    }
    expect(bt.getSchedulerStats().activeCount).toBe(10);
    expect(bt.getSchedulerStats().queuedCount).toBe(0);
  });

  it('#3300: 各深度池独立计数，第 6 个同深度提交才排队', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 5, maxQueueSize: 95 });
    for (let i = 0; i < 5; i++) bt.trySubmit({ speakerId: `L1-${i}`, depth: 1 });
    for (let i = 0; i < 5; i++) bt.trySubmit({ speakerId: `L2-${i}`, depth: 2 });
    expect(bt.trySubmit({ speakerId: 'L1-extra', depth: 1 }).state).toBe('queued');
    expect(bt.trySubmit({ speakerId: 'L2-extra', depth: 2 }).state).toBe('queued');
  });

  it('#3300: release 只 drain 匹配深度池的排队者（跳过队首的满池深度）', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'a1', depth: 1 }); // depth-1 active
    bt.trySubmit({ speakerId: 'b1', depth: 2 }); // depth-2 active
    bt.trySubmit({ speakerId: 'a2', depth: 1 }); // depth-1 queued（队首）
    bt.trySubmit({ speakerId: 'b2', depth: 2 }); // depth-2 queued

    const cbA2 = vi.fn();
    const cbB2 = vi.fn();
    bt.onActivate('a2', cbA2);
    bt.onActivate('b2', cbB2);

    // 释放 depth-2 slot → 应激活 b2（跳过队首 a2，它的 depth-1 池仍满）
    bt.releaseChildAgent('b1');
    expect(cbB2).toHaveBeenCalledOnce();
    expect(cbA2).not.toHaveBeenCalled();
    expect(bt.isActiveChild('b2')).toBe(true);

    // 释放 depth-1 slot → a2 激活
    bt.releaseChildAgent('a1');
    expect(cbA2).toHaveBeenCalledOnce();
    expect(bt.isActiveChild('a2')).toBe(true);
  });

  it('#3300: depth 缺省 / 非法值归入池 1（向后兼容）', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    expect(bt.trySubmit({ speakerId: 'no-depth' }).state).toBe('active');
    // 与缺省同池：池 1 已满 → 排队
    expect(bt.trySubmit({ speakerId: 'zero-depth', depth: 0 }).state).toBe('queued');
    expect(bt.trySubmit({ speakerId: 'nan-depth', depth: Number.NaN }).state).toBe('queued');
  });

  // ─── trySubmit 是同步函数（不返回 Promise）────────────────────

  it('trySubmit 是同步函数', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 5 });
    const result = bt.trySubmit({ speakerId: 'a1' });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.state).toBe('active');
  });

  it('releaseChildAgent 是同步函数', () => {
    const bt = new BudgetTracker({ maxConcurrentChildren: 5 });
    bt.trySubmit({ speakerId: 'a1' });
    const result = bt.releaseChildAgent('a1');
    expect(result).not.toBeInstanceOf(Promise);
  });
});
