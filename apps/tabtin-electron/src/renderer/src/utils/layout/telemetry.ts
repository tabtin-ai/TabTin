import { createLogger } from '@/utils/logger'

const log = createLogger('LayoutTelemetry')

export type LayoutV4Scope =
  | 'tabvideo'
  | 'file-explorer'
  | 'tabcode'
  | 'crawlspace'
  | 'shell-sidebar'
  | 'chat-rail'
  | 'chat-split'
  | 'canvas-split'

export type LayoutTelemetryLevel = 'info' | 'warn' | 'error'

export type LayoutTelemetryName =
  | 'resize_start'
  | 'resize_end'
  | 'resize_cancel'
  | 'layout_persist_success'
  | 'layout_persist_failed'
  | 'feature_flag_checked'

export interface LayoutTelemetryEvent {
  id: string
  name: LayoutTelemetryName
  level: LayoutTelemetryLevel
  scope: LayoutV4Scope | 'unknown'
  timestamp: number
  durationMs?: number
  payload?: Record<string, unknown>
}

const MAX_EVENTS = 500
const events: LayoutTelemetryEvent[] = []
const counters = new Map<string, number>()

const WINDOW_SNAPSHOT_KEY = '__TABTIN_LAYOUT_TELEMETRY__'
const VERBOSE_STORAGE_KEY = 'layout:telemetry:verbose'

const nextId = () => `layout-telem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const isVerboseEnabled = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return (
      window.localStorage.getItem(VERBOSE_STORAGE_KEY) === '1' ||
      Boolean(window.__TABTIN_LAYOUT_TELEMETRY_VERBOSE__)
    )
  } catch {
    return false
  }
}

const persistToWindow = () => {
  if (typeof window === 'undefined') return
  window.__TABTIN_LAYOUT_TELEMETRY__ = {
    events: [...events],
    counters: Object.fromEntries(counters.entries()),
  }
}

export interface TrackLayoutTelemetryOptions {
  level?: LayoutTelemetryLevel
  counterKey?: string
  durationMs?: number
}

export const trackLayoutTelemetry = (
  name: LayoutTelemetryName,
  scope: LayoutV4Scope | 'unknown',
  payload?: Record<string, unknown>,
  options?: TrackLayoutTelemetryOptions,
): void => {
  const event: LayoutTelemetryEvent = {
    id: nextId(),
    name,
    level: options?.level || 'info',
    scope,
    timestamp: Date.now(),
    durationMs: options?.durationMs,
    payload,
  }

  events.push(event)
  if (events.length > MAX_EVENTS) {
    events.shift()
  }

  if (options?.counterKey) {
    counters.set(options.counterKey, (counters.get(options.counterKey) || 0) + 1)
  }

  if (isVerboseEnabled()) {
    const prefix = `${event.scope}.${event.name}`
    if (event.level === 'error') {
      log.error(prefix, event)
    } else if (event.level === 'warn') {
      log.warn(prefix, event)
    } else {
      log.info(prefix, event)
    }
  }

  persistToWindow()
}

export interface LayoutResizeTelemetrySession {
  end: (payload?: Record<string, unknown>) => void
  cancel: (payload?: Record<string, unknown>) => void
  persistSuccess: (payload?: Record<string, unknown>) => void
  persistFailed: (error: unknown, payload?: Record<string, unknown>) => void
}

export const startLayoutResizeTelemetry = (
  scope: LayoutV4Scope | 'unknown',
  payload?: Record<string, unknown>,
): LayoutResizeTelemetrySession => {
  const startedAt = Date.now()
  let closed = false

  trackLayoutTelemetry('resize_start', scope, payload, {
    counterKey: `${scope}.resize_start`,
  })

  const durationMs = () => Date.now() - startedAt

  return {
    end: (endPayload) => {
      if (closed) return
      closed = true
      trackLayoutTelemetry(
        'resize_end',
        scope,
        endPayload,
        {
          durationMs: durationMs(),
          counterKey: `${scope}.resize_end`,
        },
      )
    },
    cancel: (cancelPayload) => {
      if (closed) return
      closed = true
      trackLayoutTelemetry(
        'resize_cancel',
        scope,
        cancelPayload,
        {
          level: 'warn',
          durationMs: durationMs(),
          counterKey: `${scope}.resize_cancel`,
        },
      )
    },
    persistSuccess: (successPayload) => {
      trackLayoutTelemetry(
        'layout_persist_success',
        scope,
        successPayload,
        { counterKey: `${scope}.persist_success` },
      )
    },
    persistFailed: (error, failedPayload) => {
      trackLayoutTelemetry(
        'layout_persist_failed',
        scope,
        {
          ...failedPayload,
          error: error instanceof Error ? error.message : String(error),
        },
        {
          level: 'error',
          counterKey: `${scope}.persist_failed`,
        },
      )
    },
  }
}

export const getLayoutTelemetrySnapshot = () => ({
  events: [...events],
  counters: Object.fromEntries(counters.entries()),
})

export const resetLayoutTelemetry = () => {
  events.splice(0, events.length)
  counters.clear()
  persistToWindow()
}
