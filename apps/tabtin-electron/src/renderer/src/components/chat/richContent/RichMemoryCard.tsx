/* eslint-disable tabtin/no-chat-design-violations -- 重要度星标（amber ★ 评分）是记忆卡的领域评级色，等同评分/标记约定色，非 UI 警示色 */
/**
 * `memory_card` kind renderer (W7) — used by memory_search.
 *
 * Each memory shows: type chip + content (line-clamp 3) + tags + relative time.
 * Layout is denser than search_results because users are skimming "do I remember
 * this" rather than browsing search hits.
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Link2 } from 'lucide-react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { openAgentMemory } from '@/services/agentMemoryNavigation'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { formatRichRelativeTime } from './relativeTime'

const COLLAPSED_LIMIT = 5

type TFn = (key: string, options?: Record<string, unknown>) => string

interface MemoryItem {
  id?: string
  content?: string
  memo_type?: string
  tags?: string[]
  importance?: number
  created_at?: string
  source_url?: string
}

const MemoryRow: React.FC<{
  item: MemoryItem
  t: TFn
  onOpen?: () => void
}> = ({ item, t, onOpen }) => {
  const content = item.content ?? ''
  const relative = item.created_at ? formatRichRelativeTime(item.created_at, t) : ''

  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      } : undefined}
      className={
        onOpen
          ? 'flex flex-col gap-1 px-3 py-2 border-b border-border/10 last:border-0 hover:bg-muted/15 transition-colors cursor-pointer'
          : 'flex flex-col gap-1 px-3 py-2 border-b border-border/10 last:border-0 hover:bg-muted/15 transition-colors'
      }
    >
      <div className="flex items-center gap-2 text-caption text-muted-foreground/80">
        {item.memo_type && (
          <span className="px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono">
            {item.memo_type}
          </span>
        )}
        {typeof item.importance === 'number' && item.importance > 0 && (
          <span className="text-amber-500" aria-label={t('richContent.memory.importanceLabel', { count: item.importance })}>
            {'★'.repeat(Math.min(5, Math.max(0, item.importance)))}
          </span>
        )}
        <span className="flex-1" />
        {relative && (
          <span title={item.created_at} className="tabular-nums shrink-0">
            {relative}
          </span>
        )}
      </div>
      <p className="text-caption text-foreground line-clamp-3 whitespace-pre-wrap break-words">
        {content || <span className="text-muted-foreground/60">{t('richContent.memory.emptyContent')}</span>}
      </p>
      {(Array.isArray(item.tags) && item.tags.length > 0) || item.source_url ? (
        <div className="flex flex-wrap items-center gap-1">
          {Array.isArray(item.tags) && item.tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 rounded bg-accent/10 text-accent text-caption font-mono"
            >
              #{tag}
            </span>
          ))}
          {/* source_url 形如 ``thread://session_id`` / ``https://...``。
              Tabtin 内部协议（thread:// 等）不让浏览器打开，仅作 chip 展示
              + tooltip；http(s) 链接走外部锚点。这样保持"用户能看到来源"
              的最小可见性，跳转语义留给后续 onResourceNavigate 接入。 */}
          {item.source_url && /^https?:\/\//.test(item.source_url) ? (
            <a
              href={item.source_url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground text-caption font-mono hover:bg-muted/60 hover:text-foreground transition-colors"
              title={item.source_url}
            >
              <Link2 className="w-3 h-3" aria-hidden />
              <span className="truncate max-w-[160px]">{item.source_url}</span>
            </a>
          ) : item.source_url ? (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground text-caption font-mono"
              title={item.source_url}
            >
              <Link2 className="w-3 h-3" aria-hidden />
              <span className="truncate max-w-[160px]">{item.source_url}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const RichMemoryCard: React.FC<{ block: RichContentBlock }> = React.memo(
  ({ block }) => {
    const { t } = useTranslation('chat')
    const organizationId = useOrganizationStore(s => s.selectedOrganization?.id ?? null)
    // ：runtime 富块 payload 摊平后带 agent_id（data-tools memory_search）；
    // 点击条目深链到「我的 Agent → 记忆」并高亮该条。
    const agentId = typeof block.agent_id === 'string' && block.agent_id ? block.agent_id : null
    const memories = (block.memories ?? []) as MemoryItem[]
    const [expanded, setExpanded] = useState(memories.length <= COLLAPSED_LIMIT)
    const visible = useMemo(
      () => (expanded ? memories : memories.slice(0, COLLAPSED_LIMIT)),
      [expanded, memories],
    )

    const openMemory = (memoryId?: string) => {
      if (!agentId && !memoryId) return
      openAgentMemory({
        organizationId,
        agentId,
        memoryId: memoryId ?? null,
      })
    }

    if (memories.length === 0) {
      return (
        <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
          <Header query={block.query} count={0} t={t} />
          <div className="px-3 py-4 text-caption text-muted-foreground text-center">
            {t('richContent.memory.noMemos')}
          </div>
        </div>
      )
    }

    return (
      <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
        <Header query={block.query} count={block.total_count ?? memories.length} t={t} />
        <div className="max-h-[420px] overflow-auto">
          <div className="flex flex-col">
            {visible.map((item, i) => (
              <MemoryRow
                key={item.id ?? i}
                item={item}
                t={t}
                onOpen={agentId || item.id ? () => openMemory(item.id) : undefined}
              />
            ))}
          </div>
        </div>
        {!expanded && memories.length > COLLAPSED_LIMIT && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-3 py-1.5 bg-muted/20 border-t border-border/20 text-caption text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors text-left"
          >
            {t('richContent.memory.showAll', {
              shown: COLLAPSED_LIMIT,
              total: memories.length,
            })}
          </button>
        )}
        {block.has_more && (
          <div className="px-3 py-1 bg-amber-500/5 border-t border-amber-500/20 text-caption text-amber-700 dark:text-amber-400">
            {t('richContent.memory.hasMore')}
          </div>
        )}
      </div>
    )
  },
)

const Header: React.FC<{ query?: string; count: number; t: TFn }> = ({ query, count, t }) => (
  <div className="px-3 py-1.5 bg-muted/30 border-b border-border/20 flex items-center gap-2">
    <Brain className="h-3 w-3 text-muted-foreground/80 shrink-0" aria-hidden />
    {query ? (
      <code className="text-caption font-mono text-muted-foreground truncate flex-1" title={query}>
        {query}
      </code>
    ) : (
      <span className="text-caption text-muted-foreground flex-1">
        {t('richContent.memory.title')}
      </span>
    )}
    <span className="text-caption text-muted-foreground/60 tabular-nums shrink-0">
      {t('richContent.memory.count', { count })}
    </span>
  </div>
)
