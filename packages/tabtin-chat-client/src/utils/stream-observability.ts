export interface StreamTelemetryEvent {
  id: string
  name: string
  timestamp: number
  payload?: Record<string, unknown>
}

const MAX_EVENTS = 300
const streamEvents: StreamTelemetryEvent[] = []
const streamCounters = new Map<string, number>()

const nextId = () => `stream-telem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const persistWindow = () => {
  if (typeof window === 'undefined') return
  ;(window as any).__TABTIN_STREAM_TELEMETRY__ = {
    events: [...streamEvents],
    counters: Object.fromEntries(streamCounters.entries()),
  }
}

const shouldVerbose = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('chat:stream:verbose') === '1'
  } catch {
    return false
  }
}

export const trackStreamTelemetry = (
  name: string,
  payload?: Record<string, unknown>,
  counterKey?: string,
) => {
  streamEvents.push({
    id: nextId(),
    name,
    timestamp: Date.now(),
    payload,
  })

  if (streamEvents.length > MAX_EVENTS) {
    streamEvents.shift()
  }

  if (counterKey) {
    streamCounters.set(counterKey, (streamCounters.get(counterKey) || 0) + 1)
  }

  if (shouldVerbose()) {
    console.info('[StreamTelemetry]', name, payload || {})
  }

  persistWindow()
}
