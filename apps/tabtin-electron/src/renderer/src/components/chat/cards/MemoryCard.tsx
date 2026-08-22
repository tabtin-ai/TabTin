/**
 * MemoryCard — structured rendering for memory_write / memory_search / memory_delete tools.
 *
 * - memory_write: displays memory title/content summary
 * - memory_search: displays search results as key-value list
 * - memory_delete: displays deleted memory ID
 *
 * Self-registers as 'MemoryCard'.
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { NotebookPen, Search, Trash2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { CardRendererProps } from '../registry/types'
import {
  CARD_HEADER_PADDING,
  CARD_PADDING,
  CARD_MAX_HEIGHT,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { ErrorBanner, LoadingPlaceholder } from './primitives'

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

function getNestedArgs(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  return (obj.kwargs as Record<string, unknown>) ?? obj
}

function unwrapData(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object') return {}
  const obj = output as Record<string, unknown>
  const inner = obj.data
  return (inner && typeof inner === 'object' ? inner : obj) as Record<string, unknown>
}

/* ─── memory_write sub-card ─────────────────────────────────────────── */

const MemoryWriteBody: React.FC<{ input: unknown; output: unknown }> = React.memo(({ input, output }) => {
  const { t } = useTranslation('chat')
  const args = getNestedArgs(input)
  const data = unwrapData(output)

  const title = String(args?.title ?? args?.key ?? data?.title ?? data?.key ?? '')
  const content = String(args?.content ?? args?.value ?? data?.content ?? data?.value ?? '')

  return (
    <div className={cn(CARD_PADDING.x, 'py-1.5 space-y-1')}>
      {title && (
        <div className={cn(TEXT.body, 'font-medium', TEXT_COLOR.secondary)}>
          {title}
        </div>
      )}
      {content && (
        <pre className={cn(TEXT.code, TEXT_COLOR.muted, 'whitespace-pre-wrap break-all line-clamp-5')}>
          {truncate(content, 500)}
        </pre>
      )}
      {!title && !content && (
        <div className={cn(TEXT.meta, TEXT_COLOR.faint, 'italic')}>
          {t('card.generic_no_content', 'No content')}
        </div>
      )}
    </div>
  )
})
MemoryWriteBody.displayName = 'MemoryWriteBody'

/* ─── memory_search sub-card ────────────────────────────────────────── */

const MemorySearchBody: React.FC<{ input: unknown; output: unknown }> = React.memo(({ input, output }) => {
  const { t } = useTranslation('chat')
  const args = getNestedArgs(input)
  const query = String(args?.query ?? args?.keyword ?? '')

  const results = useMemo(() => {
    const data = unwrapData(output)
    const items = (data.results ?? data.memories ?? data.items) as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(items)) return []
    return items.slice(0, 20).map((item) => ({
      key: String(item.title ?? item.key ?? item.id ?? ''),
      value: String(item.content ?? item.value ?? item.snippet ?? ''),
      score: item.score != null ? Number(item.score) : undefined,
    }))
  }, [output])

  return (
    <div>
      {query && (
        <div className={cn(CARD_PADDING.x, 'py-1', TEXT.code, TEXT_COLOR.secondary, 'truncate')} title={query}>
          {query}
        </div>
      )}
      {results.length === 0 ? (
        <div className={cn(CARD_PADDING.x, 'py-2', TEXT.meta, TEXT_COLOR.muted, 'italic')}>
          {t('card.no_search_results', 'No results found')}
        </div>
      ) : (
        <ScrollArea className={CARD_MAX_HEIGHT.md} scrollBar="vertical">
          <div className="divide-y divide-border/10">
            {results.map((item, i) => (
              <div key={`${item.key}-${i}`} className={cn(CARD_PADDING.x, 'py-1.5 space-y-0.5')}>
                <div className="flex items-center gap-2">
                  <span className={cn(TEXT.body, 'font-medium', TEXT_COLOR.secondary, 'truncate flex-1')}>
                    {item.key || `#${i + 1}`}
                  </span>
                  {item.score != null && (
                    <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'shrink-0')}>
                      {item.score.toFixed(2)}
                    </span>
                  )}
                </div>
                {item.value && (
                  <pre className={cn(TEXT.code, TEXT_COLOR.muted, 'whitespace-pre-wrap break-all line-clamp-2')}>
                    {truncate(item.value, 200)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
})
MemorySearchBody.displayName = 'MemorySearchBody'

/* ─── memory_delete sub-card ────────────────────────────────────────── */

const MemoryDeleteBody: React.FC<{ input: unknown; output: unknown }> = React.memo(({ input, output }) => {
  const args = getNestedArgs(input)
  const data = unwrapData(output)
  const memoryId = String(args?.memory_id ?? args?.key ?? args?.id ?? data?.memory_id ?? data?.id ?? '')

  return (
    <div className={cn(CARD_PADDING.x, 'py-1.5')}>
      {memoryId ? (
        <span className={cn(TEXT.code, TEXT_COLOR.secondary)}>
          ID: <span className={TEXT_COLOR.muted}>{memoryId}</span>
        </span>
      ) : (
        <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'italic')}>deleted</span>
      )}
    </div>
  )
})
MemoryDeleteBody.displayName = 'MemoryDeleteBody'

/* ─── Main renderer ─────────────────────────────────────────────────── */

type MemoryOp = 'write' | 'search' | 'delete'

function detectOp(toolName: string): MemoryOp {
  if (toolName.includes('search')) return 'search'
  if (toolName.includes('delete')) return 'delete'
  return 'write'
}

const OP_CONFIG: Record<MemoryOp, { icon: React.FC<{ className?: string }>; labelKey: string }> = {
  write: { icon: NotebookPen, labelKey: 'card.memory_write' },
  search: { icon: Search, labelKey: 'card.memory_search' },
  delete: { icon: Trash2, labelKey: 'card.memory_delete' },
}

const MemoryCardRenderer: React.FC<CardRendererProps> = React.memo(
  ({ toolName, input, output, error, phase }) => {
    const { t } = useTranslation('chat')
    if (error) return <ErrorBanner error={error} />
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />

    const op = detectOp(toolName)
    const { icon: Icon, labelKey } = OP_CONFIG[op]

    return (
      <div className={'overflow-hidden'}>
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-1.5',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            BG.header,
            'border-b',
            BORDER.subtle,
          )}
        >
          <Icon className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
          <span className={cn(TEXT.label, TEXT_COLOR.muted)}>
            {t(labelKey, { defaultValue: labelKey.split('.').pop() ?? labelKey })}
          </span>
        </div>

        {/* Body */}
        {op === 'write' && <MemoryWriteBody input={input} output={output} />}
        {op === 'search' && <MemorySearchBody input={input} output={output} />}
        {op === 'delete' && <MemoryDeleteBody input={input} output={output} />}
      </div>
    )
  },
)

MemoryCardRenderer.displayName = 'MemoryCardRenderer'

registerCardRenderer('MemoryCard', MemoryCardRenderer)

export { MemoryCardRenderer }
export default MemoryCardRenderer
