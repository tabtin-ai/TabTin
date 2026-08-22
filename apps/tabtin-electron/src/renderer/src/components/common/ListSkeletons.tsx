import React from 'react'
import { ScrollArea, Skeleton } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import {
  SKELETON_CHAT_HISTORY_ROW,
  SKELETON_DETAIL_ROW,
  SKELETON_GRID_CARD,
  SKELETON_IM_ROW,
  SKELETON_MANAGEMENT_CARD,
  SKELETON_MEMO_CARD,
  SKELETON_NAV_ROW,
  SKELETON_RESOURCE_ROW,
  SKELETON_TABLE_FRAME,
} from '@/constants/skeletonUi'

const CHAT_TITLE_WIDTHS = ['54%', '72%', '61%', '67%', '49%', '58%'] as const
const CHAT_META_WIDTHS = ['28%', '34%', '22%', '30%', '26%', '24%'] as const
const CHAT_COUNT_WIDTHS = ['18%', '24%', '20%', '16%', '22%', '14%'] as const
const NAV_TITLE_WIDTHS = ['52%', '68%', '60%', '74%', '58%', '64%'] as const
const NAV_META_WIDTHS = ['24%', '30%', '18%', '26%', '22%', '28%'] as const
const DETAIL_TITLE_WIDTHS = ['48%', '66%', '58%', '72%', '54%', '62%'] as const
const DETAIL_SUBTITLE_WIDTHS = ['32%', '24%', '28%', '20%', '30%', '26%'] as const
const RESOURCE_TITLE_WIDTHS = ['44%', '62%', '56%', '48%', '68%', '52%'] as const
const RESOURCE_PREVIEW_WIDTHS = ['72%', '84%', '66%', '78%', '70%', '82%'] as const
const RESOURCE_META_WIDTHS = ['18%', '22%', '16%', '20%', '24%', '14%'] as const
const BUBBLE_WIDTHS = ['56%', '70%', '48%', '64%', '52%', '60%'] as const
const MEMO_HEIGHTS = [118, 142, 104, 136, 112, 152] as const

const pickWidth = (widths: readonly string[], index: number) => widths[index % widths.length]

export const SpaceListSkeleton: React.FC<{ count?: number }> = ({ count = 8 }) => {
  return (
    <div className="flex h-full flex-col" aria-hidden="true">
      <ScrollArea className="flex-1" scrollBar="vertical">
        <div className="sticky top-0 z-sticky flex flex-col items-center gap-1.5 pb-2 pt-1">
          <Skeleton width={32} height={32} rounded="lg" />
          <Skeleton width={32} height={32} rounded="lg" className="opacity-80" />
        </div>
        <div className="space-y-1 px-1">
          {Array.from({ length: count }).map((_, index) => (
            <div key={index} className="flex justify-center">
              <Skeleton
                width={40}
                height={40}
                rounded="xl"
                className={cn(index % 4 === 0 && 'opacity-75')}
              />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

export const ChatHistorySkeleton: React.FC<{ count?: number }> = ({ count = 6 }) => {
  return (
    <div className="space-y-0.5 px-1.5 py-1" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={SKELETON_CHAT_HISTORY_ROW}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton width={pickWidth(CHAT_TITLE_WIDTHS, index)} height={13} rounded="md" />
              <div className="flex items-center gap-2">
                <Skeleton width={pickWidth(CHAT_META_WIDTHS, index)} height={10} rounded="full" className="opacity-80" />
                <Skeleton width={pickWidth(CHAT_COUNT_WIDTHS, index)} height={10} rounded="full" className="opacity-60" />
              </div>
            </div>
            <Skeleton width={18} height={18} rounded="md" className="opacity-60" />
          </div>
        </div>
      ))}
    </div>
  )
}

export const SidebarResourceListSkeleton: React.FC<{ count?: number }> = ({ count = 6 }) => {
  return (
    <div className="space-y-0.5" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={cn(SKELETON_NAV_ROW, 'py-1')}>
          <Skeleton width={12} height={12} rounded="sm" className="opacity-80" />
          <Skeleton width={pickWidth(RESOURCE_TITLE_WIDTHS, index)} height={11} rounded="md" className="flex-1" />
          <Skeleton width={pickWidth(RESOURCE_META_WIDTHS, index)} height={10} rounded="full" className="opacity-60" />
        </div>
      ))}
    </div>
  )
}

interface ResourceCollectionSkeletonProps {
  mode?: 'list' | 'grid'
  count?: number
  minCardWidth?: number
  variant?: 'default' | 'flat'
}

