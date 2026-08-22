import { trackChatTelemetry } from './chatTelemetry'

export type SendTimingTrace = {
  traceId: string
  clickedAtPerf: number
  clickedAtWall: number
  isNewSession: boolean
}

let activeTrace: SendTimingTrace | null = null

export function beginSendTimingTrace(args: { isNewSession: boolean }): SendTimingTrace {
  const trace: SendTimingTrace = {
    traceId: `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clickedAtPerf: performance.now(),
    clickedAtWall: Date.now(),
    isNewSession: args.isNewSession,
  }
  activeTrace = trace
  return trace
}

export function getActiveSendTimingTrace(): SendTimingTrace | null {
  return activeTrace
}

export function clearSendTimingTrace(traceId?: string): void {
  if (!traceId || activeTrace?.traceId === traceId) {
    activeTrace = null
  }
}

export function elapsedSinceSendClick(trace: SendTimingTrace | null | undefined): number | null {
  if (!trace) return null
  return Math.max(0, Math.round(performance.now() - trace.clickedAtPerf))
}

export function buildSendTimingPayload(
  trace: SendTimingTrace | null | undefined,
): Record<string, unknown> {
  if (!trace) return {}
  const elapsed = elapsedSinceSendClick(trace)
  return {
    sendTraceId: trace.traceId,
    isNewSession: trace.isNewSession,
    ...(elapsed != null ? { elapsed_ms: elapsed } : {}),
  }
}

export function trackSendTimingTelemetry(
  name: string,
  payload: Record<string, unknown> | undefined,
  trace: SendTimingTrace | null | undefined,
  options?: {
    sessionId?: string | null
    counterKey?: string
    level?: 'info' | 'warn' | 'error'
  },
): void {
  const resolved = trace ?? getActiveSendTimingTrace()
  trackChatTelemetry(name, {
    ...payload,
    ...buildSendTimingPayload(resolved),
  }, {
    sessionId: options?.sessionId,
    counterKey: options?.counterKey,
    level: options?.level,
  })
}
