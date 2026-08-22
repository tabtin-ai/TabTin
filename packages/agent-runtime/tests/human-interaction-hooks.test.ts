import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requestPlatformApproval,
  runWithHumanInteractionContext,
  setHumanInteractionHooks,
} from '../src/permissions/human-interaction-hooks.js';

afterEach(() => {
  setHumanInteractionHooks(undefined);
});

describe('human interaction hooks', () => {
  it('fails closed without an injected runtime context', async () => {
    setHumanInteractionHooks({
      requestPlatformApproval: vi.fn(async () => ({ approved: true })),
    });
    await expect(requestPlatformApproval({
      actionType: 'browser.click',
      detail: 'click',
    })).resolves.toEqual({ approved: false });
  });

  it('injects the context independently for concurrent conversations', async () => {
    const handler = vi.fn(async context => ({
      approved: context.threadId === 'thread-a',
    }));
    setHumanInteractionHooks({ requestPlatformApproval: handler });

    const [first, second] = await Promise.all([
      runWithHumanInteractionContext(
        { threadId: 'thread-a', interactionMode: 'interactive' },
        () => requestPlatformApproval({ actionType: 'file_write', detail: 'a' }),
      ),
      runWithHumanInteractionContext(
        { threadId: 'thread-b', interactionMode: 'interactive' },
        () => requestPlatformApproval({ actionType: 'file_write', detail: 'b' }),
      ),
    ]);

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(false);
    expect(handler.mock.calls.map(([context]) => context.threadId)).toEqual([
      'thread-a',
      'thread-b',
    ]);
  });

  it('does not inherit a parent conversation when a nested boundary has no thread', async () => {
    const handler = vi.fn(async () => ({ approved: true }));
    setHumanInteractionHooks({ requestPlatformApproval: handler });

    const result = await runWithHumanInteractionContext(
      { threadId: 'thread-parent', interactionMode: 'interactive' },
      () => runWithHumanInteractionContext(
        { threadId: '', interactionMode: 'interactive' },
        () => requestPlatformApproval({ actionType: 'file_delete', detail: 'delete' }),
      ),
    );

    expect(result).toEqual({ approved: false });
    expect(handler).not.toHaveBeenCalled();
  });
});
