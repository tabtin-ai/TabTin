/**
 * EEL-012 回归测试
 *
 * 验证 13 个 git 只读 IPC channel 均经 guardedHandle 来源验证，
 * 外部 WebContents 无法探测用户 git 历史、分支、diff 内容。
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
  isTrustedSender: vi.fn(),
  // 路径权限治理 Wave 2：git IPC 接 path-access-checker 替代老
  // isPathSafe / PathRuleSet。本测试只关心 sender 验证，path 默认放行。
  pathAccessCheck: vi.fn(() => ({ allowed: true })),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
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

vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: mocks.pathAccessCheck,
  }),
}))

vi.mock('../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../git-index-lock-diagnostics', () => ({
  INDEX_LOCK_STALE_THRESHOLD_MS: 300_000,
  collectGitIndexLockDiagnostics: vi.fn(async () => ({
    lockState: 'missing',
    activeGitProcessCount: 0,
    processProbe: 'ok',
    processScope: 'system-wide',
  })),
  isStaleIndexLockCandidate: vi.fn(() => false),
  tryRemoveStaleIndexLock: vi.fn(async () => ({
    removed: false,
    staleLockCandidate: false,
  })),
}))

import { registerGitIpcHandlers } from '../git-ipc'

// Wave 0 contract: guardedHandle 改返 envelope 形状 ({ok, error.code/message})。
const UNTRUSTED_ERROR = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
}

const GIT_READONLY_CHANNELS = [
  'git:isRepo',
  'git:branch',
  'git:branchMeta',
  'git:branches',
  'git:status',
  'git:diffStat',
  'git:showFile',
  'git:showStaged',
  'git:rawDiff',
  'git:remotes',
  'git:pullRequestUrl',
  'git:worktrees',
  'git:fullStatus',
]

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

describe('EEL-012: git 只读 IPC channel guardedHandle 来源验证', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    mocks.isTrustedSender.mockReturnValue(true)
    registerGitIpcHandlers()
  })

  for (const channel of GIT_READONLY_CHANNELS) {
    it(`${channel}: 不可信来源（外部页面）被拒绝`, async () => {
      mocks.isTrustedSender.mockReturnValue(false)
      const handler = getHandler(channel)
      const event = { senderFrame: { url: 'https://evil.com/probe' } }
      const result = await handler(event, '/tmp/home/project')
      // W1 D3：envelope 自动 stamp per-call trace_id
      expect(result).toMatchObject(UNTRUSTED_ERROR)
      expect(result).toHaveProperty('trace_id')
    })

    it(`${channel}: 可信来源正常通过（不返回 UNTRUSTED_ERROR）`, async () => {
      mocks.isTrustedSender.mockReturnValue(true)
      mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
      const handler = getHandler(channel)
      const event = { senderFrame: { url: 'file:///app/index.html' } }
      const result = await handler(event, '/tmp/home/project') as any
      expect(result).not.toEqual(UNTRUSTED_ERROR)
    })
  }

  it('所有 13 个 channel 均已注册并包含来源检查', () => {
    for (const channel of GIT_READONLY_CHANNELS) {
      const handler = getHandler(channel)
      expect(handler).toBeDefined()
    }
    expect(GIT_READONLY_CHANNELS).toHaveLength(13)
  })
})
