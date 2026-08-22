/**
 * CheckpointContextCard — 折叠式决策摘要卡片
 *
 * 位于 MessageBubble 的 checkpoint 区域。默认折叠仅显示"展开决策详情"
 * 文字按钮；展开后显示 intent / outcome / key_decisions / open_items。
 *
 * 数据来源：`checkpoint_record.context_summary.decision_summary`
 *
 * 状态（Wave 13）：
 * - `basic`：基础版，仅 intent + outcome（checkpoint 创建瞬间即可用）
 * - `pending`：LLM 增强生成中 — 展示 Loader2 + "决策摘要生成中…" 提示
 * - `ready`：LLM 增强版就绪 — 展示 key_decisions / open_items
 * - `failed`：LLM 生成失败 — 展示明确提示 + 保留 basic 内容
 *
 * 兜底拉取（Wave 13 QC-01）：
 * WS 推送只在用户留在 session 时生效；若用户切换 session 或客户端刷新，
 * 展开时主动 fetch decision-context 拉取最新状态，避免 UI 永远停留在非 ready。
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  ChevronRight, ChevronDown, Lightbulb, CheckCircle2, Pin, ClipboardList,
  Loader2, AlertTriangle, GitBranch,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { DecisionSummary, OutcomeStructured, SubConversationRef } from '@tabtin/chat-client'
import { fetchCheckpointDecisionContext } from '@/services/chatExtraApi'
import { applyDecisionSummaryUpdate } from '@/stores/chat/checkpoint/handlers/checkpointHandler'
import { useChatStore } from '@/stores/chat/useChatStore'
import { toast } from '@tabtin/smartsheet-ui/toast'

interface CheckpointContextCardProps {
  decisionSummary: DecisionSummary
  /**
   * 该 card 归属的 SpaceCheckpoint ID（`CheckpointRecordView.checkpoint_id`）。
   * 用于展开时的兜底拉取；若缺失，兜底降级为仅依赖 WS 推送。
   */
  checkpointId?: string | null
  /** 归属 session，用于将兜底拉取结果 dispatch 回 store。 */
  sessionId?: string | null
  /** 归属 message，用于精确匹配目标 checkpoint_record。 */
  messageId?: string | null
  /**
   * QC-02.C / PRD §3.4 US-3：该 checkpoint 派生的子 Agent 会话列表。
   * 展开态最下方渲染"🔀 含 N 个子任务"入口，点击单个子任务跳转到对应 session/message。
   * 空/未提供时不渲染该区块。
   */
  subConversations?: SubConversationRef[] | null
}

