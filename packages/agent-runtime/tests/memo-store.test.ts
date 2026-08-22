/**
 * `InMemoryApprovalMemoStore` 单元测试（PRD 05 v0.4 §7.3 / §8.1.2）。
 *
 * 覆盖矩阵：
 *   1. 构造时 initialAlways / initialGeneration 注入
 *   2. getAlways / putAlways 命中 + 写入
 *   3. getThread / putThread 命中 + 写入；clearThread 清 thread 不影响 always
 *   4. putAlways 触发 commitAlways 回调（fire-and-forget）
 *   5. commitAlways 抛错 → onCommitError 兜底，不污染 store
 *   6. commitAlways 返回 Promise reject → onCommitError 兜底
 *   7. maybeRefetch：server generation > local → 调 refetchAll + replaceAll
 *   8. maybeRefetch：server generation <= local → no-op
 *   9. maybeRefetch：无 refetch 回调 → 仅更新 generation（fallback）
 *   10. replaceAll 全量替换 always；thread 不动；generation 同步
 */

import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryApprovalMemoStore,
  applyCancelledByRollbackToHitl,
} from '../src/permissions/memo-store.js';
import type { ApprovalMemoEntry } from '../src/permissions/types.js';

function entry(decision: 'allow' | 'deny' = 'allow'): ApprovalMemoEntry {
  const now = Date.now();
  return {
    decision,
    createdAt: now,
    updatedAt: now,
    approverUserId: 'user-1',
  };
}

