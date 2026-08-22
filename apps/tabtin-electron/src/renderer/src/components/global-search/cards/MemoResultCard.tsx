/**
 * 备忘录搜索结果卡片（PRD 3.4）
 *
 * 字段映射：
 * - 图标：📝
 * - 标题：备忘录首行（已 hydrate）
 * - 摘要：内容片段（高亮）
 * - 创建者标识：用户/Agent
 * - 元信息：Space · 标签 · 时间
 */

import React from 'react'
import type { FtsSearchResultItem } from '@tabtin/app-shell'
import { SafeHighlight } from '../components/SafeHighlight'
import { buildQuerySnippetHighlight } from '../components/querySnippet'
import { CardShell, CreatorBadge, SpacePath, formatRelativeTime } from './cardCommon'
import { RESULT_TYPE_EMOJI } from '../i18n'

interface MemoResultCardProps {
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
}

export function MemoResultCard({
  item,
  selected,
  dataIdx,
  id,
  onClick,
  onMouseEnter,
  onScopeToSpace,
  currentUserId,
  selfLabel = '你',
  typeBadgeLabel = '备忘录',
  query,
}: MemoResultCardProps) {
  const isSelf =
    item.creator_type === 'user' && !!currentUserId && item.creator_id === currentUserId
  const title = item.title || ''
  const titleHasQuery = query && title.toLowerCase().includes(query.trim().toLowerCase())
  const titleContent = titleHasQuery ? buildQuerySnippetHighlight(title, query, { maxChars: 120 }) : ''
  const snippet = item.highlight?.content?.[0] || buildQuerySnippetHighlight(item.snippet, query)
  const tags = (item.metadata?.tags as string[] | undefined) || []
  const aiTags = (item.metadata?.ai_tags as string[] | undefined) || []
  const allTags = [...tags, ...aiTags].slice(0, 3)

  return (
    <CardShell
      id={id}
      dataIdx={dataIdx}
      selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      icon={RESULT_TYPE_EMOJI.memo}
      badge={typeBadgeLabel}
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
        {allTags.map((tag) => (
          <span
            key={tag}
            className="text-caption text-muted-foreground/60 bg-muted/30 rounded px-1"
          >
            #{tag}
          </span>
        ))}
      </div>
    </CardShell>
  )
}
