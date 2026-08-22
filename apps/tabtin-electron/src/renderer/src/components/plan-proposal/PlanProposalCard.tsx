/**
 * PlanProposalCard — Plan 草稿的 inline 卡片
 *
 * 由 `MessageBubble` 在 system 消息且 `metadata.kind === 'plan_proposal'` 时
 * 渲染。视觉与交互对齐 Plan Card 视觉与交互：
 *   - 默认折叠：标题 + Summary + 前 3 条 todos + 展开按钮
 *   - 右上角主按钮「执行」：执行后变「已执行」disabled
 *   - 右上角次要按钮「打开文档」：跳到 tabdoc 标签页继续编辑
 *   - 多份 plan 卡片在 chat 历史中独立保留、各自可点击执行
 *
 * ：「执行」为纯 renderer 行为——标记 executed → setAgentMode('agent') →
 * 用卡片快照 markdown + plan_ref 拼继续消息发送（不再走 IPC + Django /plan/exit）。
 * 「打开」按 plan_ref 分派（document → TabDoc；file 本机 → 文件树；file 遥控 → WS 预览）。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, toast } from '@tabtin/smartsheet-ui'
import { ChevronDown, ChevronUp, ExternalLink, Loader2, ListChecks } from 'lucide-react'
import { resolvePlanRef, planRefToLegacyId, planRefKey, type PlanRef } from '@tabtin/agent-wire'
import { cn } from '@/utils/cn'
import { MarkdownRenderer } from '@components/chat/markdown/MarkdownRenderer'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'
import { openPlanRef } from '@/services/planContentProvider'
import { isPlanExecuted } from './planExecutedStore'
import { sendPlanExecution } from './planExecute'
import { createLogger } from '@/utils/logger'

const log = createLogger('PlanProposalCard')

const COLLAPSED_TODO_PREVIEW = 3

const TODO_STATUS_DOT: Record<string, string> = {
  pending: 'bg-muted-foreground/40',
  in_progress: 'bg-warning',
  completed: 'bg-success',
  cancelled: 'bg-destructive/60',
}

export interface PlanProposalMetadata {
  /** 统一 plan 指针。过渡期由 plan_document_id 回退推导。 */
  plan_ref: PlanRef
  /** 过渡兼容：旧字段（document 载体 = id；file 载体 = 相对路径 / ref key）。 */
  plan_document_id: string
  /** 快照 */
  plan_name: string
  overview: string
  description_markdown: string
  todos: ReadonlyArray<{
    id: string
    content: string
    status: string
  }>
  /** 用户点过执行后由 ChatStore 写回，避免重复执行 */
  executed?: boolean
}

/**
 * 从 ChatMessage.metadata 抽取并校验 plan_proposal payload。
 * 不合法时返回 null —— MessageBubble 会回退到默认 system 渲染。
 */
export function extractPlanProposalMetadata(metadata: unknown): PlanProposalMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null
  const meta = metadata as Record<string, unknown>
  if (meta.kind !== 'plan_proposal') return null
  const payload = meta.plan_proposal
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  // ：优先 plan_ref，回退 plan_document_id（旧卡片 / 旧事件）。
  const ref = resolvePlanRef({
    plan_ref: p.plan_ref as PlanRef | undefined,
    plan_document_id: typeof p.plan_document_id === 'string' ? p.plan_document_id : undefined,
  })
  if (!ref) return null
  const todosRaw = Array.isArray(p.todos) ? (p.todos as Array<Record<string, unknown>>) : []
  return {
    plan_ref: ref,
    plan_document_id:
      typeof p.plan_document_id === 'string' && p.plan_document_id
        ? p.plan_document_id
        : planRefToLegacyId(ref),
    plan_name: typeof p.plan_name === 'string' ? p.plan_name : '',
    overview: typeof p.overview === 'string' ? p.overview : '',
    description_markdown: typeof p.description_markdown === 'string' ? p.description_markdown : '',
    todos: todosRaw.map((t, idx) => ({
      id: typeof t.id === 'string' && t.id ? (t.id as string) : `todo-${idx}`,
      content: typeof t.content === 'string' ? t.content : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
    })),
    executed: p.executed === true,
  }
}

