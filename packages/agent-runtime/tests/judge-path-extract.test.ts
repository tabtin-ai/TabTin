import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractJudgePath } from '../src/engine/tooling/judge-path-extract.js';

const WORKSPACE_ROOT = '/Users/me/ws';

describe('extractJudgePath · ', () => {
  it('file 类省略目录时回落到 workspaceRoot', () => {
    expect(
      extractJudgePath(
        { policyActionKind: 'file' },
        { glob_pattern: '*' },
        WORKSPACE_ROOT,
      ),
    ).toBe(WORKSPACE_ROOT);
  });

  it('相对路径按 workspaceRoot 收成绝对路径', () => {
    expect(
      extractJudgePath(
        { policyActionKind: 'file' },
        { path: 'src/foo.ts' },
        WORKSPACE_ROOT,
      ),
    ).toBe(path.resolve(WORKSPACE_ROOT, 'src/foo.ts'));
  });

  it('显式区外绝对路径保持原样', () => {
    expect(
      extractJudgePath(
        { policyActionKind: 'file' },
        { path: '/tmp/outside.txt' },
        WORKSPACE_ROOT,
      ),
    ).toBe('/tmp/outside.txt');
  });

  it('工具自报 extractPath 的相对路径也会按 workspaceRoot 解析', () => {
    expect(
      extractJudgePath(
        {
          policyActionKind: 'file',
          extractPath: () => 'attachments',
        },
        { file_id: 'file-1' },
        WORKSPACE_ROOT,
      ),
    ).toBe(path.resolve(WORKSPACE_ROOT, 'attachments'));
  });

  it('同时声明时优先 extractPath 而不是 extractPolicyParams', () => {
    expect(
      extractJudgePath(
        {
          policyActionKind: 'file',
          extractPath: () => 'from-extract-path',
          extractPolicyParams: () => ({ path: 'from-policy-params' }),
        },
        {},
        WORKSPACE_ROOT,
      ),
    ).toBe(path.resolve(WORKSPACE_ROOT, 'from-extract-path'));
  });

  it('非 file 类省略路径时不回落 workspaceRoot', () => {
    expect(
      extractJudgePath(
        { policyActionKind: 'object' },
        { query: 'x' },
        WORKSPACE_ROOT,
      ),
    ).toBeUndefined();
  });

  it('tilde 路径留给 normalize 展开，不在这里拼 workspace', () => {
    expect(
      extractJudgePath(
        { policyActionKind: 'file' },
        { path: '~/Desktop/a' },
        WORKSPACE_ROOT,
      ),
    ).toBe('~/Desktop/a');
  });
});
