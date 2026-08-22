import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  GIT_INDEX_LOCK_ERROR_MESSAGE,
  INDEX_LOCK_RETRY_DELAYS_MS,
  isGitIndexLockError,
  normalizeCwdKey,
  resetCwdWriteQueuesForTests,
  withCwdWriteQueue,
  withCwdWriteQueues,
  withIndexLockRetry,
} from '../git-ipc-lock'

describe('git-ipc-lock', () => {
  beforeEach(() => {
    resetCwdWriteQueuesForTests()
  })

  describe('isGitIndexLockError', () => {
    it('detects index.lock File exists errors', () => {
      const error = Object.assign(new Error('Command failed'), {
        stderr:
          "fatal: Unable to create '/Users/tabtin/Desktop/TabTin/.git/index.lock': File exists.\n" +
          'Another git process seems to be running in this repository',
      })
      expect(isGitIndexLockError(error)).toBe(true)
    })

    it('ignores unrelated git errors', () => {
      expect(isGitIndexLockError(new Error('pathspec did not match any files'))).toBe(false)
      expect(isGitIndexLockError({ stderr: 'error: failed to push some refs' })).toBe(false)
    })
  })

  describe('withIndexLockRetry', () => {
    it('retries lock conflicts then succeeds', async () => {
      const sleep = vi.fn(async () => {})
      const lockError = Object.assign(new Error('failed'), {
        stderr: "fatal: Unable to create '.git/index.lock': File exists.",
      })
      const fn = vi
        .fn()
        .mockRejectedValueOnce(lockError)
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce('ok')

      await expect(withIndexLockRetry(fn, { sleep })).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(3)
      expect(sleep).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenNthCalledWith(1, INDEX_LOCK_RETRY_DELAYS_MS[0])
      expect(sleep).toHaveBeenNthCalledWith(2, INDEX_LOCK_RETRY_DELAYS_MS[1])
    })

    it('throws after exhausting retries on persistent lock', async () => {
      const sleep = vi.fn(async () => {})
      const onLockConflict = vi.fn(async () => {})
      const lockError = Object.assign(new Error('failed'), {
        stderr: 'Another git process seems to be running in this repository',
      })
      const fn = vi.fn().mockRejectedValue(lockError)

      await expect(withIndexLockRetry(fn, { sleep, onLockConflict })).rejects.toBe(lockError)
      expect(fn).toHaveBeenCalledTimes(INDEX_LOCK_RETRY_DELAYS_MS.length + 1)
      expect(sleep).toHaveBeenCalledTimes(INDEX_LOCK_RETRY_DELAYS_MS.length)
      expect(onLockConflict).toHaveBeenCalledTimes(INDEX_LOCK_RETRY_DELAYS_MS.length + 1)
      expect(onLockConflict).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          attempt: 1,
          maxAttempts: INDEX_LOCK_RETRY_DELAYS_MS.length + 1,
          nextDelayMs: INDEX_LOCK_RETRY_DELAYS_MS[0],
          exhausted: false,
        }),
      )
      expect(onLockConflict).toHaveBeenLastCalledWith(
        expect.objectContaining({
          attempt: INDEX_LOCK_RETRY_DELAYS_MS.length + 1,
          nextDelayMs: null,
          exhausted: true,
        }),
      )
    })

    it('does not retry non-lock errors', async () => {
      const sleep = vi.fn(async () => {})
      const other = new Error('not a lock')
      const fn = vi.fn().mockRejectedValue(other)

      await expect(withIndexLockRetry(fn, { sleep })).rejects.toBe(other)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    })

    it('runs beforeRetry before sleeping on lock conflicts', async () => {
      const sleep = vi.fn(async () => {})
      const beforeRetry = vi.fn(async () => {})
      const lockError = Object.assign(new Error('failed'), {
        stderr: "fatal: Unable to create '.git/index.lock': File exists.",
      })
      const fn = vi
        .fn()
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce('ok')

      await expect(withIndexLockRetry(fn, { sleep, beforeRetry })).resolves.toBe('ok')
      expect(beforeRetry).toHaveBeenCalledTimes(1)
      expect(beforeRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          exhausted: false,
          nextDelayMs: INDEX_LOCK_RETRY_DELAYS_MS[0],
        }),
      )
      expect(sleep).toHaveBeenCalledTimes(1)
    })

    it('does not run beforeRetry on the exhausted attempt', async () => {
      const sleep = vi.fn(async () => {})
      const beforeRetry = vi.fn(async () => {})
      const lockError = Object.assign(new Error('failed'), {
        stderr: 'Another git process seems to be running in this repository',
      })
      const fn = vi.fn().mockRejectedValue(lockError)

      await expect(withIndexLockRetry(fn, { sleep, beforeRetry })).rejects.toBe(lockError)
      expect(beforeRetry).toHaveBeenCalledTimes(INDEX_LOCK_RETRY_DELAYS_MS.length)
      expect(beforeRetry).not.toHaveBeenCalledWith(
        expect.objectContaining({ exhausted: true }),
      )
    })
  })

  describe('withCwdWriteQueue', () => {
    it('serializes concurrent writes for the same cwd', async () => {
      const order: string[] = []
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      const first = withCwdWriteQueue('/tmp/repo-a', async () => {
        order.push('first-start')
        await firstGate
        order.push('first-end')
        return 1
      })

      // 让 first 进入队列并开始执行
      await Promise.resolve()
      await Promise.resolve()

      const second = withCwdWriteQueue('/tmp/repo-a', async () => {
        order.push('second')
        return 2
      })

      // second 应仍在排队，尚未执行
      await Promise.resolve()
      expect(order).toEqual(['first-start'])

      releaseFirst()
      await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
      expect(order).toEqual(['first-start', 'first-end', 'second'])
    })

    it('allows concurrent writes for different cwds', async () => {
      let releaseA!: () => void
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve
      })

      const a = withCwdWriteQueue('/tmp/repo-a', async () => {
        await gateA
        return 'a'
      })

      await Promise.resolve()
      await Promise.resolve()

      const bStarted = vi.fn()
      const b = withCwdWriteQueue('/tmp/repo-b', async () => {
        bStarted()
        return 'b'
      })

      await expect(b).resolves.toBe('b')
      expect(bStarted).toHaveBeenCalled()
      releaseA()
      await expect(a).resolves.toBe('a')
    })

    it('serializes overlapping multi-cwd writes regardless of input order', async () => {
      const order: string[] = []
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const first = withCwdWriteQueues(['/tmp/repo-a', '/tmp/repo-b'], async () => {
        order.push('first-start')
        await firstGate
        order.push('first-end')
      })
      await Promise.resolve()
      await Promise.resolve()

      const second = withCwdWriteQueues(['/tmp/repo-b', '/tmp/repo-a'], async () => {
        order.push('second')
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(order).toEqual(['first-start'])

      releaseFirst()
      await Promise.all([first, second])
      expect(order).toEqual(['first-start', 'first-end', 'second'])
    })

    it('normalizes cwd keys so path variants share a queue', () => {
      expect(normalizeCwdKey('/tmp/Repo')).toBe(normalizeCwdKey('/tmp/Repo/'))
    })

    it('reports queue contention without exposing the cwd key', async () => {
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const firstStarted = vi.fn()
      const secondStarted = vi.fn()

      const first = withCwdWriteQueue('/tmp/repo-a', async () => {
        await firstGate
      }, { onStart: firstStarted })
      await Promise.resolve()
      await Promise.resolve()

      const second = withCwdWriteQueue('/tmp/repo-a', async () => {}, {
        onStart: secondStarted,
      })
      await Promise.resolve()

      expect(firstStarted).toHaveBeenCalledWith(
        expect.objectContaining({ queuedAhead: 0 }),
      )
      expect(secondStarted).not.toHaveBeenCalled()

      releaseFirst()
      await Promise.all([first, second])
      expect(secondStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          queuedAhead: 1,
          waitMs: expect.any(Number),
        }),
      )
      expect(JSON.stringify(secondStarted.mock.calls)).not.toContain('/tmp/repo-a')
    })
  })

  it('exposes a path-safe reason for renderer localization', () => {
    expect(GIT_INDEX_LOCK_ERROR_MESSAGE).toContain('index.lock')
    expect(GIT_INDEX_LOCK_ERROR_MESSAGE).toContain('another Git process')
    expect(GIT_INDEX_LOCK_ERROR_MESSAGE).toContain('stale lock')
    expect(GIT_INDEX_LOCK_ERROR_MESSAGE).not.toContain('/Users/')
    expect(GIT_INDEX_LOCK_ERROR_MESSAGE).not.toContain('C:\\')
  })
})
