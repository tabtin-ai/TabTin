import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'home') return '/tmp/home'
    return '/tmp'
  }),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  execFileAsync: vi.fn(),
  isTrustedSender: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  pathAccessCheck: vi.fn((_filePath?: string, _action?: string) => ({ allowed: true })),
  collectGitIndexLockDiagnostics: vi.fn(),
  tryRemoveStaleIndexLock: vi.fn(),
  gitLog: {
    debug: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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

vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: mocks.pathAccessCheck,
  }),
}))

vi.mock('../git-index-lock-diagnostics', async () => {
  const actual = await vi.importActual<typeof import('../git-index-lock-diagnostics')>(
    '../git-index-lock-diagnostics',
  )
  return {
    ...actual,
    collectGitIndexLockDiagnostics: mocks.collectGitIndexLockDiagnostics,
    tryRemoveStaleIndexLock: mocks.tryRemoveStaleIndexLock,
  }
})

vi.mock('../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

vi.mock('../logger', () => ({
  createLogger: () => mocks.gitLog,
}))

import { registerGitIpcHandlers } from '../git-ipc'
import { INDEX_LOCK_STALE_THRESHOLD_MS } from '../git-index-lock-diagnostics'

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

describe('git IPC diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    for (const logger of Object.values(mocks.gitLog)) {
      logger.mockImplementation(() => undefined)
    }
    mocks.collectGitIndexLockDiagnostics.mockResolvedValue({
      lockState: 'present',
      lockAgeMs: INDEX_LOCK_STALE_THRESHOLD_MS + 60_000,
      lockSizeBytes: 0,
      activeGitProcessCount: 0,
      processProbe: 'ok',
      processScope: 'system-wide',
    })
    mocks.tryRemoveStaleIndexLock.mockResolvedValue({
      removed: false,
      staleLockCandidate: false,
    })
    registerGitIpcHandlers()
  })

  it('does not let logger failures change a successful Git result', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    mocks.gitLog.info.mockImplementation(() => {
      throw new Error('logger unavailable')
    })

    const handler = getHandler('git:stage')
    const result = await handler({}, '/tmp/home/project', ['sample.txt'])

    expect(result).toEqual({ success: true })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1)
  })

  it('preserves the original Git failure when warning logs throw', async () => {
    const stderr = 'fatal: pathspec did not match any files'
    mocks.execFileAsync.mockRejectedValue({ stderr })
    mocks.gitLog.warn.mockImplementation(() => {
      throw new Error('logger unavailable')
    })

    const handler = getHandler('git:stage')
    const result = await handler({}, '/tmp/home/project', ['sample.txt'])

    expect(result).toEqual({ success: false, error: stderr })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1)
  })

  it('logs redacted git:stage failures with action and path diagnostics', async () => {
    const cwd = '/tmp/home/project'
    const stderr = "fatal: cannot open '/tmp/home/project/src/App.tsx': Permission denied"
    mocks.execFileAsync.mockRejectedValueOnce({ stderr })

    const handler = getHandler('git:stage')
    const result = await handler({}, cwd, ['src/App.tsx']) as { success?: boolean; error?: string }

    expect(result).toEqual({ success: false, error: stderr })
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'git write failed',
      expect.objectContaining({
        action: 'stage',
        cwdBase: 'project',
        pathArrayProvided: true,
        rawPathCount: 1,
        cleanPathCount: 1,
        droppedPathCount: 0,
        pathMode: 'explicit',
        errorSummary: expect.stringContaining('<git-cwd>'),
      }),
    )

    const failureCall = mocks.gitLog.warn.mock.calls.find(
      (call: unknown[]) => call[0] === 'git write failed',
    )
    const diagnostics = failureCall?.[1] as Record<string, unknown>
    expect(JSON.stringify(diagnostics)).not.toContain(cwd)
    expect(JSON.stringify(diagnostics)).not.toContain('/tmp/home/project/src/App.tsx')
    expect(JSON.stringify(diagnostics)).toContain('App.tsx')
  })

  it('returns the concrete index.lock reason after retries are exhausted', async () => {
    const cwd = '/tmp/home/project'
    const stderr = [
      `fatal: Unable to create '${cwd}/.git/index.lock': File exists.`,
      'Another git process seems to be running in this repository.',
    ].join('\n')
    const error = Object.assign(
      new Error(`Command failed: git add -- '${cwd}/src/App.tsx'`),
      { stderr },
    )
    mocks.execFileAsync.mockRejectedValue(error)

    const handler = getHandler('git:stage')
    const result = await handler({}, cwd, ['src/App.tsx']) as { success?: boolean; error?: string }

    expect(result).toEqual({
      success: false,
      error: 'GIT_INDEX_LOCK: index.lock already exists; another Git process may be running, or a stale lock may remain after an interrupted Git operation.',
    })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(4)
    expect(mocks.collectGitIndexLockDiagnostics).toHaveBeenCalledTimes(1)
    expect(mocks.collectGitIndexLockDiagnostics).toHaveBeenCalledWith(cwd)
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'git index lock conflict',
      expect.objectContaining({
        command: 'add',
        phase: 'exhausted',
        attempt: 4,
        maxAttempts: 4,
        lockState: 'present',
        lockAgeMs: INDEX_LOCK_STALE_THRESHOLD_MS + 60_000,
        lockSizeBytes: 0,
        activeGitProcessCount: 0,
        processProbe: 'ok',
        processScope: 'system-wide',
        staleLockCandidate: true,
        operationId: expect.any(String),
        cwdBase: 'project',
        cwdHash: expect.any(String),
      }),
    )
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'git write failed',
      expect.objectContaining({
        action: 'stage',
        errorSummary: expect.stringContaining('GIT_INDEX_LOCK'),
      }),
    )
    const failureCall = mocks.gitLog.warn.mock.calls.find(
      (call: unknown[]) => call[0] === 'git write failed',
    )
    const diagnostics = failureCall?.[1] as Record<string, unknown>
    expect(JSON.stringify(diagnostics)).not.toContain(cwd)
    expect(String(diagnostics.errorSummary)).not.toContain('App.tsx')
    expect(String(diagnostics.errorSummary)).toContain('stale lock')
    const lockCalls = mocks.gitLog.warn.mock.calls.filter(
      (call: unknown[]) => call[0] === 'git index lock conflict',
    )
    expect(lockCalls).toHaveLength(4)
    expect(JSON.stringify(lockCalls)).not.toContain(cwd)
    expect(JSON.stringify(lockCalls)).not.toContain('App.tsx')
    const exhaustedDiagnostics = lockCalls.at(-1)?.[1] as Record<string, unknown>
    expect(diagnostics.operationId).toBe(exhaustedDiagnostics.operationId)
  })

  it('recovers from a stale index.lock after pre-write cleanup without retrying git add', async () => {
    const cwd = '/tmp/home/project'
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' })
    mocks.tryRemoveStaleIndexLock.mockResolvedValueOnce({
      removed: true,
      staleLockCandidate: true,
    })

    const handler = getHandler('git:stage')
    const result = await handler({}, cwd, ['src/App.tsx'])

    expect(result).toEqual({ success: true })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1)
    expect(mocks.tryRemoveStaleIndexLock).toHaveBeenCalledTimes(1)
    expect(mocks.tryRemoveStaleIndexLock).toHaveBeenCalledWith(cwd)
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'removed stale git index lock',
      expect.objectContaining({
        command: 'add',
        phase: 'pre-write',
        staleLockCandidate: true,
        cwdBase: 'project',
      }),
    )
  })

  it('recovers from a stale index.lock after cleanup and retries git add', async () => {
    const cwd = '/tmp/home/project'
    const stderr = [
      `fatal: Unable to create '${cwd}/.git/index.lock': File exists.`,
      'Another git process seems to be running in this repository.',
    ].join('\n')
    const error = Object.assign(new Error('Command failed'), { stderr })
    mocks.execFileAsync
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    mocks.tryRemoveStaleIndexLock
      .mockResolvedValueOnce({ removed: false, staleLockCandidate: false })
      .mockResolvedValueOnce({
        removed: true,
        staleLockCandidate: true,
      })

    const handler = getHandler('git:stage')
    const result = await handler({}, cwd, ['src/App.tsx'])

    expect(result).toEqual({ success: true })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(2)
    expect(mocks.tryRemoveStaleIndexLock).toHaveBeenCalledTimes(2)
    expect(mocks.tryRemoveStaleIndexLock).toHaveBeenCalledWith(cwd)
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'removed stale git index lock',
      expect.objectContaining({
        command: 'add',
        phase: 'before-retry',
        staleLockCandidate: true,
        cwdBase: 'project',
      }),
    )
  })

  it('does not remove index.lock when active git processes are reported', async () => {
    const cwd = '/tmp/home/project'
    const stderr = 'Another git process seems to be running in this repository'
    const error = Object.assign(new Error('Command failed'), { stderr })
    mocks.execFileAsync.mockRejectedValue(error)
    mocks.collectGitIndexLockDiagnostics.mockResolvedValue({
      lockState: 'present',
      lockAgeMs: INDEX_LOCK_STALE_THRESHOLD_MS + 60_000,
      lockSizeBytes: 0,
      activeGitProcessCount: 2,
      processProbe: 'ok',
      processScope: 'system-wide',
    })
    mocks.tryRemoveStaleIndexLock.mockResolvedValue({
      removed: false,
      staleLockCandidate: false,
    })

    const handler = getHandler('git:stage')
    const result = await handler({}, cwd, ['src/App.tsx']) as { success?: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(mocks.tryRemoveStaleIndexLock).toHaveBeenCalled()
    expect(mocks.gitLog.warn).not.toHaveBeenCalledWith(
      'removed stale git index lock',
      expect.anything(),
    )
    const exhaustedCall = mocks.gitLog.warn.mock.calls.find(
      (call: unknown[]) =>
        call[0] === 'git index lock conflict' &&
        (call[1] as { phase?: string }).phase === 'exhausted',
    )
    expect(exhaustedCall?.[1]).toEqual(
      expect.objectContaining({
        activeGitProcessCount: 2,
        agedLockBlockedByActiveGit: true,
      }),
    )
    expect(exhaustedCall?.[1]).not.toHaveProperty('staleLockCandidate')
  })

  it('unstages a file before the repository has its first commit', async () => {
    const cwd = '/tmp/home/new-project'
    mocks.execFileAsync
      .mockRejectedValueOnce({ stderr: "fatal: Needed a single revision" })
      .mockResolvedValueOnce({
        stdout: '# branch.oid (initial)\n# branch.head main\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const handler = getHandler('git:unstage')
    const result = await handler({}, cwd, ['sample.txt'])

    expect(result).toEqual({ success: true })
    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--verify', 'HEAD'],
      expect.objectContaining({ cwd }),
    )
    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['status', '--porcelain=2', '--branch', '--untracked-files=no'],
      expect.objectContaining({ cwd }),
    )
    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(
      3,
      'git',
      ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', 'sample.txt'],
      expect.objectContaining({
        cwd,
        env: expect.objectContaining({ GIT_LITERAL_PATHSPECS: '1' }),
      }),
    )
  })

  it('clears the index when unstaging all files before the first commit', async () => {
    const cwd = '/tmp/home/new-project'
    mocks.execFileAsync
      .mockRejectedValueOnce({ stderr: "fatal: Needed a single revision" })
      .mockResolvedValueOnce({
        stdout: '# branch.oid (initial)\n# branch.head main\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const handler = getHandler('git:unstage')
    const result = await handler({}, cwd)

    expect(result).toEqual({ success: true })
    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(
      3,
      'git',
      ['read-tree', '--empty'],
      expect.objectContaining({ cwd }),
    )
  })

  it('does not treat a HEAD probe infrastructure failure as an unborn branch', async () => {
    const cwd = '/tmp/home/project'
    const stderr = 'fatal: unable to access repository: Permission denied'
    mocks.execFileAsync
      .mockRejectedValueOnce({ stderr })
      .mockRejectedValueOnce({ stderr })

    const handler = getHandler('git:unstage')
    const result = await handler({}, cwd, ['sample.txt'])

    expect(result).toEqual({ success: false, error: stderr })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(2)
  })

  it('does not treat a corrupt HEAD as an unborn branch', async () => {
    const cwd = '/tmp/home/project'
    const stderr = "fatal: bad revision 'HEAD'"
    mocks.execFileAsync
      .mockRejectedValueOnce({ stderr })
      .mockResolvedValueOnce({
        stdout: '# branch.oid 0000000000000000000000000000000000000000\n# branch.head main\n',
        stderr: '',
      })

    const handler = getHandler('git:unstage')
    const result = await handler({}, cwd, ['sample.txt'])

    expect(result).toEqual({ success: false, error: stderr })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid explicit paths instead of unstaging everything', async () => {
    const handler = getHandler('git:unstage')
    const result = await handler({}, '/tmp/home/project', ['../outside.txt'])

    expect(result).toEqual({ success: false, error: 'one or more file paths are invalid' })
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'git write blocked',
      expect.objectContaining({
        action: 'unstage',
        reason: 'invalid pathspec',
        droppedPathCount: 1,
      }),
    )
  })

  it('logs path-access denials before running git', async () => {
    mocks.pathAccessCheck.mockImplementation((filePath?: string) => {
      if (typeof filePath === 'string' && filePath.endsWith('.env')) {
        return { allowed: false, reason: { reasonCode: 'sensitive_path', message: 'access denied: .env' } }
      }
      return { allowed: true }
    })

    const handler = getHandler('git:stage')
    const result = await handler({}, '/tmp/home/project', ['.env']) as { success?: boolean; error?: string }

    expect(result).toEqual({ success: false, error: 'access denied: .env' })
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'git write blocked',
      expect.objectContaining({
        action: 'stage',
        reason: 'path write access denied',
        cleanPathCount: 1,
        errorSummary: 'access denied: .env',
      }),
    )
  })

  it('stages non-denied root files when the batch also contains .env ', async () => {
    mocks.pathAccessCheck.mockImplementation((filePath?: string) => {
      if (typeof filePath === 'string' && filePath.endsWith('.env')) {
        return { allowed: false, reason: { reasonCode: 'deny_list', message: 'access denied: .env' } }
      }
      return { allowed: true }
    })
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' })

    const handler = getHandler('git:stage')
    const result = await handler(
      {},
      '/tmp/home/project',
      ['.env', 'README.md', 'package.json'],
    ) as { success?: boolean; skippedPaths?: string[]; skippedCount?: number }

    expect(result).toEqual({
      success: true,
      skippedPaths: ['.env'],
      skippedCount: 1,
    })
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1)
    expect(mocks.execFileAsync.mock.calls[0]?.[1]).toEqual(['add', '--', 'README.md', 'package.json'])
    expect(mocks.gitLog.warn).toHaveBeenCalledWith(
      'git write blocked',
      expect.objectContaining({
        action: 'stage',
        reason: 'path write access denied (skipped)',
      }),
    )
  })
})
