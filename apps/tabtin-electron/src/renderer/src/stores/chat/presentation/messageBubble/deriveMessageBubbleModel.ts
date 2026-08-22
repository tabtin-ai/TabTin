import type { ChatMessage } from '@tabtin/chat-client'
import { deriveAssistantBubbleModel } from './deriveAssistantBubbleModel'
import { deriveMessageErrorModel, resolveMessageBubbleErrorState } from './deriveMessageErrorModel'
import { deriveMessageFooterModel } from './deriveMessageFooterModel'
import { deriveUserBubbleModel } from './deriveUserBubbleModel'
import { findRegenerateSourceMessage } from './regenerateSourceMessage'
import {
  deriveCanReply,
  deriveInterruptPresentation,
  deriveRetryMessageContent,
  deriveStreamingPresentation,
} from './messageBubblePresentationDerivers'
import { isPushNotificationMessage } from './timelineMessageVisibility'
import type {
  DeriveMessageBubbleModelInput,
  MessageBubbleDerivedModel,
} from './messageBubbleModelTypes'

export type {
  DeriveMessageBubbleModelInput,
  MessageBubbleDerivedModel,
} from './messageBubbleModelTypes'

export {
  EMPTY_CONTENT_BLOCKS,
} from './messageBubbleModelTypes'

export {
  resolveMessageContentBlocks,
} from './resolveMessageContentBlocks'

export function deriveStalledLevel(input: {
  isStreaming: boolean
  runStateSuspended: boolean
  heartbeatInfo: { lastHeartbeatAt: number; secondsSinceLastChunk?: number } | null
  nowMs?: number
}): 0 | 1 | 2 {
  const nowMs = input.nowMs ?? Date.now()
  if (!input.isStreaming || input.runStateSuspended || !input.heartbeatInfo) return 0
  const heartbeatAge = (nowMs - input.heartbeatInfo.lastHeartbeatAt) / 1000
  const sinceChunk = (input.heartbeatInfo.secondsSinceLastChunk ?? 0) + heartbeatAge
  if (sinceChunk > 120 || heartbeatAge > 120) return 2
  if (sinceChunk > 60) return 1
  return 0
}

