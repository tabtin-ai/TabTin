/**
 * LinkedRecordsTable — 记录详情内的关联字段内嵌小表
 *
 * 展示已关联记录（标题 + 可选列），支持：
 * - 打开完整详情（复用主字段展开 → 编辑记录侧栏）
 * - 解除关联（不删目标记录）
 * - 添加/选择记录
 */

import * as React from 'react'
import { Maximize2, Plus, X } from 'lucide-react'
import { Button } from '../button'
import { FieldTypeIcon } from '../common/field-type-icon'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import {
  formatLinkRecordLabel,
  resolveLinkGridCellText,
  UNNAMED_RECORD_DISPLAY_NAME,
} from './linkRecordLabel'

export interface LinkedRecordItem {
  id: string
  title?: string
  /** 可选：多列展示用的字段值 */
  fields?: Record<string, unknown>
}

export interface LinkedRecordColumn {
  id: string
  name: string
  field_type: string
  is_primary?: boolean
}

export interface LinkedRecordsTableProps {
  items: LinkedRecordItem[]
  columns?: LinkedRecordColumn[]
  disabled?: boolean
  isSingleSelect?: boolean
  error?: string
  description?: string
  onAdd?: () => void
  onUnlink?: (id: string) => void
  onOpenRecord?: (item: LinkedRecordItem) => void
  className?: string
}

const renderCellValue = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (v && typeof v === 'object' && 'title' in (v as object)) {
          return String((v as { title?: unknown }).title ?? '')
        }
        return renderCellValue(v)
      })
      .filter(Boolean)
      .join(', ')
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (obj.title != null) return String(obj.title)
    if (obj.name != null) return String(obj.name)
  }
  return String(value)
}

export const LinkedRecordsTable: React.FC<LinkedRecordsTableProps> = ({
  items,
  columns = [],
  disabled = false,
  isSingleSelect = false,
  error,
  description,
  onAdd,
  onUnlink,
  onOpenRecord,
  className,
}) => {
  const displayColumns =
    columns.length > 0
      ? columns.slice(0, 4)
      : ([{ id: '__title__', name: t('recordFormDialog.link.titleColumn'), field_type: 'text', is_primary: true }] as LinkedRecordColumn[])

  const canAdd = Boolean(onAdd) && !disabled && !(isSingleSelect && items.length >= 1)

  return (
    <div className={cn('space-y-2', className)}>
      <div className="overflow-hidden rounded-md border bg-background">
        {items.length === 0 ? (
          <div className="px-3 py-3 text-body text-muted-foreground">
            {t('recordFormDialog.link.noRecords')}
          </div>
        ) : (
          <>
            <div className="flex h-8 items-center border-b bg-muted/30 px-2">
              <div className="w-6 shrink-0" />
              {displayColumns.map((col, idx) => (
                <div
                  key={col.id}
                  className={cn(
                    'flex min-w-0 items-center gap-1 truncate px-2 text-caption font-medium text-muted-foreground',
                    idx === 0 ? 'flex-[1.4]' : 'flex-1',
                  )}
                >
                  <FieldTypeIcon type={col.field_type} size={12} className="shrink-0 opacity-70" />
                  <span className="truncate">{col.name}</span>
                </div>
              ))}
              {!disabled && onUnlink && <div className="w-7 shrink-0" />}
            </div>
            <div role="table">
              {items.map((item) => (
                <div
                  key={item.id}
                  role="row"
                  className="group flex h-9 items-center border-b border-border/60 px-2 last:border-b-0 hover:bg-muted/40"
                >
                  <button
                    type="button"
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground',
                      onOpenRecord
                        ? 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                        : 'opacity-0 pointer-events-none',
                    )}
                    title={t('recordFormDialog.link.openRecord')}
                    disabled={!onOpenRecord}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onOpenRecord?.(item)
                    }}
                  >
                    <Maximize2 className="h-3 w-3" />
                  </button>
                  {displayColumns.map((col, idx) => {
                    const untitled = t('recordFormDialog.link.unnamedRecord') || UNNAMED_RECORD_DISPLAY_NAME
                    const value =
                      col.id === '__title__'
                        ? formatLinkRecordLabel(item.id, item.title, untitled)
                        : resolveLinkGridCellText(renderCellValue(item.fields?.[col.id]))
                    return (
                      <div
                        key={col.id}
                        className={cn(
                          'min-w-0 truncate px-2 text-body',
                          idx === 0 ? 'flex-[1.4] font-medium' : 'flex-1 text-muted-foreground',
                        )}
                        title={value}
                      >
                        {value || '—'}
                      </div>
                    )
                  })}
                  {!disabled && onUnlink && (
                    <button
                      type="button"
                      className="flex h-6 w-7 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                      title={t('recordFormDialog.link.unlink')}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onUnlink(item.id)
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {canAdd && (
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
          {t('recordFormDialog.link.selectRecords')}
        </Button>
      )}

      {description && (
        <p className="text-body text-muted-foreground">{description}</p>
      )}
      {error && <p className="text-body text-destructive">{error}</p>}
    </div>
  )
}
