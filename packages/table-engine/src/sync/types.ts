/**
 * WS Gateway 最小接口 — 供 sync 模块使用，不依赖 @tabtin/chat-client。
 * Electron/Web 各自传入自己的 WsGateway 实例即可满足该接口。
 */
export interface WsGatewayLike {
  connect(): Promise<boolean>
  subscribe(
    topics: string[],
    options?: { topicContexts?: Record<string, Record<string, unknown>> },
  ): Promise<{ ok: boolean } | null>
  request(messageType: string, payload: Record<string, unknown>): Promise<unknown>
  addListener(listener: (envelope: any) => void): void
  removeListener(listener: (envelope: any) => void): void
  onReconnectedEvent(listener: () => void): void
  offReconnectedEvent(listener: () => void): void
}

export type TableStreamEvent = {
  event: string
  data: Record<string, unknown>
  id?: string
}

export type StreamStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface IncrementalSyncSnapshot {
  total?: number
  metadata?: Record<string, unknown>
}
