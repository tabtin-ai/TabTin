import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockShow,
  mockWinRtShow,
  windowState,
  cliState,
  notificationState,
  MockNotification,
} = vi.hoisted(() => {
  const mockShow = vi.fn()
  const mockWinRtShow = vi.fn(async () => ({ ok: true, detail: 'ok:Enabled' }))
  const windowState = {
    windows: [] as Array<any>,
    mainWindow: null as any,
  }
  const cliState = {
    spaceId: null as string | null,
    organizationId: null as string | null,
  }
  const notificationState = {
    clickHandler: null as (() => void) | null,
  }

  class MockNotification {
    constructor(_options: unknown) {}

    static isSupported() {
      return true
    }

    on(event: string, handler: () => void) {
      if (event === 'click') {
        notificationState.clickHandler = handler
      }
    }

    show() {
      mockShow()
    }
  }

  return {
    mockShow,
    mockWinRtShow,
    windowState,
    cliState,
    notificationState,
    MockNotification,
  }
})

vi.mock('electron', () => ({
  Notification: MockNotification,
  app: {
    getAppPath: () => 'C:\\fake-app',
  },
}))

vi.mock('../../../window-manager', () => ({
  getAllWindows: () => windowState.windows,
  getMainWindow: () => windowState.mainWindow,
}))

vi.mock('../../../cli/cli-context', () => ({
  getCLISpaceId: () => cliState.spaceId,
  getCLIOrganizationId: () => cliState.organizationId,
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../win-rt-toast', () => ({
  showWindowsRtToast: mockWinRtShow,
  WIN_TOAST_BANNER_SECONDS_DEFAULT: 5,
}))

import { OsNotificationPresenter } from '../presenter'

function createMockWindow(options: {
  focused?: boolean
  visible?: boolean
  minimized?: boolean
  loading?: boolean
} = {}) {
  const didFinishLoadHandlers: Array<() => void> = []
  let focused = options.focused ?? false
  let visible = options.visible ?? true
  let minimized = options.minimized ?? false
  let loading = options.loading ?? false

  return {
    isFocused: () => focused,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isDestroyed: () => false,
    restore: vi.fn(() => { minimized = false }),
    focus: vi.fn(() => { focused = true }),
    show: vi.fn(() => { visible = true }),
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => loading),
      once: vi.fn((event: string, handler: () => void) => {
        if (event === 'did-finish-load') {
          didFinishLoadHandlers.push(handler)
        }
      }),
    },
    emitDidFinishLoad: () => {
      loading = false
      for (const handler of didFinishLoadHandlers.splice(0, didFinishLoadHandlers.length)) {
        handler()
      }
    },
  }
}

/** 当前平台若是 win32，presenter 走 WinRT；否则走 Electron Notification。 */
function expectToastDispatched() {
  if (process.platform === 'win32') {
    expect(mockWinRtShow).toHaveBeenCalled()
    expect(mockShow).not.toHaveBeenCalled()
  } else {
    expect(mockShow).toHaveBeenCalled()
  }
}

function expectToastNotDispatched() {
  expect(mockWinRtShow).not.toHaveBeenCalled()
  expect(mockShow).not.toHaveBeenCalled()
}

