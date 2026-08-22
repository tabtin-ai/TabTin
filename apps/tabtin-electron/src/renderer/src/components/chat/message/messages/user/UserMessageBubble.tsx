import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { MousePointerClick } from 'lucide-react'
import { CHAT_MESSAGE_TEXT_BODY } from '../../../registry/chatDesignTokens'
import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import { ContextRefCards, isContextRefBlock, type ContextBlock } from '../../../context/ContextRefCard'
import { ConversationReferenceCard } from '../../../context/ConversationReferenceCard'
import { ConversationReferenceViewerDialog } from '../../../context/ConversationReferenceViewerDialog'
import type { ConversationReferenceDisplay } from '@utils/chat/conversationReference'
import { enterChatSession } from '@/services/chatSessionNavigation'
import { ReplyQuoteBar } from '../../../composer/ReplyQuoteBar'
import type { LocalChatMessage } from '../../../../../stores/chat/shared/types'
import { AttachmentCard } from '../../../composer/AttachmentCard'
import { UserMessageEditMode } from './UserMessageEditMode'
import {
  CollapsibleMessage,
  MSG_COLLAPSE_CHAR_THRESHOLD,
  MSG_COLLAPSE_ENABLED,
} from '../common/CollapsibleMessage'
import { MarkdownRenderer } from '../../../markdown/MarkdownRenderer'
import { ComposerPresetBlockCard } from '../../../composer-presets/ComposerPresetBlockCard'
import { deriveUserAttachments } from '@utils/chat/userMessageAttachments'
import { AgentModeBadge } from './AgentModeBadge'
import { TeamSpaceExecutionLine } from '../common/TeamSpaceExecutionLine'
import { SendStatusIndicator } from './SendStatusIndicator'
import type { UserEchoCard } from '@stores/chat/presentation/messageBubble/userEchoCards'

const EMPTY_MESSAGE_BLOCKS: MessageBlock[] = []
const EMPTY_USER_ECHO_CARDS: UserEchoCard[] = []

function fallback<T>(value: T | null | undefined, fallbackValue: T): T {
  return value ?? fallbackValue
}

function renderWidgetSendPromptBadge(
  metadata: Record<string, unknown> | null | undefined,
  label: string,
) {
  if (metadata?.source !== 'widget' && metadata?.via_widget !== true) return null
  return (
    <div className="flex justify-end mt-0.5" data-testid="widget-send-prompt-badge">
      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 border border-primary/20 px-1.5 py-0.5 text-caption text-primary/80">
        <MousePointerClick className="h-3 w-3" />
        {label}
      </span>
    </div>
  )
}

export interface UserMessageBubbleProps {
  message: ChatMessage
  sessionId?: string | null
  isEditing: boolean
  onEditingChange: (editing: boolean) => void
  userInbound: boolean
  userSenderDisplayName: string
  canEdit: boolean
  displayContent: string
  messageBlocks: MessageBlock[]
  userEchoCards: UserEchoCard[]
  conversationReferenceParsed: ReturnType<typeof import('@utils/chat/conversationReference').parseConversationReferenceMessage>
  retryMessageContent: string
  onContextBlockNavigate?: (block: ContextBlock) => void
  onUserMessageExpand?: (messageId: string) => void
}

