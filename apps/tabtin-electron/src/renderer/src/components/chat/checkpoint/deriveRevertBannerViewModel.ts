import type { ChatMessage, SessionRollbackState } from '@tabtin/chat-client'
import { getRollbackResourceDetailsFromState, hasWorkspaceFilesFailure } from '../../../stores/chat/checkpoint/utils/rollbackResult'
import { isRegularUserMessage } from '../../../stores/chat/messages/utils/semanticMessageCount'
import {
  buildRevertBannerGuidance,
  buildRevertBannerHeadline,
  buildRevertBannerLayerChips,
  resolveRevertBannerStatus,
  REVERT_BANNER_COLLAPSE_MARKER_FALLBACK,
} from './revertBannerViewModelParts'
import { resolveRevertBannerPrimaryVariant } from './resolveRevertBannerPrimaryVariant'
import type { RevertBannerLayerChip, RevertBannerViewModel } from './revertBannerTypes'

export { REVERT_BANNER_COLLAPSE_MARKER_FALLBACK }
export type { RevertBannerLayerChip, RevertBannerViewModel } from './revertBannerTypes'

type TranslateFn = (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => string

export function deriveRevertBannerViewModel(params: {
  rollbackState: SessionRollbackState | null
  isInterrupted: boolean
  isReverted: boolean
  isRestoring: boolean
  isEditResendRevert: boolean
  collapsedRevertBannerMarker: string | undefined
  pending: boolean
  isStreaming: boolean
  t: TranslateFn
}): RevertBannerViewModel {
  const primaryVariant = resolveRevertBannerPrimaryVariant(params)
  if (primaryVariant) return primaryVariant
  const { rollbackState, t, pending, isStreaming } = params
  if (!rollbackState) return { variant: 'hidden' }
  const canUnrevert = rollbackState.can_unrevert ?? false
  const isActionDisabled = pending || isStreaming
  const currentStatus = resolveRevertBannerStatus(rollbackState)
  const canCollapseRevertSuccess = currentStatus === 'success'
  const resourceDetails = getRollbackResourceDetailsFromState(rollbackState)
  const retryableItems = resourceDetails.retryableItems
  const retryPreview = retryableItems
    .slice(0, 2)
    .map(item => `${item.resource_type}:${item.resource_id.slice(0, 8)}`)
    .join('、')

  return {
    variant: 'complex',
    currentStatus,
    headline: buildRevertBannerHeadline(currentStatus, t),
    guidance: buildRevertBannerGuidance(rollbackState, currentStatus, t),
    layerChips: buildRevertBannerLayerChips(rollbackState, t),
    rollbackReason: rollbackState.last_rollback_reason ?? undefined,
    hasRetryableRestores: retryableItems.length > 0,
    retryableCount: retryableItems.length,
    retryPreview,
    collabWarningCount: resourceDetails.collabWarnings.length,
    canUnrevert,
    canCollapseRevertSuccess,
    isActionDisabled,
    hasFileFailure: hasWorkspaceFilesFailure(rollbackState.partial_success_details),
  }
}

export function isRevertConsumedByNewTurn(
  targetMessageId: string | null | undefined,
  messages: Array<Pick<ChatMessage, 'id' | 'role' | 'message_kind' | 'metadata'> | ChatMessage> | undefined,
): boolean {
  if (!targetMessageId || !messages || messages.length === 0) return false
  const targetIdx = messages.findIndex(m => m.id === targetMessageId)
  if (targetIdx < 0) return false
  for (let i = targetIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    //  / ：只有真人用户轮才算「新一轮已开」；push / skill_invoke 不算
    if (isRegularUserMessage(m as ChatMessage)) {
      return true
    }
  }
  return false
}
