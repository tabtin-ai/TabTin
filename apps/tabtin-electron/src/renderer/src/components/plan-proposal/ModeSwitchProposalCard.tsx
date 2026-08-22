/**
 * ModeSwitchProposalCard — 模式切换审批卡片（通用化，）
 *
 * 方向由 metadata 的 from_mode_id / target_mode_id 决定；文案与续聊提示按 target 动态生成。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Loader2 } from 'lucide-react'
import { Button, toast } from '@tabtin/smartsheet-ui'
import { cn } from '@/utils/cn'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  resolveAgentModeName,
  type AgentModeName,
} from '@stores/chat/shared/types'
import { executeModeSwitch } from '@/services/modeSwitchExecuteApi'
import { recordHitlResolvedKey } from '@/stores/chat/hitl/handlers/hitlStreamHandlers'
import { getSessionController } from '@/services/agentService'
import { extractPlanProposalMetadata } from './PlanProposalCard'
import {
  modeSwitchProposalDescription,
  modeSwitchProposalTitle,
  modeSwitchTargetLabel,
} from './modeSwitchProposalCopy'
import { createLogger } from '@/utils/logger'

const log = createLogger('ModeSwitchProposalCard')

export interface ModeSwitchProposalMetadata {
  proposal_id: string
  /** 目标模式；通用化后可为任意 AgentMode（当前策略只会是 agent）。 */
  target_mode_id: AgentModeName
  /** 来源模式；通用化前的数据缺省回退 plan。 */
  from_mode_id: AgentModeName
  reason: string
  resolved: 'approved' | 'cancelled' | null
}

export function extractModeSwitchProposalMetadata(
  metadata: unknown,
): ModeSwitchProposalMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null
  const meta = metadata as Record<string, unknown>
  if (meta.kind !== 'mode_switch_proposal') return null
  const payload = meta.mode_switch_proposal
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.proposal_id !== 'string' || !p.proposal_id) return null
  const resolved =
    p.resolved === 'approved' || p.resolved === 'cancelled' ? p.resolved : null
  return {
    proposal_id: p.proposal_id,
    target_mode_id: resolveAgentModeName(p.target_mode_id, 'agent'),
    from_mode_id: resolveAgentModeName(p.from_mode_id, 'plan'),
    reason: typeof p.reason === 'string' ? p.reason : '',
    resolved,
  }
}

interface ModeSwitchProposalCardProps {
  metadata: ModeSwitchProposalMetadata
  sessionId: string | null
  messageId: string
}

function messagesHavePendingPlan(
  messages: ReadonlyArray<{ metadata?: unknown }> | undefined,
): boolean {
  if (!messages?.length) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const planMeta = extractPlanProposalMetadata(messages[i]?.metadata)
    if (planMeta && !planMeta.executed) return true
  }
  return false
}

function clearPendingApprovalForSession(sessionId: string): void {
  //  + （第二刀）：清面板前——
  //   1. 记墓碑：switch_mode 已就地 resolve waiter（executeModeSwitch IPC 内完成），
  //      但对应的 tool_approval batch pending 可能还没被 mode 切换连带 cancel 掉
  //      （或已被 `reconfigureSessionModeInPlace` cancel 但 approval_resolved
  //      relay 尚未到达）——墓碑防 reconcileHitlPanelsFromMessages 派生恢复。
  //   2. 显式 cancel-hitl：让 runtime 立即发 HitlInteractionEvent(status='cancelled')，
  //      把 hitl_interaction 消息终态与本地 UI 同步（本刀主治）；已被
  //      soft-reconfigure 提前 cancel 的 pending IPC 返 PENDING_NOT_FOUND，
  //      对本机 UI 无副作用。fire-and-forget。
  const pending = useChatStore.getState().pendingApprovalBySessionId[sessionId]
  if (pending?.batchId) {
    void getSessionController(sessionId)
      .cancelHitlInteraction({
        kind: 'approval',
        requestKey: pending.batchId,
        reason: 'Approval panel closed by mode switch approval.',
      })
      .catch((err) => {
        log.warn('cancel-hitl(approval) after mode switch failed (non-fatal)', err)
      })
  }
  useChatStore.setState((state) => {
    const cur = state.pendingApprovalBySessionId[sessionId]
    if (!cur) return {}
    recordHitlResolvedKey(sessionId, cur.batchId)
    const next = { ...state.pendingApprovalBySessionId }
    delete next[sessionId]
    const nextSubmitting = { ...state.approvalSubmittingBySessionId }
    delete nextSubmitting[sessionId]
    return {
      pendingApprovalBySessionId: next,
      approvalSubmittingBySessionId: nextSubmitting,
    }
  })
}

