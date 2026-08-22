/**
 * SearchResultList — reusable list of search results with keyword highlighting.
 *
 * Used by CodeSearchCard, WebSearchCard, and other search-type tool cards.
 */

import React from 'react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import {
  TEXT,
  TEXT_COLOR,
  CARD_MAX_HEIGHT,
  BORDER,
} from '../../registry/chatDesignTokens'

export interface SearchResultItem {
  /** Unique key for React rendering */
  key: string
  /** Icon element (optional) */
  icon?: React.ReactNode
  /** Primary text (e.g. file path, page title) */
  title: string
  /** Secondary text (e.g. line number, URL) */
  subtitle?: string
  /** Preview / snippet content */
  preview?: string
  /** Keywords to highlight in preview and title */
  highlightTerms?: string[]
  /** Right-side badge or label */
  badge?: React.ReactNode
}

export interface SearchResultListProps {
  items: SearchResultItem[]
  /** Max visible items before scroll */
  maxHeight?: keyof typeof CARD_MAX_HEIGHT
  /** Empty state message */
  emptyMessage?: string
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

const SearchResultList: React.FC<SearchResultListProps> = React.memo(
  ({ items, maxHeight = 'md', emptyMessage }) => {
    const { t } = useTranslation('chat')
    const displayEmpty = emptyMessage ?? t('card.no_results')

    if (items.length === 0) {
      return (
        <div className={cn('px-3 py-2', TEXT.meta, TEXT_COLOR.muted, 'italic')}>
          {displayEmpty}
        </div>
      )
    }

    return (
      <ScrollArea className={CARD_MAX_HEIGHT[maxHeight]} scrollBar="vertical">
        <div className="divide-y divide-border/10">
          {items.map((item) => (
            <div
              key={item.key}
              className={cn('px-3 py-1.5 flex items-start gap-2', 'hover:bg-muted/10')}
            >
              {item.icon && (
                <span className={cn('shrink-0 mt-0.5', TEXT_COLOR.muted)}>{item.icon}</span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn(TEXT.body, 'font-medium', TEXT_COLOR.secondary, 'truncate')}>
                    {item.highlightTerms
                      ? highlightText(item.title, item.highlightTerms)
                      : item.title}
                  </span>
                  {item.badge && <span className="shrink-0">{item.badge}</span>}
                </div>
                {item.subtitle && (
                  <div className={cn(TEXT.meta, TEXT_COLOR.faint, 'truncate')}>{item.subtitle}</div>
                )}
                {item.preview && (
                  <pre
                    className={cn(
                      TEXT.code,
                      TEXT_COLOR.muted,
                      'mt-0.5 whitespace-pre-wrap break-all line-clamp-3',
                    )}
                  >
                    {item.highlightTerms
                      ? highlightText(item.preview, item.highlightTerms)
                      : item.preview}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    )
  },
)

SearchResultList.displayName = 'SearchResultList'

export { SearchResultList }
export default SearchResultList
