/**
 * 资源变更事件流 Hook
 *
 * 按 scope 订阅 WS 资源事件：
 * - `space`: `context.sync.{spaceId}`
 * - `organization`: `context.sync.organization.{organizationId}`
 *
 * ：同时订阅 `context.sync.user.{userId}`，接收私有云资源扇出事件
 *（organization / space topic 不再承载云盘敏感 payload）。
 *
 * 将资源变更统一分发到 useUnifiedResources store。
 * 使用全局单例的 WsGateway 连接。
 */
import { useCallback, useMemo } from 'react'
import { ContextSyncEvents } from '@tabtin/ws-gateway-client'
import { useAuthStore } from '@/stores/useAuthStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useUnifiedResources, type ResourceWsEvent } from '@/stores/useUnifiedResources'
import { useCollections } from '@/stores/useCollections'
import { useGatewayTopic } from './useGatewayTopic'

interface UseResourceEventStreamOptions {
  spaceId?: string | null
  scope?: 'space' | 'organization'
  enabled?: boolean
  onReconnected?: () => void
  onAfterDispatch?: (parsed: ReturnType<typeof parseResourceEnvelope>) => void
}

function parseResourceEnvelope(
  envelope: Record<string, unknown>,
  options: {
    scope: 'space' | 'organization' | 'user'
    spaceId?: string | null
    organizationId?: string | null
  },
): {
  structural?: Record<string, unknown>
  resource?: ResourceWsEvent
} | null {
  const { scope, spaceId, organizationId } = options
  const nestedPayload = envelope?.payload
  const rawPayload = nestedPayload && typeof nestedPayload === 'object'
    ? nestedPayload
    : envelope
  if (!rawPayload || typeof rawPayload !== 'object') return null
  const payload = rawPayload as Record<string, unknown>

  const envelopeType = typeof envelope?.type === 'string' ? envelope.type : ''
  const payloadType = typeof payload.type === 'string' ? payload.type : ''
  const eventType = payloadType || envelopeType

  const payloadSpaceId = typeof payload.space_id === 'string' ? payload.space_id : null
  const payloadOrganizationId = typeof payload.organization_id === 'string'
    ? payload.organization_id
    : (typeof envelope?.organization_id === 'string' ? envelope.organization_id : null)

  // user topic：按 organization 做防御性过滤（跨组织事件忽略）
  if (scope === 'space' && spaceId && payloadSpaceId !== spaceId) return null
  if (
    (scope === 'organization' || scope === 'user')
    && payloadOrganizationId
    && organizationId
    && payloadOrganizationId !== organizationId
  ) {
    return null
  }

  if (
    eventType.startsWith('collection_') ||
    eventType.startsWith('section_') ||
    eventType === 'collections_reordered' ||
    eventType === 'sections_reordered' ||
    eventType === 'items_moved' ||
    eventType === 'items_reordered'
  ) {
    // 结构事件仍走 scope topic；user topic 上忽略
    if (scope === 'user') return null
    return {
      structural: {
        type: eventType,
        space_id: payloadSpaceId ?? spaceId ?? '',
        organization_id: payloadOrganizationId,
        ...(typeof payload.collection_id === 'string' || payload.collection_id === null
          ? { collection_id: payload.collection_id }
          : {}),
        ...(Array.isArray(payload.collection_ids)
          ? { collection_ids: payload.collection_ids.filter((id): id is string => typeof id === 'string') }
          : {}),
      },
    }
  }

  if (
    !eventType.startsWith('resource_')
    && !envelopeType.startsWith(ContextSyncEvents.PREFIX)
  ) {
    return null
  }
  if (typeof payload.resource_type !== 'string' || typeof payload.resource_id !== 'string') {
    return null
  }

  // ：organization / space topic 上若仍收到云资源敏感事件（历史/漏改），前端忽略
  if (
    (scope === 'organization' || scope === 'space')
    && (payload.resource_type === 'tabdoc'
      || payload.resource_type === 'tabdata'
      || payload.resource_type === 'tabfiles')
    && eventType.startsWith('resource_')
  ) {
    return null
  }

  return {
    resource: {
      type: eventType,
      resource_type: payload.resource_type,
      resource_id: payload.resource_id,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      space_id: payloadSpaceId ?? spaceId ?? '',
      organization_id: payloadOrganizationId,
      user_id: typeof payload.user_id === 'string' ? payload.user_id : undefined,
      metadata: payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata as Record<string, unknown>
        : undefined,
      status: typeof payload.status === 'string' ? payload.status : undefined,
      preview: typeof payload.preview === 'string' ? payload.preview : undefined,
      updated_at: typeof payload.updated_at === 'string' || payload.updated_at === null
        ? payload.updated_at as string | null
        : undefined,
      is_pinned: typeof payload.is_pinned === 'boolean' ? payload.is_pinned : undefined,
      pinned_at: typeof payload.pinned_at === 'string' || payload.pinned_at === null
        ? payload.pinned_at as string | null
        : undefined,
      collection_id: typeof payload.collection_id === 'string' || payload.collection_id === null
        ? payload.collection_id as string | null
        : undefined,
      context_item_id: typeof payload.context_item_id === 'string'
        ? payload.context_item_id
        : undefined,
    },
  }
}

