import React from 'react'
import { Button, cn, LoadingSpinner } from '@tabtin/smartsheet-ui'
import { formatFieldDisplayValue, isAttachmentFieldType } from '@tabtin/table-ui'
import type { Field } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@/utils/i18n/format'
import {
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
} from '@/services/openResourceLink'

// ---------------------------------------------------------------------------
// ViewLoadingOverlay — non-grid views loading indicator
// ---------------------------------------------------------------------------

export const ViewLoadingOverlay: React.FC = () => (
  <div className="pointer-events-none absolute inset-0 z-sticky flex items-center justify-center bg-background/60 backdrop-blur-[1px] transition-opacity">
    <div className="flex items-center gap-2 rounded-interactive border border-border/20 bg-background px-4 py-2 [box-shadow:var(--shadow-overlay)]">
      <LoadingSpinner size="sm" inline />
    </div>
  </div>
)

// ---------------------------------------------------------------------------
// CellValue renderer
// ---------------------------------------------------------------------------

const renderCellByFieldType = (
  fieldType: string,
  value: unknown,
  str: string,
  ellipsis: boolean,
  isMultiValue?: boolean,
): React.ReactNode => {
  switch (fieldType) {
    case 'select':
    case 'single_select':
      return (
        <div className={cn('flex gap-1', ellipsis ? 'flex-nowrap overflow-hidden' : 'flex-wrap')}>
          <span
            className="inline-flex h-5 items-center rounded-md bg-secondary px-2 text-body text-secondary-foreground"
            title={str}
          >
            <span className="min-w-0 truncate">{str}</span>
          </span>
        </div>
      )

    case 'multi_select': {
      const items = Array.isArray(value)
        ? value
        : String(value).split(',').map(s => s.trim()).filter(Boolean)
      return (
        <div className={cn('flex gap-1', ellipsis ? 'flex-nowrap overflow-hidden' : 'flex-wrap')}>
          {items.map((v, i) => (
            <span
              key={`${v}-${i}`}
              className="inline-flex h-5 items-center rounded-md bg-secondary px-2 text-body text-secondary-foreground"
              title={String(v)}
            >
              <span className="min-w-0 truncate">{v}</span>
            </span>
          ))}
        </div>
      )
    }

    case 'checkbox': {
      if (isMultiValue && Array.isArray(value)) {
        return (
          <div className="flex gap-1 flex-wrap">
            {value.map((v, i) => (
              <svg key={i} className={cn('size-4', v ? 'text-success' : 'text-muted-foreground/40')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={v ? 2.5 : 2}>
                {v
                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  : <rect x="3" y="3" width="18" height="18" rx="3" />}
              </svg>
            ))}
          </div>
        )
      }
      return (
        <div className="flex gap-1 flex-wrap">
          {value ? (
            <svg className="size-5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="size-5 text-muted-foreground/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="3" width="18" height="18" rx="3" />
            </svg>
          )}
        </div>
      )
    }

    case 'rating': {
      if (isMultiValue && Array.isArray(value)) {
        return (
          <div className={cn('flex gap-1', ellipsis ? 'flex-nowrap overflow-hidden' : 'flex-wrap')}>
            {value.map((v, i) => (
              <span key={i} className="text-body leading-5 tabular-nums text-warning">{`★${v}`}</span>
            ))}
          </div>
        )
      }
      const numVal = typeof value === 'number' ? value : Number(value)
      if (!Number.isNaN(numVal) && numVal > 0) {
        return (
          <div className="flex gap-0.5">
            {Array.from({ length: Math.min(numVal, 10) }, (_, i) => (
              <svg key={i} className="size-4 text-warning" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            ))}
          </div>
        )
      }
      return <span className="text-body leading-5 text-muted-foreground">{str || '—'}</span>
    }

    case 'url': {
      const isSafeHref = /^https?:\/\//i.test(str) || /^mailto:/i.test(str)
      // W8 L29 / L77：URL 单元格走 ResourceRouter（D1 一视同仁；非 http(s)/mailto
      // 的非法 href 仍渲染但 href 留空 + onClick guard，与 W8 前行为一致）
      return (
        <div className="w-full overflow-hidden" style={ellipsis ? { textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : undefined}>
          <a
            href={isSafeHref ? str : undefined}
            className={cn(
              'text-body leading-5 text-accent hover:underline hover:underline-offset-2',
              !ellipsis && 'break-all',
              ellipsis && 'truncate'
            )}
            title={str}
            onClick={(e) => {
              e.stopPropagation()
              if (isSafeHref) handleResourceLinkClick(e, str)
            }}
            onContextMenu={(e) => {
              if (isSafeHref) handleResourceLinkContextMenu(e, str)
            }}
          >
            {str}
          </a>
        </div>
      )
    }

    case 'number':
      return ellipsis ? (
        <div className="w-full overflow-hidden text-body leading-5 tabular-nums" style={{ textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={str}>
          {str}
        </div>
      ) : (
        <div className="w-full overflow-hidden whitespace-pre-wrap break-all text-body leading-5 tabular-nums line-clamp-6">
          {str}
        </div>
      )

    case 'date':
    case 'created_time':
    case 'last_modified_time':
      return ellipsis ? (
        <div className="w-full overflow-hidden text-body leading-5 text-muted-foreground" style={{ textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={str}>
          {str}
        </div>
      ) : (
        <div className="w-full overflow-hidden whitespace-pre-wrap break-all text-body leading-5 text-muted-foreground line-clamp-6">
          {str}
        </div>
      )

    case 'attachment':
      return (
        <div className="flex gap-1 flex-wrap">
          <span className="text-body leading-5 text-muted-foreground">{str || '—'}</span>
        </div>
      )

    default:
      return ellipsis ? (
        <div className="w-full overflow-hidden text-body leading-5" style={{ textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={str}>
          {str}
        </div>
      ) : (
        <div className="w-full overflow-hidden whitespace-pre-wrap break-all text-body leading-5 line-clamp-6">
          {str}
        </div>
      )
  }
}

export const CellValueRenderer: React.FC<{
  field: Field
  value: unknown
  ellipsis?: boolean
  userDisplayNameById?: ReadonlyMap<string, string>
}> = ({ field, value, ellipsis = false, userDisplayNameById }) => {
  const str = formatFieldDisplayValue(
    value,
    field as Parameters<typeof formatFieldDisplayValue>[1],
    { emptyLabel: '', userDisplayNameById }
  )

  const fieldType = isAttachmentFieldType(field.field_type) ? 'attachment' : field.field_type
  return <>{renderCellByFieldType(fieldType, value, str, ellipsis, false)}</>
}

// ---------------------------------------------------------------------------
// ViewPaginationBar
// ---------------------------------------------------------------------------

export const ViewPaginationBar: React.FC<{
  currentPage: number
  totalPages: number
  totalCount: number
  isLoading: boolean
  onPageChange: (page: number) => Promise<void>
}> = ({ currentPage, totalPages, totalCount, isLoading, onPageChange }) => {
  const { t } = useTranslation('view')

  if (totalPages <= 1) return null

  const page = Math.max(1, Math.min(currentPage, totalPages))

  return (
    <div className="flex items-center justify-between border-t bg-background px-4 py-2 text-body text-muted-foreground">
      <span>
        {t('pagination.summary', {
          page: formatNumber(page),
          totalPages: formatNumber(totalPages),
          total: formatNumber(totalCount),
        })}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1 || isLoading} onClick={() => void onPageChange(page - 1)}>
          {t('pagination.prev')}
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages || isLoading} onClick={() => void onPageChange(page + 1)}>
          {t('pagination.next')}
        </Button>
      </div>
    </div>
  )
}
