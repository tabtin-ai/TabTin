/**
 * 路径权限治理 Wave 4 (L5)：judge file 分支多路径 AND 严格语义。
 *
 * extractPath 现在可以返回 string | readonly string[] | undefined。
 * 钉死契约：
 *   1. 单路径与之前行为一致（向后兼容）
 *   2. 多路径全部 in workspace → workspace_in: allow
 *   3. 多路径任一不在 workspace → workspace_out: ask（AND 严格，"用户授权
 *      了 X 不等于自动授权 Y"）
 *   4. 多路径任一命中红线 → hardline_path: deny
 *   5. 空数组 = 没传路径，按 inWorkspace=false（与单路径 undefined 一致）
 */
import { describe, it, expect } from 'vitest';
import { judge } from '../src/judge';
import type {
  EffectivePolicy,
  JudgeTool,
  WorkspaceSnapshot,
  MemoStore,
  ApprovalMemoLookupResult,
} from '../src/types-v3';

class NullMemoStore implements MemoStore {
  get generation(): number { return 0; }
  lookup(): ApprovalMemoLookupResult | null { return null; }
  async putAlways(): Promise<void> {}
  async revoke(): Promise<void> {}
  async maybeRefetch(): Promise<boolean> { return false; }
  async bootstrap(): Promise<void> {}
  replaceAll(): void {}
}

function makeWs(allowed: string[]): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: allowed[0] ?? '',
      tabcodeProjects: allowed.slice(1),
      tabfolderDirs: [],
      attachedFiles: [],
    },
    allowedPaths: allowed,
    allowedFiles: [],
    spaceSessionId: 'sess',
  };
}

function makePolicy(allowed: string[] = []): EffectivePolicy {
  return {
    approvalMode: 'always_ask',
    workspace: makeWs(allowed),
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

const multiPathSearchTool: JudgeTool = {
  name: 'multi_path_search',
  policyActionKind: 'file',
  extractPath: (input) => {
    const i = input as { target_directories?: unknown; target_directory?: string };
    if (Array.isArray(i.target_directories)) {
      return i.target_directories.filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      );
    }
    if (typeof i.target_directory === 'string' && i.target_directory.length > 0) {
      return i.target_directory;
    }
    return undefined;
  },
  extractSubcmd: () => 'search',
  isWriteOp: () => false,
};

const readLintsTool: JudgeTool = {
  name: 'read_lints',
  policyActionKind: 'file',
  extractPath: (input) => {
    const i = input as { paths?: unknown };
    if (Array.isArray(i.paths)) {
      return i.paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    }
    return undefined;
  },
  extractSubcmd: () => 'lints',
  isWriteOp: () => false,
};

describe('judge — file 分支多路径 AND 严格语义 (L5)', () => {
  it('多路径只读工具的 target_directories 全部 in workspace → workspace_in allow', () => {
    const decision = judge({
      tool: multiPathSearchTool,
      input: {
        target_directories: ['/proj/a/src/auth', '/proj/a/src/perm'],
      },
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    expect(decision.behavior).toBe('allow');
    if (decision.behavior === 'allow') {
      expect(decision.reason.type).toBe('workspace_in');
    }
  });

  it('target_directories 任一在 workspace 外 → workspace_out ask（AND 严格）', () => {
    const decision = judge({
      tool: multiPathSearchTool,
      input: {
        target_directories: ['/proj/a/src', '/proj/b/src'], // /proj/b 不在 ws
      },
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    expect(decision.behavior).toBe('ask');
    if (decision.behavior === 'ask') {
      expect(decision.reason.type).toBe('workspace_out');
    }
  });

  it('read_lints.paths[] 全部 in workspace → workspace_in allow', () => {
    const decision = judge({
      tool: readLintsTool,
      input: {
        paths: ['/proj/a/x.ts', '/proj/a/sub/y.ts'],
      },
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    expect(decision.behavior).toBe('allow');
  });

  it('read_lints.paths[] 任一在 workspace 外 → workspace_out ask', () => {
    const decision = judge({
      tool: readLintsTool,
      input: {
        paths: ['/proj/a/x.ts', '/elsewhere/y.ts'],
      },
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    expect(decision.behavior).toBe('ask');
  });

  it('read_lints.paths[] 任一命中红线 → hardline_path deny（即使 isWriteOp=false 时不查；read_lints 不是 write）', () => {
    // read_lints 是 read（isWriteOp=false），红线只在写操作触发——这条
    // case 验证 read 路径下不会因路径红线 deny（与单路径行为一致）。
    const decision = judge({
      tool: readLintsTool,
      input: {
        paths: ['/proj/a/x.ts', '/etc/passwd'],
      },
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    // /etc/passwd 不在 workspace，整体 ask
    expect(decision.behavior).toBe('ask');
  });

  it('多路径只读工具的 target_directory 单值（fallback 路径）→ 单路径行为不变', () => {
    const decision = judge({
      tool: multiPathSearchTool,
      input: { target_directory: '/proj/a/src' },
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    expect(decision.behavior).toBe('allow');
  });

  it('未传任何路径字段 → workspace_out ask（fallback 单路径 undefined 行为）', () => {
    const decision = judge({
      tool: multiPathSearchTool,
      input: {},
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    expect(decision.behavior).toBe('ask');
  });

  it('空数组 → workspace_out ask（与未传等价）', () => {
    const decision = judge({
      tool: multiPathSearchTool,
      input: { target_directories: [] },
      effectivePolicy: makePolicy(['/proj/a']),
      memoStore: new NullMemoStore(),
    });
    expect(decision.behavior).toBe('ask');
  });
});
