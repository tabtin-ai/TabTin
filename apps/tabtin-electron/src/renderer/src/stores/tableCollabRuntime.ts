export interface TableCollabRuntimeState {
  isOnline: boolean
  isFallback: boolean
}

interface ViewIdentity {
  id?: unknown
}

export interface CollabViewRuntimeDecisionInput {
  isDocumentRuntimeActive: boolean
  targetViewId: string
  collabViews: ReadonlyArray<ViewIdentity> | null | undefined
}

/**
 * Whether view configuration should read from and write to the table Y.Doc.
 *
 * Keep this semantic separate from transport connectivity: a table may stay
 * online while the resource itself has fallen back to the REST projection.
 */
export const isTableCollabDocumentRuntimeActive = (
  state: TableCollabRuntimeState | null | undefined,
): boolean => Boolean(state?.isOnline && !state.isFallback)

/** Keep view-config writes on the same runtime that owns the rendered view. */
export const shouldUseCollabViewRuntime = (
  input: CollabViewRuntimeDecisionInput,
): boolean =>
  input.isDocumentRuntimeActive &&
  Boolean(input.collabViews?.some(view => String(view.id) === input.targetViewId))

export interface CollabViewRecordsRefreshDecisionInput extends CollabViewRuntimeDecisionInput {
  isTruncated: boolean
}

/**
 * After saving view config, refresh records via REST when the target view is
 * not owned by a complete Y.Doc projection (offline / fallback / missing view /
 * truncated snapshot).
 *
 * Must stay aligned with {@link shouldUseCollabViewRuntime}: write routing and
 * post-save refresh must use the same ownership judgment.
 */
export const shouldRefreshViewRecordsViaRest = (
  input: CollabViewRecordsRefreshDecisionInput,
): boolean => !shouldUseCollabViewRuntime(input) || input.isTruncated
