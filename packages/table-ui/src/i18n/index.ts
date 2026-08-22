/**
 * table-ui 共享翻译资源
 *
 * 包含 table-ui 共享 controller 层使用的所有 i18n key（table: namespace）。
 * 消费端（Electron / Web）应将此数据作为 base，再用本地 table.json 覆盖。
 */

import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import enUS from './locales/en-US.json'
import jaJP from './locales/ja-JP.json'
import koKR from './locales/ko-KR.json'
import deDE from './locales/de-DE.json'
import frFR from './locales/fr-FR.json'
import esES from './locales/es-ES.json'

export const tableSharedLocales = {
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
  zhCN as tableSharedZhCN,
  zhTW as tableSharedZhTW,
  enUS as tableSharedEnUS,
  jaJP as tableSharedJaJP,
  koKR as tableSharedKoKR,
  deDE as tableSharedDeDE,
  frFR as tableSharedFrFR,
  esES as tableSharedEsES,
}

export type TableSharedLocale = typeof zhCN
