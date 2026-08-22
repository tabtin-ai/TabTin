import { describe, expect, it, vi } from 'vitest';

import { AgentPersistenceSupervisor } from '../src/application/agent/agent-persistence-supervisor.js';

const owner = { userId: 'user-1', organizationId: 'org-1' };

function createSupervisor() {
  return new AgentPersistenceSupervisor({
    isEnabled: () => false,
    syncRoot: () => null,
    ownerKey: value => `${value.userId}:${value.organizationId}`,
    warn: vi.fn(),
  });
}

describe('AgentPersistenceSupervisor', () => {
  it('serializes reset operations for the same owner', async () => {
    const supervisor = createSupervisor();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = supervisor.runOwnerReset(owner, async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = supervisor.runOwnerReset(owner, async () => {
      order.push('second:start');
    });

    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('serializes three resets without allowing followers to overlap', async () => {
    const supervisor = createSupervisor();
    const active: string[] = [];
    let maxActive = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const operation = (name: string, wait = false) => supervisor.runOwnerReset(owner, async () => {
      active.push(name);
      maxActive = Math.max(maxActive, active.length);
      if (wait) await gate;
      active.splice(active.indexOf(name), 1);
    });

    const first = operation('first', true);
    const second = operation('second');
    const third = operation('third');
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second, third]);

    expect(maxActive).toBe(1);
  });

  it('hands cleared-file state to exactly one reset result', () => {
    const supervisor = createSupervisor();
    supervisor.recordClearedFiles(owner, true);

    expect(supervisor.consumeClearedFiles(owner)).toBe(true);
    expect(supervisor.consumeClearedFiles(owner)).toBe(false);
  });

  it('allows startup reconciliation to be claimed only once', () => {
    const supervisor = createSupervisor();
    expect(supervisor.claimStartupReconcile()).toBe(true);
    expect(supervisor.claimStartupReconcile()).toBe(false);
  });

  it('does not recreate persistence resources after disposal', async () => {
    const supervisor = createSupervisor();
    await supervisor.dispose();
    expect(supervisor.getManagedTaskQueue(owner)).toBeUndefined();
    await expect(supervisor.runOwnerReset(owner, async () => undefined)).rejects.toThrow('disposed');
  });

  it('waits for already queued owner resets before disposal completes', async () => {
    const supervisor = createSupervisor();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = supervisor.runOwnerReset(owner, async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const second = supervisor.runOwnerReset(owner, async () => { events.push('second'); });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));

    let disposed = false;
    const disposing = supervisor.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    releaseFirst();
    await Promise.all([first, second, disposing]);

    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(disposed).toBe(true);
  });
});
