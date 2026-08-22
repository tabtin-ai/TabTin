/**
 * RecordHistoryDialog - 记录变更历史对话框
 *
 * 展示单条记录 / 表格范围的操作历史（创建/更新/删除），支持：
 * - 字段类型图标与名称
 * - 字段类型感知的值渲染（select 标签、checkbox、日期格式化等）
 * - 展开查看字段级 diff
 * - 加载更多分页
 *
 * 提供字段级 diff、分页加载与类型感知值渲染的展示体验。
 */

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { Button } from '../button'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import { FieldTypeIcon as FieldTypeIconBase } from '../common/field-type-icon'
import { formatSmartTime } from '../../utils/time'
import { ScrollArea } from '../scroll-area'
import {
  areHistoryValuesEqual,
  SYSTEM_MANAGED_HISTORY_FIELD_TYPES,
} from './history-utils'

// ── Types ──

export interface HistoryOperationUser {
  id: number | null
  name: string
}

export interface FieldChange {
  old: unknown
  new: unknown
}

export interface HistoryOperationItem {
  field_key: string
  field_name?: string | null
  field_type?: string | null
  before: unknown
  after: unknown
}

export interface HistoryOperation {
  id: string
  record_id: string
  action: 'create' | 'update' | 'delete' | 'restore'
  action_display: string
  field_changes: Record<string, FieldChange>
  items?: HistoryOperationItem[]
  user: HistoryOperationUser | null
  created_at: string
  is_undone: boolean
  undone_at: string | null
  undone_by: HistoryOperationUser | null
  operation_group_id: string | null
  editor_type?: 'user' | 'human' | 'agent' | 'system'
  agent_run_id?: string | null
}

export interface RecordHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recordId: string
  recordLabel: string
  /** 变更操作列表 */
  operations: HistoryOperation[]
  /** 总操作数 */
  total: number
  /** 是否正在加载 */
  loading?: boolean
  /** 加载更多回调 */
  onLoadMore?: () => void
  /** 字段 ID → 显示名称的映射 */
  fieldNameMap?: Record<string, string>
  /** 字段 ID → 字段类型的映射（用于类型感知渲染） */
  fieldTypeMap?: Record<string, string>
  /** 字段 ID → 选项列表（用于 select/multi_select 标签渲染） */
  fieldChoicesMap?: Record<string, string[]>
}

// ── Sub-components ──

/** Adapter: wraps common FieldTypeIcon to keep the existing `fieldType` prop interface */
function FieldTypeIcon({ fieldType, className }: { fieldType?: string; className?: string }) {
  return <FieldTypeIconBase type={fieldType} size={14} className={className} />
}


const ACTION_STYLES: Record<string, string> = {
  create: 'bg-success/20 text-success',
  update: 'bg-info/20 text-info',
  delete: 'bg-destructive/10 text-destructive',
  restore: 'bg-accent/20 text-accent',
}

const KNOWN_ACTIONS = new Set(['create', 'update', 'delete', 'restore'])

function ActionBadge({ action, display }: { action: string; display: string }) {
  const label = KNOWN_ACTIONS.has(action)
    ? t(`recordHistoryDialog.action.${action}`)
    : (display || action)
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-body font-medium',
        ACTION_STYLES[action] || 'bg-muted text-muted-foreground'
      )}
    >
      {label}
    </span>
  )
}

function UndoneTag() {
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-body font-medium bg-warning/20 text-warning">
      {t('recordHistoryDialog.status.undone')}
    </span>
  )
}

// ── Select badge 色板（稳定 hash 映射） ──

const SELECT_BADGE_COLORS = [
  'bg-info/20 text-info',
  'bg-success/20 text-success',
  'bg-accent/20 text-accent',
  'bg-warning/20 text-warning',
  'bg-type-webhook/20 text-type-webhook',
  'bg-primary/20 text-primary',
  'bg-warning/20 text-warning',
  'bg-destructive/20 text-destructive',
]

function stableColorIndex(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % SELECT_BADGE_COLORS.length
}

