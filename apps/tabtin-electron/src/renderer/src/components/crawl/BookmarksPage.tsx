/**
 * BookmarksPage - 书签管理页面
 *
 * 提供书签列表展示、搜索过滤、点击打开、删除等功能。
 */

import React, { useMemo, useState, useCallback } from 'react'
import { Star, Search, Globe, Trash2, ExternalLink } from 'lucide-react'
import { useBookmarkStore, type BookmarkItem } from '@stores/useBookmarkStore'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@components/ui'
import { openWebTabInSpace } from '@/services/openWebTabInSpace'
import { BrowserTabIcon } from '@components/context-space/registry/handlers/browser'
import { ContextPageHeader } from '@components/context-space/ContextPageHeader'

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86_400_000

  if (ts >= today) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (ts >= yesterday) {
    return `昨天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const BookmarkItemRow: React.FC<{
  item: BookmarkItem
  onOpen: (url: string) => void
  onDelete: (id: string) => void
}> = React.memo(({ item, onOpen, onDelete }) => {
  const { t } = useTranslation('crawl')
  const date = useMemo(() => formatDate(item.createdAt), [item.createdAt])

  return (
    <div className="group flex items-center gap-3 px-4 py-2.5 hover:bg-muted/60 rounded-lg transition-colors cursor-pointer min-w-0">
      <button
        type="button"
        className="flex flex-1 items-center gap-3 min-w-0 text-left"
        onClick={() => onOpen(item.url)}
      >
        <div className="flex-shrink-0">
          <BrowserTabIcon favicon={item.favicon} url={item.url} className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="block truncate text-body text-foreground">
            {item.title || item.url}
          </span>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground/60" title={item.url}>
              {item.url}
            </span>
            <span className="text-muted-foreground/30 text-caption">·</span>
            <span className="flex-shrink-0 text-caption text-muted-foreground/60">
              {date}
            </span>
          </div>
        </div>
      </button>
      <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => { e.stopPropagation(); onOpen(item.url) }}
          title={t('bookmarks.openAction', '打开')}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
          onClick={(e) => { e.stopPropagation(); onDelete(item.id) }}
          title={t('bookmarks.deleteAction', '删除')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
})
BookmarkItemRow.displayName = 'BookmarkItemRow'

export const BookmarksPage: React.FC<{ spaceId?: string; tabScopeKey?: string | null }> = ({
  spaceId: propSpaceId,
  tabScopeKey,
}) => {
  const { t } = useTranslation('crawl')
  const items = useBookmarkStore(s => s.items)
  const removeBookmark = useBookmarkStore(s => s.removeBookmark)
  const clearAll = useBookmarkStore(s => s.clearAll)
  const [searchQuery, setSearchQuery] = useState('')

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items
    const q = searchQuery.trim().toLowerCase()
    return items.filter(
      item =>
        item.title.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q),
    )
  }, [items, searchQuery])

  const handleOpenUrl = useCallback(async (url: string) => {
    const spaceId = propSpaceId
    if (!spaceId) {
      window.open(url, '_blank')
      return
    }

    const opened = await openWebTabInSpace(spaceId, url, { tabScopeKey })
    if (!opened.ok) {
      window.open(url, '_blank')
    }
  }, [propSpaceId, tabScopeKey])

  const handleDelete = useCallback((id: string) => {
    removeBookmark(id)
  }, [removeBookmark])

  const isEmpty = filteredItems.length === 0

  return (
    <div className="w-full h-full flex flex-col bg-background overflow-hidden">
      <ContextPageHeader
        className="flex-shrink-0 px-6 pt-6 pb-4"
        icon={<Star className="h-7 w-7" />}
        title={t('bookmarks.title', '书签')}
        description={
          items.length > 0
            ? t('bookmarks.totalCount', { count: items.length, defaultValue: `${items.length} 个书签` })
            : t('bookmarks.noBookmarks', '暂无书签')
        }
        actions={items.length > 0 ? (
          <button
            type="button"
            className="rounded-interactive px-3 py-1.5 text-body text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
            onClick={clearAll}
          >
            {t('bookmarks.clearAll', '清除全部')}
          </button>
        ) : null}
        footer={items.length > 3 ? (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('bookmarks.searchPlaceholder', '搜索书签...')}
              className="w-full rounded-interactive border border-border/30 bg-foreground/[0.025] py-2 pl-9 pr-4 text-body outline-none placeholder:text-muted-foreground/40 transition-colors focus:border-primary/60 focus:ring-1 focus:ring-inset focus:ring-ring dark:bg-foreground/[0.04]"
            />
          </div>
        ) : null}
      />

      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 pb-6">
          <div className="p-4 bg-muted/30 rounded-full mb-4">
            <Globe className="w-8 h-8 text-muted-foreground/30" />
          </div>
          <p className="text-body text-muted-foreground">
            {searchQuery
              ? t('bookmarks.noResults', '没有找到匹配的书签')
              : t('bookmarks.empty', '暂无书签')
            }
          </p>
          <p className="text-body text-muted-foreground/60 mt-1">
            {t('bookmarks.emptyHint', '点击地址栏的星标收藏网页')}
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1 px-4 pb-6">
          {filteredItems.map((item) => (
            <BookmarkItemRow
              key={item.id}
              item={item}
              onOpen={handleOpenUrl}
              onDelete={handleDelete}
            />
          ))}
        </ScrollArea>
      )}
    </div>
  )
}
