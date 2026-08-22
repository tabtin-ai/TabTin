import { app } from 'electron'

export type StartupUiLocale =
  | 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP'
  | 'ko-KR' | 'de-DE' | 'fr-FR' | 'es-ES'

export function normalizeStartupUiLocale(raw?: string | null): StartupUiLocale {
  const value = (raw || '').toLowerCase()
  if (
    value === 'zh-tw' || value.startsWith('zh-hant')
    || value.startsWith('zh-hk') || value.startsWith('zh-mo')
  ) return 'zh-TW'
  if (value.startsWith('zh')) return 'zh-CN'
  if (value.startsWith('ja')) return 'ja-JP'
  if (value.startsWith('ko')) return 'ko-KR'
  if (value.startsWith('de')) return 'de-DE'
  if (value.startsWith('fr')) return 'fr-FR'
  if (value.startsWith('es')) return 'es-ES'
  return 'en-US'
}

/**
 * 主进程启动期 UI 语言（托盘 / 右键菜单 / 终端 locale 等）。
 * 未打包时可用 `VITE_DEV_LANGUAGE` 显式钉任一受支持语言；未设置则跟系统。
 * 安装包跟系统语言。
 */
export function resolveStartupUiLocale(): StartupUiLocale {
  if (!app.isPackaged) {
    const override = process.env.VITE_DEV_LANGUAGE?.trim()
    if (override && /^(zh-CN|zh-TW|en-US|ja-JP|ko-KR|de-DE|fr-FR|es-ES)$/.test(override)) {
      return normalizeStartupUiLocale(override)
    }
  }
  return normalizeStartupUiLocale(app.getLocale())
}
