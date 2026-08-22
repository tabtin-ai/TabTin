/**
 * exit-guard 主进程单元测试（W2.5 T9）
 *
 * 验证：
 * - getMainWindow 返回 null 时降级 'continue'（避免阻塞退出）
 * - 正常 ask → renderer 响应 → resolve 用户选择
 * - 重复并发 ask 复用 pending request
 * - 超时降级走原生 fallback dialog
 * - 非主窗口 sender 的响应被忽略
 * - dispose 后 ipcMain listener 注销
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock 在文件顶层会被 hoist 到 import 之前；使用 vi.hoisted 让常量也提前可用，
// 内部 require 而非 import EventEmitter，避免 import 也被 hoist 触发循环依赖
const { mockIpcMain, mockDialog } = vi.hoisted(() => {
  const { EventEmitter } = require('events') as typeof import('events')
  return {
    mockIpcMain: new EventEmitter(),
    mockDialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  dialog: mockDialog,
}))

import { createExitGuardController, type ExitGuardController } from '../exit-guard'

interface MockWebContents {
  send: ReturnType<typeof vi.fn>
}

interface MockWindow {
  isDestroyed: () => boolean
  webContents: MockWebContents
}

const makeWin = (): MockWindow => ({
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
})

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

let guard: ExitGuardController | null = null

beforeEach(() => {
  mockIpcMain.removeAllListeners()
  mockDialog.showMessageBox.mockReset().mockResolvedValue({ response: 0 })
  log.info.mockReset()
  log.warn.mockReset()
  log.error.mockReset()
  if (guard) guard.dispose()
})

describe('createExitGuardController', () => {
  it('getMainWindow 返回 null 时立即降级 continue', async () => {
    guard = createExitGuardController({
      log,
      getMainWindow: () => null,
    })

    const choice = await guard.ask('app-quit')
    expect(choice).toBe('continue')
    expect(log.warn).toHaveBeenCalled()
  })

  it('window 已 destroyed 时立即降级 continue', async () => {
    const win = makeWin()
    win.isDestroyed = () => true
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    const choice = await guard.ask('app-quit')
    expect(choice).toBe('continue')
  })

  it('正常 ask → 发送请求到 renderer，等响应', async () => {
    const win = makeWin()
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    const askPromise = guard.ask('app-quit')

    // 验证已发送请求
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    const [channel, payload] = win.webContents.send.mock.calls[0]
    expect(channel).toBe('app:exit-guard:request')
    expect(payload.reason).toBe('app-quit')
    const requestId = payload.requestId

    // 模拟 renderer 响应
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId,
      choice: 'cancel',
    })

    await expect(askPromise).resolves.toBe('cancel')
  })

  it('renderer 选 continue → resolve continue', async () => {
    const win = makeWin()
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    const askPromise = guard.ask('window-close')
    const requestId = win.webContents.send.mock.calls[0][1].requestId
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId,
      choice: 'continue',
    })

    await expect(askPromise).resolves.toBe('continue')
  })

  it('非主窗口 sender 的响应被忽略', async () => {
    const win = makeWin()
    const otherWebContents = { send: vi.fn() }
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    const askPromise = guard.ask('app-quit')
    const requestId = win.webContents.send.mock.calls[0][1].requestId

    // 别的 webContents 发响应 → 忽略
    mockIpcMain.emit('app:exit-guard:response', { sender: otherWebContents }, {
      requestId,
      choice: 'continue',
    })
    expect(log.warn).toHaveBeenCalled()

    // 主窗口正确响应 → 才被接受
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId,
      choice: 'continue',
    })
    await expect(askPromise).resolves.toBe('continue')
  })

  it('requestId 不匹配的响应被忽略', async () => {
    const win = makeWin()
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    const askPromise = guard.ask('app-quit')
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId: 'wrong-id',
      choice: 'continue',
    })
    expect(log.warn).toHaveBeenCalled()

    const realId = win.webContents.send.mock.calls[0][1].requestId
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId: realId,
      choice: 'cancel',
    })
    await expect(askPromise).resolves.toBe('cancel')
  })

  it('无效 payload 被忽略', async () => {
    const win = makeWin()
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    const askPromise = guard.ask('app-quit')
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, null)
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, { foo: 'bar' })
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId: 'x',
      choice: 'invalid',
    })
    expect(log.warn.mock.calls.length).toBeGreaterThanOrEqual(3)

    const realId = win.webContents.send.mock.calls[0][1].requestId
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId: realId,
      choice: 'continue',
    })
    await expect(askPromise).resolves.toBe('continue')
  })

  it('重复并发 ask 共享同一 pending；settle 时两个 promise 都被 resolve', async () => {
    const win = makeWin()
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    const p1 = guard.ask('app-quit')
    const p2 = guard.ask('window-close')

    // 第二次 ask 不应再发新请求（复用 pending）
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('复用 pending'))

    const requestId = win.webContents.send.mock.calls[0][1].requestId
    mockIpcMain.emit('app:exit-guard:response', { sender: win.webContents }, {
      requestId,
      choice: 'cancel',
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('cancel')
    expect(r2).toBe('cancel')
  })

  it('超时走原生 fallback dialog', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    const fallback = vi.fn(async () => 'continue' as const)
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
      timeoutMs: 100,
      showNativeFallback: fallback,
    })

    const askPromise = guard.ask('app-quit')

    await vi.advanceTimersByTimeAsync(100)
    await expect(askPromise).resolves.toBe('continue')

    expect(fallback).toHaveBeenCalledWith(win, 'app-quit')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('未响应'))
    vi.useRealTimers()
  })

  it('超时后 fallback 抛错 → 降级 continue', async () => {
    vi.useFakeTimers()
    const win = makeWin()
    const fallback = vi.fn(async () => { throw new Error('boom') })
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
      timeoutMs: 50,
      showNativeFallback: fallback,
    })

    const askPromise = guard.ask('app-quit')
    await vi.advanceTimersByTimeAsync(50)
    await expect(askPromise).resolves.toBe('continue')
    expect(log.error).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('dispose 后 ipcMain listener 数恢复', () => {
    const win = makeWin()
    guard = createExitGuardController({
      log,
      getMainWindow: () => win as never,
    })

    expect(mockIpcMain.listenerCount('app:exit-guard:response')).toBe(1)
    guard.dispose()
    expect(mockIpcMain.listenerCount('app:exit-guard:response')).toBe(0)
    guard = null
  })
})
