import { describe, expect, it } from 'vitest'
import {
  joinParentAndName,
  sanitizeWorktreeFolderName,
  slugifyBranchForWorktreePath,
  splitParentAndName,
  suggestSiblingWorktreePath,
} from './worktreePaths'

describe('slugifyBranchForWorktreePath', () => {
  it('小写化并把分隔符归一为单个 -', () => {
    expect(slugifyBranchForWorktreePath('feat/TabCode Worktree_Session.Root')).toBe(
      'feat-tabcode-worktree-session-root',
    )
  })

  it('去掉首尾多余的 -', () => {
    expect(slugifyBranchForWorktreePath('/feat/foo/')).toBe('feat-foo')
  })

  it('空分支名兜底为 branch', () => {
    expect(slugifyBranchForWorktreePath('')).toBe('branch')
    expect(slugifyBranchForWorktreePath('   ')).toBe('branch')
  })
})

describe('suggestSiblingWorktreePath', () => {
  it('默认生成 <parent>/<repo>-<branch-slug>', () => {
    expect(
      suggestSiblingWorktreePath({
        repoRoot: '/Users/me/tabtin-project/TabTin',
        branch: 'feat/foo',
      }),
    ).toBe('/Users/me/tabtin-project/TabTin-feat-foo')
  })

  it('repoRoot 带尾部斜杠时结果不受影响', () => {
    expect(
      suggestSiblingWorktreePath({
        repoRoot: '/Users/me/tabtin-project/TabTin/',
        branch: 'feat/foo',
      }),
    ).toBe('/Users/me/tabtin-project/TabTin-feat-foo')
  })

  it('冲突时依次追加 -2 -3', () => {
    const repoRoot = '/Users/me/tabtin-project/TabTin'
    const branch = 'feat/foo'
    const first = suggestSiblingWorktreePath({ repoRoot, branch })

    const second = suggestSiblingWorktreePath({
      repoRoot,
      branch,
      existingPaths: [first],
    })
    expect(second).toBe(`${first}-2`)

    const third = suggestSiblingWorktreePath({
      repoRoot,
      branch,
      existingPaths: [first, second],
    })
    expect(third).toBe(`${first}-3`)
  })

  it('existingPaths 比较忽略反斜杠与尾部斜杠差异', () => {
    const repoRoot = '/Users/me/tabtin-project/TabTin'
    const branch = 'feat/foo'
    const base = suggestSiblingWorktreePath({ repoRoot, branch })

    const next = suggestSiblingWorktreePath({
      repoRoot,
      branch,
      existingPaths: [`${base}/`],
    })
    expect(next).toBe(`${base}-2`)
  })
})

describe('splitParentAndName / joinParentAndName', () => {
  it('拆出父目录和最后一段目录名', () => {
    expect(splitParentAndName('/Users/me/project/TabTin-feat-foo')).toEqual({
      parent: '/Users/me/project',
      name: 'TabTin-feat-foo',
    })
  })

  it('目录名为空时不拼回父目录', () => {
    expect(joinParentAndName('/Users/me/project', '   ')).toBe('')
  })

  it('拼回绝对路径并去掉尾斜杠', () => {
    expect(joinParentAndName('/Users/me/project/', 'TabTin-feat-foo')).toBe(
      '/Users/me/project/TabTin-feat-foo',
    )
  })
})

describe('sanitizeWorktreeFolderName', () => {
  it('把路径分隔符换成 -，避免目录名变成多层路径', () => {
    expect(sanitizeWorktreeFolderName('foo/bar\\baz')).toBe('foo-bar-baz')
  })
})
