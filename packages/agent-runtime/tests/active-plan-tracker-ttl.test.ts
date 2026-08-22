/**
 * active-plan-tracker lazy TTL 兑底测试。
 *
 * 主路径：宿主在 stop() 中调 `clearAllForSession` 清理 ACTIVE_PLANS。
 * 兑底：宿主漏 cleanup 时（崩溃 / 切 Organization / 切 Space / 长驻 Daemon），
 *       lazy TTL（24h）在 `getActivePlan` / `markActivePlan` / `__snapshotActivePlans`
 *       触发时清理过期 entries。
 *
 * ：tracker 存储 PlanRef（本测试用 document 载体覆盖 TTL 逻辑；file 载体
 * 语义与 document 一致，TTL 不区分载体）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markActivePlan,
  clearActivePlan,
  getActivePlan,
  getActivePlanRef,
  clearAllForSession,
  setActivePlanChangeListener,
  __snapshotActivePlans,
  __resetActivePlanTrackerForTests,
  type ActivePlanChangeEvent,
} from '../src/state/active-plan-tracker.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // 固定基准时间

const docRef = (id: string) => ({ kind: 'document' as const, document_id: id });

let events: ActivePlanChangeEvent[];

beforeEach(() => {
  __resetActivePlanTrackerForTests();
  events = [];
  setActivePlanChangeListener((e) => events.push(e));
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  setActivePlanChangeListener(undefined);
  vi.useRealTimers();
  __resetActivePlanTrackerForTests();
});

describe('active-plan-tracker — lazy TTL via getActivePlan', () => {
  it('returns documentId when entry is fresh', () => {
    markActivePlan('s1', docRef('doc-1'));
    expect(getActivePlan('s1')).toBe('doc-1');
  });

  it('returns null and lazy-clears when entry has expired', () => {
    markActivePlan('s1', docRef('doc-1'));
    events.length = 0; // 重置 set 事件

    // 推进时间到 TTL 边界之前 1ms
    vi.setSystemTime(T0 + TTL_MS - 1);
    expect(getActivePlan('s1')).toBe('doc-1');
    expect(events).toHaveLength(0);

    // 跨过 TTL 边界
    vi.setSystemTime(T0 + TTL_MS);
    expect(getActivePlan('s1')).toBeNull();

    // 触发了 onChange (reason='reset')
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'clear',
      sessionId: 's1',
      previousRef: docRef('doc-1'),
      reason: 'reset',
    });

    // 二次调用应该是干净的 null（entry 已被清理）
    events.length = 0;
    expect(getActivePlan('s1')).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('does not affect other sessions when one expires', () => {
    markActivePlan('s1', docRef('doc-1'));
    vi.setSystemTime(T0 + TTL_MS / 2);
    markActivePlan('s2', docRef('doc-2'));

    // 推进 14h —— s1 早于 24h 之前创建 → 过期；s2 在 12h 前 → 仍在 TTL 内
    vi.setSystemTime(T0 + TTL_MS + 1);
    expect(getActivePlan('s1')).toBeNull();
    expect(getActivePlan('s2')).toBe('doc-2');
  });

  it('does not expire when system time goes backwards', () => {
    markActivePlan('s1', docRef('doc-1'));
    // 模拟系统时间被回拨（NTP 校正 / 用户改时区）
    vi.setSystemTime(T0 - 60 * 60 * 1000);
    expect(getActivePlan('s1')).toBe('doc-1');
    // 没有 expire 事件
    expect(events.filter((e) => e.type === 'clear')).toHaveLength(0);
  });
});

describe('active-plan-tracker — sweep on markActivePlan', () => {
  it('sweeps expired sessions when a new plan is marked', () => {
    markActivePlan('s1', docRef('doc-old'));
    events.length = 0;

    vi.setSystemTime(T0 + TTL_MS + 1);
    // mark 新 plan 应该顺手清掉 s1
    markActivePlan('s2', docRef('doc-new'));

    // 应该有 1 个 reset (s1) + 1 个 set (s2)
    const clears = events.filter((e) => e.type === 'clear');
    const sets = events.filter((e) => e.type === 'set');
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ sessionId: 's1', reason: 'reset' });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ sessionId: 's2', ref: docRef('doc-new') });

    // s1 真的没了
    expect(getActivePlan('s1')).toBeNull();
    expect(getActivePlan('s2')).toBe('doc-new');
  });

  it('sweeps multiple expired sessions in one mark call', () => {
    markActivePlan('s1', docRef('doc-1'));
    markActivePlan('s2', docRef('doc-2'));
    markActivePlan('s3', docRef('doc-3'));
    events.length = 0;

    vi.setSystemTime(T0 + TTL_MS + 1);
    markActivePlan('s4', docRef('doc-4'));

    const clears = events.filter((e) => e.type === 'clear');
    expect(clears).toHaveLength(3);
    expect(clears.map((e) => e.sessionId).sort()).toEqual(['s1', 's2', 's3']);
    expect(getActivePlan('s4')).toBe('doc-4');
  });

  it('idempotent mark does not refresh createdAt (so TTL still triggers)', () => {
    markActivePlan('s1', docRef('doc-1'));
    vi.setSystemTime(T0 + TTL_MS / 2);

    // 同 doc 重复 mark —— 因为没过期所以是幂等返回，createdAt 不刷新
    events.length = 0;
    markActivePlan('s1', docRef('doc-1'));
    expect(events).toHaveLength(0);

    // 推进到原始 createdAt 之后 24h —— entry 应该过期了
    vi.setSystemTime(T0 + TTL_MS + 1);
    expect(getActivePlan('s1')).toBeNull();
  });

  it('expired same-doc mark refreshes createdAt (treated as new write)', () => {
    markActivePlan('s1', docRef('doc-1'));
    events.length = 0;

    // 跨过 TTL 之后再 mark 同 doc —— 应当被当作新写入（不再幂等）
    vi.setSystemTime(T0 + TTL_MS + 1);
    markActivePlan('s1', docRef('doc-1'));

    // sweep 触发 reset，然后新 set
    const clears = events.filter((e) => e.type === 'clear');
    const sets = events.filter((e) => e.type === 'set');
    expect(clears).toHaveLength(1);
    expect(sets).toHaveLength(1);
    expect(getActivePlan('s1')).toBe('doc-1');
  });
});

describe('active-plan-tracker — snapshot also sweeps', () => {
  it('does not return expired entries via __snapshotActivePlans', () => {
    markActivePlan('s1', docRef('doc-1'));
    markActivePlan('s2', docRef('doc-2'));
    vi.setSystemTime(T0 + TTL_MS + 1);

    const snap = __snapshotActivePlans();
    expect(snap).toEqual([]);
  });

  it('returns only non-expired entries when mixed', () => {
    markActivePlan('s1', docRef('doc-1'));
    vi.setSystemTime(T0 + TTL_MS / 2);
    markActivePlan('s2', docRef('doc-2'));
    vi.setSystemTime(T0 + TTL_MS + 1); // s1 过期，s2 没过

    const snap = __snapshotActivePlans();
    expect(snap).toHaveLength(1);
    expect(snap[0].sessionId).toBe('s2');
    expect(snap[0].ref).toEqual(docRef('doc-2'));
  });
});

describe('active-plan-tracker — file 载体', () => {
  it('getActivePlanRef 返回 file ref；getActivePlan 返回 null（不参与 target 豁免）', () => {
    markActivePlan('s1', { kind: 'file', path: 'plans/2026-07-04-foo.plan.md' });
    expect(getActivePlanRef('s1')).toEqual({ kind: 'file', path: 'plans/2026-07-04-foo.plan.md' });
    // guard 视角：file 载体不返回 document id
    expect(getActivePlan('s1')).toBeNull();
  });
});

describe('active-plan-tracker — TTL coexists with explicit clears', () => {
  it('clearAllForSession still works on fresh entries', () => {
    markActivePlan('s1', docRef('doc-1'));
    events.length = 0;

    clearAllForSession('s1');
    expect(getActivePlan('s1')).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      reason: 'session_dispose',
    });
  });

  it('clearActivePlan still works on fresh entries', () => {
    markActivePlan('s1', docRef('doc-1'));
    events.length = 0;

    expect(clearActivePlan('s1')).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 's1', reason: 'manual' });
  });

  it('clearAllForSession on already-expired entry is a no-op (already cleared by lazy)', () => {
    markActivePlan('s1', docRef('doc-1'));
    vi.setSystemTime(T0 + TTL_MS + 1);

    // getActivePlan 触发 lazy clear
    getActivePlan('s1');
    events.length = 0;

    // 再调 clearAllForSession 应该是 no-op
    clearAllForSession('s1');
    expect(events).toHaveLength(0);
  });
});
