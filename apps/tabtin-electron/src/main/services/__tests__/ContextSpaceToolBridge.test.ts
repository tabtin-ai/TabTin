import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const mocks = vi.hoisted(() => ({
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  isTrustedSender: vi.fn(() => true),
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: mocks.ipcMain,
}))

vi.mock('../../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

vi.mock('../../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

import { ContextSpaceToolBridge } from '../ContextSpaceToolBridge'

type MockWindow = {
  isDestroyed: ReturnType<typeof vi.fn>
  webContents: {
    isDestroyed: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
  }
}

function createWindow(destroyed = false): MockWindow {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: {
      isDestroyed: vi.fn(() => destroyed),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
  }
}

describe('ContextSpaceToolBridge', () => {
  let bridge: ContextSpaceToolBridge | null = null

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    bridge?.destroy()
    bridge = null
    vi.useRealTimers()
  })

  it('每次调用解析当前主窗口，窗口重建后不再使用旧引用', async () => {
    const oldWindow = createWindow(true)
    const currentWindow = createWindow()
    let activeWindow: MockWindow | null = oldWindow
    bridge = new ContextSpaceToolBridge(
      async () => activeWindow as unknown as BrowserWindow | null,
    )

    activeWindow = currentWindow
    const resultPromise = bridge.invoke('open_terminal_tab', { spaceId: 'space-1' })

    expect(oldWindow.webContents.send).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'context-space:ready-check',
      )
    })

    const readyHandler = mocks.ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'context-space:ready',
    )?.[1]
    readyHandler({ sender: currentWindow.webContents })
    await Promise.resolve()

    const message = currentWindow.webContents.send.mock.calls.find(
      ([channel]) => channel === 'context-space:invoke',
    )?.[1]
    const responseHandler = mocks.ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'context-space:response',
    )?.[1]
    responseHandler({ sender: oldWindow.webContents }, {
      requestId: message.requestId,
      success: true,
      data: { sessionId: 'wrong-window' },
    })
    responseHandler({ sender: currentWindow.webContents }, {
      requestId: message.requestId,
      success: true,
      data: { sessionId: 'terminal-1' },
    })

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      data: { sessionId: 'terminal-1' },
    })
  })

  it('当前没有可用主窗口时返回明确失败且不发送 IPC', async () => {
    bridge = new ContextSpaceToolBridge(async () => null)

    await expect(bridge.invoke('open_terminal_tab', { spaceId: 'space-1' })).resolves.toEqual({
      requestId: 'invalid',
      success: false,
      error: 'mainWindow unavailable',
    })
    expect(mocks.ipcMain.on).not.toHaveBeenCalled()
  })

  it('业务请求等待期间窗口销毁时立即失败', async () => {
    const currentWindow = createWindow()
    bridge = new ContextSpaceToolBridge(
      async () => currentWindow as unknown as BrowserWindow,
    )

    const resultPromise = bridge.invoke('open_terminal_tab', { spaceId: 'space-1' })
    const rejection = expect(resultPromise).rejects.toThrow('mainWindow unavailable')
    await vi.waitFor(() => {
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'context-space:ready-check',
      )
    })
    const readyHandler = mocks.ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'context-space:ready',
    )?.[1]
    readyHandler({ sender: currentWindow.webContents })
    await vi.waitFor(() => {
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'context-space:invoke',
        expect.anything(),
      )
    })

    for (const [, handleDestroyed] of currentWindow.webContents.once.mock.calls.filter(
      ([channel]) => channel === 'destroyed',
    )) {
      handleDestroyed()
    }

    await rejection
  })

  it('#5125/#6774：子 frame 导航（webview 后台挂载）不掐断 in-flight 请求', async () => {
    const currentWindow = createWindow()
    bridge = new ContextSpaceToolBridge(
      async () => currentWindow as unknown as BrowserWindow,
    )

    const resultPromise = bridge.invoke('create_web_tab', { spaceId: 'space-1' })
    await vi.waitFor(() => {
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'context-space:ready-check',
      )
    })
    const readyHandler = mocks.ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'context-space:ready',
    )?.[1]
    readyHandler({ sender: currentWindow.webContents })
    await vi.waitFor(() => {
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'context-space:invoke',
        expect.anything(),
      )
    })

    // 模拟 create_web_tab 处理期间后台挂载 <webview>：宿主收到子 frame 导航
    for (const [, handleNavigation] of currentWindow.webContents.on.mock.calls.filter(
      ([channel]) => channel === 'did-start-navigation',
    )) {
      handleNavigation({ isMainFrame: false, isSameDocument: false })
    }

    // 请求不应被拒：renderer 完成后正常回响应
    const message = currentWindow.webContents.send.mock.calls.find(
      ([channel]) => channel === 'context-space:invoke',
    )?.[1]
    const responseHandler = mocks.ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'context-space:response',
    )?.[1]
    responseHandler({ sender: currentWindow.webContents }, {
      requestId: message.requestId,
      success: true,
      data: { viewId: 'view-1' },
    })

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      data: { viewId: 'view-1' },
    })
  })

  it('#5125/#6774：主 frame 真导航（页面 reload）仍立即掐断 in-flight 请求', async () => {
    const currentWindow = createWindow()
    bridge = new ContextSpaceToolBridge(
      async () => currentWindow as unknown as BrowserWindow,
    )

    const resultPromise = bridge.invoke('create_web_tab', { spaceId: 'space-1' })
    const rejection = expect(resultPromise).rejects.toThrow('mainWindow unavailable')
    await vi.waitFor(() => {
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'context-space:ready-check',
      )
    })
    const readyHandler = mocks.ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'context-space:ready',
    )?.[1]
    readyHandler({ sender: currentWindow.webContents })
    await vi.waitFor(() => {
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'context-space:invoke',
        expect.anything(),
      )
    })

    for (const [, handleNavigation] of currentWindow.webContents.on.mock.calls.filter(
      ([channel]) => channel === 'did-start-navigation',
    )) {
      handleNavigation({ isMainFrame: true, isSameDocument: false })
    }

    await rejection
  })

  it('renderer 未确认就绪时在调用超时内失败且不发送业务请求', async () => {
    vi.useFakeTimers()
    const currentWindow = createWindow()
    bridge = new ContextSpaceToolBridge(
      async () => currentWindow as unknown as BrowserWindow,
    )

    const resultPromise = bridge.invoke(
      'open_terminal_tab',
      { spaceId: 'space-1' },
      100,
    )
    const rejection = expect(resultPromise).rejects.toThrow(
      'context-space invoke timeout: open_terminal_tab',
    )

    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(currentWindow.webContents.send).not.toHaveBeenCalledWith(
      'context-space:invoke',
      expect.anything(),
    )
  })

  it('等待窗口期间销毁 bridge 后不会重新注册监听或发送 IPC', async () => {
    const currentWindow = createWindow()
    let resolveWindow!: (window: BrowserWindow) => void
    const windowPromise = new Promise<BrowserWindow>((resolve) => {
      resolveWindow = resolve
    })
    bridge = new ContextSpaceToolBridge(
      () => windowPromise,
    )

    const resultPromise = bridge.invoke('open_terminal_tab', { spaceId: 'space-1' })
    const rejection = expect(resultPromise).rejects.toThrow(
      'context-space bridge destroyed',
    )
    bridge.destroy()
    resolveWindow(currentWindow as unknown as BrowserWindow)

    await rejection
    expect(mocks.ipcMain.on).not.toHaveBeenCalled()
    expect(currentWindow.webContents.send).not.toHaveBeenCalled()
  })
})
