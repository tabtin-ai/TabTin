import zhCN from './zh-CN.json'
import zhTW from './zh-TW.json'
import enUS from './en-US.json'
import jaJP from './ja-JP.json'
import koKR from './ko-KR.json'
import deDE from './de-DE.json'
import frFR from './fr-FR.json'
import esES from './es-ES.json'

export const tabdocLocales = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'de-DE': deDE,
  'fr-FR': frFR,
  'es-ES': esES,
} as const

export {
  zhCN as tabdocLocaleZhCN,
  zhTW as tabdocLocaleZhTW,
  enUS as tabdocLocaleEnUS,
  jaJP as tabdocLocaleJaJP,
  koKR as tabdocLocaleKoKR,
  deDE as tabdocLocaleDeDE,
  frFR as tabdocLocaleFrFR,
  esES as tabdocLocaleEsES,
}

export type TabdocLocale = typeof zhCN
