/**
 * OrgAgentDiaryFeed — Organization 级跨 Agent「工作日记」只读流。
 *
 * 数据源：``GET /agent-memory/diary-feed/``（与移动端同一正典）。
 * 不读写旧 TabMemo ``source=agent + memo_type=diary``，也不混排猜重。
 * per-Agent 治理动作仍走 ``AgentDiaryFeed``（纠正 / 忘记 / 有用）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button, Input, ScrollArea } from '@components/ui'
import { cn } from '@utils/cn'
import { getCurrentLanguage } from '@/i18n'
import { createLogger } from '@/utils/logger'
import {
  AgentMemoryApi,
  type OrgDiaryFeedItem,
} from '@/services/agentMemoryApi'

const log = createLogger('OrgAgentDiaryFeed')
const PAGE_SIZE = 30

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffHour < 24) return `${diffHour} 小时前`
  if (diffDay < 7) return `${diffDay} 天前`
  return date.toLocaleDateString(getCurrentLanguage(), { month: 'short', day: 'numeric' })
}

export const OrgAgentDiaryFeed: React.FC<{
  organizationId: string
  className?: string
}> = ({ organizationId, className }) => {
  const { t } = useTranslation('agentMemory')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<OrgDiaryFeedItem[]>([])
  const [nextCursor, setNextCursor] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    if (!organizationId) return
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const page = await AgentMemoryApi.listOrgDiaryFeed(organizationId, {
        search: search || undefined,
        state: 'active',
        limit: PAGE_SIZE,
      })
      if (seq !== seqRef.current) return
      setItems(page.items)
      setNextCursor(page.next_cursor || '')
      setHasMore(Boolean(page.has_more))
      setMemoryEnabled(page.memory_enabled !== false)
    } catch (err) {
      if (seq !== seqRef.current) return
      const message = err instanceof Error ? err.message : 'Load failed'
      log.error('org diary feed load failed', { organizationId, error: err })
      setError(message)
      setItems([])
      setHasMore(false)
      setNextCursor('')
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [organizationId, search])

  const loadMore = useCallback(async () => {
    if (!organizationId || !hasMore || !nextCursor || loadingMore) return
    const seq = seqRef.current
    setLoadingMore(true)
    try {
      const page = await AgentMemoryApi.listOrgDiaryFeed(organizationId, {
        search: search || undefined,
        state: 'active',
        cursor: nextCursor,
        limit: PAGE_SIZE,
      })
      if (seq !== seqRef.current) return
      setItems(prev => {
        const seen = new Set(prev.map(item => item.id))
        return [...prev, ...page.items.filter(item => !seen.has(item.id))]
      })
      setNextCursor(page.next_cursor || '')
      setHasMore(Boolean(page.has_more))
    } catch (err) {
      if (seq !== seqRef.current) return
      log.error('org diary feed loadMore failed', { organizationId, error: err })
    } finally {
      if (seq === seqRef.current) setLoadingMore(false)
    }
  }, [organizationId, hasMore, nextCursor, loadingMore, search])

  useEffect(() => {
    void load()
    return () => {
      seqRef.current += 1
    }
  }, [load])

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 px-5 py-2">
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          <span>
            {t('workbench.orgDiaryHint', {
              defaultValue: '来自你可用 Agent 的工作日记（AgentMemory）',
            })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('diary.searchPlaceholder', { defaultValue: '搜索 Agent 日记' })}
            className="h-8 w-48"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="h-7 px-2"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-5 py-4">
          {loading && items.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-body">{t('label.loading', { defaultValue: '加载中…' })}</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <p className="text-body text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                {t('actions.retry', { defaultValue: '重试' })}
              </Button>
            </div>
          )}

          {!loading && !error && !memoryEnabled && (
            <div className="py-16 text-center text-body text-muted-foreground">
              {t('empty.memoryDisabled', {
                defaultValue: '记忆已关闭，日记不可用',
              })}
            </div>
          )}

          {!loading && !error && memoryEnabled && items.length === 0 && (
            <div className="py-16 text-center text-body text-muted-foreground">
              {t('workbench.orgDiaryEmpty', { defaultValue: '还没有 Agent 日记' })}
            </div>
          )}

          {items.map(item => (
            <article
              key={item.id}
              className="rounded-lg border border-border/40 bg-card/40 px-4 py-3"
            >
              <div className="mb-1.5 flex items-center gap-2 text-caption text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {item.agent_name || t('workbench.unnamedAgent', { defaultValue: '未命名 Agent' })}
                </span>
                <span>·</span>
                <time dateTime={item.created_at}>{formatRelativeTime(item.created_at)}</time>
              </div>
              <p className="whitespace-pre-wrap text-body text-foreground/90">
                {item.content || '—'}
              </p>
              {item.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.tags.map(tag => (
                    <span
                      key={tag}
                      className="rounded bg-muted/50 px-1.5 py-0.5 text-caption text-muted-foreground"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </article>
          ))}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t('actions.loadMore', { defaultValue: '加载更多' })
                )}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
