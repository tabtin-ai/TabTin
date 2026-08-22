export type PageLoadErrorKind = 'dns' | 'offline' | 'connection' | 'server' | 'fallback'

const DNS_DESCRIPTIONS = new Set([
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
])

const OFFLINE_DESCRIPTIONS = new Set([
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_ACCESS_DENIED',
  'ERR_ADDRESS_UNREACHABLE',
])

const CONNECTION_DESCRIPTIONS = new Set([
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_FAILED',
  'ERR_TIMED_OUT',
  'ERR_EMPTY_RESPONSE',
  'ERR_ADDRESS_INVALID',
  'ERR_CONNECTION_ABORTED',
])

/** Chromium net error codes（与上表对应的常用子集） */
const DNS_CODES = new Set([-105, -137])
const OFFLINE_CODES = new Set([-106, -21, -138, -109])
const CONNECTION_CODES = new Set([-102, -101, -100, -118, -104, -7, -324, -108, -103])

const HTTP_DESC_RE = /^HTTP\s*([4-5]\d{2})\b/i

function normalizeDescription(raw?: string | null): string {
  return (raw ?? '').trim()
}

export function classifyPageLoadError(input: {
  errorDescription?: string | null
  errorCode?: number | null
  httpStatus?: number | null
}): PageLoadErrorKind {
  const status = input.httpStatus
  if (typeof status === 'number' && status >= 400) return 'server'

  const desc = normalizeDescription(input.errorDescription)
  if (HTTP_DESC_RE.test(desc)) return 'server'

  if (DNS_DESCRIPTIONS.has(desc) || (input.errorCode != null && DNS_CODES.has(input.errorCode))) {
    return 'dns'
  }
  if (OFFLINE_DESCRIPTIONS.has(desc) || (input.errorCode != null && OFFLINE_CODES.has(input.errorCode))) {
    return 'offline'
  }
  if (
    CONNECTION_DESCRIPTIONS.has(desc) ||
    (input.errorCode != null && CONNECTION_CODES.has(input.errorCode))
  ) {
    return 'connection'
  }
  return 'fallback'
}
