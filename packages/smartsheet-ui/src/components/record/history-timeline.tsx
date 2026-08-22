/**
 * HistoryTimeline — 时间线分组展示历史变更
 *
 * 设计模式：
 * - 可折叠日期分组（Collapsible）
 * - 用户头像 + 名称
 * - "当前" 标记
 * - 时间线连接线（CSS ::before）
 * - 精致的空状态
 * - ScrollArea 平滑滚动
 *
 * 同时保留多维表格特有的字段级变更内联展示。
 */

import * as React from 'react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import type { HistoryOperation } from './record-history-dialog'
import type { HistoryGroup, NormalizedChange, TimeSection } from './history-utils'
import {
  groupOperations,
  groupByTimeSection,
  formatTimeRange,
  resolveHistoryFieldName,
  resolveHistoryFieldType,
} from './history-utils'
import { FieldTypeIcon as FieldTypeIconBase } from '../common/field-type-icon'
import { UserAvatar } from '../common/user-avatar'
import { EmptyState } from '../common/empty-state'
import { LoadingSpinner } from '../loading-spinner'
import { compactCellValue } from '../../utils/cell-value'
import { Bot } from 'lucide-react'

/** Adapter: wraps common FieldTypeIcon for the local `fieldType` prop interface */
function FieldTypeIcon({ fieldType }: { fieldType?: string }) {
  return <FieldTypeIconBase type={fieldType} size={12} />
}

// ── Compact value renderer ──

function CompactValue({ value }: { value: unknown }) {
  const display = compactCellValue(value, { maxLen: 30 })
  if (display === '-' || display === '') {
    return <span className="text-muted-foreground/40 italic">{t('historyTimeline.empty')}</span>
  }
  return <span className="break-all">{display}</span>
}

// ── Action dot colors ──

const ACTION_DOT_COLORS: Record<string, string> = {
  create: 'bg-success',
  update: 'bg-info',
  delete: 'bg-destructive',
  restore: 'bg-warning',
}

// ── Chevron icon ──

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        'shrink-0 transition-transform duration-200',
        collapsed ? '' : 'rotate-90',
      )}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

// ── HistoryTimeline Props ──

export interface HistoryTimelineProps {
  operations: HistoryOperation[]
  total: number
  loading?: boolean
  onLoadMore?: () => void
  fieldNameMap?: Record<string, string>
  fieldTypeMap?: Record<string, string>
  /** 点击某个分组时的回调（用于高亮单元格和快照预览） */
  onGroupClick?: (group: HistoryGroup) => void
  /** 当前选中的分组 ID */
  activeGroupId?: string | null
  /** 当前语言 locale（如 'zh-CN'、'en-US'），影响日期分段和时间格式化 */
  locale?: string
}

// ── Change item row ──

const MAX_INLINE_CHANGES = 5

