export interface ParsedEndMarker {
  /**
   * Exit code of the command.
   * `null` means the marker could not be parsed — callers should NOT treat this as "success" (PC-11 fix).
   */
  exitCode: number | null
  cwd: string
}

/**
 * The separator used between exitCode and cwd in the end marker tail.
 * PC-21 fix: changed from `_` to `\x1F` (Unit Separator) because `_` is
 * extremely common in filesystem paths, making the old format ambiguous.
 */
export const END_MARKER_SEPARATOR = '\x1F'

/**
 * Parses the tail portion after the end marker prefix, extracting exit code and cwd.
 *
 * New format (PC-21): `{endMarkerPrefix}{exitCode}\x1F{cwd}__`
 * Old format (legacy): `{endMarkerPrefix}{exitCode}_{cwd}__`
 *
 * PC-11 fix: when the marker tail cannot be parsed (empty, no valid exit code),
 * returns exitCode = null instead of silently defaulting to 0.
 *
 * PC-21 fix: uses \x1F (Unit Separator) as delimiter. Falls back to legacy `_`
 * parsing for backward compatibility with markers generated before this change.
 */
export function parseEndMarker(markerTail: string, fallbackCwd: string): ParsedEndMarker {
  // Try new separator first (\x1F)
  if (markerTail.includes(END_MARKER_SEPARATOR)) {
    return parseEndMarkerWithSeparator(markerTail, fallbackCwd, END_MARKER_SEPARATOR)
  }

  // Fallback to legacy `_` separator for backward compatibility
  return parseEndMarkerLegacy(markerTail, fallbackCwd)
}

/**
 * Parse using the new unambiguous separator.
 */
function parseEndMarkerWithSeparator(
  markerTail: string,
  fallbackCwd: string,
  separator: string,
): ParsedEndMarker {
  const cleaned = markerTail.replace(/__$/, '')
  const sepIdx = cleaned.indexOf(separator)
  if (sepIdx === -1) {
    return { exitCode: null, cwd: fallbackCwd }
  }

  const codeStr = cleaned.substring(0, sepIdx)
  const cwd = cleaned.substring(sepIdx + separator.length)

  if (codeStr === '') {
    return { exitCode: null, cwd: fallbackCwd }
  }

  const parsedCode = parseInt(codeStr, 10)
  if (isNaN(parsedCode)) {
    return { exitCode: null, cwd: fallbackCwd }
  }

  return {
    exitCode: parsedCode,
    cwd: cwd || fallbackCwd,
  }
}

/**
 * Legacy parser: splits on `_` and rejoins the rest for cwd.
 * Kept for backward compatibility with markers generated before PC-21.
 */
function parseEndMarkerLegacy(markerTail: string, fallbackCwd: string): ParsedEndMarker {
  const cleaned = markerTail.replace(/__$/, '')
  const parts = cleaned.split('_')

  if (parts.length === 0 || parts[0] === '') {
    return { exitCode: null, cwd: fallbackCwd }
  }

  const parsedCode = parseInt(parts[0], 10)

  if (isNaN(parsedCode)) {
    return { exitCode: null, cwd: fallbackCwd }
  }

  const cwd = parts.length > 1 ? parts.slice(1).join('_') : fallbackCwd

  return {
    exitCode: parsedCode,
    cwd: cwd || fallbackCwd,
  }
}

/**
 * Extracts the marker tail from raw output after a given marker prefix.
 * Returns null if the marker prefix is not found or the marker line is
 * incomplete (the protocol terminator `__` has not arrived yet).
 */
export function extractMarkerTail(output: string, markerPrefix: string): string | null {
  const idx = output.indexOf(markerPrefix)
  if (idx === -1) return null

  const afterMarker = output.substring(idx + markerPrefix.length)
  const lineEnd = afterMarker.indexOf('\n')
  const tail = lineEnd >= 0 ? afterMarker.substring(0, lineEnd) : afterMarker
  return tail.endsWith('__') ? tail : null
}
