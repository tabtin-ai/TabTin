/**
 * ResourceListItem — 资源列表行（共享组件）
 *
 * 标准化的列表行渲染：emoji + 标题（可选置顶图标 + 尾部标签）+ 时间。
 * 消除 ContextHome / CollectionsView 间的重复列表渲染代码。
 */
import React from 'react'
import { Pin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { contextRegistry } from '../instance'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import {
  SIDEBAR_BADGE,
  SIDEBAR_ICON,
  SIDEBAR_META_END,
  SIDEBAR_ROW,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
} from '@components/layout/sidebarUi'
import type { SpaceContextItem } from '@/services/spaceApi'
import { resolveResourceEmoji } from './metaFieldUtils'

export interface ResourceListItemProps {
  item: SpaceContextItem
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** 标题下方的摘要行 */
  snippet?: string | null
  /** 标题后方的附加内容（如合集名称标签） */
  trailingBadge?: React.ReactNode
  /** 是否在置顶资源旁显示置顶图标 */
  showPinIcon?: boolean
  className?: string
  isBusy?: boolean
  busyLabel?: string
}

export const ResourceListItem: React.FC<ResourceListItemProps> = ({
  item,
  onClick,
  onContextMenu,
  snippet,
  trailingBadge,
  showPinIcon = false,
  className,
  isBusy = false,
  busyLabel,
}) => {
  const { t } = useTranslation('context')
  const emoji = resolveResourceEmoji(
    item.item_type,
    item.metadata,
    type => contextRegistry.getDisplayEmoji(type),
  )

  return (
    <button
      type="button"
      disabled={isBusy}
      aria-busy={isBusy}
      className={cn(
        SIDEBAR_ROW,
        SIDEBAR_ROW_FULL_WIDTH,
        SIDEBAR_ROW_INACTIVE,
        isBusy && 'cursor-not-allowed opacity-60 hover:bg-transparent',
        className,
      )}
      onClick={isBusy ? undefined : onClick}
      onContextMenu={isBusy ? undefined : onContextMenu}
    >
      <span className={cn(SIDEBAR_ICON, 'flex items-center justify-center text-body leading-none')}>
        {isBusy ? (
          <span className="block h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground/80 animate-spin" />
        ) : emoji}
      </span>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden text-body text-foreground/80">
          {showPinIcon && item.is_pinned && <Pin className="h-3 w-3 shrink-0 text-primary-text" />}
          <span className="truncate">{item.title || item.resource_id}</span>
          {trailingBadge && <span className={SIDEBAR_BADGE}>{trailingBadge}</span>}
        </div>
        {snippet && (
          <p className={cn('truncate', 'leading-snug', 'text-muted-foreground/60', 'm-0', CANVAS_TEXT_META)}>
            {snippet}
          </p>
        )}
      </div>
      <span className={SIDEBAR_META_END}>
        {isBusy
          ? (busyLabel || t('home.deleting', { defaultValue: 'Deleting...' }))
          : (
            item.item_type === 'tabfolder' && item.metadata?.pathInvalid
              ? t('folder.status.pathInvalid', { defaultValue: '已失效' })
              : formatRelativeTime(item.updated_at, t)
          )
        }
      </span>
    </button>
  )
}
