import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { shouldHidePushNotificationAtTopLevel } from './timelineMessageVisibility'
import {
  resolveAgentTurnTailActivity,
  resolveAgentAwaitingThoughtPhase,
} from '@utils/chat/agentAwaitingThoughtPhase'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSessionBusy } from '@stores/chat/execution/sessionRunProjection'
import { useAuthStore } from '@stores/useAuthStore'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useMessageBlocksById } from '@stores/chat/messages/messageBlocks'
import { isProjectTaskEditAndResendBlocked } from '@stores/chat/messages/product/delivery/projectTaskSendGate'
import {
  deriveMessageBubbleModel,
  deriveRegenerateSourceMessage,
  deriveStalledLevel,
  type MessageBubbleDerivedModel,
} from './deriveMessageBubbleModel'
import { buildCheckpointFooterMeta } from './checkpointFooterMeta'
import { buildResendContextBlocks } from './messageResendContext'
import { useMessageBubbleSessionPulseVisible } from './useMessageBubbleSessionPulseVisible'

const EMPTY_CHAT_MESSAGES: ChatMessage[] = []

export interface UseMessageBubbleOrchestrationInput {
  message: ChatMessage
  sessionId?: string | null
  subagentRunSessionId?: string | null
  userAlign?: 'left' | 'right'
  previewMode?: boolean
  isLastAssistantMsg?: boolean
  sessionPulseVisible?: boolean
  isLastInTurn?: boolean
  contentBlocksOverride?: ContentBlockEntry[]
}

export interface MessageBubbleOrchestration {
  model: MessageBubbleDerivedModel
  isStreaming: boolean
  isActiveSession: boolean
  isRestoring: boolean
  runStateSuspended: boolean
  stalledLevel: 0 | 1 | 2
  showAwaitingThought: boolean
  showPlanningNext: boolean
  checkpointSemanticFeedback: ReturnType<typeof buildCheckpointFooterMeta>['checkpointSemanticFeedback']
  checkpointBadgeTitle: string
  isEditing: boolean
  setIsEditing: (editing: boolean) => void
  agentRunRollingBack: boolean
  agentRunRollbackConfirmOpen: boolean
  setAgentRunRollbackConfirmOpen: (open: boolean) => void
  handleAgentRunRollback: () => Promise<void>
  handleRegenerate: () => void
  messageBlocks: ChatMessage['content_blocks_json']
  hideAnchoredPushNotification: boolean
}

