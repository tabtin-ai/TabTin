import React from 'react'
import { CircleAlert, Globe, Loader2 } from 'lucide-react'
import { toast } from '@components/ui'
import type { ContextTypeHandler } from '../types'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useCrawlTabStore, type CrawlspaceConfig } from '@stores/useCrawlTabStore'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { useDiscardedViewStore } from '@hooks/useTabDiscardListener'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { electronCrawlspaceHost } from '@/crawlspace/host/electron-crawlspace-host'
import i18n from '@/i18n'
import { metaStr } from '../homeSections/metaFieldUtils'
import {
  activateBrowserView,
  cancelBrowserViewActivation,
  useBrowserViewActivationState,
} from '@/services/browserViewActivation'
import { seedManager } from '@stores/seed-manager'
import type { OpenIntentHints } from '@shared/open-intent'

/** crawlspace-core 默认标题若被原样写入 view.title，标签栏会显示键名 */
const CRAWLSPACE_RAW_TITLE_KEYS = new Set(['tabs.untitled', 'tabs.newTabTitle'])

function displayBrowserViewTitle(title: string | undefined, whenRawKey: string): string {
  const trimmed = (title ?? '').trim()
  if (!trimmed) return whenRawKey
  if (CRAWLSPACE_RAW_TITLE_KEYS.has(trimmed)) {
    return i18n.t('label.newTab', { ns: 'context' })
  }
  return trimmed
}

const loadBrowserPaneRenderer = () =>
  import('./renderers/BrowserPaneRenderer').then(m => ({ default: m.BrowserPaneRenderer }))
const BrowserPaneRenderer = React.lazy(loadBrowserPaneRenderer)

const restoringViewIds = new Set<string>()

function readOpenIntentHints(raw: unknown): OpenIntentHints | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const hints: OpenIntentHints = {}
  if (typeof value.filename === 'string' && value.filename.trim()) hints.filename = value.filename
  if (typeof value.mimeType === 'string' && value.mimeType.trim()) hints.mimeType = value.mimeType
  if (typeof value.assetId === 'string' && value.assetId.trim()) hints.assetId = value.assetId
  return Object.keys(hints).length > 0 ? hints : undefined
}

function readMetaOpenIntentHints(meta: Record<string, unknown> | undefined): OpenIntentHints | undefined {
  return readOpenIntentHints(meta?.openIntentHints)
}

function findSeedOpenIntentHints(crawlspaceId: string | undefined, viewId: string, url: string): OpenIntentHints | undefined {
  if (!crawlspaceId) return undefined
  const seed = seedManager.getSeeds(crawlspaceId).find(candidate => candidate.viewId === viewId)
  return seed?.url === url ? seed.openIntentHints : undefined
}

export const buildFaviconCandidates = (favicon?: string, url?: string): string[] => {
  const candidates = new Set<string>()
  const push = (value?: string) => {
    if (!value || typeof value !== 'string') return
    candidates.add(value)
    if (value.startsWith('http://')) {
      candidates.add(`https://${value.slice(7)}`)
    }
  }
  push(favicon)
  if (url) {
    try {
      const parsed = new URL(url)
      candidates.add(`${parsed.origin}/favicon.ico`)
      if (parsed.protocol === 'http:') {
        candidates.add(`https://${parsed.host}/favicon.ico`)
      }
    } catch {
      // ignore invalid url
    }
  }
  return Array.from(candidates)
}

