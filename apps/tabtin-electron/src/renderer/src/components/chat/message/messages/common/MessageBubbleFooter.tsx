import React from 'react'
import { cn } from '@utils/cn'
import type { ChatMessage } from '@tabtin/chat-client'
import type { CheckpointFooterMeta } from '@stores/chat/presentation/messageBubble/checkpointFooterMeta'
import { MessageCostLabel } from '../../../billing/MessageCostLabel'
import { MessageActions } from './MessageActions'
import { MessageRelativeTimestamp } from './MessageRelativeTimestamp'
import { MessageRoundTimingLabel } from './MessageRoundTimingLabel'
import { TeamSpaceExecutionLine } from './TeamSpaceExecutionLine'

const FOOTER_BASE_CLASS = cn(
  'flex min-w-0 items-center gap-2 text-caption overflow-visible transition-opacity duration-200 justify-between',
  'max-h-8 opacity-100 mt-1',
  '[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0',
  '[@media(hover:hover)_and_(pointer:fine)]:group-hover/msg:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/msg:opacity-100',
  '[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/msg:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/msg:opacity-100',
)

const FOOTER_ERROR_CLASS = cn(
  'flex min-w-0 items-center gap-2 text-caption overflow-hidden transition-opacity duration-200 justify-between',
  'max-h-8 opacity-100 mt-1',
  '[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0',
  '[@media(hover:hover)_and_(pointer:fine)]:group-hover/msg:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/msg:opacity-100',
  '[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/msg:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/msg:opacity-100',
)

export interface MessageBubbleFooterProps {
  variant: 'standard' | 'error_envelope'
  message: ChatMessage
  sessionId?: string | null
  isUser: boolean
  /** 本条是否会话内最后一条 assistant——供 debug 单轮计时读 runState */
  isLastAssistantMsg?: boolean
  /** 相对时间由叶子订阅 timeTick context，不进气泡 memo props */
  createdAt: string
  intentLabel: string | null
  displayContent: string
  assistantToolbarContent: string
  assistantCopyContent?: string
  userSenderDisplayName: string
  canEdit: boolean
  canReply: boolean
  canRegenerate: boolean
  showRollback: boolean
  showAgentRunRollback: boolean
  agentRunRollingBack: boolean
  isActiveSession: boolean
  checkpointSemanticFeedback: CheckpointFooterMeta['checkpointSemanticFeedback']
  checkpointBadgeTitle: string
  onEdit: () => void
  onRegenerate?: () => void
  onRollback?: () => void
  onAgentRunRollback?: () => void
  onFork?: () => void
  forkWholeSession?: boolean
  onReply?: () => void
  showCopy?: boolean
}

export const MessageBubbleFooter: React.FC<MessageBubbleFooterProps> = ({
  variant,
  message,
  sessionId,
  isUser,
  isLastAssistantMsg = false,
  createdAt,
  intentLabel,
  displayContent: _displayContent,
  assistantToolbarContent,
  assistantCopyContent,
  userSenderDisplayName: _userSenderDisplayName,
  canEdit,
  canReply,
  canRegenerate,
  showRollback,
  showAgentRunRollback,
  agentRunRollingBack,
  isActiveSession: _isActiveSession,
  checkpointSemanticFeedback,
  checkpointBadgeTitle,
  onEdit,
  onRegenerate,
  onRollback,
  onAgentRunRollback,
  onFork,
  forkWholeSession = false,
  onReply,
  showCopy = true,
// eslint-disable-next-line complexity -- footer 聚合时间、成本、checkpoint 与动作入口，分支对应稳定的产品能力矩阵。
}) => {
  const isErrorEnvelope = variant === 'error_envelope'
  const contentForActions = isErrorEnvelope ? (message.content ?? '') : assistantToolbarContent
  const usageJson = (message as ChatMessage & { usage_json?: Record<string, unknown> | null }).usage_json ?? {}
  const costMetadata = {
    ...(message.metadata ?? {}),
    ...usageJson,
    last_input_tokens: usageJson.input_tokens
      ?? message.metadata?.last_input_tokens,
    last_output_tokens: usageJson.output_tokens
      ?? message.metadata?.last_output_tokens,
    last_cache_read_input_tokens: usageJson.cache_read_input_tokens
      ?? message.metadata?.last_cache_read_input_tokens,
    last_cache_creation_input_tokens: usageJson.cache_creation_input_tokens
      ?? message.metadata?.last_cache_creation_input_tokens,
  }

  return (
    <div
      className={isErrorEnvelope ? FOOTER_ERROR_CLASS : FOOTER_BASE_CLASS}
      data-testid={isErrorEnvelope ? 'error-envelope-footer' : undefined}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-muted-foreground/45',
          isErrorEnvelope ? 'overflow-hidden justify-start' : 'overflow-visible justify-start',
        )}
      >
        {!isUser && !isErrorEnvelope && intentLabel && (
          <span className="min-w-0 max-w-[min(100%,12rem)] truncate rounded-md bg-muted/30 px-1.5 py-0.5 text-caption text-muted-foreground/80">
            {intentLabel}
          </span>
        )}
        {!isUser && !isErrorEnvelope && checkpointSemanticFeedback && (
          <span
            className={cn(
              'min-w-0 max-w-[min(100%,14rem)] truncate rounded-md px-1.5 py-0.5 text-caption font-medium',
              checkpointSemanticFeedback.tone === 'success'
                ? 'border border-success/30 text-success'
                : checkpointSemanticFeedback.tone === 'warning'
                  ? 'border border-warning/30 text-warning'
                  : checkpointSemanticFeedback.tone === 'destructive'
                    ? 'border border-destructive/30 text-destructive'
                    : 'bg-muted/40 text-muted-foreground',
            )}
            title={checkpointBadgeTitle}
          >
            {checkpointSemanticFeedback.badgeLabel}
          </span>
        )}
        <MessageRelativeTimestamp createdAt={createdAt} />
        {!isUser && !isErrorEnvelope && <TeamSpaceExecutionLine metadata={message.metadata} />}
        {!isUser && !isErrorEnvelope && <MessageCostLabel metadata={costMetadata} />}
        {!isUser && !isErrorEnvelope && (
          <MessageRoundTimingLabel
            sessionId={sessionId}
            message={message}
            isLastAssistantMsg={isLastAssistantMsg}
          />
        )}
      </div>

      <MessageActions
        content={contentForActions}
        copyContent={isErrorEnvelope ? undefined : (assistantCopyContent || undefined)}
        isUser={isUser}
        canEdit={canEdit}
        onEdit={onEdit}
        onRegenerate={canRegenerate ? onRegenerate : undefined}
        showRollback={showRollback}
        rollbackTitle={checkpointSemanticFeedback?.rollbackTooltip}
        onRollback={onRollback}
        showAgentRunRollback={showAgentRunRollback}
        agentRunRollingBack={agentRunRollingBack}
        onAgentRunRollback={onAgentRunRollback}
        onFork={onFork}
        forkWholeSession={forkWholeSession}
        onReply={canReply ? onReply : undefined}
        showCopy={showCopy}
      />
    </div>
  )
}
