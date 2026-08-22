/**
 * Realtime subscription client for TabData table changes.
 *
 * Connects to the TabTin WebSocket gateway and subscribes
 * to `table.open.{tableId}` topics for live change events.
 */

export type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'SCHEMA' | '*'

export interface ChangePayload {
  table_id: string
  event: RealtimeEvent
  record_ids?: string[]
  records?: Record<string, unknown>[] | null
  action?: string
  field_ids?: string[]
  timestamp?: string
}

type ChangeHandler = (payload: ChangePayload) => void

interface Subscription {
  tableId: string
  events: Set<RealtimeEvent>
  handler: ChangeHandler
}

let requestCounter = 0
function nextRequestId(): string {
  return `sdk_${Date.now()}_${++requestCounter}`
}

export class RealtimeClient {
  private wsURL: string
  private token: string
  private ws: WebSocket | null = null
  private subscriptions = new Map<string, Subscription>()
  private connected = false
  private authResolved = false
  private pendingAuth: { resolve: () => void; reject: (err: Error) => void } | null = null

  constructor(wsURL: string, token: string) {
    this.wsURL = wsURL.replace(/\/$/, '')
    this.token = token
  }

  /**
   * Connect to the WebSocket gateway and authenticate.
   */
  async connect(): Promise<void> {
    if (this.connected) return

    return new Promise((resolve, reject) => {
      const url = `${this.wsURL}/ws/v1/gateway`
      this.ws = new WebSocket(url)
      this.pendingAuth = { resolve, reject }

      this.ws.onopen = () => {
        this.sendAuth()
      }

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          this.handleMessage(msg)
        } catch {
          // ignore non-JSON messages
        }
      }

      this.ws.onerror = () => {
        if (this.pendingAuth) {
          this.pendingAuth.reject(new Error('WebSocket connection failed'))
          this.pendingAuth = null
        }
      }

      this.ws.onclose = () => {
        this.connected = false
        this.authResolved = false
      }
    })
  }

  /**
   * Subscribe to changes on a table.
   *
   * ```ts
   * realtime.on('table-uuid', 'INSERT', (payload) => {
   *   console.log('New record:', payload)
   * })
   * ```
   */
  on(tableId: string, event: RealtimeEvent | RealtimeEvent[], handler: ChangeHandler): this {
    const events = new Set(Array.isArray(event) ? event : [event])
    const topic = `table.open.${tableId}`

    this.subscriptions.set(topic, { tableId, events, handler })

    if (this.connected && this.authResolved) {
      this.sendSubscribe(topic)
    }

    return this
  }

  /**
   * Unsubscribe from a table's changes.
   */
  off(tableId: string): this {
    const topic = `table.open.${tableId}`
    this.subscriptions.delete(topic)

    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify({
        v: 1,
        type: 'unsubscribe',
        request_id: nextRequestId(),
        role: 'open_api',
        payload: { topic },
      }))
    }

    return this
  }

  /**
   * Disconnect from the WebSocket gateway.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.authResolved = false
    this.subscriptions.clear()
  }

  // ── Internal ─────────────────────────────────────────

  private sendAuth(): void {
    if (!this.ws) return
    this.ws.send(JSON.stringify({
      v: 1,
      type: 'auth',
      request_id: nextRequestId(),
      role: 'open_api',
      payload: {
        access_token: this.token,
        capabilities: [],
      },
    }))
  }

  private sendSubscribe(topic: string): void {
    if (!this.ws) return
    this.ws.send(JSON.stringify({
      v: 1,
      type: 'subscribe',
      request_id: nextRequestId(),
      role: 'open_api',
      payload: { topic },
    }))
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string

    // Auth response
    if (type === 'auth.ok') {
      this.connected = true
      this.authResolved = true

      // Subscribe to all pending topics
      for (const topic of this.subscriptions.keys()) {
        this.sendSubscribe(topic)
      }

      if (this.pendingAuth) {
        this.pendingAuth.resolve()
        this.pendingAuth = null
      }
      return
    }

    // Auth error
    if (type === 'error' && !this.authResolved) {
      if (this.pendingAuth) {
        const payload = msg.payload as Record<string, unknown> | undefined
        this.pendingAuth.reject(new Error(
          `Auth failed: ${payload?.message || payload?.code || 'unknown'}`,
        ))
        this.pendingAuth = null
      }
      return
    }

    // Change events: table.open.record_change or table.open.schema_change
    if (type === 'table.open.record_change' || type === 'table.open.schema_change') {
      const payload = msg.payload as ChangePayload
      if (!payload?.table_id) return

      const topic = `table.open.${payload.table_id}`
      const sub = this.subscriptions.get(topic)
      if (!sub) return

      // Filter by event type
      if (sub.events.has('*') || sub.events.has(payload.event)) {
        sub.handler(payload)
      }
    }
  }
}
