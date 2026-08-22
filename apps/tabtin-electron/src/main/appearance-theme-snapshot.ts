import type { MainWindowAppearance } from './types/runtime'

/**
 * 主进程外观快照：渲染层「跟随系统」应以 shouldUseDarkColors 为准
 *（Electron 官方 SSoT），而不是只信 renderer 的 prefers-color-scheme。
 */
export interface AppearanceThemeSnapshot {
  appearance: MainWindowAppearance
  themeSource: 'system' | 'light' | 'dark'
  shouldUseDarkColors: boolean
  /** Windows 上区分「系统外壳」与「应用」深色；其它平台与 shouldUseDarkColors 同值或不可用 */
  shouldUseDarkColorsForSystemIntegratedUI: boolean | null
}

export interface NativeThemeLike {
  themeSource: string
  shouldUseDarkColors: boolean
  shouldUseDarkColorsForSystemIntegratedUI?: boolean
}

export function readAppearanceThemeSnapshot(
  nativeTheme: NativeThemeLike,
  appearance: MainWindowAppearance,
): AppearanceThemeSnapshot {
  const themeSource =
    nativeTheme.themeSource === 'light' || nativeTheme.themeSource === 'dark'
      ? nativeTheme.themeSource
      : 'system'

  const systemUi =
    typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean'
      ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
      : null

  return {
    appearance,
    themeSource,
    shouldUseDarkColors: Boolean(nativeTheme.shouldUseDarkColors),
    shouldUseDarkColorsForSystemIntegratedUI: systemUi,
  }
}

export function resolvedThemeFromSnapshot(
  snapshot: Pick<AppearanceThemeSnapshot, 'shouldUseDarkColors'>,
): 'light' | 'dark' {
  return snapshot.shouldUseDarkColors ? 'dark' : 'light'
}
