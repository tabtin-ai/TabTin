import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@components/ui'
import { ExecutionTargetWizard } from '@components/chat/shared-view/ExecutionTargetWizard'
import { useIMStore } from '@stores/useIMStore'
import { enterChatSession } from '@/services/chatSessionNavigation'
import {
  projectContinuationCta,
  type ContinuationAction,
  type ContinuationPhase,
  type SharedTaskRole,
} from '@/services/im/cards/sharedTaskCardControl'
import {
  createTaskFromSessionContinuation,
  type SessionContinuationDetail,
} from '@/services/tabchatApi'
import type { TabTinSessionContinuationCard } from '@/services/im/cards/tabtinCustomCardModel'
import { SessionContinuationCard } from './SessionContinuationCard'
import type { SharedTaskCardAction } from './SharedTaskCardSurface'

interface Props {
  card: TabTinSessionContinuationCard
}

function projectPhase(
  detail: SessionContinuationDetail | null,
  loadState: 'idle' | 'loading' | 'loaded' | 'error',
  accessDenied: boolean,
): ContinuationPhase {
  if (!detail) {
    if (accessDenied) return 'invalid'
    return loadState === 'loading' ? 'sending' : 'detailError'
  }
  if (!detail.eligibility.can_create && detail.role === 'recipient') return 'invalid'
  if (detail.creation_status === 'created') return 'created'
  if (detail.creation_status === 'failed') return 'createFailed'
  if (detail.delivery_status !== 'confirmed') return 'sending'
  if (detail.context_status === 'empty') return 'empty'
  if (detail.context_status === 'truncated') return 'truncated'
  if (detail.resource_status === 'partial' || detail.resource_status === 'unavailable') return 'partial'
  return 'pending'
}

