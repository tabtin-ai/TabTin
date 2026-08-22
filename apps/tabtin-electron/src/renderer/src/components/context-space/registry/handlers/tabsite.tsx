import React, { Suspense } from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Globe2 } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import i18n from '@/i18n'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from '../homeSections/metaFieldUtils'

const loadTabSitePaneHost = () => import('@components/tabsite/TabSitePaneHost')
const LazyTabSitePaneHost = React.lazy(loadTabSitePaneHost)

export const tabsiteHandler: ContextTypeHandler = {
  type: 'tabsite',
  appId: 'tabsite',
  prefetch: loadTabSitePaneHost,
  persistOnly: true,
  appEntryMode: 'create',
  displayLabel: 'Sites',
  displayEmoji: '🌐',
  agent: {
    displayName: '站点',
    capability: '多页站点搭建（轻量静态网站 / 内嵌应用），支持模板和发布',
    aliases: ['site', '网站', 'website'],
  },
  backendAliases: ['site'],
  searchable: true,
  searchLabelKey: 'organization:search.sites',
  quickAction: {
    icon: <Globe2 className="h-3.5 w-3.5" />,
    labelKey: 'context:home.quickActions.newSite',
    shortLabelKey: 'context:home.quickActions.shortSite',
  },
  appMeta: { idField: 'current_site_id', titleField: 'current_site_title' },
  attachToChat: {
    refType: 'site',
    buildRef: (item) => {
      if (!item.id) return null
      return {
        resourceId: item.id,
        label: item.title || i18n.t('label.untitledSite', { ns: 'context' }),
      }
    },
  },

  onSelect: (item, ctx) => {
    useSpaceContextTabsStore.getState().openResourceTab(ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId), {
      type: 'tabsite',
      id: item.id,
      title: item.title,
      meta: item.meta,
    })
  },

  resolveTabItem: (id, ctx) => {
    const title = ctx.persistedItem?.title || i18n.t('label.untitledSite', { ns: 'context' })
    const spaceId = metaStr(ctx.persistedItem?.meta, 'spaceId') ?? ctx.spaceId
    return {
      type: 'tabsite',
      id,
      tabKey: ctx.tabKey,
      title,
      meta: { spaceId },
    }
  },

  getTabLabel: (item) => item.title || i18n.t('label.untitledSite', { ns: 'context' }),
  getTabIcon: () => <TabTypeEmoji appIdOrType="tabsite" />,
  getDragPayload: (item) => ({ type: 'tabsite', id: item.id, title: item.title }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),

  renderPane: (item, _ctx) => {
    const spaceId = metaStr(item.meta, 'spaceId')
    return (
      <Suspense
        fallback={<PaneLoadingSkeleton />}
      >
        <LazyTabSitePaneHost
          resourceId={item.id}
          spaceId={spaceId ?? null}
        />
      </Suspense>
    )
  },
}
