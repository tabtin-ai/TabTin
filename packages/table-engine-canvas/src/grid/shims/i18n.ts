/**
 * grid stub（补齐宿主未提供的 SDK 类型）：i18n，供 ErrorIndicator 引用。
 * Host apps (Electron) should call setCanvasGridLocale when language changes.
 */

export type CanvasGridLocale = 'zh-CN' | 'en-US'

const MESSAGES: Record<CanvasGridLocale, Record<string, string>> = {
  'zh-CN': {
    'aiError.title': '错误',
    'aiError.retry': '重试',
    'aiError.dismiss': '关闭',
  },
  'en-US': {
    'aiError.title': 'Error',
    'aiError.retry': 'Retry',
    'aiError.dismiss': 'Dismiss',
  },
}

let currentLocale: CanvasGridLocale = 'zh-CN'

export function setCanvasGridLocale(locale: CanvasGridLocale): void {
  currentLocale = locale
}

export function getCanvasGridLocale(): CanvasGridLocale {
  return currentLocale
}

export function useTranslation() {
  return {
    t: (key: string) => {
      return MESSAGES[currentLocale]?.[key] ?? MESSAGES['en-US'][key] ?? key
    },
  }
}
