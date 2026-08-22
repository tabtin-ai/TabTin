import { describe, expect, it } from 'vitest'

import {
  readAppearanceThemeSnapshot,
  resolvedThemeFromSnapshot,
} from './appearance-theme-snapshot'

describe('appearance-theme-snapshot', () => {
  it('跟随系统时以 shouldUseDarkColors 解析深色，即使 system UI 标志不同', () => {
    const snapshot = readAppearanceThemeSnapshot(
      {
        themeSource: 'system',
        shouldUseDarkColors: true,
        shouldUseDarkColorsForSystemIntegratedUI: true,
      },
      'system',
    )

    expect(snapshot).toEqual({
      appearance: 'system',
      themeSource: 'system',
      shouldUseDarkColors: true,
      shouldUseDarkColorsForSystemIntegratedUI: true,
    })
    expect(resolvedThemeFromSnapshot(snapshot)).toBe('dark')
  })

  it('记录 Windows「外壳深色 / 应用浅色」分轨，便于诊断假跟随失败', () => {
    const snapshot = readAppearanceThemeSnapshot(
      {
        themeSource: 'system',
        shouldUseDarkColors: false,
        shouldUseDarkColorsForSystemIntegratedUI: true,
      },
      'system',
    )

    expect(snapshot.shouldUseDarkColors).toBe(false)
    expect(snapshot.shouldUseDarkColorsForSystemIntegratedUI).toBe(true)
    expect(resolvedThemeFromSnapshot(snapshot)).toBe('light')
  })

  it('themeSource 被强制为 light 时快照仍如实反映', () => {
    const snapshot = readAppearanceThemeSnapshot(
      {
        themeSource: 'light',
        shouldUseDarkColors: false,
      },
      'light',
    )

    expect(snapshot.themeSource).toBe('light')
    expect(snapshot.shouldUseDarkColorsForSystemIntegratedUI).toBeNull()
    expect(resolvedThemeFromSnapshot(snapshot)).toBe('light')
  })
})