function ChangeCard({
  group,
  fieldNameMap,
  fieldTypeMap,
  isActive,
  isFirstInSection,
  onClick,
  locale,
}: {
  group: HistoryGroup
  fieldNameMap: Record<string, string>
  fieldTypeMap: Record<string, string>
  isActive: boolean
  isFirstInSection: boolean
  onClick?: () => void
  locale?: string
}) {
  const [expanded, setExpanded] = React.useState(false)
  const visibleChanges = expanded
    ? group.changes
    : group.changes.slice(0, MAX_INLINE_CHANGES)
  const hasMore = group.changes.length > MAX_INLINE_CHANGES

  const fieldNameFor = (change: NormalizedChange): string => {
    if (change.fieldId === '_deleted') return t('historyTimeline.systemField.deleted')
    return resolveHistoryFieldName(
      change,
      fieldNameMap,
      t('historyTimeline.deletedField'),
    )
  }

  return (
    <button
      type="button"
      className={cn(
        'w-full text-left rounded-md p-2.5 transition-all duration-150 cursor-pointer group/card',
        'hover:bg-accent/50',
        isActive
          ? 'bg-primary/8 ring-1 ring-primary/25'
          : 'bg-transparent',
      )}
      onClick={onClick}
    >
      {/* Header: user avatar + name + time */}
      <div className="flex items-center gap-2 mb-1.5">
        <UserAvatar name={group.user?.name || (group.editorType === 'system' ? t('historyTimeline.systemUser') : t('historyTimeline.unknownUser'))} seed={group.user?.id?.toString()} size={22} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-body font-medium text-foreground truncate flex items-center gap-1">
              {group.editorType === 'agent' && (
                <Bot className="h-3 w-3 shrink-0 text-info" />
              )}
              {group.user?.name || (group.editorType === 'system' ? t('historyTimeline.systemUser') : t('historyTimeline.unknownUser'))}
            </span>
            {isActive && (
              <span className="text-caption px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">
                {t('historyTimeline.current') || 'Current'}
              </span>
            )}
            {group.hasUndone && (
              <span className="text-caption px-1.5 py-0.5 rounded-full bg-warning/20 text-warning">
                {t('historyTimeline.undone')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <span className="tabular-nums">
              {formatTimeRange(group.startTime, group.endTime, locale)}
            </span>
            {group.count > 1 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span>{t('historyTimeline.opCount', { count: String(group.count) })}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Field changes (inline) */}
      {visibleChanges.length > 0 ? (
        <div className="space-y-1 ml-[30px]">
          {visibleChanges.map((change: NormalizedChange) => (
            <div key={change.fieldId} className="flex items-start gap-1.5 text-caption leading-relaxed">
              <div className="flex items-center gap-1 shrink-0 text-muted-foreground/80 max-w-[100px]">
                <FieldTypeIcon fieldType={resolveHistoryFieldType(change, fieldTypeMap)} />
                <span className="truncate font-medium" title={fieldNameFor(change)}>
                  {fieldNameFor(change)}
                </span>
              </div>
              <div className="flex items-center gap-1 min-w-0 flex-1">
                <span className="text-destructive/60 line-through truncate max-w-[80px]">
                  <CompactValue value={change.old} />
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-muted-foreground/30" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                </svg>
                <span className="text-success truncate max-w-[80px]">
                  <CompactValue value={change.new} />
                </span>
              </div>
            </div>
          ))}

          {hasMore && !expanded && (
            <button
              type="button"
              className="text-caption text-primary/60 hover:text-primary transition-colors pl-0"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(true)
              }}
            >
              {t('historyTimeline.showMore', {
                count: String(group.changes.length - MAX_INLINE_CHANGES),
              })}
            </button>
          )}
        </div>
      ) : (
        <div className="text-caption text-muted-foreground/40 italic ml-[30px]">
          {t('historyTimeline.noChanges')}
        </div>
      )}
    </button>
  )
}

// ── Collapsible day group ──

function DayGroup({
  section,
  groups,
  fieldNameMap,
  fieldTypeMap,
  activeGroupId,
  onGroupClick,
  defaultExpanded = true,
  locale,
}: {
  section: TimeSection
  groups: HistoryGroup[]
  fieldNameMap: Record<string, string>
  fieldTypeMap: Record<string, string>
  activeGroupId: string | null | undefined
  onGroupClick?: (group: HistoryGroup) => void
  defaultExpanded?: boolean
  locale?: string
}) {
  const [collapsed, setCollapsed] = React.useState(!defaultExpanded)

  return (
    <div className="mb-1">
      {/* Collapsible trigger — day label */}
      <button
        type="button"
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-md w-full text-left',
          'text-caption font-semibold text-muted-foreground uppercase tracking-wider',
          'hover:bg-accent/30 transition-colors',
        )}
        onClick={() => setCollapsed(c => !c)}
      >
        <ChevronIcon collapsed={collapsed} />
        <span>{section.label}</span>
        <span className="text-muted-foreground/40 font-normal normal-case">
          ({groups.length})
        </span>
      </button>

      {/* Collapsible content with timeline line */}
      {!collapsed && (
        <div
          className="relative pl-6 ml-2 mt-1"
          style={{
            // Timeline connector line via box-shadow trick (cleaner than ::before in CSS-in-JS)
          }}
        >
          {/* Timeline vertical line */}
          <div
            className="absolute top-0 bottom-0 w-px bg-border"
            style={{ left: '11px' }}
          />

          <div className="space-y-1">
            {groups.map((group, idx) => (
              <div key={group.id} className="relative">
                {/* Timeline dot */}
                <div
                  className={cn(
                    'absolute -left-6 top-3 w-2.5 h-2.5 rounded-full border-2 border-background z-sticky',
                    activeGroupId === group.id
                      ? 'ring-2 ring-primary/30'
                      : '',
                    ACTION_DOT_COLORS[group.action] || 'bg-muted-foreground',
                  )}
                  style={{ left: '-19px' }}
                />
                <ChangeCard
                  group={group}
                  fieldNameMap={fieldNameMap}
                  fieldTypeMap={fieldTypeMap}
                  isActive={activeGroupId === group.id}
                  isFirstInSection={idx === 0}
                  onClick={() => onGroupClick?.(group)}
                  locale={locale}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Component ──

export const HistoryTimeline: React.FC<HistoryTimelineProps> = ({
  operations,
  total,
  loading = false,
  onLoadMore,
  fieldNameMap = {},
  fieldTypeMap = {},
  onGroupClick,
  activeGroupId,
  locale,
}) => {
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  // Group and merge
  const groups = React.useMemo(() => groupOperations(operations), [operations])
  const sections = React.useMemo(() => groupByTimeSection(groups, locale), [groups, locale])

  // Infinite scroll
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
      { rootMargin: '200px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [onLoadMore, loading, operations.length, total])

  const hasMore = operations.length < total

  // Loading state
  if (loading && operations.length === 0) {
    return (
      <LoadingSpinner size="sm" text={t('historyTimeline.loading')} className="py-16" />
    )
  }

  // Empty state
  if (operations.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title={t('historyTimeline.emptyTitle') || t('historyTimeline.empty')}
        description={t('historyTimeline.emptyDescription') || '编辑表格后，变更历史将在此显示'}
        size="lg"
      />
    )
  }

  return (
    <div className="space-y-1">
      {sections.map((section, sIdx) => (
        <DayGroup
          key={section.label}
          section={section}
          groups={section.groups}
          fieldNameMap={fieldNameMap}
          fieldTypeMap={fieldTypeMap}
          activeGroupId={activeGroupId}
          onGroupClick={onGroupClick}
          defaultExpanded={sIdx < 3}
          locale={locale}
        />
      ))}

      {/* Load more sentinel / button */}
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-3">
          {loading ? (
            <LoadingSpinner size="xs" text={t('historyTimeline.loading')} inline textClassName="text-body" />
          ) : (
            <button
              type="button"
              className="text-body text-muted-foreground hover:text-foreground transition-colors"
              onClick={onLoadMore}
            >
              {t('historyTimeline.loadMore') || '加载更多'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
