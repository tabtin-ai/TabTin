/**
 * Win32 Bridge Manager 单元测试。
 *
 * 在 macOS 上跑 mock——mock 掉 child_process.spawn，
 * 只测消息协议正确性 + 生命周期管理 + 崩溃重启策略。
 *
 * FIXME(Win真机验): Windows 真机上需要验证 bridge.py 实际 spawn
 * 和 stdio JSONL 通信的端到端正确性。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

// ---------------------------------------------------------------------------
// Mock child_process（需要提供 default 和 named exports）
// ---------------------------------------------------------------------------

let mockStdinData: string[] = []
let mockProc: EventEmitter & {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn>
  pid: number
} | null = null

function createMockProcess() {
  mockStdinData = []
  const proc = Object.assign(new EventEmitter(), {
    stdin: new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        mockStdinData.push(chunk.toString())
        cb()
      },
    }),
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    kill: vi.fn(),
    pid: 12345,
  })
  mockProc = proc
  return proc
}

const mockSpawn = vi.fn(() => createMockProcess())

vi.mock('node:child_process', () => {
  const mod = {
    spawn: (...args: unknown[]) => mockSpawn(...args),
    execFileSync: vi.fn(),
    execFile: vi.fn(),
  }
  return { ...mod, default: mod }
})

vi.mock('node:fs', () => {
  const mod = {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    createReadStream: vi.fn(),
    appendFileSync: vi.fn(),
  }
  return { ...mod, default: mod }
})

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { Win32BridgeManager } from '../win32-bridge/bridge-manager'
import { DesktopErrorCode } from '../desktop-error-codes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_PLATFORM = process.platform

function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

function sendLine(line: string) {
  mockProc?.stdout.push(line + '\n')
}

function sendReady() {
  sendLine(JSON.stringify({ id: 0, result: { status: 'ready', version: '1.0.0' } }))
}

function sendResponse(id: number, result: Record<string, unknown>) {
  sendLine(JSON.stringify({ id, result }))
}

function sendError(id: number, code: string, message: string) {
  sendLine(JSON.stringify({ id, error: { code, message } }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Win32BridgeManager', () => {
  let manager: Win32BridgeManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new Win32BridgeManager()
  })

  afterEach(() => {
    manager.dispose()
    setPlatform(ORIGINAL_PLATFORM)
  })

  describe('platform guard', () => {
    it('非 win32 平台 start() 不 spawn 进程', async () => {
      setPlatform('darwin')
      await manager.start()
      expect(manager.ready).toBe(false)
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('非 win32 平台 call() 抛 AX_UNAVAILABLE', async () => {
      setPlatform('darwin')
      await expect(manager.call('ping')).rejects.toMatchObject({
        code: DesktopErrorCode.AX_UNAVAILABLE,
      })
    })

    it('错误消息包含当前平台名', async () => {
      setPlatform('linux')
      try {
        await manager.call('ping')
      } catch (err: unknown) {
        expect((err as Error).message).toContain('linux')
      }
    })
  })

  describe('spawn + ready 握手', () => {
    it('win32 平台 start() spawn 进程并等待 ready', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP
      expect(manager.ready).toBe(true)
      expect(mockSpawn).toHaveBeenCalled()
    })

    it('多次 start() 不重复 spawn', async () => {
      setPlatform('win32')
      const p1 = manager.start()
      const p2 = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await Promise.all([p1, p2])
      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })
  })

  describe('call() 消息协议', () => {
    it('发送 JSONL 请求并匹配响应', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP

      const callP = manager.call('ping', { test: true })
      await new Promise(r => setTimeout(r, 10))

      expect(mockStdinData.length).toBeGreaterThan(0)
      const sent = JSON.parse(mockStdinData[mockStdinData.length - 1])
      expect(sent.method).toBe('ping')
      expect(sent.params).toEqual({ test: true })
      expect(typeof sent.id).toBe('number')

      sendResponse(sent.id, { status: 'ok' })
      const result = await callP
      expect(result).toEqual({ status: 'ok' })
    })

    it('bridge 返回 error → call() 抛 DesktopError', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP

      const callP = manager.call('find_window', { title: 'test' })
      await new Promise(r => setTimeout(r, 10))
      const sent = JSON.parse(mockStdinData[mockStdinData.length - 1])
      sendError(sent.id, 'ELEMENT_NOT_FOUND', '找不到窗口')

      await expect(callP).rejects.toMatchObject({
        code: 'ELEMENT_NOT_FOUND',
        message: '找不到窗口',
      })
    })

    it('多个并发请求按 id 正确路由', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP

      const p1 = manager.call('ping')
      const p2 = manager.call('find_window', { title: 'A' })
      await new Promise(r => setTimeout(r, 10))

      const sent1 = JSON.parse(mockStdinData[mockStdinData.length - 2])
      const sent2 = JSON.parse(mockStdinData[mockStdinData.length - 1])

      // 故意乱序响应
      sendResponse(sent2.id, { windows: [] })
      sendResponse(sent1.id, { status: 'ok' })

      const r1 = await p1
      const r2 = await p2
      expect(r1).toEqual({ status: 'ok' })
      expect(r2).toEqual({ windows: [] })
    })
  })

  describe('崩溃处理', () => {
    it('进程退出后 pending 请求被 reject', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP

      const callP = manager.call('ping')
      await new Promise(r => setTimeout(r, 10))

      mockProc!.emit('exit', 1, null)

      await expect(callP).rejects.toMatchObject({
        code: DesktopErrorCode.INTERNAL_ERROR,
      })
    })

    it('spawn error 不崩溃', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP

      mockProc!.emit('error', new Error('ENOENT'))
      expect(manager.ready).toBe(false)
    })
  })

  describe('dispose', () => {
    it('dispose 清理所有资源并 kill 进程', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP

      manager.dispose()
      expect(manager.ready).toBe(false)
      expect(mockProc!.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('dispose 后 call() 抛 AX_UNAVAILABLE（因为非 win32）', async () => {
      setPlatform('darwin')
      manager.dispose()
      await expect(manager.call('ping')).rejects.toMatchObject({
        code: DesktopErrorCode.AX_UNAVAILABLE,
      })
    })

    it('dispose 后 start() 不再 spawn', async () => {
      setPlatform('win32')
      manager.dispose()
      await manager.start()
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })

  describe('ping 健康检查', () => {
    it('bridge 正常 → ping 返回 true', async () => {
      setPlatform('win32')
      const startP = manager.start()
      await new Promise(r => setTimeout(r, 10))
      sendReady()
      await startP

      const pingP = manager.ping()
      await new Promise(r => setTimeout(r, 10))
      const sent = JSON.parse(mockStdinData[mockStdinData.length - 1])
      sendResponse(sent.id, { status: 'ok' })

      expect(await pingP).toBe(true)
    })

    it('bridge 不可用 → ping 返回 false', async () => {
      setPlatform('darwin')
      expect(await manager.ping()).toBe(false)
    })
  })
})
