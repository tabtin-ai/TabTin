import { describe, expect, it } from 'vitest'
import {
  buildCreateWorktreeArgs,
  parseWorktrees,
} from '../worktree-service'

describe('worktree-service', () => {
  it('解析 porcelain 输出并保留 current/main/locked 语义', () => {
    const result = parseWorktrees([
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/release/260812',
      '',
      'worktree /repo/feature',
      'HEAD def456',
      'branch refs/heads/feat/10498',
      'locked 正在验证',
    ].join('\n'), '/repo/feature')

    expect(result).toEqual([
      {
        path: '/repo/main',
        branch: 'release/260812',
        commitHash: 'abc123',
        isCurrent: false,
        isMainWorktree: true,
        isDetached: false,
        isBare: false,
        isLocked: false,
      },
      {
        path: '/repo/feature',
        branch: 'feat/10498',
        commitHash: 'def456',
        isCurrent: true,
        isMainWorktree: false,
        isDetached: false,
        isBare: false,
        isLocked: true,
        lockReason: '正在验证',
      },
    ])
  })

  it('为新分支和已有分支生成无 shell 拼接的参数数组', () => {
    expect(buildCreateWorktreeArgs({
      path: '/repo/wt',
      branch: 'feat/10498',
      createBranch: true,
      baseBranch: 'release/260812',
    })).toEqual([
      'worktree',
      'add',
      '-b',
      'feat/10498',
      '/repo/wt',
      'release/260812',
    ])
    expect(buildCreateWorktreeArgs({
      path: '/repo/wt-existing',
      branch: 'feat/existing',
    })).toEqual([
      'worktree',
      'add',
      '/repo/wt-existing',
      'feat/existing',
    ])
  })

  it('新分支模式缺少 branch 时拒绝', () => {
    expect(() => buildCreateWorktreeArgs({
      path: '/repo/wt',
      createBranch: true,
    })).toThrow('branch is required')
  })
})
