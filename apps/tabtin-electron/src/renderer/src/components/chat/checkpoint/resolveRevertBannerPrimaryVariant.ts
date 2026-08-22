import type { SessionRollbackState } from '@tabtin/chat-client'
import {
  isSimpleRollback,
  resolveRevertBannerStatus,
  REVERT_BANNER_COLLAPSE_MARKER_FALLBACK,
} from './revertBannerViewModelParts'
import type { RevertBannerViewModel } from './revertBannerTypes'

export function resolveRevertBannerPrimaryVariant(params: {
  rollbackState: SessionRollbackState | null
  isInterrupted: boolean
  isReverted: boolean
  isRestoring: boolean
  isEditResendRevert: boolean
  collapsedRevertBannerMarker: string | undefined
  pending: boolean
  isStreaming: boolean
}): RevertBannerViewModel | null {
  const {
    rollbackState,
    isInterrupted,
    isReverted,
    isRestoring,
    isEditResendRevert,
    collapsedRevertBannerMarker,
    pending,
    isStreaming,
  } = params

  if (isInterrupted && !isReverted && !isRestoring) return { variant: 'interrupted' }
  if (!isReverted || isRestoring || !rollbackState || isEditResendRevert) return { variant: 'hidden' }

  const canUnrevert = rollbackState.can_unrevert ?? false
  const isActionDisabled = pending || isStreaming
  const currentStatus = resolveRevertBannerStatus(rollbackState)
  const revertBannerCollapseMarker = rollbackState.updated_at
    ?? rollbackState.safety_snapshot_ref
    ?? REVERT_BANNER_COLLAPSE_MARKER_FALLBACK
  const isRevertSuccessCollapsed = currentStatus === 'success'
    && collapsedRevertBannerMarker === revertBannerCollapseMarker

  if (isRevertSuccessCollapsed) {
    return { variant: 'collapsed_success', canUnrevert, isActionDisabled }
  }
  if (isSimpleRollback(null, rollbackState)) {
    return { variant: 'simple', canUnrevert, isActionDisabled }
  }
  return null
}
