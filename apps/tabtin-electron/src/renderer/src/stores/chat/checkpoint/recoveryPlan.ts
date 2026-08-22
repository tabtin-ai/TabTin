import type {
  ResourceRestoreInfo,
  RollbackPreviewResult,
} from '../../../services/chatExtraApi'

export interface RecoveryFileAnchor {
  id: string | null
  source: 'preview' | 'legacy_message_cache'
}

export interface RecoveryPlanContract {
  version: number
  previewRevision?: string
  filePreviewRevision?: string
  fileAnchor: RecoveryFileAnchor
}

export interface RecoveryPlanConfirmation {
  resourceRestorePlan?: ResourceRestoreInfo[]
  rollbackReason?: string
  approvedUnavailableFileReason?: string
  contract: RecoveryPlanContract
}

/**
 * 新契约的 rewind_anchor_id 属于用户确认的权威恢复计划。本地消息缓存只为
 * 没有该字段的旧 preview 提供兼容推导，不能否决或覆盖服务端计划。
 */
export function resolveRecoveryFileAnchor(
  preview: RollbackPreviewResult | null,
  cachedAnchorId: string | null,
): RecoveryFileAnchor {
  const hasPreviewAnchor = preview != null
    && Object.prototype.hasOwnProperty.call(preview, 'rewind_anchor_id')

  if (hasPreviewAnchor) {
    const anchorId = typeof preview.rewind_anchor_id === 'string'
      && preview.rewind_anchor_id.length > 0
      ? preview.rewind_anchor_id
      : null
    return { id: anchorId, source: 'preview' }
  }

  return { id: cachedAnchorId, source: 'legacy_message_cache' }
}

export function buildRecoveryPlanContract(input: {
  preview: RollbackPreviewResult
  fileAnchor: RecoveryFileAnchor
  localFilePreviewRevision: string | null
}): RecoveryPlanContract {
  const filePreviewRevision = input.preview.file_restore_host === 'daemon'
    ? input.preview.file_preview_revision ?? undefined
    : input.localFilePreviewRevision ?? undefined

  return {
    version: input.preview.rollback_contract_version ?? 2,
    previewRevision: input.preview.preview_revision ?? undefined,
    filePreviewRevision,
    fileAnchor: input.fileAnchor,
  }
}
