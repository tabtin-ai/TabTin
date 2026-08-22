import { useCallback } from 'react'
import { useAgentGatewayStatus } from '@/hooks/useAgentGatewayStatus'
import { mainAgentGateway } from '@/services/mainAgentGateway'
import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { reconnectCentrifugo } from '@/hooks/useCentrifugoClient'

export function useChatInputWsState() {
  const agentGatewayStatus = useAgentGatewayStatus()
  const reconnectAttempt = useWsConnectionStore(s => s.reconnectAttempt)
  const wsStatus = agentGatewayStatus === 'ready' ? 'connected' : 'disconnected'
  const sendBlockedByGatewayStatus = false

  const handleReconnect = useCallback(async () => {
    await mainAgentGateway.connect()
    reconnectCentrifugo()
  }, [])

  return {
    wsStatus,
    reconnectAttempt,
    wsDisconnected: sendBlockedByGatewayStatus,
    handleReconnect,
  }
}
