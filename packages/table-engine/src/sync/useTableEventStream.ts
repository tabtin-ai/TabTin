import { useEffect, useRef, useState, useCallback } from 'react'
import type { WsGatewayLike, TableStreamEvent, StreamStatus } from './types'

const TABLE_EVENT_TYPES = new Set([
  'table.events.delta',
  'table.events.field',
  'table.events.view',
])

const DEDUP_CACHE_LIMIT = 200

export interface UseTableEventStreamOptions {
  tableId: string | null
  /** 返回 WS Gateway 实例（平台各自注入） */
  getGateway: () => WsGatewayLike
  enabled?: boolean
  onEvent?: (event: TableStreamEvent) => void
  onStatusChange?: (status: StreamStatus, error?: string) => void
  onReconnected?: () => void
  /** 订阅级访问上下文；服务端会独立校验，不作为客户端授权凭据。 */
  topicContext?: Record<string, unknown>
}

export function buildTableEventSubscribeOptions(
  tableId: string,
  topicContext: Record<string, unknown> | undefined,
): { topicContexts: Record<string, Record<string, unknown>> } | undefined {
  if (!topicContext || Object.keys(topicContext).length === 0) return undefined
  return {
    topicContexts: {
      [`table.events.${tableId}`]: topicContext,
    },
  }
}

export function useTableEventStream(options: UseTableEventStreamOptions) {
  const {
    tableId,
    getGateway,
    enabled = true,
    onEvent,
    onStatusChange,
    onReconnected,
    topicContext,
  } = options

  const [status, setStatus] = useState<StreamStatus>('idle')
  const listenerRef = useRef<((envelope: any) => void) | null>(null)
  const reconnectHandlerRef = useRef<(() => void) | null>(null)
  const isActiveRef = useRef(false)
  const hasConnectedRef = useRef(false)

  const recentEventIdsRef = useRef(new Set<string>())
  const onEventRef = useRef(onEvent)
  const onStatusChangeRef = useRef(onStatusChange)
  const onReconnectedRef = useRef(onReconnected)
  const getGatewayRef = useRef(getGateway)
  onEventRef.current = onEvent
  onStatusChangeRef.current = onStatusChange
  onReconnectedRef.current = onReconnected
  getGatewayRef.current = getGateway

  const [reconnectTrigger, setReconnectTrigger] = useState(0)
  const effectGenRef = useRef(0)

  useEffect(() => {
    if (!enabled || !tableId) {
      setStatus('idle')
      onStatusChangeRef.current?.('idle')
      return
    }

    const gen = ++effectGenRef.current
    isActiveRef.current = true
    const subscribeOptions = buildTableEventSubscribeOptions(tableId, topicContext)

    const isStale = () => effectGenRef.current !== gen

    const updateStatus = (nextStatus: StreamStatus, error?: string) => {
      setStatus(nextStatus)
      onStatusChangeRef.current?.(nextStatus, error)
    }

    const disconnect = () => {
      try {
        const gateway = getGatewayRef.current()
        if (listenerRef.current) {
          gateway.removeListener(listenerRef.current)
          listenerRef.current = null
        }
        if (reconnectHandlerRef.current) {
          gateway.offReconnectedEvent(reconnectHandlerRef.current)
          reconnectHandlerRef.current = null
        }
        if (tableId) {
          gateway.request('unsubscribe', { topics: [`table.events.${tableId}`] }).catch(() => {})
        }
      } catch { /* ignore if gateway not yet created */ }
    }

    const connect = async () => {
      if (isStale()) return

      disconnect()
      updateStatus('connecting')

      try {
        const gateway = getGatewayRef.current()

        const connected = await gateway.connect()
        if (isStale()) return
        if (!connected) throw new Error('WS connection failed')

        const subscribed = await gateway.subscribe([`table.events.${tableId}`], subscribeOptions)
        if (isStale()) return
        if (!subscribed?.ok) throw new Error('WS subscribe failed')

        listenerRef.current = (envelope) => {
          if (!envelope || !TABLE_EVENT_TYPES.has(envelope.type)) return
          const payload = envelope.payload || {}
          if (payload.table_id !== tableId && envelope.table_id !== tableId) return
          const eventId = envelope.event_id as string | undefined
          if (eventId) {
            const cache = recentEventIdsRef.current
            if (cache.has(eventId)) return
            cache.add(eventId)
            if (cache.size > DEDUP_CACHE_LIMIT) {
              const first = cache.values().next().value
              if (first !== undefined) cache.delete(first)
            }
          }
          onEventRef.current?.({
            event: envelope.type,
            data: payload,
            id: envelope.event_id,
          })
        }
        gateway.addListener(listenerRef.current)

        const reconnectedHandler = () => {
          if (isStale()) return

          // Even a stream that received no prior events may have missed a delete
          // while disconnected, so every real resubscribe must resume HTTP delta sync.
          updateStatus('connecting')
          gateway.subscribe([`table.events.${tableId}`], subscribeOptions).then(sub => {
            if (isStale()) return
            if (sub?.ok) {
              updateStatus('connected')
              onReconnectedRef.current?.()
            } else {
              updateStatus('error', 'resubscribe failed')
            }
          }).catch(() => {
            if (!isStale()) updateStatus('error', 'resubscribe failed')
          })
        }
        reconnectHandlerRef.current = reconnectedHandler
        gateway.onReconnectedEvent(reconnectedHandler)

        hasConnectedRef.current = true
        updateStatus('connected')
      } catch (error) {
        if (isStale()) return
        updateStatus('error', error instanceof Error ? error.message : 'push connection error')
      }
    }

    void connect()

    return () => {
      isActiveRef.current = false
      hasConnectedRef.current = false
      disconnect()
    }
  }, [enabled, tableId, topicContext, reconnectTrigger])

  const reconnect = useCallback(() => {
    setReconnectTrigger(prev => prev + 1)
  }, [])

  const disconnect = useCallback(() => {
    isActiveRef.current = false
    try {
      const gateway = getGatewayRef.current()
      if (listenerRef.current) {
        gateway.removeListener(listenerRef.current)
        listenerRef.current = null
      }
      if (reconnectHandlerRef.current) {
        gateway.offReconnectedEvent(reconnectHandlerRef.current)
        reconnectHandlerRef.current = null
      }
    } catch { /* ignore */ }
    setStatus('disconnected')
    onStatusChangeRef.current?.('disconnected')
  }, [])

  return {
    status,
    isConnected: status === 'connected',
    reconnect,
    disconnect,
  }
}
