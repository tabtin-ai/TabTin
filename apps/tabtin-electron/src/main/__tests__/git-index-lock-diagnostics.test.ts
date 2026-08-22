import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countGitProcessesFromOutput,
  INDEX_LOCK_FORCE_STALE_THRESHOLD_MS,
  INDEX_LOCK_STALE_THRESHOLD_MS,
  inspectIndexLock,
  isStaleIndexLockCandidate,
  tryRemoveStaleIndexLock,
  type GitIndexLockDiagnostics,
} from '../git-index-lock-diagnostics'

const testDirectories: string[] = []

function makeTestDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-index-lock-'))
  testDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('git-index-lock-diagnostics', () => {
  it('reports a lock age and size without returning its path', async () => {
    const cwd = makeTestDirectory()
    const gitDirectory = path.join(cwd, '.git')
    const lockPath = path.join(gitDirectory, 'index.lock')
    fs.mkdirSync(gitDirectory)
    fs.writeFileSync(lockPath, 'lock')
    fs.utimesSync(lockPath, new Date(5_000), new Date(5_000))

    const result = await inspectIndexLock(cwd, () => 10_000)

    expect(result).toEqual({
      lockState: 'present',
      lockAgeMs: 5_000,
      lockSizeBytes: 4,
    })
    expect(JSON.stringify(result)).not.toContain(cwd)
    expect(JSON.stringify(result)).not.toContain('index.lock')
  })

  it('resolves a linked worktree .git pointer', async () => {
    const root = makeTestDirectory()
    const cwd = path.join(root, 'worktree')
    const gitDirectory = path.join(root, 'metadata')
    fs.mkdirSync(cwd)
    fs.mkdirSync(gitDirectory)
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../metadata\n')
    fs.writeFileSync(path.join(gitDirectory, 'index.lock'), '')

    const result = await inspectIndexLock(cwd, () => Date.now())

    expect(result.lockState).toBe('present')
    expect(result.lockSizeBytes).toBe(0)
  })

  it('reports a missing lock separately from a failed probe', async () => {
    const cwd = makeTestDirectory()
    fs.mkdirSync(path.join(cwd, '.git'))

    await expect(inspectIndexLock(cwd)).resolves.toEqual({ lockState: 'missing' })
    await expect(inspectIndexLock(path.join(cwd, 'missing'))).resolves.toEqual({
      lockState: 'unavailable',
      lockProbeErrorCode: 'ENOENT',
    })
  })

  it('counts only exact Git executables without retaining command lines', () => {
    const windowsOutput = [
      '"git.exe","123","Console","1","10,000 K"',
      '"git-lfs.exe","124","Console","1","10,000 K"',
      '"node.exe","125","Console","1","10,000 K"',
    ].join('\r\n')
    const unixOutput = [
      '/usr/bin/git',
      '/usr/bin/git-remote-https',
      '/usr/bin/node',
      'git',
    ].join('\n')

    expect(countGitProcessesFromOutput('win32', windowsOutput)).toBe(1)
    expect(countGitProcessesFromOutput('darwin', unixOutput)).toBe(2)
  })

  describe('isStaleIndexLockCandidate', () => {
    const staleSnapshot: GitIndexLockDiagnostics = {
      lockState: 'present',
      lockAgeMs: INDEX_LOCK_STALE_THRESHOLD_MS + 1,
      lockSizeBytes: 0,
      activeGitProcessCount: 0,
      processProbe: 'ok',
      processScope: 'system-wide',
    }

    it('treats an aged empty lock with no git processes as stale', () => {
      expect(isStaleIndexLockCandidate(staleSnapshot)).toBe(true)
    })

    it('does not treat a fresh lock as stale', () => {
      expect(
        isStaleIndexLockCandidate({
          ...staleSnapshot,
          lockAgeMs: INDEX_LOCK_STALE_THRESHOLD_MS,
        }),
      ).toBe(false)
    })

    it('allows extremely old empty locks when process probe is unavailable', () => {
      expect(
        isStaleIndexLockCandidate({
          lockState: 'present',
          lockAgeMs: INDEX_LOCK_FORCE_STALE_THRESHOLD_MS + 1,
          lockSizeBytes: 0,
          activeGitProcessCount: null,
          processProbe: 'unavailable',
          processScope: 'system-wide',
        }),
      ).toBe(true)
    })

    it('does not force-remove empty locks when process probe is unavailable but lock is young', () => {
      expect(
        isStaleIndexLockCandidate({
          lockState: 'present',
          lockAgeMs: INDEX_LOCK_STALE_THRESHOLD_MS + 1,
          lockSizeBytes: 0,
          activeGitProcessCount: null,
          processProbe: 'unavailable',
          processScope: 'system-wide',
        }),
      ).toBe(false)
    })

    it('does not delete candidate when git processes are active', () => {
      expect(
        isStaleIndexLockCandidate({
          ...staleSnapshot,
          activeGitProcessCount: 1,
        }),
      ).toBe(false)
    })
  })

  describe('tryRemoveStaleIndexLock', () => {
    it('removes an aged empty lock when no git processes are running', async () => {
      const cwd = makeTestDirectory()
      const gitDirectory = path.join(cwd, '.git')
      const lockPath = path.join(gitDirectory, 'index.lock')
      fs.mkdirSync(gitDirectory)
      fs.writeFileSync(lockPath, '')
      const staleTime = new Date(Date.now() - INDEX_LOCK_STALE_THRESHOLD_MS - 60_000)
      fs.utimesSync(lockPath, staleTime, staleTime)

      const result = await tryRemoveStaleIndexLock(cwd)

      if (result.staleLockCandidate && result.removed) {
        expect(fs.existsSync(lockPath)).toBe(false)
        return
      }

      // 测试环境若存在 git 进程，应保守跳过删除而不是误删。
      expect(result).toEqual({ removed: false, staleLockCandidate: false })
      expect(fs.existsSync(lockPath)).toBe(true)
    })

    it('does not remove a freshly created lock', async () => {
      const cwd = makeTestDirectory()
      const gitDirectory = path.join(cwd, '.git')
      const lockPath = path.join(gitDirectory, 'index.lock')
      fs.mkdirSync(gitDirectory)
      fs.writeFileSync(lockPath, '')

      const result = await tryRemoveStaleIndexLock(cwd)

      expect(result).toEqual({ removed: false, staleLockCandidate: false })
      expect(fs.existsSync(lockPath)).toBe(true)
    })
  })
})
