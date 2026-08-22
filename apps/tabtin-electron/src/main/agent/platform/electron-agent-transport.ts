import type {
  AgentTransportEnvelope,
  AgentTransportPort,
  AgentTransportReadyInfo,
} from '@tabtin/agent-host/realtime'
import { electronWsGateway } from '../../ws/ElectronWsGateway.js'

export const electronAgentTransport: AgentTransportPort = {
  async subscribe(topics, options): Promise<void> {
    const response = await electronWsGateway.subscribe(topics, options)
    if (!response.ok) {
      throw new Error(response.error?.message ?? 'Agent topic subscription failed')
    }
  },
  async unsubscribe(topics): Promise<void> {
    const response = await electronWsGateway.unsubscribe(topics)
    if (!response.ok) {
      throw new Error(response.error?.message ?? 'Agent topic unsubscription failed')
    }
  },
  onEnvelope(handler): () => void {
    return electronWsGateway.onAnyEvent(envelope =>
      handler(envelope as AgentTransportEnvelope))
  },
  onReady(handler: (info: AgentTransportReadyInfo) => void): () => void {
    return electronWsGateway.onReconnect(() => handler({ reconnected: true }))
  },
}
