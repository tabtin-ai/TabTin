/**
 * DocSearchCard — structured rendering for tabdoc.search_documents tool results.
 *
 * Displays search query, result count, and a list of document hits with
 * titles, matched snippets, and relevance scores. Self-registers as 'DocSearchCard'.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { useSpaceListStore } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { useMainNavStore } from '@/stores/useMainNavStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useTabDocRevealStore } from '@/stores/useTabDocRevealStore'
import { buildTabDocSearchReveal, textContainsSearchQuery } from '@/services/tabDocSearchReveal'
import { openResourceTabGuarded } from '@/components/context-space/restore/openResourceMembershipGuard'
import { resolveForegroundTabScopeKey } from '../subagent/openSubagentTab'
import type { CardRendererProps } from '../registry/types'
import {
  CARD_HEADER_PADDING,
  CARD_MAX_HEIGHT,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { ErrorBanner, LoadingPlaceholder } from './primitives'

interface DocSearchItem {
  document_id: string
  title: string
  snippet: string
  relevance_score: number
  matched_on_title: boolean
  space_id?: string | null
  block_id?: string | null
  block_type?: string | null
  block_index?: number | null
  block_preview?: string
  latest_version?: number
  updated_at?: string | null
}

interface DocSearchCardProps {
  query: string
  items: DocSearchItem[]
  total: number
  onItemClick?: (item: DocSearchItem) => void
}

function highlightText(text: string, terms: string[]): React.ReactNode {
  if (!terms.length || !text) return text
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(pattern)
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-accent/25 text-accent rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

const DocSearchCard: React.FC<DocSearchCardProps> = React.memo(({ query, items, total, onItemClick }) => {
  const { t } = useTranslation('chat')
  const highlightTerms = query ? query.split(/\s+/).filter((term) => term.length > 2) : []

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
        <FileText className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
        {query && (
          <span className={cn(TEXT.code, TEXT_COLOR.secondary, 'truncate')} title={query}>
            {query}
          </span>
        )}
        <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto shrink-0')}>
          {t('card.result_count', { count: total })}
        </span>
      </div>

      {/* Results */}
      {items.length === 0 ? (
        <div className={cn('px-3 py-2', TEXT.meta, TEXT_COLOR.muted, 'italic')}>
          {t('card.no_search_results')}
        </div>
      ) : (
        <ScrollArea className={CARD_MAX_HEIGHT.md} scrollBar="vertical">
          <div className="divide-y divide-border/10">
            {items.map((item, i) => {
              const subtitleParts = [
                item.relevance_score != null ? `score: ${item.relevance_score.toFixed(2)}` : undefined,
                item.matched_on_title ? 'title match' : undefined,
              ].filter(Boolean) as string[]

              return (
                <button
                  type="button"
                  key={`${item.document_id}-${i}`}
                  className={cn(
                    'w-full px-3 py-1.5 flex items-start gap-2 text-left',
                    onItemClick ? 'hover:bg-muted/10 cursor-pointer' : 'cursor-default',
                  )}
                  onClick={onItemClick ? () => onItemClick(item) : undefined}
                  disabled={!onItemClick}
                >
                  <span className={cn('shrink-0 mt-0.5', TEXT_COLOR.muted)}>
                    <FileText className={ICON_SIZE.sm} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cn(TEXT.body, 'font-medium', TEXT_COLOR.secondary, 'truncate')}>
                      {highlightTerms.length > 0 ? highlightText(item.title, highlightTerms) : item.title}
                    </div>
                    {subtitleParts.length > 0 && (
                      <div className={cn(TEXT.meta, TEXT_COLOR.faint, 'truncate')}>
                        {subtitleParts.join(' · ')}
                      </div>
                    )}
                    {item.snippet && (
                      <pre
                        className={cn(
                          TEXT.code,
                          TEXT_COLOR.muted,
                          'mt-0.5 whitespace-pre-wrap break-all line-clamp-3',
                        )}
                      >
                        {highlightTerms.length > 0
                          ? highlightText(item.snippet, highlightTerms)
                          : item.snippet}
                      </pre>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  )
})

DocSearchCard.displayName = 'DocSearchCard'

const DocSearchCardRenderer: React.FC<CardRendererProps> = ({ input, output, error, phase }) => {
  if (error) return <ErrorBanner error={error} />

  const inp = ((input as Record<string, unknown>)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const query = String(inp.query ?? '')

  const raw = (output ?? {}) as Record<string, unknown>

  if (raw.success === true && Array.isArray(raw.items)) {
    const effectiveQuery = String(raw.query ?? query)
    const items: DocSearchItem[] = (raw.items as Array<Record<string, unknown>>).map((hit) => {
      const document = (hit.document && typeof hit.document === 'object'
        ? hit.document
        : {}) as Record<string, unknown>
      return {
        document_id: String(hit.document_id ?? document.id ?? ''),
        title: String(hit.title ?? document.title ?? ''),
        snippet: String(hit.snippet ?? ''),
        relevance_score: Number(hit.relevance_score ?? 0),
        matched_on_title: Boolean(hit.matched_on_title),
        space_id: hit.space_id != null ? String(hit.space_id) : (document.space_id != null ? String(document.space_id) : null),
        block_id: hit.block_id != null ? String(hit.block_id) : null,
        block_type: hit.block_type != null ? String(hit.block_type) : null,
        block_index: hit.block_index != null ? Number(hit.block_index) : null,
        block_preview: hit.block_preview != null ? String(hit.block_preview) : '',
        latest_version: hit.latest_version != null ? Number(hit.latest_version) : undefined,
        updated_at: hit.updated_at != null ? String(hit.updated_at) : null,
      }
    })
    const handleItemClick = (item: DocSearchItem) => {
      if (!item.document_id) return
      const spaceId = item.space_id || useSpaceStore.getState().selectedSpace?.id
      if (!spaceId) return

      const openDocument = () => {
        const reveal = buildTabDocSearchReveal({
          blockId: item.block_id,
          blockPreview: item.block_preview,
          snippet: textContainsSearchQuery(item.snippet, effectiveQuery) ? item.snippet : '',
        })
        if (reveal) {
          useTabDocRevealStore.getState().setPendingReveal(item.document_id, {
            kind: 'doc_selection',
            ...reveal,
          })
        }
        openResourceTabGuarded(resolveForegroundTabScopeKey(spaceId), {
          type: 'tabdoc',
          id: item.document_id,
          title: item.title || undefined,
          meta: { spaceId },
        }, spaceId)
      }

      const activeSpaceId = useSpaceStore.getState().selectedSpace?.id ?? null
      if (activeSpaceId !== spaceId) {
        const activated = useSpaceListStore.getState().activateSpace(spaceId)
        if (!activated) {
          toast.error('该文档所在 Space 暂不可进入')
          return
        }
        useMainNavStore.getState().setCurrentTab('agent')
        window.setTimeout(openDocument, 80)
        return
      }

      openDocument()
    }
    return (
      <DocSearchCard
        query={effectiveQuery}
        items={items}
        total={Number(raw.total ?? items.length)}
        onItemClick={handleItemClick}
      />
    )
  }

  if (raw.success === false) {
    return <ErrorBanner error={String(raw.error ?? 'Search failed')} />
  }

  if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
  return null
}

DocSearchCardRenderer.displayName = 'DocSearchCardRenderer'

registerCardRenderer('DocSearchCard', DocSearchCardRenderer)

export { DocSearchCard, DocSearchCardRenderer }
export default DocSearchCard
