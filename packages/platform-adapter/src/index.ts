export type PlatformKind = 'electron' | 'daemon' | 'cloud' | 'mobile' | 'iot' | 'web'

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface AuthSnapshot {
  accessToken: string | null
  refreshToken: string | null
  expiresAt: number | null
  user?: unknown | null
}

export interface AuthAdapter {
  getSnapshot(): Promise<AuthSnapshot>
  save(snapshot: AuthSnapshot): Promise<void>
  clear(): Promise<void>
  isTokenExpiringSoon?: (bufferMinutes: number) => Promise<boolean>
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HttpRequest {
  url: string
  method?: HttpMethod
  headers?: Record<string, string>
  params?: Record<string, string | number | boolean | undefined>
  data?: unknown
}

export interface HttpAdapter {
  request<T>(request: HttpRequest): Promise<T>
  setAuthToken(token: string | null): void
}

export interface EventBus {
  on<T = unknown>(event: string, handler: (payload: T) => void): () => void
  emit<T = unknown>(event: string, payload: T): void
  clear(): void
}

export interface PlatformAdapter {
  platform: PlatformKind
  storage: KeyValueStorage
  auth: AuthAdapter
  http: HttpAdapter
  events: EventBus
}

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  return {
    on(event, handler) {
      const set = listeners.get(event) ?? new Set()
      set.add(handler as (payload: unknown) => void)
      listeners.set(event, set)
      return () => {
        set.delete(handler as (payload: unknown) => void)
        if (set.size === 0) {
          listeners.delete(event)
        }
      }
    },
    emit(event, payload) {
      const set = listeners.get(event)
      if (!set) return
      for (const handler of set) {
        handler(payload)
      }
    },
    clear() {
      listeners.clear()
    },
  }
}

export function createMemoryStorage(initial?: Record<string, string>): KeyValueStorage {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    async getItem(key) {
      return store.has(key) ? store.get(key)! : null
    },
    async setItem(key, value) {
      store.set(key, value)
    },
    async removeItem(key) {
      store.delete(key)
    },
  }
}