describe('InMemoryApprovalMemoStore', () => {
  it('1. constructor injects initial entries + generation', () => {
    const store = new InMemoryApprovalMemoStore({
      initialAlways: { 'ns::bash::npm install': entry('allow') },
      initialGeneration: 42,
    });
    expect(store.generation).toBe(42);
    expect(store.getAlways('ns::bash::npm install')?.decision).toBe('allow');
    expect(store.getAlways('miss')).toBeNull();
  });

  it('2. getAlways / putAlways round-trip', () => {
    const store = new InMemoryApprovalMemoStore();
    expect(store.getAlways('k')).toBeNull();
    store.putAlways('k', entry('deny'));
    expect(store.getAlways('k')?.decision).toBe('deny');
  });

  it('3. thread isolation: clearThread does not affect always', () => {
    const store = new InMemoryApprovalMemoStore();
    store.putAlways('a', entry('allow'));
    store.putThread('t', entry('allow'));
    expect(store.getThread('t')).not.toBeNull();

    store.clearThread();
    expect(store.getThread('t')).toBeNull();
    expect(store.getAlways('a')?.decision).toBe('allow');
  });

  it('4. putAlways triggers commitAlways callback', async () => {
    const commit = vi.fn();
    const store = new InMemoryApprovalMemoStore({ commitAlways: commit });
    store.putAlways('k', entry('allow'));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('k', expect.objectContaining({ decision: 'allow' }));
    expect(store.getAlways('k')?.decision).toBe('allow');
  });

  it('5. commitAlways throws sync → onCommitError, store still updated', () => {
    const onErr = vi.fn();
    const store = new InMemoryApprovalMemoStore({
      commitAlways: () => {
        throw new Error('boom');
      },
      onCommitError: onErr,
    });
    expect(() => store.putAlways('k', entry('allow'))).not.toThrow();
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(store.getAlways('k')?.decision).toBe('allow');
  });

  it('6. commitAlways async reject → onCommitError catches', async () => {
    const onErr = vi.fn();
    const store = new InMemoryApprovalMemoStore({
      commitAlways: async () => {
        throw new Error('async-boom');
      },
      onCommitError: onErr,
    });
    store.putAlways('k', entry('allow'));
    // 等微任务消化 promise reject
    await new Promise((r) => setImmediate(r));
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(store.getAlways('k')?.decision).toBe('allow');
  });

  it('7. maybeRefetch: server generation > local → invokes refetchAll', async () => {
    const refetch = vi.fn(async () => ({
      entries: { 'ns::bash::ls': entry('allow') },
      generation: 5,
    }));
    const store = new InMemoryApprovalMemoStore({
      initialGeneration: 1,
      refetchAll: refetch,
    });

    const did = await store.maybeRefetch(5);
    expect(did).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(store.generation).toBe(5);
    expect(store.getAlways('ns::bash::ls')?.decision).toBe('allow');
  });

  it('8. maybeRefetch: server <= local → no-op', async () => {
    const refetch = vi.fn();
    const store = new InMemoryApprovalMemoStore({
      initialGeneration: 5,
      refetchAll: refetch,
    });
    expect(await store.maybeRefetch(5)).toBe(false);
    expect(await store.maybeRefetch(3)).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('9. maybeRefetch without refetchAll callback: just bumps generation', async () => {
    const store = new InMemoryApprovalMemoStore({ initialGeneration: 1 });
    expect(await store.maybeRefetch(7)).toBe(false);
    expect(store.generation).toBe(7);
  });

  it('10. replaceAll replaces always but preserves thread', () => {
    const store = new InMemoryApprovalMemoStore({
      initialAlways: { old: entry('allow') },
      initialGeneration: 1,
    });
    store.putThread('t', entry('allow'));

    store.replaceAll({ new1: entry('deny'), new2: entry('allow') }, 99);
    expect(store.generation).toBe(99);
    expect(store.getAlways('old')).toBeNull();
    expect(store.getAlways('new1')?.decision).toBe('deny');
    expect(store.getAlways('new2')?.decision).toBe('allow');
    expect(store.getThread('t')?.decision).toBe('allow');
    expect(store.__debugThreadSize()).toBe(1);
  });

  // ─── bootstrap (W2-轮 2) ────────────────────────────────────────
  // bootstrap 是 host 装配完 store 后**主动**拉一次 server snapshot 的入口；
  // 跟 maybeRefetch 区别在于不依赖 generation 比对。

  it('11. bootstrap success: invokes refetchAll + replaceAll', async () => {
    const refetch = vi.fn(async () => ({
      entries: { 'ns::tool::k1': entry('allow') },
      generation: 3,
    }));
    const store = new InMemoryApprovalMemoStore({
      initialGeneration: 0,
      refetchAll: refetch,
    });
    const ok = await store.bootstrap();
    expect(ok).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(store.generation).toBe(3);
    expect(store.getAlways('ns::tool::k1')?.decision).toBe('allow');
  });

  it('12. bootstrap without refetchAll: returns false fail-soft', async () => {
    const store = new InMemoryApprovalMemoStore({ initialGeneration: 0 });
    expect(await store.bootstrap()).toBe(false);
    expect(store.generation).toBe(0);
  });

  it('13. bootstrap when refetch throws: fails fail-soft + onCommitError', async () => {
    const onErr = vi.fn();
    const store = new InMemoryApprovalMemoStore({
      refetchAll: async () => {
        throw new Error('network down');
      },
      onCommitError: onErr,
    });
    expect(await store.bootstrap()).toBe(false);
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(onErr.mock.calls[0]?.[1]).toBe('__bootstrap__');
    expect(store.generation).toBe(0);
  });

  it('14. bootstrap then commit: commit reads new generation', async () => {
    let gen = 0;
    const commit = vi.fn(() => {
      // commit 调用时已知 server gen
      gen += 1;
    });
    const refetch = vi.fn(async () => ({ entries: {}, generation: 7 }));
    const store = new InMemoryApprovalMemoStore({
      commitAlways: commit,
      refetchAll: refetch,
    });
    await store.bootstrap();
    expect(store.generation).toBe(7);
    store.putAlways('k', entry('allow'));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(gen).toBe(1);
  });

  // ─── advanceGeneration（W2-轮 2 自修复 CRITICAL #1） ─────────────
  // commit 200 成功路径回灌 server gen，让同批多条 always 不撞 409 自我覆盖。

  it('15. advanceGeneration: monotonic forward only', () => {
    const store = new InMemoryApprovalMemoStore({ initialGeneration: 5 });
    expect(store.advanceGeneration(7)).toBe(true);
    expect(store.generation).toBe(7);
    // 回退尝试：旧值忽略
    expect(store.advanceGeneration(5)).toBe(false);
    expect(store.advanceGeneration(3)).toBe(false);
    expect(store.generation).toBe(7);
  });

  it('16. advanceGeneration preserves alwaysCache', () => {
    const store = new InMemoryApprovalMemoStore({
      initialAlways: { 'kept': entry('allow') },
      initialGeneration: 1,
    });
    store.putAlways('also-kept', entry('deny'));
    store.advanceGeneration(99);
    expect(store.generation).toBe(99);
    expect(store.getAlways('kept')?.decision).toBe('allow');
    expect(store.getAlways('also-kept')?.decision).toBe('deny');
  });

  // ─── W3-轮 1 · markPendingApprovalsStale（PRD 05 §7.6.2 接口 B） ──
  // 用户场景："用户回滚了，pending 审批应该自动取消而不是让 LLM 等下去。"
  // store 触发 host 注入的 cancelPendingApprovals 回调（HTTP POST 到 Django
  // 接口 A），然后 server 广播 approval_resolved(cancelled_by_rollback) 让
  // host 内部 promise 通过 applyCancelledByRollbackToHitl 链路自动 resolve。

  it('17. markPendingApprovalsStale delegates to cancelPendingApprovals callback', async () => {
    const cancelClient = vi.fn(async (
      _threadId: string,
      _reason: string,
      _rollbackEventId?: string,
    ) => ({ cancelledIds: ['req-1', 'req-2'] }));
    const store = new InMemoryApprovalMemoStore({ cancelPendingApprovals: cancelClient });

    const result = await store.markPendingApprovalsStale(
      'thread-A', 'rollback_auto_cancel', 'rb-evt-1',
    );

    expect(result.cancelledIds).toEqual(['req-1', 'req-2']);
    expect(cancelClient).toHaveBeenCalledTimes(1);
    expect(cancelClient).toHaveBeenCalledWith('thread-A', 'rollback_auto_cancel', 'rb-evt-1');
  });

  it('18. markPendingApprovalsStale throws when cancelClient not wired (fail-closed)', async () => {
    const store = new InMemoryApprovalMemoStore();
    await expect(
      store.markPendingApprovalsStale('thread-A', 'rollback_auto_cancel'),
    ).rejects.toThrow(/no cancelClient wired/);
  });

  it('19. markPendingApprovalsStale propagates client error', async () => {
    const cancelClient = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const store = new InMemoryApprovalMemoStore({ cancelPendingApprovals: cancelClient });
    await expect(
      store.markPendingApprovalsStale('thread-A', 'rollback_auto_cancel'),
    ).rejects.toThrow(/network unreachable/);
  });
});

// ─── W3-轮 1 · applyCancelledByRollbackToHitl host helper ─────────────

describe('applyCancelledByRollbackToHitl (PRD 05 §7.6.2 接口 B)', () => {
  // 用户场景：另一台设备 / 07 PRD rollback pipeline 触发了 cancel；本机 runtime
  // 还活着、batch promise 还挂着——host envelope handler 收到广播后用本 helper
  // 把 promise resolve 成 cancelled，让 LLM 看到合理 tool_result 文案而不是干等。

  it('resolves matching batch promise with cancelled outcome + reason', () => {
    // Phase 3 F1：hitlMap entry 升级为 { sessionId, resolver }
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map();
    const resolver = vi.fn();
    hitlMap.set('batch-A', { sessionId: 'sess-1', resolver });

    const result = applyCancelledByRollbackToHitl({
      batchId: 'batch-A',
      decisions: [
        { request_id: 'req-1', tool_call_id: 'tu-1', outcome: 'cancelled_by_rollback' },
        { request_id: 'req-2', tool_call_id: 'tu-2', outcome: 'cancelled_by_rollback' },
      ],
      hitlMap,
      rejectionMessage: 'rollback test reason',
    });

    expect(result.resolvedBatchIds).toEqual(['batch-A']);
    expect(result.orphanedRequestIds).toEqual([]);
    // hitlMap 被清——避免后续 handleSubmitHitlBatch 二次 resolve
    expect(hitlMap.has('batch-A')).toBe(false);
    expect(resolver).toHaveBeenCalledTimes(1);
    const responsePayload = resolver.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(responsePayload).toMatchObject({
      batch_id: 'batch-A',
    });
    const decisions = (responsePayload as { decisions: Array<Record<string, unknown>> }).decisions;
    expect(decisions).toHaveLength(2);
    for (const d of decisions) {
      expect(d.outcome).toBe('cancelled');
      expect(d.rejection_message).toBe('rollback test reason');
    }
    expect(decisions[0].tool_call_id).toBe('tu-1');
    expect(decisions[1].tool_call_id).toBe('tu-2');
  });

  it('skips non-cancelled_by_rollback decisions (filter out)', () => {
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map();
    const resolver = vi.fn();
    hitlMap.set('batch-A', { sessionId: 'sess-1', resolver });

    const result = applyCancelledByRollbackToHitl({
      batchId: 'batch-A',
      decisions: [
        { request_id: 'req-1', tool_call_id: 'tu-1', outcome: 'allow' },
        { request_id: 'req-2', tool_call_id: 'tu-2', outcome: 'deny' },
      ],
      hitlMap,
    });

    expect(result.resolvedBatchIds).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
    expect(hitlMap.has('batch-A')).toBe(true);  // 不动
  });

  it('records orphans when batch_id not in hitlMap (race or process restart)', () => {
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map();
    // batch-A 不在 hitlMap（已 resolve / 进程重启）

    const result = applyCancelledByRollbackToHitl({
      batchId: 'batch-A',
      decisions: [
        { request_id: 'req-1', tool_call_id: 'tu-1', outcome: 'cancelled_by_rollback' },
      ],
      hitlMap,
    });

    expect(result.resolvedBatchIds).toEqual([]);
    expect(result.orphanedRequestIds).toEqual(['req-1']);
  });
});
