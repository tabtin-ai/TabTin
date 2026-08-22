import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSubagentWaitForUserInput,
  createChildWaitForUserInputStub,
  getPendingHitlCount,
  __resetPendingHitlCountForTests,
} from '../src/permissions/subagent-hitl.js';

beforeEach(() => {
  __resetPendingHitlCountForTests();
});

afterEach(() => {
  __resetPendingHitlCountForTests();
});

describe('createSubagentWaitForUserInput', () => {
  it('returns undefined when parent has no waitForUserInput', () => {
    const result = createSubagentWaitForUserInput(undefined);
    expect(result).toBeUndefined();
  });

  it('delegates to parent waitForUserInput and returns the result', async () => {
    const parentFn = vi.fn().mockResolvedValue({ approved: true, answer: 'yes' });
    const childFn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-A' })!;

    expect(childFn).toBeDefined();
    const result = await childFn('req-123');

    expect(parentFn).toHaveBeenCalledWith('req-123');
    expect(result).toEqual({ approved: true, answer: 'yes' });
  });

  it('tracks pending count during execution', async () => {
    let resolveParent!: (v: unknown) => void;
    const parentFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveParent = resolve; }),
    );
    const childFn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-A' })!;

    expect(getPendingHitlCount('sess-A')).toBe(0);

    const promise = childFn('req-1');
    expect(getPendingHitlCount('sess-A')).toBe(1);

    resolveParent('ok');
    await promise;

    expect(getPendingHitlCount('sess-A')).toBe(0);
  });

  it('decrements pending count even when parent rejects', async () => {
    const parentFn = vi.fn().mockRejectedValue(new Error('denied'));
    const childFn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-A' })!;

    await expect(childFn('req-2')).rejects.toThrow('denied');
    expect(getPendingHitlCount('sess-A')).toBe(0);
  });

  it('denies when pending count reaches MAX_PENDING_HITL (100) for same session', async () => {
    const blockers: Array<{ resolve: (v: unknown) => void }> = [];
    const parentFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => { blockers.push({ resolve }); }),
    );
    const childFn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-A' })!;

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(childFn(`req-${i}`));
    }
    expect(getPendingHitlCount('sess-A')).toBe(100);

    await expect(childFn('req-overflow')).rejects.toThrow('too many pending requests');
    expect(getPendingHitlCount('sess-A')).toBe(100);

    for (const b of blockers) b.resolve('ok');
    await Promise.all(promises);
    expect(getPendingHitlCount('sess-A')).toBe(0);
  });

  it('session isolation : sess-A at limit does not block sess-B', async () => {
    const blockingParent = vi.fn().mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );
    const childA = createSubagentWaitForUserInput(blockingParent, { sessionId: 'sess-A' })!;
    for (let i = 0; i < 100; i++) {
      void childA(`req-a-${i}`);
    }
    expect(getPendingHitlCount('sess-A')).toBe(100);

    await expect(childA('req-a-overflow')).rejects.toThrow('too many pending requests');

    const resolvingParent = vi.fn().mockResolvedValue('ok');
    const childB = createSubagentWaitForUserInput(resolvingParent, { sessionId: 'sess-B' })!;
    await expect(childB('req-b-ok')).resolves.toBe('ok');
    expect(getPendingHitlCount('sess-B')).toBe(0);
    expect(getPendingHitlCount('sess-A')).toBe(100);
  });

  it('times out after HITL_TIMEOUT_MS and cleans up timer', async () => {
    vi.useFakeTimers();
    try {
      const parentFn = vi.fn().mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      );
      const childFn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-A' })!;

      const promise = childFn('req-timeout');
      expect(getPendingHitlCount('sess-A')).toBe(1);

      vi.advanceTimersByTime(60 * 60 * 1000 + 1);

      await expect(promise).rejects.toThrow('timed out');
      expect(getPendingHitlCount('sess-A')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears timeout timer when parent resolves normally', async () => {
    vi.useFakeTimers();
    try {
      const parentFn = vi.fn().mockResolvedValue('approved');
      const childFn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-A' })!;

      await childFn('req-fast');

      // If the timer were leaked, advancing past HITL_TIMEOUT_MS would cause
      // an unhandled rejection. Here we verify it doesn't.
      const activeTimersBefore = vi.getTimerCount();
      expect(activeTimersBefore).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports concurrent child HITL requests from different sub-agents', async () => {
    const parentFn = vi.fn().mockImplementation(
      (requestId: string) => Promise.resolve({ id: requestId }),
    );

    const child1Fn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-1' })!;
    const child2Fn = createSubagentWaitForUserInput(parentFn, { sessionId: 'sess-2' })!;

    const [r1, r2] = await Promise.all([
      child1Fn('req-child1'),
      child2Fn('req-child2'),
    ]);

    expect(r1).toEqual({ id: 'req-child1' });
    expect(r2).toEqual({ id: 'req-child2' });
    expect(parentFn).toHaveBeenCalledTimes(2);
    expect(getPendingHitlCount()).toBe(0);
  });
});

describe('createChildWaitForUserInputStub', () => {
  it('always throws with descriptive message about missing approval support', async () => {
    const stub = createChildWaitForUserInputStub();
    await expect(stub('any-id')).rejects.toThrow('requires user approval');
  });
});

// 统一审批 W0.2（B3）：宿主把 waitForUserInput 注入 agentToolDeps 后，
// agent-tool 走 `createSubagentWaitForUserInput(config.waitForUserInput)
//   ?? createChildWaitForUserInputStub()` 选路。
// 这组用例对照该 ?? 选路逻辑：父函数缺失 → stub 抛错；父函数存在 → 包装函数
// 透传 requestId 并回填父响应，不再走 stub。
describe('agent-tool selection: stub vs wrapped (W0.2 / B3 contract)', () => {
  it('falls back to stub error when host did not wire waitForUserInput', async () => {
    const childFn =
      createSubagentWaitForUserInput(undefined) ?? createChildWaitForUserInputStub();
    await expect(childFn('req-no-host')).rejects.toThrow('requires user approval');
  });

  it('uses parent-backed wrapper (not stub) when host wires waitForUserInput', async () => {
    const parentFn = vi.fn().mockResolvedValue({ approved: true, answer: 'ok' });
    const childFn =
      createSubagentWaitForUserInput(parentFn) ?? createChildWaitForUserInputStub();

    const result = await childFn('req-from-child');

    expect(parentFn).toHaveBeenCalledTimes(1);
    expect(parentFn).toHaveBeenCalledWith('req-from-child');
    expect(result).toEqual({ approved: true, answer: 'ok' });
  });

  it('forwards exact requestId across multiple sub-agent calls without rewriting it', async () => {
    const seenRequestIds: string[] = [];
    const parentFn = vi.fn().mockImplementation((requestId: string) => {
      seenRequestIds.push(requestId);
      return Promise.resolve({ approved: true, requestId });
    });

    const childFn =
      createSubagentWaitForUserInput(parentFn) ?? createChildWaitForUserInputStub();

    const ids = ['ask-uuid-A', 'ask-uuid-B', 'ask-uuid-C'];
    const results = await Promise.all(ids.map((id) => childFn(id)));

    expect(seenRequestIds).toEqual(ids);
    expect(results).toEqual(ids.map((id) => ({ approved: true, requestId: id })));
    expect(getPendingHitlCount()).toBe(0);
  });
});