export function deriveMessageBubbleModel(input: DeriveMessageBubbleModelInput): MessageBubbleDerivedModel {
  const {
    message,
    sessionId = null,
    currentUserId,
    userAlign = 'right',
    previewMode,
    isLastAssistantMsg = false,
    sessionPulseVisible = false,
    isLastInTurn = true,
    isEditing = false,
    isActiveSession,
    isRestoring,
    isStreaming,
    runStateSuspended,
    sessionMessages,
    runtimeBlocks,
    contentBlocksOverride,
    projectTaskResendBlocked = false,
    t,
    locale,
  } = input

  const isUser = message.role === 'user'
  const metadata = message.metadata as Record<string, unknown> | null | undefined
  const messageKind = message.message_kind ?? 'llm'
  const isPushNotification = isPushNotificationMessage(message)
  const canReply = deriveCanReply({ message, sessionId, previewMode, messageKind })
  const interruptPresentation = deriveInterruptPresentation({ message, metadata, t, locale })
  const streamingPresentation = deriveStreamingPresentation({
    isStreaming,
    isLastAssistantMsg,
    sessionPulseVisible,
  })
  const retryMessageContent = deriveRetryMessageContent({ message, metadata })

  const errorState = resolveMessageBubbleErrorState(message)
  const hasErrorIndicators = !!(
    errorState.isErrorMessage
    || errorState.errorCategory
    || errorState.errorClass
  )

  if (isUser) {
    const userModel = deriveUserBubbleModel({
      message,
      metadata,
      currentUserId,
      userAlign,
      previewMode,
      isActiveSession,
      isStreaming,
      isRestoring,
      sessionId,
      projectTaskResendBlocked,
    })
    const errorModel = deriveMessageErrorModel({
      message,
      displayContent: userModel.displayContent,
      isUser: true,
      isInterrupted: interruptPresentation.isInterrupted,
      t,
      isLastAssistantMsg,
      isStreaming,
    })
    const footerModel = deriveMessageFooterModel({
      message,
      sessionId,
      previewMode,
      isUser: true,
      isActiveSession,
      isRestoring,
      isStreaming,
      runStateSuspended,
      isLastAssistantMsg,
      isLastInTurn,
      isEditing,
      isMiniMessage: false,
      isErrorEnvelope: false,
      isPushNotification,
      isStreamingTailMessage: streamingPresentation.isStreamingTailMessage,
      displayContent: userModel.displayContent,
      conversationReferenceParsed: userModel.conversationReferenceParsed,
      hasContentBlocks: false,
      sessionMessages,
      projectTaskResendBlocked,
    })

    return {
      isUser: true,
      isPushNotification,
      userInbound: userModel.userInbound,
      userSenderDisplayName: userModel.userSenderDisplayName,
      canReply,
      canEdit: userModel.canEdit,
      messageKind,
      isMiniMessage: false,
      isErrorEnvelope: false,
      isInterrupted: interruptPresentation.isInterrupted,
      intentLabel: interruptPresentation.intentLabel,
      timestamp: interruptPresentation.timestamp,
      isStreamingTailMessage: streamingPresentation.isStreamingTailMessage,
      suppressInlineLoading: streamingPresentation.suppressInlineLoading,
      contentBlocks: [],
      hasContentBlocks: false,
      displayContent: userModel.displayContent,
      userDisplayContent: userModel.userDisplayContent,
      conversationReferenceParsed: userModel.conversationReferenceParsed,
      assistantCopyContent: userModel.assistantCopyContent,
      assistantToolbarContent: userModel.assistantToolbarContent,
      userEchoCards: userModel.userEchoCards,
      retryMessageContent,
      ...errorModel,
      ...footerModel,
    }
  }

  const assistantModel = deriveAssistantBubbleModel({
    message,
    messageKind,
    metadata,
    runtimeBlocks,
    contentBlocksOverride,
    t,
    hasErrorIndicators,
  })
  const errorModel = deriveMessageErrorModel({
    message,
    displayContent: assistantModel.displayContent,
    isUser: false,
    isInterrupted: interruptPresentation.isInterrupted,
    t,
    isLastAssistantMsg,
    isStreaming,
  })
  const footerModel = deriveMessageFooterModel({
    message,
    sessionId,
    previewMode,
    isUser: false,
    isActiveSession,
    isRestoring,
    isStreaming,
    runStateSuspended,
    isLastAssistantMsg,
    isLastInTurn,
    isEditing,
    isMiniMessage: assistantModel.isMiniMessage,
    isErrorEnvelope: assistantModel.isErrorEnvelope,
    isPushNotification: false,
    isStreamingTailMessage: streamingPresentation.isStreamingTailMessage,
    displayContent: assistantModel.displayContent,
    conversationReferenceParsed: assistantModel.conversationReferenceParsed,
    hasContentBlocks: assistantModel.hasContentBlocks,
    sessionMessages,
    projectTaskResendBlocked,
  })

  return {
    isUser: false,
    isPushNotification: false,
    userInbound: false,
    userSenderDisplayName: '',
    canReply,
    canEdit: false,
    messageKind,
    isMiniMessage: assistantModel.isMiniMessage,
    isErrorEnvelope: assistantModel.isErrorEnvelope,
    isInterrupted: interruptPresentation.isInterrupted,
    intentLabel: interruptPresentation.intentLabel,
    timestamp: interruptPresentation.timestamp,
    isStreamingTailMessage: streamingPresentation.isStreamingTailMessage,
    suppressInlineLoading: streamingPresentation.suppressInlineLoading,
    contentBlocks: assistantModel.contentBlocks,
    hasContentBlocks: assistantModel.hasContentBlocks,
    displayContent: assistantModel.displayContent,
    userDisplayContent: assistantModel.userDisplayContent,
    conversationReferenceParsed: assistantModel.conversationReferenceParsed,
    assistantCopyContent: assistantModel.assistantCopyContent,
    assistantToolbarContent: assistantModel.assistantToolbarContent,
    userEchoCards: assistantModel.userEchoCards,
    retryMessageContent,
    ...errorModel,
    ...footerModel,
  }
}

export function deriveRegenerateSourceMessage(
  sessionMessages: ChatMessage[],
  messageId: string,
  isUser: boolean,
): ChatMessage | null {
  if (isUser) return null
  return findRegenerateSourceMessage(sessionMessages, messageId)
}
