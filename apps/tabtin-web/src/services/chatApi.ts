import { ChatClient } from '@tabtin/chat-client'
import { Capabilities } from '@tabtin/ws-gateway-client'
import { useOrganizationStore } from '@tabtin/app-shell'
import { API_BASE_URL, CHAT_API_BASE_URL } from '@/config/api'
import { STORAGE_KEYS } from '@/platform'
import { useWsConnectionStore } from '@/stores/ws-connection-store'

let instance: ChatClient | null = null

function getDeviceId(): string {
  const KEY = 'tabtin_web_device_id'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}

export function getChatClient(): ChatClient {
  if (instance) return instance

  const chatApiBaseUrl = CHAT_API_BASE_URL || API_BASE_URL || `${window.location.origin}/api`

  const client = new ChatClient({
    baseURL: chatApiBaseUrl,
    catalogBaseURL: API_BASE_URL || `${window.location.origin}/api`,

    getToken: async () => {
      const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)
      if (!token) throw new Error('Not logged in')
      return token
    },

    getOrganizationId: async () => {
      return useOrganizationStore.getState().getEffectiveOrganizationId() ?? null
    },

    role: 'web',
    capabilities: [
      Capabilities.TABLE_EVENTS,
      Capabilities.NOTIFICATIONS,
      Capabilities.SHARE_EVENTS,
    ],
    deviceId: getDeviceId(),

    onDisconnect: () => {
      useWsConnectionStore.getState().setDisconnected()
    },
    onConnected: () => {
      useWsConnectionStore.getState().setConnected()
    },
    onReconnected: () => {
      useWsConnectionStore.getState().setConnected()
    },
    onReconnecting: (attempt: number, delayMs: number) => {
      useWsConnectionStore.getState().setReconnecting(attempt, delayMs)
    },
    onAuthFailed: () => {
      useWsConnectionStore.getState().setAuthFailed()
    },

    timeout: 30000,
  })

  instance = client
  return client
}

export function resetChatClient(): void {
  if (instance) {
    try {
      instance.getGateway().close()
    } catch { /* best-effort */ }
    instance = null
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (instance) {
      try { instance.getGateway().close() } catch { /* best-effort */ }
    }
  })
}
