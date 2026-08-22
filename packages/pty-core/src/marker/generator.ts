import { randomBytes } from 'crypto'
import { MARKER_PREFIX } from './constants'

export interface MarkerPair {
  nonce: string
  startMarker: string
  endMarkerPrefix: string
}

/**
 * Generates a cryptographically strong nonce (128 bits / 32 hex chars)
 * used to construct start and end markers for the PTY command protocol.
 *
 * PC-9 fix: increased nonce from 48 bits (12 hex) to 128 bits (32 hex)
 * to make brute-force marker forgery computationally infeasible.
 *
 * PC-20 fix: start and end markers now use different nonces so that
 * a child process observing the start marker echo cannot use it to
 * forge the end marker.
 */
export function generateMarkerPair(): MarkerPair {
  const startNonce = randomBytes(16).toString('hex')
  const endNonce = randomBytes(16).toString('hex')
  const startMarker = `${MARKER_PREFIX}START_${startNonce}__`
  const endMarkerPrefix = `${MARKER_PREFIX}END_${endNonce}_`
  return { nonce: endNonce, startMarker, endMarkerPrefix }
}
