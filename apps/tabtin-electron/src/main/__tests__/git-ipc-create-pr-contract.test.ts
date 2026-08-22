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

describe('git createPullRequest structured contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerGitIpcHandlers()
  })

  it('returns CLI_MISSING when GitHub CLI is not installed', async () => {
    mocks.execFileAsync.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'remote') {
        return {
          stdout: [
            'origin\tgit@github.com:acme/demo.git (fetch)',
            'origin\tgit@github.com:acme/demo.git (push)',
          ].join('\n'),
          stderr: '',
        }
      }
      if (command === 'git' && args[0] === 'push') {
        return { stdout: '', stderr: '' }
      }
      if (command === 'git' && args[0] === 'diff') {
        throw new Error('no diff')
      }
      if (command === 'gh' && args[0] === '--version') {
        throw new Error('gh: command not found')
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`)
    })

    const result = await getHandler('git:createPullRequest')({}, '/tmp/home/project', {
      remote: 'origin',
      baseBranch: 'main',
      headBranch: 'feat/demo',
      title: 'demo',
    })

    expect(result).toMatchObject({
      success: false,
      code: 'CLI_MISSING',
      error: 'GitHub CLI (gh) not found, please install and login first',
    })
  })
})
