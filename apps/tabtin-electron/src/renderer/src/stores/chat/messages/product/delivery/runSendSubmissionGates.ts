import type { ChatAttachment } from '../../../../../components/chat/types'
import type { SendTimingTrace } from '../../../execution/sendTimingTrace'
import { hasRuntimeBridge } from '@/services/agentService'
import { useChatModelStore } from '../../../../useChatModelStore'
import { isSendableChatModel } from '@/utils/chatModelGuards'
import {
  evaluateDeliverySubmission,
  evaluatePreLockSubmission,
} from './submissionGuards'
import { resolveProjectTaskChatSendGate } from './projectTaskSendGate'
import { evaluateHitlOnSubmit } from '../hitl/hitlOnSubmit'
import { isBlockedSubmission } from '../types'
import { applyBlockedSubmissionFeedback } from '../../runtime/applyBlockedSubmissionFeedback'
import { applySoftAskUserSubmitPlan } from '../../runtime/applySoftAskUserSubmitPlan'
import { prefillComposerAfterBlockedSend } from '../../runtime/prefillComposerAfterBlockedSend'
import { runDraftMessageSendPreflight } from '../../actions/draftMessageSendPreflight'
import { resolveSessionForSend } from '../../actions/sendDispatchInputs'
import type { SendMessageDeps, SendMessageOptions, SendMessageStore } from '../../actions/sendMessageTypes'

export type SendSubmissionGatesResult =
  | { ok: false }
  | { ok: true; sessionId: string }

/**
 * 发送前门禁链：pre-lock → DraftMessage → delivery → project task → HITL soft-skip →
 * 模型可发 → streaming-only。任一步 blocked 则反馈并返回 ok:false。
 */
export async function runSendSubmissionGates(params: {
  sessionId: string | null | undefined
  visibleMessage: string
  attachments: ChatAttachment[] | undefined
  contextBlocks: Array<Record<string, unknown>> | undefined
  options: SendMessageOptions | undefined
  sendRoute: 'runtime' | 'gateway' | 'unavailable'
  /** 在 execution 解析前只跑 pre-lock / sessionId；其余在有 route 后调用。 */
  phase: 'pre_execution' | 'post_execution'
  sendTimingTrace?: SendTimingTrace
  deps: Pick<
    SendMessageDeps,
    'get' | 'set' | 'getChatClient' | 'updateSessionMessages' | 'updateSessionInCaches'
  >
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}): Promise<SendSubmissionGatesResult> {
  const {
    visibleMessage,
    attachments,
    contextBlocks,
    options,
    sendTimingTrace,
    deps,
    log,
  } = params
  const sessionId = params.sessionId

  if (params.phase === 'pre_execution') {
    const preLockGuard = evaluatePreLockSubmission(
      {
        sessionId: sessionId ?? null,
        restoringSessionId: deps.get().restoringSessionId,
        pendingApprovalBySessionId: deps.get().pendingApprovalBySessionId,
        pendingAskUserBySessionId: deps.get().pendingAskUserBySessionId,
      },
    )
    if (isBlockedSubmission(preLockGuard)) {
      applyBlockedSubmissionFeedback(preLockGuard, {
        sessionId: sessionId ?? null,
        sendTimingTrace,
        log,
      })
      return { ok: false }
    }
    if (!sessionId) {
      return { ok: false }
    }

    const preflight = await runDraftMessageSendPreflight({
      sessionId,
      existingClientMessageId: options?.existingClientMessageId,
      expectedDraftMessageId: options?.expectedDraftMessageId,
      patchSessionAgent: (id, agentId) =>
        deps.getChatClient().sessions.update(id, { agent_id: agentId }),
      getSession: (id) => resolveSessionForSend(deps.get(), id),
      updateSessionInCaches: (id, patch) => {
        deps.updateSessionInCaches(id, patch as Parameters<typeof deps.updateSessionInCaches>[1])
      },
      updateSessionMessages: deps.updateSessionMessages,
    })
    if (preflight.blocked) {
      prefillComposerAfterBlockedSend(sessionId, visibleMessage, attachments, contextBlocks)
      return { ok: false }
    }
    return { ok: true, sessionId }
  }

  // post_execution
  if (!sessionId) return { ok: false }

  const deliveryGuard = evaluateDeliverySubmission(
    {
      sessionId,
      restoringSessionId: deps.get().restoringSessionId,
      pendingApprovalBySessionId: deps.get().pendingApprovalBySessionId,
      pendingAskUserBySessionId: deps.get().pendingAskUserBySessionId,
    },
    {
      sendRoute: params.sendRoute,
      modelConfigured: (() => {
        const model = useChatModelStore.getState().getCurrentModel()
        return Boolean(model && isSendableChatModel(model))
      })(),
    },
  )
  if (isBlockedSubmission(deliveryGuard)) {
    applyBlockedSubmissionFeedback(deliveryGuard, {
      sessionId,
      sendTimingTrace,
      log,
    })
    if (deliveryGuard.reason === 'no_runtime') {
      prefillComposerAfterBlockedSend(sessionId, visibleMessage, attachments, contextBlocks)
    }
    return { ok: false }
  }

  const projectTaskGate = await resolveProjectTaskChatSendGate(sessionId)
  if (projectTaskGate) {
    applyBlockedSubmissionFeedback({
      ok: false,
      reason: 'project_task_run_required',
      queueReason: 'project_task_run_required',
      userFeedback: 'project_task_run_required_toast',
    }, {
      sessionId,
      sendTimingTrace,
      log,
    })
    return { ok: false }
  }

  const pendingAskUser = deps.get().pendingAskUserBySessionId[sessionId]
  const hitlOnSubmit = evaluateHitlOnSubmit(pendingAskUser, hasRuntimeBridge())
  if (hitlOnSubmit.action === 'apply_soft_skip') {
    applySoftAskUserSubmitPlan(sessionId, hitlOnSubmit.plan, {
      getPendingAskUserBySessionId: () => deps.get().pendingAskUserBySessionId,
      getAskUserSubmittingBySessionId: () => deps.get().askUserSubmittingBySessionId,
      set: deps.set,
      updateSessionMessages: deps.updateSessionMessages,
      log,
    })
  }

  const currentModel = useChatModelStore.getState().getCurrentModel()
  if (!currentModel || !isSendableChatModel(currentModel)) {
    return { ok: false }
  }

  return { ok: true, sessionId }
}

export type { SendMessageStore }
