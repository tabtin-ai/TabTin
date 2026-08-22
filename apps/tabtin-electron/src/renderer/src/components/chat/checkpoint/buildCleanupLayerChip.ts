import type { RollbackApplyLayerStatus } from '@tabtin/chat-client'
import type { RevertBannerLayerChip } from './revertBannerTypes'

type TranslateFn = (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => string

const CLEANUP_LABEL_KEY = 'checkpoint.layerCleanup'
const CLEANUP_LABEL_DEFAULT = '消息整理'

export function buildCleanupLayerChip(
  cleanupStatus: string,
  t: TranslateFn,
): RevertBannerLayerChip | null {
  if (cleanupStatus === 'pending_retry') {
    return {
      key: 'pg_state',
      label: t(CLEANUP_LABEL_KEY, { defaultValue: CLEANUP_LABEL_DEFAULT }),
      detail: t('checkpoint.layerCleanupRetry', { defaultValue: '待自动处理' }),
      status: 'partial_success',
    }
  }
  if (cleanupStatus === 'failed') {
    return {
      key: 'pg_state',
      label: t(CLEANUP_LABEL_KEY, { defaultValue: CLEANUP_LABEL_DEFAULT }),
      detail: t('checkpoint.layerCleanupFailed', { defaultValue: '处理失败' }),
      status: 'failed',
    }
  }
  if (cleanupStatus === 'abandoned') {
    return {
      key: 'pg_state',
      label: t(CLEANUP_LABEL_KEY, { defaultValue: CLEANUP_LABEL_DEFAULT }),
      detail: t('checkpoint.layerCleanupAbandoned', { defaultValue: '已跳过（不影响使用）' }),
      status: 'partial_success',
    }
  }
  if (cleanupStatus === 'pending') {
    return {
      key: 'pg_state',
      label: t(CLEANUP_LABEL_KEY, { defaultValue: CLEANUP_LABEL_DEFAULT }),
      detail: t('checkpoint.layerCleanupPending', { defaultValue: '待完成' }),
      status: 'pending',
    }
  }
  return null
}

export function buildResourceLayerChip(params: {
  rollbackState: { resource_restore_state?: unknown[] }
  resourceDetails: {
    restoredCount: number
    failedCount: number
    retryableItems: unknown[]
  }
  hasRetryableRestores: boolean
  t: TranslateFn
}): { detail: string; status: RollbackApplyLayerStatus } {
  const { resourceDetails, hasRetryableRestores, t } = params
  let status: RollbackApplyLayerStatus = 'success'
  let detail = t('checkpoint.layerResourcesRestored', {
    count: Math.max(resourceDetails.restoredCount, params.rollbackState.resource_restore_state?.length ?? 0),
    defaultValue: '已恢复 {{count}} 个',
  })
  if (resourceDetails.failedCount > 0) {
    status = resourceDetails.restoredCount > 0 ? 'partial_success' : 'failed'
    detail = resourceDetails.restoredCount > 0
      ? t('checkpoint.layerResourcesPartial', {
          restored: resourceDetails.restoredCount,
          failed: resourceDetails.failedCount,
          defaultValue: '{{restored}} 成功 / {{failed}} 失败',
        })
      : t('checkpoint.layerResourcesFailed', {
          failed: resourceDetails.failedCount,
          defaultValue: '{{failed}} 个失败',
        })
  } else if (hasRetryableRestores) {
    status = 'partial_success'
    detail = t('checkpoint.layerResourcesRetryable', {
      count: resourceDetails.retryableItems.length,
      defaultValue: '{{count}} 个待重试',
    })
  }
  return { detail, status }
}
