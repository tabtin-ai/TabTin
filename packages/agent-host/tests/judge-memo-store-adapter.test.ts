/**
 * JudgeMemoStoreAdapter — thread scope memo lookup 回归
 *
 * 覆盖：
 *   1. putThread → lookup 同 thread 命中
 *   2. clearThread（模拟换 thread）→ lookup 不命中
 *   3. always 与 thread 同 key 并存 → always 优先
 */

import { describe, it, expect } from 'vitest';
import { judge } from '@tabtin/security-policy';
import type { EffectivePolicy, JudgeTool } from '@tabtin/security-policy';

import { InMemoryApprovalMemoStore } from '@tabtin/agent-runtime';
import type { ApprovalMemoEntry } from '@tabtin/agent-runtime';
import { createJudgeMemoStoreAdapter } from '../src/policy/judge-memo-store-adapter.js';

function entry(decision: 'allow' | 'deny' = 'allow'): ApprovalMemoEntry {
  const now = Date.now();
  return {
    decision,
    createdAt: now,
    updatedAt: now,
    approverUserId: 'user-test',
  };
}

const shellTool: JudgeTool = {
  name: 'execute_command',
  policyActionKind: 'shell',
  extractPath: (input) => {
    const cwd = (input as { cwd?: string }).cwd;
    return typeof cwd === 'string' ? cwd : undefined;
  },
  extractSubcmd: (input) => {
    const cmd = (input as { command?: string }).command;
    if (!cmd) return undefined;
    return cmd.trim().split(/\s+/)[0];
  },
};

const policy: EffectivePolicy = {
  approvalMode: 'always_ask',
  workspace: {
    sources: {
      sandbox: '/Users/me/project',
      tabcodeProjects: [],
      tabfolderDirs: [],
      attachedFiles: [],
    },
    allowedPaths: ['/Users/me/project'],
    allowedFiles: [],
    spaceSessionId: 'thread-memo-test',
  },
  memo: { generation: 0, entries: {} },
  executionLimits: {},
  planModeGuardActive: false,
};

describe('JudgeMemoStoreAdapter.lookup — threadCache merge ', () => {
  it('1. putThread → lookup hits memo_allow in same thread', () => {
    const inner = new InMemoryApprovalMemoStore();
    const adapter = createJudgeMemoStoreAdapter(inner);
    const patternKey = 'execute_command::npm:workspace-internal';

    inner.putThread(patternKey, entry('allow'));

    const decision = judge({
      tool: shellTool,
      input: { command: 'npm install', cwd: '/Users/me/project' },
      effectivePolicy: policy,
      memoStore: adapter,
      homeDir: '/Users/me',
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.reason.type).toBe('memo_allow');
    expect(decision.reason).toMatchObject({ key: patternKey });
  });

  it('2. clearThread simulates new thread → thread memo no longer hits', () => {
    const inner = new InMemoryApprovalMemoStore();
    const adapter = createJudgeMemoStoreAdapter(inner);
    const patternKey = 'execute_command::npm:workspace-internal';

    inner.putThread(patternKey, entry('allow'));
    inner.clearThread();

    const decision = judge({
      tool: shellTool,
      input: { command: 'npm install', cwd: '/Users/me/project' },
      effectivePolicy: policy,
      memoStore: adapter,
      homeDir: '/Users/me',
    });

    expect(decision.reason.type).not.toBe('memo_allow');
    // cwd 在工作区内时 shell 走 workspace_in 自动放行——验证点是 thread memo 已清
    expect(decision.reason.type).toBe('workspace_in');
  });

  it('3. same key in thread + always → always wins (deny over thread allow)', () => {
    const inner = new InMemoryApprovalMemoStore();
    const adapter = createJudgeMemoStoreAdapter(inner);
    const patternKey = 'execute_command::npm:workspace-internal';

    inner.putThread(patternKey, entry('allow'));
    inner.putAlways(patternKey, entry('deny'));

    const decision = judge({
      tool: shellTool,
      input: { command: 'npm install', cwd: '/Users/me/project' },
      effectivePolicy: policy,
      memoStore: adapter,
      homeDir: '/Users/me',
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.reason.type).toBe('memo_deny');
  });

  it('4. always-only still hits when thread cache is empty', () => {
    const inner = new InMemoryApprovalMemoStore();
    const adapter = createJudgeMemoStoreAdapter(inner);
    const patternKey = 'execute_command::npm:workspace-internal';

    inner.putAlways(patternKey, entry('allow'));

    const decision = judge({
      tool: shellTool,
      input: { command: 'npm install', cwd: '/Users/me/project' },
      effectivePolicy: policy,
      memoStore: adapter,
      homeDir: '/Users/me',
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.reason.type).toBe('memo_allow');
  });
});
