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

const MAIN = '/tmp/home/project'
const SOURCE = '/tmp/home/project-source'
const TARGET = '/tmp/home/project-target'

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((candidate: unknown[]) => candidate[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

function worktreeList(): string {
  return [
    `worktree ${MAIN}`,
    'HEAD abc123def456',
    'branch refs/heads/main',
    '',
    `worktree ${SOURCE}`,
    'HEAD abc123def456',
    'branch refs/heads/feat/source',
    '',
    `worktree ${TARGET}`,
    'HEAD abc123def456',
    'branch refs/heads/release',
    '',
  ].join('\n')
}

describe('git destructive actions fail closed when working tree status is unknown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerGitIpcHandlers()
  })

  it('does not checkout when the working tree status cannot be read', async () => {
    mocks.execFileAsync.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') {
        throw new Error('unable to read index')
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`)
    })

    const result = await getHandler('git:checkout')({}, MAIN, { branch: 'release' })

    expect(result).toMatchObject({
      success: false,
      code: 'WORKING_TREE_UNKNOWN',
      error: 'unable to determine whether the working tree is clean',
    })
    expect(mocks.execFileAsync).not.toHaveBeenCalledWith(
      'git',
      ['checkout', 'release'],
      expect.anything(),
    )
  })

  it('does not merge when the source working tree status cannot be read', async () => {
    mocks.execFileAsync.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command !== 'git') throw new Error(`unexpected ${command}`)
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${MAIN}\n`, stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList(), stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'feat/source\n', stderr: '' }
      }
      if (args[0] === 'status' && options?.cwd === SOURCE) {
        throw new Error('unable to read source index')
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    const result = await getHandler('git:worktreeMerge')({}, MAIN, {
      sourceWorktreePath: SOURCE,
      targetBranch: 'release',
    })

    expect(result).toMatchObject({
      success: false,
      code: 'WORKING_TREE_UNKNOWN',
      error: 'unable to determine whether the source worktree is clean',
    })
    expect(mocks.execFileAsync).not.toHaveBeenCalledWith(
      'git',
      ['merge', 'feat/source', '--no-edit'],
      expect.anything(),
    )
  })

  it('does not merge when the target working tree status cannot be read', async () => {
    mocks.execFileAsync.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command !== 'git') throw new Error(`unexpected ${command}`)
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${MAIN}\n`, stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList(), stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'feat/source\n', stderr: '' }
      }
      if (args[0] === 'status' && options?.cwd === SOURCE) {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'status' && options?.cwd === TARGET) {
        throw new Error('unable to read target index')
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    const result = await getHandler('git:worktreeMerge')({}, MAIN, {
      sourceWorktreePath: SOURCE,
      targetBranch: 'release',
    })

    expect(result).toMatchObject({
      success: false,
      code: 'WORKING_TREE_UNKNOWN',
      error: 'unable to determine whether the target worktree is clean',
    })
    expect(mocks.execFileAsync).not.toHaveBeenCalledWith(
      'git',
      ['merge', 'feat/source', '--no-edit'],
      expect.anything(),
    )
  })
})
