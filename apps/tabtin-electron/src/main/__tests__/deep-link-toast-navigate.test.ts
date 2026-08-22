/**
 * WinRT toast → tabtin://notify 协议激活：确保主窗 + 等加载再发 notification:navigate
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    listeners,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    }),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAsDefaultProtocolClient: vi.fn(),
    defaultApp: false,
  }
})

vi.mock('electron', () => ({
  app: {
    on: electronState.on,
    quit: electronState.quit,
    requestSingleInstanceLock: electronState.requestSingleInstanceLock,
    setAsDefaultProtocolClient: electronState.setAsDefaultProtocolClient,
    get defaultApp() {
      return electronState.defaultApp
    },
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
  },
}))

import { createDeepLinkController } from '../deep-link'
import { buildToastLaunchUrl } from '../services/notification/notify-launch'

type Handler = (...args: unknown[]) => void

function createMockWindow(opts: { loading?: boolean; visible?: boolean } = {}) {
  const finishHandlers: Handler[] = []
  const failHandlers: Handler[] = []
  const readyHandlers: Handler[] = []
  const send = vi.fn()
  const show = vi.fn()
  const focus = vi.fn()
  const restore = vi.fn()
  let loading = opts.loading ?? false
  let visible = opts.visible ?? true

  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => visible,
    show: () => {
      visible = true
      show()
    },
    focus,
    restore,
    once: (event: string, handler: Handler) => {
      if (event === 'ready-to-show') readyHandlers.push(handler)
    },
    webContents: {
      isLoading: () => loading,
      send,
      once: (event: string, handler: Handler) => {
        if (event === 'did-finish-load') finishHandlers.push(handler)
        if (event === 'did-fail-load') failHandlers.push(handler)
      },
    },
    emitDidFinishLoad: () => {
      loading = false
      for (const handler of [...finishHandlers]) handler()
      finishHandlers.length = 0
    },
    emitReadyToShow: () => {
      for (const handler of [...readyHandlers]) handler()
      readyHandlers.length = 0
    },
    mocks: { send, show, focus, restore },
  }
}

describe('deep-link toast navigate ', () => {
  beforeEach(() => {
    electronState.listeners.clear()
    vi.clearAllMocks()
    electronState.requestSingleInstanceLock.mockReturnValue(true)
  })

  it('主窗加载中时推迟 show 与 notification:navigate，加载完成后再派发', async () => {
    const mainWindow = createMockWindow({ loading: true, visible: false })
    const controller = createDeepLinkController({
      log: { debug: vi.fn(), error: vi.fn() },
      getMainWindow: () => mainWindow as never,
    })

    const url = buildToastLaunchUrl({
      type: 'im-conversation',
      id: 'conv-1',
      organizationId: 'org-1',
    })
    controller.handleSecondInstance(['TabTin.exe', url])

    await Promise.resolve()
    await Promise.resolve()

    expect(mainWindow.mocks.show).not.toHaveBeenCalled()
    expect(mainWindow.mocks.send).not.toHaveBeenCalled()

    mainWindow.emitDidFinishLoad()
    await Promise.resolve()

    expect(mainWindow.mocks.send).toHaveBeenCalledWith('notification:navigate', {
      type: 'im-conversation',
      id: 'conv-1',
      organizationId: 'org-1',
    })
    expect(mainWindow.mocks.show).toHaveBeenCalled()
    expect(mainWindow.mocks.focus).toHaveBeenCalled()
  })

  it('主窗缺失时经 ensureMainWindow 拉起再导航', async () => {
    const mainWindow = createMockWindow({ loading: false, visible: false })
    const ensureMainWindow = vi.fn().mockResolvedValue(mainWindow)

    const controller = createDeepLinkController({
      log: { debug: vi.fn(), error: vi.fn() },
      getMainWindow: () => null,
    })
    controller.setEnsureMainWindow(ensureMainWindow)

    const url = buildToastLaunchUrl({ type: 'im-conversation', id: 'conv-2' })
    controller.handleSecondInstance(['electron', url])

    await vi.waitFor(() => {
      expect(ensureMainWindow).toHaveBeenCalledTimes(1)
      expect(mainWindow.mocks.send).toHaveBeenCalledWith('notification:navigate', {
        type: 'im-conversation',
        id: 'conv-2',
      })
    })
    expect(mainWindow.mocks.show).toHaveBeenCalled()
  })

  it('tabtin://focus 只聚焦，不发 notification:navigate', async () => {
    const mainWindow = createMockWindow({ loading: false, visible: true })
    const controller = createDeepLinkController({
      log: { debug: vi.fn(), error: vi.fn() },
      getMainWindow: () => mainWindow as never,
    })

    controller.handleSecondInstance(['TabTin.exe', 'tabtin://focus'])
    await Promise.resolve()
    await Promise.resolve()

    expect(mainWindow.mocks.focus).toHaveBeenCalled()
    expect(mainWindow.mocks.send).not.toHaveBeenCalled()
  })
})
