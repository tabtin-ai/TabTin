/**
 * MessageBubble - 单条消息气泡（orchestrator）
 *
 * 订阅 store → deriveMessageBubbleModel → 路由到子组件。
 */

import React from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../blocks/types'
import type { ContextBlock } from '../../context/ContextRefCard'
import type { TurnArtifact } from '../../turn/turnArtifacts'
import { shouldShowTurnArtifactsCard } from '../../turn/turnArtifacts'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@components/ui'
import { ErrorBoundary } from '../../../common/ErrorBoundary'
import { MessageErrorFallback } from '../MessageErrorFallback'
import { messageBubblePropsAreEqual } from './common/messageBubbleMemoCompare'
import { isCompactionSummaryPresentation } from '@stores/chat/presentation/messageBubble/compactionSummaryPresentation'
import { SystemMessageBubble } from './system/SystemMessageBubble'
import { UserMessageBubble } from './user/UserMessageBubble'
import { AssistantMessageBody } from './assistant/AssistantMessageBody'
import { TurnAgentBadge } from './assistant/TurnAgentBadge'
import { MessageBubbleFooter } from './common/MessageBubbleFooter'
import { MessageBubbleTurnExtras } from './common/MessageBubbleTurnExtras'
import { useMessageBubbleOrchestration } from '@stores/chat/presentation/messageBubble/useMessageBubbleOrchestration'
import { ExternalArchivePrefixBubble, parseExternalArchivePrefix, resolveImportSourceLabel } from './system/ExternalArchivePrefixBubble'
import { PlanProposalCard, extractPlanProposalMetadata } from '@components/plan-proposal/PlanProposalCard'
import { ModeSwitchProposalCard, extractModeSwitchProposalMetadata } from '@components/plan-proposal/ModeSwitchProposalCard'
import { PushNotificationBubble } from './notification/PushNotificationBubble'
import { parsePushNotification } from '@utils/chat/pushNotificationParse'
import {
  isAgentSwitchedSystemMessage,
  isSubagentCompletionPush,
} from '@stores/chat/presentation/messageBubble/timelineMessageVisibility'
import { deriveMessageBubbleVisibility } from '@stores/chat/presentation/messageBubble/messageBubblePresentationDerivers'
import { deriveResolvedAskChoicePresentation } from '@stores/chat/presentation/messageBubble/resolvedAskChoicePresentation'
import { ResolvedAskChoiceResultCard } from './hitl/ResolvedAskChoiceResultCard'
import {
  OWNER_SESSION_ACCESS_CAPABILITIES,
  type SessionAccessCapabilities,
} from '../../sessionAccessCapabilities'
import { useChatStore } from '../../../../stores/chat/useChatStore'

export { SendStatusIndicator } from './user/SendStatusIndicator'

export interface MessageBubbleProps {
  message: ChatMessage
  sessionId?: string | null
  tabScopeKey?: string | null
  isLastAssistantMsg?: boolean
  sessionPulseVisible?: boolean
  isLastInTurn?: boolean
  subagentRunSessionId?: string | null
  ownerRunId?: string
  showSubagentCompletionPush?: boolean
  onFork?: (messageId: string) => void
  onContextBlockNavigate?: (block: ContextBlock) => void
  onContextBlockContextMenu?: (block: ContextBlock, x: number, y: number) => void
  userAlign?: 'left' | 'right'
  previewMode?: boolean
  contentBlocksOverride?: ContentBlockEntry[]
  /** ：同用户轮内 run 续块，隐藏重复小Tin 头。 */
  hideAgentBadge?: boolean
  highlightedMessageId?: string | null
  highlightKey?: string
  isMini?: boolean
  isSameTurnAssistant?: boolean
  timelineMessages?: ChatMessage[]
  timelineIndex?: number
  includeSubagentMessages?: boolean
  timelineIsStreaming?: boolean
  turnArtifacts?: TurnArtifact[]
  historyArtifacts?: TurnArtifact[]
  /** 稳定回调：列表层直接传 (messageId) => void，勿再包 inline */
  onUserMessageExpand?: (messageId: string) => void
  accessCapabilities?: SessionAccessCapabilities
}

function shouldRenderTurnArtifacts({
  sessionId,
  artifacts,
  timelineMessages,
  timelineIndex,
  includeSubagentMessages,
  timelineIsStreaming,
}: {
  sessionId: string | null
  artifacts?: TurnArtifact[]
  timelineMessages?: ChatMessage[]
  timelineIndex?: number
  includeSubagentMessages?: boolean
  timelineIsStreaming?: boolean
}) {
  if (!artifacts) return false
  if (!timelineMessages || timelineIndex == null) return true
  if (includeSubagentMessages) return false
  return shouldShowTurnArtifactsCard({
    sessionId,
    artifacts,
    messages: timelineMessages,
    index: timelineIndex,
    isStreaming: timelineIsStreaming ?? false,
  })
}

