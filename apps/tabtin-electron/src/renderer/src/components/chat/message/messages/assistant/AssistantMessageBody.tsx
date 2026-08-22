import React, { useMemo } from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { Loader2, Pause } from 'lucide-react'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../../blocks/types'
import { CHAT_MESSAGE_TEXT_BODY } from '../../../registry/chatDesignTokens'
import { AgentAwaitingThought } from '../../../turn/AgentAwaitingThought'
import { BillingErrorCard } from '../../../billing/BillingErrorCard'
import { BlockTimeline as DefaultBlockTimeline } from '../../../blocks'
import { getBlockTimelineRenderer } from '../../blockTimelineRendererRegistry'
import { ErrorClassCard } from './ErrorClassCard'
import type { ErrorClassInfo } from '@utils/chat/messageErrorClassMap'
import { MessageBubbleTurnEndSpacer, useMessageBubbleTurnEndLayout } from './MessageBubbleTurnEnd'
import { useMessageBubbleSessionPulseVisible } from '@stores/chat/presentation/messageBubble/useMessageBubbleSessionPulseVisible'
import {
  collectAttachmentFilenameById,
  projectAttachmentBlocksForDisplay,
} from '@utils/chat/thinkingAttachmentDisplay'

const EMPTY_CONTENT_BLOCKS: ContentBlockEntry[] = []

function fallback<T>(value: T | null | undefined, fallbackValue: T): T {
  return value ?? fallbackValue
}

/** 正文 text 块仍在流式（未 finalize 且已有可见文本）——与思考/工具持续动效互斥。 */
function hasLiveStreamingTextBody(blocks: readonly ContentBlockEntry[]): boolean {
  return blocks.some((entry) => {
    if (entry.finalized) return false
    const block = entry.block as { type?: string; text?: string } | undefined
    return block?.type === 'text' && !!block.text?.trim()
  })
}

export interface AssistantMessageBodyProps {
  message: ChatMessage
  timelineMessages?: ChatMessage[]
  sessionId?: string | null
  tabScopeKey?: string | null
  subagentRunSessionId?: string | null
  ownerRunId?: string
  isLastAssistantMsg?: boolean
  sessionPulseVisible?: boolean
  isStreaming: boolean
  isActiveSession: boolean
  runStateSuspended: boolean
  suppressInlineLoading: boolean
  contentBlocks: ContentBlockEntry[]
  hasContentBlocks: boolean
  displayContent: string
  errorMessage?: string
  errorClassInfo: ErrorClassInfo | null
  suppressBlockPartialReason: boolean
  shouldRenderInterruptedBadge: boolean
  errorClassSkipContent: boolean
  isBillingError: boolean
  stalledLevel: 0 | 1 | 2
  showAwaitingThought: boolean
  showPlanningNext: boolean
  onResourceNavigate: (rType: string, rId: string, hint?: string, opts?: { modifierExternal?: boolean; resourceSpaceId?: string }) => void
  onResourceContextMenu: (e: React.MouseEvent<HTMLElement>, rType: string, rId: string, hint?: string) => void
}

const noopResourceNavigate = () => {}
const noopResourceContextMenu = () => {}

