import { ANSI_EXTENDED_RE, createMarkerLineRE } from './constants'

/**
 * Strips ANSI escape codes (including OSC sequences) and marker lines from raw PTY output.
 * PC-10 fix: uses ANSI_EXTENDED_RE which covers OSC sequences (\x1B]...ST).
 * PC-24 fix: uses createMarkerLineRE() to get a fresh global regex each call,
 * avoiding shared lastIndex state bugs.
 */
export function cleanOutput(raw: string): string {
  return raw
    .replace(ANSI_EXTENDED_RE, '')
    .replace(createMarkerLineRE(), '')
    .replace(/\n{3,}/g, '\n\n')
}
