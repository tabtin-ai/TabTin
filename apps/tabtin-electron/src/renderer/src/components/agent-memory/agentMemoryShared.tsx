/**
 * Agent 记忆治理面共享 hook / 卡片零件（ W5 抽公共）。
 *
 * ``AgentDiaryFeed``（成长记录）与 ``AgentMemoryGovernancePanel.FactsList``
 * （事实与经验）原本各自维护一份几乎相同的「列表控制器」（加载 / 翻页 /
 * 有用 / 纠正 / 忘记 + busy / error 态）与「记忆卡零件」（内联更正编辑器 +
 * 有用/纠正/忘记 动作行）。这里收口成共享 hook + 组件，行为保持不变，
 * 文案统一走 ``agentMemory`` i18n namespace（zh + en）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Check, X, Heart, MessageCircle, Trash2 } from 'lucide-react'
import { Button, toast } from '@components/ui'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import {
  AgentMemoryApi,
  AgentMemoryApiError,
  type AgentMemory,
  type AgentMemoryType,
} from '@/services/agentMemoryApi'

const log = createLogger('AgentMemory')

// ── 列表控制器 hook ──────────────────────────────────────────────

export interface UseAgentMemoryListOptions {
  organizationId: string
  agentId?: string
  /** 只拉某类型（``diary`` 用于成长记录；不传=事实/经验混合）。 */
  memoryType?: AgentMemoryType
  /**
   * 未指定 ``memoryType`` 时是否前端再滤掉 ``diary``（事实面「全部」用——
   * 成长记录独占 diary tab）。指定 memoryType 时后端已过滤，本项无效。
   */
  excludeDiary?: boolean
  pageSize?: number
}

/**
 * Agent 记忆列表控制器：加载 / 翻页 / 有用 / 纠正 / 忘记 + busy / error / 待忘记
 * 目标态。全部走 ``/agent-memory`` 领域端点（AgentMemoryApi），严格 per-Agent
 * （缺 scope 时不请求、置空）。
 *
 *  治理闭环缺口：本 hook 只服务于治理 UI（FactsList / AgentDiaryFeed），
 * 因此列表请求总是带 ``governanceView: true``——总闸关闭时后端仍放行读取
 * 历史条目，让用户能找到旧记忆点「忘记」；这不代表运行时召回/注入放宽（召回
 * 路径是完全独立的 recall.py，不经过这里，也从不传该参数）。
 */
export function useAgentMemoryList(opts: UseAgentMemoryListOptions) {
  const {
    organizationId,
    agentId,
    memoryType,
    excludeDiary = false,
    pageSize = 30,
  } = opts
  const { t } = useTranslation('agentMemory')

  const [memos, setMemos] = useState<AgentMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [forgetTarget, setForgetTarget] = useState<string | null>(null)

  const scope = useMemo(
    () => (organizationId && agentId ? { organizationId, agentId } : null),
    [organizationId, agentId],
  )

  // 乱序响应守卫：快速切筛选（memoryType）时，只认最新一次请求的结果，避免
  // 旧筛选的响应后到覆盖新筛选视图。翻页 in-flight 守卫：防连点重复 append 同一页。
  const reqSeqRef = useRef(0)
  const loadingMoreRef = useRef(false)

  const load = useCallback(
    async (append = false) => {
      if (!scope) {
        setMemos([])
        setLoading(false)
        return
      }
      if (append) {
        if (loadingMoreRef.current) return
        loadingMoreRef.current = true
      }
      const myReq = ++reqSeqRef.current
      if (!append) {
        setLoading(true)
        setLoadError(null)
      }
      try {
        const data = await AgentMemoryApi.listMemories(scope, {
          state: 'active',
          limit: pageSize,
          memoryType: memoryType || undefined,
          governanceView: true,
          ...(append && cursor ? { cursor } : {}),
        })
        // 已被更新的请求取代 → 丢弃本次结果（stale），不 setState。
        if (myReq !== reqSeqRef.current) return
        const raw = data.items || []
        // 事实面「全部」时前端滤掉 diary（diary 在成长记录 tab）；按类型过滤时
        // 后端已只返回该类型，无需再滤。
        const items =
          excludeDiary && !memoryType
            ? raw.filter(m => m.memory_type !== 'diary')
            : raw
        setMemos(prev => (append ? [...prev, ...items] : items))
        setCursor(data.next_cursor || '')
        setHasMore(!!data.next_cursor)
        setLoadError(null)
      } catch (err) {
        if (myReq !== reqSeqRef.current) return
        // 加载失败要显式暴露成错误态（可重试），别伪装成空态。
        if (!append) {
          setLoadError(
            err instanceof AgentMemoryApiError
              ? err.message
              : t('errors.loadFailed', { defaultValue: '加载失败，请重试' }),
          )
        } else {
          toast({
            description: t('errors.loadMoreFailed', { defaultValue: '加载更多失败，请重试' }),
            variant: 'destructive',
          })
        }
        log.error('加载 Agent 记忆失败', { organizationId, agentId, memoryType }, err)
      } finally {
        if (append) loadingMoreRef.current = false
        // 仅最新请求负责关 loading，避免 stale 响应把新请求的 loading 提前翻掉。
        if (myReq === reqSeqRef.current) setLoading(false)
      }
    },
    [scope, cursor, memoryType, excludeDiary, pageSize, organizationId, agentId, t],
  )

  useEffect(() => {
    setCursor('')
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, agentId, memoryType])

  const handleUseful = useCallback(
    async (memoId: string) => {
      if (!scope) return
      setBusyId(memoId)
      try {
        const updated = await AgentMemoryApi.feedbackMemory(memoId, scope, { useful: true })
        setMemos(prev => prev.map(m => (m.id === memoId ? { ...m, importance: updated.importance } : m)))
      } catch (err) {
        toast({
          description:
            err instanceof AgentMemoryApiError
              ? err.message
              : t('errors.actionFailed', { defaultValue: '操作失败' }),
          variant: 'destructive',
        })
        log.warn('反馈记忆重要度失败', { memoId }, err)
      } finally {
        setBusyId(null)
      }
    },
    [scope, t],
  )

  const handleCorrect = useCallback(
    async (memoId: string, content: string) => {
      if (!scope) return
      setBusyId(memoId)
      try {
        // 纠正会归档原行、新建替代行——用替代行替换列表项（保持位置）。
        const replacement = await AgentMemoryApi.correctMemory(memoId, scope, { content })
        setMemos(prev => prev.map(m => (m.id === memoId ? replacement : m)))
        toast({ description: t('toast.corrected', { defaultValue: '已更正这条记忆' }) })
      } catch (err) {
        toast({
          description:
            err instanceof AgentMemoryApiError
              ? err.message
              : t('errors.correctFailed', { defaultValue: '更正失败' }),
          variant: 'destructive',
        })
        throw err
      } finally {
        setBusyId(null)
      }
    },
    [scope, t],
  )

  const doForget = useCallback(
    async (memoId: string) => {
      if (!scope) return
      setBusyId(memoId)
      try {
        await AgentMemoryApi.forgetMemory(memoId, scope)
        setMemos(prev => prev.filter(m => m.id !== memoId))
      } catch (err) {
        toast({
          description:
            err instanceof AgentMemoryApiError
              ? err.message
              : t('errors.actionFailed', { defaultValue: '操作失败' }),
          variant: 'destructive',
        })
      } finally {
        setBusyId(null)
        setForgetTarget(null)
      }
    },
    [scope, t],
  )

  const reload = useCallback(() => {
    setCursor('')
    void load(false)
  }, [load])

  const loadMore = useCallback(() => {
    void load(true)
  }, [load])

  return {
    scope,
    memos,
    setMemos,
    loading,
    loadError,
    hasMore,
    busyId,
    forgetTarget,
    setForgetTarget,
    load,
    loadMore,
    reload,
    handleUseful,
    handleCorrect,
    doForget,
  }
}

