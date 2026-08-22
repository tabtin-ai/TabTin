import { describe, expect, it, vi } from 'vitest';
import { LocalRuntimeEvents } from '@tabtin/ws-gateway-client';

import {
  PromptForwardController,
  type PromptForwardControllerPorts,
} from '../src/application/agent/prompt-forward-controller.js';

function createHarness(overrides: Partial<PromptForwardControllerPorts> = {}) {
  const ports: PromptForwardControllerPorts = {
    acceptsNewTasks: vi.fn(() => true),
    lifecycleState: vi.fn(() => 'running'),
    hasAgentHost: vi.fn(() => true),
    feed: vi.fn(),
    reportFailure: vi.fn().mockResolvedValue(undefined),
    handleUnavailableUserResponse: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(),
    debug: vi.fn(),
    ...overrides,
  };
  return { controller: new PromptForwardController(ports), ports };
}

describe('PromptForwardController', () => {
  it('forwards admitted prompt work to the agent host', async () => {
    const { controller, ports } = createHarness();
    const envelope = { type: 'agent.prompt.forward', payload: { task_id: 'task-1' } };

    await controller.handle(envelope);

    expect(ports.feed).toHaveBeenCalledWith(envelope);
    expect(ports.reportFailure).not.toHaveBeenCalled();
  });

  it('rejects new work while draining and preserves the raw payload for failure reporting', async () => {
    const { controller, ports } = createHarness({
      acceptsNewTasks: vi.fn(() => false),
      lifecycleState: vi.fn(() => 'draining'),
    });
    const payload = { task_id: 'task-1' };
    const envelope = { type: 'agent.prompt.forward', payload };

    await controller.handle(envelope);

    expect(ports.feed).not.toHaveBeenCalled();
    expect(ports.reportFailure).toHaveBeenCalledWith(
      envelope,
      payload,
      'Local runtime is unavailable: daemon is draining',
    );
  });

  it('acks user responses through the unavailable-runtime path when no host exists', async () => {
    const { controller, ports } = createHarness({ hasAgentHost: vi.fn(() => false) });
    const envelope = { type: LocalRuntimeEvents.USER_RESPONSE, payload: { request_id: 'request-1' } };

    await controller.handle(envelope);

    expect(ports.handleUnavailableUserResponse).toHaveBeenCalledWith(envelope);
    expect(ports.feed).not.toHaveBeenCalled();
  });

  it('does not turn a control message into new work when the host is unavailable', async () => {
    const { controller, ports } = createHarness({ hasAgentHost: vi.fn(() => false) });

    await controller.handle({ type: 'agent.subagent.cancel', payload: { child_id: 'child-123456789' } });

    expect(ports.feed).not.toHaveBeenCalled();
    expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining('child-12'));
  });

  it('forwards permission responses, mode updates, and session resets to the runtime', async () => {
    const { controller, ports } = createHarness();
    for (const type of [
      'agent.permission.response',
      'agent.permission.mode_update',
      'agent.permission.reset_session',
    ]) {
      await controller.handle({ type, payload: {} });
    }
    expect(ports.feed).toHaveBeenCalledTimes(3);
  });
});
