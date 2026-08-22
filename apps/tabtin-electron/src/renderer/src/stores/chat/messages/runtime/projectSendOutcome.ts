/**
 * SendOutcome → 产品 UI：上屏 / HostPending / 失败恢复。
 * 只解释结果，不选通道、不再发。
 */

import type { SendOutcome } from '@/services/agentService'
import type { ChatAttachment } from '../../../../components/chat/types'
import type { SendTimingTrace } from '../../execution/sendTimingTrace'
import type { AgentModeName } from '../../shared/types'
import type { ChatMessage } from '@tabtin/chat-client'
import { getRemoteExecutionAccess } from '@/services/remoteExecutionGuard'
import { endSessionRunIfStarted } from '@/stores/chat/stream/handlers/sessionCleanup'
import { showBillingErrorByCategory } from '../../shared/helpers'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import { trackSendTimingTelemetry } from '../../execution/sendTimingTrace'
import { getChatSessionAccess } from '@/stores/chat/shared/storeAccessRegistry'
import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui/toast'
import type { RemoteGatewayResponse } from '../actions/sendDispatchInputs'
import { checkMemberLimitError } from '../actions/sendDispatchInputs'
import { markMessageFailed, markUserMessageSubmitted } from '../actions/messageStatusUpdates'
import type { PendingUserSend } from './optimisticUserSend'
import { applyLocalRuntimeSendAck } from './applyLocalRuntimeSendAck'
import { applySendFailureRecovery } from './applySendFailureRecovery'

export type ProjectSendOutcomeParams = {
  outcome: SendOutcome
  sessionId: string
  capturedRuntimeSpaceId: string | undefined
  currentAgentMode: AgentModeName
  pending: PendingUserSend
  visibleMessage: string
  uploadedAttachments: ChatAttachment[] | undefined
  contextBlocks: Array<Record<string, unknown>> | undefined
  sendTimingTrace?: SendTimingTrace
  get: () => {
    setSendInFlight: (sessionId: string, inFlight: boolean) => void
    requestComposerClearAfterSend: (sessionId: string) => void
    enqueueHostPendingSend: (item: {
      runId: string
      sessionId: string
      queuePosition: number
      createdAt: string
      userMessage: PendingUserSend['draft']
      titleText: string
    }) => void
    hostPendingSendsBySessionId: Record<string, unknown[] | undefined>
    messagesBySessionId: Record<string, ChatMessage[] | undefined>
  }
  bumpSessionSidebarOnSend: () => void
  addStreamingSession: (sessionId: string) => void
  removeStreamingSession: (sessionId: string) => void
  updateSessionMessages: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export type SendSubmissionResult =
  | {
      accepted: true
      persisted: boolean
      route: 'runtime' | 'gateway'
    }
  | {
      accepted: false
      persisted: false
      reason: string
    }

function fail(
  params: Omit<ProjectSendOutcomeParams, 'outcome'>,
  error: unknown,
): SendSubmissionResult {
  applySendFailureRecovery({
    error,
    sessionId: params.sessionId,
    clientMessageId: params.pending.clientMessageId,
    userMessageId: params.pending.userMessageId,
    visibleMessage: params.visibleMessage,
    uploadedAttachments: params.uploadedAttachments,
    contextBlocks: params.contextBlocks,
    sendTimingTrace: params.sendTimingTrace,
    getMessages: () => params.get().messagesBySessionId[params.sessionId] ?? [],
    setSendInFlight: (sid, inFlight) => params.get().setSendInFlight(sid, inFlight),
    updateSessionMessages: params.updateSessionMessages,
    removeStreamingSession: params.removeStreamingSession,
    log: params.log,
  })
  return {
    accepted: false,
    persisted: false,
    reason: error instanceof Error ? error.message : String(error),
  }
}

export function projectSendOutcome(params: ProjectSendOutcomeParams): SendSubmissionResult {
  const { outcome, ...ctx } = params

  if (outcome.route === 'unavailable') {
    return fail(ctx, new Error('send: no available execution route'))
  }

  if (outcome.route === 'runtime') {
    applyLocalRuntimeSendAck({
      sessionId: ctx.sessionId,
      disposition: outcome.result.runDisposition,
      runId: outcome.result.runId,
      queuePosition: outcome.result.queuePosition,
      currentAgentMode: ctx.currentAgentMode,
      displayMessage: ctx.pending.displayMessage,
      pending: ctx.pending,
      get: ctx.get,
      bumpSessionSidebarOnSend: ctx.bumpSessionSidebarOnSend,
      addStreamingSession: ctx.addStreamingSession,
      log: ctx.log,
    })
    return { accepted: true, persisted: false, route: 'runtime' }
  }

  const response = outcome.response as RemoteGatewayResponse
  if (!response.ok || response.type !== 'chat.send_message.ok') {
    const code = response.error?.code || response.payload?.error_code
    const messageText =
      response.error?.message
      || response.payload?.error_message
      || response.payload?.message
      || i18n.t('chat:messages.sendFailed', { message: 'remote device dispatch failed' })
    ctx.log.error('[RemoteExecution] chat.send_message failed:', messageText, {
      sessionId: ctx.sessionId,
      errorCode: code,
    })
    endSessionRunIfStarted({
      sessionId: ctx.sessionId,
      status: 'error',
      errorMessage: messageText,
      removeStreamingSession: ctx.removeStreamingSession,
    })
    // 编辑重发：气泡已在时间线上，只标失败；普通持稿走统一恢复（发送区可改）。
    if (ctx.pending.onTimeline) {
      markMessageFailed(
        ctx.sessionId,
        ctx.pending.userMessageId,
        '',
        '',
        ctx.updateSessionMessages,
        (msg) => msg,
      )
      ctx.get().setSendInFlight(ctx.sessionId, false)
    } else {
      fail(ctx, new Error(messageText))
    }
    if (code) {
      showBillingErrorByCategory(code)
      checkMemberLimitError(code)
    }
    toast.error(i18n.t('chat:messages.sendFailed', { message: messageText }))
    trackChatTelemetry('message.send.failed', {
      sessionId: ctx.sessionId,
      message: messageText,
      ...(code ? { errorCategory: code } : {}),
    }, {
      counterKey: 'message.send.failed',
      level: 'error',
      sessionId: ctx.sessionId,
    })
    return { accepted: false, persisted: false, reason: messageText }
  }

  ctx.pending.applyAck('started', ctx.currentAgentMode)
  ctx.bumpSessionSidebarOnSend()
  ctx.get().setSendInFlight(ctx.sessionId, false)
  ctx.get().requestComposerClearAfterSend(ctx.sessionId)
  markUserMessageSubmitted(
    ctx.sessionId,
    ctx.pending.userMessageId,
    response.payload?.message_id,
    ctx.updateSessionMessages,
  )
  const ackRunState = response.payload?.run_state
  if (ackRunState != null) {
    getChatSessionAccess()?.setSessionFields(ctx.sessionId, {
      run_state: ackRunState as never,
    })
  }
  const { controlDeviceId } = getRemoteExecutionAccess(ctx.capturedRuntimeSpaceId)
  trackSendTimingTelemetry('message.send.remote_forwarded', {
    sessionId: ctx.sessionId,
    controlDeviceId,
  }, ctx.sendTimingTrace, {
    counterKey: 'message.send.remote_forwarded',
    sessionId: ctx.sessionId,
  })
  return {
    accepted: true,
    persisted: typeof response.payload?.message_id === 'string' && response.payload.message_id.length > 0,
    route: 'gateway',
  }
}

export { fail as projectSendFailure }
