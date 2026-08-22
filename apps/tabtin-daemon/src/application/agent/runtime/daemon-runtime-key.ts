import {
  disabledAppsExtraKeysMatch,
  normalizeDisabledAppsExtraKey,
  type RuntimeDisabledAppsExtraKey,
} from '@tabtin/agent-host/runtime'

export interface DaemonRuntimeExtraKey extends RuntimeDisabledAppsExtraKey {
  workspaceId: string
}

export function normalizeDaemonRuntimeExtraKey(
  disabledApps: readonly string[] | undefined,
  disabledToolPrefixes: readonly string[] | undefined,
  workspaceId: string,
): DaemonRuntimeExtraKey {
  return {
    ...normalizeDisabledAppsExtraKey(disabledApps, disabledToolPrefixes),
    workspaceId,
  }
}

export function daemonRuntimeExtraKeysMatch(
  existing: DaemonRuntimeExtraKey | undefined,
  requested: DaemonRuntimeExtraKey | undefined,
): boolean {
  return disabledAppsExtraKeysMatch(existing, requested)
    && (existing?.workspaceId ?? '') === (requested?.workspaceId ?? '')
}
