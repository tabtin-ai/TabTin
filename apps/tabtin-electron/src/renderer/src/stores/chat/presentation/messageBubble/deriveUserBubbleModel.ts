import type { ChatMessage } from '@tabtin/chat-client'
import { parseConversationReferenceMessage } from '@utils/chat/conversationReference'
import { isUnconfirmedLocalMessage } from '@stores/chat/shared/types'
import { deriveUserMessageDisplayContent } from '@utils/chat/messageDisplayContent'
import { deriveUserEchoCards, type UserEchoCard } from './userEchoCards'

export interface DeriveUserBubbleModelInput {
  message: ChatMessage
  metadata: Record<string, unknown> | null | undefined
  currentUserId?: string
  userAlign: 'left' | 'right'
  previewMode?: boolean
  isActiveSession: boolean
  isStreaming: boolean
  isRestoring: boolean
  sessionId?: string | null
  projectTaskResendBlocked?: boolean
}

export interface UserBubbleDerivedModel {
  userSenderDisplayName: string
  userInbound: boolean
  canEdit: boolean
  userEchoCards: UserEchoCard[]
  conversationReferenceParsed: ReturnType<typeof parseConversationReferenceMessage>
  userDisplayContent: string
  displayContent: string
  assistantCopyContent: undefined
  assistantToolbarContent: string
}

function resolveUserConversationReference(message: ChatMessage) {
  // ：优先从结构化块取 raw_block（切会话后 content 可能只有追问正文）
  for (const block of message.content_blocks_json ?? []) {
    if (
      block
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'conversation_reference'
    ) {
      const rawBlock = (block as { raw_block?: unknown }).raw_block
      if (typeof rawBlock === 'string' && rawBlock.trim()) {
        const fromBlock = parseConversationReferenceMessage(rawBlock)
        if (fromBlock) {
          const remainder = typeof message.content === 'string'
            ? message.content.replace(rawBlock, '').trim()
            : ''
          return { ...fromBlock, remainderText: remainder || fromBlock.remainderText }
        }
      }
    }
  }
  const referenceSource = typeof message.content === 'string' && message.content.trim()
    ? message.content
    : (typeof message.text_summary === 'string' ? message.text_summary : '')
  return parseConversationReferenceMessage(referenceSource)
}

function resolveIsOtherSender(message: ChatMessage, currentUserId?: string): boolean {
  return !!message.sender_user_id
    && !!currentUserId
    && String(message.sender_user_id) !== String(currentUserId)
}

export function deriveUserBubbleModel(input: DeriveUserBubbleModelInput): UserBubbleDerivedModel {
  const {
    message,
    metadata,
    currentUserId,
    userAlign,
    previewMode,
    isActiveSession,
    isStreaming,
    isRestoring,
    projectTaskResendBlocked = false,
  } = input

  const userSenderDisplayName = typeof message.sender_display_name === 'string'
    ? message.sender_display_name.trim()
    : ''
  const isOtherSender = resolveIsOtherSender(message, currentUserId)
  const userInbound = userAlign === 'left' || isOtherSender
  const messageBlocks = message.content_blocks_json ?? []
  const userEchoCards = deriveUserEchoCards(messageBlocks, metadata)
  // 外来导入历史只读：避免点 Markdown/表格误进编辑，也不应「改历史重发」
  const isExternalArchive = metadata?.external_archive === true
  const canEdit = !isExternalArchive
    && !isOtherSender
    && isActiveSession
    && !isStreaming
    && !isRestoring
    && !isUnconfirmedLocalMessage(message)
    && !previewMode
    // ：失败 Project Task 会话禁止编辑重发入口
    && !projectTaskResendBlocked
  const conversationReferenceParsed = resolveUserConversationReference(message)
  const userDisplayContent = conversationReferenceParsed
    ? conversationReferenceParsed.remainderText
    : deriveUserMessageDisplayContent(message)

  return {
    userSenderDisplayName,
    userInbound,
    canEdit,
    userEchoCards,
    conversationReferenceParsed,
    userDisplayContent,
    displayContent: userDisplayContent,
    assistantCopyContent: undefined,
    assistantToolbarContent: userDisplayContent,
  }
}
