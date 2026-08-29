/**
 * presentAccessBarrier — 单测（设计 §7 运行时行为 / plan Task 4）。
 */

import { describe, expect, it, vi } from 'vitest';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import {
  presentAccessBarrier,
  buildUnattendedResolution,
  type AccessBarrier,
} from '../src/access-barrier/present.js';
import type { InterruptPort } from '../src/engine/contracts/hitl.js';

function makeBarrier(overrides: Partial<AccessBarrier> = {}): AccessBarrier {
  return {
    kind: 'login',
    reason: '需要登录',
    domain: 'example.com',
    pageUrl: 'https://example.com',
    tabId: 't1',
    sourceTool: 'observe',
    detectedAt: new Date().toISOString(),
    actions: ['resume_same_tab', 'alternate_source', 'abort_this_target'],
    ...overrides,
  };
}

function makeInterrupt(overrides: Partial<InterruptPort> = {}): InterruptPort {
  return {
    isAvailable: () => true,
    isBatchAvailable: () => false,
    interrupt: vi.fn(async () => ({ status: 'resolved', value: { action: 'abort_this_target' } })) as any,
    interruptBatch: vi.fn() as any,
    resumePending: vi.fn(async () => ({ toolResultBlocks: [] })) as any,
    ...overrides,
  };
}

