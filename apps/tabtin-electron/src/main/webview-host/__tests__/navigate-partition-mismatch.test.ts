/**
 * webview-host:navigate 的 partition 重建协议测试（ Phase 3 批次 4）。
 *
 * 业务场景：用户在设置页改 Space → BrowserEnvironment 绑定后，已打开的
 * <webview> tab 的 partition 焊死在旧值（partition 属性只能创建时设定）。
 * navigate 比对 renderer 传来的 expectedPartition 与权威条目 partition：
 *   - 一致 / 未传 → 正常导航（向后兼容）
 *   - 不一致 + 无 active run → 广播 crawl-view:partition-rebuilt（复用 WCV
 *     的 toast 链路）+ 返回 code='partition-mismatch' 要求 renderer 销毁
 *     元素以新 partition 重建
 *   - 不一致 + active run → 不打断任务，返回 skipped 延迟到 run 结束收敛
 *
 * 语义对照 WCV 的 crawl-view:show partition-rebuild（partition-rebuild.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetViewState,
  mockGetWebContents,
  mockCheckViewTaskLock,
  mockGetRunIdByView,
  mockGetRun,
  mockValidateNavigationUrl,
} = vi.hoisted(() => ({
  mockGetViewState: vi.fn(),
  mockGetWebContents: vi.fn(),
  mockCheckViewTaskLock: vi.fn(() => false),
  mockGetRunIdByView: vi.fn((): string | undefined => undefined),
  mockGetRun: vi.fn(),
  mockValidateNavigationUrl: vi.fn(() => ({ ok: true })),
}))

const ipcHandlerMap = new Map<string, (...args: any[]) => any>()
const mockBrowserWindowList: Array<{ isDestroyed: () => boolean; webContents: { send: (...args: any[]) => void } }> = []

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/tabtin-test') },
  session: {
    fromPartition: vi.fn(() => ({})),
    defaultSession: {},
  },
  webContents: { fromId: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => mockBrowserWindowList,
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}))

vi.mock('../../utils/guarded-handle', () => ({
  guardedHandle: (channel: string, handler: any) => {
    ipcHandlerMap.set(channel, handler)
  },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

vi.mock('../../window-manager', () => ({
  getMainWindow: () => mockBrowserWindowList[0] ?? null,
}))

vi.mock('../../../shared/browser-container-mode', () => ({
  resolveBrowserContainerMode: () => 'webview',
}))

vi.mock('../../view-factory', () => ({
  getViewFactory: () => ({
    getViewState: mockGetViewState,
    getWebContents: mockGetWebContents,
  }),
}))

vi.mock('../../crawl-view/view-display', () => ({
  checkViewTaskLock: mockCheckViewTaskLock,
}))

vi.mock('../../run-session/RunSessionManager', () => ({
  getRunSessionManager: () => ({
    getRunIdByView: mockGetRunIdByView,
    getRun: mockGetRun,
  }),
}))

vi.mock('../../crawl-view/utils', () => ({
  validateNavigationUrl: mockValidateNavigationUrl,
}))

import { registerWebviewHostIpcHandlers, __resetWebviewHostForTesting } from '../webview-host'

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  }
}

function makeWebContents(url = 'https://old.example.com') {
  return {
    isDestroyed: () => false,
    getURL: () => url,
    loadURL: vi.fn(async () => undefined),
  }
}

async function invokeNavigate(tabId: string, url: string, options?: { expectedPartition?: string }) {
  const handler = ipcHandlerMap.get('webview-host:navigate')
  if (!handler) throw new Error('webview-host:navigate 未注册')
  return handler({}, tabId, url, options)
}

describe('webview-host:navigate — partition 重建协议', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBrowserWindowList.length = 0
    mockBrowserWindowList.push(makeWindow())
    __resetWebviewHostForTesting()
    // registerWebviewHostIpcHandlers 有模块级幂等 flag，重复调用是 no-op；
    // handler 引用不变，跨用例复用 ipcHandlerMap 即可
    registerWebviewHostIpcHandlers()

    mockCheckViewTaskLock.mockReturnValue(false)
    mockValidateNavigationUrl.mockReturnValue({ ok: true })
    mockGetViewState.mockReturnValue({
      containerKind: 'webview-tag',
      config: { partition: 'persist:tabtin:env:old', metadata: {} },
    })
    mockGetWebContents.mockReturnValue(makeWebContents())
  })

  it('expectedPartition 与当前一致 → 正常导航', async () => {
    const wc = makeWebContents()
    mockGetWebContents.mockReturnValue(wc)

    const result = await invokeNavigate('tab-1', 'https://target.com', {
      expectedPartition: 'persist:tabtin:env:old',
    })

    expect(result).toEqual({ success: true })
    expect(wc.loadURL).toHaveBeenCalledWith('https://target.com')
  })

  it('未传 expectedPartition → 不触发 mismatch 分支（向后兼容）', async () => {
    const wc = makeWebContents()
    mockGetWebContents.mockReturnValue(wc)

    const result = await invokeNavigate('tab-1', 'https://target.com')

    expect(result).toEqual({ success: true })
    expect(wc.loadURL).toHaveBeenCalled()
    expect(mockBrowserWindowList[0].webContents.send).not.toHaveBeenCalled()
  })

  it('partition 不一致 + 无 active run → 广播 partition-rebuilt + 返回 partition-mismatch', async () => {
    mockGetRunIdByView.mockReturnValue(undefined)
    const wc = makeWebContents()
    mockGetWebContents.mockReturnValue(wc)

    const result = await invokeNavigate('tab-1', 'https://target.com', {
      expectedPartition: 'persist:tabtin:env:new',
    })

    expect(result).toMatchObject({ success: false, code: 'partition-mismatch' })
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(mockBrowserWindowList[0].webContents.send).toHaveBeenCalledWith('crawl-view:partition-rebuilt', {
      tabId: 'tab-1',
      oldPartition: 'persist:tabtin:env:old',
      newPartition: 'persist:tabtin:env:new',
      reason: 'env-binding-changed',
    })
  })

  it('partition 不一致 + active run → 不打断，返回 skipped 延迟重建', async () => {
    mockGetRunIdByView.mockReturnValue('run-1')
    mockGetRun.mockReturnValue({ id: 'run-1' })
    const wc = makeWebContents()
    mockGetWebContents.mockReturnValue(wc)

    const result = await invokeNavigate('tab-1', 'https://target.com', {
      expectedPartition: 'persist:tabtin:env:new',
    })

    expect(result).toMatchObject({ success: true, skipped: 'partition-rebuild-deferred', deferred: 'run-in-progress' })
    expect(wc.loadURL).not.toHaveBeenCalled()
    // run 进行中不弹 toast（未真正重建）
    expect(mockBrowserWindowList[0].webContents.send).not.toHaveBeenCalled()
  })

  it('run 记录已不存在（残留 viewToRun 映射）→ 按无 run 处理，照常重建', async () => {
    mockGetRunIdByView.mockReturnValue('run-stale')
    mockGetRun.mockReturnValue(undefined)

    const result = await invokeNavigate('tab-1', 'https://target.com', {
      expectedPartition: 'persist:tabtin:env:new',
    })

    expect(result).toMatchObject({ success: false, code: 'partition-mismatch' })
  })

  it('广播发给所有窗口，已销毁窗口跳过', async () => {
    const win2 = makeWindow()
    const destroyedWin = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    mockBrowserWindowList.push(destroyedWin, win2)

    await invokeNavigate('tab-1', 'https://target.com', {
      expectedPartition: 'persist:tabtin:env:new',
    })

    expect(mockBrowserWindowList[0].webContents.send).toHaveBeenCalledWith('crawl-view:partition-rebuilt', expect.anything())
    expect(win2.webContents.send).toHaveBeenCalledWith('crawl-view:partition-rebuilt', expect.anything())
    expect(destroyedWin.webContents.send).not.toHaveBeenCalled()
  })

  it('task-lock 优先级高于 partition mismatch（run 占用的 view 不触发重建）', async () => {
    mockCheckViewTaskLock.mockReturnValue(true)

    const result = await invokeNavigate('tab-1', 'https://target.com', {
      expectedPartition: 'persist:tabtin:env:new',
    })

    expect(result).toEqual({ success: true, skipped: 'task-lock' })
    expect(mockBrowserWindowList[0].webContents.send).not.toHaveBeenCalled()
  })
})
