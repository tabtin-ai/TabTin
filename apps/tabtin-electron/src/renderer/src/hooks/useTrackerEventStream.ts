/**
 * Tracker 事件流 Hook（Module F 决策 3：Space 边界版）。
 *
 * 订阅 WS topic ``tracker.events.{spaceId}``（修复前是 ``{organizationId}``，
 * 跨 Space 数据会泄漏给同 organization 的其他成员）：
 * - 处理 ``tracker.event.*`` 事件（Tracker CRUD：created / updated / deleted）
 * - 同时转发 ``tracker.*`` 运行相关事件（progress / run_completed / run_failed /
 *   run_cancelled / health_alert / trigger_filtered）
 *
 * 一个 Space 一个 hook 实例。需要同时监听多个 Space 的场景（如 AppGlobalEffects
 * 全局通知），用一个 wrapper 组件 map spaceIds 生成 N 个子 hook 实例。
 *
 * 历史 legacy 入口已全部下线：
 * - 文件名：``useAgendaEventStream`` → ``useTrackerEventStream``
 * - 事件前缀：``agenda.event.*`` → ``tracker.event.*``、``goal.*`` → ``tracker.*``
 * - 死 handler ``agenda.attendee.added`` / ``agenda.reminder``（后端无生产者）已删
 */

import { useRef, useCallback, useMemo } from 'react'
import { TrackerEvents } from '@tabtin/ws-gateway-client'
import { useGatewayTopic } from './useGatewayTopic'
import {
  extractTrackerPayload,
  parseTrackerProgressPayload,
  parseTrackerRunCompletedPayload,
  parseTrackerRunFailedPayload,
  parseTrackerRunCancelledPayload,
  parseTrackerHealthAlertPayload,
  parseTrackerTriggerFilteredPayload,
  warnTrackerPayloadDropped,
} from './tracker-ws-payload'
import type {
  TrackerProgressEvent,
  TrackerRunCompletedEvent,
  TrackerRunFailedEvent,
  TrackerRunCancelledEvent,
  TrackerHealthAlertEvent,
  TrackerTriggerFilteredEvent,
} from './tracker-ws-payload'

/** tracker.event.created / updated / deleted 等扁平 envelope 的常用字段 */
export interface TrackerChangePayload {
  type: string
  /** Tracker 实体 ID（即 tracker_id；envelope 顶层透传） */
  tracker_id?: string
  name?: string
  space_id?: string | null
  user_id?: string | null
}

export interface UseTrackerEventStreamOptions {
  /** Module F 决策 3：订阅 Space 级 topic，按 Space 边界过滤。null 时不订阅。 */
  spaceId: string | null
  enabled?: boolean
  onReconnected?: () => void

  onTrackerCreated?: (payload: TrackerChangePayload) => void
  onTrackerUpdated?: (payload: TrackerChangePayload) => void
  onTrackerDeleted?: (payload: TrackerChangePayload) => void

  onProgress?: (event: TrackerProgressEvent) => void
  onRunCompleted?: (event: TrackerRunCompletedEvent) => void
  onRunFailed?: (event: TrackerRunFailedEvent) => void
  onRunCancelled?: (event: TrackerRunCancelledEvent) => void
  onHealthAlert?: (event: TrackerHealthAlertEvent) => void
  onTriggerFiltered?: (event: TrackerTriggerFilteredEvent) => void
}

function toTrackerChangePayload(envelope: Record<string, unknown>): TrackerChangePayload {
  return {
    type: typeof envelope.type === 'string' ? envelope.type : '',
    tracker_id: typeof envelope.tracker_id === 'string' ? envelope.tracker_id : undefined,
    name: typeof envelope.name === 'string' ? envelope.name : undefined,
    space_id: (envelope.space_id as string | null | undefined) ?? null,
    user_id: (envelope.user_id as string | null | undefined) ?? null,
  }
}

export function useTrackerEventStream(options: UseTrackerEventStreamOptions) {
  const {
    spaceId,
    enabled = true,
    onReconnected,
    onTrackerCreated,
    onTrackerUpdated,
    onTrackerDeleted,
    onProgress,
    onRunCompleted,
    onRunFailed,
    onRunCancelled,
    onHealthAlert,
    onTriggerFiltered,
  } = options

  const trackerCallbacksRef = useRef({
    onTrackerCreated,
    onTrackerUpdated,
    onTrackerDeleted,
  })
  trackerCallbacksRef.current = {
    onTrackerCreated,
    onTrackerUpdated,
    onTrackerDeleted,
  }

  const runCallbacksRef = useRef({
    onProgress,
    onRunCompleted,
    onRunFailed,
    onRunCancelled,
    onHealthAlert,
    onTriggerFiltered,
  })
  runCallbacksRef.current = {
    onProgress,
    onRunCompleted,
    onRunFailed,
    onRunCancelled,
    onHealthAlert,
    onTriggerFiltered,
  }

  const handleEnvelope = useCallback((envelope: Record<string, unknown>) => {
    const msgType = typeof envelope?.type === 'string' ? envelope.type : ''

    if (msgType.startsWith('tracker.event.')) {
      if (msgType === 'tracker.event.created') {
        trackerCallbacksRef.current.onTrackerCreated?.(toTrackerChangePayload(envelope))
        return
      }
      if (msgType === 'tracker.event.updated') {
        trackerCallbacksRef.current.onTrackerUpdated?.(toTrackerChangePayload(envelope))
        return
      }
      if (msgType === 'tracker.event.deleted') {
        trackerCallbacksRef.current.onTrackerDeleted?.(toTrackerChangePayload(envelope))
        return
      }
      return
    }

    if (!msgType.startsWith('tracker.')) return

    const raw = extractTrackerPayload(envelope, true)
    if (!raw) return

    const warn = () => warnTrackerPayloadDropped(msgType, raw, 'TrackerEventStream')

    switch (msgType) {
      case TrackerEvents.PROGRESS: {
        const parsed = parseTrackerProgressPayload(raw)
        if (parsed) runCallbacksRef.current.onProgress?.(parsed); else warn()
        break
      }
      case TrackerEvents.RUN_COMPLETED: {
        const parsed = parseTrackerRunCompletedPayload(raw)
        if (parsed) runCallbacksRef.current.onRunCompleted?.(parsed); else warn()
        break
      }
      case TrackerEvents.RUN_FAILED: {
        const parsed = parseTrackerRunFailedPayload(raw)
        if (parsed) runCallbacksRef.current.onRunFailed?.(parsed); else warn()
        break
      }
      case TrackerEvents.RUN_CANCELLED: {
        const parsed = parseTrackerRunCancelledPayload(raw)
        if (parsed) runCallbacksRef.current.onRunCancelled?.(parsed); else warn()
        break
      }
      case TrackerEvents.HEALTH_ALERT: {
        const parsed = parseTrackerHealthAlertPayload(raw)
        if (parsed) runCallbacksRef.current.onHealthAlert?.(parsed); else warn()
        break
      }
      case TrackerEvents.TRIGGER_FILTERED: {
        const parsed = parseTrackerTriggerFilteredPayload(raw)
        if (parsed) runCallbacksRef.current.onTriggerFiltered?.(parsed); else warn()
        break
      }
    }
  }, [])

  const topic = useMemo(
    () => (spaceId ? `tracker.events.${spaceId}` : null),
    [spaceId],
  )

  return useGatewayTopic({
    topic,
    enabled,
    onEvent: handleEnvelope,
    onReconnected,
    logPrefix: 'TrackerEventStream',
  })
}