/**
 * ：从持久化的 `tabtin_rich_content` kind='plan' block（payload 已被 adapter 摊平到
 * 顶层）构造 PlanProposalMetadata。block 只存 plan_ref + 轻量展示字段，不含正文 markdown。
 */
export function planMetadataFromRichBlock(block: Record<string, unknown>): PlanProposalMetadata | null {
  const ref = resolvePlanRef({
    plan_ref: block.plan_ref as PlanRef | undefined,
    plan_document_id: typeof block.plan_document_id === 'string' ? block.plan_document_id : undefined,
  })
  if (!ref) return null
  const todosRaw = Array.isArray(block.todos) ? (block.todos as Array<Record<string, unknown>>) : []
  return {
    plan_ref: ref,
    plan_document_id:
      typeof block.plan_document_id === 'string' && block.plan_document_id
        ? block.plan_document_id
        : planRefToLegacyId(ref),
    plan_name: typeof block.plan_name === 'string' ? block.plan_name : (typeof block.summary === 'string' ? block.summary : ''),
    overview: typeof block.overview === 'string' ? block.overview : '',
    // 持久化 block 不存正文；正文由「打开/执行」按 plan_ref 懒读。
    description_markdown: '',
    todos: todosRaw.map((t, idx) => ({
      id: typeof t.id === 'string' && t.id ? (t.id as string) : `todo-${idx}`,
      content: typeof t.content === 'string' ? t.content : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
    })),
    executed: block.executed === true,
  }
}

interface PlanProposalCardProps {
  metadata: PlanProposalMetadata
  /** 当前 chat session id —— 反查 spaceId 打开文档 + 执行时透传 */
  sessionId: string | null
  /** ChatMessage.id —— 保留给调用方（ 后 executed 走本地持久化，不再回写消息 metadata） */
  messageId?: string
}