describe('presentAccessBarrier（设计 §7）', () => {
  it('scheduled 模式：不调用 interrupt，直接诚实失败 host_unavailable', async () => {
    const interrupt = makeInterrupt();
    const barrier = makeBarrier();
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier,
      runtimeMode: 'scheduled',
    });
    expect(interrupt.interrupt).not.toHaveBeenCalled();
    expect(resolution).toEqual({ action: 'host_unavailable' });
  });

  it('batch 模式：同 scheduled，不调用 interrupt', async () => {
    const interrupt = makeInterrupt();
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'batch',
    });
    expect(interrupt.interrupt).not.toHaveBeenCalled();
    expect(resolution).toEqual({ action: 'host_unavailable' });
  });

  it('!isAvailable()：诚实失败，不调用 interrupt', async () => {
    const interrupt = makeInterrupt({ isAvailable: () => false });
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'interactive',
    });
    expect(interrupt.interrupt).not.toHaveBeenCalled();
    expect(resolution).toEqual({ action: 'host_unavailable' });
  });

  it('超时 → { action: "timeout" } 并补发 single_hitl_resolved(outcome=expired)', async () => {
    const emitStreamEvent = vi.fn();
    const interrupt = makeInterrupt({
      interrupt: vi.fn(async () => ({ status: 'timeout', message: 'timed out' })) as any,
    });
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'interactive',
      generateId: () => 'req-timeout',
      emitStreamEvent,
      sessionId: 'sess-1',
    });
    expect(resolution).toEqual({ action: 'timeout' });
    expect(emitStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: StreamEvents.SINGLE_HITL_RESOLVED,
        payload: expect.objectContaining({
          request_id: 'req-timeout',
          interrupt_id: 'req-timeout',
          outcome: 'expired',
          thread_id: 'sess-1',
        }),
      }),
    );
  });

  it('用户点选后补发 single_hitl_resolved(outcome=answered)', async () => {
    const emitStreamEvent = vi.fn();
    const interrupt = makeInterrupt({
      interrupt: vi.fn(async () => ({
        status: 'resolved',
        value: { action: 'resume_same_tab', tabId: 't1' },
      })) as any,
    });
    await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'interactive',
      generateId: () => 'req-answered',
      emitStreamEvent,
    });
    expect(emitStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: StreamEvents.SINGLE_HITL_RESOLVED,
        payload: expect.objectContaining({
          request_id: 'req-answered',
          outcome: 'answered',
        }),
      }),
    );
  });

  it('cancel 形态决议 → single_hitl_resolved(outcome=cancelled) + host_unavailable', async () => {
    const emitStreamEvent = vi.fn();
    const interrupt = makeInterrupt({
      interrupt: vi.fn(async () => ({
        status: 'resolved',
        value: {
          cancelled: true,
          reason: 'aborted',
        },
      })) as any,
    });
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'interactive',
      generateId: () => 'req-cancel',
      emitStreamEvent,
    });
    expect(resolution).toEqual({ action: 'host_unavailable' });
    expect(emitStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: StreamEvents.SINGLE_HITL_RESOLVED,
        payload: expect.objectContaining({
          request_id: 'req-cancel',
          outcome: 'cancelled',
        }),
      }),
    );
  });

  it('interactive + isAvailable：emit access_barrier_required 专用卡片并挂起', async () => {
    const barrier = makeBarrier();
    const interrupt = makeInterrupt({
      interrupt: vi.fn(async (req: any) => {
        expect(req.kind).toBe('access_barrier');
        expect(req.requestEvent.type).toBe(StreamEvents.ACCESS_BARRIER_REQUIRED);
        expect(req.requestEvent.payload.barrier).toEqual(barrier);
        expect(req.requestEvent.payload.request_id).toBe(req.interruptId);
        expect(typeof req.requestEvent.payload.expires_at).toBe('number');
        return { status: 'resolved', value: { action: 'resume_same_tab', tabId: 't1' } };
      }) as any,
    });
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier,
      runtimeMode: 'interactive',
      generateId: () => 'req-1',
    });
    expect(interrupt.interrupt).toHaveBeenCalledOnce();
    expect(resolution).toEqual({ action: 'resume_same_tab', tabId: 't1' });
  });

  it('用户选 alternate_source', async () => {
    const interrupt = makeInterrupt({
      interrupt: vi.fn(async () => ({ status: 'resolved', value: { action: 'alternate_source' } })) as any,
    });
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'interactive',
    });
    expect(resolution).toEqual({ action: 'alternate_source' });
  });

  it('host resolve 回传未知形状 → fail-closed 落 host_unavailable（禁止假装成功）', async () => {
    const interrupt = makeInterrupt({
      interrupt: vi.fn(async () => ({ status: 'resolved', value: { weird: true } })) as any,
    });
    const resolution = await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'interactive',
    });
    expect(resolution).toEqual({ action: 'host_unavailable' });
  });

  it('solo 模式（有人值守）也会走 interrupt（非 scheduled/batch）', async () => {
    const interrupt = makeInterrupt();
    await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier(),
      runtimeMode: 'solo',
    });
    expect(interrupt.interrupt).toHaveBeenCalledOnce();
  });

  it('telemetry：presented + resolved 打点（observe 被调用）', async () => {
    const observe = vi.fn();
    const interrupt = makeInterrupt({
      interrupt: vi.fn(async () => ({ status: 'resolved', value: { action: 'abort_this_target' } })) as any,
    });
    await presentAccessBarrier({
      interrupt,
      barrier: makeBarrier({ kind: 'geetest', domain: 'geetest.example' }),
      runtimeMode: 'interactive',
      observe,
      sessionId: 'session-1',
    });
    const eventNames = observe.mock.calls.map((call) => call[0]);
    expect(eventNames).toContain('access_barrier.presented');
    expect(eventNames).toContain('access_barrier.resolved');
    for (const call of observe.mock.calls) {
      expect(call[2]).toEqual({ session_id: 'session-1' });
    }
  });

  it('telemetry：host_unavailable 打点（scheduled）', async () => {
    const observe = vi.fn();
    await presentAccessBarrier({
      interrupt: makeInterrupt(),
      barrier: makeBarrier(),
      runtimeMode: 'scheduled',
      observe,
    });
    expect(observe).toHaveBeenCalledWith(
      'access_barrier.host_unavailable',
      expect.objectContaining({ reason: 'scheduled_or_batch' }),
      undefined,
    );
  });

  it('telemetry：timeout 打点', async () => {
    const observe = vi.fn();
    await presentAccessBarrier({
      interrupt: makeInterrupt({
        interrupt: vi.fn(async () => ({ status: 'timeout', message: 'timed out' })) as any,
      }),
      barrier: makeBarrier(),
      runtimeMode: 'interactive',
      observe,
    });
    expect(observe).toHaveBeenCalledWith(
      'access_barrier.timeout',
      expect.objectContaining({ kind: 'login', domain: 'example.com' }),
      undefined,
    );
  });

  it('buildUnattendedResolution 直查：始终 host_unavailable', () => {
    expect(buildUnattendedResolution(makeBarrier())).toEqual({ action: 'host_unavailable' });
  });
});
