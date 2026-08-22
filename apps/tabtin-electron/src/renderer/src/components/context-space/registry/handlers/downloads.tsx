import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Download } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import i18n from '@/i18n'

const DownloadsPage = React.lazy(
  () => import('@components/crawl/DownloadsPage').then(m => ({ default: m.DownloadsPage }))
)

export const downloadsHandler: ContextTypeHandler = {
  type: 'tindownloads',
  persistOnly: true,
  renderMode: 'pane',
  displayLabel: 'Downloads',
  displayEmoji: '⬇️',

  getTabLabel: () => i18n.t('downloads.title', { ns: 'crawl', defaultValue: '下载管理' }),

  getTabIcon: () => <TabTypeEmoji appIdOrType="downloads" />,

  resolveTabItem: (_id, ctx) => ({
    type: 'tindownloads',
    id: 'downloads',
    tabKey: ctx.tabKey,
    title: i18n.t('downloads.title', { ns: 'crawl', defaultValue: '下载管理' }),
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
        <DownloadsPage />
      </div>
    </React.Suspense>
  ),
}