export const BrowserTabIcon: React.FC<{
  favicon?: string
  url?: string
  className?: string
  crawlspaceId?: string
  viewId?: string
}> = ({ favicon, url, className = 'h-4 w-4', crawlspaceId, viewId }) => {
  const activationState = useBrowserViewActivationState(crawlspaceId, viewId)
  const candidates = React.useMemo(() => buildFaviconCandidates(favicon, url), [favicon, url])
  const [index, setIndex] = React.useState(0)

  React.useEffect(() => {
    setIndex(0)
  }, [favicon, url])

  if (activationState.phase === 'restoring') {
    return <Loader2 className={`${className} shrink-0 animate-spin text-primary`} />
  }
  if (activationState.phase === 'failed') {
    return <CircleAlert className={`${className} shrink-0 text-destructive`} />
  }

  const current = candidates[index]
  if (!current) {
    return <Globe className={`${className} shrink-0`} />
  }

  return (
    <img
      src={current}
      alt=""
      className={`${className} shrink-0 object-contain`}
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => {
        setIndex((prev) => (prev + 1 < candidates.length ? prev + 1 : candidates.length))
      }}
    />
  )
}

export const browserHandler: ContextTypeHandler = {
  type: 'tabweb',
  appId: 'tabweb',
  prefetch: loadBrowserPaneRenderer,
  renderMode: 'persistent',
  appEntryMode: 'resources',
  hasBrowserActions: true,
  displayLabel: 'Browser',
  displayEmoji: '🌐',
  agent: {
    displayName: '浏览器',
    capability: '内嵌网页浏览与采集（支持登录态、当前页复用、列表落表），适合打开网页、观察页面、抓取资料。',
    aliases: ['browser', '网页', 'web'],
  },
  backendAliases: ['browser'],
  quickAction: {
    icon: <Globe className="h-3.5 w-3.5" />,
    labelKey: 'context:home.quickActions.newWebTab',
    shortLabelKey: 'context:home.quickActions.shortWebTab',
  },
  appMeta: {
    idField: '',
    resolve: (item) => {
      const store = useCrawlTabStore.getState()
      for (const cache of Object.values(store.crawlspaceContextCache)) {
        const view = cache.viewList.find(v => v.viewId === item.id)
        if (view) {
          return {
            current_browser_url: view.url || null,
            current_browser_title: view.title || null,
          }
        }
      }
      return null
    },
    // resolve 用 getState() 读的是 crawl view 快照，本身不建立订阅。宿主
    // useChatPanelContext 靠 metaDeps 决定订阅什么再触发 activeAppMeta 重算——
    // resolve 读 view.url/title；两者在导航过程中可能分批更新，必须都订阅。
    // 漏声明会退化成非响应式快照，同标签页导航（viewId/tabKey 不变）时
    // 注入残留旧页面 URL/标题，或标题稍晚到达时继续显示 URL。
    metaDeps: {
      useCrawlViewUrl: true,
      useCrawlViewTitle: true,
    },
  },
  attachToChat: {
    refType: 'webpage',
    buildRef: (item) => {
      // 优先从实时 viewList 拿 url（最新），fallback 到 item.meta.url（discarded 状态）
      let url = ''
      let title = ''
      let favicon: string | undefined
      const store = useCrawlTabStore.getState()
      for (const cache of Object.values(store.crawlspaceContextCache)) {
        const view = cache.viewList.find(v => v.viewId === item.id)
        if (view) {
          url = view.url || ''
          title = displayBrowserViewTitle(view.title, '')
          favicon = view.favicon
          break
        }
      }
      if (!url) {
        url = (item.meta?.url as string) || (item.meta?.discardedUrl as string) || ''
      }
      if (!title) {
        title = displayBrowserViewTitle(item.title, '') || url
      }
      if (!url || url === 'about:blank') return null
      return {
        resourceId: url,
        label: title || url,
        meta: favicon ? { pageTitle: title, favicon } : { pageTitle: title },
      }
    },
  },
  onSelect: (item, ctx) => {
    if (!ctx.crawlspaceId) {
      toast({
        title: i18n.t('error.organizationNotReady.title', { ns: 'context' }),
        description: i18n.t('error.organizationNotReady.switch', { ns: 'context' }),
        variant: 'destructive',
      })
      return
    }

    const tabScopeKey = ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId)
    if (item.meta?.discarded) {
      if (restoringViewIds.has(item.id)) return
      restoringViewIds.add(item.id)
      const openIntentHints = readMetaOpenIntentHints(item.meta)

      const store = useSpaceContextTabsStore.getState()
      store.upsertItems(tabScopeKey, [{
        ...item,
        meta: { ...item.meta, restoring: true },
      }])

      void (async () => {
        const url = (item.meta?.discardedUrl as string) || (item.meta?.url as string) || 'about:blank'
        try {
          const ipcAdapter = createElectronIpcAdapter(ctx.crawlspaceId!, ctx.spaceId)
          const newViewId = `view-${ctx.crawlspaceId}-${Date.now()}`
          const created = await ipcAdapter.createView(
            newViewId,
            url,
            undefined,
            item.title,
            undefined,
            openIntentHints ? { openIntentHints } : undefined,
          )
          if (!created) {
            store.upsertItems(tabScopeKey, [{
              ...item,
              meta: { ...item.meta, restoring: undefined },
            }])
            toast({
              title: i18n.t('error.restoreTabFailed', { ns: 'context', defaultValue: '恢复标签失败' }),
              variant: 'destructive',
            })
            return
          }
          seedManager.ensureSeed(ctx.crawlspaceId!, {
            viewId: newViewId,
            url,
            title: item.title,
            openIntentHints,
          })
          useDiscardedViewStore.getState().clearDiscarded(item.id)
          const newTabKey = `tabweb:${newViewId}`
          useSpaceContextTabsStore.getState().replaceTabKey(tabScopeKey, item.tabKey, newTabKey, newViewId)
          await activateBrowserView(ctx.crawlspaceId!, newViewId, {
            spaceId: ctx.spaceId,
            selection: { tabScopeKey, tabKey: newTabKey },
          })
        } catch (err) {
          console.error('[browser] 恢复 discarded view 失败:', err)
          store.upsertItems(tabScopeKey, [{
            ...item,
            meta: { ...item.meta, restoring: undefined },
          }])
          toast({
            title: i18n.t('error.restoreTabFailed', { ns: 'context', defaultValue: '恢复标签失败' }),
            variant: 'destructive',
          })
        } finally {
          restoringViewIds.delete(item.id)
        }
      })()
      return
    }

    void activateBrowserView(ctx.crawlspaceId, item.id, {
      spaceId: ctx.spaceId,
      selection: { tabScopeKey, tabKey: item.tabKey },
      fallbackView: {
        viewId: item.id,
        url: typeof item.meta?.url === 'string' ? item.meta.url : 'about:blank',
        title: item.title || i18n.t('label.newTab', { ns: 'context' }),
        favicon: typeof item.meta?.favicon === 'string' ? item.meta.favicon : undefined,
        openIntentHints: readMetaOpenIntentHints(item.meta),
      },
    })
  },
  /**
   * 关闭浏览器标签：
   * 1. 若是 discarded（休眠）状态，清理 discardedStore + 推入 closedTabsStore 供 ⌘⇧T 还原
   * 2. 否则从 crawlspace viewList 读取当前 url 推入 closedTabsStore
   * 3. 调用 ctx.closeBrowserView 销毁 WebContentsView（crawlspace context client + IPC）
   *
   * 契约：**不改 activeKey / tabOrder**，统一由 useCloseHandlers 计算 fallback。
   */
  onClose: async (item, ctx) => {
    if (!ctx.crawlspaceId) {
      toast({
        title: i18n.t('error.organizationNotReady.title', { ns: 'context' }),
        description: i18n.t('error.organizationNotReady.close', { ns: 'context' }),
        variant: 'destructive',
      })
      return
    }
    cancelBrowserViewActivation(ctx.crawlspaceId, item.id)

    if (item.meta?.discarded) {
      const url = (item.meta.discardedUrl as string) || (item.meta.url as string)
      const openIntentHints = readMetaOpenIntentHints(item.meta)
      if (url && url !== 'about:blank') {
        useClosedTabsStore.getState().push({
          type: 'tabweb',
          id: item.id,
          tabKey: item.tabKey,
          url,
          title: item.title || url,
          favicon: typeof item.meta.favicon === 'string' ? item.meta.favicon : undefined,
          spaceId: ctx.spaceId,
          ...(openIntentHints ? { meta: { openIntentHints } } : {}),
        })
      }
      useDiscardedViewStore.getState().clearDiscarded(item.id)
      return
    }

    const store = useCrawlTabStore.getState()
    for (const cache of Object.values(store.crawlspaceContextCache)) {
      const view = cache.viewList.find(v => v.viewId === item.id)
      if (view && view.url && view.url !== 'about:blank') {
        const openIntentHints =
          view.openIntentHints ||
          findSeedOpenIntentHints(view.crawlspaceId || ctx.crawlspaceId, item.id, view.url) ||
          readMetaOpenIntentHints(item.meta)
        useClosedTabsStore.getState().push({
          type: 'tabweb',
          id: item.id,
          tabKey: item.tabKey,
          url: view.url,
          title: view.title || view.url,
          favicon: view.favicon,
          spaceId: ctx.spaceId,
          ...(openIntentHints ? { meta: { openIntentHints } } : {}),
        })
        break
      }
    }
    await ctx.closeBrowserView?.(ctx.crawlspaceId, item.id)
  },
  onRefresh: (item) => {
    void electronCrawlspaceHost.view?.reload?.(item.id, false)
  },
  resolveTabItem: (id, ctx) => {
    const store = useCrawlTabStore.getState()
    let viewInfo: {
      title: string
      url: string
      favicon?: string
      isPreview?: boolean
      crawlspaceId?: string
      openIntentHints?: OpenIntentHints
    } | null = null
    for (const cache of Object.values(store.crawlspaceContextCache)) {
      const v = cache.viewList.find(v => v.viewId === id)
      if (v) { viewInfo = v; break }
    }
    const persistedUrl = metaStr(ctx.persistedItem?.meta, 'url')
    const persistedFavicon = metaStr(ctx.persistedItem?.meta, 'favicon')
    const resolvedCrawlspaceId = viewInfo?.crawlspaceId || ctx.crawlspaceId
    // 读取 Session 颜色，用于侧边栏标签页颜色条
    const sessionColor = resolvedCrawlspaceId
      ? store.getCrawlspaceConfig(resolvedCrawlspaceId)?.sessionColor
      : undefined
    const persistedDiscarded = ctx.persistedItem?.meta?.discarded
    const metaOpenIntentHints =
      viewInfo?.openIntentHints || readMetaOpenIntentHints(ctx.persistedItem?.meta)
    const newTabFallback = i18n.t('label.newTab', { ns: 'context' })
    const rawPersistedTitle = typeof ctx.persistedItem?.title === 'string' ? ctx.persistedItem.title : ''
    const resolvedTitle =
      displayBrowserViewTitle(viewInfo?.title, '')
      || viewInfo?.url
      || displayBrowserViewTitle(rawPersistedTitle, '')
      || persistedUrl
      || newTabFallback
    return {
      type: 'tabweb',
      id,
      tabKey: ctx.tabKey,
      title: resolvedTitle,
      meta: {
        url: viewInfo?.url || persistedUrl,
        favicon: viewInfo?.favicon || persistedFavicon,
        isPreview: viewInfo?.isPreview,
        crawlspaceId: resolvedCrawlspaceId,
        ...(metaOpenIntentHints ? { openIntentHints: metaOpenIntentHints } : {}),
        ...(sessionColor ? { themeColor: sessionColor } : {}),
        ...(persistedDiscarded ? {
          discarded: true,
          discardedUrl: ctx.persistedItem?.meta?.discardedUrl,
        } : {}),
      },
    }
  },
  getSourceItems: (ctx, existingKeys) => {
    if (!ctx.crawlspaceId) return []
    const store = useCrawlTabStore.getState()
    const viewList = store.crawlspaceContextCache[ctx.crawlspaceId]?.viewList || []
    // 读取当前 crawlspace 的 Session 颜色
    const sessionColor = store.getCrawlspaceConfig(ctx.crawlspaceId)?.sessionColor
    const newTabTitle = i18n.t('label.newTab', { ns: 'context' })
    const items: import('../types').ContextItem[] = []
    for (const view of viewList) {
      if (view.isClosing) continue
      const tabKey = `tabweb:${view.viewId}` as import('../types').ContextTabKey
      if (existingKeys.has(tabKey)) continue
      const viewCrawlspaceId = view.crawlspaceId || ctx.crawlspaceId
      // 若 view 属于不同 crawlspace，取其自身的 sessionColor
      const viewSessionColor = viewCrawlspaceId !== ctx.crawlspaceId
        ? store.getCrawlspaceConfig(viewCrawlspaceId)?.sessionColor
        : sessionColor
      items.push({
        type: 'tabweb',
        id: view.viewId,
        tabKey,
        title: displayBrowserViewTitle(view.title, '') || view.url || newTabTitle,
        meta: {
          url: view.url,
          favicon: view.favicon,
          isPreview: view.isPreview,
          crawlspaceId: viewCrawlspaceId,
          ...(view.openIntentHints ? { openIntentHints: view.openIntentHints } : {}),
          ...(viewSessionColor ? { themeColor: viewSessionColor } : {}),
        },
      })
    }
    return items
  },
  getTabLabel: item => {
    const url = typeof item.meta?.url === 'string' ? item.meta.url : ''
    const fallback = i18n.t('label.newTab', { ns: 'context' })
    return displayBrowserViewTitle(item.title, '') || url || fallback
  },
  getTabIcon: item => (
    <BrowserTabIcon
      favicon={typeof item.meta?.favicon === 'string' ? item.meta.favicon : undefined}
      url={typeof item.meta?.url === 'string' ? item.meta.url : undefined}
      crawlspaceId={typeof item.meta?.crawlspaceId === 'string' ? item.meta.crawlspaceId : undefined}
      viewId={item.id}
    />
  ),
  getDragPayload: item => ({
    type: 'tabweb',
    id: item.id,
    title: item.title,
    url: typeof item.meta?.url === 'string' ? item.meta.url : undefined
  }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),
  renderPane: (item, ctx) => {
    const crawlspaceConfig = ctx.crawlspaceConfig as CrawlspaceConfig | undefined
    if (!ctx.crawlspaceId || !crawlspaceConfig) {
      return (
        <div
          className="h-full w-full flex items-center justify-center text-body text-muted-foreground"
          onPointerDownCapture={() => ctx.onPaneInteraction?.()}
          onFocusCapture={() => ctx.onPaneInteraction?.()}
        >
          {i18n.t('error.organizationNotReady.load', { ns: 'context' })}
        </div>
      )
    }
    const viewUrl = ctx.viewInfo?.url || (typeof item.meta?.url === 'string' ? item.meta.url : '')
    if (!viewUrl) {
      return (
        <div
          className="h-full w-full flex items-center justify-center text-body text-muted-foreground"
          onPointerDownCapture={() => ctx.onPaneInteraction?.()}
          onFocusCapture={() => ctx.onPaneInteraction?.()}
        >
          {i18n.t('error.missingPageUrl', { ns: 'context' })}
        </div>
      )
    }
    return (
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            {i18n.t('label.loading', { ns: 'context' })}
          </div>
        }
      >
        <BrowserPaneRenderer
          crawlspaceId={ctx.crawlspaceId}
          viewId={item.id}
          isGroupActive={ctx.isGroupActive}
          isPaneActive={ctx.isPaneActive}
          onPaneInteraction={ctx.onPaneInteraction}
        />
      </React.Suspense>
    )
  }
}
