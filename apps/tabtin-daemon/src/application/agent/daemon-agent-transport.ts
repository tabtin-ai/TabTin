/**
 * Daemon → AgentHost transport seam.
 *
 * Physical WS stays on DaemonGatewayClient. Host-owned Agent envelopes are
 * fed here; ActionBridge keeps ACTION_REQUEST on its own
 * path and must not be fed into this port.
 */

import type {
  AgentTransportEnvelope,
  AgentTransportPort,
  AgentTransportReadyInfo,
} from '@tabtin/agent-host/realtime'
import type { AgentGatewayPort } from './agent-gateway-port.js'

export class DaemonAgentTransport implements AgentTransportPort {
  private readonly envelopeHandlers = new Set<(envelope: AgentTransportEnvelope) => void>()
  private readonly readyHandlers = new Set<(info: AgentTransportReadyInfo) => void>()
  private reconnectHookInstalled = false

  constructor(private readonly gateway: AgentGatewayPort) {}

  feed(envelope: AgentTransportEnvelope): void {
    for (const handler of this.envelopeHandlers) {
      handler(envelope)
    }
  }

  async subscribe(topics: string[]): Promise<void> {
    await this.gateway.subscribeTopics(topics)
  }

  async unsubscribe(topics: string[]): Promise<void> {
    await this.gateway.unsubscribeTopics(topics)
  }

  onEnvelope(handler: (envelope: AgentTransportEnvelope) => void): () => void {
    this.envelopeHandlers.add(handler)
    return () => {
      this.envelopeHandlers.delete(handler)
    }
  }

  onReady(handler: (info: AgentTransportReadyInfo) => void): () => void {
    this.readyHandlers.add(handler)
    if (!this.reconnectHookInstalled) {
      this.reconnectHookInstalled = true
      this.gateway.onReconnect(() => {
        for (const ready of this.readyHandlers) {
          ready({ reconnected: true })
        }
      })
    }
    return () => {
      this.readyHandlers.delete(handler)
    }
  }
}
