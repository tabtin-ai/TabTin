/**
 * Electron TabDoc 文档事件流 Port
 *
 * 将 Gateway `doc.events.{documentId}` 订阅适配为 TabDocEventStreamPort，
 * 供 @tabtin/tabdoc-ui 在 Agent save-content 等外部写入后 reconcile 编辑器。
 */
import type {
  TabDocEventStreamEvent,
  TabDocEventStreamPort,
  TabDocEventStreamSubscription,
} from '@tabtin/tabdoc-ui'
import { getChatClient } from '@/services/chatApi'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import {
  ensureGatewayTopicSubscribed,
  releaseGatewayTopic,
  retainGatewayTopic,
  type GatewayTopicStatus,
} from '@/hooks/useGatewayTopic'

const DOC_EVENT_TYPES = new Set([
  'doc.events.save',
  'doc.events.editor',
  'doc.events.version',
  'doc.events.comment',
  'doc.events.comment_thread',
  'doc.events.comment_message',
])

const DEDUP_CACHE_LIMIT = 200

function resolveOrganizationId(): string | null {
  return useOrganizationStore.getState().getEffectiveOrganizationId?.() ?? null
}

function isOrganizationReady(): boolean {
  const state = useOrganizationStore.getState()
  return !!(state.selectedOrganization || state.organizations[0])
}

export const electronTabDocEventStreamPort: TabDocEventStreamPort = {
  subscribe(documentId, onEvent) {
    let active = true
    let status: GatewayTopicStatus = 'idle'
    let listener: ((envelope: Record<string, unknown>) => void) | null = null
    let reconnectHandler: (() => void) | null = null
    let retainedTopic: string | null = null
    const recentEventIds = new Set<string>()

    const organizationId = resolveOrganizationId()
    const topic = organizationId ? `doc.events.${documentId}` : null

    const emitEvent = (event: TabDocEventStreamEvent) => {
      if (!active) return
      onEvent(event)
    }

    const detachListeners = () => {
      try {
        const gw = getChatClient().getGateway()
        if (listener) {
          gw.removeListener(listener)
          listener = null
        }
        if (reconnectHandler) {
          gw.offReconnectedEvent(reconnectHandler)
          reconnectHandler = null
        }
      } catch {
        // Gateway may not be initialized
      }
    }

    const setStatus = (next: GatewayTopicStatus) => {
      status = next
    }

    const connect = async () => {
      if (!active || !topic || !isOrganizationReady()) {
        setStatus('idle')
        return
      }

      detachListeners()
      setStatus('connecting')

      try {
        const gw = getChatClient().getGateway()
        const connected = await gw.connect()
        if (!active) return
        if (!connected) {
          setStatus('error')
          return
        }

        listener = (envelope: Record<string, unknown>) => {
          if (!active) return
          const eventType = envelope?.type as string | undefined
          if (!eventType || !DOC_EVENT_TYPES.has(eventType)) return

          const eventId = envelope?.event_id as string | undefined
          if (eventId) {
            if (recentEventIds.has(eventId)) return
            recentEventIds.add(eventId)
            if (recentEventIds.size > DEDUP_CACHE_LIMIT) {
              const first = recentEventIds.values().next().value
              if (first !== undefined) recentEventIds.delete(first)
            }
          }

          emitEvent({
            event: eventType,
            data: (envelope?.payload ?? envelope?.data ?? envelope) as Record<string, unknown>,
          })
        }
        gw.addListener(listener)

        reconnectHandler = () => {
          if (!active || !topic) return
          setStatus('connecting')
          void ensureGatewayTopicSubscribed(gw, topic).then((subscribed) => {
            if (!active) return
            setStatus(subscribed.ok ? 'connected' : 'error')
          })
        }
        gw.onReconnectedEvent(reconnectHandler)

        retainGatewayTopic(topic)
        retainedTopic = topic

        const subscribed = await ensureGatewayTopicSubscribed(gw, topic)
        if (!active) {
          detachListeners()
          if (retainedTopic === topic) {
            retainedTopic = null
            await releaseGatewayTopic(gw, topic)
          }
          return
        }
        setStatus(subscribed.ok ? 'connected' : 'error')
      } catch {
        if (active) setStatus('error')
      }
    }

    void connect()

    const subscription: TabDocEventStreamSubscription = {
      get status() {
        return status
      },
      unsubscribe() {
        if (!active) return
        active = false
        detachListeners()
        try {
          const gw = getChatClient().getGateway()
          if (retainedTopic) {
            void releaseGatewayTopic(gw, retainedTopic)
            retainedTopic = null
          }
        } catch {
          // ignore
        }
        setStatus('idle')
      },
    }

    return subscription
  },
}
