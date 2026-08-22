/**
 * Shared runtime-cache extra key (disabled apps / tool prefixes).
 * Both Electron and Daemon must include these in reuse decisions.
 */

export interface RuntimeDisabledAppsExtraKey {
  disabledApps: readonly string[]
  disabledToolPrefixes: readonly string[]
}

export function normalizeDisabledAppsExtraKey(
  disabledApps?: readonly string[],
  disabledToolPrefixes?: readonly string[],
): RuntimeDisabledAppsExtraKey {
  return {
    disabledApps: disabledApps ?? [],
    disabledToolPrefixes: disabledToolPrefixes ?? [],
  }
}

export function disabledAppsExtraKeysMatch(
  existing: RuntimeDisabledAppsExtraKey | undefined,
  requested: RuntimeDisabledAppsExtraKey | undefined,
): boolean {
  const left = normalizeDisabledAppsExtraKey(
    existing?.disabledApps,
    existing?.disabledToolPrefixes,
  )
  const right = normalizeDisabledAppsExtraKey(
    requested?.disabledApps,
    requested?.disabledToolPrefixes,
  )
  return (
    stringArraysEqual(left.disabledApps, right.disabledApps)
    && stringArraysEqual(left.disabledToolPrefixes, right.disabledToolPrefixes)
  )
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}
