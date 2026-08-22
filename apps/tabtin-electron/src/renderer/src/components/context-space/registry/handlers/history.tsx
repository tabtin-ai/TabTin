import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Clock } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import i18n from '@/i18n'

const BrowsingHistoryPage = React.lazy(
  () => import('@components/crawl/BrowsingHistoryPage').then(m => ({ default: m.BrowsingHistoryPage }))
)

export const historyHandler: ContextTypeHandler = {
  type: 'tinhistory',
  persistOnly: true,
  renderMode: 'pane',
  displayLabel: 'History',
  displayEmoji: '🕐',

  getTabLabel: () => i18n.t('history.title', { ns: 'crawl', defaultValue: '浏览历史' }),

  getTabIcon: () => <TabTypeEmoji appIdOrType="history" />,

  resolveTabItem: (_id, ctx) => ({
    type: 'tinhistory',
    id: 'history',
    tabKey: ctx.tabKey,
    title: i18n.t('history.title', { ns: 'crawl', defaultValue: '浏览历史' }),
  }),

  renderPane: (_item, ctx) => (
    <React.Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <span className="text-body text-muted-foreground">
            {i18n.t('label.loading', { ns: 'context' })}
          </span>
        </div>
      }
    >
      <div
        className="h-full w-full overflow-hidden"
        onPointerDownCapture={() => ctx?.onPaneInteraction?.()}
        onFocusCapture={() => ctx?.onPaneInteraction?.()}
      >
        <BrowsingHistoryPage spaceId={ctx?.spaceId ?? undefined} tabScopeKey={ctx?.tabScopeKey ?? null} />
      </div>
    </React.Suspense>
  ),
}
