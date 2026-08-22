import type { RollbackApplyLayerStatus, SessionRollbackState } from '@tabtin/chat-client'
import {
  getRollbackResourceDetailsFromState,
  hasWorkspaceFilesFailure,
} from '../../../stores/chat/checkpoint/utils/rollbackResult'
import { buildCleanupLayerChip, buildResourceLayerChip } from './buildCleanupLayerChip'
import { isSimpleRollback } from '@utils/chat/checkpointFeedback'
import type { RevertBannerLayerChip } from './revertBannerTypes'

export const REVERT_BANNER_COLLAPSE_MARKER_FALLBACK = 'rollback-active'

type TranslateFn = (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => string

export function buildRevertBannerLayerChips(
  rollbackState: SessionRollbackState,
  t: TranslateFn,
): RevertBannerLayerChip[] {
  const resourceDetails = getRollbackResourceDetailsFromState(rollbackState)
  const retryableItems = resourceDetails.retryableItems
  const hasRetryableRestores = retryableItems.length > 0
  const hasFileFailure = hasWorkspaceFilesFailure(rollbackState.partial_success_details)
  const cleanupStatus = rollbackState.cleanup_status ?? 'not_started'
  const resourceApplicable = resourceDetails.restoredCount > 0
    || resourceDetails.failedCount > 0
    || hasRetryableRestores
    || (rollbackState.resource_restore_state?.length ?? 0) > 0

  const chips: RevertBannerLayerChip[] = [
    {
      key: 'conversation',
      label: t('checkpoint.layerConversation', { defaultValue: '对话' }),
      detail: t('checkpoint.layerConversationRolledBack', { defaultValue: '已回退' }),
      status: 'success',
    },
    {
      key: 'workspace_files',
      label: t('checkpoint.layerFiles', { defaultValue: '文件' }),
      detail: hasFileFailure
        ? t('checkpoint.layerFilesFailed', { defaultValue: '恢复失败' })
        : t('checkpoint.layerFilesRolledBack', { defaultValue: '已回退' }),
      status: hasFileFailure ? 'failed' : 'success',
    },
  ]

  if (resourceApplicable) {
    const { detail, status } = buildResourceLayerChip({
      rollbackState: {
        resource_restore_state: rollbackState.resource_restore_state ?? undefined,
      },
      resourceDetails,
      hasRetryableRestores,
      t,
    })
    chips.push({
      key: 'resources',
      label: t('checkpoint.layerResources', { defaultValue: '资源' }),
      detail,
      status,
    })
  }

  const cleanupChip = buildCleanupLayerChip(cleanupStatus, t)
  if (cleanupChip) chips.push(cleanupChip)

  return chips
}

export function resolveRevertBannerStatus(rollbackState: SessionRollbackState): RollbackApplyLayerStatus {
  const resourceDetails = getRollbackResourceDetailsFromState(rollbackState)
  const cleanupStatus = rollbackState.cleanup_status ?? 'not_started'
  const hasFileFailure = hasWorkspaceFilesFailure(rollbackState.partial_success_details)
  const hasRetryableRestores = resourceDetails.retryableItems.length > 0
  if (rollbackState.last_apply_result === 'failed') return 'failed'
  if (
    rollbackState.last_apply_result === 'partial_success'
    || hasFileFailure
    || hasRetryableRestores
    || resourceDetails.failedCount > 0
    || cleanupStatus === 'failed'
    || cleanupStatus === 'pending_retry'
    || cleanupStatus === 'abandoned'
  ) {
    return 'partial_success'
  }
  return rollbackState.last_apply_result ?? 'success'
}

export function buildRevertBannerGuidance(
  rollbackState: SessionRollbackState,
  currentStatus: RollbackApplyLayerStatus,
  t: TranslateFn,
): string {
  const resourceDetails = getRollbackResourceDetailsFromState(rollbackState)
  const retryableItems = resourceDetails.retryableItems
  const hasRetryableRestores = retryableItems.length > 0
  const hasFileFailure = hasWorkspaceFilesFailure(rollbackState.partial_success_details)
  const canUnrevert = rollbackState.can_unrevert ?? false

  if (hasRetryableRestores) {
    return t('checkpoint.revertedRetryHint', {
      count: retryableItems.length,
      defaultValue: '优先重试 {{count}} 个失败的资源回退；发送新消息后将无法恢复原状。',
    })
  }
  if (hasFileFailure) {
    return t('checkpoint.revertedFileFailureHint', {
      defaultValue: '工作区文件恢复存在问题，请先手动检查文件状态；发送新消息后将无法恢复原状。',
    })
  }
  if (canUnrevert) {
    return t('checkpoint.revertedCanUnrevert', {
      defaultValue: '当前可撤销本次回退、恢复对话（工作区文件不会自动还原）。发送新消息后将无法撤销。',
    })
  }
  return t('checkpoint.revertedCannotUnrevert', {
    defaultValue: '当前已无法恢复原状，请在继续之前确认当前状态。',
  })
}

export function buildRevertBannerHeadline(currentStatus: RollbackApplyLayerStatus, t: TranslateFn): string {
  if (currentStatus === 'failed') {
    return t('checkpoint.revertedFailedTitle', { defaultValue: '回退未完整完成，请先处理当前问题' })
  }
  if (currentStatus === 'partial_success') {
    return t('checkpoint.revertedPartialTitle', { defaultValue: '回退已完成，但仍有部分步骤需要处理' })
  }
  return t('checkpoint.revertedSuccessTitle', { defaultValue: '已回退到历史版本' })
}

export { isSimpleRollback }
