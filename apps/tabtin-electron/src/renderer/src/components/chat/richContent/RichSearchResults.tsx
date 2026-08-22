/**
 * `search_results` kind renderer (W7) — used by rag_search and semantic_search.
 * Web search results now render inside the standard WebSearchCard tool card.
 * Each remaining emitter uses the same shape; this card only
 * differs by `content_type` decorations.
 *
 * Visual contract:
 *   - Header: query string + total count badge + (optional) "showing N of M"
 *   - Each result row: title (bold) → snippet (truncated 2 lines) → footer
 *     line with source / score / content_type chip
 *   - URL results render as anchor; rag_search source_id renders as `tabtin://`
 *     resource hint (callers wire onResourceNavigate elsewhere — search_results
 *     currently does not jump because rag hits don't carry a stable resource_type
 *     mapping yet; a follow-up could promote source_id → resource_ref).
 *   - Collapsed by default to first 5 rows; "show all" expands to full list.
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Globe, Search } from 'lucide-react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { RichFallback } from './RichFallback'

const COLLAPSED_LIMIT = 5

type TFn = (key: string, options?: Record<string, unknown>) => string

interface SearchResultItem {
  title?: string
  url?: string
  snippet?: string
  score?: number
  content_type?: string
  file_path?: string
  source?: string
  favicon?: string
}

/**
 * 从 url 安全提取 host：上游脏数据 / 非法 URL 时返回 null 而非抛错。
 *
 * `new URL(...)` 对非 http(s) / 缺协议头的字符串会抛 TypeError——卡片上一条
 * 脏数据不能让整个 RichSearchResults 渲染失败（消息气泡级 ErrorBoundary 不一定
 * 兜底）。
 */
function safeUrlHost(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

const ResultRow: React.FC<{ item: SearchResultItem; t: TFn }> = ({ item, t }) => {
  const titleText = item.title || item.url || item.file_path || t('richContent.searchResults.untitled')
  const isExternal = typeof item.url === 'string' && /^https?:\/\//.test(item.url)
  const scorePct = typeof item.score === 'number' ? Math.round(item.score * 100) : undefined
  const urlHost = safeUrlHost(item.url)
  const [faviconBroken, setFaviconBroken] = useState(false)

  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 border-b border-border/10 last:border-0 hover:bg-muted/15 transition-colors">
      <div className="flex items-start gap-2 min-w-0">
        {item.favicon && !faviconBroken ? (
          <img
            src={item.favicon}
            alt=""
            aria-hidden
            className="w-4 h-4 mt-0.5 shrink-0 rounded-sm"
            // 加载失败时切到 Globe 默认图标——visibility:hidden 会留 4x4 空白
            // 让后续 title 错位（真实用户视角 Review 反馈）。
            onError={() => setFaviconBroken(true)}
          />
        ) : (
          <Globe className="w-3.5 h-3.5 mt-1 shrink-0 text-muted-foreground/60" aria-hidden />
        )}
        <div className="flex-1 min-w-0">
          {isExternal ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-caption font-medium text-accent hover:underline truncate block"
              title={titleText}
            >
              {titleText}
            </a>
          ) : (
            <span
              className="text-caption font-medium text-foreground truncate block"
              title={titleText}
            >
              {titleText}
            </span>
          )}
          {item.snippet && (
            <p className="text-caption text-muted-foreground line-clamp-2 mt-0.5">
              {item.snippet}
            </p>
          )}
          <div className="flex items-center gap-2 mt-0.5 text-caption text-muted-foreground/60">
            {item.content_type && (
              <span className="px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground">
                {item.content_type}
              </span>
            )}
            {item.source && !isExternal && (
              <span className="font-mono truncate" title={item.source}>
                {item.source}
              </span>
            )}
            {urlHost && (
              <span className="font-mono truncate" title={item.url}>
                {urlHost}
              </span>
            )}
            {item.file_path && (
              <span className="font-mono truncate" title={item.file_path}>
                {item.file_path}
              </span>
            )}
            {typeof scorePct === 'number' && (
              <span className="tabular-nums">{scorePct}%</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export const RichSearchResults: React.FC<{ block: RichContentBlock }> = React.memo(
  ({ block }) => {
    const { t } = useTranslation('chat')
    const results = (block.search_results ?? []) as SearchResultItem[]
    // 整卡折叠：与其他工具卡（ToolStepCard）一致，成功结果默认折叠，点 header 展开。
    const [open, setOpen] = useState(false)
    // 列表截断：卡片展开后仍先只显示前 5 条，>5 时提供"显示全部"。
    const [showAll, setShowAll] = useState(results.length <= COLLAPSED_LIMIT)
    const visible = useMemo(
      () => (showAll ? results : results.slice(0, COLLAPSED_LIMIT)),
      [showAll, results],
    )

    const header = (
      <Header
        query={block.query}
        count={block.total_count ?? results.length}
        shown={results.length}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        t={t}
      />
    )

    if (results.length === 0) {
      return (
        <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
          {header}
          {open && (
            <div className="px-3 py-4 text-caption text-muted-foreground text-center">
              {t('richContent.searchResults.noResults')}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
        {header}
        {open && (
          <>
            <div className="max-h-[420px] overflow-auto">
              <div className="flex flex-col">
                {visible.map((item, i) => (
                  <ResultRow key={i} item={item} t={t} />
                ))}
              </div>
            </div>
            {!showAll && results.length > COLLAPSED_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="px-3 py-1.5 bg-muted/20 border-t border-border/20 text-caption text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors text-left"
              >
                {t('richContent.searchResults.showAll', {
                  shown: COLLAPSED_LIMIT,
                  total: results.length,
                })}
              </button>
            )}
          </>
        )}
      </div>
    )
  },
)

const Header: React.FC<{
  query?: string
  count: number
  shown: number
  open: boolean
  onToggle: () => void
  t: TFn
}> = ({ query, count, shown, open, onToggle, t }) => {
  // 双层一致性：当 total_count 大于本次返回的 shown 时显式提示 "M / N"，
  // 避免用户看到 "12 条" badge 但只渲染 5 条 → 误以为前端坏了或与 LLM 总数不一致。
  const showsTruncationHint = count > shown && shown > 0
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`w-full px-3 py-1.5 bg-muted/30 flex items-center gap-2 text-left hover:bg-muted/40 transition-colors${
        open ? ' border-b border-border/20' : ''
      }`}
    >
      <Search className="h-3 w-3 text-muted-foreground/80 shrink-0" aria-hidden />
      {query ? (
        <code className="text-caption font-mono text-muted-foreground truncate flex-1" title={query}>
          {query}
        </code>
      ) : (
        <span className="text-caption text-muted-foreground/60 flex-1">
          {t('richContent.searchResults.noQuery')}
        </span>
      )}
      <span className="text-caption text-muted-foreground/60 tabular-nums shrink-0">
        {showsTruncationHint
          ? t('richContent.searchResults.showingOf', { shown, total: count })
          : t('richContent.searchResults.count', { count })}
      </span>
      {open ? (
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" aria-hidden />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" aria-hidden />
      )}
    </button>
  )
}