function SelectBadge({ value }: { value: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-body font-medium', SELECT_BADGE_COLORS[stableColorIndex(value)])}>
      {value}
    </span>
  )
}

// ── 字段类型感知值渲染 ──

function CellValueDisplay({ value, fieldType }: { value: unknown; fieldType?: string }) {
  // null / undefined
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/60 italic">-</span>
  }

  // empty string
  if (typeof value === 'string' && value.trim() === '') {
    return <span className="text-muted-foreground/60 italic">-</span>
  }

  switch (fieldType) {
    case 'checkbox': {
      const checked = value === true || value === 'true' || value === 1
      return (
        <span className={cn('inline-flex items-center gap-1 text-body font-medium', checked ? 'text-success' : 'text-muted-foreground')}>
          {checked ? '✓' : '✗'}
        </span>
      )
    }

    case 'select':
    case 'single_select': {
      const str = typeof value === 'string' ? value : String(value)
      return <SelectBadge value={str} />
    }

    case 'multi_select': {
      const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [String(value)]
      return (
        <span className="inline-flex flex-wrap gap-1">
          {items.map((item, i) => <SelectBadge key={`${item}-${i}`} value={String(item)} />)}
        </span>
      )
    }

    case 'date': {
      const str = typeof value === 'string' ? value : String(value)
      try {
        const d = new Date(str)
        if (!Number.isNaN(d.getTime())) {
          return <span className="tabular-nums">{d.toLocaleDateString()}</span>
        }
      } catch { /* fallthrough */ }
      return <span>{str}</span>
    }

    case 'number': {
      const num = typeof value === 'number' ? value : Number(value)
      if (!Number.isNaN(num)) {
        return <span className="tabular-nums font-mono">{num.toLocaleString()}</span>
      }
      return <span>{String(value)}</span>
    }

    case 'url': {
      const str = typeof value === 'string' ? value : String(value)
      return (
        <span className="text-info underline underline-offset-2 break-all" title={str}>
          {str.length > 60 ? str.slice(0, 57) + '...' : str}
        </span>
      )
    }

    case 'email': {
      const str = typeof value === 'string' ? value : String(value)
      return <span className="text-info break-all">{str}</span>
    }

    case 'attachment':
    {
      if (Array.isArray(value)) {
        const names = value.map((item: any) => item?.name || item?.file_id || '?').join(', ')
        return (
          <span className="inline-flex items-center gap-1">
            <FieldTypeIcon fieldType={fieldType as any} className="opacity-60" />
            <span className="truncate" title={names}>{names || '-'}</span>
          </span>
        )
      }
      return <span>{String(value)}</span>
    }

    default: {
      // Generic fallback — try to render as string
      if (typeof value === 'string') return <span className="break-all">{value}</span>
      if (typeof value === 'number') return <span className="tabular-nums">{value}</span>
      if (typeof value === 'boolean') return <span>{value ? 'true' : 'false'}</span>
      // Complex objects — compact JSON
      try {
        const json = JSON.stringify(value)
        if (json.length > 120) {
          return <span className="break-all font-mono text-caption" title={json}>{json.slice(0, 117)}...</span>
        }
        return <span className="break-all font-mono text-caption">{json}</span>
      } catch {
        return <span>{String(value)}</span>
      }
    }
  }
}

// ── Main Component ──

function normalizeOperationChanges(
  op: HistoryOperation,
  fieldTypeMap: Record<string, string>,
): NormalizedHistoryChange[] {
  const rawChanges: NormalizedHistoryChange[] = op.items && op.items.length > 0
    ? op.items.map((item) => ({
        fieldId: item.field_key,
        fieldName: item.field_name,
        fieldType: item.field_type ?? fieldTypeMap[item.field_key],
        old: item.before,
        new: item.after,
      }))
    : Object.entries(op.field_changes).map(([fieldId, change]) => ({
        fieldId,
        fieldType: fieldTypeMap[fieldId],
        old: change?.old,
        new: change?.new,
      }))

  return rawChanges.filter((change) => {
    if (change.fieldType && SYSTEM_MANAGED_HISTORY_FIELD_TYPES.has(change.fieldType)) {
      return false
    }
    return !areHistoryValuesEqual(change.old, change.new)
  })
}

