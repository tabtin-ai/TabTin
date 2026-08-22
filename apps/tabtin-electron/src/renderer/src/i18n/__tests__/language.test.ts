import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LANGUAGE,
  DEFAULT_LANGUAGE_PREFERENCE,
  LANGUAGE_NATIVE_LABELS,
  SUPPORTED_LANGUAGES,
  getSystemLanguage,
  normalizeLanguage,
  parseStoredLanguagePreference,
  resolveDevLanguagePreference,
  resolvePreference,
} from '../language'

describe('resolveDevLanguagePreference', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('非 DEV 不钉语言', () => {
    vi.stubEnv('DEV', false)
    expect(resolveDevLanguagePreference()).toBeNull()
  })

  it('DEV 未设 VITE_DEV_LANGUAGE 时不钉', () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', '')
    expect(resolveDevLanguagePreference()).toBeNull()
  })

  it('DEV 可用 VITE_DEV_LANGUAGE 覆盖', () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', 'en-US')
    expect(resolveDevLanguagePreference()).toBe('en-US')
  })

  it.each(['zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES'] as const)('DEV 可钉 %s', (language) => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', language)
    expect(resolveDevLanguagePreference()).toBe(language)
  })
})

describe('getSystemLanguage / resolvePreference（无 DEV 钉时跟偏好）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('DEV 无钉时跟随系统语言', () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', '')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'en-CN' },
    })
    expect(getSystemLanguage()).toBe('en-US')
    expect(resolvePreference('system')).toBe('en-US')
  })

  it('DEV 无钉时 resolvePreference 尊重全部受支持语言', () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', '')
    for (const language of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES'] as const) {
      expect(resolvePreference(language)).toBe(language)
    }
  })

  it.each([
    ['zh-Hant-HK', 'zh-TW'],
    ['zh-TW', 'zh-TW'],
    ['ko', 'ko-KR'],
    ['de-AT', 'de-DE'],
    ['fr-CA', 'fr-FR'],
    ['es-MX', 'es-ES'],
  ] as const)('系统区域 %s 解析为 %s', (systemLocale, expected) => {
    expect(normalizeLanguage(systemLocale)).toBe(expected)
  })

  it('系统日语区域解析为 ja-JP', () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', '')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'ja' },
    })
    expect(getSystemLanguage()).toBe('ja-JP')
    expect(resolvePreference('system')).toBe('ja-JP')
  })

  it('非 DEV 仍跟系统语言', () => {
    vi.stubEnv('DEV', false)
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'en-US' },
    })
    expect(getSystemLanguage()).toBe('en-US')
    expect(resolvePreference('system')).toBe('en-US')
  })

  it('DEV 显式钉 zh-CN 时仍覆盖偏好', () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', 'zh-CN')
    expect(resolvePreference('en-US')).toBe(DEFAULT_LANGUAGE)
  })

  it('未持久化偏好时默认跟随系统', () => {
    expect(DEFAULT_LANGUAGE_PREFERENCE).toBe('system')
    expect(parseStoredLanguagePreference(null)).toBe('system')
    expect(parseStoredLanguagePreference('')).toBe('system')
    expect(parseStoredLanguagePreference('{')).toBe('system')
  })

  it('读取已保存的语言偏好', () => {
    expect(parseStoredLanguagePreference(JSON.stringify({ state: { preference: 'en-US' } }))).toBe('en-US')
    expect(parseStoredLanguagePreference(JSON.stringify({ state: { preference: 'system' } }))).toBe('system')
  })

  it('从 navigator.languages 回退解析系统语言', () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_LANGUAGE', '')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'und', languages: ['ko-KR', 'en-US'] },
    })
    expect(getSystemLanguage()).toBe('ko-KR')
  })
})

describe('LANGUAGE_NATIVE_LABELS', () => {
  it('语种名称固定为各语言自己的写法', () => {
    expect(LANGUAGE_NATIVE_LABELS['zh-CN']).toBe('简体中文')
    expect(LANGUAGE_NATIVE_LABELS['zh-TW']).toBe('繁體中文')
    expect(LANGUAGE_NATIVE_LABELS['en-US']).toBe('English')
    expect(LANGUAGE_NATIVE_LABELS['ja-JP']).toBe('日本語')
    expect(LANGUAGE_NATIVE_LABELS['ko-KR']).toBe('한국어')
    expect(LANGUAGE_NATIVE_LABELS['de-DE']).toBe('Deutsch')
    expect(LANGUAGE_NATIVE_LABELS['fr-FR']).toBe('Français')
    expect(LANGUAGE_NATIVE_LABELS['es-ES']).toBe('Español')
    expect(SUPPORTED_LANGUAGES.every((language) => LANGUAGE_NATIVE_LABELS[language])).toBe(true)
  })
})
