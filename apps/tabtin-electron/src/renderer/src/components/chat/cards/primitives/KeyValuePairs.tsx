/**
 * KeyValuePairs — structured key-value display, replacing raw JSON dumps.
 *
 * Used by RecordOpCard and GenericToolCard for cleaner object rendering.
 */

import React from 'react'
import { cn } from '@utils/cn'
import {
  TEXT,
  TEXT_COLOR,
} from '../../registry/chatDesignTokens'

export interface KeyValueItem {
  key: string
  value: unknown
}

export interface KeyValuePairsProps {
  items: KeyValueItem[]
  /** Compact mode shows items inline, full mode shows as rows */
  compact?: boolean
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isSimpleValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

const KeyValuePairs: React.FC<KeyValuePairsProps> = React.memo(({ items, compact = false }) => {
  if (items.length === 0) return null

  if (compact) {
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-1.5">
        {items.map((item) => (
          <span key={item.key} className={cn(TEXT.meta)}>
            <span className={TEXT_COLOR.faint}>{item.key}: </span>
            <span className={TEXT_COLOR.secondary}>{formatValue(item.value)}</span>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="px-3 py-1.5 space-y-0.5">
      {items.map((item) => (
        <div key={item.key} className={cn('flex', isSimpleValue(item.value) ? 'items-center gap-2' : 'flex-col gap-0.5')}>
          <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'shrink-0 min-w-[80px]')}>
            {item.key}
          </span>
          {isSimpleValue(item.value) ? (
            <span className={cn(TEXT.code, TEXT_COLOR.secondary, 'truncate')}>
              {formatValue(item.value)}
            </span>
          ) : (
            <pre className={cn(TEXT.code, TEXT_COLOR.secondary, 'whitespace-pre-wrap break-all text-caption')}>
              {formatValue(item.value)}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
})

KeyValuePairs.displayName = 'KeyValuePairs'

export { KeyValuePairs }
export default KeyValuePairs
