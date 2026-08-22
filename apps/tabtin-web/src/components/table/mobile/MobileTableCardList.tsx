import React from 'react'
import { ChevronDown, ChevronRight, ImageIcon, Plus } from 'lucide-react'
import type { Field, TableRecord, ViewMeta } from '@tabtin/table-core'
import type { TableGridRow } from '@tabtin/table-engine'
import { cn } from '@tabtin/smartsheet-ui'
import { projectMobileTableItems } from './mobileTableProjection'

export interface MobileTableCardListProps {
  rows: readonly TableGridRow[]
  records: readonly TableRecord[]
  fields: Field[]
  currentView: ViewMeta | null
  isLoading: boolean
  isReadonly: boolean
  emptyTitle: string
  emptyDescription: string
  addRecordLabel: string
  ungroupedLabel: string
  untitledRecordLabel: string
  currentSearchRecordId?: string
  userDisplayNameById?: ReadonlyMap<string, string>
  isTablet?: boolean
  onOpenRecord: (recordId: string) => void
  onToggleGroup: (groupId: string) => void
  onAddRecord: (groupValues?: Record<string, unknown>) => void
}

export const MobileTableCardList: React.FC<MobileTableCardListProps> = ({
  rows,
  records,
  fields,
  currentView,
  isLoading,
  isReadonly,
  emptyTitle,
  emptyDescription,
  addRecordLabel,
  ungroupedLabel,
  untitledRecordLabel,
  currentSearchRecordId,
  userDisplayNameById,
  isTablet = false,
  onOpenRecord,
  onToggleGroup,
  onAddRecord,
}) => {
  const items = React.useMemo(
    () => projectMobileTableItems({
      rows,
      records,
      fields,
      currentView,
      userDisplayNameById,
      ungroupedLabel,
      untitledRecordLabel,
    }),
    [currentView, fields, records, rows, ungroupedLabel, untitledRecordLabel, userDisplayNameById],
  )
  if (isLoading) {
    return (
      <div
        className={cn('grid grid-cols-1 gap-3 px-3 py-4', isTablet && 'sm:grid-cols-2')}
        aria-busy="true"
      >
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-36 animate-pulse rounded-2xl border border-border/50 bg-muted/40"
          />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-8 py-16 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <ImageIcon className="size-5" />
        </div>
        <h2 className="text-title font-semibold text-foreground">{emptyTitle}</h2>
        <p className="mt-1 max-w-xs text-body text-muted-foreground">{emptyDescription}</p>
        {!isReadonly ? (
          <button
            type="button"
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-body font-medium text-primary-foreground shadow-sm"
            onClick={() => onAddRecord()}
          >
            <Plus className="size-4" />
            {addRecordLabel}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-2 px-2.5 py-3 pb-[max(88px,calc(env(safe-area-inset-bottom)+72px))]',
        isTablet && 'sm:grid-cols-2 sm:gap-3 sm:px-3',
      )}
      style={{
        paddingLeft: 'max(0.625rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.625rem, env(safe-area-inset-right))',
      }}
      data-table-card-layout={isTablet ? 'tablet' : 'phone'}
    >
      {items.map((item) => {
        if (item.kind === 'group') {
          return (
            <div
              key={`group-${item.id}`}
              className="sticky top-0 z-10 -mx-0.5 flex min-h-11 items-center gap-2 rounded-xl border-b border-border/50 bg-background/95 px-2 py-2 backdrop-blur col-span-full"
              style={{ paddingLeft: `${8 + item.level * 16}px` }}
            >
              <button
                type="button"
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onToggleGroup(item.id)}
                aria-expanded={!item.collapsed}
              >
                {item.collapsed ? (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate text-body font-semibold text-foreground">
                  {item.label}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
                  {item.count}
                </span>
              </button>
              {!isReadonly ? (
                <button
                  type="button"
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-primary transition-colors active:bg-primary/10"
                  onClick={() => onAddRecord(item.groupValues)}
                  aria-label={addRecordLabel}
                  title={addRecordLabel}
                >
                  <Plus className="size-5" />
                </button>
              ) : null}
            </div>
          )
        }

        return (
          <button
            type="button"
            key={item.id}
            data-mobile-record-card={item.id}
            data-search-current={currentSearchRecordId === item.id ? 'true' : undefined}
            className={cn(
              'flex min-h-11 w-full min-w-0 gap-3 rounded-2xl border border-border/55 bg-card p-3 text-left shadow-sm transition-transform active:scale-[0.99] active:bg-muted/20',
              item.treeDepth > 0 && (isTablet
                ? 'ml-3 w-[calc(100%-0.75rem)]'
                : 'ml-5 w-[calc(100%-1.25rem)]'),
              currentSearchRecordId === item.id && 'border-primary/60 ring-2 ring-primary/25',
            )}
            onClick={() => onOpenRecord(item.id)}
          >
            {item.coverUrl ? (
              <img
                src={item.coverUrl}
                alt=""
                className="size-24 shrink-0 rounded-xl border border-border/40 bg-muted object-cover"
                loading="lazy"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <h3 className="line-clamp-2 text-body font-semibold leading-6 text-foreground">
                {item.title}
              </h3>
              {item.fields.length > 0 ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                  {item.fields.map(({ field, displayValue }) => (
                    <div key={field.id} className="min-w-0">
                      <dt className="truncate text-caption text-muted-foreground">{field.name}</dt>
                      <dd
                        className="mt-0.5 truncate text-body text-foreground"
                        title={displayValue}
                      >
                        {displayValue}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </button>
        )
      })}
    </div>
  )
}

MobileTableCardList.displayName = 'MobileTableCardList'
