type ChatTelemetryLevel = 'info' | 'warn' | 'error'

export interface ChatTelemetryEvent {
  id: string
  name: string
  level: ChatTelemetryLevel
  timestamp: number
  sessionId?: string | null
  payload?: Record<string, unknown>
}

const MAX_EVENTS = 300
const events: ChatTelemetryEvent[] = []
let head = 0
const counters = new Map<string, number>()

function pushEvent(event: ChatTelemetryEvent): void {
  if (events.length < MAX_EVENTS) {
    events.push(event)
  } else {
    events[head] = event
    head = (head + 1) % MAX_EVENTS
  }
}

const isVerboseEnabled = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return (
      window.localStorage.getItem('chat:telemetry:verbose') === '1' ||
      Boolean(window.__TABTIN_CHAT_TELEMETRY_VERBOSE__)
    )
  } catch {
    return false
  }
}

const persistToWindow = () => {
  if (typeof window === 'undefined') return
  window.__TABTIN_CHAT_TELEMETRY__ = getChatTelemetrySnapshot()
}

const nextId = () => `chat-telem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export const trackChatTelemetry = (
  name: string,
  payload?: Record<string, unknown>,
  options?: {
    level?: ChatTelemetryLevel
    sessionId?: string | null
    counterKey?: string
  },
) => {
  const event: ChatTelemetryEvent = {
    id: nextId(),
    name,
    level: options?.level || 'info',
    timestamp: Date.now(),
    sessionId: options?.sessionId,
    payload,
  }

  pushEvent(event)

  if (options?.counterKey) {
    counters.set(options.counterKey, (counters.get(options.counterKey) || 0) + 1)
  }

  if (isVerboseEnabled()) {
    const tag = `[ChatTelemetry:${event.level}] ${event.name}`
    if (event.level === 'error') {
      console.error(tag, event)
    } else if (event.level === 'warn') {
      console.warn(tag, event)
    } else {
      console.info(tag, event)
    }
  }

  schedulePersist()
}

let _persistRafId: number | null = null
function schedulePersist() {
  if (_persistRafId !== null) return
  if (typeof requestAnimationFrame === 'undefined') { persistToWindow(); return }
  _persistRafId = requestAnimationFrame(() => {
    _persistRafId = null
    persistToWindow()
  })
}

export const resetChatTelemetry = () => {
  events.splice(0, events.length)
  head = 0
  counters.clear()
  persistToWindow()
}

export const getChatTelemetrySnapshot = () => ({
  events: events.length < MAX_EVENTS
    ? [...events]
    : [...events.slice(head), ...events.slice(0, head)],
  counters: Object.fromEntries(counters.entries()),
})
