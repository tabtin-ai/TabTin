/**
 * WebFetchCard — structured rendering for historical page-fetch transcript results.
 *
 * Displays URL, page title, and a content preview.
 * Self-registers as 'WebFetchCard'.
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { CardRendererProps } from '../registry/types'
import type { WebFetchData } from '@tabtin/chat-client'
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
import { extractDomain } from '../utils/domain'
import { safeCopyToClipboard } from '../utils/clipboard'
import { ErrorBanner, LoadingPlaceholder } from './primitives'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

interface WebFetchCardProps {
  url: string
  title?: string
  content: string
}

const WebFetchCard: React.FC<WebFetchCardProps> = React.memo(({ url, title, content }) => {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const domain = extractDomain(url)

  const handleCopy = useCallback(() => {
    safeCopyToClipboard(content, () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [content])

  const handleOpenUrl = useCallback(() => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }, [url])

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
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className={cn('flex items-center gap-1.5 min-w-0 flex-1', TEXT_COLOR.muted)}
        >
          {expanded ? (
            <ChevronDown className={ICON_SIZE.sm} />
          ) : (
            <ChevronRight className={ICON_SIZE.sm} />
          )}
          <Globe className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
          {title ? (
            <span className={cn(TEXT.body, 'font-medium', TEXT_COLOR.secondary, 'truncate')}>
              {title}
            </span>
          ) : (
            <span className={cn(TEXT.meta, TEXT_COLOR.muted, 'truncate')}>{domain}</span>
          )}
        </button>

        {url && (
          <button
            type="button"
            onClick={handleOpenUrl}
            className={cn(TEXT.meta, 'text-accent hover:underline shrink-0')}
            title={url}
          >
            {domain}
          </button>
        )}

        <ChatIconTooltip content={t('card.copy_content')}>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              'shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors',
              TEXT_COLOR.muted,
            )}
            aria-label={t('card.copy_content')}
          >
            {copied ? (
              <Check className={cn(ICON_SIZE.sm, 'text-success')} />
            ) : (
              <Copy className={ICON_SIZE.sm} />
            )}
          </button>
        </ChatIconTooltip>
      </div>

      {/* Content preview */}
      {expanded && (
        <ScrollArea className={CARD_MAX_HEIGHT.md} scrollBar="both">
          <pre
            className={cn(
              'px-3 py-1.5 whitespace-pre-wrap break-words',
              TEXT.code,
              TEXT_COLOR.secondary,
            )}
          >
            {content}
          </pre>
        </ScrollArea>
      )}

      {/* Footer: content length */}
      {expanded && content.length > 500 && (
        <div
          className={cn(
            'flex items-center justify-end',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            'border-t',
            BORDER.subtle,
          )}
        >
          <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>
            {content.length > 1000
              ? `${(content.length / 1000).toFixed(1)}k chars`
              : `${content.length} chars`}
          </span>
        </div>
      )}
    </div>
  )
})

WebFetchCard.displayName = 'WebFetchCard'

const WebFetchCardRenderer: React.FC<CardRendererProps> = ({ data, input, output, error, phase }) => {
  if (error) return <ErrorBanner error={error} />

  const fetch = data as WebFetchData | undefined

  if (fetch && fetch.kind === 'web_page_fetch') {
    return (
      <WebFetchCard
        url={fetch.url}
        title={fetch.title}
        content={fetch.content_preview || ''}
      />
    )
  }

  const inp = ((input as any)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const url = String(inp.url ?? '')

  if (typeof output === 'string' && output.length > 0) {
    const titleMatch = output.match(/^#\s+(.+)$/m)
    return (
      <WebFetchCard url={url} title={titleMatch?.[1]} content={output.slice(0, 2000)} />
    )
  }

  if (output && typeof output === 'object') {
    const raw = ((output as any).data ?? output) as Record<string, unknown>
    const content = String(raw.content ?? raw.text ?? raw.content_preview ?? '')
    if (content) {
      return (
        <WebFetchCard
          url={String(raw.url ?? url)}
          title={raw.title as string | undefined}
          content={content.slice(0, 2000)}
        />
      )
    }
  }

  if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
  return null
}

WebFetchCardRenderer.displayName = 'WebFetchCardRenderer'

registerCardRenderer('WebFetchCard', WebFetchCardRenderer)

export { WebFetchCard, WebFetchCardRenderer }
export default WebFetchCard
