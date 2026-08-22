import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  execFileAsync: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/home' },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: vi.fn(),
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
    default: { ...actual, statSync: () => ({ isDirectory: () => true }) },
    statSync: () => ({ isDirectory: () => true }),
  }
})

vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: () => ({ allowed: true }),
  }),
}))

vi.mock('../auth', () => ({
  isTrustedSender: () => true,
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

import { registerGitIpcHandlers } from '../git-ipc'

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((candidate: unknown[]) => candidate[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

function mockBranchAheadWithUntrackedFile() {
  mocks.execFileAsync
    .mockResolvedValueOnce({
      stdout: [
        '# branch.oid abc123',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +1 -0',
      ].join('\n'),
      stderr: '',
    })
    .mockResolvedValueOnce({ stdout: '?? temp1.js\n', stderr: '' })
}

describe('git push dirty-worktree policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerGitIpcHandlers()
  })

  it('允许调用方在保留未跟踪文件时推送已有提交', async () => {
    mockBranchAheadWithUntrackedFile()
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' })

    const result = await getHandler('git:push')({}, '/tmp/home/project', {
      remote: 'origin',
      branch: 'main',
      allowDirty: true,
    })

    expect(result).toEqual({ success: true })
    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(
      3,
      'git',
      ['push', 'origin', 'main'],
      expect.objectContaining({ cwd: '/tmp/home/project' }),
    )
  })

  it('默认仍阻止脏工作区推送', async () => {
    mockBranchAheadWithUntrackedFile()

    const result = await getHandler('git:push')({}, '/tmp/home/project', {
      remote: 'origin',
      branch: 'main',
    })

    expect(result).toMatchObject({
      success: false,
      code: 'WORKING_TREE_DIRTY',
      error: 'working tree has uncommitted changes, push blocked by policy',
    })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(2)
  })

  it('marks behind-upstream separately from a missing upstream', async () => {
    mocks.execFileAsync
      .mockResolvedValueOnce({
        stdout: [
          '# branch.oid abc123',
          '# branch.head main',
          '# branch.upstream origin/main',
          '# branch.ab +1 -2',
        ].join('\n'),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const result = await getHandler('git:push')({}, '/tmp/home/project', {
      remote: 'origin',
      branch: 'main',
    })

    expect(result).toMatchObject({
      success: false,
      code: 'BEHIND_UPSTREAM',
      error: 'branch is behind upstream by 2 commit(s), please pull/rebase first',
    })
  })
})
