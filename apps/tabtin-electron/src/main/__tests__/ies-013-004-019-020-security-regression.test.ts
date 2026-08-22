/**
 * IES-013 / IES-004 / IES-019 / IES-020 回归测试
 *
 * IES-013: git IPC 必须接 path-access-checker（Wave 2 起）做路径权限判定，
 *          checker 拒绝时 git:showFile / git:showStaged / git:rawDiff 返回
 *          "invalid file path"，且不继续执行更宽泛的 git 命令。
 *          —— 老语义"isPathSafe + PathRuleSet 双重检查"已被 path-access-checker
 *          单源化收敛（路径权限治理 Wave 2）。
 * IES-019: chat:reportDetachedState 必须验证 sender 来源
 * IES-020: agent:log-action-result 必须验证 sender 来源
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════
//  Part 1: IES-013 — git IPC 接 path-access-checker
// ═══════════════════════════════════════════════════

const gitMocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'home') return '/tmp/home'
    return '/tmp'
  }),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  execFileAsync: vi.fn(),
  resolveSpacesRoot: vi.fn(() => '/tmp/sandbox'),
  isTrustedSender: vi.fn(() => true),
  pathAccessCheck: vi.fn(() => ({ allowed: true })),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}))

vi.mock('electron', () => ({
  app: { getPath: gitMocks.getPath },
  ipcMain: {
    handle: gitMocks.handle,
    removeHandler: gitMocks.removeHandler,
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}))

vi.mock('child_process', () => {
  const execFile = vi.fn()
  return { execFile, default: { execFile } }
})

vi.mock('util', () => ({
  promisify: () => gitMocks.execFileAsync,
  default: { promisify: () => gitMocks.execFileAsync },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: { ...actual, statSync: gitMocks.statSync },
    statSync: gitMocks.statSync,
  }
})

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: gitMocks.resolveSpacesRoot,
  matchSensitivePath: vi.fn(() => null),
}))

vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: gitMocks.pathAccessCheck,
  }),
}))

vi.mock('../auth', () => ({
  isTrustedSender: gitMocks.isTrustedSender,
}))

import { registerGitIpcHandlers } from '../git-ipc'

function getGitHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = gitMocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

describe('IES-013: git IPC 接 path-access-checker（Wave 2 单源化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gitMocks.statSync.mockReturnValue({ isDirectory: () => true })
    gitMocks.pathAccessCheck.mockReturnValue({ allowed: true })
    gitMocks.isTrustedSender.mockReturnValue(true)
    registerGitIpcHandlers()
  })

  describe('git:showFile', () => {
    it('path-access-checker 拒绝目标文件 → 返回 "invalid file path"', async () => {
      // validateCwd 第 1 次 check（cwd） → allow；第 2 次（fullPath） → deny
      gitMocks.pathAccessCheck
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({
          allowed: false,
          reason: { reasonCode: 'outside_workspace', message: 'denied' },
        })

      const handler = getGitHandler('git:showFile')
      const result = (await handler(
        { senderFrame: { url: 'file:///app/index.html' } },
        '/tmp/home/project',
        'src/index.ts',
      )) as any

      expect(result.error).toBe('invalid file path')
      expect(gitMocks.execFileAsync).not.toHaveBeenCalled()
    })

    it('path-access-checker 全部 allow 时应正常返回', async () => {
      gitMocks.pathAccessCheck.mockReturnValue({ allowed: true })
      gitMocks.execFileAsync.mockResolvedValueOnce({ stdout: 'file-content' })

      const handler = getGitHandler('git:showFile')
      const result = (await handler(
        { senderFrame: { url: 'file:///app/index.html' } },
        '/tmp/home/project',
        'src/index.ts',
      )) as any

      expect(result.success).toBe(true)
      expect(result.content).toBe('file-content')
    })

    it('Windows 风格相对路径传给 git tree 时使用 POSIX 分隔符', async () => {
      gitMocks.pathAccessCheck.mockReturnValue({ allowed: true })
      gitMocks.execFileAsync.mockResolvedValueOnce({ stdout: 'file-content' })

      const handler = getGitHandler('git:showFile')
      await handler(
        { senderFrame: { url: 'file:///app/index.html' } },
        '/tmp/home/project',
        'src\\nested\\file.ts',
      )

      expect(gitMocks.execFileAsync).toHaveBeenCalledWith(
        'git',
        ['cat-file', 'blob', 'HEAD:src/nested/file.ts'],
        expect.objectContaining({ cwd: '/tmp/home/project' }),
      )
    })
  })

  describe('git:showStaged', () => {
    it('path-access-checker 拒绝目标文件 → 返回 "invalid file path"', async () => {
      gitMocks.pathAccessCheck
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({
          allowed: false,
          reason: { reasonCode: 'outside_workspace', message: 'denied' },
        })

      const handler = getGitHandler('git:showStaged')
      const result = (await handler(
        { senderFrame: { url: 'file:///app/index.html' } },
        '/tmp/home/project',
        'src/app.ts',
      )) as any

      expect(result.error).toBe('invalid file path')
      expect(gitMocks.execFileAsync).not.toHaveBeenCalled()
    })
  })

  describe('git:rawDiff', () => {
    it('path-access-checker 拒绝某个文件参数 → 返回 "invalid file path"', async () => {
      gitMocks.pathAccessCheck
        .mockReturnValueOnce({ allowed: true })   // validateCwd
        .mockReturnValueOnce({
          allowed: false,                          // 单个文件参数
          reason: { reasonCode: 'outside_workspace', message: 'denied' },
        })

      const handler = getGitHandler('git:rawDiff')
      const result = (await handler(
        { senderFrame: { url: 'file:///app/index.html' } },
        '/tmp/home/project',
        ['some/outside/file.txt'],
      )) as any

      expect(result.error).toBe('invalid file path')
      expect(gitMocks.execFileAsync).not.toHaveBeenCalled()
    })
  })
})

// ═══════════════════════════════════════════════════
//  Part 2: IES-004 / IES-019 / IES-020 — ipc-registry sender 验证
// ═══════════════════════════════════════════════════

describe('IES-004 / IES-019 / IES-020: ipc-registry sender 来源验证', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('node:fs') as typeof import('fs')
  const nodePath = require('node:path') as typeof import('path')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const ipcRegistrySource = nodeFs.readFileSync(
    nodePath.resolve(__dirname, '../ipc-registry.ts'),
    'utf-8',
  )

  it('IES-020: agent:log-action-result 使用 guardedOn 安全封装', () => {
    expect(ipcRegistrySource).toMatch(/guardedOn\(\s*'agent:log-action-result'[\s\S]*action-result:/)
  })
})
