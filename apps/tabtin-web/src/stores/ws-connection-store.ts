import { create } from 'zustand'

interface WsConnectionState {
  status: 'idle' | 'connected' | 'disconnected' | 'reconnecting' | 'auth_failed'
  reconnectAttempt: number
  reconnectDelay: number
  setConnected: () => void
  setDisconnected: () => void
  setReconnecting: (attempt: number, delayMs: number) => void
  setAuthFailed: () => void
}

export const useWsConnectionStore = create<WsConnectionState>((set) => ({
  status: 'idle',
  reconnectAttempt: 0,
  reconnectDelay: 0,
  setConnected: () => set({ status: 'connected', reconnectAttempt: 0, reconnectDelay: 0 }),
  setDisconnected: () => set({ status: 'disconnected' }),
  setReconnecting: (attempt, delayMs) =>
    set({ status: 'reconnecting', reconnectAttempt: attempt, reconnectDelay: delayMs }),
  setAuthFailed: () => set({ status: 'auth_failed' }),
}))
