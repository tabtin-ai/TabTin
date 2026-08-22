import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@components/ui'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { openSharedSessionInIm } from '@/components/chat/shared-view/openSharedSessionInIm'
import { formatMessageTimestamp } from '@/lib/dateUtils'
import {
  projectCollaborationCta,
  type CollaborationAction,
  type CollaborationPhase,
  type SharedTaskRole,
} from '@/services/im/cards/sharedTaskCardControl'
import {
  acceptSessionShareV2,
  retrySessionShareV2Delivery,
  type SessionShareInfo,
} from '@/services/tabchatApi'
import type { TabTinSessionShareV2Card } from '@/services/im/cards/tabtinCustomCardModel'
import { SessionCollaborationCard } from './SessionCollaborationCard'
import type { SharedTaskCardAction } from './SharedTaskCardSurface'
import { useSharedTaskLive } from './useSharedTaskLive'

interface Props {
  card: TabTinSessionShareV2Card
  conversationId: string
}

function resolvePhase(entry: ReturnType<typeof useIMStore.getState>['sessionShares'][string]): CollaborationPhase {
  if (!entry?.detail) {
    if (entry?.accessDenied) return 'ineligible'
    return entry?.loadState === 'loading' ? 'sending' : 'detailError'
  }
  const phase = entry.detail.phase
  if (phase === 'sending'
    || phase === 'awaitingJoin'
    || phase === 'activeView'
    || phase === 'activeCollaborate'
    || phase === 'deliveryUnconfirmed'
    || phase === 'stopped'
    || phase === 'ineligible') return phase
  return entry.loadState === 'error' ? 'detailError' : 'sending'
}

