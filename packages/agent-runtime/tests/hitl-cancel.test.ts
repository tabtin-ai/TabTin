/**
 * cancelAllPendingHitlRequests — Phase 3 mode switch stale cleanup
 *
 * Phase 3 F1 修复：从 Map<batchId, resolver> 升级为带 sessionId 的 entry，
 * 取消按 sessionId 过滤，避免跨 session 误杀 pending HITL。
 */

import { describe, it, expect } from 'vitest';
import {
  cancelAllPendingHitlRequests,
  cancelAllSessionsHitlRequests,
  type PendingHitlMap,
} from '../src/permissions/hitl-cancel.js';

function makeMap(): PendingHitlMap {
  return new Map();
}

describe('cancelAllPendingHitlRequests (session-scoped)', () => {
  it('resolves all pending batches in the same session and clears those entries', () => {
    const hitlMap = makeMap();
    const resolved: unknown[] = [];
    hitlMap.set('batch-a', { sessionId: 'sess-1', resolver: (r) => resolved.push(r) });
    hitlMap.set('batch-b', { sessionId: 'sess-1', resolver: (r) => resolved.push(r) });

    const ids = cancelAllPendingHitlRequests({
      hitlMap,
      sessionId: 'sess-1',
      reason: 'mode switch',
    });

    expect(ids.sort()).toEqual(['batch-a', 'batch-b']);
    expect(hitlMap.size).toBe(0);
    expect(resolved).toHaveLength(2);
    const first = resolved[0] as { decisions: Array<{ outcome: string; rejection_message: string }> };
    expect(first.decisions[0]?.outcome).toBe('cancelled');
    expect(first.decisions[0]?.rejection_message).toBe('mode switch');
  });

  it('returns empty when no pending', () => {
    const hitlMap = makeMap();
    expect(cancelAllPendingHitlRequests({ hitlMap, sessionId: 'sess-1' })).toEqual([]);
  });

  // ─── 关键：F1 P0 修复的核心场景 — 跨 session 隔离 ─────────────────
  it('does not cancel batches of other sessions when sessionId is given', () => {
    const hitlMap = makeMap();
    const resolvedA: unknown[] = [];
    const resolvedB: unknown[] = [];
    hitlMap.set('batch-a1', { sessionId: 'sess-A', resolver: (r) => resolvedA.push(r) });
    hitlMap.set('batch-a2', { sessionId: 'sess-A', resolver: (r) => resolvedA.push(r) });
    hitlMap.set('batch-b1', { sessionId: 'sess-B', resolver: (r) => resolvedB.push(r) });
    hitlMap.set('batch-b2', { sessionId: 'sess-B', resolver: (r) => resolvedB.push(r) });

    const cancelled = cancelAllPendingHitlRequests({
      hitlMap,
      sessionId: 'sess-A',
      reason: 'mode switch in sess-A',
    });

    expect(cancelled.sort()).toEqual(['batch-a1', 'batch-a2']);
    // sess-B 的两条 batch 必须保留——这是 F1 的核心断言
    expect(hitlMap.size).toBe(2);
    expect(hitlMap.has('batch-b1')).toBe(true);
    expect(hitlMap.has('batch-b2')).toBe(true);
    expect(resolvedA).toHaveLength(2);
    expect(resolvedB).toHaveLength(0);
  });

  it('omitting sessionId cancels all sessions (legacy / shutdown path)', () => {
    const hitlMap = makeMap();
    const resolved: unknown[] = [];
    hitlMap.set('a', { sessionId: 'sess-A', resolver: (r) => resolved.push(r) });
    hitlMap.set('b', { sessionId: 'sess-B', resolver: (r) => resolved.push(r) });

    const cancelled = cancelAllPendingHitlRequests({ hitlMap });

    expect(cancelled.sort()).toEqual(['a', 'b']);
    expect(hitlMap.size).toBe(0);
    expect(resolved).toHaveLength(2);
  });

  it('cancelAllSessionsHitlRequests is a clearer alias for the global path', () => {
    const hitlMap = makeMap();
    const resolved: unknown[] = [];
    hitlMap.set('a', { sessionId: 'sess-A', resolver: (r) => resolved.push(r) });
    hitlMap.set('b', { sessionId: 'sess-B', resolver: (r) => resolved.push(r) });

    const cancelled = cancelAllSessionsHitlRequests({ hitlMap });

    expect(cancelled.sort()).toEqual(['a', 'b']);
    expect(hitlMap.size).toBe(0);
    expect(resolved).toHaveLength(2);
  });

  it('resolver throws are swallowed (defensive) and entry still removed', () => {
    const hitlMap = makeMap();
    hitlMap.set('boom', {
      sessionId: 'sess-x',
      resolver: () => {
        throw new Error('resolver should never throw, but if it does we swallow');
      },
    });

    expect(() =>
      cancelAllPendingHitlRequests({ hitlMap, sessionId: 'sess-x' }),
    ).not.toThrow();
    expect(hitlMap.has('boom')).toBe(false);
  });
});