// eslint-disable-next-line complexity -- 用户消息气泡负责文本、附件、上下文引用、重试状态的组合渲染。
export const UserMessageBubble: React.FC<Partial<UserMessageBubbleProps>> = (props) => {
  const message = props.message
  const sessionId = fallback(props.sessionId, null)
  const isEditing = fallback(props.isEditing, false)
  const onEditingChange = fallback(props.onEditingChange, () => {})
  const userInbound = fallback(props.userInbound, false)
  const userSenderDisplayName = props.userSenderDisplayName ?? ''
  const canEdit = fallback(props.canEdit, false)
  const displayContent = fallback(props.displayContent, fallback(message?.content, ''))
  const messageBlocks = fallback(props.messageBlocks, EMPTY_MESSAGE_BLOCKS)
  const userEchoCards = fallback(props.userEchoCards, EMPTY_USER_ECHO_CARDS)
  const conversationReferenceParsed = fallback(props.conversationReferenceParsed, null)
  const retryMessageContent = fallback(props.retryMessageContent, fallback(message?.content, ''))
  const onContextBlockNavigate = props.onContextBlockNavigate
  const onUserMessageExpand = props.onUserMessageExpand
  const { t } = useTranslation('chat')

  const hasContextRefs = messageBlocks.some(isContextRefBlock)
  const messageAttachments = deriveUserAttachments(message?.attachments_json, messageBlocks)
  const hasAttachments = messageAttachments.length > 0
  const isExternalArchive =
    (message?.metadata as Record<string, unknown> | null | undefined)?.external_archive === true

  const [refViewerOpen, setRefViewerOpen] = useState(false)

  const handleOpenConversationReference = useCallback(async (reference: ConversationReferenceDisplay) => {
    if (!reference.spaceId || !reference.sessionId) {
      // 交接场景：无 spaceId，改为弹窗展示 rawBlock 对话内容
      setRefViewerOpen(true)
      return
    }
    const unavailable = t('session.conversationReference.unavailable', {
      defaultValue: '源对话不可用',
    })
    await enterChatSession(reference.spaceId, reference.sessionId, {
      organizationId: reference.organizationId,
      verifySessionExists: true,
      sessionFailureMessage: unavailable,
      sessionNotFoundMessage: unavailable,
    })
  }, [t])

  if (!message) return null

  if (isEditing) {
    return (
      <UserMessageEditMode
        message={message}
        sessionId={sessionId}
        onCancel={() => onEditingChange(false)}
      />
    )
  }

  return (
    <div
      className="space-y-1"
      onClick={(e) => {
        if (!canEdit) return
        const target = e.target as HTMLElement
        if (!target.closest('[data-user-message-edit-bubble="true"]')) return
        if (target.closest('a, button')) return
        onEditingChange(true)
      }}
    >
      {userSenderDisplayName && (
        <div
          className={cn(
            'text-caption text-muted-foreground/60',
            userInbound ? 'mr-auto text-left' : 'ml-auto text-right',
          )}
        >
          {userSenderDisplayName}
        </div>
      )}
      {message.reply_to_preview && (
        <div className={cn('max-w-[320px]', userInbound ? 'mr-auto' : 'ml-auto')}>
          <ReplyQuoteBar preview={message.reply_to_preview} />
        </div>
      )}
      {hasContextRefs && (
        <div className={cn('max-w-[280px]', userInbound ? 'mr-auto' : 'ml-auto')}>
          <ContextRefCards blocks={messageBlocks} onNavigate={onContextBlockNavigate} />
        </div>
      )}
      {userEchoCards.length > 0 && (
        <div className={cn('max-w-[320px] space-y-1.5', userInbound ? 'mr-auto' : 'ml-auto')}>
          {userEchoCards.map(c => (
            <ComposerPresetBlockCard
              key={c.key}
              presetId={c.presetId}
              params={c.params}
              source={c.source}
            />
          ))}
        </div>
      )}
      {hasAttachments && (
        <div className={cn('flex flex-wrap items-start gap-2', userInbound ? 'justify-start' : 'justify-end')}>
          {messageAttachments.map((att, i) => (
            <AttachmentCard
              key={att.file_id || i}
              attachment={att}
              messageId={message.id}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
      {conversationReferenceParsed && (
        <>
          <ConversationReferenceCard
            reference={conversationReferenceParsed.reference}
            align={userInbound ? 'left' : 'right'}
            onOpen={(ref) => { void handleOpenConversationReference(ref) }}
          />
          <ConversationReferenceViewerDialog
            open={refViewerOpen}
            onOpenChange={setRefViewerOpen}
            reference={conversationReferenceParsed.reference}
            rawBlock={conversationReferenceParsed.rawBlock}
          />
        </>
      )}
      {displayContent && displayContent.trim().length > 0 && (
        <div
          data-user-message-edit-bubble="true"
          className={cn(
            'w-fit max-w-full rounded-2xl px-4 py-2.5',
            CHAT_MESSAGE_TEXT_BODY,
            userInbound ? 'mr-auto rounded-bl-md' : 'ml-auto rounded-br-md',
            canEdit && 'cursor-text',
            'bg-background/95',
          )}
        >
          <CollapsibleMessage
            messageId={message.id}
            content={displayContent}
            shouldCollapse={MSG_COLLAPSE_ENABLED && displayContent.length > MSG_COLLAPSE_CHAR_THRESHOLD}
            onExpand={
              onUserMessageExpand
                ? () => onUserMessageExpand(message.id)
                : undefined
            }
          >
            {() =>
              isExternalArchive ? (
                <div className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                  <MarkdownRenderer content={displayContent} />
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words">
                  {displayContent}
                </div>
              )
            }
          </CollapsibleMessage>
        </div>
      )}
      {renderWidgetSendPromptBadge(message.metadata, t('widgetSendPrompt.badge', '来自 widget 点击'))}
      <AgentModeBadge metadata={message.metadata} />
      <TeamSpaceExecutionLine
        metadata={message.metadata}
        align={userInbound ? 'left' : 'right'}
      />
      <SendStatusIndicator
        sendStatus={(message as LocalChatMessage).sendStatus}
        messageId={message.id}
        messageContent={retryMessageContent}
        sessionId={sessionId ?? null}
        attachmentsJson={message.attachments_json}
        blocksJson={message.content_blocks_json}
      />
    </div>
  )
}
