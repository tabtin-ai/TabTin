import { describe, expect, it } from 'vitest';
import { resolveToolNotificationThreadId } from '../notification-thread.js';

describe('resolveToolNotificationThreadId ', () => {
  it('主 Agent 没有 subagentRunId 时回落业务 threadId', () => {
    expect(resolveToolNotificationThreadId({ threadId: 'parent-thread' })).toBe('parent-thread');
  });

  it('子 Agent 用 assistantSubagentRunId，不跟父对话 thread', () => {
    expect(
      resolveToolNotificationThreadId({
        threadId: 'parent-thread',
        assistantSubagentRunId: 'child-run-id',
      }),
    ).toBe('child-run-id');
  });

  it('空白 child id 视为无效，回落父 thread', () => {
    expect(
      resolveToolNotificationThreadId({
        threadId: 'parent-thread',
        assistantSubagentRunId: '   ',
      }),
    ).toBe('parent-thread');
  });
});