// eslint-disable-next-line complexity -- assistant 正文负责 blocks、异常卡、流式状态和轮次尾部占位的组合渲染。
export const AssistantMessageBody: React.FC<Partial<AssistantMessageBodyProps>> = (props) => {
  const message = props.message
  const timelineMessages = props.timelineMessages
  const sessionId = fallback(props.sessionId, null)
  const tabScopeKey = fallback(props.tabScopeKey, null)
  const subagentRunSessionId = fallback(props.subagentRunSessionId, null)
  const ownerRunId = props.ownerRunId
  const isLastAssistantMsg = fallback(props.isLastAssistantMsg, false)
  const sessionPulseVisible = props.sessionPulseVisible
  const isStreaming = fallback(props.isStreaming, false)
  const isActiveSession = fallback(props.isActiveSession, false)
  const runStateSuspended = fallback(props.runStateSuspended, false)
  const suppressInlineLoading = fallback(props.suppressInlineLoading, false)
  const contentBlocks = fallback(props.contentBlocks, EMPTY_CONTENT_BLOCKS)
  const hasContentBlocks = fallback(props.hasContentBlocks, contentBlocks.length > 0)
  const errorMessage = props.errorMessage
  const errorClassInfo = fallback(props.errorClassInfo, null)
  const suppressBlockPartialReason = fallback(props.suppressBlockPartialReason, false)
  const shouldRenderInterruptedBadge = fallback(props.shouldRenderInterruptedBadge, false)
  const errorClassSkipContent = fallback(props.errorClassSkipContent, false)
  const isBillingError = fallback(props.isBillingError, false)
  const stalledLevel = fallback(props.stalledLevel, 0)
  const showAwaitingThought = fallback(props.showAwaitingThought, false)
  const showPlanningNext = fallback(props.showPlanningNext, false)

  const { t } = useTranslation('chat')
  const derivedSessionPulseVisible = useMessageBubbleSessionPulseVisible(sessionId ?? null)
  const effectiveSessionPulseVisible = sessionPulseVisible ?? derivedSessionPulseVisible
  const onResourceNavigate = props.onResourceNavigate ?? noopResourceNavigate
  const onResourceContextMenu = props.onResourceContextMenu ?? noopResourceContextMenu

  const attachmentFilenameById = useMemo(
    () => collectAttachmentFilenameById(timelineMessages),
    [timelineMessages],
  )
  const displayContentBlocks = useMemo(
    () => projectAttachmentBlocksForDisplay(contentBlocks, attachmentFilenameById),
    [attachmentFilenameById, contentBlocks],
  )

  const { showTurnEndSpacer } = useMessageBubbleTurnEndLayout({
    isLastAssistantMsg,
    isStreaming,
    sessionPulseVisible: effectiveSessionPulseVisible,
  })

  // 仅正文 text 块实际流式时显示段尾光标；正文唯一来源是 blocks。
  const showStreamingCaret = useMemo(() => {
    if (!isStreaming || !isActiveSession || !isLastAssistantMsg || runStateSuspended) return false
    if (showAwaitingThought || showPlanningNext) return false
    return hasContentBlocks && hasLiveStreamingTextBody(contentBlocks)
  }, [
    isStreaming,
    isActiveSession,
    isLastAssistantMsg,
    runStateSuspended,
    showAwaitingThought,
    showPlanningNext,
    hasContentBlocks,
    contentBlocks,
  ])

  if (!message) return null

  if (isBillingError) {
    return <BillingErrorCard message={message} sessionId={sessionId} />
  }

  const BlockTimeline = getBlockTimelineRenderer() ?? DefaultBlockTimeline

  return (
    <div
      className={cn(
        'min-w-0 max-w-full text-foreground [overflow-wrap:anywhere]',
        showStreamingCaret && 'chat-motion-streaming-body',
      )}
      data-streaming-caret={showStreamingCaret ? 'true' : undefined}
    >
      {showAwaitingThought && <AgentAwaitingThought mode="thinking" />}
      {hasContentBlocks && !errorClassSkipContent && BlockTimeline ? (
        <BlockTimeline
          blocks={displayContentBlocks}
          sessionId={sessionId ?? null}
          tabScopeKey={tabScopeKey ?? null}
          subagentRunSessionId={subagentRunSessionId}
          ownerRunId={message.subagent_run_id ?? ownerRunId ?? ''}
          messageId={message.id}
          isLastAssistantMsg={isLastAssistantMsg}
          isStreaming={isStreaming}
          suppressPartialReason={suppressBlockPartialReason}
          suppressInlineLoading={suppressInlineLoading}
          onResourceNavigate={onResourceNavigate}
          onResourceContextMenu={onResourceContextMenu}
        />
      ) : null}
      {showPlanningNext && <AgentAwaitingThought mode="planningNext" />}
      {showTurnEndSpacer && <MessageBubbleTurnEndSpacer />}
      {shouldRenderInterruptedBadge && (
        <span className="inline-flex items-center gap-1 mt-1 rounded-md bg-muted/40 px-2 py-0.5 text-caption text-muted-foreground/60">
          <Pause className="h-3 w-3" />
          {t('message.interrupted')}
        </span>
      )}
      {!hasContentBlocks && errorMessage && !errorClassInfo ? (
        <p className={cn('mt-1 text-destructive/80 whitespace-pre-wrap break-words', CHAT_MESSAGE_TEXT_BODY)}>
          {errorMessage}
        </p>
      ) : null}
      {/* ：仅异常终止出卡；ABORT 已在 deriveMessageErrorModel 置空。 */}
      {errorClassInfo && (
        <ErrorClassCard info={errorClassInfo} sessionId={sessionId ?? null} />
      )}
      {isStreaming && isActiveSession && isLastAssistantMsg && !runStateSuspended && stalledLevel > 0 && (
        <div className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg mt-2',
          'bg-muted/40',
        )}>
          <Loader2 className={cn('h-3.5 w-3.5 flex-shrink-0 animate-spin', stalledLevel === 2 ? 'text-warning/80' : 'text-foreground/60')} />
          <span className={cn(CHAT_MESSAGE_TEXT_BODY, stalledLevel === 2 ? 'text-warning/80' : 'text-foreground/60')}>
            {stalledLevel === 2
              ? t('stream.stalledStrong', { defaultValue: '回复生成似乎已停滞' })
              : t('stream.stalledSoft', { defaultValue: 'AI 思考时间较长' })
            }
          </span>
        </div>
      )}
    </div>
  )
}
