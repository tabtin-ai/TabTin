/**
 * i18next 按需加载后端 — 自动发现 locales/ 下的 JSON 文件。
 *
 * 非首屏关键 namespace 通过 Vite import.meta.glob 自动发现并按需加载。
 * 首屏关键 namespace（common, sidebar, organization, auth, context, space, design）
 * 仍在 index.ts 中静态导入。
 *
 * 新增 locale 文件只需放入 locales/{lang}/ 目录即可，无需修改本文件。
 */
import type { BackendModule, ReadCallback } from 'i18next'
import { tableSharedLocales } from '@tabtin/table-ui'
import {
  recordSharedLocales,
  deepMergeLocaleObjects,
} from '@tabtin/table-core'
import { SUPPORTED_LANGUAGES } from './language'

type NamespaceLoader = () => Promise<{ default: Record<string, unknown> }>

const FILENAME_TO_NS: Record<string, string> = {
  'user-agent': 'userAgent',
  'global-search': 'globalSearch',
}

const CRITICAL_NS = new Set([
  'common', 'auth', 'organization', 'sidebar', 'context', 'space', 'design', 'tabdoc',
])

function fileToNs(filename: string): string {
  const base = filename.replace('.json', '')
  return FILENAME_TO_NS[base] ?? base
}

function buildLoadersByLanguage(
  modules: Record<string, () => Promise<{ default: Record<string, unknown> }>>,
): Record<string, Record<string, NamespaceLoader>> {
  const loadersByLanguage: Record<string, Record<string, NamespaceLoader>> = {}
  for (const [path, loader] of Object.entries(modules)) {
    const match = path.match(/\/locales\/([^/]+)\/([^/]+\.json)$/)
    if (!match) continue
    const language = match[1]
    const filename = path.split('/').pop() ?? ''
    const ns = fileToNs(filename)
    if (CRITICAL_NS.has(ns)) continue
    loadersByLanguage[language] ??= {}
    loadersByLanguage[language][ns] = loader
  }
  return loadersByLanguage
}

const localeGlobs = (import.meta as any).glob([
  './locales/*/*.json',
  '!./locales/*/common.json',
  '!./locales/*/auth.json',
  '!./locales/*/organization.json',
  '!./locales/*/sidebar.json',
  '!./locales/*/context.json',
  '!./locales/*/space.json',
  '!./locales/*/design.json',
]) as Record<string, () => Promise<{ default: Record<string, unknown> }>>

const loadersByLanguage = buildLoadersByLanguage(localeGlobs)

/** 从 locales/ 目录自动推导的全部 namespace 列表（含首屏关键 ns） */
export const allNamespaces: string[] = (() => {
  const ns = new Set<string>(CRITICAL_NS)
  for (const path of Object.keys(localeGlobs)) {
    const filename = path.split('/').pop()
    if (filename) {
      ns.add(fileToNs(filename))
    }
  }
  return Array.from(ns)
})()

const sharedResources: Record<string, Record<string, Record<string, unknown>>> = Object.fromEntries(
  SUPPORTED_LANGUAGES.map(language => [language, {
    table: tableSharedLocales[language],
    record: recordSharedLocales[language],
  }]),
)

const lazyBackend: BackendModule = {
  type: 'backend',

  init() {
    // no-op
  },

  read(language: string, namespace: string, callback: ReadCallback) {
    const shared = sharedResources[language]?.[namespace]
    const loader = loadersByLanguage[language]?.[namespace]
    if (!loader) {
      callback(null, (shared ?? {}) as any)
      return
    }
    loader()
      .then(mod => {
        const local = (mod as any).default || mod
        callback(null, shared ? deepMergeLocaleObjects(shared, local) : local)
      })
      .catch(() => callback(null, (shared ?? {}) as any))
  },
}

export default lazyBackend