// ── 内联更正编辑 hook ────────────────────────────────────────────

/** 记忆卡内联「更正」编辑态：editing / draft / saving + 保存/取消。行为与
 *  DiaryCard / FactRow 原逻辑一致（空或未改则取消，不发请求）。 */
export function useInlineMemoryEdit(
  memo: AgentMemory,
  onCorrect: (id: string, content: string) => Promise<void>,
) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memo.content)
  const [saving, setSaving] = useState(false)

  const startEdit = useCallback(() => {
    setDraft(memo.content)
    setEditing(true)
  }, [memo.content])

  const cancel = useCallback(() => {
    setEditing(false)
    setDraft(memo.content)
  }, [memo.content])

  const save = useCallback(async () => {
    const next = draft.trim()
    if (!next || next === memo.content) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onCorrect(memo.id, next)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }, [draft, memo.content, memo.id, onCorrect])

  return { editing, draft, setDraft, saving, startEdit, cancel, save }
}

// ── 共享卡片零件 ─────────────────────────────────────────────────

/** 内联更正编辑器（textarea + 取消/保存），DiaryCard / FactRow 共用。 */
export const MemoryCorrectEditor: React.FC<{
  draft: string
  saving: boolean
  onDraftChange: (v: string) => void
  onCancel: () => void
  onSave: () => void
}> = ({ draft, saving, onDraftChange, onCancel, onSave }) => (
  <div className="flex flex-col gap-2">
    <textarea
      value={draft}
      onChange={e => onDraftChange(e.target.value)}
      rows={3}
      autoFocus
      disabled={saving}
      className="w-full resize-y rounded-md border border-border/40 bg-background px-2.5 py-1.5 text-body text-foreground focus:outline-none focus:border-accent/60"
    />
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" disabled={saving} onClick={onSave}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
      </Button>
    </div>
  </div>
)

/** 记忆卡动作行（有用 / 纠正 / 忘记），hover 显现。DiaryCard / FactRow 共用；
 *  ``className`` 兼容两处细微的外边距差异。 */
export const MemoryActionRow: React.FC<{
  busy: boolean
  onUseful: () => void
  onEdit: () => void
  onForget: () => void
  className?: string
}> = ({ busy, onUseful, onEdit, onForget, className }) => {
  const { t } = useTranslation('agentMemory')
  return (
    <div
      className={cn(
        'flex items-center gap-1 pt-2 border-t border-border/20 opacity-0 group-hover:opacity-100 transition-opacity',
        className,
      )}
    >
      <button
        onClick={onUseful}
        disabled={busy}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-caption text-muted-foreground/60 hover:text-rose-500 hover:bg-rose-500/5 transition-colors disabled:opacity-50"
      >
        <Heart className="h-3 w-3" />
        <span>{t('actions.useful', { defaultValue: '有用' })}</span>
      </button>
      <button
        onClick={onEdit}
        disabled={busy}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-caption text-muted-foreground/60 hover:text-amber-500 hover:bg-amber-500/5 transition-colors disabled:opacity-50"
      >
        <MessageCircle className="h-3 w-3" />
        <span>{t('actions.correct', { defaultValue: '纠正' })}</span>
      </button>
      <button
        onClick={onForget}
        disabled={busy}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-caption text-muted-foreground/60 hover:text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
      >
        <Trash2 className="h-3 w-3" />
        <span>{t('actions.forget', { defaultValue: '忘记' })}</span>
      </button>
    </div>
  )
}
