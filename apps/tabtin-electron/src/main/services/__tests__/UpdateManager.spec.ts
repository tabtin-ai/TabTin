import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  const authListeners = new Set<() => void>()
  const fileStore = new Map<string, string>()
  const setFeedURL = vi.fn()
  const checkForUpdates = vi.fn()
  const downloadUpdate = vi.fn()
  const quitAndInstall = vi.fn()
  const removeAllListeners = vi.fn(() => listeners.clear())
  const on = vi.fn((event: string, handler: (...args: any[]) => void) => {
    const current = listeners.get(event) ?? []
    current.push(handler)
    listeners.set(event, current)
    return autoUpdater
  })

  const autoUpdater = {
    logger: null as any,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    setFeedURL,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    removeAllListeners,
    on,
  }

  return {
    autoUpdater,
    setFeedURL,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    on,
    tokenGetUserInfo: vi.fn(),
    tokenGetAccessToken: vi.fn(),
    tokenOnAuthChanged: vi.fn((cb: () => void) => {
      authListeners.add(cb)
      return () => {
        authListeners.delete(cb)
      }
    }),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    showMessageBox: vi.fn(),
    showMessageBoxSync: vi.fn(),
    showErrorBox: vi.fn(),
    fileStore,
    mkdtempSync: vi.fn((prefix: string) => `${prefix}mock`),
    existsSync: vi.fn((path: string) => fileStore.has(String(path))),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((path: string) => fileStore.get(String(path)) ?? ''),
    rmSync: vi.fn((path: string) => {
      fileStore.delete(String(path))
    }),
    writeFileSync: vi.fn((path: string, data: string | Buffer) => {
      fileStore.set(String(path), String(data))
    }),
    reset() {
      listeners.clear()
      authListeners.clear()
      fileStore.clear()
      setFeedURL.mockReset()
      checkForUpdates.mockReset()
      downloadUpdate.mockReset()
      quitAndInstall.mockReset()
      removeAllListeners.mockClear()
      on.mockClear()
      this.tokenGetUserInfo.mockReset()
      this.tokenGetAccessToken.mockReset()
      this.tokenOnAuthChanged.mockClear()
      this.logInfo.mockReset()
      this.logWarn.mockReset()
      this.logError.mockReset()
      this.showMessageBox.mockReset()
      this.showMessageBoxSync.mockReset()
      this.showErrorBox.mockReset()
      this.mkdtempSync.mockClear()
      this.existsSync.mockClear()
      this.mkdirSync.mockClear()
      this.readFileSync.mockClear()
      this.rmSync.mockClear()
      this.writeFileSync.mockClear()
      autoUpdater.logger = null
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.forceDevUpdateConfig = false
    },
    emit(event: string, ...args: any[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args)
      }
    },
    emitAuthChanged() {
      for (const handler of authListeners) {
        handler()
      }
    },
  }
})

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: mocks.autoUpdater,
  },
  autoUpdater: mocks.autoUpdater,
}))

vi.mock('node:fs', async () => {
  const actualModule = await vi.importActual<any>('node:fs')
  const actual = actualModule.default ?? actualModule
  const patched = {
    ...actual,
    mkdtempSync: mocks.mkdtempSync,
    existsSync: mocks.existsSync,
    mkdirSync: mocks.mkdirSync,
    readFileSync: mocks.readFileSync,
    rmSync: mocks.rmSync,
    writeFileSync: mocks.writeFileSync,
  }
  return {
    ...patched,
    default: patched,
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '1.0.0'),
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => '/tmp/tabtin-user-data'),
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
    showMessageBoxSync: mocks.showMessageBoxSync,
    showErrorBox: mocks.showErrorBox,
  },
}))

vi.mock('electron-log', () => ({
  default: {
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    transports: {
      file: {
        level: 'info',
      },
    },
  },
}))

vi.mock('../../auth', () => ({
  TokenManager: {
    getUserInfo: mocks.tokenGetUserInfo,
    getAccessToken: mocks.tokenGetAccessToken,
    onAuthChanged: mocks.tokenOnAuthChanged,
  },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'https://api.example.com/api',
}))

// notification 链路会拉起 logger / guarded-handle 等主进程基础设施，单测里直接断开
vi.mock('../notification', () => ({
  notificationService: {
    show: vi.fn(),
  },
}))

