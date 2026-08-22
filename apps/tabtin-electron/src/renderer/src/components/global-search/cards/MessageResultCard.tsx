/**
 * 消息搜索结果卡片（PRD 3.4）
 *
 * 字段映射：
 * - 图标：💬 或 Agent 头像（按 creator_type）
 * - 标题：会话标题（高亮）
 * - 摘要：命中消息内容（高亮）
 * - 创建者标识："你 → 性能优化" / "🤖 CodeBot → 性能优化"
 * - 元信息：Space 路径 · 时间
 */

import React from 'react'
import type { FtsSearchResultItem } from '@tabtin/app-shell'
import { SafeHighlight } from '../components/SafeHighlight'
import { buildQuerySnippetHighlight } from '../components/querySnippet'
import { CardShell, CreatorBadge, SpacePath, formatRelativeTime } from './cardCommon'
import { RESULT_TYPE_EMOJI } from '../i18n'

interface MessageResultCardProps {
  item: FtsSearchResultItem
  selected?: boolean
  dataIdx?: number
  id?: string
  onClick?: () => void
  onMouseEnter?: () => void
  onScopeToSpace?: () => void
  /** 当前用户 id，用于"你 → ..." 自识别 */
  currentUserId?: string | null
  /** 自我标签（i18n） */
  selfLabel?: string
  /** 类型徽章文案（i18n） */
  typeBadgeLabel?: string
  query?: string
}

export function MessageResultCard({
  item,
  selected,
  dataIdx,
  id,
  onClick,
  onMouseEnter,
  onScopeToSpace,
  currentUserId,
  selfLabel = '你',
  typeBadgeLabel = '消息',
  query,
}: MessageResultCardProps) {
  const isSelf =
    item.creator_type === 'user' && !!currentUserId && item.creator_id === currentUserId
  // 标题：会话标题；如有 highlight 走高亮
  const titleHl = item.highlight?.session_title?.[0]
  const title = item.title || item.session_title || ''
  const titleHasQuery = query && title.toLowerCase().includes(query.trim().toLowerCase())
  const titleContent = titleHl || (titleHasQuery ? buildQuerySnippetHighlight(title, query, { maxChars: 120 }) : '')
  // 摘要：内容片段
  const snippet = item.highlight?.content?.[0] || buildQuerySnippetHighlight(item.snippet, query)

  return (
    <CardShell
      id={id}
      dataIdx={dataIdx}
      selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      icon={RESULT_TYPE_EMOJI.message}
      badge={typeBadgeLabel}
      trailing={formatRelativeTime(item.created_at)}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-body text-foreground truncate">
          {titleContent ? <SafeHighlight html={titleContent} /> : title}
        </span>
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
          target={item.session_title || item.title || undefined}
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
