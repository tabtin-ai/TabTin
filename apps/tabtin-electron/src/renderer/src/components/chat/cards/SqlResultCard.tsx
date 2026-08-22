/**
 * SqlResultCard — Tabular card for SQL query results in agent chat.
 *
 * Renders query results as a compact table with header (icon, label, row
 * count, copy-as-CSV button), scrollable body, and optional footer when
 * the result set is truncated. Self-registers as 'SqlResultCard'.
 */

import React, { useCallback, useMemo, useState } from 'react'
import { Database, Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { CardRendererProps } from '../registry/types'
import type { SqlResultData } from '@tabtin/chat-client'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  CARD_MAX_HEIGHT,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { safeCopyToClipboard } from '../utils/clipboard'
import { ErrorBanner, LoadingPlaceholder } from './primitives'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

const MAX_VISIBLE_ROWS = 10

interface SqlResultCardProps {
  columns: string[]
  rows: unknown[][]
  totalRows?: number
}

/**
 * Convert columns + rows to CSV text for clipboard.
 */
function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const header = columns.map(escape).join(',')
  const body = rows.map((row) => row.map(escape).join(',')).join('\n')
  return `${header}\n${body}`
}

const SqlResultCard: React.FC<SqlResultCardProps> = React.memo(
  ({ columns, rows, totalRows }) => {
    const { t } = useTranslation('chat')
    const [copied, setCopied] = useState(false)

    const visibleRows = useMemo(() => rows.slice(0, MAX_VISIBLE_ROWS), [rows])
    const total = totalRows ?? rows.length
    const isTruncated = total > MAX_VISIBLE_ROWS

    const handleCopy = useCallback(() => {
      const csv = toCsv(columns, rows)
      safeCopyToClipboard(csv, () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    }, [columns, rows])

    return (
      <div className={'overflow-hidden'}>
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-2',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            BG.header,
            'border-b',
            BORDER.subtle,
          )}
        >
          <Database className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
          <span className={cn(TEXT.header, TEXT_COLOR.secondary)}>
            {t('card.sql_result')}
          </span>

          <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto shrink-0')}>
            {t('card.rows_count', { count: total })}
          </span>

          <ChatIconTooltip content={t('card.copy_csv')}>
            <button
              type="button"
              onClick={handleCopy}
              className={cn(
                'shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors',
                TEXT_COLOR.muted,
              )}
              aria-label={t('card.copy_csv')}
            >
              {copied ? (
                <Check className={cn(ICON_SIZE.sm, 'text-success')} />
              ) : (
                <Copy className={ICON_SIZE.sm} />
              )}
            </button>
          </ChatIconTooltip>
        </div>

        {/* Table */}
        <ScrollArea className={CARD_MAX_HEIGHT.md} scrollBar="both">
          <table className={cn('w-full', TEXT.code)}>
            <thead>
              <tr className={cn('border-b', BORDER.subtle, BG.header)}>
                {columns.map((col, i) => (
                  <th
                    key={i}
                    className={cn(
                      'px-2 py-1 text-left font-medium whitespace-nowrap',
                      TEXT_COLOR.muted,
                    )}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, ri) => (
                <tr key={ri} className={cn('border-b last:border-0', BORDER.subtle)}>
                  {(row as unknown[]).map((cell, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        'px-2 py-0.5 whitespace-nowrap max-w-[160px] truncate',
                        cell === null || cell === undefined
                          ? TEXT_COLOR.faint
                          : TEXT_COLOR.secondary,
                      )}
                    >
                      {cell === null || cell === undefined ? 'null' : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>

        {/* Footer (truncation notice) */}
        {isTruncated && (
          <div
            className={cn(
              'border-t',
              BORDER.subtle,
              CARD_HEADER_PADDING.x,
              CARD_HEADER_PADDING.y,
              TEXT.meta,
              TEXT_COLOR.faint,
            )}
          >
            {t('card.sql_result_truncated', {
              shown: MAX_VISIBLE_ROWS,
              total,
            })}
          </div>
        )}
      </div>
    )
  },
)

SqlResultCard.displayName = 'SqlResultCard'

/** Renderer adapter conforming to CardRendererProps for the registry. */
const SqlResultCardRenderer: React.FC<CardRendererProps> = React.memo((props) => {
  const { t } = useTranslation('chat')
  const { error, phase, input } = props
  if (error) return <ErrorBanner error={error} />

  const sql = (props.data as SqlResultData | null | undefined) ??
    (props.output as SqlResultData | null | undefined)

  if (!sql || typeof sql !== 'object') {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }

  const columns: string[] = sql.columns ?? []
  const rows: unknown[][] = sql.rows ?? []
  const totalRows = sql.total_rows

  if (columns.length === 0) {
    const inp = ((input as any)?.kwargs ?? input ?? {}) as Record<string, unknown>
    const rawQuery = String(inp.query ?? inp.sql ?? '')
    const displayQuery = rawQuery.length > 200 ? rawQuery.slice(0, 200) + '...' : rawQuery
    return (
      <div className="px-3 py-2">
        <div className="text-body text-muted-foreground/60">{t('card.sql_no_results')}</div>
        {displayQuery && (
          <div className="text-caption text-muted-foreground/60 font-mono mt-1 break-all">{displayQuery}</div>
        )}
      </div>
    )
  }

  return <SqlResultCard columns={columns} rows={rows} totalRows={totalRows} />
})

SqlResultCardRenderer.displayName = 'SqlResultCardRenderer'

/* ─── Self-registration ───────────────────────────────────────────── */

registerCardRenderer('SqlResultCard', SqlResultCardRenderer)

export { SqlResultCard, SqlResultCardRenderer }
export default SqlResultCard
