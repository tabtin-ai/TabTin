/**
 * 通用 embeddedWeb handler 工厂。
 *
 * 为 uiRuntime=embeddedWeb 的 marketplace app 生成标准 ContextTypeHandler，
 * 免去为每个新 embeddedWeb app 手写专属 handler 文件。
 *
 * 字段命名约定：context field 名为 `current_{appId}_url`，
 * 与 app.json 中 agentIntegration.contextFields 的 isResourceId 字段保持一致。
 */

import React from 'react'
import type { ContextTypeHandler, ContextItemType } from './types'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { crawlspaceContextClient } from '@/crawlspace/electron/crawlspace-context-client'
import i18n from '@/i18n'
import { metaStr } from './homeSections/metaFieldUtils'

const EmbeddedWebAppPane = React.lazy(() =>
  import('./handlers/renderers/EmbeddedWebAppPane').then(m => ({ default: m.EmbeddedWebAppPane })),
)

export interface EmbeddedWebAppSpec {
  id: string
  name: string
  context_type?: string | null
  embedded_web: { baseUrl: string; sessionMode?: string }
  context_url_field?: string
}

export function createGenericEmbeddedWebHandler(app: EmbeddedWebAppSpec): ContextTypeHandler {
  const appId = app.id
  const baseUrl = app.embedded_web.baseUrl
  const contextFieldName = app.context_url_field || `current_${appId}_url`

  return {
    type: appId as ContextItemType,
    appId,
    renderMode: 'persistent',
    appEntryMode: 'resources',
    marketplaceApp: true,
    embeddedWeb: { baseUrl, sessionMode: app.embedded_web.sessionMode },
    displayLabel: app.name,
    displayEmoji: '🌐',
    appMeta: {
      idField: '',
      resolve: (item) => {
        const { crawlspaceContextCache } = useCrawlTabStore.getState()
        for (const cache of Object.values(crawlspaceContextCache)) {
          const view = cache.viewList.find(v => v.viewId === item.id)
          if (view?.url) return { [contextFieldName]: view.url }
        }
        const url = typeof item.meta?.url === 'string' ? item.meta.url : null
        return { [contextFieldName]: url }
      },
      metaDeps: {
        tabMetaKeys: ['url'],
        useCrawlViewUrl: true,
      },
    },
    onSelect: (item, ctx) => {
      useSpaceContextTabsStore.getState().setActiveKey(ctx.tabScopeKey ?? ctx.spaceId, item.tabKey)
      const csId = metaStr(item.meta, 'crawlspaceId')
      if (csId) {
        void crawlspaceContextClient.setActiveView(csId, item.id)
      }
    },
    resolveTabItem: (id, ctx) => {
      const store = useCrawlTabStore.getState()
      let viewInfo: { title: string; url: string; favicon?: string; crawlspaceId?: string } | null = null
      for (const cache of Object.values(store.crawlspaceContextCache)) {
        const v = cache.viewList.find(vi => vi.viewId === id)
        if (v) { viewInfo = v; break }
      }
      const persistedUrl = metaStr(ctx.persistedItem?.meta, 'url')
      const persistedFavicon = metaStr(ctx.persistedItem?.meta, 'favicon')
      const resolvedCrawlspaceId = viewInfo?.crawlspaceId || metaStr(ctx.persistedItem?.meta, 'crawlspaceId')
      return {
        type: appId as ContextItemType,
        id,
        tabKey: ctx.tabKey,
        title: viewInfo?.title || app.name,
        meta: {
          url: viewInfo?.url || persistedUrl || baseUrl,
          favicon: viewInfo?.favicon ?? persistedFavicon,
          ...(resolvedCrawlspaceId ? { crawlspaceId: resolvedCrawlspaceId } : {}),
        },
      }
    },
    getTabLabel: (item) => item.title || app.name,
    getTabIcon: () => null,
    renderPane: (item, ctx) =>
      React.createElement(
        React.Suspense,
        {
          fallback: React.createElement(
            'div',
            { className: 'flex h-full items-center justify-center text-body text-muted-foreground' },
            i18n.t('label.loading', { ns: 'context' }),
          ),
        },
        React.createElement(EmbeddedWebAppPane, {
          appId,
          viewId: item.id,
          isGroupActive: ctx.isGroupActive,
          onPaneInteraction: ctx.onPaneInteraction,
        }),
      ),
  }
}
