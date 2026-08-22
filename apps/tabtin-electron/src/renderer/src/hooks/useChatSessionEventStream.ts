/**
 * useChatSessionEventStream — 订阅 agent.session.{session_id} topic
 *
 * 背景（Wave 13 QC-01）：
 * LLM 增强摘要等 session-level 异步事件在 agent.stream.done 之后数十秒才就绪，
 * 而 StreamManager 在 done 后立即 unsubscribe agent.stream.{thread_id}，
 * 导致事件被 channel_layer group_send 静默丢弃。
 *
 * 本 hook 订阅一个独立的 session-level topic，生命周期与 ChatSession
 * 激活/离开绑定——只要用户处于该 session，事件就能按时送达。
 *
 * 复用 useGatewayTopic：引用计数 + 重连重订阅 + 事件去重。
 *
 * 兜底：即便 WS 丢失（短暂断线、切换 session 后事件才就绪），
 * CheckpointContextCard 展开时会通过 fetchCheckpointDecisionContext 主动拉取。
 */

import { useCallback, useMemo, useRef } from 'react'
import { AgentSessionEvents } from '@tabtin/ws-gateway-client'
import type { DecisionSummary } from '@tabtin/chat-client'
import { useGatewayTopic, type GatewayTopicStatus } from './useGatewayTopic'

export interface DecisionSummaryEventPayload {
  checkpoint_id?: string
  session_id?: string
  message_id?: string
  decision_summary?: DecisionSummary
}

export interface UseChatSessionEventStreamOptions {
  sessionId: string | null
  enabled?: boolean
  onModelChanged?: () => void
  onDecisionSummaryUpdate?: (payload: DecisionSummaryEventPayload) => void
  onStatusChange?: (status: GatewayTopicStatus, error?: string) => void
}

export function useChatSessionEventStream(options: UseChatSessionEventStreamOptions) {
  const { sessionId, enabled = true, onModelChanged, onDecisionSummaryUpdate, onStatusChange } = options

  const onUpdateRef = useRef(onDecisionSummaryUpdate)
  onUpdateRef.current = onDecisionSummaryUpdate
  const onModelChangedRef = useRef(onModelChanged)
  onModelChangedRef.current = onModelChanged

  const handleEnvelope = useCallback((envelope: Record<string, unknown>) => {
    const eventType = envelope?.type as string | undefined
    if (!eventType) return
    if (eventType === AgentSessionEvents.MODEL_CHANGED) {
      onModelChangedRef.current?.()
      return
    }
    if (
      eventType !== AgentSessionEvents.DECISION_SUMMARY_READY &&
      eventType !== AgentSessionEvents.DECISION_SUMMARY_FAILED &&
      eventType !== AgentSessionEvents.DECISION_SUMMARY_PENDING
    ) {
      return
    }
    const raw = (envelope?.payload as Record<string, unknown>) ?? {}
    onUpdateRef.current?.({
      checkpoint_id: typeof raw.checkpoint_id === 'string' ? raw.checkpoint_id : undefined,
      session_id: typeof raw.session_id === 'string' ? raw.session_id : undefined,
      message_id: typeof raw.message_id === 'string' ? raw.message_id : undefined,
      decision_summary:
        raw.decision_summary && typeof raw.decision_summary === 'object'
          ? (raw.decision_summary as DecisionSummary)
          : undefined,
    })
  }, [])

  const topic = useMemo(
    () => (sessionId ? `agent.session.${sessionId}` : null),
    [sessionId],
  )

  return useGatewayTopic({
    topic,
    enabled,
    onEvent: handleEnvelope,
    onStatusChange,
    logPrefix: 'ChatSessionEventStream',
  })
}
