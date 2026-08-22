/**
 * UrlPreview — compact URL display with domain extraction and clickable link.
 *
 * Used by WebSearchCard, WebFetchCard for displaying URLs with context.
 */

import React, { useCallback } from 'react'
import { ExternalLink } from 'lucide-react'
import { cn } from '@utils/cn'
import {
  TEXT,
  TEXT_COLOR,
  ICON_SIZE,
} from '../../registry/chatDesignTokens'
import { extractDomain } from '../../utils/domain'

export interface UrlPreviewProps {
  url: string
  title?: string
  /** Short description / snippet */
  description?: string
}

const UrlPreview: React.FC<UrlPreviewProps> = React.memo(({ url, title, description }) => {
  const domain = extractDomain(url)

  const handleClick = useCallback(() => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [url])

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleClick}
          className={cn(
            TEXT.body,
            'font-medium text-accent hover:underline truncate text-left',
          )}
          title={url}
        >
          {title || url}
        </button>
        <ExternalLink className={cn(ICON_SIZE.sm, TEXT_COLOR.faint, 'shrink-0')} />
      </div>
      <div className={cn(TEXT.meta, TEXT_COLOR.faint)}>{domain}</div>
      {description && (
        <p className={cn(TEXT.meta, TEXT_COLOR.muted, 'mt-0.5 line-clamp-2')}>
          {description}
        </p>
      )}
    </div>
  )
})

UrlPreview.displayName = 'UrlPreview'

export { UrlPreview }
export default UrlPreview
