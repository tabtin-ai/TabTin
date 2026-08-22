import type { ChatMessage } from '@tabtin/chat-client'
import {
  isContextInjectionMessage,
  isRenderableUserMessage,
} from '@stores/chat/messages/utils/semanticMessageCount'
import { isAssistantInterruptedMessage } from '@stores/chat/messages/utils/assistantInterrupt'
import { isEmptyInterruptedAssistantShell } from '@stores/chat/messages/utils/emptyInterruptedAssistant'
import type { LocalChatMessage } from '@stores/chat/shared/types'
import type { Translate } from './messageBubbleModelTypes'
import { formatTime, getIntentLabel } from '@utils/chat/messageTime'
import { shouldHideEntireMessageBubble } from './resolveMessageContentBlocks'
import { deriveResolvedAskChoicePresentation } from './resolvedAskChoicePresentation'
import { isPushNotificationMessage } from './timelineMessageVisibility'

export { isAssistantInterruptedMessage }

export function isInternalNonRenderableMessage(input: {
  message: ChatMessage
  metadata: Record<string, unknown> | null | undefined
  messageKind: NonNullable<ChatMessage['message_kind']> | 'llm'
}): boolean {
  const { message, metadata, messageKind } = input
  return deriveMessageBubbleVisibility({
    message,
    metadata,
    messageKind,
    hideAnchoredPushNotification: false,
  }).shouldHideEntireBubble
}

export function deriveMessageBubbleVisibility(input: {
  message: ChatMessage
  metadata: Record<string, unknown> | null | undefined
  messageKind: NonNullable<ChatMessage['message_kind']> | 'llm'
  hideAnchoredPushNotification: boolean
}): {
  isPushNotification: boolean
  shouldHideEntireBubble: boolean
} {
  const { message, metadata, messageKind, hideAnchoredPushNotification } = input
  const isPushNotification = isPushNotificationMessage(message)
  const isEnvironmentContext = isContextInjectionMessage(message)
  const isNonRenderableUserMessage =
    message.role === 'user'
    && !isPushNotification
    && !isRenderableUserMessage(message)
  const isHitlInteraction = messageKind === 'hitl_interaction'
    && deriveResolvedAskChoicePresentation(metadata) === null
  const isSkillInjection = metadata?.source === 'skill_invoke'
  const isContinuationTrigger = metadata?.triggered_by === 'continuation'
  const isEmptyInterruptedAssistant =
    messageKind === 'llm'
    && isEmptyInterruptedAssistantShell(message, metadata)
  return {
    isPushNotification,
    shouldHideEntireBubble: shouldHideEntireMessageBubble({
      isSkillInjection,
      hideAnchoredPushNotification,
      isEnvironmentContext: isEnvironmentContext || isNonRenderableUserMessage,
      isHitlInteraction,
      isEmptyInterruptedAssistant,
      isContinuationTrigger,
    }),
  }
}

export function deriveCanReply(input: {
  message: ChatMessage
  sessionId: string | null
  previewMode?: boolean
  messageKind: NonNullable<ChatMessage['message_kind']> | 'llm'
}): boolean {
  const { message, sessionId, previewMode, messageKind } = input
  return !!sessionId
    && !previewMode
    && (message.role === 'user' || message.role === 'assistant')
    && !message.id.startsWith('temp-')
    && (message as LocalChatMessage).sendStatus !== 'sending'
    && (message as LocalChatMessage).sendStatus !== 'failed'
    && messageKind === 'llm'
}

export function deriveInterruptPresentation(input: {
  message: ChatMessage
  metadata: Record<string, unknown> | null | undefined
  t: Translate
  locale: string
}): {
  isInterrupted: boolean
  intentLabel: string | null
  timestamp: string
} {
  const { message, metadata, t, locale } = input
  const isInterrupted = isAssistantInterruptedMessage(message, metadata)
  const intentLabel = (message.intent && !isInterrupted)
    ? getIntentLabel(message.intent, t, locale)
    : null
  const timestamp = formatTime(message.created_at, t, locale)

  return { isInterrupted, intentLabel, timestamp }
}

export function deriveStreamingPresentation(input: {
  isStreaming: boolean
  isLastAssistantMsg: boolean
  sessionPulseVisible: boolean
}): {
  isStreamingTailMessage: boolean
  suppressInlineLoading: boolean
} {
  return {
    isStreamingTailMessage: input.isStreaming && input.isLastAssistantMsg,
    suppressInlineLoading: input.sessionPulseVisible && input.isLastAssistantMsg,
  }
}

export function deriveRetryMessageContent(input: {
  message: ChatMessage
  metadata: Record<string, unknown> | null | undefined
}): string {
  const { message, metadata } = input
  if (
    (metadata?.source === 'widget' || metadata?.via_widget === true)
    && typeof metadata?.raw_text === 'string'
  ) {
    return metadata.raw_text
  }
  return message.content || ''
}
