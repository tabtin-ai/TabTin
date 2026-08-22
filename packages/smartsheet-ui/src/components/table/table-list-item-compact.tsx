/**
 * 紧凑型表格列表项组件（Notion 风格 - 与项目统一）
 * 用于侧边栏中的表格显示
 * 与项目列表项保持完全一致的视觉样式
 * 通过缩进表达层级关系
 */

import React from 'react'
import { Archive } from 'lucide-react'
import { t } from "../../i18n"
import { formatRelativeTime as formatRelativeTimeUtil } from '../../utils/time'

export interface Table {
  id: string
  name: string
  icon?: string
  row_count?: number
  field_count?: number
  is_archived?: boolean
  created_at?: string
  updated_at?: string
  schema_history_id?: string
  default_source_url?: string
}

function formatRelativeTime(dateString?: string): string {
  if (!dateString) return ''
  return formatRelativeTimeUtil(dateString, {
    justNow: t('tableListItemCompact.time.justNow'),
    minutesAgo: (n) => t('tableListItemCompact.time.minutesAgo', { count: n }),
    hoursAgo: (n) => t('tableListItemCompact.time.hoursAgo', { count: n }),
    daysAgo: (n) => t('tableListItemCompact.time.daysAgo', { count: n }),
    weeksAgo: (n) => t('tableListItemCompact.time.weeksAgo', { count: n }),
    monthsAgo: (n) => t('tableListItemCompact.time.monthsAgo', { count: n }),
    yearsAgo: (n) => t('tableListItemCompact.time.yearsAgo', { count: n }),
  })
}

export interface TableListItemCompactProps {
  table: Table
  isSelected?: boolean
  onClick?: (table: Table) => void
}

export const TableListItemCompact: React.FC<TableListItemCompactProps> = ({
  table,
  isSelected = false,
  onClick,
}) => {
  const relativeTime = formatRelativeTime(table.updated_at)

  const hasMetadata = relativeTime || (table.row_count !== undefined && table.row_count > 0)

  return (
    <div
      onClick={() => onClick?.(table)}
      className={`group relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
        isSelected
          ? 'bg-accent/15 text-foreground'
          : 'hover:bg-muted/20 text-foreground'
      }`}
    >
      <span className="text-body leading-none shrink-0">
        {table.icon || '📄'}
      </span>

      <span className={`min-w-0 flex-1 truncate text-body ${isSelected ? 'font-medium text-foreground' : 'text-foreground'}`}>
        {table.name}
      </span>

      <div className="shrink-0 flex items-center gap-1.5">
        {table.is_archived && (
          <span title={t('tableListItemCompact.archived')}>
            <Archive className="h-3 w-3 text-muted-foreground/60" />
          </span>
        )}
        {hasMetadata && (
          <span className="text-caption text-muted-foreground/60 whitespace-nowrap">
            {relativeTime}
            {relativeTime && table.row_count !== undefined && table.row_count > 0 && ' · '}
            {table.row_count !== undefined && table.row_count > 0 && t('tableListItemCompact.rowsCount', { count: table.row_count })}
          </span>
        )}
      </div>
    </div>
  )
}
