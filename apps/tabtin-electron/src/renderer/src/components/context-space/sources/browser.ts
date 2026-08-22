import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCrawlTabStore, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { contextRegistry } from '@components/context-space/registry/instance'
import type { BrowserContextSourceResult } from './types'
import i18n from '@/i18n'

/** 稳定的空数组，供 zustand selector 在「无嵌入 tab」时返回，避免每次 new Set/new [] 触发 useSyncExternalStore 无限更新 */
const EMPTY_EMBEDDED_APP_VIEW_IDS: string[] = []

type UseBrowserContextSourceOptions = {
  crawlspaceId: string | null
  /** 用于排除已挂载为嵌入式 Web App 标签的 crawl 视图，避免与 tabweb 重复 */
  spaceId?: string
  tabScopeKey?: string
}

export const useBrowserContextSource = ({
  crawlspaceId,
  spaceId,
  tabScopeKey,
}: UseBrowserContextSourceOptions): BrowserContextSourceResult => {
  const storageKey = tabScopeKey || spaceId
  const emptyViews = useMemo<CrawlspaceViewInfo[]>(() => [], [])
  const viewList = useCrawlTabStore(state => {
    if (!crawlspaceId) return emptyViews
    return state.crawlspaceContextCache[crawlspaceId]?.viewList || emptyViews
  })
  const activeViewId = useCrawlTabStore(state => {
    if (!crawlspaceId) return null
    return state.crawlspaceContextCache[crawlspaceId]?.activeViewId ?? null
  })

  const embeddedAppViewIds = useSpaceContextTabsStore(
    useShallow((state) => {
      if (!storageKey) return EMPTY_EMBEDDED_APP_VIEW_IDS
      const items = state.itemsBySpace[storageKey] ?? {}
      const ids: string[] = []
      for (const rec of Object.values(items)) {
        if (rec.meta?.embeddedAppId && typeof rec.id === 'string') ids.push(rec.id)
      }
      if (ids.length === 0) return EMPTY_EMBEDDED_APP_VIEW_IDS
      return ids.sort()
    }),
  )

  const items = useMemo(() => {
    return viewList
      .filter(view => !view.isClosing)
      .filter(view => !embeddedAppViewIds.includes(view.viewId))
      .map(view => ({
      type: 'tabweb',
      id: view.viewId,
      tabKey: contextRegistry.buildTabKey('tabweb', view.viewId),
      title: view.title || view.url || i18n.t('label.newTab', { ns: 'context' }),
      meta: {
        url: view.url,
        favicon: view.favicon,
        isPreview: view.isPreview,
        crawlspaceId: view.crawlspaceId || crawlspaceId
      }
      }))
  }, [crawlspaceId, embeddedAppViewIds, viewList])

  return {
    viewList,
    items,
    activeViewId,
  }
}
