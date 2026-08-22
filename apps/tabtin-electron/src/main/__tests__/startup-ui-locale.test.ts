import { afterEach, describe, expect, it, vi } from 'vitest'

const { isPackagedRef, getLocaleMock } = vi.hoisted(() => ({
  isPackagedRef: { value: false },
  getLocaleMock: vi.fn(() => 'en-US'),
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return isPackagedRef.value
    },
    getLocale: getLocaleMock,
  },
}))

import { resolveStartupUiLocale } from '../startup-ui-locale'

describe('resolveStartupUiLocale', () => {
  afterEach(() => {
    isPackagedRef.value = false
    getLocaleMock.mockReset()
    getLocaleMock.mockReturnValue('en-US')
    delete process.env.VITE_DEV_LANGUAGE
  })

  it('未打包未设钉时跟随系统语言', () => {
    isPackagedRef.value = false
    getLocaleMock.mockReturnValue('en-CN')
    expect(resolveStartupUiLocale()).toBe('en-US')
  })

  it('未打包可用 VITE_DEV_LANGUAGE=en-US 覆盖', () => {
    isPackagedRef.value = false
    process.env.VITE_DEV_LANGUAGE = 'en-US'
    expect(resolveStartupUiLocale()).toBe('en-US')
  })

  it('未打包可用 VITE_DEV_LANGUAGE=zh-CN 覆盖', () => {
    isPackagedRef.value = false
    getLocaleMock.mockReturnValue('en-US')
    process.env.VITE_DEV_LANGUAGE = 'zh-CN'
    expect(resolveStartupUiLocale()).toBe('zh-CN')
  })

  it.each(['zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES'])('未打包可钉 %s', (language) => {
    isPackagedRef.value = false
    process.env.VITE_DEV_LANGUAGE = language
    expect(resolveStartupUiLocale()).toBe(language)
  })

  it('安装包跟系统语言', () => {
    isPackagedRef.value = true
    getLocaleMock.mockReturnValue('en-US')
    expect(resolveStartupUiLocale()).toBe('en-US')
    getLocaleMock.mockReturnValue('zh-CN')
    expect(resolveStartupUiLocale()).toBe('zh-CN')
    getLocaleMock.mockReturnValue('zh-Hant-HK')
    expect(resolveStartupUiLocale()).toBe('zh-TW')
    getLocaleMock.mockReturnValue('fr-CA')
    expect(resolveStartupUiLocale()).toBe('fr-FR')
  })
})
