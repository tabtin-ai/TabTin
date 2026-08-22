import type { RollbackApplyLayerStatus } from '@tabtin/chat-client'

export type RevertBannerLayerChip = {
  key: string
  label: string
  detail: string
  status: RollbackApplyLayerStatus
}

export type RevertBannerViewModel =
  | { variant: 'hidden' }
  | { variant: 'interrupted' }
  | { variant: 'collapsed_success'; canUnrevert: boolean; isActionDisabled: boolean }
  | { variant: 'simple'; canUnrevert: boolean; isActionDisabled: boolean }
  | {
    variant: 'complex'
    currentStatus: RollbackApplyLayerStatus
    headline: string
    guidance: string
    layerChips: RevertBannerLayerChip[]
    rollbackReason?: string
    hasRetryableRestores: boolean
    retryableCount: number
    retryPreview: string
    collabWarningCount: number
    canUnrevert: boolean
    canCollapseRevertSuccess: boolean
    isActionDisabled: boolean
    hasFileFailure: boolean
  }
