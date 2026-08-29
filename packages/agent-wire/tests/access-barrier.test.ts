import { describe, expect, it } from 'vitest';

import { StreamEvents } from '../src/events.js';
import {
  ACCESS_BARRIER_REQUIRED_EVENT_TYPE,
  AccessBarrierRequiredPayloadSchema,
  AccessBarrierResolutionSchema,
  AccessBarrierSchema,
} from '../src/access-barrier.js';

describe('Access Barrier HITL wire schema', () => {
  it('StreamEvents.ACCESS_BARRIER_REQUIRED === agent.stream.access_barrier_required', () => {
    expect(StreamEvents.ACCESS_BARRIER_REQUIRED).toBe('agent.stream.access_barrier_required');
    expect(StreamEvents.ACCESS_BARRIER_REQUIRED).toBe(ACCESS_BARRIER_REQUIRED_EVENT_TYPE);
  });

  it('parses access_barrier_required payload', () => {
    const raw = {
      request_id: 'r1',
      barrier: {
        kind: 'login',
        reason: '需要登录',
        domain: 'example.com',
        detectedAt: new Date().toISOString(),
        actions: ['resume_same_tab', 'alternate_source', 'abort_this_target'],
      },
    };
    expect(AccessBarrierRequiredPayloadSchema.parse(raw).request_id).toBe('r1');
  });

  it('rejects invalid barrier.kind', () => {
    const raw = {
      request_id: 'r1',
      barrier: {
        kind: 'not_a_kind',
        reason: 'x',
        domain: 'example.com',
        detectedAt: new Date().toISOString(),
        actions: [],
      },
    };
    expect(AccessBarrierSchema.safeParse(raw.barrier).success).toBe(false);
    expect(AccessBarrierRequiredPayloadSchema.safeParse(raw).success).toBe(false);
  });

  it('AccessBarrierResolutionSchema parses 三选一 + 系统结局四种', () => {
    expect(AccessBarrierResolutionSchema.parse({ action: 'resume_same_tab', tabId: 't1' }).action).toBe('resume_same_tab');
    expect(AccessBarrierResolutionSchema.parse({ action: 'alternate_source' }).action).toBe('alternate_source');
    expect(AccessBarrierResolutionSchema.parse({ action: 'abort_this_target' }).action).toBe('abort_this_target');
    for (const action of ['timeout', 'skipped', 'host_unavailable']) {
      expect(AccessBarrierResolutionSchema.parse({ action }).action).toBe(action);
    }
  });

  it('geetest kind 独立于 captcha（设计 §5.1 注）', () => {
    const parsed = AccessBarrierSchema.parse({
      kind: 'geetest',
      reason: '极验',
      domain: 'example.com',
      detectedAt: new Date().toISOString(),
      actions: ['resume_same_tab', 'alternate_source', 'abort_this_target'],
    });
    expect(parsed.kind).toBe('geetest');
  });
});
