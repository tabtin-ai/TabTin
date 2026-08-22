/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'

export type SearchEngineId = 'google' | 'bing' | 'duckduckgo' | 'baidu'

export interface SearchEngineOption {
  id: SearchEngineId
  label: string
  urlTemplate: string
}

export const SEARCH_ENGINES: readonly SearchEngineOption[] = [
  { id: 'google', label: 'Google', urlTemplate: 'https://www.google.com/search?q=%s' },
  { id: 'bing', label: 'Bing', urlTemplate: 'https://www.bing.com/search?q=%s' },
  { id: 'duckduckgo', label: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' },
  { id: 'baidu', label: '百度', urlTemplate: 'https://www.baidu.com/s?wd=%s' },
] as const

export function getSearchEngine(id: SearchEngineId): SearchEngineOption {
  return SEARCH_ENGINES.find(e => e.id === id) ?? SEARCH_ENGINES[0]
}

export function buildSearchUrl(engineId: SearchEngineId, query: string): string {
  const engine = getSearchEngine(engineId)
  return engine.urlTemplate.replace('%s', encodeURIComponent(query))
}

function syncTemplateToMain(id: SearchEngineId): void {
  const engine = getSearchEngine(id)
  window.tabtin?.browserPrefs?.syncSearchEngine?.(engine.urlTemplate)
}

export type AccessPolicyId = 'auto' | 'enhanced' | 'off'

export const ACCESS_POLICIES: readonly { id: AccessPolicyId; labelKey: string }[] = [
  { id: 'auto', labelKey: 'home.browserHome.accessPolicyAuto' },
  { id: 'enhanced', labelKey: 'home.browserHome.accessPolicyEnhanced' },
  { id: 'off', labelKey: 'home.browserHome.accessPolicyOff' },
] as const

export interface ProxyEntry {
  server: string
  username?: string
  password?: string
  enabled: boolean
}

interface BrowserPrefsState {
  searchEngine: SearchEngineId
  homepageUrl: string
  accessPolicy: AccessPolicyId
  proxyList: ProxyEntry[]

  setSearchEngine: (id: SearchEngineId) => void
  setHomepageUrl: (url: string) => void
  setAccessPolicy: (id: AccessPolicyId) => void
  setProxyList: (list: ProxyEntry[]) => void
  addProxy: (entry: Omit<ProxyEntry, 'enabled'>) => void
  removeProxy: (index: number) => void
  toggleProxy: (index: number) => void
}

export const useBrowserPrefsStore = create<BrowserPrefsState>()(
  persist(
    (set) => ({
      searchEngine: 'google',
      homepageUrl: '',
      accessPolicy: 'auto',
      proxyList: [],

      setSearchEngine: (id) => {
        set({ searchEngine: id })
        syncTemplateToMain(id)
      },
      setHomepageUrl: (url) => set({ homepageUrl: url.trim() }),
      setAccessPolicy: (id) => {
        set({ accessPolicy: id })
        window.tabtin?.browserPrefs?.syncAccessPolicy?.(id)
      },
      setProxyList: (list) => set({ proxyList: list }),
      addProxy: (entry) => set((state) => ({
        proxyList: [...state.proxyList, { ...entry, enabled: true }],
      })),
      removeProxy: (index) => set((state) => ({
        proxyList: state.proxyList.filter((_, i) => i !== index),
      })),
      toggleProxy: (index) => set((state) => ({
        proxyList: state.proxyList.map((p, i) => i === index ? { ...p, enabled: !p.enabled } : p),
      })),
    }),
    withPersistSafety({
      name: PERSIST_KEYS.browser,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-browser-prefs'])),
      partialize: (state) => ({
        searchEngine: state.searchEngine,
        homepageUrl: state.homepageUrl,
        accessPolicy: state.accessPolicy,
        proxyList: state.proxyList,
      }),
      version: 1,
      migrate: (persisted: unknown, _version: number) => persisted,
      onRehydrateStorage: () => (state) => {
        if (state?.searchEngine) {
          syncTemplateToMain(state.searchEngine)
        }
        if (state?.accessPolicy) {
          window.tabtin?.browserPrefs?.syncAccessPolicy?.(state.accessPolicy)
        }
      },
    }),
  ),
)
