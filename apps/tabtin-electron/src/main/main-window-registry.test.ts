import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [] as unknown[]),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
  clearMainWindow: vi.fn(),
  setMainWindowNotificationHostReady: vi.fn(),
  isMainWindowNotificationHostReady: vi.fn(() => false),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mocks.getAllWindows,
  },
}))

vi.mock('./window-manager', () => ({
  getMainWindow: mocks.getMainWindow,
  setMainWindow: mocks.setMainWindow,
  clearMainWindow: mocks.clearMainWindow,
  setMainWindowNotificationHostReady: mocks.setMainWindowNotificationHostReady,
  isMainWindowNotificationHostReady: mocks.isMainWindowNotificationHostReady,
}))

import { createMainWindowRegistry } from './main-window-registry'

function createWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    isLoading: vi.fn(() => true),
    send: vi.fn(),
  })
  return Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents,
  })
}

describe('main-window-registry ensureReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMainWindow.mockReturnValue(null)
  })

  it('没有主窗口时创建窗口并等待加载成功', async () => {
    const window = createWindow()
    mocks.getAllWindows.mockReturnValue([window])
    const createWindowMock = vi.fn(() => window)
    const registry = createMainWindowRegistry({
      createWindow: createWindowMock as never,
      registerContextSpaceShortcutGuard: vi.fn(),
      onMainWindowDidFinishLoad: vi.fn().mockResolvedValue(undefined),
    })

    const readyPromise = registry.ensureReady()
    expect(createWindowMock).toHaveBeenCalledTimes(1)

    window.webContents.emit('did-finish-load')

    await expect(readyPromise).resolves.toBe(window)
  })

  it('窗口加载失败时返回 null 并清理其余等待监听器', async () => {
    const window = createWindow()
    const registry = createMainWindowRegistry({
      createWindow: vi.fn(() => window) as never,
      registerContextSpaceShortcutGuard: vi.fn(),
      onMainWindowDidFinishLoad: vi.fn().mockResolvedValue(undefined),
    })

    const readyPromise = registry.ensureReady()
    window.webContents.emit('did-fail-load')

    await expect(readyPromise).resolves.toBeNull()
    expect(window.webContents.listenerCount('did-finish-load')).toBe(2)
    expect(window.listenerCount('closed')).toBe(1)
  })

  it('调用取消时停止等待并清理本次加载监听器', async () => {
    const window = createWindow()
    const registry = createMainWindowRegistry({
      createWindow: vi.fn(() => window) as never,
      registerContextSpaceShortcutGuard: vi.fn(),
      onMainWindowDidFinishLoad: vi.fn().mockResolvedValue(undefined),
    })
    const controller = new AbortController()
    const readyPromise = registry.ensureReady(controller.signal)
    const cancellation = expect(readyPromise).rejects.toThrow('cancelled')

    controller.abort(new Error('cancelled'))

    await cancellation
    expect(window.webContents.listenerCount('did-finish-load')).toBe(2)
    expect(window.listenerCount('closed')).toBe(1)
  })
})
