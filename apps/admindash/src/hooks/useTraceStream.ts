/**
 * useTraceStream Hook
 * 实时订阅 Trace 的 WS 事件流 — 基于 @tabtin/ws-gateway-client
 */

import { getApiClient } from '@/api/tabtin-client'
import { ORGANIZATION_API } from '@/config/api'
import type { SSEConnectedEvent, SSETraceEvent } from '@/types/agent-debug'
import { getOrCreateDeviceId } from '@/utils/deviceId'
import { type GatewayEnvelope, WsGatewayClient } from '@tabtin/ws-gateway-client'
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseTraceStreamOptions {
  enabled?: boolean
  onConnected?: (data: SSEConnectedEvent) => void
  onEvent?: (event: SSETraceEvent) => void
  onTraceEnd?: (status: string) => void
  onError?: (error: string) => void
}

interface UseTraceStreamReturn {
  events: SSETraceEvent[]
  isConnected: boolean
  error: string | null
  reconnect: () => void
  disconnect: () => void
}

interface OrganizationListResponse {
  organizations?: Array<{ id: string | number }>
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const optionalEnv = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function deriveWsBaseUrlFromApiBaseUrl(apiBaseUrl: string): string | undefined {
  try {
    const url = new URL(trimTrailingSlash(apiBaseUrl))
    if (url.pathname.endsWith('/api')) {
      url.pathname = url.pathname.slice(0, -4) || '/'
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = ''
    url.hash = ''
    return trimTrailingSlash(url.toString())
  } catch {
    return undefined
  }
}

function resolveWsBaseUrl(): string {
  const explicitWsBaseUrl = optionalEnv(import.meta.env.VITE_WS_BASE_URL)
  if (explicitWsBaseUrl) return trimTrailingSlash(explicitWsBaseUrl)

  const apiDerivedWsBaseUrl = optionalEnv(import.meta.env.VITE_API_BASE_URL)
    ? deriveWsBaseUrlFromApiBaseUrl(import.meta.env.VITE_API_BASE_URL)
    : undefined
  if (apiDerivedWsBaseUrl) return apiDerivedWsBaseUrl

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

async function resolveOrganizationId(): Promise<string | null> {
  try {
    const response = await getApiClient().raw<OrganizationListResponse>(
      'GET',
      ORGANIZATION_API.LIST_DEFAULT
    )
    const organizations = response.organizations || []
    if (Array.isArray(organizations) && organizations.length > 0) {
      return String(organizations[0].id)
    }
  } catch {
    // ignore
  }

  try {
    const response = await getApiClient().raw<OrganizationListResponse>('GET', ORGANIZATION_API.LIST)
    const organizations = response.organizations || []
    if (Array.isArray(organizations) && organizations.length > 0) {
      return String(organizations[0].id)
    }
  } catch {
    // ignore
  }

  return null
}

const deviceId = getOrCreateDeviceId()

export function useTraceStream(
  traceId: string | null,
  options: UseTraceStreamOptions = {}
): UseTraceStreamReturn {
  const { enabled = true, onConnected, onEvent, onTraceEnd, onError } = options

  const [events, setEvents] = useState<SSETraceEvent[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<WsGatewayClient | null>(null)
  const traceEndedRef = useRef(false)

  const onConnectedRef = useRef(onConnected)
  const onEventRef = useRef(onEvent)
  const onTraceEndRef = useRef(onTraceEnd)
  const onErrorRef = useRef(onError)
  onConnectedRef.current = onConnected
  onEventRef.current = onEvent
  onTraceEndRef.current = onTraceEnd
  onErrorRef.current = onError

  const disconnect = useCallback(() => {
    clientRef.current?.close()
    clientRef.current = null
    setIsConnected(false)
  }, [])

  const connect = useCallback(async () => {
    if (!traceId || !enabled) return

    disconnect()
    traceEndedRef.current = false
    // H2-A 技术 Review P1 修复：reconnect / 切 traceId 时清空 events，
    // 避免 hook 内部 events 状态在 traceId 切换后串了上一个 trace 的数据。
    // 当前 trace-detail.tsx 只用 isConnected 不读 events，所以现状不显形；
    // 但 hook 是公共 API，未来其他页面订阅时容易踩坑——前置卫生。
    setEvents([])
    setError(null)

    const token = localStorage.getItem('access_token')
    if (!token) {
      const msg = '未登录，无法订阅 Trace'
      setError(msg)
      onErrorRef.current?.(msg)
      return
    }

    const organizationId = await resolveOrganizationId()
    if (!organizationId) {
      const msg = '未找到组织'
      setError(msg)
      onErrorRef.current?.(msg)
      return
    }

    const currentTraceId = traceId

    const client = new WsGatewayClient({
      role: 'admin',
      capabilities: ['trace.stream'],
      deviceId,
      wsBaseUrl: resolveWsBaseUrl(),
      onEvent: (envelope: GatewayEnvelope) => {
        if (envelope.type === 'trace.stream.event') {
          const payload: SSETraceEvent = envelope.payload as SSETraceEvent
          setEvents((prev) => [...prev, payload])
          onEventRef.current?.(payload)
          if (payload.phase === 'trace_end') {
            traceEndedRef.current = true
            onTraceEndRef.current?.(payload.status || 'completed')
            client.close()
            clientRef.current = null
            setIsConnected(false)
          }
        }
      },
      onError: (err) => {
        setError(err.message)
        onErrorRef.current?.(err.message)
      },
      onDisconnect: () => {
        setIsConnected(false)
      },
    })

    clientRef.current = client

    const connected = await client.connect({ token, organizationId })
    if (!connected) {
      setError('WS 连接失败')
      onErrorRef.current?.('WS 连接失败')
      return
    }

    const subResponse = await client.subscribe([`trace.stream.${currentTraceId}`])
    if (!subResponse.ok) {
      setError(subResponse.error?.message || '订阅失败')
      onErrorRef.current?.(subResponse.error?.message || '订阅失败')
      client.close()
      clientRef.current = null
      return
    }

    setIsConnected(true)
    setError(null)
    onConnectedRef.current?.({ trace_id: currentTraceId, status: 'connected' })
  }, [traceId, enabled, disconnect])

  useEffect(() => {
    if (!enabled || !traceId) return

    void connect()
    return () => {
      disconnect()
    }
  }, [connect, disconnect, enabled, traceId])

  return {
    events,
    isConnected,
    error,
    reconnect: connect,
    disconnect,
  }
}
