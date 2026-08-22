import { StreamEvents } from '@tabtin/agent-wire'
import type { StreamEvent } from '@tabtin/agent-runtime'

export type DeliveryEventSource = 'runtime' | 'subagent_trace'
  | 'subagent_stream'

export type DeliveryRoute = 'durable' | 'transient'

/**
 * Host-level delivery routing policy.
 *
 * Runtime owns event construction. Host owns event destination: durable session
 * history/relay or transient observer delivery. Keep this decision centralized
 * so source-specific wiring cannot accidentally drop user-visible message facts.
 */
export function routeDeliveryEvent(
  event: StreamEvent,
  source: DeliveryEventSource,
): DeliveryRoute {
  if (source === 'subagent_trace') {
    return event.type === StreamEvents.PERSIST_MESSAGE ? 'durable' : 'transient'
  }
  if (source === 'subagent_stream') {
    return event.type === StreamEvents.SUBAGENT_STREAM_EVENT ? 'transient' : 'durable'
  }
  return 'durable'
}
