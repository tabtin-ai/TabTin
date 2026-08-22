import React, { useCallback, useMemo } from 'react'
import { MessageSquare } from 'lucide-react'
import type { ViewRecordsResponse } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@/utils/i18n/format'
import { useRecordCommentCounts } from '@components/table/hooks/useRecordCommentCounts'
import { useTableCollab } from '@components/table/TableCollabContext'
import { cn } from '@utils/cn'

const RecordCommentCountContext = React.createContext<Record<string, number>>({})
const RecordCommentOpenContext = React.createContext<((recordId: string) => void) | null>(null)

function resolveRecordId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = record.id ?? record._id ?? record.__id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function appendRecordIds(ids: Set<string>, records: unknown): void {
  if (!Array.isArray(records)) return
  for (const item of records) {
    const wrapper =
      item && typeof item === 'object' ? (item as Record<string, unknown>).record : undefined
    const recordId = resolveRecordId(wrapper ?? item)
    if (recordId) ids.add(recordId)
  }
}

/**
 * 统一提取当前视图已经装载的记录 ID。
 *
 * 普通/画册/闪卡记录位于 records；日历 records 是 occurrence wrapper；
 * 看板分组增量加载还会把记录放在 metadata.groups[].records。
 */
export function collectViewRecordIds(viewRecords: ViewRecordsResponse | null): string[] {
  if (!viewRecords) return []
  const ids = new Set<string>()
  appendRecordIds(ids, viewRecords.records)

  const groups = viewRecords.metadata?.groups
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      appendRecordIds(ids, (group as Record<string, unknown>).records)
    }
  }

  return [...ids]
}

export const ViewRecordCommentCountsProvider: React.FC<{
  tableId: string | null
  viewRecords: ViewRecordsResponse | null
  enabled: boolean
  onOpenRecordComments?: (recordId: string) => void
  children: React.ReactNode
}> = ({ tableId, viewRecords, enabled, onOpenRecordComments, children }) => {
  const { collabBridge } = useTableCollab()
  const collab = collabBridge.collab
  const recordIds = useMemo(() => collectViewRecordIds(viewRecords), [viewRecords])
  const subscribeCommentChanges = useCallback(
    (onChange: () => void) => collab.onStatelessEvent('table.comment.changed', onChange),
    [collab],
  )
  const { counts } = useRecordCommentCounts({
    tableId,
    recordIds,
    enabled,
    subscribe: subscribeCommentChanges,
  })

  return (
    <RecordCommentCountContext.Provider value={counts}>
      <RecordCommentOpenContext.Provider value={onOpenRecordComments ?? null}>
        {children}
      </RecordCommentOpenContext.Provider>
    </RecordCommentCountContext.Provider>
  )
}

export const RecordCommentCountBadge: React.FC<{
  recordId: string | null | undefined
  className?: string
}> = ({ recordId, className }) => {
  const counts = React.useContext(RecordCommentCountContext)
  const openRecordComments = React.useContext(RecordCommentOpenContext)
  const { t } = useTranslation('view')
  const count = recordId ? (counts[recordId] ?? 0) : 0
  if (count <= 0) return null

  const label = String(t('comments.count', { count }))
  const content = (
    <>
      <MessageSquare className="size-3" aria-hidden />
      <span className="tabular-nums">{formatNumber(count)}</span>
    </>
  )

  if (recordId && openRecordComments) {
    return (
      <button
        type="button"
        className={cn(
          'inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-caption font-medium leading-none text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          className,
        )}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation()
          openRecordComments(recordId)
        }}
      >
        {content}
      </button>
    )
  }

  return (
    <span
      className={cn(
        'pointer-events-none inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-caption font-medium leading-none text-muted-foreground',
        className,
      )}
      aria-label={label}
      title={label}
    >
      {content}
    </span>
  )
}
