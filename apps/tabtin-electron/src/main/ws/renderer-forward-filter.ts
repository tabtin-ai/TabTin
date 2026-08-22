import type { GatewayEnvelope } from '@tabtin/ws-gateway-client'

export function shouldForwardGatewayEnvelopeToRenderer(envelope: Pick<GatewayEnvelope, 'type' | '_topic'>): boolean {
  const topic = typeof envelope._topic === 'string' ? envelope._topic : ''
  return !(
    envelope.type === 'agent.stream'
    || envelope.type.startsWith('agent.stream.')
    || topic === 'agent.stream'
    || topic.startsWith('agent.stream.')
  )
}
