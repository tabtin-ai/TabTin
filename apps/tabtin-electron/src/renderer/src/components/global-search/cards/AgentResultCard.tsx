/**
 * Agent 搜索结果卡片（PRD 3.4）
 *
 * 字段映射：
 * - 图标：Agent avatar（暂用 🤖 兜底）
 * - 标题：Agent 名称（高亮）
 * - 摘要：description（高亮）
 * - 元信息：Organization · Space 数（来自 metadata.space_ids）
 */

import React from 'react'
import type { FtsSearchResultItem } from '@tabtin/app-shell'
import { SafeHighlight } from '../components/SafeHighlight'
import { CardShell, formatRelativeTime } from './cardCommon'
import { RESULT_TYPE_EMOJI } from '../i18n'

interface AgentResultCardProps {
  item: FtsSearchResultItem
  selected?: boolean
  dataIdx?: number
  id?: string
  onClick?: () => void
  onMouseEnter?: () => void
  typeBadgeLabel?: string
}

export function AgentResultCard({
  item,
  selected,
  dataIdx,
  id,
  onClick,
  onMouseEnter,
  typeBadgeLabel = 'Agent',
}: AgentResultCardProps) {
  const titleHl = item.highlight?.name?.[0]
  const snippet = item.highlight?.description?.[0] || item.snippet || ''
  const spaceIds = (item.metadata?.space_ids as string[] | undefined) || []

  return (
    <CardShell
      id={id}
      dataIdx={dataIdx}
      selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      icon={item.creator_avatar || RESULT_TYPE_EMOJI.agent}
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
      {spaceIds.length > 0 && (
        <div className="text-caption text-muted-foreground/60 mt-1">
          {spaceIds.length} 个 Space
        </div>
      )}
    </CardShell>
  )
}
