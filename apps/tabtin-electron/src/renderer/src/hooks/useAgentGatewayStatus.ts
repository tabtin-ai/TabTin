import { useEffect } from 'react'
import {
  ensureAgentGatewayBridge,
  useAgentGatewayStore,
  type AgentGatewayStatus,
} from '@/stores/useAgentGatewayStore'

export type { AgentGatewayStatus }

/** 读 store 中的 Agent Gateway 状态；首次挂载时确保 bridge 已订阅。 */
export function useAgentGatewayStatus(): AgentGatewayStatus {
  useEffect(() => {
    ensureAgentGatewayBridge()
  }, [])

  return useAgentGatewayStore((s) => s.status)
}
