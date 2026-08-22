/**
 * IM 消息搜索结果卡片（PRD 3.4）
 *
 * 字段映射：
 * - 图标：💬
 * - 标题：会话名称（高亮）
 * - 摘要：命中消息内容（高亮）
 * - 元信息：发送者 · 时间
 *
 * W2-2 提示：item.session_id 实际是 conversation_id；前端导航分发时按
 * `type === 'im'` 走 IM 路由（详见 GlobalSearch.handleNavigate）。
 */

import React from 'react'
import type { FtsSearchResultItem } from '@tabtin/app-shell'
import { SafeHighlight } from '../components/SafeHighlight'
import { CardShell, formatRelativeTime } from './cardCommon'
import { RESULT_TYPE_EMOJI } from '../i18n'

interface IMResultCardProps {
  item: FtsSearchResultItem
  selected?: boolean
  dataIdx?: number
  id?: string
  onClick?: () => void
  onMouseEnter?: () => void
  typeBadgeLabel?: string
}

export function IMResultCard({
  item,
  selected,
  dataIdx,
  id,
  onClick,
  onMouseEnter,
  typeBadgeLabel = 'IM',
}: IMResultCardProps) {
  const titleHl = item.highlight?.conversation_name?.[0]
  const snippet = item.highlight?.content?.[0] || item.snippet || ''

  return (
    <CardShell
      id={id}
      dataIdx={dataIdx}
      selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      icon={RESULT_TYPE_EMOJI.im}
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
      {item.creator_name && (
        <div className="text-caption text-muted-foreground/60 mt-1 truncate">
          👤 {item.creator_name}
        </div>
      )}
    </CardShell>
  )
}
