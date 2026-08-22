/**
 * table-core 共享翻译资源
 *
 * 包含 record-store 等核心模块使用的所有 i18n key（record: namespace）。
 * 消费端（Electron / Web）应将此数据作为 base，再用本地 record.json 覆盖。
 */

import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import enUS from './locales/en-US.json'
import jaJP from './locales/ja-JP.json'
import koKR from './locales/ko-KR.json'
import deDE from './locales/de-DE.json'
import frFR from './locales/fr-FR.json'
import esES from './locales/es-ES.json'
export { deepMergeLocaleObjects, type LocaleDictionary } from './merge'

export const recordSharedLocales = {
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
  zhCN as recordSharedZhCN,
  zhTW as recordSharedZhTW,
  enUS as recordSharedEnUS,
  jaJP as recordSharedJaJP,
  koKR as recordSharedKoKR,
  deDE as recordSharedDeDE,
  frFR as recordSharedFrFR,
  esES as recordSharedEsES,
}

export type RecordSharedLocale = typeof zhCN