export function SessionContinuationCardController({ card }: Props) {
  const { t } = useTranslation('tabchat')
  const entry = useIMStore((state) => state.sessionContinuations[card.object_id])
  const detail = entry?.detail ?? null
  const phase = projectPhase(
    detail,
    entry?.loadState ?? 'idle',
    Boolean(entry?.accessDenied),
  )
  const role: SharedTaskRole = detail?.role ?? 'observer'
  const [wizardOpen, setWizardOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const materializeRequestId = useRef(crypto.randomUUID())
  const displayedPhase: ContinuationPhase = creating ? 'creating' : phase

  const reload = useCallback(() => {
    void useIMStore.getState().loadSessionContinuation(card.object_id, card.version)
  }, [card.object_id, card.version])

  useEffect(() => {
    reload()
  }, [reload])

  const projectedCta = projectContinuationCta(displayedPhase, role)
  const action = useMemo<SharedTaskCardAction<ContinuationAction> | null>(() => {
    if (!projectedCta) return null
    const labels: Record<typeof projectedCta.kind, string> = {
      createContinuationTask: t('sharedTaskCard.createTask', { defaultValue: '创建我的任务' }),
      openContinuationTask: t('sharedTaskCard.openCreatedTask', { defaultValue: '打开新任务' }),
      retryContinuationCreation: t('sharedTaskCard.retryCreate', { defaultValue: '重试创建' }),
      inspectReason: t('sharedTaskCard.ineligible', { defaultValue: '资格已失效' }),
      retryLoad: t('sharedTaskCard.retryLoad', { defaultValue: '重新加载' }),
      waitingForDelivery: t('sharedTaskCard.waitingDelivery', { defaultValue: '等待送达' }),
      creationUnavailable: t('sharedTaskCard.emptyContext', { defaultValue: '没有可续接内容' }),
      creating: t('sharedTaskCard.creating', { defaultValue: '正在创建' }),
    }
    const command = projectedCta.command
    const canOpen = command !== 'openContinuationTask'
      || Boolean(detail?.linked_session_id && detail.target_workspace_id)
    return {
      ...(command && canOpen && command !== 'inspectReason' ? { id: command } : {}),
      label: labels[projectedCta.kind],
      disabled: projectedCta.disabled || !canOpen || command === 'inspectReason',
      loading: projectedCta.loading,
      tone: command === 'retryLoad' || command === 'retryContinuationCreation' ? 'danger' : 'family',
    }
  }, [detail?.linked_session_id, detail?.target_workspace_id, projectedCta, t])

  const openCreatedTask = useCallback(async (next: SessionContinuationDetail) => {
    if (!next.linked_session_id || !next.target_workspace_id) return
    useIMStore.getState().closeIM()
    await enterChatSession(next.target_workspace_id, next.linked_session_id, {
      organizationId: next.organization_id,
      initialMessagePage: 'latest',
    })
  }, [])

  const handleAction = useCallback((command: ContinuationAction) => {
    if (command === 'retryLoad') {
      reload()
      return
    }
    if (command === 'openContinuationTask' && detail) {
      void openCreatedTask(detail)
      return
    }
    if (command === 'createContinuationTask' || command === 'retryContinuationCreation') {
      setWizardOpen(true)
    }
  }, [detail, openCreatedTask, reload])

  const handleCreate = useCallback(async (agentId: string, workspaceId: string) => {
    setCreating(true)
    try {
      const created = await createTaskFromSessionContinuation(card.object_id, {
        agentId,
        workspaceId,
        clientRequestId: materializeRequestId.current,
      })
      useIMStore.getState().setSessionContinuation(created)
      setWizardOpen(false)
      toast({ title: t('sharedTaskCard.created', { defaultValue: '已创建续接任务' }) })
      await openCreatedTask(created)
    } finally {
      setCreating(false)
    }
  }, [card.object_id, openCreatedTask, t])

  const statusLabels: Record<ContinuationPhase, string> = {
    sending: t('sharedTaskCard.statusSending', { defaultValue: '发送中' }),
    pending: t('sharedTaskCard.statusReady', { defaultValue: '可续接' }),
    truncated: t('sharedTaskCard.statusTruncated', { defaultValue: '上下文已截断' }),
    partial: t('sharedTaskCard.statusPartial', { defaultValue: '部分资源不可用' }),
    empty: t('sharedTaskCard.statusEmpty', { defaultValue: '没有可续接内容' }),
    creating: t('sharedTaskCard.statusCreating', { defaultValue: '创建中' }),
    created: t('sharedTaskCard.statusCreated', { defaultValue: '已创建' }),
    createFailed: t('sharedTaskCard.statusCreateFailed', { defaultValue: '创建失败' }),
    invalid: t('sharedTaskCard.statusIneligible', { defaultValue: '资格失效' }),
    detailError: t('sharedTaskCard.statusUnavailable', { defaultValue: '详情不可用' }),
  }

  return (
    <>
      <SessionContinuationCard
        phase={displayedPhase}
        title={detail?.title_snapshot || card.title_snapshot}
        content={{
          kindLabel: t('sharedTaskCard.continuationKind', { defaultValue: '任务续接' }),
          statusLabel: statusLabels[displayedPhase],
          relation: role === 'owner'
            ? t('sharedTaskCard.continuationSent', { defaultValue: '你发送的冻结任务上下文' })
            : t('sharedTaskCard.continuationReceived', { defaultValue: '对方交给你继续的任务' }),
          permissionLabel: t('sharedTaskCard.snapshot', { defaultValue: '快照' }),
          permissionCopy: t('sharedTaskCard.snapshotDescription', {
            defaultValue: `发送时冻结 ${detail?.snapshot_turn_count ?? 0} 轮上下文，之后不跟随原任务变化`,
          }),
          infoTitle: detail?.title_snapshot || card.title_snapshot,
          infoDescription: displayedPhase === 'partial'
            ? t('sharedTaskCard.partialDescription', { defaultValue: '可创建任务，但部分资源需要重新获取权限。' })
            : t('sharedTaskCard.continuationDescription', { defaultValue: '新任务只使用发送时冻结的内容创建。' }),
          resources: detail?.resources?.map((resource) => ({
            label: resource.label || t('sharedTaskCard.resource', { defaultValue: '关联资源' }),
            unavailable: Boolean(resource.unavailable),
            unavailableLabel: resource.reason,
          })),
          footer: '',
        }}
        action={action}
        onAction={handleAction}
      />
      <ExecutionTargetWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        title={t('sharedTaskCard.createWizardTitle', { defaultValue: '创建续接任务' })}
        onConfirm={handleCreate}
      />
    </>
  )
}
