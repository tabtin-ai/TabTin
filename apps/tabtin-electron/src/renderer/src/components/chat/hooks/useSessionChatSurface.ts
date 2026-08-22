/**
 * useSessionChatSurface — 主对话 / 分屏共用的「单会话表面」状态与副作用
 *
 * ChatContent 与 ChatSplitPane 各自维护了一套几乎相同的：
 *   - 消息 / 分页 / busy / HITL / 队列 / 回退态
 *   - decision_summary WS 订阅
 *   - ChatInput 审批 / AskUser 回调（一律走 *ForSession，避免分屏误伤当前会话）
 *
 * 本 hook 把这些收成一处，两套 UI 只保留布局差异。
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  useSessionBusy,
  useSessionRunProjection,
} from '@/stores/chat/execution/sessionRunProjection'
import {
  useChatSessionEventStream,
  type DecisionSummaryEventPayload,
} from '@/hooks/useChatSessionEventStream'
import { applyDecisionSummaryUpdate } from '@/stores/chat/checkpoint/handlers/checkpointHandler'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ChatInputProps } from '../composer/chatInputTypes'
import { getChatClient } from '@/services/chatApi'

const EMPTY_MESSAGES: ChatMessage[] = []

export function useSessionChatSurface(
  sessionId: string | null,
  access?: { shareId?: string | null },
) {
  useSessionDecisionSummaryStream(sessionId)

  const messagesRaw = useChatStore(
    useCallback(
      (s) => (sessionId ? s.messagesBySessionId[sessionId] : undefined),
      [sessionId],
    ),
  )
  const messages = messagesRaw ?? EMPTY_MESSAGES
  const isMessagesLoading = sessionId !== null && messagesRaw === undefined
  const loadSessionMessages = useChatStore((s) => s.loadSessionMessages)

  // 页面重载 / HMR 后会话指针可能先于会话列表恢复。消息时间线只依赖稳定的
  // sessionId，不应等待 session record 或 Agent 身份完成 hydration；否则当前指针
  // 已存在、selectSession 不会再次触发时，主消息区会永久保持空白。
  useEffect(() => {
    if (!sessionId || access?.shareId || messagesRaw !== undefined) return
    void loadSessionMessages(sessionId)
  }, [access?.shareId, loadSessionMessages, messagesRaw, sessionId])

  const hasMore = useChatStore(
    useCallback(
      (s) => (sessionId ? s.hasMoreBySessionId[sessionId] ?? false : false),
      [sessionId],
    ),
  )
  const isLoadingMore = useChatStore(
    useCallback(
      (s) => (sessionId ? s.isLoadingMoreBySessionId[sessionId] ?? false : false),
      [sessionId],
    ),
  )
  const loadMoreMessages = useChatStore((s) => s.loadMoreMessages)

  const isBusy = useSessionBusy(sessionId)

  const pendingApproval = useChatStore(
    useCallback(
      (s) => (sessionId ? s.pendingApprovalBySessionId[sessionId] ?? null : null),
      [sessionId],
    ),
  )
  const isApprovalSubmitting = useChatStore(
    useCallback(
      (s) => (sessionId ? s.approvalSubmittingBySessionId[sessionId] ?? false : false),
      [sessionId],
    ),
  )
  const pendingAskUser = useChatStore(
    useCallback(
      (s) => (sessionId ? s.pendingAskUserBySessionId[sessionId] ?? null : null),
      [sessionId],
    ),
  )
  const isAskUserSubmitting = useChatStore(
    useCallback(
      (s) => (sessionId ? s.askUserSubmittingBySessionId[sessionId] ?? false : false),
      [sessionId],
    ),
  )

  const isReverted = useChatStore(
    useCallback((s) => {
      if (!sessionId) return false
      return !!s.sessions.find((session) => session.id === sessionId)?.rollback_state?.revert_active
    }, [sessionId]),
  )

  const restoringSessionId = useChatStore((s) => s.restoringSessionId)
  const isRestoring = sessionId != null && restoringSessionId === sessionId

  const runProjection = useSessionRunProjection(sessionId)
  /** 停止铬 / 排队计数权威：run_sync.queued_run_ids；HostPending 只服务抽屉 payload。 */
  const queueCount = runProjection?.queuedRunIds?.length ?? 0

  /** ：点发送 → Host ACK；驱动发送区 Loader，不占用 queueCount。 */
  const isSendInFlight = useChatStore(
    useCallback(
      (s) => (sessionId ? Boolean(s.sendInFlightBySessionId?.[sessionId]) : false),
      [sessionId],
    ),
  )

  const submitApprovalDecisionsForSession = useChatStore((s) => s.submitApprovalDecisionsForSession)
  const submitAskUserAnswerForSession = useChatStore((s) => s.submitAskUserAnswerForSession)
  const submitAskUserTextForSession = useChatStore((s) => s.submitAskUserTextForSession)
  const submitAskUserFieldValuesForSession = useChatStore((s) => s.submitAskUserFieldValuesForSession)
  const submitAskUserApprovalForSession = useChatStore((s) => s.submitAskUserApprovalForSession)
  const skipAskUserForSession = useChatStore((s) => s.skipAskUserForSession)
  const dismissApprovalForSession = useChatStore((s) => s.dismissApprovalForSession)

  const hitlProps = useMemo((): Pick<
    ChatInputProps,
    | 'pendingApproval'
    | 'onApprovalSubmit'
    | 'isApprovalSubmitting'
    | 'onApprovalDismiss'
    | 'pendingAskUser'
    | 'onAskUserSubmit'
    | 'onAskUserTextSubmit'
    | 'onAskUserFieldsSubmit'
    | 'onAskUserApprovalSubmit'
    | 'onAskUserSkip'
    | 'isAskUserSubmitting'
  > => ({
    pendingApproval,
    onApprovalSubmit: async (decisions) => {
      if (!sessionId) return
      await submitApprovalDecisionsForSession(sessionId, decisions)
    },
    isApprovalSubmitting,
    onApprovalDismiss: (reason) => {
      if (sessionId) dismissApprovalForSession(sessionId, reason)
    },
    pendingAskUser,
    onAskUserSubmit: async (answers) => {
      if (!sessionId) return
      await submitAskUserAnswerForSession(sessionId, answers)
    },
    onAskUserTextSubmit: async (text) => {
      if (!sessionId) return
      await submitAskUserTextForSession(sessionId, text)
    },
    onAskUserFieldsSubmit: async (fieldValues) => {
      if (!sessionId) return
      await submitAskUserFieldValuesForSession(sessionId, fieldValues)
    },
    onAskUserApprovalSubmit: async (approved) => {
      if (!sessionId) return
      await submitAskUserApprovalForSession(sessionId, approved)
    },
    onAskUserSkip: async () => {
      if (!sessionId) return
      await skipAskUserForSession(sessionId)
    },
    isAskUserSubmitting,
  }), [
    sessionId,
    pendingApproval,
    isApprovalSubmitting,
    pendingAskUser,
    isAskUserSubmitting,
    submitApprovalDecisionsForSession,
    dismissApprovalForSession,
    submitAskUserAnswerForSession,
    submitAskUserTextForSession,
    submitAskUserFieldValuesForSession,
    submitAskUserApprovalForSession,
    skipAskUserForSession,
  ])

  const onLoadMore = useCallback(() => {
    if (!sessionId) return
    if (!access?.shareId) {
      loadMoreMessages(sessionId)
      return
    }
    const state = useChatStore.getState()
    const oldestId = state.messagesBySessionId[sessionId]?.[0]?.id
    if (!oldestId || state.isLoadingMoreBySessionId[sessionId]) return
    useChatStore.setState(current => ({
      isLoadingMoreBySessionId: {
        ...current.isLoadingMoreBySessionId,
        [sessionId]: true,
      },
    }))
    void getChatClient().messages.list(
      sessionId,
      { limit: 30, before: oldestId },
      { shareId: access.shareId },
    ).then((response) => {
      const latest = useChatStore.getState()
      if (response.messages.length > 0) {
        latest.prependOlderMessages(sessionId, response.messages)
      }
      useChatStore.setState(current => ({
        hasMoreBySessionId: {
          ...current.hasMoreBySessionId,
          [sessionId]: response.has_more,
        },
        isLoadingMoreBySessionId: {
          ...current.isLoadingMoreBySessionId,
          [sessionId]: false,
        },
      }))
    }).catch(() => {
      useChatStore.setState(current => ({
        isLoadingMoreBySessionId: {
          ...current.isLoadingMoreBySessionId,
          [sessionId]: false,
        },
      }))
    })
  }, [access?.shareId, sessionId, loadMoreMessages])

  return {
    messages,
    messagesRaw,
    isMessagesLoading,
    hasMore,
    isLoadingMore,
    onLoadMore,
    isBusy,
    isReverted,
    isRestoring,
    queueCount,
    isSendInFlight,
    hitlProps,
  }
}

function useSessionDecisionSummaryStream(sessionId: string | null) {
  const handleDecisionSummaryUpdate = useCallback((payload: DecisionSummaryEventPayload) => {
    if (!payload.decision_summary) return
    const targetSessionId = payload.session_id || sessionId
    if (!targetSessionId) return
    void applyDecisionSummaryUpdate({
      targetSessionId,
      messageId: payload.message_id || null,
      checkpointId: payload.checkpoint_id || null,
      decisionSummary: payload.decision_summary,
    })
  }, [sessionId])

  useChatSessionEventStream({
    sessionId,
    onDecisionSummaryUpdate: handleDecisionSummaryUpdate,
  })
}
