/**
 * DownloadsPage - 下载管理页面
 *
 * 作为浏览器内的一个特殊标签页（tabtin://downloads），提供：
 * - 下载列表：按时间分组（今天、昨天、更早）
 * - 实时进度：进度条 + 速度 + 剩余时间
 * - 下载操作：暂停/恢复/取消/重试/打开/文件夹/删除
 * - 搜索过滤：按文件名搜索
 * - 批量操作：清除已完成
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  Download,
  Search,
  ArrowDown,
} from 'lucide-react'
import { useDownloadStore, type DownloadItem, type StreamDownloadItem } from '@stores/useDownloadStore'
import { useTranslation } from 'react-i18next'
import { useSafeVirtualizer } from '@hooks/useSafeVirtualizer'
import { groupByDate } from './utils/download-utils'
import { storeActions } from './DownloadRowShared'
import { DownloadItemRow } from './DownloadItemRow'
import { StreamDownloadItemRow } from './StreamDownloadItemRow'
import { DownloadContextMenu } from './DownloadContextMenu'
import { StreamContextMenu } from './StreamContextMenu'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useScrollPositionPreserve } from '@hooks/useScrollPositionPreserve'
import { ContextPageHeader } from '@components/context-space/ContextPageHeader'

const ROW_HEIGHT = 72
const HEADER_HEIGHT = 28

// ==================== 主页面组件 ====================

export const DownloadsPage: React.FC = () => {
  const { t } = useTranslation('crawl')
  const items = useDownloadStore(s => s.items)
  const streamItems = useDownloadStore(s => s.streamItems)
  const activeCount = useDownloadStore(s => s.activeCount)
  const initialize = useDownloadStore(s => s.initialize)
  const [searchQuery, setSearchQuery] = useState('')
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'download'; x: number; y: number; item: DownloadItem }
    | { kind: 'stream'; x: number; y: number; item: StreamDownloadItem }
    | null
  >(null)

  useEffect(() => {
    initialize()
  }, [initialize])

  const handleItemContextMenu = useCallback((e: React.MouseEvent, item: DownloadItem) => {
    setCtxMenu({ kind: 'download', x: e.clientX, y: e.clientY, item })
  }, [])

  const handleStreamContextMenu = useCallback((e: React.MouseEvent, item: StreamDownloadItem) => {
    e.preventDefault()
    setCtxMenu({ kind: 'stream', x: e.clientX, y: e.clientY, item })
  }, [])

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items
    const q = searchQuery.trim().toLowerCase()
    return items.filter(
      item => item.name.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)
    )
  }, [items, searchQuery])

  const filteredStreamItems = useMemo(() => {
    if (!searchQuery.trim()) return streamItems
    const q = searchQuery.trim().toLowerCase()
    return streamItems.filter(
      item => item.name.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)
    )
  }, [streamItems, searchQuery])

  const activeStreamItems = useMemo(() => {
    return filteredStreamItems.filter(i =>
      i.status === 'resolving' || i.status === 'downloading' || i.status === 'merging'
    )
  }, [filteredStreamItems])

  const finishedStreamItems = useMemo(() => {
    return filteredStreamItems.filter(i => i.status === 'completed' || i.status === 'failed')
  }, [filteredStreamItems])

  const groups = useMemo(() => groupByDate(filteredItems), [filteredItems])

  const hasCompleted = useMemo(
    () =>
      items.some(i => i.status === 'completed' || i.status === 'cancelled' || i.status === 'interrupted') ||
      streamItems.some(i => i.status === 'completed' || i.status === 'failed'),
    [items, streamItems]
  )

  const totalItems = items.length + streamItems.length

  const handleClearCompleted = storeActions.clearCompleted

  const getGroupLabel = useCallback(
    (label: string) => {
      if (label === 'today') return t('downloads.today', '今天')
      if (label === 'yesterday') return t('downloads.yesterday', '昨天')
      return label
    },
    [t]
  )

  const isEmpty = groups.length === 0 && filteredStreamItems.length === 0

  type VirtualRow =
    | { kind: 'header'; label: string; variant: 'stream' | 'date' | 'streamHistory' }
    | { kind: 'download'; item: DownloadItem }
    | { kind: 'stream'; item: StreamDownloadItem }

  const flatRows = useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = []
    if (activeStreamItems.length > 0) {
      rows.push({ kind: 'header', label: t('downloads.streamActive', '流媒体下载'), variant: 'stream' })
      activeStreamItems.forEach(item => rows.push({ kind: 'stream', item }))
    }
    groups.forEach(group => {
      rows.push({ kind: 'header', label: getGroupLabel(group.label), variant: 'date' })
      group.items.forEach(item => rows.push({ kind: 'download', item }))
    })
    if (finishedStreamItems.length > 0) {
      rows.push({ kind: 'header', label: t('downloads.streamHistory', '流媒体历史'), variant: 'streamHistory' })
      finishedStreamItems.forEach(item => rows.push({ kind: 'stream', item }))
    }
    return rows
  }, [activeStreamItems, groups, finishedStreamItems, getGroupLabel, t])

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
    if (row.kind === 'header') return `h-${row.variant}-${row.label}`
    if (row.kind === 'download') return `d-${row.item.id}`
    return `s-${row.item.id}`
  }, [])

  // hot-spaces 治理：见 `hooks/useScrollPositionPreserve.ts` 文件头注释。
  // 统一走 virtualizer 路径——之前的 `useVirtual` 阈值分叉会让短列表落到
  // 普通 `<ScrollArea>` 分支，scrollContainerRef 不绑定 → scroll preserve
  // 完全失效。绝大多数下载页 ≤ 50 行，删阈值后 hook 才能在主流场景生效。
  // 短列表性能差异微乎其微（virtualizer 自身开销 < 1ms）。
  // 已知限制：列表 newest-first 排序（today bucket 在前），hot-spaces 切走
  // 又有新下载产生时按 px 恢复的位置会指向错位项——hook 头 §已知限制 #1。
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

  const renderRow = useCallback((row: VirtualRow) => {
    if (row.kind === 'header') {
      const colorCls = row.variant === 'stream' ? 'text-type-agent/80' : 'text-muted-foreground/80'
      return (
        <div className={`px-4 py-1.5 text-body font-medium ${colorCls} uppercase tracking-wider`}>
          {row.label}
        </div>
      )
    }
    if (row.kind === 'stream') {
      return <StreamDownloadItemRow item={row.item} onContextMenu={handleStreamContextMenu} />
    }
    return <DownloadItemRow item={row.item} onContextMenu={handleItemContextMenu} />
  }, [handleItemContextMenu, handleStreamContextMenu])

  return (
    <div className="w-full h-full flex flex-col bg-background overflow-hidden">
      {/* 头部 */}
      <ContextPageHeader
        className="flex-shrink-0 px-6 pt-6 pb-4"
        icon={<Download className="h-7 w-7" />}
        title={t('downloads.title', '下载管理')}
        description={
          activeCount > 0
            ? t('downloads.activeCount', { count: activeCount, defaultValue: `${activeCount} 个下载进行中` })
            : t('downloads.noActive', '暂无进行中的下载')
        }
        actions={hasCompleted ? (
          <button
            type="button"
            className="rounded-interactive px-3 py-1.5 text-body text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
            onClick={handleClearCompleted}
          >
            {t('downloads.clearAll', '清除历史')}
          </button>
        ) : null}
        footer={totalItems > 3 ? (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('downloads.searchPlaceholder', '搜索文件名或 URL...')}
              className="w-full rounded-interactive border border-border/30 bg-foreground/[0.025] py-2 pl-9 pr-4 text-body outline-none placeholder:text-muted-foreground/40 transition-colors focus:border-primary/60 focus:ring-1 focus:ring-inset focus:ring-ring dark:bg-foreground/[0.04]"
            />
          </div>
        ) : null}
      />

      {/* 下载列表 */}
      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 pb-6">
          <div className="p-4 bg-muted/30 rounded-full mb-4">
            <ArrowDown className="w-8 h-8 text-muted-foreground/30" />
          </div>
          <p className="text-body text-muted-foreground">
            {searchQuery
              ? t('downloads.noResults', '没有找到匹配的下载')
              : t('downloads.empty', '暂无下载记录')
            }
          </p>
          <p className="text-body text-muted-foreground/60 mt-1">
            {t('downloads.emptyHint', '浏览网页时的下载将会显示在这里')}
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

      {ctxMenu && ctxMenu.kind === 'download' && (
        <DownloadContextMenu x={ctxMenu.x} y={ctxMenu.y} item={ctxMenu.item} onClose={() => setCtxMenu(null)} />
      )}
      {ctxMenu && ctxMenu.kind === 'stream' && (
        <StreamContextMenu x={ctxMenu.x} y={ctxMenu.y} item={ctxMenu.item} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  )
}