export const CheckpointContextCard: React.FC<CheckpointContextCardProps> = React.memo(({
  decisionSummary,
  checkpointId,
  sessionId,
  messageId,
  subConversations,
}) => {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const navigateToMessage = useChatStore((s) => s.navigateToMessage)

  const subTasks = (subConversations && subConversations.length > 0) ? subConversations : null
  const subTaskCount = subTasks?.length ?? 0

  const { intent, outcome, outcome_structured, key_decisions, open_items, status } = decisionSummary

  const renderedOutcome = useMemo(() => {
    if (!outcome_structured || Object.keys(outcome_structured).length === 0) return outcome || ''
    return formatOutcomeStructured(outcome_structured, t)
  }, [outcome_structured, outcome, t])

  // pending/failed/ready 状态对 UI 展示的影响
  const isPending = status === 'pending'
  const isFailed = status === 'failed'
  const isBasicOnly = status === 'basic' && (!key_decisions || key_decisions.length === 0)
  const hasKeyDecisions = key_decisions && key_decisions.length > 0
  const hasOpenItems = open_items && open_items.length > 0

  // 兜底拉取：展开且非终态时，主动拉取 decision-context。
  //
  // 节流策略（Wave 14 V-03 修正）：
  // - **仅 ready 锁死**（不再把 failed 也锁）。failed 是"本次 LLM 增强失败，
  //   但用户重试/后端重新触发可能由 failed → ready"，锁死会导致"切走再切回"
  //   后永远停留在 failed。ready 才是真正幂等终态。
  // - 非终态（basic/pending/failed）拉取后走 10s 节流，不永久锁。
  //
  // 两道共存保护：
  //   1. 最小间隔：`lastFetchAtRef` 控制 10s 内不重复拉同一 cpId（覆盖 WS 推送已到达）
  //   2. 终态锁：`terminalFetchedCpRef` 拉到 ready 后永久锁
  const terminalFetchedCpRef = useRef<string | null>(null)
  const lastFetchAtRef = useRef<{ cpId: string | null; at: number }>({ cpId: null, at: 0 })
  const FETCH_THROTTLE_MS = 10_000

  useEffect(() => {
    if (!expanded) return
    if (status === 'ready') return
    if (!checkpointId) return
    if (terminalFetchedCpRef.current === checkpointId) return
    const last = lastFetchAtRef.current
    if (last.cpId === checkpointId && Date.now() - last.at < FETCH_THROTTLE_MS) return
    lastFetchAtRef.current = { cpId: checkpointId, at: Date.now() }
    fetchCheckpointDecisionContext(checkpointId).then((res) => {
      if (!res) return
      const freshDecisionSummary = res.context?.decision_summary as DecisionSummary | undefined
      if (!freshDecisionSummary || !freshDecisionSummary.status) return
      // V-03：仅 ready 锁；failed 保持可重试路径。
      if (freshDecisionSummary.status === 'ready') {
        terminalFetchedCpRef.current = checkpointId
      }
      // 即使远端仍为非 ready（pending/basic/failed），也 dispatch 以便让 outcome /
      // key_decisions 等字段在后端已有更丰富值时同步到前端。
      // applyDecisionSummaryUpdate 已做幂等保护，不会把 ready 覆盖回 basic。
      void applyDecisionSummaryUpdate({
        targetSessionId: sessionId || res.anchor_session_id || '',
        messageId: messageId || res.anchor_message_id || null,
        checkpointId,
        decisionSummary: freshDecisionSummary,
      })
    }).catch((err) => {
      console.warn('[CheckpointContextCard] fallback fetch failed:', err)
      // 失败不锁，允许用户再展开时重试
      lastFetchAtRef.current = { cpId: null, at: 0 }
    })
  }, [expanded, status, checkpointId, sessionId, messageId])

  // 点击子任务跳转：navigateToMessage 内部成功路径会自行处理 toast（messageNotFound /
  // messageLoadFailed），此处 catch 兜底 async 层抛错（网络、权限拒绝等），给出明确提示，
  // 避免 Wave 13 之前"按钮无响应"的静默失败（PRD §3.5 / QC-02.C 归档降级体验）。
  const handleSubTaskJump = useCallback(
    async (sub: SubConversationRef) => {
      if (!sub.session_id || !sub.message_id) return
      try {
        await navigateToMessage(sub.session_id, sub.message_id)
      } catch (err) {
        console.warn('[CheckpointContextCard] navigateToMessage failed', err)
        toast({ title: t('subtaskJumpFailed'), variant: 'destructive' })
      }
    },
    [navigateToMessage, t],
  )

  // Wave 13 QC-15 修复：pending/failed 状态也要让用户能看到入口，不再 early return。
  // Wave 14 QC-02.C：即使没有 intent/outcome，只要有子任务入口也值得渲染，
  // 让用户能从聊天面板直接追溯子 Agent 对话（PRD §3.4 US-3）。
  if (!intent && !renderedOutcome && !isPending && !isFailed && !subTasks) return null

  // 折叠态的小标签文本（按钮右侧）
  const inlineStatusLabel = (() => {
    if (isPending) return t('checkpoint.decisionPending')
    if (isFailed) return t('checkpoint.decisionFailed')
    return null
  })()

  return (
    <div className="mt-1.5">
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1 text-caption',
          'transition-colors duration-150',
          isFailed
            ? 'text-warning/80 hover:text-warning'
            : 'text-muted-foreground/60 hover:text-muted-foreground',
        )}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" />
          : <ChevronRight className="h-3 w-3 shrink-0" />
        }
        <span>{expanded ? t('checkpoint.decisionCollapse') : t('checkpoint.decisionToggle')}</span>
        {inlineStatusLabel && (
          <span
            className={cn(
              'ml-1.5 inline-flex items-center gap-1 text-caption',
              isFailed ? 'text-warning/80' : 'text-muted-foreground/60',
            )}
          >
            {isPending && (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />
            )}
            {isFailed && (
              <AlertTriangle className="h-3 w-3 shrink-0" />
            )}
            <span className="italic">{inlineStatusLabel}</span>
          </span>
        )}
      </button>

      <div
        aria-hidden={!expanded}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden min-h-0">
          <div
            className={cn(
              'mt-1.5 space-y-1.5 rounded-md border px-2.5 py-2',
              isFailed
                ? 'border-warning/20 bg-warning/5'
                : 'border-border/20 bg-muted/10',
            )}
          >
            {/* Intent */}
            {intent && (
              <div className="flex items-start gap-1.5">
                <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-accent/80" />
                <div className="min-w-0">
                  <span className="text-caption font-medium text-muted-foreground/80">
                    {t('checkpoint.decisionIntent')}
                  </span>
                  <p className="text-caption text-foreground/80 break-words whitespace-pre-wrap">
                    {intent}
                  </p>
                </div>
              </div>
            )}

            {/* Outcome */}
            {renderedOutcome && (
              <div className="flex items-start gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success/80" />
                <div className="min-w-0">
                  <span className="text-caption font-medium text-muted-foreground/80">
                    {t('checkpoint.decisionOutcome')}
                  </span>
                  <p className="text-caption text-foreground/80 break-words whitespace-pre-wrap">
                    {renderedOutcome}
                  </p>
                </div>
              </div>
            )}

            {/* Key Decisions — 仅 ready 或已有数据才展示 */}
            {!isBasicOnly && hasKeyDecisions && (
              <div className="flex items-start gap-1.5">
                <Pin className="mt-0.5 h-3 w-3 shrink-0 text-warning/80" />
                <div className="min-w-0">
                  <span className="text-caption font-medium text-muted-foreground/80">
                    {t('checkpoint.decisionKeyDecisions')}
                  </span>
                  <ul className="mt-0.5 space-y-0.5">
                    {key_decisions!.map((d, i) => (
                      <li key={`${i}-${d.slice(0, 20)}`} className="text-caption text-foreground/80 break-words pl-0.5">
                        {'· '}{d}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Open Items */}
            {!isBasicOnly && hasOpenItems && (
              <div className="flex items-start gap-1.5">
                <ClipboardList className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
                <div className="min-w-0">
                  <span className="text-caption font-medium text-muted-foreground/80">
                    {t('checkpoint.decisionOpenItems')}
                  </span>
                  <ul className="mt-0.5 space-y-0.5">
                    {open_items!.map((item, i) => (
                      <li key={`${i}-${item.slice(0, 20)}`} className="text-caption text-foreground/80 break-words pl-0.5">
                        {'· '}{item}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Pending：独立提示行，让用户明确知道 LLM 还在生成。
                 与按钮旁的 inline label 互补——折叠态看按钮，展开态看这里。 */}
            {isPending && (
              <div className="flex items-center gap-1.5 pt-0.5">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground/60" />
                <span className="text-caption italic text-muted-foreground/60">
                  {t('checkpoint.decisionPending')}
                </span>
              </div>
            )}

            {/* Failed：显式告知 + 鼓励用户理解 basic 内容足够 */}
            {isFailed && (
              <div className="flex items-start gap-1.5 pt-0.5">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning/80" />
                <div className="min-w-0">
                  <p className="text-caption text-warning/80">
                    {t('checkpoint.decisionFailed')}
                  </p>
                  <p className="text-caption text-muted-foreground/60">
                    {t('checkpoint.decisionFailedHint')}
                  </p>
                </div>
              </div>
            )}

            {/* QC-02 / PRD §3.4 US-3：子任务入口（展开态），按钮点击跳转子 session 消息 */}
            {subTasks && subTaskCount > 0 && (
              <div className="flex items-start gap-1.5 pt-1 border-t border-border/40">
                <GitBranch className="mt-0.5 h-3 w-3 shrink-0 text-accent/80" />
                <div className="min-w-0 flex-1">
                  <div className="text-caption font-medium text-muted-foreground/80">
                    {t('subtasksTitleWithCount', { count: subTaskCount })}
                  </div>
                  <ul className="mt-0.5 space-y-0.5">
                    {subTasks.map((sub) => {
                      const display = sub.label?.trim() || t('subtaskFallbackLabel')
                      const canJump = !!(sub.session_id && sub.message_id)
                      return (
                        <li
                          key={`${sub.session_id}-${sub.message_id}`}
                          className="flex items-start gap-1 text-caption pl-0.5"
                        >
                          <span className="text-foreground/80 truncate min-w-0" title={display}>
                            {'· '}{display}
                          </span>
                          {canJump && (
                            <button
                              type="button"
                              className="shrink-0 text-accent/80 hover:text-accent hover:underline"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleSubTaskJump(sub)
                              }}
                              title={t('subtaskJump')}
                            >
                              {t('subtaskJump')} →
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
CheckpointContextCard.displayName = 'CheckpointContextCard'

const RESOURCE_TYPE_I18N_KEYS: Record<string, string> = {
  table: 'rewind.resourceType.table',
  docs: 'rewind.resourceType.docs',
  design: 'rewind.resourceType.design',
  slide: 'rewind.resourceType.slide',
  video: 'rewind.resourceType.video',
  canvas: 'rewind.resourceType.canvas',
}

function formatOutcomeStructured(
  data: OutcomeStructured,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = []

  const { files_changed, insertions, deletions, resources } = data
  if (files_changed || insertions || deletions) {
    const sub: string[] = []
    if (insertions) sub.push(t('checkpoint.outcomeInsertions', { count: insertions }))
    if (deletions) sub.push(t('checkpoint.outcomeDeletions', { count: deletions }))
    let seg = t('checkpoint.outcomeFilesChanged', { count: files_changed ?? 0 })
    if (sub.length) seg += t('checkpoint.outcomeSeparator') + sub.join(t('checkpoint.outcomeSeparator'))
    parts.push(seg)
  }

  if (resources?.length) {
    const segs = resources.map(({ type, count }) => {
      const key = RESOURCE_TYPE_I18N_KEYS[type]
      const label = key ? t(key) : type
      return t('checkpoint.outcomeResourceItem', { count, type: label })
    })
    parts.push(t('checkpoint.outcomeResourcesUpdated', { list: segs.join(t('checkpoint.outcomeSeparator')) }))
  }

  return parts.join(t('checkpoint.outcomeJoiner')) || t('checkpoint.outcomeDefault')
}
