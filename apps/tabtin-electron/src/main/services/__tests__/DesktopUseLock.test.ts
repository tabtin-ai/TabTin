/**
 * DesktopUseLock 单元测试
 *
 * 文件锁互斥机制：确保同一时间只有一个 Agent session 操控桌面。
 * 覆盖场景：获取/重入/竞争/死进程回收/释放/状态检查/内存状态
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMkdir = vi.fn()
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockUnlink = vi.fn()

vi.mock('fs/promises', () => {
  const mod = {
    mkdir: mockMkdir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    unlink: mockUnlink,
  }
  return { ...mod, default: mod }
})

vi.mock('fs', () => {
  const mod = {
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
  return { ...mod, default: mod }
})

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    quit: vi.fn(),
  },
}))

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALIVE_PID = 12345
const DEAD_PID = 99999

function makeLockPayload(sessionId: string, pid: number): string {
  return JSON.stringify({ sessionId, pid, acquiredAt: Date.now() })
}

function eexistError(): NodeJS.ErrnoException {
  const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException
  err.code = 'EEXIST'
  return err
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DesktopUseLock', () => {
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockMkdir.mockReset().mockResolvedValue(undefined)
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockUnlink.mockReset().mockResolvedValue(undefined)

    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (pid === ALIVE_PID || pid === process.pid) return true
        throw new Error('ESRCH: no such process')
      }
      return true
    }) as typeof process.kill)
  })

  afterEach(() => {
    killSpy.mockRestore()
    vi.resetModules()
  })

  // ===== tryAcquire — 正常获取锁 =====

  describe('tryAcquire — 正常获取锁', () => {
    it('锁文件不存在时 writeFile(wx) 成功，返回 acquired + fresh=true', async () => {
      mockWriteFile.mockResolvedValue(undefined)

      const { tryAcquire, isHeldLocally } = await import('../DesktopUseLock')
      const result = await tryAcquire('session-1')

      expect(result).toEqual({ kind: 'acquired', fresh: true })
      expect(isHeldLocally()).toBe(true)
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('.tabtin'), { recursive: true })
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('desktop-use.lock'),
        expect.any(String),
        { flag: 'wx' },
      )
    })

    it('写入的 payload 包含正确的 sessionId、pid、acquiredAt', async () => {
      mockWriteFile.mockResolvedValue(undefined)

      const { tryAcquire } = await import('../DesktopUseLock')
      await tryAcquire('session-abc')

      const written = JSON.parse(mockWriteFile.mock.calls[0][1])
      expect(written).toMatchObject({ sessionId: 'session-abc', pid: process.pid })
      expect(typeof written.acquiredAt).toBe('number')
    })
  })

  // ===== tryAcquire — 重入 =====

  describe('tryAcquire — 重入（同 session）', () => {
    it('已持有锁的 session 再次调用返回 acquired + fresh=false', async () => {
      mockWriteFile.mockResolvedValue(undefined)
      const { tryAcquire } = await import('../DesktopUseLock')
      await tryAcquire('session-1')

      mockWriteFile.mockRejectedValue(eexistError())
      mockReadFile.mockResolvedValue(makeLockPayload('session-1', process.pid))

      const result = await tryAcquire('session-1')
      expect(result).toEqual({ kind: 'acquired', fresh: false })
    })
  })

  // ===== tryAcquire — 被占用 =====

  describe('tryAcquire — 被占用（另一个活跃 session）', () => {
    it('另一个活跃 session 持有时返回 blocked', async () => {
      mockWriteFile.mockRejectedValue(eexistError())
      mockReadFile.mockResolvedValue(makeLockPayload('other-session', ALIVE_PID))

      const { tryAcquire, isHeldLocally } = await import('../DesktopUseLock')
      const result = await tryAcquire('session-1')

      expect(result).toEqual({ kind: 'blocked', by: 'other-session' })
      expect(isHeldLocally()).toBe(false)
    })
  })

  // ===== tryAcquire — 死进程锁回收 =====

  describe('tryAcquire — 死进程锁回收', () => {
    it('持有者 PID 不存活时回收旧锁并成功获取', async () => {
      mockWriteFile
        .mockRejectedValueOnce(eexistError())
        .mockResolvedValueOnce(undefined)
      mockReadFile.mockResolvedValue(makeLockPayload('dead-session', DEAD_PID))

      const { tryAcquire, isHeldLocally } = await import('../DesktopUseLock')
      const result = await tryAcquire('session-1')

      expect(result).toEqual({ kind: 'acquired', fresh: true })
      expect(isHeldLocally()).toBe(true)
      expect(mockUnlink).toHaveBeenCalled()
    })
  })

  // ===== release — 正常释放 =====

  describe('release — 正常释放', () => {
    it('持有者释放锁后删除文件并返回 true', async () => {
      mockWriteFile.mockResolvedValue(undefined)
      const { tryAcquire, release, isHeldLocally } = await import('../DesktopUseLock')

      await tryAcquire('session-1')
      expect(isHeldLocally()).toBe(true)

      mockReadFile.mockResolvedValue(makeLockPayload('session-1', process.pid))
      const released = await release('session-1')

      expect(released).toBe(true)
      expect(isHeldLocally()).toBe(false)
    })
  })

  // ===== release — 非持有者释放 =====

  describe('release — 非持有者释放', () => {
    it('未持有锁时 release 返回 false 且不删文件', async () => {
      const { release } = await import('../DesktopUseLock')
      const result = await release('non-holder')

      expect(result).toBe(false)
      expect(mockUnlink).not.toHaveBeenCalled()
    })

    it('持有锁但使用不同 sessionId 调用 release 返回 false', async () => {
      mockWriteFile.mockResolvedValue(undefined)
      const { tryAcquire, release } = await import('../DesktopUseLock')
      await tryAcquire('session-1')

      mockUnlink.mockClear()
      const result = await release('session-2')

      expect(result).toBe(false)
      expect(mockUnlink).not.toHaveBeenCalled()
    })
  })

  // ===== check — 各种状态 =====

  describe('check — 各种状态', () => {
    it('无锁文件时返回 free', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))

      const { check } = await import('../DesktopUseLock')
      expect(await check('session-1')).toEqual({ kind: 'free' })
    })

    it('自己持有时返回 held_by_self', async () => {
      mockReadFile.mockResolvedValue(makeLockPayload('session-1', process.pid))

      const { check } = await import('../DesktopUseLock')
      expect(await check('session-1')).toEqual({ kind: 'held_by_self' })
    })

    it('他人持有且 PID 存活时返回 blocked', async () => {
      mockReadFile.mockResolvedValue(makeLockPayload('other-session', ALIVE_PID))

      const { check } = await import('../DesktopUseLock')
      expect(await check('my-session')).toEqual({ kind: 'blocked', by: 'other-session' })
    })

    it('他人持有但 PID 已死时回收锁并返回 free', async () => {
      mockReadFile.mockResolvedValue(makeLockPayload('dead-session', DEAD_PID))

      const { check } = await import('../DesktopUseLock')
      expect(await check('my-session')).toEqual({ kind: 'free' })
      expect(mockUnlink).toHaveBeenCalled()
    })
  })

  // ===== isHeldLocally — 内存状态 =====

  describe('isHeldLocally — 内存状态', () => {
    it('初始为 false', async () => {
      const { isHeldLocally } = await import('../DesktopUseLock')
      expect(isHeldLocally()).toBe(false)
    })

    it('acquire 后为 true', async () => {
      mockWriteFile.mockResolvedValue(undefined)

      const { tryAcquire, isHeldLocally } = await import('../DesktopUseLock')
      await tryAcquire('session-1')
      expect(isHeldLocally()).toBe(true)
    })

    it('release 后恢复为 false', async () => {
      mockWriteFile.mockResolvedValue(undefined)

      const { tryAcquire, release, isHeldLocally } = await import('../DesktopUseLock')
      await tryAcquire('session-1')
      expect(isHeldLocally()).toBe(true)

      mockReadFile.mockResolvedValue(makeLockPayload('session-1', process.pid))
      await release('session-1')
      expect(isHeldLocally()).toBe(false)
    })
  })
})
