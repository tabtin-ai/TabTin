import { describe, expect, it } from 'vitest';
import { ActionAdmissionController } from '../src/application/execution/action-admission-controller.js';

describe('ActionAdmissionController', () => {
  it('owns request accounting and idempotent completion', () => {
    const controller = new ActionAdmissionController();
    const lease = controller.admitRequest();
    expect(lease).not.toBeNull();
    expect(controller.getActiveRequestCount()).toBe(1);
    lease!.complete();
    lease!.complete();
    expect(controller.getActiveRequestCount()).toBe(0);
  });

  it('rejects duplicate task ownership without replacing the original owner', () => {
    const controller = new ActionAdmissionController();
    const first = controller.claimTask('task-1');
    expect(first).not.toBeNull();
    expect(controller.claimTask('task-1')).toBeNull();
    expect(controller.cancel('task-1')).toBe(true);
    expect(first!.controller.signal.aborted).toBe(true);
    first!.complete();
    expect(controller.claimTask('task-1')).not.toBeNull();
  });

  it('suspends new work while preserving cancellation, then aborts all on dispose', () => {
    const controller = new ActionAdmissionController();
    const task = controller.claimTask('task-1')!;
    controller.suspend();
    expect(controller.admitRequest()).toBeNull();
    expect(controller.cancel('task-1')).toBe(true);

    const secondController = new ActionAdmissionController();
    const second = secondController.claimTask('task-2')!;
    controller.dispose();
    secondController.dispose();
    expect(second.controller.signal.aborted).toBe(true);
    expect(controller.cancel('task-2')).toBe(false);
    expect(controller.claimTask('task-3')).toBeNull();
  });
});