// eslint-disable-next-line complexity -- 顶层路由负责特殊消息类型分发；各气泡渲染已下沉到子组件。
const MessageBubbleInner: React.FC<MessageBubbleProps> = (props) => {
  const { t } = useTranslation('chat')
  const {
    message,
    sessionId = null,
    tabScopeKey = null,
    isLastAssistantMsg = false,
    sessionPulseVisible,
    isLastInTurn = true,
    subagentRunSessionId,
    ownerRunId,
    showSubagentCompletionPush = false,
    userAlign = 'right',
    previewMode,
    contentBlocksOverride,
    hideAgentBadge = false,
    highlightedMessageId = null,
    highlightKey,
    isMini,
    isSameTurnAssistant,
    timelineMessages,
    timelineIndex,
    includeSubagentMessages,
    timelineIsStreaming,
    onFork,
    onContextBlockNavigate,
    onContextBlockContextMenu,
    turnArtifacts,
    historyArtifacts,
    onUserMessageExpand,
    accessCapabilities = OWNER_SESSION_ACCESS_CAPABILITIES,
  } = props

  const orchestration = useMessageBubbleOrchestration({
    message,
    sessionId,
    subagentRunSessionId,
    userAlign,
    previewMode,
    isLastAssistantMsg,
    sessionPulseVisible,
    isLastInTurn,
    contentBlocksOverride,
  })
  const {
    model,
    isActiveSession,
    isEditing,
    setIsEditing,
    agentRunRollingBack,
    agentRunRollbackConfirmOpen,
    setAgentRunRollbackConfirmOpen,
    handleAgentRunRollback,
    handleRegenerate,
    checkpointSemanticFeedback,
    checkpointBadgeTitle,
  } = orchestration

  const messageMeta = message.metadata as Record<string, unknown> | null | undefined
  const messageKind = message.message_kind ?? 'llm'
  const resolvedAskChoice = deriveResolvedAskChoicePresentation(messageMeta)
  const externalSource =
    messageMeta?.external_archive === true && typeof messageMeta.source === 'string'
      ? messageMeta.source
      : null
  const externalSourceLabel = externalSource
    ? resolveImportSourceLabel(externalSource)
    : null
  // 特殊气泡：命中后立即返回，避免落到通用 system / user / assistant 渲染。
  if (isAgentSwitchedSystemMessage(message)) {
    return null
  }

  const planProposalMeta = extractPlanProposalMetadata(message.metadata)
  if (planProposalMeta) {
    return <PlanProposalCard metadata={planProposalMeta} sessionId={sessionId ?? null} messageId={message.id} />
  }

  const modeSwitchMeta = extractModeSwitchProposalMetadata(message.metadata)
  if (modeSwitchMeta) {
    return <ModeSwitchProposalCard metadata={modeSwitchMeta} sessionId={sessionId ?? null} messageId={message.id} />
  }

  const isCompactionSummary = isCompactionSummaryPresentation(message)
  if (isCompactionSummary) {
    return <SystemMessageBubble message={message} variant="compaction_checkpoint" />
  }

  const externalPrefix = parseExternalArchivePrefix(message)
  if (externalPrefix) {
    return <ExternalArchivePrefixBubble info={externalPrefix} />
  }

  const visibility = deriveMessageBubbleVisibility({
    message,
    metadata: messageMeta,
    messageKind,
    hideAnchoredPushNotification: showSubagentCompletionPush ? false : orchestration.hideAnchoredPushNotification,
  })

  if (visibility.shouldHideEntireBubble) {
    return null
  }

  if (resolvedAskChoice) {
    return <ResolvedAskChoiceResultCard result={resolvedAskChoice} />
  }

  const pushNotification = parsePushNotification(message.content)
  if (pushNotification && visibility.isPushNotification) {
    if (isSubagentCompletionPush(message) && !showSubagentCompletionPush) return null
    return <PushNotificationBubble message={message} />
  }

  const systemFact = typeof messageMeta?.system_fact === 'string' ? messageMeta.system_fact : null
  const shouldRenderSystemPill =
    message.role === 'system'
    && (
      (messageMeta?.source === 'manual_compact_status' && messageMeta?.status === 'running')
      || systemFact === 'checkpoint_rewind_summary'
      || systemFact === 'checkpoint_unrevert_summary'
      || systemFact === 'ask_user_auto_skipped'
      || systemFact === 'device_status'
    )
  if (shouldRenderSystemPill) {
    return <SystemMessageBubble message={message} variant="status_pill" />
  }

  if (message.role === 'system' && !visibility.isPushNotification) {
    return null
  }

  const canEdit = model.canEdit && accessCapabilities.canMutateHistory
  const canRegenerate = model.canRegenerate && accessCapabilities.canMutateHistory
  const canReply = model.canReply && accessCapabilities.canReply
  const showRollback = model.showRollback && accessCapabilities.canMutateHistory
  const showAgentRunRollback = model.showAgentRunRollback && accessCapabilities.canMutateHistory
  const showTurnArtifacts = shouldRenderTurnArtifacts({
    sessionId,
    artifacts: turnArtifacts,
    timelineMessages,
    timelineIndex,
    includeSubagentMessages,
    timelineIsStreaming,
  })
  const shouldHighlight = highlightedMessageId === message.id

  const onResourceNavigate = (
    rType: string,
    rId: string,
    hint?: string,
    opts?: { modifierExternal?: boolean; resourceSpaceId?: string },
  ) => {
    onContextBlockNavigate?.({
      type: rType,
      resource_id: rId,
      space_id: opts?.resourceSpaceId,
      hint_carrier_app_id: hint,
      modifierExternal: opts?.modifierExternal,
    } as ContextBlock)
  }

  const onResourceContextMenu = (e: React.MouseEvent<HTMLElement>, rType: string, rId: string, hint?: string) => {
    onContextBlockContextMenu?.({
      type: rType,
      resource_id: rId,
      hint_carrier_app_id: hint,
    } as ContextBlock, e.clientX, e.clientY)
  }

  const messageBody = model.isUser ? (
    <UserMessageBubble
      message={message}
      sessionId={sessionId}
      isEditing={isEditing}
      onEditingChange={setIsEditing}
      userInbound={model.userInbound}
      userSenderDisplayName={model.userSenderDisplayName}
      canEdit={canEdit}
      displayContent={model.displayContent}
      messageBlocks={orchestration.messageBlocks}
      userEchoCards={model.userEchoCards}
      conversationReferenceParsed={model.conversationReferenceParsed}
      retryMessageContent={model.retryMessageContent}
      onContextBlockNavigate={onContextBlockNavigate}
      onUserMessageExpand={onUserMessageExpand}
    />
  ) : (
    <>
      {!hideAgentBadge && (
        <TurnAgentBadge
          agentId={message.agent_id}
          displayNameOverride={externalSourceLabel ?? message.agent_name}
          avatarUrlOverride={message.agent_avatar}
          avatarIdOverride={externalSource ? `external:${externalSource}` : null}
        />
      )}
      <AssistantMessageBody
        message={message}
        timelineMessages={timelineMessages}
        sessionId={sessionId}
        tabScopeKey={tabScopeKey}
        subagentRunSessionId={subagentRunSessionId}
        ownerRunId={ownerRunId}
        isLastAssistantMsg={isLastAssistantMsg}
        sessionPulseVisible={sessionPulseVisible}
        isStreaming={orchestration.isStreaming}
        isActiveSession={isActiveSession}
        runStateSuspended={orchestration.runStateSuspended}
        suppressInlineLoading={model.suppressInlineLoading}
        contentBlocks={model.contentBlocks}
        hasContentBlocks={model.hasContentBlocks}
        displayContent={model.displayContent}
        errorMessage={model.errorMessage}
        errorClassInfo={model.errorClassInfo}
        suppressBlockPartialReason={model.suppressBlockPartialReason}
        shouldRenderInterruptedBadge={model.shouldRenderInterruptedBadge}
        errorClassSkipContent={model.errorClassSkipContent}
        isBillingError={model.isBillingError}
        stalledLevel={orchestration.stalledLevel}
        showAwaitingThought={orchestration.showAwaitingThought}
        showPlanningNext={orchestration.showPlanningNext}
        onResourceNavigate={onResourceNavigate}
        onResourceContextMenu={onResourceContextMenu}
      />
    </>
  )

  return (
    <div
      data-highlight-key={shouldHighlight ? highlightKey : undefined}
      data-same-turn-assistant={isSameTurnAssistant ? 'true' : undefined}
      data-mid-turn={!isLastInTurn ? 'true' : undefined}
      data-mini-message={isMini ? 'true' : undefined}
      className={cn(
        'group/msg relative flex flex-col',
        shouldHighlight && 'animate-message-highlight',
        isSameTurnAssistant && '-mt-3',
        model.isUser
          ? (model.userInbound ? 'items-start pt-3 pb-0' : 'items-end pt-3 pb-0')
          : 'items-start py-2',
      )}
    >
      <div
        className={cn(
          model.isUser
            ? (isEditing ? 'w-full max-w-full' : 'max-w-[85%] w-full')
            : 'w-full min-w-0 max-w-full',
        )}
      >
        {messageBody}
      </div>

      <MessageBubbleTurnExtras
        sessionId={sessionId}
        tabScopeKey={tabScopeKey}
        isLastInTurn={isLastInTurn}
        isUser={model.isUser}
        isMiniMessage={model.isMiniMessage}
        isErrorEnvelope={model.isErrorEnvelope}
        turnArtifacts={showTurnArtifacts ? turnArtifacts : undefined}
        historyArtifacts={showTurnArtifacts ? historyArtifacts : undefined}
        canOpenArtifacts={accessCapabilities.canOpenArtifacts}
      />

      {model.showStandardFooter && (
        <MessageBubbleFooter
          variant="standard"
          message={message}
          sessionId={sessionId}
          isUser={model.isUser}
          isLastAssistantMsg={isLastAssistantMsg}
          createdAt={message.created_at}
          intentLabel={model.intentLabel}
          displayContent={model.displayContent}
          assistantToolbarContent={model.assistantToolbarContent}
          assistantCopyContent={model.assistantCopyContent}
          userSenderDisplayName={model.userSenderDisplayName}
          canEdit={canEdit}
          canReply={canReply}
          canRegenerate={canRegenerate}
          showRollback={showRollback}
          showAgentRunRollback={showAgentRunRollback}
          agentRunRollingBack={agentRunRollingBack}
          isActiveSession={isActiveSession}
          checkpointSemanticFeedback={checkpointSemanticFeedback}
          checkpointBadgeTitle={checkpointBadgeTitle}
          onEdit={() => setIsEditing(true)}
          onRegenerate={handleRegenerate}
          onRollback={isActiveSession && accessCapabilities.canMutateHistory ? () => {
            useChatStore.getState().requestRewindPreview(sessionId ?? null, message.id, 'rollback')
          } : undefined}
          onAgentRunRollback={accessCapabilities.canMutateHistory
            ? () => setAgentRunRollbackConfirmOpen(true)
            : undefined}
          // fork 点必须是 assistant（与云端 _resolve_assistant_fork_point 对齐）
          onFork={
            (accessCapabilities.canMutateHistory || accessCapabilities.canForkWholeSession)
              && onFork
              && message.role === 'assistant'
              ? () => onFork(message.id)
              : undefined
          }
          forkWholeSession={accessCapabilities.canForkWholeSession && !accessCapabilities.canMutateHistory}
          onReply={() => {
            if (!sessionId) return
            const previewText = (model.displayContent || message.content || '').slice(0, 200)
            useChatStore.getState().setReplyTarget(sessionId, {
              messageId: message.id,
              preview: {
                role: message.role,
                author: model.isUser ? (model.userSenderDisplayName || undefined) : undefined,
                text: previewText,
              },
            })
          }}
          showCopy={accessCapabilities.canCopy}
        />
      )}

      {model.showErrorEnvelopeFooter && (
        <MessageBubbleFooter
          variant="error_envelope"
          message={message}
          sessionId={sessionId}
          isUser={false}
          createdAt={message.created_at}
          intentLabel={null}
          displayContent={model.displayContent}
          assistantToolbarContent={message.content ?? ''}
          userSenderDisplayName=""
          canEdit={false}
          canReply={false}
          canRegenerate={false}
          showRollback={false}
          showAgentRunRollback={false}
          agentRunRollingBack={false}
          isActiveSession={isActiveSession}
          checkpointSemanticFeedback={null}
          checkpointBadgeTitle=""
          onEdit={() => {}}
          showCopy={accessCapabilities.canCopy}
        />
      )}

      {showAgentRunRollback && (
        <ConfirmDialog
          open={agentRunRollbackConfirmOpen}
          onOpenChange={setAgentRunRollbackConfirmOpen}
          title={t('checkpoint.rollbackAgentRun')}
          description={t('checkpoint.agentRunRollbackConfirmDesc', {
            defaultValue: '此操作将撤销 AI 的资源修改，恢复到 AI 操作前的版本。\n\n注意：您在 AI 之后对这些资源的手动编辑也会被撤回。\n\n不会影响对话消息。确定要继续吗？',
          })}
          onConfirm={() => { void handleAgentRunRollback() }}
          variant="destructive"
        />
      )}
    </div>
  )
}

export const MessageBubble: React.FC<MessageBubbleProps> = React.memo<MessageBubbleProps>((props) => (
  <ErrorBoundary
    fallback={<MessageErrorFallback messageId={props.message.id} role={props.message.role} rawContent={props.message.content} />}
    resetKeys={[props.message.id, props.message.content, props.message.metadata]}
  >
    <MessageBubbleInner {...props} />
  </ErrorBoundary>
), messageBubblePropsAreEqual)
MessageBubble.displayName = 'MessageBubble'
