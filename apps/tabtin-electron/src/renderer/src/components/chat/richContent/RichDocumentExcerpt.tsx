/* eslint-disable tabtin/no-chat-design-violations -- 解析状态徽章是一套完整状态图例（parsing 蓝 / pending·partial 琥珀 / failed 红 / success 绿），等同 CI 状态色系，整套保留才能让用户辨识解析阶段，非单点 UI 警示 */
/**
 * `document_excerpt` kind renderer (W7) — used by parse_document.
 *
 * State-aware card:
 *   - parsing → spinner + progress bar (parsed_pages / total_pages)
 *   - pending → hourglass + retry hint
 *   - partial / success → chunks grouped by page (collapsed by default)
 *   - failed → falls through to RichFallback (parse_document returns isError)
 *
 * The card never tries to render the full document body—chunks are already
 * truncated by the runtime; if users want full content they can click through
 * to the file preview (the filename is shown while navigation keeps file_id).
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Loader2, Hourglass, ExternalLink } from 'lucide-react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { RichFallback } from './RichFallback'

const COLLAPSED_PAGE_LIMIT = 3

type TFn = (key: string, options?: Record<string, unknown>) => string

interface DocumentChunk {
  page?: number
  content?: string
  chunk_type?: string
  heading_level?: number
}

function groupByPage(chunks: DocumentChunk[]): Map<number, DocumentChunk[]> {
  const groups = new Map<number, DocumentChunk[]>()
  for (const c of chunks) {
    const page = typeof c.page === 'number' ? c.page : -1
    const list = groups.get(page) ?? []
    list.push(c)
    groups.set(page, list)
  }
  return groups
}

const ChunkLine: React.FC<{ chunk: DocumentChunk }> = ({ chunk }) => {
  if (chunk.chunk_type === 'heading' && chunk.heading_level) {
    const level = Math.min(6, Math.max(1, chunk.heading_level))
    const sizeClass = level <= 2 ? 'text-subtitle font-semibold' : 'text-body font-medium'
    return <div className={`${sizeClass} text-foreground`}>{chunk.content ?? ''}</div>
  }
  return (
    <p className="text-caption text-foreground whitespace-pre-wrap break-words">
      {chunk.content ?? ''}
    </p>
  )
}

const PageSection: React.FC<{ page: number; chunks: DocumentChunk[]; t: TFn }> = ({ page, chunks, t }) => (
  <div className="flex flex-col gap-1 px-3 py-2 border-b border-border/10 last:border-0">
    <div className="text-caption font-medium text-muted-foreground/80">
      {page > 0 ? t('richContent.document.pageLabel', { page }) : t('richContent.document.pageUnknown')}
    </div>
    <div className="flex flex-col gap-1.5">
      {chunks.map((c, i) => (
        <ChunkLine key={i} chunk={c} />
      ))}
    </div>
  </div>
)

export const RichDocumentExcerpt: React.FC<{
  block: RichContentBlock
  onResourceNavigate?: (resourceType: string, resourceId: string) => void
}> = React.memo(
  ({ block, onResourceNavigate }) => {
    const { t } = useTranslation('chat')
    const status = block.parse_status ?? 'success'
    const chunks = (block.document_chunks ?? []) as DocumentChunk[]
    const grouped = useMemo(() => groupByPage(chunks), [chunks])
    const pages = useMemo(() => Array.from(grouped.keys()).sort((a, b) => a - b), [grouped])
    const [expanded, setExpanded] = useState(pages.length <= COLLAPSED_PAGE_LIMIT)
    const visiblePages = expanded ? pages : pages.slice(0, COLLAPSED_PAGE_LIMIT)
    const displayName = typeof block.filename === 'string' && block.filename.trim()
      ? block.filename.trim()
      : block.file_id

    const handleNavigate = useCallback(() => {
      if (block.file_id) onResourceNavigate?.('file', block.file_id)
    }, [block.file_id, onResourceNavigate])

    if (status === 'parsing') {
      return (
        <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
          <Header displayName={displayName} status={status} t={t} onNavigate={handleNavigate} canNavigate={!!onResourceNavigate && !!block.file_id} />
          <div className="px-3 py-4 flex flex-col gap-2 items-center">
            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              <span>{t('richContent.document.parsing')}</span>
            </div>
            {typeof block.total_pages === 'number' && block.total_pages > 0 && (
              <ParseProgress
                parsed={block.parsed_pages ?? 0}
                total={block.total_pages}
                t={t}
              />
            )}
          </div>
        </div>
      )
    }

    if (status === 'pending') {
      return (
        <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
          <Header displayName={displayName} status={status} t={t} onNavigate={handleNavigate} canNavigate={!!onResourceNavigate && !!block.file_id} />
          <div className="px-3 py-4 flex items-center gap-2 text-caption text-muted-foreground justify-center">
            <Hourglass className="h-3.5 w-3.5" aria-hidden />
            <span>{t('richContent.document.pending')}</span>
          </div>
        </div>
      )
    }

    if (status === 'failed') {
      return <RichFallback block={block} />
    }

    return (
      <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
        <Header
          displayName={displayName}
          status={status}
          chunkCount={chunks.length}
          parsedPages={block.parsed_pages}
          totalPages={block.total_pages}
          t={t}
          onNavigate={handleNavigate}
          canNavigate={!!onResourceNavigate && !!block.file_id}
        />
        {chunks.length === 0 ? (
          <div className="px-3 py-4 text-caption text-muted-foreground text-center">
            {t('richContent.document.empty')}
          </div>
        ) : (
          <div className="max-h-[420px] overflow-auto">
            <div className="flex flex-col">
              {visiblePages.map((p) => (
                <PageSection key={p} page={p} chunks={grouped.get(p) ?? []} t={t} />
              ))}
            </div>
          </div>
        )}
        {!expanded && pages.length > COLLAPSED_PAGE_LIMIT && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-3 py-1.5 bg-muted/20 border-t border-border/20 text-caption text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors text-left"
          >
            {t('richContent.document.showAllPages', {
              shown: COLLAPSED_PAGE_LIMIT,
              total: pages.length,
            })}
          </button>
        )}
        {status === 'partial' && (
          <div className="px-3 py-1.5 bg-amber-500/10 border-t border-amber-500/20 text-caption text-amber-700 dark:text-amber-400">
            {t('richContent.document.partial')}
          </div>
        )}
      </div>
    )
  },
)

const Header: React.FC<{
  displayName?: string
  status: string
  chunkCount?: number
  parsedPages?: number
  totalPages?: number
  t: TFn
  /** 是否启用 file_id → 文件预览跳转。host 不挂 onResourceNavigate 时为 false。 */
  canNavigate?: boolean
  onNavigate?: () => void
}> = ({ displayName, status, chunkCount, parsedPages, totalPages, t, canNavigate, onNavigate }) => (
  <div className="px-3 py-1.5 bg-muted/30 border-b border-border/20 flex items-center gap-2">
    <FileText className="h-3 w-3 text-muted-foreground/80 shrink-0" aria-hidden />
    <span className="text-caption font-mono text-muted-foreground truncate flex-1" title={displayName}>
      {displayName ?? t('richContent.document.unknownFile')}
    </span>
    <StatusBadge status={status} t={t} />
    {typeof chunkCount === 'number' && chunkCount > 0 && (
      <span className="text-caption text-muted-foreground/60 tabular-nums shrink-0">
        {t('richContent.document.chunkCount', { count: chunkCount })}
      </span>
    )}
    {typeof totalPages === 'number' && totalPages > 0 && (
      <span className="text-caption text-muted-foreground/60 tabular-nums shrink-0">
        {t('richContent.document.pageOf', {
          parsed: parsedPages ?? totalPages,
          total: totalPages,
        })}
      </span>
    )}
    {canNavigate && (
      <button
        type="button"
        className="inline-flex items-center gap-0.5 text-caption text-accent hover:text-accent/80 transition-colors shrink-0"
        onClick={onNavigate}
        title={t('richContent.document.openFile')}
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
        <span>{t('richContent.document.openFile')}</span>
      </button>
    )}
  </div>
)

const StatusBadge: React.FC<{ status: string; t: TFn }> = ({ status, t }) => {
  const labelKey = `richContent.document.status.${status}`
  const cls = (() => {
    switch (status) {
      case 'parsing': return 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
      case 'pending': return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
      case 'partial': return 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
      case 'failed':  return 'bg-red-500/10 text-red-600 dark:text-red-400'
      default:        return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    }
  })()
  return (
    <span className={`px-1.5 py-0.5 rounded font-mono text-caption shrink-0 ${cls}`}>
      {t(labelKey)}
    </span>
  )
}

const ParseProgress: React.FC<{ parsed: number; total: number; t: TFn }> = ({ parsed, total, t }) => {
  const pct = total > 0 ? Math.min(100, Math.round((parsed / total) * 100)) : 0
  return (
    <div className="w-full max-w-xs flex flex-col gap-1">
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
        <div
          className="h-full bg-blue-500/60 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-caption text-muted-foreground/80 text-center tabular-nums">
        {t('richContent.document.pageOf', { parsed, total })}
      </div>
    </div>
  )
}