export const ResourceCollectionSkeleton: React.FC<ResourceCollectionSkeletonProps> = ({
  mode = 'list',
  count = 6,
  minCardWidth = 120,
  variant = 'default',
}) => {
  if (mode === 'grid') {
    return (
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))` }}
        aria-hidden="true"
      >
        {Array.from({ length: count }).map((_, index) => (
          <div
            key={index}
            className={variant === 'flat' ? 'overflow-hidden p-1.5' : SKELETON_GRID_CARD}
          >
            <Skeleton height={72} rounded="lg" className="mb-2" />
            <Skeleton width={pickWidth(RESOURCE_TITLE_WIDTHS, index)} height={12} rounded="md" />
            <Skeleton width={pickWidth(RESOURCE_META_WIDTHS, index)} height={10} rounded="full" className="mt-2 opacity-80" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 min-w-0 w-full" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={SKELETON_RESOURCE_ROW}>
          <Skeleton width={14} height={14} rounded="md" className="mt-0.5 opacity-80" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton width={pickWidth(RESOURCE_TITLE_WIDTHS, index)} height={12} rounded="md" />
            <Skeleton width={pickWidth(RESOURCE_PREVIEW_WIDTHS, index)} height={10} rounded="full" className="opacity-80" />
          </div>
          <Skeleton width={pickWidth(RESOURCE_META_WIDTHS, index)} height={10} rounded="full" className="opacity-60" />
        </div>
      ))}
    </div>
  )
}

export const NavigationListSkeleton: React.FC<{ count?: number }> = ({ count = 6 }) => {
  return (
    <div className="space-y-0.5 px-1 py-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={SKELETON_IM_ROW}>
          <Skeleton width={30} height={30} rounded="full" className="opacity-80" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton width={pickWidth(NAV_TITLE_WIDTHS, index)} height={12} rounded="md" />
            <Skeleton width={pickWidth(NAV_META_WIDTHS, index)} height={10} rounded="full" className="opacity-80" />
          </div>
          <Skeleton width={16} height={16} rounded="full" className="opacity-60" />
        </div>
      ))}
    </div>
  )
}

interface DetailedRowListSkeletonProps {
  count?: number
  showPreview?: boolean
  leadingShape?: 'icon' | 'avatar'
  compact?: boolean
}

export const DetailedRowListSkeleton: React.FC<DetailedRowListSkeletonProps> = ({
  count = 6,
  showPreview = true,
  leadingShape = 'icon',
  compact = false,
}) => {
  const verticalPadding = compact ? 'py-2.5' : 'py-3'
  const iconSize = leadingShape === 'avatar' ? 30 : 16
  const iconRounded = leadingShape === 'avatar' ? 'full' : 'md'

  return (
    <div aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={cn(SKELETON_DETAIL_ROW, verticalPadding)}>
          <Skeleton width={iconSize} height={iconSize} rounded={iconRounded} className="mt-0.5 opacity-80" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <Skeleton width={pickWidth(DETAIL_TITLE_WIDTHS, index)} height={12} rounded="md" />
              <Skeleton width={pickWidth(DETAIL_SUBTITLE_WIDTHS, index)} height={10} rounded="full" className="ml-auto opacity-60" />
            </div>
            <Skeleton width={pickWidth(RESOURCE_TITLE_WIDTHS, index)} height={11} rounded="md" className="opacity-80" />
            {showPreview && (
              <Skeleton width={pickWidth(RESOURCE_PREVIEW_WIDTHS, index)} height={10} rounded="full" className="opacity-80" />
            )}
          </div>
          <Skeleton width={18} height={18} rounded="full" className="mt-0.5 opacity-60" />
        </div>
      ))}
    </div>
  )
}

interface PaneLoadingSkeletonProps {
  count?: number
  showPreview?: boolean
}

export const PaneLoadingSkeleton: React.FC<PaneLoadingSkeletonProps> = ({
  count = 6,
  showPreview = true,
}) => {
  return (
    <div className="flex h-full w-full flex-col bg-background" aria-hidden="true">
      <div className="flex items-start justify-between border-b border-border/20 px-4 py-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton width={18} height={18} rounded="md" className="opacity-80" />
            <Skeleton width="30%" height={14} rounded="md" />
          </div>
          <div className="flex items-center gap-2 pl-7">
            <Skeleton width="16%" height={10} rounded="full" className="opacity-80" />
            <Skeleton width="12%" height={10} rounded="full" className="opacity-60" />
            <Skeleton width="18%" height={10} rounded="full" className="opacity-60" />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton width={30} height={30} rounded="md" className="opacity-60" />
          <Skeleton width={68} height={30} rounded="md" className="opacity-80" />
        </div>
      </div>
      <div className="flex-1 overflow-hidden py-2">
        <DetailedRowListSkeleton count={count} showPreview={showPreview} compact />
      </div>
    </div>
  )
}

export const ManagementCardListSkeleton: React.FC<{ count?: number }> = ({ count = 4 }) => {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={SKELETON_MANAGEMENT_CARD}>
          <div className="flex items-center gap-3">
            <Skeleton width={16} height={16} rounded="md" className="opacity-80" />
            <div className="space-y-1.5">
              <Skeleton width={pickWidth(DETAIL_TITLE_WIDTHS, index)} height={12} rounded="md" />
              <Skeleton width={pickWidth(DETAIL_SUBTITLE_WIDTHS, index)} height={10} rounded="full" className="opacity-80" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton width={26} height={26} rounded="md" className="opacity-60" />
            <Skeleton width={26} height={26} rounded="md" className="opacity-60" />
          </div>
        </div>
      ))}
    </div>
  )
}

interface TablePreviewSkeletonProps {
  rows?: number
  columns?: number
}

export const TablePreviewSkeleton: React.FC<TablePreviewSkeletonProps> = ({
  rows = 6,
  columns = 5,
}) => {
  return (
    <div className="h-full overflow-hidden p-3" aria-hidden="true">
      <div className={SKELETON_TABLE_FRAME}>
        <div
          className="grid border-b border-border/20 bg-muted/20"
          style={{ gridTemplateColumns: `44px repeat(${columns}, minmax(120px, 1fr))` }}
        >
          <div className="border-r border-border/20 px-2 py-2">
            <Skeleton width={14} height={10} rounded="full" className="mx-auto opacity-60" />
          </div>
          {Array.from({ length: columns }).map((_, index) => (
            <div key={index} className="border-r border-border/20 px-3 py-2 last:border-r-0">
              <Skeleton width={pickWidth(RESOURCE_TITLE_WIDTHS, index)} height={11} rounded="md" />
            </div>
          ))}
        </div>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid border-b border-border/20 last:border-b-0"
            style={{ gridTemplateColumns: `44px repeat(${columns}, minmax(120px, 1fr))` }}
          >
            <div className="border-r border-border/20 px-2 py-2.5">
              <Skeleton width={12} height={10} rounded="full" className="mx-auto opacity-60" />
            </div>
            {Array.from({ length: columns }).map((_, columnIndex) => (
              <div key={columnIndex} className="border-r border-border/20 px-3 py-2.5 last:border-r-0">
                <Skeleton
                  width={pickWidth(RESOURCE_PREVIEW_WIDTHS, rowIndex + columnIndex)}
                  height={10}
                  rounded="full"
                  className={cn((rowIndex + columnIndex) % 3 === 0 && 'opacity-80')}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export const MessageListSkeleton: React.FC<{ count?: number }> = ({ count = 6 }) => {
  return (
    <div className="space-y-3 px-4 py-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => {
        const isOwn = index % 3 === 2
        return (
          <div key={index} className={cn('flex', isOwn ? 'justify-end' : 'justify-start')}>
            {!isOwn && <Skeleton width={28} height={28} rounded="full" className="mr-2 mt-1 opacity-80" />}
            <div className={cn('flex max-w-[78%] flex-col space-y-1.5', isOwn ? 'items-end' : 'items-start')}>
              {!isOwn && (
                <Skeleton width={pickWidth(NAV_META_WIDTHS, index)} height={10} rounded="full" className="opacity-60" />
              )}
              <Skeleton width={pickWidth(BUBBLE_WIDTHS, index)} height={36 + (index % 2) * 12} rounded="xl" />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * MemoGridSkeleton — 与 MasonryGrid 使用相同的响应式列数逻辑
 * 断点：>=1024→4列, >=768→3列, >=480→2列, <480→1列
 */
export const MemoGridSkeleton: React.FC<{ count?: number }> = ({ count = 8 }) => {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [columnCount, setColumnCount] = React.useState<number | null>(null)

  React.useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const calc = (w: number) => (w >= 1024 ? 4 : w >= 768 ? 3 : w >= 480 ? 2 : 1)
    setColumnCount(calc(el.clientWidth))
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) setColumnCount(calc(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const cols = columnCount ?? 2
  const items = Array.from({ length: count })
  const columns: number[][] = Array.from({ length: cols }, () => [])
  const heights = new Array(cols).fill(0)
  items.forEach((_, idx) => {
    let shortest = 0
    for (let c = 1; c < cols; c++) {
      if (heights[c] < heights[shortest]) shortest = c
    }
    columns[shortest].push(idx)
    heights[shortest] += 1
  })

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', gap: 12, visibility: columnCount === null ? 'hidden' : undefined }}
      aria-hidden="true"
    >
      {columns.map((col, colIdx) => (
        <div key={colIdx} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {col.map(index => (
            <div
              key={index}
              className={SKELETON_MEMO_CARD}
              style={{ minHeight: MEMO_HEIGHTS[index % MEMO_HEIGHTS.length] }}
            >
              <Skeleton width={pickWidth(DETAIL_TITLE_WIDTHS, index)} height={12} rounded="md" />
              <Skeleton width={pickWidth(RESOURCE_PREVIEW_WIDTHS, index)} height={10} rounded="full" className="mt-2 opacity-80" />
              <Skeleton width={pickWidth(RESOURCE_TITLE_WIDTHS, index)} height={10} rounded="full" className="mt-1.5 opacity-80" />
              <div className="mt-4 space-y-2">
                <Skeleton width="100%" height={10} rounded="full" className="opacity-80" />
                <Skeleton width={pickWidth(BUBBLE_WIDTHS, index)} height={10} rounded="full" className="opacity-60" />
              </div>
              <div className="mt-5 flex items-center justify-between">
                <Skeleton width={38} height={18} rounded="full" className="opacity-60" />
                <Skeleton width={18} height={18} rounded="full" className="opacity-60" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
