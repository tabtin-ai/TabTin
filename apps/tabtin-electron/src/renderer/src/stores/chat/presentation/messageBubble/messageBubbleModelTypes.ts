import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import type { parseConversationReferenceMessage } from '@utils/chat/conversationReference'
import type { ErrorClassInfo } from '@utils/chat/messageErrorClassMap'
import type { UserEchoCard } from './userEchoCards'

export const EMPTY_CONTENT_BLOCKS: readonly ContentBlockEntry[] = []

export type Translate = (key: string, options?: Record<string, unknown>) => string

export interface DeriveMessageBubbleModelInput {
  message: ChatMessage
  sessionId?: string | null
  currentUserId?: string
  userAlign?: 'left' | 'right'
  previewMode?: boolean
  isLastAssistantMsg?: boolean
  sessionPulseVisible?: boolean
  isLastInTurn?: boolean
  isEditing?: boolean
  isActiveSession: boolean
  isRestoring: boolean
  isStreaming: boolean
  runStateSuspended: boolean
  sessionMessages: ChatMessage[]
  runtimeBlocks: ContentBlockEntry[]
  contentBlocksOverride?: ContentBlockEntry[]
  projectTaskResendBlocked?: boolean
  t: Translate
  locale: string
}

export interface MessageBubbleDerivedModel {
  isUser: boolean
  isPushNotification: boolean
  userInbound: boolean
  userSenderDisplayName: string
  canReply: boolean
  canEdit: boolean
  messageKind: NonNullable<ChatMessage['message_kind']> | 'llm'
  isMiniMessage: boolean
  isErrorEnvelope: boolean
  isInterrupted: boolean
  intentLabel: string | null
  timestamp: string
  isStreamingTailMessage: boolean
  suppressInlineLoading: boolean
  contentBlocks: ContentBlockEntry[]
  hasContentBlocks: boolean
  displayContent: string
  userDisplayContent: string
  conversationReferenceParsed: ReturnType<typeof parseConversationReferenceMessage>
  assistantCopyContent: string | undefined
  assistantToolbarContent: string
  userEchoCards: UserEchoCard[]
  retryMessageContent: string
  errorMessage?: string
  errorClass?: string
  errorClassInfo: ErrorClassInfo | null
  hasAbortErrorCard: boolean
  suppressBlockPartialReason: boolean
  shouldRenderInterruptedBadge: boolean
  errorClassSkipContent: boolean
  isBillingError: boolean
  hasStandardFooterContent: boolean
  showStandardFooter: boolean
  showErrorEnvelopeFooter: boolean
  canRegenerate: boolean
  showRollback: boolean
  canPreviewRollback: boolean
  showAgentRunRollback: boolean
  agentRunId: string | null
}
