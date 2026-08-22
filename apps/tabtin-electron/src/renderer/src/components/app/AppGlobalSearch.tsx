/**
 * AppGlobalSearch — 全局搜索宿主（主 renderer 只同步开关状态）
 *
 * UI 由透明子 BrowserWindow（overlay.html?role=modal）承载，盖在所有 crawl view 之上、
 * 半透明 mask 透出底层网页。主 renderer 仅把开关状态同步过去，并接收关闭回调。
 */
import { useEffect } from 'react'
import type { FtsSearchResultItem } from '@tabtin/app-shell'
import { useUIStore } from '@stores/useUIStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import {
  navigateSearchResult,
  type NavigateSearchResultPayload,
} from '@/services/searchResultNavigation'
import { readThemeSnapshot } from '@/utils/overlayThemeSync'

export function AppGlobalSearch() {
  const globalSearchOpen = useUIStore((state) => state.globalSearchOpen)
  const setGlobalSearchOpen = useUIStore((state) => state.setGlobalSearchOpen)
  const organizationId = useOrganizationStore((state) => state.selectedOrganization?.id ?? null)
  const activeSpaceId = useSpaceStore((state) => state.selectedSpace?.id ?? null)

  useEffect(() => {
    void window.tabtin?.overlay?.push({
      type: 'global-search',
      open: globalSearchOpen,
      organizationId,
      activeSpaceId,
      // scope key 必须在主 renderer 解析（子窗口 store 是空副本，见 payload 注释）。
      // 打开瞬间的快照即可——搜索是模态，打开期间前台 scope 不会变。
      tabScopeKey: activeSpaceId ? resolveForegroundTabScopeKey(activeSpaceId) : null,
    })
  }, [globalSearchOpen, organizationId, activeSpaceId])

  useEffect(() => {
    const unsubscribe = window.tabtin?.overlay?.onGlobalSearchClosed?.(() => {
      setGlobalSearchOpen(false)
    })
    return () => {
      unsubscribe?.()
    }
  }, [setGlobalSearchOpen])

  // 主题跟随：把主窗口 documentElement 的主题快照广播给 overlay 子窗口 / overlay view。
  useEffect(() => {
    const broadcast = () => {
      void window.tabtin?.overlay?.syncTheme?.(readThemeSnapshot())
    }
    broadcast()
    const observer = new MutationObserver(broadcast)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-color-scheme'],
    })
    return () => observer.disconnect()
  }, [])

  // 子窗口全局搜索点击结果 → 在主 renderer 执行真实导航（切 space / 开 tab / 进会话）。
  useEffect(() => {
    const unsubscribe = window.tabtin?.overlay?.onNavigateSearchResult?.((raw) => {
      const payload = raw as NavigateSearchResultPayload | undefined
      if (!payload?.item) return
      void navigateSearchResult(payload.item as FtsSearchResultItem, {
        committedQuery: payload.committedQuery,
      })
    })
    return () => {
      unsubscribe?.()
    }
  }, [])

  return null
}
