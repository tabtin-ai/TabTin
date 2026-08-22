/**
 * EEL-016 / EEL-017 / EEL-025 回归测试
 *
 * EEL-016: git:rawDiff 路径过滤应使用 NFC 规范化比较，防止 Unicode 绕过
 * EEL-017: git:worktreeMerge 应对 source/target worktree 路径做 path-access-checker 校验
 * EEL-025: git:checkout 应阻断以 '-' 开头的分支名和含 '..' / '@{' 的特殊序列
 *
 * 历史版本：原文件含 EEL-014（git Space deny paths cache）测试，验证
 * `updateGitSpaceDenyPaths` / `resetGitSpaceDenyPaths` 行为。这俩是 O8
 * 死代码（无生产 caller），路径权限治理 Wave 2 已删除——本文件随之
 * 移除 EEL-014 部分。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'home') return '/tmp/home'
    return '/tmp'
  }),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  execFileAsync: vi.fn(),
  resolveSpacesRoot: vi.fn(() => '/tmp/sandbox'),
  isTrustedSender: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  pathAccessCheck: vi.fn(() => ({ allowed: true })),
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler,
  },
}))

vi.mock('child_process', () => {
  const execFile = vi.fn()
  return { execFile, default: { execFile } }
})

vi.mock('util', () => ({
  promisify: () => mocks.execFileAsync,
  default: { promisify: () => mocks.execFileAsync },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: { ...actual, statSync: mocks.statSync },
    statSync: mocks.statSync,
  }
})

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: mocks.resolveSpacesRoot,
  matchSensitivePath: vi.fn(() => null),
}))

// path-access-checker 替代了原 isPathAllowed / isPathSafe / getGitAllowedDirs
// 一整套老 helper。Wave 2 起 git IPC handler 全部 import
// `getDefaultPathAccessChecker` 调 `.check()` 做权限判定。
vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: mocks.pathAccessCheck,
  }),
}))

vi.mock('../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

import { registerGitIpcHandlers } from '../git-ipc'

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

// ───── EEL-016 ─────

describe('EEL-016: rawDiff Unicode normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerGitIpcHandlers()
  })

  it('NFC 与 NFD 编码的相同路径应被正确识别为 cwd 内部路径', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: 'diff-output' })
    const handler = getHandler('git:rawDiff')

    const nfcPath = 'caf\u00e9.txt'
    await handler({}, '/tmp/home/project', [nfcPath])

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', nfcPath],
      expect.objectContaining({ cwd: '/tmp/home/project' }),
    )
  })

  it('NFD 编码的路径也应通过 NFC 规范化后正确比较', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: 'diff-output' })
    const handler = getHandler('git:rawDiff')

    const nfdPath = 'cafe\u0301.txt'
    await handler({}, '/tmp/home/project', [nfdPath])

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['diff', nfdPath]),
      expect.objectContaining({ cwd: '/tmp/home/project' }),
    )
  })

  it('pathspec 分隔符后的 dash 开头文件名应按路径处理', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: 'diff-output' })
    const handler = getHandler('git:rawDiff')

    await handler({}, '/tmp/home/project', ['--', '-weird.txt'])

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--', '-weird.txt'],
      expect.objectContaining({ cwd: '/tmp/home/project' }),
    )
  })

  it('应仍然阻断越界路径，且不退化成全仓 diff', async () => {
    const handler = getHandler('git:rawDiff')

    const result = await handler({}, '/tmp/home/project', ['../../etc/passwd']) as { success?: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toBe('invalid file path')
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })
})

// ───── EEL-017 ─────

describe('EEL-017: worktreeMerge path validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerGitIpcHandlers()
  })

  const WORKTREE_LIST_OUTPUT = [
    'worktree /tmp/home/project',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /tmp/home/feature-wt',
    'HEAD def456',
    'branch refs/heads/feature',
    '',
  ].join('\n')

  it('应阻断 source worktree path 不在 allowed dirs 内的情况', async () => {
    mocks.execFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: '/tmp/home/project\n' }
      if (args.includes('--porcelain') && args.includes('list')) {
        return {
          stdout: [
            'worktree /tmp/home/project',
            'HEAD abc123',
            'branch refs/heads/main',
            '',
            'worktree /evil/outside/path',
            'HEAD def456',
            'branch refs/heads/feature',
            '',
          ].join('\n'),
        }
      }
      return { stdout: '' }
    })

    // path-access-checker 对 /evil/* 拒绝
    mocks.pathAccessCheck.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('evil')) {
        return { allowed: false, reason: { reasonCode: 'outside_workspace', message: 'denied' } }
      }
      return { allowed: true }
    })

    const handler = getHandler('git:worktreeMerge')
    const result = (await handler({}, '/tmp/home/project', {
      sourceWorktreePath: '/evil/outside/path',
      targetBranch: 'main',
    })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('not accessible')
  })

  it('应阻断 target worktree path 不在 allowed dirs 内的情况', async () => {
    mocks.execFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: '/tmp/home/project\n' }
      if (args.includes('--porcelain') && args.includes('list')) {
        return {
          stdout: [
            'worktree /evil/target/path',
            'HEAD abc123',
            'branch refs/heads/main',
            '',
            'worktree /tmp/home/feature-wt',
            'HEAD def456',
            'branch refs/heads/feature',
            '',
          ].join('\n'),
        }
      }
      return { stdout: '' }
    })

    mocks.pathAccessCheck.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('evil')) {
        return { allowed: false, reason: { reasonCode: 'outside_workspace', message: 'denied' } }
      }
      return { allowed: true }
    })

    const handler = getHandler('git:worktreeMerge')
    const result = (await handler({}, '/tmp/home/project', {
      sourceWorktreePath: '/tmp/home/feature-wt',
      targetBranch: 'main',
    })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('not accessible')
  })

  it('应放行两个 worktree path 都在 allowed dirs 内的情况', async () => {
    mocks.execFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: '/tmp/home/project\n' }
      if (args.includes('--porcelain') && args.includes('list')) {
        return { stdout: WORKTREE_LIST_OUTPUT }
      }
      if (args.includes('--abbrev-ref')) return { stdout: 'feature\n' }
      if (args.includes('--porcelain=v1')) return { stdout: '' }
      if (args.includes('merge')) return { stdout: '' }
      if (args.includes('--short')) return { stdout: 'abc123\n' }
      return { stdout: '' }
    })

    const handler = getHandler('git:worktreeMerge')
    const result = (await handler({}, '/tmp/home/project', {
      sourceWorktreePath: '/tmp/home/feature-wt',
      targetBranch: 'main',
    })) as any

    expect(result.success).toBe(true)
  })

  it('NFC 与 NFD 编码的 worktree 路径应匹配（macOS HFS+ 兼容）', async () => {
    const nfcPath = '/tmp/home/caf\u00e9-wt'
    const nfdPath = '/tmp/home/cafe\u0301-wt'

    mocks.execFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: '/tmp/home/project\n' }
      if (args.includes('--porcelain') && args.includes('list')) {
        return {
          stdout: [
            'worktree /tmp/home/project',
            'HEAD abc123',
            'branch refs/heads/main',
            '',
            `worktree ${nfdPath}`,
            'HEAD def456',
            'branch refs/heads/feature',
            '',
          ].join('\n'),
        }
      }
      if (args.includes('--abbrev-ref')) return { stdout: 'feature\n' }
      if (args.includes('--porcelain=v1')) return { stdout: '' }
      if (args.includes('merge')) return { stdout: '' }
      if (args.includes('--short')) return { stdout: 'abc123\n' }
      return { stdout: '' }
    })

    const handler = getHandler('git:worktreeMerge')
    const result = (await handler({}, '/tmp/home/project', {
      sourceWorktreePath: nfcPath,
      targetBranch: 'main',
    })) as any

    expect(result.success).toBe(true)
  })
})

// ───── EEL-025 ─────

describe('EEL-025: checkout branch name injection prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerGitIpcHandlers()
  })

  it('应阻断以 "-" 开头的分支名（git flag 注入）', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: '--help' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('应阻断含 ".." 的分支名', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'main..HEAD' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断含 "@{" 的分支名（git reflog 语法）', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'HEAD@{1}' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断含控制字符的分支名', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'branch\x00name' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断含 "~" 的分支名', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'HEAD~1' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断含 "^" 的分支名', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'HEAD^2' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断含 ":" 的分支名', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'refs:heads/main' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断以 ".lock" 结尾的分支名', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'branch.lock' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断含空格的分支名', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'my branch' })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid branch name')
  })

  it('应阻断不安全的 startPoint 参数', async () => {
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', {
      branch: 'new-branch',
      create: true,
      startPoint: '--exec=malicious',
    })) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid startPoint')
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('应放行合法分支名', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'feature/my-branch-123' })) as any

    expect(result.success).toBe(true)
  })

  it('应放行包含 "/" 和 "-" 的合法分支名', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', { branch: 'feat/add-new-api' })) as any

    expect(result.success).toBe(true)
  })

  it('应放行带合法 startPoint 的分支创建', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
    const handler = getHandler('git:checkout')
    const result = (await handler({}, '/tmp/home/project', {
      branch: 'new-feat',
      create: true,
      startPoint: 'origin/main',
    })) as any

    expect(result.success).toBe(true)
  })
})
