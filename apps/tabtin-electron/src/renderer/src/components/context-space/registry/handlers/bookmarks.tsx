import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Star } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import i18n from '@/i18n'

const BookmarksPage = React.lazy(
  () => import('@components/crawl/BookmarksPage').then(m => ({ default: m.BookmarksPage }))
)

export const bookmarksHandler: ContextTypeHandler = {
  type: 'tinbookmarks',
  persistOnly: true,
  renderMode: 'pane',
  displayLabel: 'Bookmarks',
  displayEmoji: '⭐',

  getTabLabel: () => i18n.t('bookmarks.title', { ns: 'crawl', defaultValue: '书签' }),

  getTabIcon: () => <TabTypeEmoji appIdOrType="bookmarks" />,

  resolveTabItem: (_id, ctx) => ({
    type: 'tinbookmarks',
    id: 'bookmarks',
    tabKey: ctx.tabKey,
    title: i18n.t('bookmarks.title', { ns: 'crawl', defaultValue: '书签' }),
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
        <BookmarksPage spaceId={ctx?.spaceId ?? undefined} tabScopeKey={ctx?.tabScopeKey ?? null} />
      </div>
    </React.Suspense>
  ),
}
