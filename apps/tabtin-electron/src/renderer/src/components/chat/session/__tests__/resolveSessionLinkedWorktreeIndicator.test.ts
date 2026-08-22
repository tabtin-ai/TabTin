import { describe, expect, it } from 'vitest'
import { resolveSessionLinkedWorktreeIndicator } from '../resolveSessionLinkedWorktreeIndicator'

const main = { path: '/repo/TabTin', branch: 'main' }
const linked = { path: '/worktrees/TabTin/feat-x', branch: 'feat/x' }

describe('resolveSessionLinkedWorktreeIndicator', () => {
  it('无 binding 时不显示', () => {
    expect(resolveSessionLinkedWorktreeIndicator({
      binding: null,
      worktrees: [main, linked],
    })).toBeNull()
  })

  it('非 active 绑定不显示', () => {
    expect(resolveSessionLinkedWorktreeIndicator({
      binding: { rootPath: linked.path, status: 'path_missing', branch: 'feat/x' },
      worktrees: [main, linked],
    })).toBeNull()
  })

  it('主工作树绑定不显示', () => {
    expect(resolveSessionLinkedWorktreeIndicator({
      binding: { rootPath: main.path, status: 'active', branch: 'main' },
      worktrees: [main, linked],
    })).toBeNull()
  })

  it('路径不在 worktree 列表中不显示', () => {
    expect(resolveSessionLinkedWorktreeIndicator({
      binding: { rootPath: '/tmp/other', status: 'active' },
      worktrees: [main, linked],
    })).toBeNull()
  })

  it('linked worktree 显示 branch 与 path', () => {
    expect(resolveSessionLinkedWorktreeIndicator({
      binding: { rootPath: `${linked.path}/`, status: 'active', branch: 'feat/x' },
      worktrees: [main, linked],
    })).toEqual({
      kind: 'linked',
      branch: 'feat/x',
      path: `${linked.path}/`,
    })
  })

  it('binding 无 branch 时回退 worktree list 的 branch', () => {
    expect(resolveSessionLinkedWorktreeIndicator({
      binding: { rootPath: linked.path, status: 'active', branch: null },
      worktrees: [main, linked],
    })).toEqual({
      kind: 'linked',
      branch: 'feat/x',
      path: linked.path,
    })
  })

  it('worktrees 为空时不显示', () => {
    expect(resolveSessionLinkedWorktreeIndicator({
      binding: { rootPath: linked.path, status: 'active' },
      worktrees: [],
    })).toBeNull()
  })
})
