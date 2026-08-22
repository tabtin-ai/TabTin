import type { PersistedEntryOwner } from '@tabtin/agent-runtime'

export type RelayEvent = {
  type: string
  payload: Record<string, unknown>
}

export interface RelayDeliveryMetadata {
  deliveryMode: 'live' | 'recover' | 'backfill'
  originalCreatedAtMs?: number
}

export interface RelayRequestPayload {
  session_id: string
  events: RelayEvent[]
  delivery_mode?: RelayDeliveryMetadata['deliveryMode']
  original_created_at_ms?: number
}

export function buildRelayRequestPayload(
  sessionId: string,
  events: RelayEvent[],
  metadata?: RelayDeliveryMetadata,
): RelayRequestPayload {
  return {
    session_id: sessionId,
    events,
    ...(metadata
      ? {
          delivery_mode: metadata.deliveryMode,
          ...(metadata.originalCreatedAtMs !== undefined
            ? { original_created_at_ms: metadata.originalCreatedAtMs }
            : {}),
        }
      : {}),
  }
}

export interface RelayAckResponse {
  ok?: boolean
  payload?: { error_code?: string; retryable?: boolean } | unknown
  error?: { code?: string; message?: string; details?: unknown }
}

export interface RelayFailureInfo {
  errorCode: string
  retryable: boolean
}

export interface RelayDeliveryLogger {
  info?: (message: string) => void
  warn: (message: string) => void
}

export interface RelayWithRetryDeps {
  resolveOwnerBestEffort: () =>
    | PersistedEntryOwner
    | undefined
    | Promise<PersistedEntryOwner | undefined>
  fallbackOrganizationId: () => string | undefined | null
  sendOnce: (
    organizationId: string,
    sessionId: string,
    events: RelayEvent[],
    metadata?: RelayDeliveryMetadata,
  ) => Promise<void>
  persistBatch: (
    owner: PersistedEntryOwner,
    sessionId: string,
    events: RelayEvent[],
  ) => Promise<void>
  log: RelayDeliveryLogger
  setTimeoutFn?: (handler: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export class SingleFlight {
  private inFlight: Promise<void> | null = null

  run(work: () => Promise<void>): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = work().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  get active(): boolean {
    return this.inFlight !== null
  }
}

const RELAY_FAILURE_MESSAGE_RE =
  /^relay_events NAK: error_code=([^ ]+) retryable=(true|false)$/

const RETRYABLE_WS_ERROR_CODES = new Set([
  'WS_REQUEST_TIMEOUT',
  'WS_NOT_CONNECTED',
  'WS_CLIENT_NOT_READY',
  'WS_SEND_FAILED',
  'WS_DISCONNECTED',
  'WS_CLOSED',
])

const NON_RETRYABLE_WS_ERROR_CODES = new Set([
  'WS_1003_SCHEMA_INVALID',
  'WS_1005_PERMISSION_DENIED',
  'WS_1014_REPLAY_GAP',
  'WS_MESSAGE_TOO_LARGE',
  'WS_SERIALIZE_FAILED',
])

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function isSessionNotFoundMessage(message: string | undefined): boolean {
  if (!message) return false
  const normalized = message.toLowerCase()
  return normalized.includes('session') && normalized.includes('not found')
}

function inferRetryableFromWsError(code: string, message?: string): boolean {
  if (NON_RETRYABLE_WS_ERROR_CODES.has(code)) return false
  if (isSessionNotFoundMessage(message)) return false
  // ：服务端超限文案；即使码被洗成 TIMEOUT 也不应重试毒帧
  if (message && /message too large/i.test(message)) return false
  if (RETRYABLE_WS_ERROR_CODES.has(code)) return true
  // Unknown WS errors are bounded by DeliveryBatchBuffer retries and
  // RelayRetryQueue attempts; prefer retrying to silently dropping events.
  return true
}

export function parseRelayFailure(
  response: RelayAckResponse | undefined | null,
): RelayFailureInfo | null {
  if (!response || response.ok !== false) return null

  const nakPayload = response.payload as
    | { error_code?: string; retryable?: boolean }
    | undefined
  const nakCode = readNonEmptyString(nakPayload?.error_code)
  if (nakCode) {
    return {
      errorCode: nakCode,
      retryable: nakPayload?.retryable === true,
    }
  }

  const wsCode = readNonEmptyString(response.error?.code)
  if (wsCode) {
    return {
      errorCode: wsCode,
      retryable: inferRetryableFromWsError(
        wsCode,
        readNonEmptyString(response.error?.message),
      ),
    }
  }

  return { errorCode: 'unknown', retryable: false }
}

export function parseRelayFailureFromError(error: unknown): RelayFailureInfo | null {
  if (!(error instanceof Error)) return null
  const match = RELAY_FAILURE_MESSAGE_RE.exec(error.message)
  if (!match) return null
  return {
    errorCode: match[1]!,
    retryable: match[2] === 'true',
  }
}

export function formatRelayFailureMessage(info: RelayFailureInfo): string {
  return `relay_events NAK: error_code=${info.errorCode} retryable=${info.retryable}`
}

export function assertRelayAck(
  response: RelayAckResponse | undefined | null,
): void {
  const failure = parseRelayFailure(response)
  if (failure) throw new Error(formatRelayFailureMessage(failure))
}

export async function relayEventsWithRetry(
  deps: RelayWithRetryDeps,
  owner: PersistedEntryOwner | undefined,
  sessionId: string,
  events: RelayEvent[],
  options?: {
    timeoutMs?: number
    deliveryMetadata?: RelayDeliveryMetadata
  },
): Promise<void> {
  const effectiveOwner = owner ?? (await deps.resolveOwnerBestEffort())
  const organizationId =
    effectiveOwner?.organizationId
    ?? deps.fallbackOrganizationId()
    ?? undefined

  if (!organizationId) {
    if (effectiveOwner) {
      await deps.persistBatch(effectiveOwner, sessionId, events)
    } else {
      deps.log.warn(
        '[relay] terminal-state relay skipped: no organizationId and no owner to persist',
      )
    }
    return
  }

  try {
    const send = options?.deliveryMetadata
      ? deps.sendOnce(
          organizationId,
          sessionId,
          events,
          options.deliveryMetadata,
        )
      : deps.sendOnce(organizationId, sessionId, events)
    await sendWithOptionalTimeout(
      send,
      options?.timeoutMs,
      deps.setTimeoutFn
        ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs)),
      deps.clearTimeoutFn
        ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (effectiveOwner) {
      deps.log.warn(
        `[relay] terminal-state relay failed, persisting for recover: ${message}`,
      )
      await deps.persistBatch(effectiveOwner, sessionId, events)
    } else {
      deps.log.warn(
        `[relay] terminal-state relay failed and no owner to persist (lost): ${message}`,
      )
    }
  }
}

async function sendWithOptionalTimeout(
  send: Promise<void>,
  timeoutMs: number | undefined,
  setTimeoutFn: (handler: () => void, ms: number) => unknown,
  clearTimeoutFn: (handle: unknown) => void,
): Promise<void> {
  if (!timeoutMs || timeoutMs <= 0) {
    await send
    return
  }

  let timer: unknown
  try {
    await Promise.race([
      send,
      new Promise<never>((_, reject) => {
        timer = setTimeoutFn(
          () => reject(new Error(`relay send timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeoutFn(timer)
  }
}
