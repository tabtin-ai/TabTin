import i18n, { type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import lazyBackend, { allNamespaces } from './lazy-backend'

import { tabdocLocales } from '@tabtin/tabdoc-ui'

import { setSmartsheetUiLocale } from '@tabtin/smartsheet-ui/i18n'
import { setCanvasGridLocale } from '@tabtin/table-engine-canvas/i18n'
import {
  DEFAULT_LANGUAGE,
  DEFAULT_LANGUAGE_PREFERENCE,
  SUPPORTED_LANGUAGES,
  type LanguagePreference,
  type SupportedLanguage,
  resolveDevLanguagePreference,
  resolvePreference,
  normalizeLanguage,
  parseStoredLanguagePreference,
} from './language'
import { PERSIST_KEYS } from '@/stores/persist-key-registry'

type LocaleModule = { default: Record<string, unknown> }

const criticalLocaleModules = import.meta.glob([
  './locales/*/common.json',
  './locales/*/auth.json',
  './locales/*/organization.json',
  './locales/*/sidebar.json',
  './locales/*/context.json',
  './locales/*/space.json',
  './locales/*/design.json',
], { eager: true }) as Record<string, LocaleModule>

const buildCriticalResources = (language: SupportedLanguage): Record<string, unknown> => {
  const resources: Record<string, unknown> = {}
  for (const [modulePath, module] of Object.entries(criticalLocaleModules)) {
    const match = modulePath.match(/\/locales\/([^/]+)\/([^/]+)\.json$/)
    if (!match || match[1] !== language) continue
    resources[match[2]] = module.default
  }
  resources.tabdoc = tabdocLocales[language]
  return resources
}

const STORAGE_KEY = PERSIST_KEYS.i18n

const loadStoredPreference = (): LanguagePreference => {
  const devPin = resolveDevLanguagePreference()
  if (devPin) return devPin
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE_PREFERENCE
  try {
    return parseStoredLanguagePreference(localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_LANGUAGE_PREFERENCE
  }
}

const applyDocumentLanguage = (language: string) => {
  if (typeof document === 'undefined') return
  const resolved = normalizeLanguage(language) ?? DEFAULT_LANGUAGE
  document.documentElement.lang = resolved
  document.documentElement.dir = 'ltr'
}

const applySmartsheetUiLocale = (language: string) => {
  const resolved = normalizeLanguage(language) ?? DEFAULT_LANGUAGE
  setSmartsheetUiLocale(resolved === 'zh-CN' || resolved === 'zh-TW' ? 'zh-CN' : 'en-US')
}

const applyCanvasGridLocale = (language: string) => {
  const resolved = normalizeLanguage(language) ?? DEFAULT_LANGUAGE
  setCanvasGridLocale(resolved === 'zh-CN' || resolved === 'zh-TW' ? 'zh-CN' : 'en-US')
}

const initialPreference = loadStoredPreference()
const initialLanguage = resolvePreference(initialPreference)

void i18n
  .use(lazyBackend)        // 🚀 按需加载非关键 namespace
  .use(initReactI18next)
  .init({
    resources: Object.fromEntries(
      SUPPORTED_LANGUAGES.map(language => [language, buildCriticalResources(language)]),
    ) as Resource,
    partialBundledLanguages: true,  // 告知 i18next：resources 只包含部分 namespace，其余走 backend
    lng: initialLanguage,
    fallbackLng: {
      'zh-TW': ['zh-CN'],
      'ja-JP': ['en-US'],
      'ko-KR': ['en-US'],
      'de-DE': ['en-US'],
      'fr-FR': ['en-US'],
      'es-ES': ['en-US'],
      default: [DEFAULT_LANGUAGE],
    },
    ns: allNamespaces,
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
  })

applyDocumentLanguage(i18n.language)
applySmartsheetUiLocale(i18n.language)
applyCanvasGridLocale(i18n.language)

const syncLocaleToMainProcess = (language: string) => {
  try {
    window.tabtin?.contextMenu?.setLocale?.(language)
  } catch { /* main process may not be ready */ }
}

i18n.on('languageChanged', (language) => {
  applyDocumentLanguage(language)
  applySmartsheetUiLocale(language)
  applyCanvasGridLocale(language)
  syncLocaleToMainProcess(language)
})

syncLocaleToMainProcess(i18n.language)

export const getCurrentLanguage = (): string => i18n.language || DEFAULT_LANGUAGE

export default i18n
