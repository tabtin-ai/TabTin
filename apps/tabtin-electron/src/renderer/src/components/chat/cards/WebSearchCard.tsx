/**
 * WebSearchCard — structured rendering for web_search tool results.
 *
 * Displays search query and a list of results with titles, URLs, and snippets.
 * Self-registers as 'WebSearchCard'.
 */

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CardRendererProps } from '../registry/types'
import type { WebSearchData } from '@tabtin/chat-client'
import { SearchResultList, type SearchResultItem } from './primitives'
import {
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { ErrorBanner, LoadingPlaceholder } from './primitives'
import { parseLegacyWebSearchMarkdown } from './parseLegacyWebSearchMarkdown'

interface WebSearchCardProps {
  query: string
  results: Array<{ title: string; url: string; snippet: string }>
}

const WebSearchCard: React.FC<WebSearchCardProps> = React.memo(({ query, results }) => {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const items: SearchResultItem[] = results.map((r, i) => ({
    key: `${r.url}-${i}`,
    title: r.title || r.url,
    subtitle: r.url,
    preview: r.snippet,
    highlightTerms: query ? query.split(/\s+/).filter((t) => t.length > 2) : [],
  }))

  return (
    <div className={'overflow-hidden'}>
      {/* Header */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          'w-full text-left',
          'flex items-center gap-1.5',
          CARD_HEADER_PADDING.x,
          CARD_HEADER_PADDING.y,
          BG.header,
          expanded ? 'border-b' : '',
          BORDER.subtle,
          'hover:bg-muted/40 transition-colors',
        )}
      >
        <Search className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
        {query && (
          <span className={cn(TEXT.code, TEXT_COLOR.secondary, 'truncate')} title={query}>
            {query}
          </span>
        )}
        <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto shrink-0')}>
          {t('card.result_count', { count: results.length })}
        </span>
        {expanded ? (
          <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'shrink-0')} aria-hidden />
        ) : (
          <ChevronRight className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'shrink-0')} aria-hidden />
        )}
      </button>

      {/* Results */}
      {expanded && (
        <SearchResultList items={items} maxHeight="md" emptyMessage={t('card.no_search_results')} />
      )}
    </div>
  )
})

WebSearchCard.displayName = 'WebSearchCard'

const WebSearchCardRenderer: React.FC<CardRendererProps> = ({ data, input, output, error, phase }) => {
  const { t } = useTranslation('chat')
  if (error) return <ErrorBanner error={error} />

  const search = data as WebSearchData | undefined

  if (search && search.kind === 'web_search') {
    return <WebSearchCard query={search.query} results={search.results || []} />
  }

  const inp = ((input as any)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const query = String(inp.search_term ?? inp.query ?? '')

  if (typeof output === 'string' && output.length > 0) {
    const results = parseLegacyWebSearchMarkdown(output)
    if (results.length > 0) {
      return <WebSearchCard query={query} results={results} />
    }
  }

  if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
  return <div className="text-body text-muted-foreground/60 px-3 py-2">{t('card.search_no_results', { defaultValue: '搜索未返回结果' })}</div>
}

WebSearchCardRenderer.displayName = 'WebSearchCardRenderer'

registerCardRenderer('WebSearchCard', WebSearchCardRenderer)

export { WebSearchCard, WebSearchCardRenderer }
export default WebSearchCard