export const RecordHistoryDialog: React.FC<RecordHistoryDialogProps> = ({
  open,
  onOpenChange,
  recordLabel,
  operations,
  total,
  loading = false,
  onLoadMore,
  fieldNameMap = {},
  fieldTypeMap = {},
  fieldChoicesMap: _fieldChoicesMap = {},
}) => {
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  const hasMore = operations.length < total
  const visibleOperations = React.useMemo(
    () => operations
      .map((op) => ({
        op,
        normalizedChanges: normalizeOperationChanges(op, fieldTypeMap),
      }))
      .filter(({ op, normalizedChanges }) => op.action !== 'update' || normalizedChanges.length > 0),
    [fieldTypeMap, operations],
  )

  const resolveFieldName = (fieldId: string): string => {
    if (fieldId === '_deleted') return t('recordHistoryDialog.systemField.deleted')
    return fieldNameMap[fieldId] || t('recordHistoryDialog.deletedField')
  }

  const resolveFieldType = (fieldId: string): string | undefined => {
    return fieldTypeMap[fieldId]
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('recordHistoryDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('recordHistoryDialog.description', { record: recordLabel })}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          {loading && operations.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-body text-muted-foreground">
              {t('recordHistoryDialog.loading')}
            </div>
          ) : visibleOperations.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-body text-muted-foreground">
              {t('recordHistoryDialog.empty')}
            </div>
          ) : (
            <div className="space-y-1">
              {/* 表头 */}
              <div className="grid grid-cols-[80px_1fr_100px_120px] gap-2 px-3 py-2 text-body font-medium text-muted-foreground border-b sticky top-0 bg-background z-sticky">
                <span>{t('recordHistoryDialog.column.action')}</span>
                <span>{t('recordHistoryDialog.column.changes')}</span>
                <span>{t('recordHistoryDialog.column.user')}</span>
                <span>{t('recordHistoryDialog.column.time')}</span>
              </div>

              {/* 操作列表 */}
              {visibleOperations.map(({ op, normalizedChanges }) => {
                const changesCount = normalizedChanges.length

                return (
                  <div key={op.id}>
                    <button
                      type="button"
                      aria-expanded={expandedId === op.id}
                      aria-label={`${op.action_display || op.action} — ${op.user?.name || ''} ${formatSmartTime(op.created_at)}`}
                      className={cn(
                        'grid grid-cols-[80px_1fr_100px_120px] gap-2 w-full px-3 py-2 text-body text-left',
                        'hover:bg-muted/50 rounded transition-colors',
                        expandedId === op.id && 'bg-muted/30'
                      )}
                      onClick={() =>
                        setExpandedId((prev) =>
                          prev === op.id ? null : op.id
                        )
                      }
                    >
                      <span className="flex items-center gap-1">
                        <ActionBadge action={op.action} display={op.action_display} />
                        {op.is_undone && <UndoneTag />}
                      </span>
                      <span className="text-body text-muted-foreground truncate">
                        {changesCount > 0
                          ? t('recordHistoryDialog.changesCount', { count: String(changesCount) })
                          : '-'}
                      </span>
                      <span className="text-body text-muted-foreground truncate">
                        {op.user?.name || '-'}
                      </span>
                      <span className="text-body text-muted-foreground truncate tabular-nums">
                        {formatSmartTime(op.created_at)}
                      </span>
                    </button>

                    {/* 展开详情：字段级差异 */}
                    {expandedId === op.id && (
                      <div className="mx-3 mb-2 rounded border border-border/60 bg-muted/10 p-3 text-body space-y-2" role="region" aria-label={t('recordHistoryDialog.column.changes')}>
                        {changesCount > 0 ? (
                          <div className="space-y-2">
                            {normalizedChanges.map((change) => {
                              const fType = change.fieldType || resolveFieldType(change.fieldId)
                              return (
                                <div
                                  key={`${op.id}:${change.fieldId}`}
                                  className="rounded bg-muted/30 p-2.5"
                                >
                                  {/* 字段名 + 图标 */}
                                  <div className="flex items-center gap-1.5 mb-1.5">
                                    <FieldTypeIcon fieldType={fType} />
                                    <span className="font-medium text-foreground text-body">
                                      {change.fieldName || resolveFieldName(change.fieldId)}
                                    </span>
                                    {fType && (
                                      <span className="text-caption text-muted-foreground/60">
                                        {fType}
                                      </span>
                                    )}
                                  </div>
                                  {/* Before → After */}
                                  <div className="grid grid-cols-[1fr_24px_1fr] gap-1 items-start">
                                    <div className="min-w-0 rounded bg-destructive/5 px-2 py-1.5 border border-destructive/10">
                                      <CellValueDisplay value={change.old} fieldType={fType} />
                                    </div>
                                    <div className="flex items-center justify-center pt-1">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/60" aria-hidden="true">
                                        <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                                      </svg>
                                    </div>
                                    <div className="min-w-0 rounded bg-success/5 px-2 py-1.5 border border-success/10">
                                      <CellValueDisplay value={change.new} fieldType={fType} />
                                    </div>
                                </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            {t('recordHistoryDialog.noFieldChanges')}
                          </span>
                        )}

                        {/* 元信息 */}
                        <div className="flex gap-4 text-muted-foreground pt-1 border-t border-border/30">
                          <span>ID: {op.id.slice(0, 12)}...</span>
                          {op.operation_group_id && (
                            <span>Group: {op.operation_group_id.slice(0, 8)}...</span>
                          )}
                          {op.is_undone && op.undone_at && (
                            <span>
                              {t('recordHistoryDialog.undoneAt', {
                                time: formatSmartTime(op.undone_at),
                                user: op.undone_by?.name || '-',
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* 加载更多 */}
              {hasMore && onLoadMore && (
                <div className="flex justify-center py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onLoadMore}
                    disabled={loading}
                  >
                    {loading
                      ? t('recordHistoryDialog.loading')
                      : t('recordHistoryDialog.loadMore')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <span className="text-body text-muted-foreground">
            {t('recordHistoryDialog.total', { count: String(total) })}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('recordHistoryDialog.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type NormalizedHistoryChange = {
  fieldId: string
  fieldName?: string | null
  fieldType?: string | null
  old: unknown
  new: unknown
}

// ── Inline Panel Component (embeddable, no Dialog wrapper) ──

export interface RecordHistoryPanelProps {
  operations: HistoryOperation[]
  total: number
  loading?: boolean
  onLoadMore?: () => void
  fieldNameMap?: Record<string, string>
  fieldTypeMap?: Record<string, string>
}

/**
 * RecordHistoryPanel - 内嵌式历史面板
 *
 * 不含 Dialog 包裹，可直接嵌入 RecordFormDialog 等容器中，
 * 配合 recordHistoryVisible 模式在详情侧栏内嵌展示。
 */
export const RecordHistoryPanel: React.FC<RecordHistoryPanelProps> = ({
  operations,
  total,
  loading = false,
  onLoadMore,
  fieldNameMap = {},
  fieldTypeMap = {},
}) => {
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  // IntersectionObserver for infinite scroll
  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !onLoadMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry?.isIntersecting && !loading && operations.length < total) {
          onLoadMore()
        }
      },
      { rootMargin: '100px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [onLoadMore, loading, operations.length, total])

  const hasMore = operations.length < total
  const visibleOperations = React.useMemo(
    () => operations
      .map((op) => ({
        op,
        normalizedChanges: normalizeOperationChanges(op, fieldTypeMap),
      }))
      .filter(({ op, normalizedChanges }) => op.action !== 'update' || normalizedChanges.length > 0),
    [fieldTypeMap, operations],
  )

  const resolveFieldName = (fieldId: string): string => {
    if (fieldId === '_deleted') return t('recordHistoryDialog.systemField.deleted')
    return fieldNameMap[fieldId] || t('recordHistoryDialog.deletedField')
  }

  const resolveFieldType = (fieldId: string): string | undefined => {
    return fieldTypeMap[fieldId]
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <ScrollArea className="flex-1">
        {loading && operations.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-body text-muted-foreground">
            {t('recordHistoryDialog.loading')}
          </div>
        ) : visibleOperations.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-body text-muted-foreground">
            {t('recordHistoryDialog.empty')}
          </div>
        ) : (
          <div className="space-y-1">
            {/* 表头 */}
            <div className="grid grid-cols-[80px_1fr_100px_120px] gap-2 px-3 py-2 text-body font-medium text-muted-foreground border-b sticky top-0 bg-background z-sticky">
              <span>{t('recordHistoryDialog.column.action')}</span>
              <span>{t('recordHistoryDialog.column.changes')}</span>
              <span>{t('recordHistoryDialog.column.user')}</span>
              <span>{t('recordHistoryDialog.column.time')}</span>
            </div>

            {visibleOperations.map(({ op, normalizedChanges }) => {
              const changesCount = normalizedChanges.length

              return (
                <div key={op.id}>
                  <button
                    type="button"
                    aria-expanded={expandedId === op.id}
                    aria-label={`${op.action_display || op.action} — ${op.user?.name || ''} ${formatSmartTime(op.created_at)}`}
                    className={cn(
                      'grid grid-cols-[80px_1fr_100px_120px] gap-2 w-full px-3 py-2 text-body text-left',
                      'hover:bg-muted/50 rounded transition-colors',
                      expandedId === op.id && 'bg-muted/30'
                    )}
                    onClick={() =>
                      setExpandedId((prev) =>
                        prev === op.id ? null : op.id
                      )
                    }
                  >
                    <span className="flex items-center gap-1">
                      <ActionBadge action={op.action} display={op.action_display} />
                      {op.is_undone && <UndoneTag />}
                    </span>
                    <span className="text-body text-muted-foreground truncate">
                      {changesCount > 0
                        ? t('recordHistoryDialog.changesCount', { count: String(changesCount) })
                        : '-'}
                    </span>
                    <span className="text-body text-muted-foreground truncate">
                      {op.user?.name || '-'}
                    </span>
                    <span className="text-body text-muted-foreground truncate tabular-nums">
                      {formatSmartTime(op.created_at)}
                    </span>
                  </button>

                  {expandedId === op.id && (
                    <div className="mx-3 mb-2 rounded border border-border/60 bg-muted/10 p-3 text-body space-y-2" role="region" aria-label={t('recordHistoryDialog.column.changes')}>
                      {changesCount > 0 ? (
                        <div className="space-y-2">
                          {normalizedChanges.map((change) => {
                            const fType = change.fieldType || resolveFieldType(change.fieldId)
                            return (
                              <div
                                key={`${op.id}:${change.fieldId}`}
                                className="rounded bg-muted/30 p-2.5"
                              >
                                <div className="flex items-center gap-1.5 mb-1.5">
                                  <FieldTypeIcon fieldType={fType} />
                                  <span className="font-medium text-foreground text-body">
                                    {change.fieldName || resolveFieldName(change.fieldId)}
                                  </span>
                                </div>
                                <div className="grid grid-cols-[1fr_24px_1fr] gap-1 items-start">
                                  <div className="min-w-0 rounded bg-destructive/5 px-2 py-1.5 border border-destructive/10">
                                    <CellValueDisplay value={change.old} fieldType={fType} />
                                  </div>
                                  <div className="flex items-center justify-center pt-1">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/60" aria-hidden="true">
                                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                                    </svg>
                                  </div>
                                  <div className="min-w-0 rounded bg-success/5 px-2 py-1.5 border border-success/10">
                                    <CellValueDisplay value={change.new} fieldType={fType} />
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          {t('recordHistoryDialog.noFieldChanges')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Infinite scroll sentinel */}
            {hasMore && (
              <div ref={sentinelRef} className="flex justify-center py-3">
                {loading && (
                  <span className="text-body text-muted-foreground">{t('recordHistoryDialog.loading')}</span>
                )}
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      <div className="flex items-center justify-between px-3 py-2 border-t text-body text-muted-foreground">
        <span>{t('recordHistoryDialog.total', { count: String(total) })}</span>
      </div>
    </div>
  )
}
