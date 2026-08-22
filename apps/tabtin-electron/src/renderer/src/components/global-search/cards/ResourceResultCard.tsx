/**
 * 资源搜索结果卡片（PRD 3.4）
 *
 * 字段映射：
 * - 图标：item_type 对应 emoji（tabdoc/tabdata/...）
 * - 标题：资源标题（高亮）
 * - 摘要：preview（高亮）
 * - 创建者标识：用户/Agent
 * - 元信息：Space 路径 · 类型徽章
 */

import React from 'react'
import type { FtsSearchResultItem } from '@tabtin/app-shell'
import { SafeHighlight } from '../components/SafeHighlight'
import { buildQuerySnippetHighlight } from '../components/querySnippet'
import { CardShell, CreatorBadge, SpacePath, formatRelativeTime } from './cardCommon'
import { RESULT_TYPE_EMOJI } from '../i18n'

interface ResourceResultCardProps {
  item: FtsSearchResultItem
  selected?: boolean
  dataIdx?: number
  id?: string
  onClick?: () => void
  onMouseEnter?: () => void
  onScopeToSpace?: () => void
  currentUserId?: string | null
  selfLabel?: string
  typeBadgeLabel?: string
  query?: string
  /** item_type → emoji 映射（来自 contextRegistry） */
  itemTypeEmoji?: (itemType: string) => string
  /** item_type → 类型显示文案（如"文档/表格/幻灯片"） */
  itemTypeLabel?: (itemType: string) => string
}

export function ResourceResultCard({
  item,
  selected,
  dataIdx,
  id,
  onClick,
  onMouseEnter,
  onScopeToSpace,
  currentUserId,
  selfLabel = '你',
  typeBadgeLabel = '资源',
  query,
  itemTypeEmoji,
  itemTypeLabel,
}: ResourceResultCardProps) {
  const isSelf =
    item.creator_type === 'user' && !!currentUserId && item.creator_id === currentUserId
  const itemType = (item.metadata?.item_type as string | undefined) || ''
  const icon = itemTypeEmoji?.(itemType) || RESULT_TYPE_EMOJI.resource
  const itemLabel = itemType ? (itemTypeLabel?.(itemType) || itemType) : typeBadgeLabel

  const titleHl = item.highlight?.title?.[0]
  const title = item.title || ''
  const titleHasQuery = query && title.toLowerCase().includes(query.trim().toLowerCase())
  const titleContent = titleHl || (titleHasQuery ? buildQuerySnippetHighlight(title, query, { maxChars: 120 }) : '')
  const snippet = item.highlight?.preview?.[0] || buildQuerySnippetHighlight(item.snippet, query)

  return (
    <CardShell
      id={id}
      dataIdx={dataIdx}
      selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      icon={icon}
      badge={itemLabel}
      trailing={formatRelativeTime(item.created_at)}
    >
      <div className="text-body text-foreground truncate">
        {titleContent ? <SafeHighlight html={titleContent} /> : title}
      </div>
      {snippet && (
        <div className="text-caption text-muted-foreground/80 truncate mt-1">
          <SafeHighlight html={snippet} />
        </div>
      )}
      <div className="flex items-center gap-2 mt-1 flex-wrap">
        <CreatorBadge
          creatorType={item.creator_type}
          creatorName={item.creator_name}
          isSelf={isSelf}
          selfLabel={selfLabel}
        />
        {item.space_name && (
          <>
            <span className="text-caption text-muted-foreground/60" aria-hidden="true">·</span>
            <SpacePath spaceName={item.space_name} onScopeToSpace={onScopeToSpace} />
          </>
        )}
      </div>
    </CardShell>
  )
}
