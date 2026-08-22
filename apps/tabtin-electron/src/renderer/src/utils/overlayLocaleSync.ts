/**
 * overlay / 独立窗口是独立 renderer，i18n 实例不会自动跟随主窗口。
 * 主 renderer 广播当前语言，这里镜像到本窗口的 i18next。
 */
import i18n from '@/i18n'
import { DEFAULT_LANGUAGE, normalizeLanguage } from '@/i18n/language'

export function applyOverlayLocale(language: unknown): void {
  if (typeof language !== 'string' || !language.trim()) return
  const resolved = normalizeLanguage(language) ?? DEFAULT_LANGUAGE
  if (i18n.language !== resolved) {
    void i18n.changeLanguage(resolved)
  }
}
