/**
 * Space 搜索结果卡片（PRD 3.4）
 *
 * 字段映射：
 * - 图标：📁
 * - 标题：Space 名称（高亮）
 * - 摘要：description（高亮）
 * - 元信息：Organization · 类型（personal/team/bot）
 */

import React from 'react'
import type { FtsSearchResultItem } from '@tabtin/app-shell'
import { SafeHighlight } from '../components/SafeHighlight'
import { CardShell, formatRelativeTime } from './cardCommon'
import { RESULT_TYPE_EMOJI } from '../i18n'

interface SpaceResultCardProps {
  item: FtsSearchResultItem
  selected?: boolean
  dataIdx?: number
  id?: string
  onClick?: () => void
  onMouseEnter?: () => void
  typeBadgeLabel?: string
}

export function SpaceResultCard({
  item,
  selected,
  dataIdx,
  id,
  onClick,
  onMouseEnter,
  typeBadgeLabel = 'Space',
}: SpaceResultCardProps) {
  const titleHl = item.highlight?.name?.[0]
  const snippet = item.highlight?.description?.[0] || item.snippet || ''
  const spaceType = item.metadata?.space_type as string | undefined

  return (
    <CardShell
      id={id}
      dataIdx={dataIdx}
      selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      icon={RESULT_TYPE_EMOJI.space}
      badge={typeBadgeLabel}
      trailing={formatRelativeTime(item.created_at)}
    >
      <div className="text-body text-foreground truncate">
        {titleHl ? <SafeHighlight html={titleHl} /> : (item.title || '')}
      </div>
      {snippet && (
        <div className="text-caption text-muted-foreground/80 truncate mt-0.5">
          <SafeHighlight html={snippet} />
        </div>
      )}
      {spaceType && (
        <div className="text-caption text-muted-foreground/60 mt-1">{spaceType}</div>
      )}
    </CardShell>
  )
}
