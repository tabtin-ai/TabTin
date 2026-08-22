import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

/**
 * ：跟随系统时，若 matchMedia 仍报浅色（themeSource 残留 / Windows 不可靠），
 * 必须以 setAppearance 回包的 shouldUseDarkColors 校正 DOM。
 */
describe('useUIStore theme follow system', () => {
  const originalTabtin = window.tabtin
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    Object.defineProperty(window, 'tabtin', {
      value: originalTabtin,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'matchMedia', {
      value: originalMatchMedia,
      writable: true,
      configurable: true,
    })
  })

  it('setAppearance 回包 shouldUseDarkColors=true 时校正为深色（即便 matchMedia 为浅色）', async () => {
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockReturnValue({
        matches: false,
        media: '(prefers-color-scheme: dark)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }),
      writable: true,
      configurable: true,
    })

    let resolveAppearance: (value: {
      success: boolean
      appearance: 'system'
      themeSource: 'system'
      shouldUseDarkColors: boolean
      shouldUseDarkColorsForSystemIntegratedUI: boolean
    }) => void = () => {}
    const setAppearance = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveAppearance = resolve
      }),
    )
    const onNativeThemeUpdated = vi.fn(() => () => {})

    Object.defineProperty(window, 'tabtin', {
      value: {
        setAppearance,
        onNativeThemeUpdated,
        zoom: {
          setZoomFactor: vi.fn(),
          getZoomFactor: () => 0.9,
        },
      },
      writable: true,
      configurable: true,
    })

    const { useUIStore } = await import('../useUIStore')
    // 模块加载时 initializeTheme 会先调一次 setAppearance；清掉以便测显式 setTheme
    setAppearance.mockClear()
    useUIStore.setState({ theme: 'light', resolvedTheme: 'light' })
    document.documentElement.classList.remove('dark')

    useUIStore.getState().setTheme('system')
    expect(useUIStore.getState().resolvedTheme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(setAppearance).toHaveBeenCalledWith('system')

    resolveAppearance({
      success: true,
      appearance: 'system',
      themeSource: 'system',
      shouldUseDarkColors: true,
      shouldUseDarkColorsForSystemIntegratedUI: true,
    })

    await vi.waitFor(() => {
      expect(useUIStore.getState().resolvedTheme).toBe('dark')
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('nativeTheme 推送应在 theme=system 时更新 resolvedTheme', async () => {
    let nativeListener:
      | ((payload: {
          appearance: 'system'
          themeSource: 'system'
          shouldUseDarkColors: boolean
          shouldUseDarkColorsForSystemIntegratedUI: boolean | null
        }) => void)
      | null = null

    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockReturnValue({
        matches: false,
        media: '(prefers-color-scheme: dark)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }),
      writable: true,
      configurable: true,
    })

    Object.defineProperty(window, 'tabtin', {
      value: {
        setAppearance: vi.fn().mockResolvedValue({
          success: true,
          appearance: 'system',
          themeSource: 'system',
          shouldUseDarkColors: false,
          shouldUseDarkColorsForSystemIntegratedUI: false,
        }),
        onNativeThemeUpdated: (cb: typeof nativeListener) => {
          nativeListener = cb
          return () => {
            nativeListener = null
          }
        },
        zoom: {
          setZoomFactor: vi.fn(),
          getZoomFactor: () => 0.9,
        },
      },
      writable: true,
      configurable: true,
    })

    const { useUIStore } = await import('../useUIStore')
    useUIStore.setState({ theme: 'system', resolvedTheme: 'light' })
    document.documentElement.classList.remove('dark')

    expect(nativeListener).toBeTypeOf('function')
    nativeListener?.({
      appearance: 'system',
      themeSource: 'system',
      shouldUseDarkColors: true,
      shouldUseDarkColorsForSystemIntegratedUI: true,
    })

    expect(useUIStore.getState().resolvedTheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
