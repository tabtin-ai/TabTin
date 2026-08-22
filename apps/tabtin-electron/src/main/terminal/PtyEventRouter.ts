export type PtyScopedEventType =
  | 'data'
  | 'exit'
  | 'agent-session-created'
  | 'agent-session-closed'
  | 'auto-respond-triggered'

const GLOBAL_SCOPE_KEY = '*'

function normalizeScopeKey(scopeId?: string): string {
  return typeof scopeId === 'string' && scopeId.trim()
    ? scopeId.trim()
    : GLOBAL_SCOPE_KEY
}

export class PtyEventRouter {
  // P1-H (WP2)：'agent-session-title' 已退役（agent-bridge.ts L168-174 硬契约
  // — D3 决策每次命令独立 session 后标题在 created 时一次定死）。
  private readonly subscribers = new Map<PtyScopedEventType, Map<string, Set<number>>>([
    ['data', new Map()],
    ['exit', new Map()],
    ['agent-session-created', new Map()],
    ['agent-session-closed', new Map()],
    ['auto-respond-triggered', new Map()],
  ])

  private readonly subscriberCache = new Map<string, number[]>()

  private invalidateCache(eventType: PtyScopedEventType, scopeKey: string): void {
    this.subscriberCache.delete(`${eventType}:${scopeKey}`)
    if (scopeKey !== GLOBAL_SCOPE_KEY) {
      this.subscriberCache.delete(`${eventType}:${GLOBAL_SCOPE_KEY}`)
    }
  }

  subscribe(eventType: PtyScopedEventType, webContentsId: number, scopeId?: string): void {
    const eventSubscribers = this.subscribers.get(eventType)
    if (!eventSubscribers) return

    const scopeKey = normalizeScopeKey(scopeId)
    const existing = eventSubscribers.get(scopeKey)
    if (existing) {
      existing.add(webContentsId)
    } else {
      eventSubscribers.set(scopeKey, new Set([webContentsId]))
    }

    this.invalidateCache(eventType, scopeKey)
  }

  unsubscribe(eventType: PtyScopedEventType, webContentsId: number, scopeId?: string): void {
    const eventSubscribers = this.subscribers.get(eventType)
    if (!eventSubscribers) return

    const scopeKey = normalizeScopeKey(scopeId)
    const existing = eventSubscribers.get(scopeKey)
    if (!existing) return

    existing.delete(webContentsId)
    if (existing.size === 0) {
      eventSubscribers.delete(scopeKey)
    }

    this.invalidateCache(eventType, scopeKey)
  }

  removeWebContents(webContentsId: number): void {
    for (const eventSubscribers of this.subscribers.values()) {
      for (const [scopeKey, listeners] of eventSubscribers) {
        listeners.delete(webContentsId)
        if (listeners.size === 0) {
          eventSubscribers.delete(scopeKey)
        }
      }
    }
    this.subscriberCache.clear()
  }

  getSubscriberIds(eventType: PtyScopedEventType, scopeId: string): number[] {
    const normalizedScope = normalizeScopeKey(scopeId)
    const cacheKey = `${eventType}:${normalizedScope}`
    const cached = this.subscriberCache.get(cacheKey)
    if (cached) return cached

    const eventSubscribers = this.subscribers.get(eventType)
    if (!eventSubscribers) return []

    const merged = new Set<number>()
    const scoped = eventSubscribers.get(normalizedScope)
    const global = normalizedScope !== GLOBAL_SCOPE_KEY
      ? eventSubscribers.get(GLOBAL_SCOPE_KEY)
      : undefined

    scoped?.forEach((id) => merged.add(id))
    global?.forEach((id) => merged.add(id))

    const result = Array.from(merged)
    this.subscriberCache.set(cacheKey, result)
    return result
  }

  hasSubscribers(eventType: PtyScopedEventType, scopeId: string): boolean {
    return this.getSubscriberIds(eventType, scopeId).length > 0
  }

  hasGlobalSubscribers(eventType: PtyScopedEventType): boolean {
    const eventSubscribers = this.subscribers.get(eventType)
    if (!eventSubscribers) return false
    return (eventSubscribers.get(GLOBAL_SCOPE_KEY)?.size ?? 0) > 0
  }
}