export const ModeSwitchProposalCard: React.FC<ModeSwitchProposalCardProps> = ({
  metadata,
  sessionId,
  messageId,
}) => {
  const { t } = useTranslation('chat')
  const [submitting, setSubmitting] = useState(false)
  const sessionMessages = useChatStore((s) =>
    sessionId ? s.messagesBySessionId[sessionId] : undefined,
  )

  const hasActivePlan = useMemo(
    () => messagesHavePendingPlan(sessionMessages),
    [sessionMessages],
  )

  const isResolved = metadata.resolved !== null
  const targetModeLabel = useMemo(
    () => modeSwitchTargetLabel(t, metadata.target_mode_id),
    [t, metadata.target_mode_id],
  )
  const fromModeLabel = useMemo(
    () => modeSwitchTargetLabel(t, metadata.from_mode_id),
    [t, metadata.from_mode_id],
  )

  const patchResolved = useCallback(
    (resolved: 'approved' | 'cancelled') => {
      if (!sessionId) return
      useChatStore.getState().patchMessageById(sessionId, messageId, (m) => {
          const meta = (m.metadata ?? {}) as Record<string, unknown>
          const proposal = (meta.mode_switch_proposal ?? {}) as Record<string, unknown>
          return {
            ...m,
            metadata: {
              ...meta,
              mode_switch_proposal: { ...proposal, resolved },
            },
          }
      })
    },
    [messageId, sessionId],
  )

  const handleOutcome = useCallback(
    async (outcome: 'approved' | 'cancelled') => {
      if (submitting || isResolved) return
      if (!sessionId) {
        toast({
          title: t('modeSwitchProposal.errorIpcUnavailable'),
          variant: 'destructive',
        })
        return
      }
      setSubmitting(true)
      try {
        // ：executeModeSwitch 现在走**纯 HITL 路径**——主进程在此 IPC 内
        // 就地 reconfigure runtime 到新模式，并 resolve switch_mode 工具阻塞的 waiter，
        // Agent 在**同一轮**内以新模式继续（不再由 renderer 发续聊用户消息）。
        await executeModeSwitch({
          sessionId,
          proposalId: metadata.proposal_id,
          outcome,
        })
        patchResolved(outcome)
        if (outcome === 'approved') {
          const toMode = metadata.target_mode_id
          clearPendingApprovalForSession(sessionId)
          // 仅同步 renderer 的 UI 模式指示（模式选择器 + 下一条用户消息携带的
          // agentMode）。切换本身已由主进程完成；这里**不**再发续聊消息。
          // 注意：必须同步，否则下一条用户消息会带旧 mode 触发主进程反向 reconfigure。
          try {
            // ：按卡片 sessionId 写入，避免与 currentSessionId 不一致时写错 map，
            // 导致下一条消息仍带 plan 把 Host 打回受限模式。
            useChatStore.getState().setAgentMode(toMode, { sessionId })
          } catch (err) {
            log.warn('setAgentMode UI sync after mode switch failed', err)
          }
        }
      } catch (err) {
        log.warn('mode switch execute failed', err)
        const message = err instanceof Error ? err.message : String(err)
        toast({
          title: t('modeSwitchProposal.error', { message }),
          variant: 'destructive',
        })
      } finally {
        setSubmitting(false)
      }
    },
    [
      submitting,
      isResolved,
      sessionId,
      metadata.proposal_id,
      metadata.target_mode_id,
      patchResolved,
      t,
    ],
  )

  // ：切换成功后模式选择器已给出反馈；审批卡片只在待确认和取消时保留。
  if (metadata.resolved === 'approved') return null

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border border-border/40 bg-background/80 px-4 py-3 my-2',
        isResolved && 'opacity-80',
      )}
    >
      <header className="flex items-start gap-2">
        <ArrowRightLeft className="h-4 w-4 shrink-0 mt-1 text-primary/80" />
        <div className="min-w-0 flex-1">
          <p className="text-subtitle font-medium leading-snug">
            {modeSwitchProposalTitle(t, metadata.target_mode_id)}
          </p>
          <p className="mt-1 text-body text-muted-foreground leading-snug break-words [overflow-wrap:anywhere]">
            {modeSwitchProposalDescription(
              t,
              metadata.target_mode_id,
              metadata.reason,
            )}
          </p>
          <p className="mt-1 text-caption text-muted-foreground/80">
            {fromModeLabel} → {targetModeLabel}
          </p>
          {hasActivePlan && metadata.target_mode_id === 'agent' && (
            <p className="mt-2 text-caption text-warning leading-snug">
              {t('modeSwitchProposal.activePlanHint')}
            </p>
          )}
        </div>
      </header>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={submitting || isResolved}
          onClick={() => void handleOutcome('cancelled')}
          data-testid="mode-switch-cancel"
        >
          {t('modeSwitchProposal.cancelButton')}
        </Button>
        <Button
          size="sm"
          className="h-7"
          disabled={submitting || isResolved}
          onClick={() => void handleOutcome('approved')}
          data-testid="mode-switch-approve"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              {t('modeSwitchProposal.switchingButton')}
            </>
          ) : metadata.resolved === 'cancelled' ? (
            t('modeSwitchProposal.cancelledButton')
          ) : (
            t('modeSwitchProposal.switchButton', {
              targetMode: targetModeLabel,
            })
          )}
        </Button>
      </div>
    </div>
  )
}