import { app } from 'electron'
import { UpdateManager } from '../UpdateManager'

describe('UpdateManager', () => {
  beforeEach(() => {
    mocks.reset()
    mocks.tokenGetUserInfo.mockResolvedValue({ id: 'user-1' })
    mocks.tokenGetAccessToken.mockResolvedValue('token-1')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    ;(app as any).isPackaged = false
    vi.mocked(app.getAppPath).mockReturnValue(process.cwd())
  })

  it('packaged app 不强制读取开发态 updater 配置', () => {
    ;(app as any).isPackaged = true

    new UpdateManager({
      checkOnStartup: false,
    })

    expect(mocks.autoUpdater.forceDevUpdateConfig).toBe(false)
  })

  it('开发态才允许读取 dev updater 配置', () => {
    ;(app as any).isPackaged = false

    new UpdateManager({
      checkOnStartup: false,
    })

    expect(mocks.autoUpdater.forceDevUpdateConfig).toBe(true)
  })

  it('获取版本历史会使用运行时平台默认渠道并限制 limit', async () => {
    const manager = new UpdateManager({
      checkOnStartup: false,
      updateServerUrl: 'https://cdn.example.com/desktop-updates/alpha/win/x64/',
    })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [
            {
              version: '1.2.0',
              release_notes: '后台发布说明',
            },
          ],
        },
      }),
    } as any)

    const result = await manager.fetchReleaseHistory({ limit: 999, locale: 'zh-CN' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`https://api.example.com/api/updates/releases?platform=${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}&arch=${process.arch === 'arm64' ? 'arm64' : 'x64'}&channel=stable&limit=50&locale=zh-CN`)
    expect(init).toMatchObject({ method: 'GET' })
    expect(result).toEqual([{ version: '1.2.0', release_notes: '后台发布说明' }])
  })

  it('获取版本历史允许显式覆盖平台架构渠道', async () => {
    const manager = new UpdateManager({ checkOnStartup: false })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { items: [] },
      }),
    } as any)

    await manager.fetchReleaseHistory({ platform: 'win', arch: 'x64', channel: 'alpha', limit: 10 })

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/api/updates/releases?platform=win&arch=x64&channel=alpha&limit=10')
  })

  it('获取版本历史会透出后端错误', async () => {
    const manager = new UpdateManager({ checkOnStartup: false })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        message: 'release history unavailable',
      }),
    } as any)

    await expect(manager.fetchReleaseHistory({ platform: 'win', arch: 'x64', channel: 'beta' })).rejects.toThrow('release history unavailable')
  })

  it('手动检查更新时会先用后端返回的 feed_url 覆盖 generic feed', async () => {
    const runtimeArch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const runtimePlatform = process.platform === 'darwin'
      ? 'mac'
      : process.platform === 'win32'
        ? 'win'
        : 'linux'
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: true,
          version: '1.1.0',
          release_notes: 'Desktop improvements',
          feed_url: 'https://cdn.example.com/desktop-updates/stable/win/x64/1.1.0',
          manifest_url: 'https://cdn.example.com/desktop-updates/stable/win/x64/1.1.0/latest.yml',
        },
      }),
    } as any)
    mocks.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '1.1.0',
      },
    })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })
    mocks.setFeedURL.mockClear()

    const result = await manager.checkForUpdates(false, 'manual')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/updates/check',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      current_version: '1.0.0',
      platform: runtimePlatform,
      arch: runtimeArch,
      channel: 'stable',
      user_id: 'user-1',
      trigger_source: 'manual',
    })
    expect(mocks.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://cdn.example.com/desktop-updates/stable/win/x64/1.1.0/',
    })
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(result?.updateInfo?.version).toBe('1.1.0')
  })

  it('后端判定无更新时会短路，不触发 electron-updater 检查', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: false,
        },
      }),
    } as any)

    const manager = new UpdateManager({
      checkOnStartup: false,
    })
    mocks.setFeedURL.mockClear()

    const result = await manager.checkForUpdates(true, 'background')

    expect(result).toBeNull()
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://cdn.example.com/releases/',
    })
    expect(manager.getState()).toMatchObject({
      status: 'idle',
      updateInfo: null,
      releaseSource: null,
    })
  })

  it('未登录启动检查仍会调用后端检查更新', async () => {
    mocks.tokenGetUserInfo.mockRejectedValue(new Error('not logged in'))
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: false,
        },
      }),
    } as any)

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    await manager.checkForUpdates(true, 'startup')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/updates/check',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      current_version: '1.0.0',
      trigger_source: 'http_poll',
    })
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).not.toHaveProperty('user_id')
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
  })

  it('重复检查请求会合并为一次后端和 electron-updater 检查', async () => {
    let resolveCheckResponse!: (value: any) => void
    const pendingCheckResponse = new Promise((resolve) => {
      resolveCheckResponse = resolve
    })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/updates/check')) {
        return pendingCheckResponse as any
      }
      return { ok: true, json: async () => ({ success: true }) } as any
    })
    mocks.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '1.8.0',
      },
    })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    const startupCheck = manager.checkForUpdates(true, 'startup')
    const manualCheck = manager.checkForUpdates(false, 'manual')

    resolveCheckResponse({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: true,
          version: '1.8.0',
          feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.8.0',
        },
      }),
    })

    await Promise.all([startupCheck, manualCheck])

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/updates/check'))).toHaveLength(1)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
  })

  it('指定版本准备检查不会复用正在进行的普通检查', async () => {
    let resolveGeneralCheck!: (value: any) => void
    const pendingGeneralCheck = new Promise((resolve) => {
      resolveGeneralCheck = resolve
    })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/updates/check')) {
        return pendingGeneralCheck as any
      }
      return { ok: true, json: async () => ({ success: true }) } as any
    })
    mocks.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '2.0.0',
      },
    })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    const generalCheck = manager.checkForUpdates(true, 'startup')
    const preparedCheck = await manager.checkForUpdates(true, 'ws_push', '2.0.0')

    expect(preparedCheck?.updateInfo?.version).toBe('2.0.0')
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)

    resolveGeneralCheck({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: false,
        },
      }),
    })
    await generalCheck

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/updates/check'))).toHaveLength(1)
  })

  it('普通检查进入 electron-updater 后，指定版本准备检查会排队并重新检查', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: true,
          version: '1.9.0',
          feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.9.0',
        },
      }),
    } as any)

    let resolveUpdaterCheck!: (value: any) => void
    const pendingUpdaterCheck = new Promise((resolve) => {
      resolveUpdaterCheck = resolve
    })
    mocks.checkForUpdates
      .mockReturnValueOnce(pendingUpdaterCheck)
      .mockResolvedValueOnce({
        updateInfo: {
          version: '2.0.0',
        },
      })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    const generalCheck = manager.checkForUpdates(true, 'startup')

    await vi.waitFor(() => {
      expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    const preparedCheck = manager.checkForUpdates(true, 'ws_push', '2.0.0')
    await Promise.resolve()
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)

    resolveUpdaterCheck({
      updateInfo: {
        version: '1.9.0',
      },
    })

    await generalCheck
    const preparedResult = await preparedCheck

    expect(preparedResult?.updateInfo?.version).toBe('2.0.0')
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('手动检查无更新或失败时不再弹主进程原生提示', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: false,
        },
      }),
    } as any)

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    await manager.checkForUpdates(false, 'manual')
    expect(mocks.showMessageBox).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as any)

    await expect(manager.checkForUpdates(false, 'manual')).rejects.toThrow('后端检查更新失败')
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
  })

  it('登录后 auth change 会立即触发 WS 重连', async () => {
    mocks.tokenGetAccessToken.mockResolvedValueOnce(null).mockResolvedValue('token-1')
    mocks.tokenGetUserInfo.mockResolvedValue({
      id: 'user-1',
      organization_id: 'organization-1',
    })
    const connectWithAuth = vi.fn().mockResolvedValue(true)
    const wsClient = {
      on: vi.fn(() => () => undefined),
      getStatus: vi.fn(() => 'idle'),
      connectWithAuth,
      getDeviceId: vi.fn(() => 'device-1'),
      close: vi.fn(),
    }

    const manager = new UpdateManager({
      checkOnStartup: false,
    })
    manager.setWsClient(wsClient as any)

    await vi.waitFor(() => {
      expect(mocks.tokenGetAccessToken).toHaveBeenCalled()
    })

    mocks.emitAuthChanged()

    await vi.waitFor(() => {
      expect(connectWithAuth).toHaveBeenCalledWith(expect.objectContaining({
        token: 'token-1',
        organizationId: 'organization-1',
      }))
    })

    manager.destroy()
    expect(wsClient.close).toHaveBeenCalled()
  })

  it('WS push 只当叫醒信号：先回查后端，用后端返回的 feed_url 准备更新', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/updates/check')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              has_update: true,
              version: '1.2.0',
              release_notes: 'Silent rollout',
              feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.2.0',
              manifest_url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.2.0/latest-mac.yml',
              mandatory: false,
              priority: 'normal',
            },
          }),
        } as any
      }
      return { ok: true, json: async () => ({ success: true }) } as any
    })
    mocks.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '1.2.0',
      },
    })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })
    mocks.setFeedURL.mockClear()

    ;(manager as any).handleWsUpdatePush({
      version: '1.2.0',
      // push payload 故意带与后端不同的 feed_url：必须以后端回查结果为准
      feed_url: 'https://evil.example.com/feed',
      silent: true,
      rollout_percentage: 100,
    })

    await vi.waitFor(() => {
      expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(mocks.autoUpdater.autoDownload).toBe(false)
    })

    // 回查走了后端 /updates/check（trigger_source = ws_push）
    const checkCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/updates/check'))
    expect(checkCall).toBeTruthy()
    expect(JSON.parse((checkCall![1] as RequestInit).body as string)).toMatchObject({
      trigger_source: 'ws_push',
    })

    // feed 用的是后端返回的 URL，不是 push payload 里的
    expect(mocks.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.2.0/',
    })
  })

  it('WS push 回查后端判定无更新时不进入下载流程', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          has_update: false,
        },
      }),
    } as any)

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    ;(manager as any).handleWsUpdatePush({
      version: '9.9.9',
      silent: true,
      rollout_percentage: 100,
    })

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.downloadUpdate).not.toHaveBeenCalled()
    expect(manager.getState().status).toBe('idle')
  })

  it('WS 不可用时进度埋点 fallback 到 HTTP /updates/progress', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/updates/check')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              has_update: true,
              version: '1.3.0',
              feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.3.0',
            },
          }),
        } as any
      }
      return { ok: true, json: async () => ({ success: true }) } as any
    })
    mocks.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '1.3.0',
      },
    })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    // 未注册 wsClient → reportProgress 应走 HTTP 兜底
    await manager.checkForUpdates(true, 'background')

    await vi.waitFor(() => {
      const progressCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/updates/progress'),
      )
      expect(progressCall).toBeTruthy()
      expect((progressCall![1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer token-1',
      })
      expect(JSON.parse((progressCall![1] as RequestInit).body as string)).toMatchObject({
        version: '1.3.0',
        status: 'checking',
        from_version: '1.0.0',
      })
    })
  })

  it('mandatory 更新不等用户点击，检查到即自动开始下载', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/updates/check')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              has_update: true,
              version: '1.4.0',
              feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.4.0',
              mandatory: true,
              priority: 'high',
            },
          }),
        } as any
      }
      return { ok: true, json: async () => ({ success: true }) } as any
    })
    mocks.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '1.4.0',
      },
    })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })

    await manager.checkForUpdates(true, 'background')

    await vi.waitFor(() => {
      expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1)
    })
    expect(manager.getState().status).toBe('downloading')
  })

  it('mandatory 更新下载完成后阻断：只有立即重启一条路', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/updates/check')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              has_update: true,
              version: '1.4.0',
              feed_url: 'https://cdn.example.com/desktop-updates/stable/mac/x64/1.4.0',
              mandatory: true,
            },
          }),
        } as any
      }
      return { ok: true, json: async () => ({ success: true }) } as any
    })
    mocks.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: '1.4.0',
      },
    })
    mocks.showMessageBox.mockResolvedValue({ response: 0 })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })
    const send = vi.fn()
    const mainWindow = { webContents: { send }, isDestroyed: () => false } as any
    manager.setMainWindow(mainWindow)

    // 先让 lastBackendHint 带上 mandatory（与真实下载链路一致）
    await manager.checkForUpdates(true, 'background')

    mocks.emit('update-downloaded', { version: '1.4.0' })

    await vi.waitFor(() => {
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        mainWindow,
        expect.objectContaining({
          buttons: ['立即重启并安装'],
        }),
      )
      expect(send).toHaveBeenCalledWith('update-event', {
        event: 'update-restart-dialog-open',
        data: {
          version: '1.4.0',
          mandatory: true,
        },
      })
      expect(mocks.quitAndInstall).toHaveBeenCalled()
    })
  })

  it('非 mandatory 更新下载完成后可以稍后重启', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })

    const manager = new UpdateManager({
      checkOnStartup: false,
    })
    const mainWindow = {
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
    } as any
    manager.setMainWindow(mainWindow)

    mocks.emit('update-downloaded', { version: '1.5.0' })

    await vi.waitFor(() => {
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        mainWindow,
        expect.objectContaining({
          buttons: ['稍后重启', '立即重启'],
        }),
      )
    })
    expect(mocks.quitAndInstall).not.toHaveBeenCalled()
  })

  it('重启安装前会写入待安装版本标记，用于下次启动上报 installed', async () => {
    const manager = new UpdateManager({
      checkOnStartup: false,
    })
    ;(manager as any).currentDownloadVersion = '1.6.0'
    ;(manager as any).runtimeState.updateInfo = { version: '1.6.0' }

    manager.quitAndInstall()

    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      '/tmp/tabtin-user-data/pending-update-install.json',
      expect.stringContaining('"version":"1.6.0"'),
      expect.objectContaining({ encoding: 'utf-8' }),
    )
    expect(mocks.quitAndInstall).toHaveBeenCalled()
  })

  it('新版启动后会把待安装标记上报为 installed 并清理', async () => {
    vi.mocked(app.getVersion).mockReturnValue('1.7.0')
    mocks.fileStore.set(
      '/tmp/tabtin-user-data/pending-update-install.json',
      JSON.stringify({ version: '1.7.0', fromVersion: '1.6.0' }),
    )
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as any)

    new UpdateManager({
      checkOnStartup: false,
    })

    await vi.waitFor(() => {
      const progressCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/updates/progress'),
      )
      expect(progressCall).toBeTruthy()
      expect(JSON.parse((progressCall![1] as RequestInit).body as string)).toMatchObject({
        version: '1.7.0',
        status: 'installed',
        progress: 100,
      })
      expect(mocks.rmSync).toHaveBeenCalledWith(
        '/tmp/tabtin-user-data/pending-update-install.json',
        { force: true },
      )
    })
  })

  it('打包产物里的 channel 元数据会覆盖环境变量，避免 beta 包回落到 stable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tabtin-update-channel-'))
    const originalEnv = {
      TABTIN_UPDATE_CHANNEL: process.env.TABTIN_UPDATE_CHANNEL,
      UPDATE_CHANNEL: process.env.UPDATE_CHANNEL,
    }

    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        tabtinDesktop: {
          updateChannel: 'beta',
        },
      }))
      vi.mocked(app.getAppPath).mockReturnValue(tempDir)
      process.env.TABTIN_UPDATE_CHANNEL = 'stable'
      process.env.UPDATE_CHANNEL = 'stable'

      const fetchMock = vi.mocked(fetch)
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            has_update: false,
          },
        }),
      } as any)

      const manager = new UpdateManager({
        checkOnStartup: false,
      })

      await manager.checkForUpdates(false, 'manual')

      expect(manager.getState().channel).toBe('beta')
      expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
        channel: 'beta',
      })
      expect(mocks.setFeedURL).toHaveBeenNthCalledWith(1, {
        provider: 'generic',
        url: 'https://cdn.example.com/releases/',
        channel: 'beta',
      })
    } finally {
      if (originalEnv.TABTIN_UPDATE_CHANNEL === undefined) {
        delete process.env.TABTIN_UPDATE_CHANNEL
      } else {
        process.env.TABTIN_UPDATE_CHANNEL = originalEnv.TABTIN_UPDATE_CHANNEL
      }
      if (originalEnv.UPDATE_CHANNEL === undefined) {
        delete process.env.UPDATE_CHANNEL
      } else {
        process.env.UPDATE_CHANNEL = originalEnv.UPDATE_CHANNEL
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
