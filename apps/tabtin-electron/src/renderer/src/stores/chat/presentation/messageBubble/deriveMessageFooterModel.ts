import type { ChatMessage } from '@tabtin/chat-client'
import type { parseConversationReferenceMessage } from '@utils/chat/conversationReference'
import {
  shouldRenderStandardMessageFooter,
  shouldShowRegenerateAction,
  shouldShowRollbackAction,
} from './messageFooterActions'
import { findRegenerateSourceMessage } from './regenerateSourceMessage'

export interface DeriveMessageFooterModelInput {
  message: ChatMessage
  sessionId: string | null
  previewMode?: boolean
  isUser: boolean
  isActiveSession: boolean
  isRestoring: boolean
  isStreaming: boolean
  runStateSuspended: boolean
  isLastAssistantMsg: boolean
  isLastInTurn: boolean
  isEditing: boolean
  isMiniMessage: boolean
  isErrorEnvelope: boolean
  isPushNotification: boolean
  isStreamingTailMessage: boolean
  displayContent: string
  conversationReferenceParsed: ReturnType<typeof parseConversationReferenceMessage>
  hasContentBlocks: boolean
  sessionMessages: ChatMessage[]
  projectTaskResendBlocked?: boolean
}

export interface MessageFooterDerivedModel {
  hasStandardFooterContent: boolean
  showStandardFooter: boolean
  showErrorEnvelopeFooter: boolean
  canRegenerate: boolean
  showRollback: boolean
  canPreviewRollback: boolean
  showAgentRunRollback: boolean
  agentRunId: string | null
}

function deriveHasStandardFooterContent(input: {
  displayContent: string
  conversationReferenceParsed: ReturnType<typeof parseConversationReferenceMessage>
  isUser: boolean
  hasContentBlocks: boolean
}): boolean {
  return input.displayContent.trim().length > 0
    || Boolean(input.conversationReferenceParsed)
    || (!input.isUser && input.hasContentBlocks)
}

function deriveShowErrorEnvelopeFooter(input: {
  previewMode?: boolean
  isStreamingTailMessage: boolean
  isLastInTurn: boolean
  isErrorEnvelope: boolean
  isEditing: boolean
  messageContent?: string | null
}): boolean {
  return !input.previewMode
    && !input.isStreamingTailMessage
    && input.isLastInTurn
    && input.isErrorEnvelope
    && !input.isEditing
    && !!input.messageContent
    && input.messageContent.trim().length > 0
}

function deriveAgentRunRollback(input: {
  isActiveSession: boolean
  isUser: boolean
  agentRunId: string | null
  isStreaming: boolean
  isRestoring: boolean
}): boolean {
  return input.isActiveSession
    && !input.isUser
    && !!input.agentRunId
    && !input.isStreaming
    && !input.isRestoring
}

export function deriveMessageFooterModel(input: DeriveMessageFooterModelInput): MessageFooterDerivedModel {
  const {
    message,
    sessionId,
    previewMode,
    isUser,
    isActiveSession,
    isRestoring,
    isStreaming,
    runStateSuspended,
    isLastAssistantMsg,
    isLastInTurn,
    isEditing,
    isMiniMessage,
    isErrorEnvelope,
    isPushNotification,
    isStreamingTailMessage,
    displayContent,
    conversationReferenceParsed,
    hasContentBlocks,
    sessionMessages,
    projectTaskResendBlocked = false,
  } = input

  const hasStandardFooterContent = deriveHasStandardFooterContent({
    displayContent,
    conversationReferenceParsed,
    isUser,
    hasContentBlocks,
  })
  const regenerateSourceMessage = isUser
    ? null
    : findRegenerateSourceMessage(sessionMessages, message.id)
  const canRegenerate = shouldShowRegenerateAction({
    sessionId,
    hasRegenerateSource: !!regenerateSourceMessage,
    isActiveSession,
    isUser,
    isLastAssistantMsg,
    isStreaming,
    isRestoring,
    runStateSuspended,
    projectTaskResendBlocked,
  })
  const showStandardFooter = shouldRenderStandardMessageFooter({
    previewMode,
    isStreamingTailMessage,
    isLastInTurn,
    isMiniMessage,
    isErrorEnvelope,
    isEditing,
    isPushNotification,
    hasStandardFooterContent,
  })
  const showErrorEnvelopeFooter = deriveShowErrorEnvelopeFooter({
    previewMode,
    isStreamingTailMessage,
    isLastInTurn,
    isErrorEnvelope,
    isEditing,
    messageContent: message.content,
  })
  const canPreviewRollback = !isUser
  const showRollback = shouldShowRollbackAction({
    isActiveSession,
    isUser,
    canPreviewRollback,
    isStreaming,
    isRestoring,
    isLastAssistantMsg,
  })
  const agentRunId = !isUser ? (message.agent_run_id ?? null) : null
  const showAgentRunRollback = deriveAgentRunRollback({
    isActiveSession,
    isUser,
    agentRunId,
    isStreaming,
    isRestoring,
  })

  return {
    hasStandardFooterContent,
    showStandardFooter,
    showErrorEnvelopeFooter,
    canRegenerate,
    showRollback,
    canPreviewRollback,
    showAgentRunRollback,
    agentRunId,
  }
}