function resolveRole(detail: Partial<SessionShareInfo> | null | undefined): SharedTaskRole {
  return detail?.role === 'owner' || detail?.role === 'recipient' ? detail.role : 'observer'
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return ''
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

function runStatusLabel(status: string | null): string {
  const labels: Record<string, string> = {
    queued: '排队中',
    running: '运行中',
    waiting_user: '等待确认',
    paused: '已暂停',
    cancelling: '停止中',
    completed: '已完成',
    failed: '运行失败',
    cancelled: '已取消',
    interrupted: '已中断',
  }
  return status ? labels[status] ?? '尚未运行' : '尚未运行'
}

export function SessionCollaborationCardController({ card, conversationId }: Props) {
  const { t } = useTranslation('tabchat')
  const entry = useIMStore((state) => state.sessionShares[card.object_id])
  const detail = entry?.detail ?? null
  const effectiveShareId = detail?.effective_share_id || card.object_id
  const authoritativePhase = resolvePhase(entry)
  const role = resolveRole(detail)
  const [joining, setJoining] = useState(false)
  const phase: CollaborationPhase = joining ? 'joining' : authoritativePhase

  const reload = useCallback(() => {
    void useIMStore.getState().loadSessionShareV2(card.object_id, card.version)
  }, [card.object_id, card.version])

  useEffect(() => {
    reload()
  }, [reload])

  const live = useSharedTaskLive(phase === 'stopped' ? null : detail, reload)
  const [now, setNow] = useState(() => Date.now())
  const liveRunning = live?.run_state?.status === 'running'
  useEffect(() => {
    if (!liveRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [liveRunning])
  const liveDuration = liveRunning && live?.run_state?.started_at
    ? Math.max(0, now - Date.parse(live.run_state.started_at))
    : live?.duration_ms ?? null
  const runState = live?.run_state ?? null
  const latestRunAt = runState
    ? runState.status === 'running'
      ? runState.started_at
      : runState.ended_at ?? runState.state_changed_at ?? runState.started_at
    : null
  const liveMeta = runState
    ? [formatMessageTimestamp(latestRunAt, t), runStatusLabel(runState.status)]
        .filter(Boolean)
        .join(' · ')
    : ''
  const formattedDuration = formatDuration(liveDuration)
  const liveDurationCopy = formattedDuration
    ? t('sharedTaskCard.runDuration', {
        duration: formattedDuration,
        defaultValue: `耗时 ${formattedDuration}`,
      })
    : ''

  const projectedCta = projectCollaborationCta(phase, role)
  const action = useMemo<SharedTaskCardAction<CollaborationAction> | null>(() => {
    if (!projectedCta) return null
    const labels: Record<typeof projectedCta.kind, string> = {
      joinCollaboration: t('sharedTaskCard.join', { defaultValue: '确认加入任务' }),
      openOriginalTask: t('sharedTaskCard.openOriginal', { defaultValue: '打开我的任务' }),
      openCollaboration: t('sharedTaskCard.openCollaboration', { defaultValue: '查看任务' }),
      openCollaborationHistory: t('sharedTaskCard.openHistory', { defaultValue: '查看已有内容' }),
      inspectStatus: t('sharedTaskCard.stopped', { defaultValue: '共享已停止' }),
      inspectReason: t('sharedTaskCard.ineligible', { defaultValue: '资格已失效' }),
      retryDelivery: t('sharedTaskCard.retryDelivery', { defaultValue: '重试发送' }),
      retryLoad: t('sharedTaskCard.retryLoad', { defaultValue: '重新加载' }),
      waitingForDelivery: t('sharedTaskCard.waitingDelivery', { defaultValue: '等待送达' }),
      joining: t('sharedTaskCard.joining', { defaultValue: '确认中' }),
    }
    const command = projectedCta.command
    const opensTask = command === 'openOriginalTask'
      || command === 'openCollaboration'
      || command === 'openCollaborationHistory'
    const executable = command === 'joinCollaboration'
      ? Boolean(detail?.actions?.can_join)
      : !opensTask || Boolean(detail?.actions?.can_open && detail.session_id)
    return {
      ...(command && executable ? { id: command } : {}),
      label: labels[projectedCta.kind],
      disabled: projectedCta.disabled || !executable || command === 'inspectStatus' || command === 'inspectReason',
      loading: projectedCta.loading,
      tone: command === 'retryLoad' ? 'danger' : 'family',
    }
  }, [detail?.actions?.can_join, detail?.actions?.can_open, detail?.session_id, projectedCta, t])

  const handleAction = useCallback(async (command: CollaborationAction) => {
    if (command === 'retryLoad') {
      reload()
      return
    }
    if (command === 'retryDelivery') {
      try {
        const updated = await retrySessionShareV2Delivery(card.object_id)
        useIMStore.getState().setSessionShare(updated)
        reload()
      } catch (error) {
        toast({
          title: t('sharedTaskCard.retryDeliveryFailed', { defaultValue: '重试发送失败' }),
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        })
      }
      return
    }
    if (command === 'joinCollaboration') {
      setJoining(true)
      try {
        const updated = await acceptSessionShareV2(card.object_id)
        useIMStore.getState().setSessionShare(updated)
      } catch (error) {
        toast({
          title: t('sharedTaskCard.joinFailed', { defaultValue: '确认加入任务失败' }),
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        })
      } finally {
        setJoining(false)
      }
      return
    }
    if (!detail?.actions?.can_open || !detail.session_id) return
    const organizationId = useOrganizationStore.getState().selectedOrganization?.id
    const opened = openSharedSessionInIm({
      conversationId,
      sessionId: detail.session_id,
      shareId: effectiveShareId,
      title: detail.session_title || card.title_snapshot,
      organizationId,
      workspaceId: detail.workspace_id ?? null,
      workspaceName: detail.workspace_name || undefined,
      ownerUserId: detail.owner_user_id,
      ownerDisplayName: detail.owner_display_name || undefined,
      incoming: role === 'recipient',
    })
    if (!opened) {
      toast({
        title: t('sessionShareOpenFailed', { defaultValue: '无法打开任务' }),
        variant: 'destructive',
      })
    }
  }, [card.object_id, card.title_snapshot, conversationId, detail, effectiveShareId, reload, role, t])

  const relation = role === 'owner'
    ? t('sharedTaskCard.sharedTo', {
        name: detail?.grantee_display_name || '',
        defaultValue: detail?.grantee_display_name ? `你邀请 ${detail.grantee_display_name} 参与原任务` : '你发起的任务协作',
      })
    : t('sharedTaskCard.sharedFrom', {
        name: detail?.owner_display_name || '',
        defaultValue: detail?.owner_display_name ? `${detail.owner_display_name} 邀请你参与原任务` : '对方邀请你参与原任务',
      })
  const statusLabels: Record<CollaborationPhase, string> = {
    sending: t('sharedTaskCard.statusSending', { defaultValue: '发送中' }),
    awaitingJoin: t('sharedTaskCard.statusAwaitingJoin', { defaultValue: '待确认' }),
    joining: t('sharedTaskCard.statusJoining', { defaultValue: '确认中' }),
    activeView: t('sharedTaskCard.statusView', { defaultValue: '参与中' }),
    activeCollaborate: t('sharedTaskCard.statusCollaborate', { defaultValue: '参与中' }),
    ownerOffline: t('sharedTaskCard.statusOffline', { defaultValue: '对方离线' }),
    deliveryUnconfirmed: t('sharedTaskCard.statusUnconfirmed', { defaultValue: '送达未确认' }),
    stopped: t('sharedTaskCard.statusStopped', { defaultValue: '已停止' }),
    ineligible: t('sharedTaskCard.statusIneligible', { defaultValue: '资格失效' }),
    detailError: t('sharedTaskCard.statusUnavailable', { defaultValue: '详情不可用' }),
  }
  const awaitingConfirmation = role === 'recipient' && phase === 'awaitingJoin'
  const confirming = role === 'recipient' && phase === 'joining'
  const participating = role === 'recipient'
    && (phase === 'activeView' || phase === 'activeCollaborate')
  let infoTitle = runState
    ? t('sharedTaskCard.latestRun', { defaultValue: '最近一轮' })
    : t('sharedTaskCard.noRun', { defaultValue: '暂无运行记录' })
  let infoMeta = liveMeta || undefined
  let infoDescription = runState
    ? liveDurationCopy
    : t('sharedTaskCard.noRunDescription', { defaultValue: '任务运行后，将在这里显示最近一轮状态。' })

  if (awaitingConfirmation) {
    infoTitle = t('sharedTaskCard.confirmToJoin', { defaultValue: '确认后加入协作任务' })
    infoMeta = undefined
    infoDescription = t('sharedTaskCard.confirmDescription', { defaultValue: '确认前不展示任务进展，也不授予原任务访问权限。' })
  } else if (confirming) {
    infoTitle = t('sharedTaskCard.confirmingTitle', { defaultValue: '正在确认参与' })
    infoMeta = undefined
    infoDescription = t('sharedTaskCard.confirmingDescription', { defaultValue: '确认成功后，卡片将更新为「参与中」并展示任务进展。' })
  } else if (phase === 'detailError') {
    infoTitle = t('sharedTaskCard.loadFailed', { defaultValue: '无法获取最新状态' })
    infoMeta = undefined
    infoDescription = t('sharedTaskCard.noRunDescription', { defaultValue: '任务运行后，将在这里显示最近一轮状态。' })
  } else if (phase === 'stopped') {
    infoTitle = detail?.session_title || card.title_snapshot
    infoMeta = undefined
    infoDescription = t('sharedTaskCard.stoppedDescription', { defaultValue: '停止共享仅影响接收方，发起人仍可打开原任务。' })
  }

  return (
    <SessionCollaborationCard
      phase={phase}
      title={detail?.session_title || card.title_snapshot}
      content={{
        kindLabel: t('sharedTaskCard.collaborationKind', { defaultValue: '协作邀请' }),
        statusLabel: statusLabels[phase],
        relation,
        permissionLabel: awaitingConfirmation || confirming
          ? t('sharedTaskCard.pendingConfirmation', { defaultValue: '待确认' })
          : phase === 'activeView'
            ? t('sharedTaskCard.view', { defaultValue: '查看' })
            : phase === 'activeCollaborate'
              ? t('sharedTaskCard.collaborate', { defaultValue: '协作' })
              : t('sharedTaskCard.permission', { defaultValue: '权限' }),
        permissionCopy: awaitingConfirmation
          ? t('sharedTaskCard.confirmPermission', { defaultValue: '确认后获得实时查看权限' })
          : confirming
            ? t('sharedTaskCard.confirmingPermission', { defaultValue: '正在建立参与关系' })
            : phase === 'activeCollaborate'
              ? role === 'owner'
                ? t('sharedTaskCard.ownerCollaboratePermission', { defaultValue: '对方可实时查看并参与 Agent 对话' })
                : t('sharedTaskCard.collaboratePermission', { defaultValue: '可实时查看并参与 Agent 对话' })
              : phase === 'activeView'
                ? role === 'owner'
                  ? t('sharedTaskCard.ownerViewPermission', { defaultValue: '对方可实时查看，不可操作我的现场' })
                  : t('sharedTaskCard.viewPermission', { defaultValue: '可实时查看，不可操作对方现场' })
                : t('sharedTaskCard.permissionUnavailable', { defaultValue: '当前不开放任务操作' }),
        infoTitle,
        infoMeta,
        infoDescription,
        infoSteps: live?.recent_steps.map(step => ({
          id: step.id,
          label: step.title,
          status: step.status,
        })),
        infoResources: live?.resources.map(resource => ({ label: resource.label })),
        footer: awaitingConfirmation
          ? t('sharedTaskCard.confirmFooter', { defaultValue: '确认后进入「参与中」' })
          : confirming
            ? t('sharedTaskCard.confirmingFooter', { defaultValue: '正在建立参与权限' })
            : participating
              ? t('sharedTaskCard.participatingFooter', { defaultValue: '已加入「协作任务」' })
              : '',
      }}
      action={action}
      onAction={handleAction}
    />
  )
}
