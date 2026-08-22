import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { deriveTextClipboardContent, deriveTextSummary } from '@/utils/contentBlockSummary'
import type { Translate } from './messageBubbleModelTypes'
import { resolveMessageContentBlocks } from './resolveMessageContentBlocks'
import { localizeErrorContent, sanitizeErrorContent } from '@utils/chat/messageErrorContent'

export interface DeriveAssistantBubbleModelInput {
  message: ChatMessage
  messageKind: NonNullable<ChatMessage['message_kind']> | 'llm'
  metadata: Record<string, unknown> | null | undefined
  runtimeBlocks: ContentBlockEntry[]
  contentBlocksOverride?: ContentBlockEntry[]
  t: Translate
  hasErrorIndicators: boolean
}

export interface AssistantBubbleDerivedModel {
  isMiniMessage: boolean
  isErrorEnvelope: boolean
  contentBlocks: ContentBlockEntry[]
  hasContentBlocks: boolean
  userDisplayContent: string
  conversationReferenceParsed: null
  userEchoCards: []
  displayContent: string
  assistantCopyContent: string | undefined
  assistantToolbarContent: string
}

export function deriveAssistantBubbleModel(input: DeriveAssistantBubbleModelInput): AssistantBubbleDerivedModel {
  const {
    message,
    messageKind,
    metadata,
    runtimeBlocks,
    contentBlocksOverride,
    t,
    hasErrorIndicators,
  } = input

  const isMiniMessage = messageKind === 'tool_artifact'
  const isErrorEnvelope = messageKind === 'error_envelope'
  const isPartialSegment = metadata?._timeline_is_partial === true
  // 正文：非 partial 信 runtimeBlocks，store 空时回落 message.blocks（ 归档冷读）；
  // partial 只信列表下发的 contentBlocksOverride。
  const contentBlocks = resolveMessageContentBlocks({
    isUser: false,
    contentBlocksOverride,
    isPartialSegment,
    runtimeBlocks,
    messageBlocks: message.blocks as ContentBlockEntry[] | undefined,
  })
  const hasContentBlocks = contentBlocks.length > 0
  // content 仍是 ≤200 text_summary（列表预览）；气泡正文只走 BlockTimeline。
  const displayContent = message.content
    ? sanitizeErrorContent(
      localizeErrorContent(message.content, t),
      hasErrorIndicators,
      t,
    )
    : ''
  const assistantCopyContent = deriveTextClipboardContent(contentBlocks) || displayContent
  const assistantToolbarContent = displayContent || deriveTextSummary(contentBlocks)

  return {
    isMiniMessage,
    isErrorEnvelope,
    contentBlocks,
    hasContentBlocks,
    userDisplayContent: '',
    conversationReferenceParsed: null,
    userEchoCards: [],
    displayContent,
    assistantCopyContent,
    assistantToolbarContent,
  }
}
