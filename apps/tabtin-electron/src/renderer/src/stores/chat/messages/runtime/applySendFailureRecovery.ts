import type { ChatMessage } from '@tabtin/chat-client'
import { ChatAPIError } from '@tabtin/chat-client'
import type { ChatAttachment } from '../../../../components/chat/types'
import type { SendTimingTrace } from '../../execution/sendTimingTrace'
import { trackSendTimingTelemetry } from '../../execution/sendTimingTrace'
import { getClientMessageId } from '@/stores/chat/domain/messageIdentity'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { endSessionRunIfStarted } from '@/stores/chat/stream/handlers/sessionCleanup'
import { showBillingErrorByCategory, getErrorHint } from '../../shared/helpers'
import { checkMemberLimitError } from '../actions/sendDispatchInputs'
import {
  appendAssistantErrorDetails,
  isAbortLikeError,
  markMessageFailed,
  markUserMessageSubmitted,
  resolveUserSendStatusOnSendRejection,
} from '../actions/messageStatusUpdates'
import { prefillComposerAfterBlockedSend } from './prefillComposerAfterBlockedSend'
import i18n from '@/i18n'

type FailureLogger = {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export type ApplySendFailureRecoveryParams = {
  error: unknown
  sessionId: string
  clientMessageId: string
  userMessageId: string
  visibleMessage: string
  uploadedAttachments: ChatAttachment[] | undefined
  contextBlocks: Array<Record<string, unknown>> | undefined
  sendTimingTrace?: SendTimingTrace
  getMessages: () => ChatMessage[]
  setSendInFlight: (sessionId: string, inFlight: boolean) => void
  updateSessionMessages: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void
  removeStreamingSession: (sessionId: string) => void
  log: FailureLogger
}

/** 发送 catch：abort / billing / 失败气泡 / Composer 回填。 */
export function applySendFailureRecovery(params: ApplySendFailureRecoveryParams): void {
  const {
    error,
    sessionId,
    clientMessageId,
    userMessageId,
    visibleMessage,
    uploadedAttachments,
    contextBlocks,
    sendTimingTrace,
    getMessages,
    setSendInFlight,
    updateSessionMessages,
    removeStreamingSession,
    log,
  } = params

  setSendInFlight(sessionId, false)
  useChatRuntimeStore.getState().clearActiveSubmittedMessage(sessionId, clientMessageId)

  const cancelled = isAbortLikeError(error)
  if (cancelled) {
    log.warn('发送流程中止（abort-like）:', error)
  } else {
    log.error('发送消息失败:', error)
  }

  endSessionRunIfStarted({
    sessionId,
    status: cancelled ? 'cancelled' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    removeStreamingSession,
  })

  const catchCategory = error instanceof ChatAPIError
    ? error.response?.error_category
    : undefined
  if (catchCategory) {
    showBillingErrorByCategory(catchCategory)
    checkMemberLimitError(catchCategory)
  }
  const catchHint = getErrorHint(catchCategory || '') || ''

  trackSendTimingTelemetry(cancelled ? 'message.send.aborted' : 'message.send.failed', {
    sessionId,
    message: error instanceof Error ? error.message : String(error),
    ...(catchCategory ? { errorCategory: catchCategory } : {}),
  }, sendTimingTrace, {
    counterKey: cancelled ? 'message.send.aborted' : 'message.send.failed',
    level: cancelled ? 'warn' : 'error',
    sessionId,
  })

  const failedErrorText = i18n.t('chat:messages.sendFailed', {
    message: error instanceof Error
      ? error.message
      : i18n.t('chat:messages.unknownError'),
  })

  const currentMessages = getMessages()
  const currentUser = currentMessages.find((message) => (
    message.id === userMessageId
    || message.id === clientMessageId
    || getClientMessageId(message) === clientMessageId
  ))
  const runtimeAccepted = (
    currentUser
    && (currentUser as ChatMessage & { sendStatus?: string }).sendStatus === 'sent'
  )
  const userSendStatus = resolveUserSendStatusOnSendRejection(error, !!runtimeAccepted)

  // ：ACK 前草稿不在时间线——只清 inflight + 回填发送区，不动历史气泡。
  if (!currentUser) {
    if (userSendStatus === 'failed') {
      prefillComposerAfterBlockedSend(
        sessionId,
        visibleMessage,
        uploadedAttachments,
        contextBlocks,
      )
    }
    return
  }

  const currentAssistant = [...currentMessages].reverse().find(message => message.role === 'assistant')
  const assistantMessageId = currentAssistant?.id ?? ''
  const assistantContent = currentAssistant?.content ?? ''

  if (cancelled) {
    markUserMessageSubmitted(sessionId, userMessageId, undefined, updateSessionMessages)
  } else {
    markMessageFailed(
      sessionId, userMessageId, assistantMessageId, assistantContent,
      updateSessionMessages,
      (msg) => {
        const mergedContent = appendAssistantErrorDetails(
          assistantContent || msg.content,
          [failedErrorText, catchHint],
        )
        return {
          ...msg,
          content: mergedContent,
          ...(catchCategory ? {
            metadata: {
              ...((msg as ChatMessage & { metadata?: Record<string, unknown> }).metadata || {}),
              errorCategory: catchCategory,
            },
          } : {}),
        }
      },
      { userSendStatus },
    )
  }

  if (userSendStatus === 'failed') {
    prefillComposerAfterBlockedSend(
      sessionId,
      visibleMessage,
      uploadedAttachments,
      contextBlocks,
    )
  }
}
