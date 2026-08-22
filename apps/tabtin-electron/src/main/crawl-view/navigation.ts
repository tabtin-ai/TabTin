/**
 * 导航控制模块
 *
 * 提供 goBack / goForward / reload / stop / getNavigationState 等功能。
 * 通过 initNavigation() 注入运行时依赖，避免与主模块产生循环引用。
 *
 * : 模块内部已容器无关化 — 只依赖 WebContents，不再引用 WebContentsView。
 */

import type { WebContents } from 'electron'
import { emitCrawlViewNavigationState } from '../crawl-view-events'
import { getViewFactory } from '../view-factory'
import { getEffectiveNavigationState } from './navigation-state'
import type { NavigationState } from './types'
import { isAliveWebContents } from './utils'
import { createLogger } from './logger'

const log = createLogger('CrawlViewNavigation')

type NavigationDeps = {
  getActiveWebContents: () => WebContents | null
  getCurrentTabId: () => string | null
  warnMissingViewId: (action: string) => boolean
}

let _deps: NavigationDeps = {
  getActiveWebContents: () => null,
  getCurrentTabId: () => null,
  warnMissingViewId: () => false,
}

export function initNavigation(deps: NavigationDeps): void {
  _deps = deps
}

function resolveWebContents(tabId?: string): WebContents | null {
  return tabId ? (getViewFactory().getWebContents(tabId) || null) : _deps.getActiveWebContents()
}

function resolveTabId(tabId?: string): string | undefined {
  return tabId || _deps.getCurrentTabId() || undefined
}

export function goBack(tabId?: string): boolean {
  if (!tabId && _deps.warnMissingViewId('goBack')) return false
  const wc = resolveWebContents(tabId)
  if (!wc) return false

  if (getEffectiveNavigationState(wc).canGoBack) {
    wc.navigationHistory.goBack()
    emitCrawlViewNavigationState(resolveTabId(tabId))
    return true
  }
  return false
}

export function goForward(tabId?: string): boolean {
  if (!tabId && _deps.warnMissingViewId('goForward')) return false
  const wc = resolveWebContents(tabId)
  if (!wc) return false

  if (getEffectiveNavigationState(wc).canGoForward) {
    wc.navigationHistory.goForward()
    emitCrawlViewNavigationState(resolveTabId(tabId))
    return true
  }
  return false
}

export function reload(ignoreCache = false, tabId?: string): boolean {
  if (!tabId && _deps.warnMissingViewId('reload')) return false
  const wc = resolveWebContents(tabId)
  if (!wc) return false

  if (ignoreCache) {
    wc.reloadIgnoringCache()
  } else {
    wc.reload()
  }
  emitCrawlViewNavigationState(resolveTabId(tabId))
  return true
}

export function stop(tabId?: string): boolean {
  if (!tabId && _deps.warnMissingViewId('stop')) return false
  const wc = resolveWebContents(tabId)
  if (!wc) return false

  wc.stop()
  emitCrawlViewNavigationState(resolveTabId(tabId))
  return true
}

export function getNavigationState(tabId?: string, options?: { includeHistory?: boolean }): NavigationState {
  const empty: NavigationState = { canGoBack: false, canGoForward: false, isLoading: false, url: '', title: '' }
  if (!tabId && _deps.warnMissingViewId('getNavigationState')) return empty
  const wc = resolveWebContents(tabId)
  if (!isAliveWebContents(wc)) return empty

  const navigation = getEffectiveNavigationState(wc)
  const state: NavigationState = {
    canGoBack: navigation.canGoBack,
    canGoForward: navigation.canGoForward,
    isLoading: wc.isLoading(),
    url: wc.getURL(),
    title: wc.getTitle(),
  }

  if (options?.includeHistory) {
    try {
      const entries = wc.navigationHistory.getAllEntries()
      state.history = entries.map((e: any) => ({ url: e.url, title: e.title || '' }))
      state.activeIndex = wc.navigationHistory.getActiveIndex()
    } catch (e) {
      log.debug('getAllEntries failed:', e)
    }
  }

  return state
}