describe('OsNotificationPresenter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    windowState.windows = []
    windowState.mainWindow = null
    cliState.spaceId = null
    cliState.organizationId = null
    notificationState.clickHandler = null
    mockWinRtShow.mockResolvedValue({ ok: true, detail: 'ok:Enabled' })
    process.env.TABTIN_APP_ID = 'com.tabtin.app.preprod'
  })

  it('当前窗口已聚焦且 organization 未变化时会抑制非豁免普通桌面通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'agent.task.completed',
      title: 'same organization',
      body: 'body',
      organizationId: 'ws-1',
    }, true)

    expectToastNotDispatched()
  })

  it('当前窗口已聚焦时仍显示 IM 桌面通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'im.message',
      title: '张三',
      body: 'hello',
      organizationId: 'ws-1',
    }, true)

    expectToastDispatched()
  })

  it('WinRT 路径会带上 protocol launchUrl 供点击跳转', () => {
    if (process.platform !== 'win32') return

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'im.message',
      title: '张三',
      body: 'hello',
      navigateTo: { type: 'im-conversation', id: 'conv-1', organizationId: 'ws-1' },
    }, true)

    expect(mockWinRtShow).toHaveBeenCalledWith(
      expect.objectContaining({
        launchUrl: expect.stringMatching(/^tabtin:\/\/notify\?d=/),
      }),
    )
  })

  it('当前窗口已聚焦时仍显示下载完成桌面通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'download.completed',
      title: '下载完成',
      body: 'report.pdf',
    }, true)

    expectToastDispatched()
  })

  it('当前窗口已聚焦时仍显示同组织 Extension 桌面通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'extension_event',
      title: '插件事件',
      body: 'body',
      organizationId: 'ws-1',
    }, true)

    expectToastDispatched()
  })

  it('当前窗口已聚焦时仍显示自动化任务完成通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'
    cliState.spaceId = 'space-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'tracker.run.completed',
      title: '自动化任务执行完成',
      body: '点击查看本次执行结果。',
      organizationId: 'ws-1',
      spaceId: 'space-1',
      priority: 'normal',
    }, true)

    expectToastDispatched()
  })

  it('当前窗口已聚焦时仍显示自动化任务失败通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'
    cliState.spaceId = 'space-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'tracker.run.failed',
      title: '自动化任务执行失败',
      body: '点击查看失败原因。',
      organizationId: 'ws-1',
      spaceId: 'space-1',
      priority: 'high',
    }, true)

    expectToastDispatched()
  })

  it('当前窗口已聚焦但目标 organization 不同时仍会显示桌面通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'agent.task.completed',
      title: 'cross organization',
      body: 'body',
      organizationId: 'ws-2',
    }, true)

    expectToastDispatched()
  })

  it('会基于 navigateTo.organizationId 判断跨 organization 通知', () => {
    windowState.windows = [{ isFocused: () => true }]
    cliState.organizationId = 'ws-1'

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'tracker.run.completed',
      title: 'goal',
      body: 'body',
      navigateTo: {
        type: 'tracker',
        id: 'tracker-1',
        organizationId: 'ws-3',
      },
    }, true)

    expectToastDispatched()
  })

  it('WinRT 失败时回退到 Electron Notification', async () => {
    if (process.platform !== 'win32') return

    mockWinRtShow.mockResolvedValueOnce({ ok: false, detail: 'timeout' })
    windowState.windows = [{ isFocused: () => false }]

    const presenter = new OsNotificationPresenter()
    presenter.show({
      type: 'im.message',
      title: 'fallback',
      body: 'body',
    }, true)

    expect(mockWinRtShow).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockShow).toHaveBeenCalledTimes(1)
  })

  it('主窗口最小化时，通知点击会恢复窗口并等待加载后导航', async () => {
    if (process.platform === 'win32') {
      // WinRT 路径暂不接线 click；强制走 Electron fallback 测点击
      mockWinRtShow.mockResolvedValueOnce({ ok: false, detail: 'force-electron' })
    }

    const mainWindow = createMockWindow({ loading: true, visible: false, minimized: true })
    const ensureMainWindow = vi.fn().mockResolvedValue(mainWindow)

    windowState.mainWindow = null
    windowState.windows = []

    const presenter = new OsNotificationPresenter()
    presenter.setEnsureMainWindow(ensureMainWindow)
    presenter.show({
      type: 'tracker.run.completed',
      title: 'goal',
      body: 'body',
      navigateTo: {
        type: 'tracker',
        id: 'tracker-1',
        organizationId: 'ws-2',
      },
    }, true)

    if (process.platform !== 'win32') {
      expect((presenter as unknown as { activeNotifications: Set<unknown> }).activeNotifications.size).toBe(1)
    }

    if (process.platform === 'win32') {
      await Promise.resolve()
      await Promise.resolve()
    }

    notificationState.clickHandler?.()
    await Promise.resolve()

    if (process.platform !== 'win32') {
      expect((presenter as unknown as { activeNotifications: Set<unknown> }).activeNotifications.size).toBe(0)
    }
    await Promise.resolve()

    expect(ensureMainWindow).toHaveBeenCalledTimes(1)
    expect(mainWindow.restore).toHaveBeenCalled()
    expect(mainWindow.show).toHaveBeenCalled()
    expect(mainWindow.focus).toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()

    mainWindow.emitDidFinishLoad()

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('notification:navigate', {
      type: 'tracker',
      id: 'tracker-1',
      organizationId: 'ws-2',
    })
  })
})
