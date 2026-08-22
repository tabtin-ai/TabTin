/** @store-category session */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

export type AgentGatewayStatus = 'idle' | 'connecting' | 'ready' | 'recovering'

function isAgentGatewayStatus(value: string): value is AgentGatewayStatus {
  return value === 'idle' || value === 'connecting' || value === 'ready' || value === 'recovering'
}

interface AgentGatewayStore {
  status: AgentGatewayStatus
  setStatus: (status: AgentGatewayStatus) => void
  reset: () => void
}

let bridgeStarted = false
let unsubBridge: (() => void) | null = null

function refreshStatusFromBridge(): void {
  if (typeof window === 'undefined') return
  const gw = (window as any).tabtin?.agentGateway
  gw?.getStatus?.()
    .then((s: string) => {
      if (isAgentGatewayStatus(s)) {
        useAgentGatewayStore.getState().setStatus(s)
      }
    })
    .catch(() => {})
}

/** Agent Gateway 连接态；跨 ChatInput remount 持久，避免切会话闪「正在连接…」。 */
export const useAgentGatewayStore = create<AgentGatewayStore>((set) => ({
  status: 'connecting',
  setStatus: (status) => set({ status }),
  reset: () => {
    set({ status: 'connecting' })
    // bridge 已建时必须重拉：否则 reset 后 latch 挡住 ensure，会一直停在 connecting
    if (bridgeStarted) refreshStatusFromBridge()
  },
}))

registerResetAction('agent-gateway', 'reset', () => useAgentGatewayStore.getState().reset())

/** 进程级订阅 preload agentGateway；可重复调用，仅首次真正挂上。 */
export function ensureAgentGatewayBridge(): void {
  if (bridgeStarted) return
  if (typeof window === 'undefined') return

  const gw = (window as any).tabtin?.agentGateway
  if (!gw) return

  bridgeStarted = true
  refreshStatusFromBridge()

  const unsub = gw.onStatusChange?.((s: string) => {
    if (isAgentGatewayStatus(s)) {
      useAgentGatewayStore.getState().setStatus(s)
    }
  })
  unsubBridge = typeof unsub === 'function' ? unsub : null
}

/** 单测用：清订阅闩锁与 store 初值（不走 reset，避免误触发 getStatus）。 */
export function __resetAgentGatewayBridgeForTests(): void {
  unsubBridge?.()
  unsubBridge = null
  bridgeStarted = false
  useAgentGatewayStore.setState({ status: 'connecting' })
}
