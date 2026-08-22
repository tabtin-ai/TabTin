export type TablePaneLoadFailure =
  | 'permission_denied'
  | 'resource_unavailable'
  | 'access_verification_unavailable'
  | 'generic'
  | null

interface ResolveTablePaneLoadFailureInput {
  fetchFailed: boolean
  hasDisplayTable: boolean
  errorCode: string | null | undefined
  errorStatus: number | null | undefined
}

/**
 * Resolve first-load failures before the loading placeholder is rendered.
 * A cached table may keep the pane usable after a transient refresh failure,
 * but it must never conceal an authoritative permission denial.
 */
export function resolveTablePaneLoadFailure({
  fetchFailed,
  hasDisplayTable,
  errorCode,
  errorStatus,
}: ResolveTablePaneLoadFailureInput): TablePaneLoadFailure {
  if (errorCode === 'EMBEDDED_ACCESS_UNAVAILABLE') {
    return 'access_verification_unavailable'
  }
  if (errorCode === 'PERMISSION_DENIED' || errorStatus === 403) {
    return 'permission_denied'
  }
  if (
    errorCode === 'NOT_FOUND'
    || errorCode === 'RESOURCE_NOT_FOUND'
    || errorStatus === 404
    || errorStatus === 410
  ) {
    return 'resource_unavailable'
  }
  if (!fetchFailed) return null
  return hasDisplayTable ? null : 'generic'
}
