import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { tableSharedZhCN, tableSharedEnUS } from '@tabtin/table-ui'
import {
  recordSharedZhCN,
  recordSharedEnUS,
  deepMergeLocaleObjects,
} from '@tabtin/table-core'

import zhCNCommon from './locales/zh-CN/common.json'
import zhCNAuth from './locales/zh-CN/auth.json'
import zhCNSidebar from './locales/zh-CN/sidebar.json'
import zhCNSpace from './locales/zh-CN/space.json'
import zhCNTable from './locales/zh-CN/table.json'
import zhCNView from './locales/zh-CN/view.json'
import zhCNField from './locales/zh-CN/field.json'
import enUSCommon from './locales/en-US/common.json'
import enUSAuth from './locales/en-US/auth.json'
import enUSSidebar from './locales/en-US/sidebar.json'
import enUSSpace from './locales/en-US/space.json'
import enUSTable from './locales/en-US/table.json'
import enUSView from './locales/en-US/view.json'
import enUSField from './locales/en-US/field.json'
import { tabdocLocaleZhCN, tabdocLocaleEnUS } from '@tabtin/tabdoc-ui'

const savedLang = localStorage.getItem('tabtin_language')
const browserLang = navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US'

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': {
      common: zhCNCommon,
      auth: zhCNAuth,
      sidebar: zhCNSidebar,
      space: zhCNSpace,
      table: deepMergeLocaleObjects(tableSharedZhCN, zhCNTable),
      view: zhCNView,
      field: zhCNField,
      record: recordSharedZhCN,
      tabdoc: tabdocLocaleZhCN,
    },
    'en-US': {
      common: enUSCommon,
      auth: enUSAuth,
      sidebar: enUSSidebar,
      space: enUSSpace,
      table: deepMergeLocaleObjects(tableSharedEnUS, enUSTable),
      view: enUSView,
      field: enUSField,
      record: recordSharedEnUS,
      tabdoc: tabdocLocaleEnUS,
    },
  },
  lng: savedLang || browserLang,
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  ns: ['common', 'auth', 'sidebar', 'space', 'table', 'view', 'field', 'record', 'tabdoc'],
  interpolation: {
    escapeValue: false,
  },
})

function syncDocumentMeta(lang: string) {
  document.documentElement.lang = lang
  document.title = i18n.t('appTitle', { ns: 'common', defaultValue: 'TabTin' })
}

syncDocumentMeta(i18n.language)
i18n.on('languageChanged', syncDocumentMeta)

export default i18n
