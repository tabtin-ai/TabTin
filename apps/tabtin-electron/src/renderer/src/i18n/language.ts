export type SupportedLanguage =
  | 'zh-CN'
  | 'zh-TW'
  | 'en-US'
  | 'ja-JP'
  | 'ko-KR'
  | 'de-DE'
  | 'fr-FR'
  | 'es-ES'
export type LanguagePreference = SupportedLanguage | 'system'

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'ja-JP',
  'ko-KR',
  'de-DE',
  'fr-FR',
  'es-ES',
]
export const DEFAULT_LANGUAGE: SupportedLanguage = 'zh-CN'
export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = 'system'

/** 语种名称用各语言自己的写法，不随界面语言翻译。 */
export const LANGUAGE_NATIVE_LABELS: Record<SupportedLanguage, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'en-US': 'English',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'de-DE': 'Deutsch',
  'fr-FR': 'Français',
  'es-ES': 'Español',
}

const ZH_PREFIX = 'zh'

/**
 * 本地 `pnpm dev` 可选语言钉：仅当显式设置 `VITE_DEV_LANGUAGE` 时生效。
 * 未设置时跟随设置页偏好 / 系统语言，不再无条件钉中文。
 * 例：`.env.local` 写 `VITE_DEV_LANGUAGE=en-US` 或 `ja-JP` 并重启 Electron。
 * 生产安装包不受影响。
 */
export const resolveDevLanguagePreference = (): LanguagePreference | null => {
  if (!import.meta.env.DEV) return null
  const override = import.meta.env.VITE_DEV_LANGUAGE?.trim()
  if (override === 'system') return override
  if (SUPPORTED_LANGUAGES.includes(override as SupportedLanguage)) return override as SupportedLanguage
  return null
}

export const normalizeLanguage = (language?: string | null): SupportedLanguage | null => {
  if (!language) return null
  const lower = language.toLowerCase()
  if (lower === 'system') return null
  if (
    lower === 'zh-tw'
    || lower.startsWith('zh-hant')
    || lower.startsWith('zh-hk')
    || lower.startsWith('zh-mo')
  ) return 'zh-TW'
  if (lower.startsWith(ZH_PREFIX)) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  if (lower.startsWith('ja')) return 'ja-JP'
  if (lower.startsWith('ko')) return 'ko-KR'
  if (lower.startsWith('de')) return 'de-DE'
  if (lower.startsWith('fr')) return 'fr-FR'
  if (lower.startsWith('es')) return 'es-ES'
  return null
}

export const getSystemLanguage = (): SupportedLanguage => {
  const devPin = resolveDevLanguagePreference()
  if (devPin && devPin !== 'system') {
    return normalizeLanguage(devPin) ?? DEFAULT_LANGUAGE
  }
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE
  const candidates = [navigator.language, ...(navigator.languages ?? [])]
  for (const candidate of candidates) {
    const normalized = normalizeLanguage(candidate)
    if (normalized) return normalized
  }
  return DEFAULT_LANGUAGE
}

export const parseStoredLanguagePreference = (raw: string | null | undefined): LanguagePreference => {
  if (!raw) return DEFAULT_LANGUAGE_PREFERENCE
  try {
    const parsed = JSON.parse(raw) as { state?: { preference?: LanguagePreference } }
    const preference = parsed?.state?.preference
    if (preference === 'system') return 'system'
    if (SUPPORTED_LANGUAGES.includes(preference as SupportedLanguage)) {
      return preference as LanguagePreference
    }
  } catch {
    /* ignore malformed persist payload */
  }
  return DEFAULT_LANGUAGE_PREFERENCE
}

export const resolvePreference = (preference: LanguagePreference): SupportedLanguage => {
  const devPin = resolveDevLanguagePreference()
  if (devPin && devPin !== 'system') {
    return normalizeLanguage(devPin) ?? DEFAULT_LANGUAGE
  }
  if (preference === 'system') {
    return getSystemLanguage()
  }
  return normalizeLanguage(preference) ?? DEFAULT_LANGUAGE
}

export const isSupportedLanguage = (language?: string | null): language is SupportedLanguage => {
  return normalizeLanguage(language) !== null
}
