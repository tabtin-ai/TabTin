/**
 * RecordOpCard — structured rendering for create_record / update_record / delete_record.
 *
 * Displays operation type, record ID, and optional field summary.
 * Self-registers as 'RecordOpCard'.
 */

import React from 'react'
import { PlusCircle, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { CardRendererProps } from '../registry/types'
import type { RecordOpData } from '@tabtin/chat-client'
import { KeyValuePairs, type KeyValueItem } from './primitives'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { ErrorBanner, LoadingPlaceholder } from './primitives'

const OP_CONFIG = {
  create: { labelKey: 'recordOp.created', defaultLabel: 'Created', icon: PlusCircle, color: TEXT_COLOR.success },
  update: { labelKey: 'recordOp.updated', defaultLabel: 'Updated', icon: RefreshCw, color: TEXT_COLOR.accent },
  delete: { labelKey: 'recordOp.deleted', defaultLabel: 'Deleted', icon: Trash2, color: TEXT_COLOR.error },
} as const

interface RecordOpCardProps {
  operation: 'create' | 'update' | 'delete'
  recordId?: string
  tableId?: string
  fieldsCount?: number
  message?: string
  fields?: Record<string, unknown>
}

const RecordOpCard: React.FC<RecordOpCardProps> = React.memo(
  ({ operation, recordId, tableId, fieldsCount, message, fields }) => {
    const { t } = useTranslation('chat')
    const config = OP_CONFIG[operation]
    const Icon = config.icon
    const label = t(config.labelKey, { defaultValue: config.defaultLabel })

    const kvItems: KeyValueItem[] = []
    if (recordId) kvItems.push({ key: t('card.record_id'), value: recordId })
    if (tableId) kvItems.push({ key: t('card.table_label'), value: tableId })
    if (fieldsCount != null) kvItems.push({ key: t('card.fields_label'), value: fieldsCount })

    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) {
        if (k !== 'id' && k !== 'table_id') {
          kvItems.push({ key: k, value: v })
        }
      }
    }

    return (
      <div className={'overflow-hidden'}>
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-1.5',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            BG.header,
            kvItems.length > 0 ? 'border-b' : '',
            kvItems.length > 0 ? BORDER.subtle : '',
          )}
        >
          <Icon className={cn(ICON_SIZE.md, config.color)} />
          <span className={cn(TEXT.header, config.color)}>{label}</span>
          {recordId && (
            <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'font-mono truncate')}>
              {recordId.length > 12 ? `${recordId.slice(0, 8)}...` : recordId}
            </span>
          )}
        </div>

        {/* Fields */}
        {kvItems.length > 0 && <KeyValuePairs items={kvItems} compact />}

        {/* Message fallback */}
        {message && kvItems.length === 0 && (
          <div className={cn('px-3 py-1.5', TEXT.meta, TEXT_COLOR.secondary)}>
            {message}
          </div>
        )}
      </div>
    )
  },
)

RecordOpCard.displayName = 'RecordOpCard'

const RecordOpCardRenderer: React.FC<CardRendererProps> = ({ data, input, output, toolName, error, phase }) => {
  if (error) return <ErrorBanner error={error} />
  if ((phase === 'start' || phase === 'running') && !data && !output && !input) return <LoadingPlaceholder />

  const record = data as RecordOpData | undefined

  const operation = (toolName === 'create_record' || toolName === 'batch_create_records')
    ? 'create' as const
    : (toolName === 'update_record' || toolName === 'batch_update_records')
    ? 'update' as const
    : 'delete' as const

  if (record && record.kind === 'record_op') {
    return (
      <RecordOpCard
        operation={record.operation}
        recordId={record.record_id}
        tableId={record.table_id}
        fieldsCount={record.fields_count}
        message={record.message}
      />
    )
  }

  const inp = ((input as any)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const raw = output as Record<string, unknown> | string | undefined

  if (typeof raw === 'string') {
    const idMatch = raw.match(/ID:\s*(\S+)/)
    return (
      <RecordOpCard
        operation={operation}
        recordId={idMatch?.[1]}
        message={raw}
        fields={inp.data as Record<string, unknown> | undefined}
      />
    )
  }

  if (raw && typeof raw === 'object') {
    const d = ((raw as any).data ?? raw) as Record<string, unknown>
    return (
      <RecordOpCard
        operation={operation}
        recordId={String(d.id ?? d.record_id ?? inp.record_id ?? '')}
        tableId={String(d.table_id ?? inp.table_id ?? '')}
        fieldsCount={d.data && typeof d.data === 'object' ? Object.keys(d.data as object).length : undefined}
        fields={inp.data as Record<string, unknown> | undefined}
      />
    )
  }

  return (
    <RecordOpCard
      operation={operation}
      recordId={String(inp.record_id ?? '')}
      fields={inp.data as Record<string, unknown> | undefined}
    />
  )
}

RecordOpCardRenderer.displayName = 'RecordOpCardRenderer'

registerCardRenderer('RecordOpCard', RecordOpCardRenderer)

export { RecordOpCard, RecordOpCardRenderer }
export default RecordOpCard
