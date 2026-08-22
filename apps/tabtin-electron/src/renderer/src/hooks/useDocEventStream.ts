/**
 * TabDoc 文档事件流 Hook (V3)
 *
 * 订阅文档级 WebSocket 事件（通过现有 Gateway）:
 * - doc.events.save     — 文档保存完成
 * - doc.events.editor   — 编辑者变更（"Agent 正在编辑..."）
 * - doc.events.version  — 新版本历史创建
 * - doc.events.comment  — 文档评论创建（旧根评论投影）
 * - doc.events.comment_thread  — 评论线程创建/状态/锚点
 * - doc.events.comment_message — 评论消息创建/删除
 *
 * 注意: Y.js 实时同步走 Hocuspocus WebSocket，不走此通道。
 * 此 hook 仅处理文档级元数据事件。
 */

import { useRef, useCallback, useMemo } from 'react'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useGatewayTopic, type GatewayTopicStatus } from './useGatewayTopic'

export type DocStreamEvent = {
  event: string
  data: any
  id?: string
}

const DOC_EVENT_TYPES = new Set([
  'doc.events.save',
  'doc.events.editor',
  'doc.events.version',
  'doc.events.comment',
  'doc.events.comment_thread',
  'doc.events.comment_message',
])

interface UseDocEventStreamOptions {
  documentId: string | null
  enabled?: boolean
  onEvent?: (event: DocStreamEvent) => void
  onStatusChange?: (status: GatewayTopicStatus, error?: string) => void
  onReconnected?: () => void
}

export function useDocEventStream(options: UseDocEventStreamOptions) {
  const { documentId, enabled = true, onEvent, onStatusChange, onReconnected } = options
  const organizationId = useOrganizationStore(state => state.getEffectiveOrganizationId())

  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const handleEnvelope = useCallback((envelope: Record<string, unknown>) => {
    const eventType = envelope?.type as string | undefined
    if (eventType && DOC_EVENT_TYPES.has(eventType)) {
      onEventRef.current?.({
        event: eventType,
        data: envelope?.payload ?? envelope?.data ?? envelope,
        id: typeof envelope?.event_id === 'string'
          ? envelope.event_id
          : typeof envelope?.id === 'string'
            ? envelope.id
            : undefined,
      })
    }
  }, [])

  const topic = useMemo(
    () => (documentId && organizationId ? `doc.events.${documentId}` : null),
    [documentId, organizationId],
  )

  return useGatewayTopic({
    topic,
    enabled,
    onEvent: handleEnvelope,
    onReconnected,
    onStatusChange,
    logPrefix: 'DocEventStream',
  })
}