export const PlanProposalCard: React.FC<PlanProposalCardProps> = ({
  metadata,
  sessionId,
}) => {
  const { t } = useTranslation('plan')
  const [expanded, setExpanded] = useState(false)
  const [executing, setExecuting] = useState(false)

  // ：卡片已是持久化 block；executed 用 localStorage（keyed by plan_ref）持久化，
  // 与 block.executed 做「或」——重启后仍显示已执行。
  const refKey = useMemo(() => planRefKey(metadata.plan_ref), [metadata.plan_ref])
  const [executed, setExecuted] = useState<boolean>(
    () => metadata.executed || isPlanExecuted(refKey),
  )

  // 反查 spaceId（chat / tabdoc 同 space）：用于打开时确定目标标签页
  const spaceId = useChatStore(useCallback((s) => {
    if (!sessionId) return null
    const entry = Object.entries(s.currentSessionIdBySpaceId).find(([, sid]) => sid === sessionId)
    return entry?.[0] ?? null
  }, [sessionId]))

  const { isRemoteViewer } = useIsRemoteViewer(spaceId ?? undefined)

  // ：按 plan_ref 分派打开（document → TabDoc；file 本机 → 文件树；file 遥控 → WS 预览）。
  const handleOpenDoc = useCallback(() => {
    void openPlanRef({
      ref: metadata.plan_ref,
      spaceId,
      sessionId,
      planName: metadata.plan_name,
      isRemoteViewer,
    }).catch((err) => log.warn('openPlanRef failed', err))
  }, [metadata.plan_ref, metadata.plan_name, spaceId, sessionId, isRemoteViewer])

  const todoStatusLabel = useCallback((status: string): string => {
    const knownStatuses = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
    if (knownStatuses.has(status)) {
      return t(`proposal.todoStatus.${status}`)
    }
    return t('proposal.todoStatus.unknown')
  }, [t])

  const handleExecute = useCallback(async () => {
    if (executing || executed) return
    if (!sessionId) {
      toast({
        title: t('proposal.executeErrorNoSession'),
        variant: 'destructive',
      })
      return
    }
    setExecuting(true)
    try {
      // ：执行 = 切 agent + 发「计划」context 卡片（与 .plan.md 文件预览共用
      // sendPlanExecution）。仅在发送成功后才置「已执行」——失败不锁死，可重试。
      const ok = await sendPlanExecution({
        ref: metadata.plan_ref,
        planName: metadata.plan_name,
        sessionId,
        spaceId,
      })
      if (ok) {
        setExecuted(true)
        toast({
          title: metadata.plan_name
            ? t('proposal.executeSuccess', { name: metadata.plan_name })
            : t('proposal.executeSuccessNoName'),
          duration: 2000,
        })
      } else {
        toast({
          title: t('proposal.executeErrorSend'),
          variant: 'destructive',
        })
      }
    } finally {
      setExecuting(false)
    }
  }, [executing, executed, metadata.plan_ref, metadata.plan_name, spaceId, sessionId, t])

  const previewTodos = useMemo(
    () => (expanded ? metadata.todos : metadata.todos.slice(0, COLLAPSED_TODO_PREVIEW)),
    [expanded, metadata.todos],
  )
  const remainingTodoCount = Math.max(metadata.todos.length - COLLAPSED_TODO_PREVIEW, 0)
  // ：document 载体打开 TabDoc；file 载体打开文件树 / 远程预览——都只需 spaceId。
  const canOpenDoc = !!spaceId
  const isExecuted = executed
  const planTitle = metadata.plan_name || t('proposal.headerTitle')

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/40 bg-background/80 px-4 py-3 my-2">
      <header className="flex items-start gap-2">
        <ListChecks className="h-4 w-4 shrink-0 mt-1 text-primary/80" />
        <div className="min-w-0 flex-1">
          <p className="text-subtitle font-medium leading-snug break-words [overflow-wrap:anywhere]">
            {planTitle}
          </p>
          {metadata.overview && (
            <p className="mt-0.5 text-caption text-muted-foreground leading-snug break-words [overflow-wrap:anywhere]">
              <span className="text-muted-foreground/60 mr-1">{t('proposal.summaryLabel')}：</span>
              {metadata.overview}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canOpenDoc && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-caption"
              onClick={handleOpenDoc}
              data-testid="plan-proposal-open-doc"
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              {t('proposal.openDocButton')}
            </Button>
          )}
          <Button
            size="sm"
            variant={isExecuted ? 'outline' : 'default'}
            className="h-7"
            disabled={executing || isExecuted}
            onClick={handleExecute}
            data-testid="plan-proposal-execute"
          >
            {executing ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                {t('proposal.executingButton')}
              </>
            ) : isExecuted ? (
              t('proposal.executedButton')
            ) : (
              t('proposal.executeButton')
            )}
          </Button>
        </div>
      </header>

      <section>
        <p className="mb-1 text-caption text-muted-foreground/80">
          {t('proposal.todosLabel', { count: metadata.todos.length })}
        </p>
        {metadata.todos.length === 0 ? (
          <p className="text-caption text-muted-foreground/60">{t('proposal.todosEmpty')}</p>
        ) : (
          <ul className="space-y-1">
            {previewTodos.map((todo) => (
              <li
                key={todo.id}
                className="flex items-start gap-2 rounded-md border border-border/20 bg-background/40 px-3 py-1.5"
              >
                <span
                  className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TODO_STATUS_DOT[todo.status] ?? 'bg-muted-foreground/60')}
                  aria-label={todoStatusLabel(todo.status)}
                  title={todoStatusLabel(todo.status)}
                />
                <p className="text-body leading-snug text-foreground/90 break-words [overflow-wrap:anywhere]">
                  {todo.content}
                </p>
              </li>
            ))}
            {!expanded && remainingTodoCount > 0 && (
              <li className="px-1 text-caption text-muted-foreground/60">
                +{remainingTodoCount}…
              </li>
            )}
          </ul>
        )}
      </section>

      {expanded && metadata.description_markdown.trim().length > 0 && (
        <section className="rounded-md border border-border/30 bg-muted/15 px-3 py-2">
          <MarkdownRenderer content={metadata.description_markdown} />
        </section>
      )}

      {(metadata.todos.length > COLLAPSED_TODO_PREVIEW ||
        metadata.description_markdown.trim().length > 0) && (
        <button
          type="button"
          className="self-start inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((v) => !v)}
          data-testid="plan-proposal-toggle"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              {t('proposal.collapseButton')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              {t('proposal.expandButton')}
            </>
          )}
        </button>
      )}
    </div>
  )
}