export function useResourceEventStream(options: UseResourceEventStreamOptions) {
  const { spaceId, scope = 'space', enabled = true, onReconnected, onAfterDispatch } = options
  const organizationId = useOrganizationStore((s) => s.getEffectiveOrganizationId())
  const userId = useAuthStore((s) => (s.user?.id != null ? String(s.user.id) : null))

  const scopeTopic = useMemo(
    () => {
      if (!organizationId) return null
      if (scope === 'organization') return `${ContextSyncEvents.PREFIX}.organization.${organizationId}`
      return spaceId ? `${ContextSyncEvents.PREFIX}.${spaceId}` : null
    },
    [scope, spaceId, organizationId],
  )

  const userTopic = useMemo(
    () => (userId ? `${ContextSyncEvents.PREFIX}.user.${userId}` : null),
    [userId],
  )

  const handleResourceWsEvent = useUnifiedResources(s => s.handleWsEvent)
  const handleStructuralEvent = useUnifiedResources(s => s.handleStructuralEvent)
  const collectionWsHandler = useCollections(s => s.handleWsEvent)

  const dispatchParsed = useCallback((
    parsed: ReturnType<typeof parseResourceEnvelope>,
  ) => {
    if (!parsed) return
    if (parsed.structural) {
      collectionWsHandler(parsed.structural as never)
      handleStructuralEvent(parsed.structural as never)
      onAfterDispatch?.(parsed)
      return
    }
    if (parsed.resource) {
      handleResourceWsEvent(parsed.resource)
      onAfterDispatch?.(parsed)
    }
  }, [collectionWsHandler, handleResourceWsEvent, handleStructuralEvent, onAfterDispatch])

  const handleScopeEnvelope = useCallback((envelope: Record<string, unknown>) => {
    dispatchParsed(parseResourceEnvelope(envelope, {
      scope,
      spaceId,
      organizationId,
    }))
  }, [dispatchParsed, scope, spaceId, organizationId])

  const handleUserEnvelope = useCallback((envelope: Record<string, unknown>) => {
    dispatchParsed(parseResourceEnvelope(envelope, {
      scope: 'user',
      spaceId,
      organizationId,
    }))
  }, [dispatchParsed, spaceId, organizationId])

  const scopeStatus = useGatewayTopic({
    topic: scopeTopic,
    enabled,
    onEvent: handleScopeEnvelope,
    // ：补偿只挂 scope topic，避免与 user topic 双触发造成 2× 列表请求
    onReconnected,
    logPrefix: 'ResourceEventStream',
  })

  // 用户 topic：只收云资源敏感事件；重连补偿见上方 scope topic
  useGatewayTopic({
    topic: userTopic,
    enabled: enabled && Boolean(userId),
    onEvent: handleUserEnvelope,
    logPrefix: 'ResourceEventStream.user',
  })

  return scopeStatus
}