export function useMessageBubbleOrchestration(
  input: UseMessageBubbleOrchestrationInput,
): MessageBubbleOrchestration {
  const {
    message,
    sessionId = null,
    subagentRunSessionId,
    userAlign = 'right',
    previewMode,
    isLastAssistantMsg = false,
    sessionPulseVisible,
    isLastInTurn = true,
    contentBlocksOverride,
  } = input

  const { t, i18n } = useTranslation('chat')
  const currentUserId = useAuthStore(state => state.user?.id)

  const storeSelector = useCallback(
    (s: { currentSessionId: string | null; restoringSessionId: string | null }) => {
      const sid = sessionId ?? s.currentSessionId
      return {
        isActiveSession: !!sid,
        resolvedSessionId: sid,
        isRestoring: sid ? s.restoringSessionId === sid : s.restoringSessionId != null,
      }
    },
    [sessionId],
  )
  const { isActiveSession, resolvedSessionId, isRestoring } = useChatStore(
    useShallow(storeSelector),
  )
  const isStreaming = useSessionBusy(resolvedSessionId)
  const derivedSessionPulseVisible = useMessageBubbleSessionPulseVisible(resolvedSessionId)
  const effectiveSessionPulseVisible = sessionPulseVisible ?? derivedSessionPulseVisible
  const sessionMessages = useChatStore(
    useShallow(useCallback(
      (s) => (sessionId ? s.messagesBySessionId[sessionId] ?? EMPTY_CHAT_MESSAGES : EMPTY_CHAT_MESSAGES),
      [sessionId],
    )),
  )
  const hideAnchoredPushNotification = useMemo(
    () => message.role === 'user' && shouldHidePushNotificationAtTopLevel(sessionMessages, message.id),
    [message.role, sessionMessages, message.id],
  )
  const runStateSuspended = useChatRuntimeStore(
    useCallback(
      (s) => (sessionId ? !!s.runStateBySessionId[sessionId]?.suspended : false),
      [sessionId],
    ),
  )
  const heartbeatInfo = useChatRuntimeStore(
    useShallow(useCallback(
      (s) => {
        if (!sessionId) return null
        const rs = s.runStateBySessionId[sessionId]
        if (!rs || typeof rs.lastHeartbeatAt !== 'number') return null
        return {
          lastHeartbeatAt: rs.lastHeartbeatAt,
          secondsSinceLastChunk: rs.secondsSinceLastChunk as number | undefined,
        }
      },
      [sessionId],
    )),
  )
  const toolEvents = useChatRuntimeStore(
    useCallback(
      (s) => (sessionId ? s.toolEventsBySessionId?.[sessionId] : undefined),
      [sessionId],
    ),
  )

  const [stalledTick, setStalledTick] = useState(0)
  const hasHeartbeat = !!heartbeatInfo
  useEffect(() => {
    if (!isStreaming || !hasHeartbeat) return
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 气泡级停滞提示只在当前消息组件挂载且流式有心跳时滴答，卸载/状态变化会清理。
    const timer = setInterval(() => setStalledTick((n) => n + 1), 5_000)
    return () => clearInterval(timer)
  }, [isStreaming, hasHeartbeat])

  const [isEditing, setIsEditing] = useState(false)
  const [agentRunRollingBack, setAgentRunRollingBack] = useState(false)
  const [agentRunRollbackConfirmOpen, setAgentRunRollbackConfirmOpen] = useState(false)

  const blockReadSessionId = subagentRunSessionId ?? sessionId ?? null
  const runtimeBlocks = useMessageBlocksById(blockReadSessionId, message.id)

  const settledToolIds = useMemo(() => {
    const ids = new Set<string>()
    if (toolEvents) {
      for (const ev of toolEvents) {
        if (ev.phase === 'end' || ev.phase === 'error') ids.add(ev.id)
      }
    }
    return ids
  }, [toolEvents])

  const projectTaskResendBlocked = isProjectTaskEditAndResendBlocked(sessionId)

  const model = useMemo(() => deriveMessageBubbleModel({
    message,
    sessionId,
    currentUserId,
    userAlign,
    previewMode,
    isLastAssistantMsg,
    sessionPulseVisible: effectiveSessionPulseVisible,
    isLastInTurn,
    isEditing,
    isActiveSession,
    isRestoring,
    isStreaming,
    runStateSuspended,
    sessionMessages,
    runtimeBlocks: [...runtimeBlocks],
    contentBlocksOverride: contentBlocksOverride ? [...contentBlocksOverride] : undefined,
    projectTaskResendBlocked,
    t,
    locale: i18n.language,
  }), [
    message,
    sessionId,
    currentUserId,
    userAlign,
    previewMode,
    isLastAssistantMsg,
    effectiveSessionPulseVisible,
    isLastInTurn,
    isEditing,
    isActiveSession,
    isRestoring,
    isStreaming,
    runStateSuspended,
    sessionMessages,
    runtimeBlocks,
    contentBlocksOverride,
    projectTaskResendBlocked,
    t,
    i18n.language,
  ])

  const { checkpointSemanticFeedback, checkpointBadgeTitle } = useMemo(
    () => buildCheckpointFooterMeta(message, model.isUser, t),
    [message, model.isUser, t],
  )

  const stalledLevel = useMemo(() => {
    void stalledTick
    return deriveStalledLevel({
      isStreaming,
      runStateSuspended,
      heartbeatInfo,
    })
  }, [stalledTick, isStreaming, runStateSuspended, heartbeatInfo])

  const tailActivity = useMemo(
    () => resolveAgentTurnTailActivity(model.contentBlocks, settledToolIds),
    [model.contentBlocks, settledToolIds],
  )
  const awaitingThoughtPhase = resolveAgentAwaitingThoughtPhase({
    sessionPulseVisible: effectiveSessionPulseVisible,
    isLastAssistantMsg,
    tailActivity,
  })

  const handleAgentRunRollback = useCallback(async () => {
    if (!model.agentRunId || agentRunRollingBack) return
    setAgentRunRollingBack(true)
    try {
      await useChatStore.getState().rollbackAgentRun(model.agentRunId)
    } finally {
      setAgentRunRollingBack(false)
    }
  }, [model.agentRunId, agentRunRollingBack])

  const handleRegenerate = useCallback(() => {
    if (!sessionId) return
    const regenerateSourceMessage = deriveRegenerateSourceMessage(sessionMessages, message.id, model.isUser)
    if (!regenerateSourceMessage) return
    useChatStore.getState().requestRewindPreview(
      sessionId,
      regenerateSourceMessage.id,
      'editAndResend',
      regenerateSourceMessage.content.trim(),
      undefined,
      buildResendContextBlocks(regenerateSourceMessage),
      'resend',
    )
  }, [sessionId, sessionMessages, message.id, model.isUser])

  return {
    model,
    isStreaming,
    isActiveSession,
    isRestoring,
    runStateSuspended,
    stalledLevel,
    showAwaitingThought: awaitingThoughtPhase === 'pending',
    showPlanningNext: awaitingThoughtPhase === 'planningNext',
    checkpointSemanticFeedback,
    checkpointBadgeTitle,
    isEditing,
    setIsEditing,
    agentRunRollingBack,
    agentRunRollbackConfirmOpen,
    setAgentRunRollbackConfirmOpen,
    handleAgentRunRollback,
    handleRegenerate,
    messageBlocks: message.content_blocks_json ?? [],
    hideAnchoredPushNotification,
  }
}
