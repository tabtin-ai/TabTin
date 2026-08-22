import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeTheme: {
    themeSource: 'system' as 'system' | 'light' | 'dark',
    shouldUseDarkColors: false,
    shouldUseDarkColorsForSystemIntegratedUI: false,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  getAllWindows: vi.fn(() => [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>),
}))

vi.mock('electron', () => ({
  nativeTheme: mocks.nativeTheme,
  BrowserWindow: {
    getAllWindows: mocks.getAllWindows,
  },
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { createWindowAppearanceRuntime, NATIVE_THEME_UPDATED_CHANNEL } from './window-appearance-runtime'

describe('window-appearance-runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.nativeTheme.themeSource = 'system'
    mocks.nativeTheme.shouldUseDarkColors = false
    mocks.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false
    mocks.getAllWindows.mockReturnValue([])
  })

  it('会统一应用 appearance 到受管窗口和 crawl views，并返回 shouldUseDarkColors 快照', () => {
    const applyBackgroundForAppearance = vi.fn()
    const applyAppearanceToAllCrawlViews = vi.fn()
    const appearanceSync = {
      getCurrentAppearance: vi.fn(() => 'system' as const),
      setCurrentAppearance: vi.fn(),
      applyBackgroundForAppearance,
      applyAppearanceToAllCrawlViews,
    }
    const runtime = createWindowAppearanceRuntime({
      appearanceSync,
    })
    const window = {
      isDestroyed: () => false,
      once: vi.fn(),
    }

    runtime.registerWindowForAppearanceSync(window as any)
    mocks.nativeTheme.shouldUseDarkColors = true
    const snapshot = runtime.applyAppearance('dark')

    expect(appearanceSync.applyBackgroundForAppearance).toHaveBeenNthCalledWith(1, window, 'system')
    expect(appearanceSync.setCurrentAppearance).toHaveBeenCalledWith('dark')
    expect(mocks.nativeTheme.themeSource).toBe('dark')
    expect(applyBackgroundForAppearance).toHaveBeenLastCalledWith(window, 'dark')
    expect(applyAppearanceToAllCrawlViews).toHaveBeenCalledWith('dark')
    expect(snapshot).toMatchObject({
      appearance: 'dark',
      themeSource: 'dark',
      shouldUseDarkColors: true,
    })
  })

  it('system 主题变化时同步受管窗口并向渲染层广播 shouldUseDarkColors', () => {
    const applyBackgroundForAppearance = vi.fn()
    const applyAppearanceToAllCrawlViews = vi.fn()
    const send = vi.fn()
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } },
    ])
    mocks.nativeTheme.shouldUseDarkColors = true
    mocks.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true

    const appearanceSync = {
      getCurrentAppearance: vi.fn(() => 'system' as const),
      setCurrentAppearance: vi.fn(),
      applyBackgroundForAppearance,
      applyAppearanceToAllCrawlViews,
    }
    const window = {
      isDestroyed: () => false,
      once: vi.fn(),
    }

    createWindowAppearanceRuntime({
      appearanceSync,
    }).registerWindowForAppearanceSync(window as any)

    const updatedHandler = mocks.nativeTheme.on.mock.calls[0]?.[1]
    updatedHandler()

    expect(applyBackgroundForAppearance).toHaveBeenLastCalledWith(window, 'system')
    expect(applyAppearanceToAllCrawlViews).toHaveBeenLastCalledWith('system')
    expect(send).toHaveBeenCalledWith(
      NATIVE_THEME_UPDATED_CHANNEL,
      expect.objectContaining({
        appearance: 'system',
        shouldUseDarkColors: true,
        shouldUseDarkColorsForSystemIntegratedUI: true,
      }),
    )
  })

  it('重复注册同一个窗口时不会重复挂 closed 清理监听', () => {
    const appearanceSync = {
      getCurrentAppearance: vi.fn(() => 'light' as const),
      setCurrentAppearance: vi.fn(),
      applyBackgroundForAppearance: vi.fn(),
      applyAppearanceToAllCrawlViews: vi.fn(),
    }
    const window = {
      isDestroyed: () => false,
      once: vi.fn(),
    }

    const runtime = createWindowAppearanceRuntime({
      appearanceSync,
    })

    runtime.registerWindowForAppearanceSync(window as any)
    runtime.registerWindowForAppearanceSync(window as any)

    expect(window.once).toHaveBeenCalledTimes(1)
    expect(appearanceSync.applyBackgroundForAppearance).toHaveBeenCalledTimes(2)
  })
})
