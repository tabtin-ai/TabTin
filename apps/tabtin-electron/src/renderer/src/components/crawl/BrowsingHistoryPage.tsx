/**
 * BrowsingHistoryPage - 浏览历史页面
 *
 * 作为浏览器内的一个特殊标签页（tinhistory），提供：
 * - 按日期分组的浏览历史列表
 * - 搜索过滤（按标题或 URL）
 * - 点击打开历史页面
 * - 删除单条或清除全部
 */

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Clock, Search, Globe, Trash2, ExternalLink } from 'lucide-react'
import {
  useBrowsingHistoryStore,
  type BrowsingHistoryItem,
} from '@stores/useBrowsingHistoryStore'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useSafeVirtualizer } from '@hooks/useSafeVirtualizer'
import { openWebTabInSpace } from '@/services/openWebTabInSpace'
import { BrowserTabIcon } from '@components/context-space/registry/handlers/browser'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useScrollPositionPreserve } from '@hooks/useScrollPositionPreserve'
import { ContextPageHeader } from '@components/context-space/ContextPageHeader'

const ROW_HEIGHT = 56
const HEADER_HEIGHT = 28

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function groupHistoryByDate(
  items: BrowsingHistoryItem[],
  t: TFunction,
): { label: string; items: BrowsingHistoryItem[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86_400_000
  const thisWeekStart = today - now.getDay() * 86_400_000
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const buckets: Record<string, BrowsingHistoryItem[]> = {}

  for (const item of items) {
    let key: string
    if (item.visitedAt >= today) {
      key = '__today'
    } else if (item.visitedAt >= yesterday) {
      key = '__yesterday'
    } else if (item.visitedAt >= thisWeekStart) {
      key = '__thisWeek'
    } else if (item.visitedAt >= thisMonthStart) {
      key = '__thisMonth'
    } else {
      const d = new Date(item.visitedAt)
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    }
    if (!buckets[key]) buckets[key] = []
    buckets[key].push(item)
  }

  const labelMap: Record<string, string> = {
    '__today': String(t('history.today', '今天')),
    '__yesterday': String(t('history.yesterday', '昨天')),
    '__thisWeek': String(t('history.thisWeek', '本周')),
    '__thisMonth': String(t('history.thisMonth', '本月')),
  }

  const sortOrder = ['__today', '__yesterday', '__thisWeek', '__thisMonth']
  const result: { label: string; items: BrowsingHistoryItem[] }[] = []

  for (const key of sortOrder) {
    if (buckets[key]) {
      result.push({ label: labelMap[key], items: buckets[key] })
    }
  }

  const dateKeys = Object.keys(buckets)
    .filter(k => !k.startsWith('__'))
    .sort((a, b) => b.localeCompare(a))
  for (const key of dateKeys) {
    result.push({ label: key, items: buckets[key] })
  }

  return result
}

const HistoryItemRow: React.FC<{
  item: BrowsingHistoryItem
  onOpen: (url: string) => void
  onDelete: (id: string) => void
}> = React.memo(({ item, onOpen, onDelete }) => {
  const { t } = useTranslation('crawl')
  const time = useMemo(() => formatTime(item.visitedAt), [item.visitedAt])

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
              {time}
            </span>
          </div>
        </div>
      </button>
      <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => { e.stopPropagation(); onOpen(item.url) }}
          title={t('history.openAction', '打开')}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
          onClick={(e) => { e.stopPropagation(); onDelete(item.id) }}
          title={t('history.deleteAction', '删除')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
})
HistoryItemRow.displayName = 'HistoryItemRow'

export const BrowsingHistoryPage: React.FC<{ spaceId?: string; tabScopeKey?: string | null }> = ({
  spaceId: propSpaceId,
  tabScopeKey,
}) => {
  const { t } = useTranslation('crawl')
  const items = useBrowsingHistoryStore(s => s.items)
  const initialize = useBrowsingHistoryStore(s => s.initialize)
  const deleteItem = useBrowsingHistoryStore(s => s.deleteItem)
  const clearAll = useBrowsingHistoryStore(s => s.clearAll)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    initialize()
  }, [initialize])

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items
    const q = searchQuery.trim().toLowerCase()
    return items.filter(
      item =>
        item.title.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q),
    )
  }, [items, searchQuery])

  const groups = useMemo(
    () => groupHistoryByDate(filteredItems, t),
    [filteredItems, t],
  )

  type VirtualRow =
    | { kind: 'header'; label: string }
    | { kind: 'item'; item: BrowsingHistoryItem }

  const flatRows = useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = []
    for (const group of groups) {
      rows.push({ kind: 'header', label: group.label })
      for (const item of group.items) {
        rows.push({ kind: 'item', item })
      }
    }
    return rows
  }, [groups])

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // react-virtual 3.13+ 要求 getItemKey 稳定，inline 函数会
  // 让测量缓存反复失效触发死循环。用 ref + useCallback 永久稳定。
  const flatRowsRef = useRef(flatRows)
  flatRowsRef.current = flatRows

  const getScrollElement = useCallback(() => scrollContainerRef.current, [])
  const estimateSize = useCallback(
    (index: number) => flatRowsRef.current[index]?.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT,
    [],
  )
  const getItemKey = useCallback((index: number) => {
    const row = flatRowsRef.current[index]
    if (!row) return index
    if (row.kind === 'header') return `h-${row.label}`
    return `i-${row.item.id}`
  }, [])

  // hot-spaces 治理：见 `hooks/useScrollPositionPreserve.ts` 文件头注释。
  // 统一走 virtualizer 路径——之前的 `useVirtual` 阈值分叉会让短列表落到
  // 普通 `<ScrollArea>` 分支，scrollContainerRef 不绑定 → scroll preserve
  // 完全失效。绝大多数浏览历史 ≤ 80 行，删阈值后 hook 才能在主流场景生效。
  // 已知限制：列表 newest-first 排序（__today bucket 在前），hot-spaces 切走
  // 又有新历史记录时按 px 恢复的位置会指向错位项——hook 头 §已知限制 #1。
  const { isForeground } = useSpaceActivity()
  const virtualizer = useSafeVirtualizer({
    count: flatRows.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: 8,
    enabled: isForeground,
  })

  useScrollPositionPreserve({
    scrollElementRef: scrollContainerRef,
    totalSize: virtualizer.getTotalSize(),
  })

  const handleOpenUrl = useCallback(async (url: string) => {
    const spaceId = propSpaceId
    if (!spaceId) {
      window.open(url, '_blank')
      return
    }

    const opened = await openWebTabInSpace(spaceId, url, { tabScopeKey })
    if (opened.ok) {
      useBrowsingHistoryStore.getState().recordVisit(url)
      return
    }

    window.open(url, '_blank')
  }, [propSpaceId, tabScopeKey])

  const handleDelete = useCallback((id: string) => {
    deleteItem(id)
  }, [deleteItem])

  const isEmpty = flatRows.length === 0

  const renderRow = useCallback((row: VirtualRow) => {
    if (row.kind === 'header') {
      return (
        <div className="px-4 py-1.5 text-body font-medium text-muted-foreground/80 uppercase tracking-wider">
          {row.label}
        </div>
      )
    }
    return <HistoryItemRow item={row.item} onOpen={handleOpenUrl} onDelete={handleDelete} />
  }, [handleOpenUrl, handleDelete])

  return (
    <div className="w-full h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <ContextPageHeader
        className="flex-shrink-0 px-6 pt-6 pb-4"
        icon={<Clock className="h-7 w-7" />}
        title={t('history.title', '浏览历史')}
        description={
          items.length > 0
            ? t('history.totalCount', { count: items.length, defaultValue: `${items.length} 条记录` })
            : t('history.noRecords', '暂无浏览记录')
        }
        actions={items.length > 0 ? (
          <button
            type="button"
            className="rounded-interactive px-3 py-1.5 text-body text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
            onClick={clearAll}
          >
            {t('history.clearAll', '清除全部')}
          </button>
        ) : null}
        footer={items.length > 3 ? (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('history.searchPlaceholder', '搜索标题或 URL...')}
              className="w-full rounded-interactive border border-border/30 bg-foreground/[0.025] py-2 pl-9 pr-4 text-body outline-none placeholder:text-muted-foreground/40 transition-colors focus:border-primary/60 focus:ring-1 focus:ring-inset focus:ring-ring dark:bg-foreground/[0.04]"
            />
          </div>
        ) : null}
      />

      {/* History list */}
      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 pb-6">
          <div className="p-4 bg-muted/30 rounded-full mb-4">
            <Globe className="w-8 h-8 text-muted-foreground/30" />
          </div>
          <p className="text-body text-muted-foreground">
            {searchQuery
              ? t('history.noResults', '没有找到匹配的记录')
              : t('history.empty', '暂无浏览记录')
            }
          </p>
          <p className="text-body text-muted-foreground/60 mt-1">
            {t('history.emptyHint', '浏览的网页将会记录在这里')}
          </p>
        </div>
      ) : (
        <div ref={scrollContainerRef} className="flex-1 overflow-auto px-4 pb-6">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = flatRows[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                >
                  {renderRow(row)}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
