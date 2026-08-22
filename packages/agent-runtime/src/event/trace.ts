import type { StreamEvent } from '../engine/contracts/wire-protocol.js'

/**
 * Extract the trace identity assigned when a runtime lifecycle starts.
 */
export function extractTraceIdFromLifecycleStart(
  event: StreamEvent,
): string | undefined {
  if (event.type !== 'agent.stream.lifecycle') return undefined
  const payload = event.payload as { phase?: unknown; trace_id?: unknown }
  if (payload.phase !== 'start') return undefined
  return typeof payload.trace_id === 'string' ? payload.trace_id : undefined
}
