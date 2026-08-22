/** @store-category session */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

export type WsConnectionState = 'idle' | 'connected' | 'reconnecting' | 'disconnected'

export function isOrganizationAccessBlockedFor(
  organizationAccessBlocked: boolean,
  organizationAccessBlockedId: string | null,
  organizationId: string | null,
): boolean {
  return organizationAccessBlocked
    && organizationId !== null
    && organizationAccessBlockedId === organizationId
}

interface WsConnectionStore {
  status: WsConnectionState
  authFailed: boolean
  /** 当前 organization 无访问权限，且暂无可自动切换的目标 */
  organizationAccessBlocked: boolean
  organizationAccessBlockedId: string | null
  organizationAccessBlockedName: string | null
  /** 正在自动切换到可用 organization */
  organizationAccessRecoveryInFlight: boolean
  reconnectAttempt: number
  reconnectDelay: number
  /** 最近一次重连同步到的新消息数量（由重连 handler 写入，Banner 消费后清零） */
  lastSyncCount: number
  /** 浏览器级网络在线状态（navigator.onLine） */
  networkOnline: boolean
  /** 因断连挂起、Agent 可能仍在后台执行的 sessionId 集合 */
  suspendedSessionIds: string[]
  setConnected: () => void
  setReconnecting: (attempt: number, delayMs: number) => void
  setDisconnected: () => void
  setAuthFailed: () => void
  clearAuthFailed: () => void
  setOrganizationAccessBlocked: (organizationId: string, organizationName: string) => void
  setOrganizationAccessRecoveryInFlight: (inFlight: boolean) => void
  clearOrganizationAccessState: () => void
  setLastSyncCount: (count: number) => void
  setNetworkOnline: (online: boolean) => void
  addSuspendedSession: (sessionId: string) => void
  removeSuspendedSession: (sessionId: string) => void
  /** 重置为初始 idle 状态（用于登出等场景） */
  reset: () => void
}

export const useWsConnectionStore = create<WsConnectionStore>((set) => ({
  status: 'idle',
  authFailed: false,
  organizationAccessBlocked: false,
  organizationAccessBlockedId: null,
  organizationAccessBlockedName: null,
  organizationAccessRecoveryInFlight: false,
  reconnectAttempt: 0,
  reconnectDelay: 0,
  lastSyncCount: 0,
  networkOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  suspendedSessionIds: [],
  setConnected: () => set({
    status: 'connected',
    authFailed: false,
    organizationAccessBlocked: false,
    organizationAccessBlockedId: null,
    organizationAccessBlockedName: null,
    organizationAccessRecoveryInFlight: false,
    reconnectAttempt: 0,
    reconnectDelay: 0,
  }),
  setReconnecting: (attempt, delayMs) =>
    set({ status: 'reconnecting', reconnectAttempt: attempt, reconnectDelay: delayMs }),
  setDisconnected: () => set({ status: 'disconnected' }),
  setAuthFailed: () => set({ authFailed: true }),
  clearAuthFailed: () => set({ authFailed: false }),
  setOrganizationAccessBlocked: (organizationId, organizationName) => set({
    organizationAccessBlocked: true,
    organizationAccessBlockedId: organizationId,
    organizationAccessBlockedName: organizationName,
    status: 'disconnected',
    reconnectAttempt: 0,
    reconnectDelay: 0,
  }),
  setOrganizationAccessRecoveryInFlight: (inFlight) => set({
    organizationAccessRecoveryInFlight: inFlight,
  }),
  clearOrganizationAccessState: () => set({
    organizationAccessBlocked: false,
    organizationAccessBlockedId: null,
    organizationAccessBlockedName: null,
    organizationAccessRecoveryInFlight: false,
  }),
  setLastSyncCount: (count) => set({ lastSyncCount: count }),
  setNetworkOnline: (online) => set({ networkOnline: online }),
  addSuspendedSession: (sessionId) =>
    set((state) => ({
      suspendedSessionIds: state.suspendedSessionIds.includes(sessionId)
        ? state.suspendedSessionIds
        : [...state.suspendedSessionIds, sessionId],
    })),
  removeSuspendedSession: (sessionId) =>
    set((state) => ({
      suspendedSessionIds: state.suspendedSessionIds.filter((id) => id !== sessionId),
    })),
  reset: () => set({
    status: 'idle',
    authFailed: false,
    organizationAccessBlocked: false,
    organizationAccessBlockedId: null,
    organizationAccessBlockedName: null,
    organizationAccessRecoveryInFlight: false,
    reconnectAttempt: 0,
    reconnectDelay: 0,
    lastSyncCount: 0,
    networkOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    suspendedSessionIds: [],
  }),
}))

registerResetAction('ws-connection', 'reset', () => useWsConnectionStore.getState().reset())
