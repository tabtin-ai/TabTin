/**
 * ResourceGridCard — 资源宫格卡片（共享组件）
 *
 * 封装 SpaceContextItem → HomeGridCard 的数据转换逻辑（缩略图提取、
 * 结构化封面、文本预览、类型图标），消除 ContextHome / CollectionsView
 * 间的重复渲染代码。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { HomeGridCard, getTypeGradient } from './HomeGridCard'
import { GridCardMetaRow, ResourceGridSpaceBadge } from './gridCardMeta'
import { buildCoverContent } from './StructuredPreviews'
import { extractThumbnail, synthesizePreview } from './resourcePreview'
import { contextRegistry } from '../instance'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import type { SpaceContextItem } from '@/services/spaceApi'
import { resolveCloudResourceEmoji } from './resolveCloudResourceIcon'

export interface ResourceGridCardProps {
  item: SpaceContextItem
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** 跨 Space 来源名；宫格内以 ↗ 图标展示，hover 看完整名 */
  spaceName?: string | null
  isBusy?: boolean
  busyLabel?: string
  className?: string
}

export const ResourceGridCard: React.FC<ResourceGridCardProps> = ({
  item,
  onClick,
  onContextMenu,
  spaceName,
  isBusy = false,
  busyLabel,
  className,
}) => {
  const { t } = useTranslation('context')
  const resolvedType = contextRegistry.normalizeBackendType(item.item_type)
  const emoji = resolveCloudResourceEmoji(
    resolvedType,
    item.metadata,
    type => contextRegistry.getDisplayEmoji(type),
    item.title || item.resource_id,
  )
  const label = contextRegistry.getDisplayLabel(resolvedType)
  const thumb = extractThumbnail(item.metadata, resolvedType)
  const rawPreview = item.preview?.trim() || null
  const cover = !thumb ? buildCoverContent(resolvedType, item.metadata, rawPreview) : null
  const preview = !thumb && !cover ? (rawPreview || synthesizePreview(item.metadata, resolvedType, t)) : null

  const isPathInvalid = resolvedType === 'tabfolder' && item.metadata?.pathInvalid === true
  const showTypeInCover = !thumb && !cover && !preview
  const showTypeInSubtitle = !showTypeInCover && !isPathInvalid && !!label

  return (
    <HomeGridCard
      gradient={getTypeGradient(resolvedType)}
      thumbnailUrl={thumb}
      coverContent={cover}
      previewText={preview}
      icon={emoji || '📁'}
      typeLabel={showTypeInCover ? label : null}
      title={item.title || item.resource_id}
      subtitle={
        <GridCardMetaRow
          typeLabel={showTypeInSubtitle ? label : null}
          time={!isPathInvalid ? formatRelativeTime(item.updated_at, t) : undefined}
          statusLabel={isPathInvalid ? t('folder.status.pathInvalid', { defaultValue: '已失效' }) : undefined}
          trailing={spaceName ? <ResourceGridSpaceBadge spaceName={spaceName} /> : undefined}
        />
      }
      onClick={onClick}
      onContextMenu={onContextMenu}
      isPinned={item.is_pinned}
      isDisabled={isBusy}
      busyLabel={isBusy ? busyLabel : undefined}
      className={className}
    />
  )
}
