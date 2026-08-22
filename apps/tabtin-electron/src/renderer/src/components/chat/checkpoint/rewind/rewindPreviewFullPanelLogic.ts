import type { getRollbackResourceDetailsFromState } from '../../../../stores/chat/checkpoint/utils/rollbackResult'

export function derivePreviousRollbackIssueMessage(params: {
  latestRollbackResourceDetails: ReturnType<typeof getRollbackResourceDetailsFromState>
  latestRollbackHasFileFailure: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}): string {
  const { latestRollbackResourceDetails, latestRollbackHasFileFailure, t } = params
  if (latestRollbackResourceDetails.retryableItems.length > 0) {
    return t('rewind.previousRollbackRetryable', {
      count: latestRollbackResourceDetails.retryableItems.length,
      defaultValue: '当前会话上一次回退仍有 {{count}} 个资源待重试，建议先处理或查看回退历史。',
    })
  }
  if (latestRollbackHasFileFailure) {
    return t('rewind.previousRollbackFileIssue', { defaultValue: '上次回退文件层未完全成功，建议先确认工作区状态。' })
  }
  return t('rewind.previousRollbackIssue', { defaultValue: '上次回退仍有未处理步骤，建议先查看回退历史。' })
}

export function deriveRollbackResourceLayerLabel(params: {
  latestRollbackResourceDetails: ReturnType<typeof getRollbackResourceDetailsFromState>
  t: (key: string, opts?: Record<string, unknown>) => string
}): string | null {
  const { latestRollbackResourceDetails, t } = params
  if (latestRollbackResourceDetails.restoredCount <= 0 && latestRollbackResourceDetails.failedCount <= 0) {
    return null
  }
  if (latestRollbackResourceDetails.failedCount > 0) {
    if (latestRollbackResourceDetails.restoredCount > 0) {
      return t('checkpoint.layerResourcesPartial', {
        restored: latestRollbackResourceDetails.restoredCount,
        failed: latestRollbackResourceDetails.failedCount,
        defaultValue: '{{restored}} 成功 / {{failed}} 失败',
      })
    }
    return t('checkpoint.layerResourcesFailed', {
      failed: latestRollbackResourceDetails.failedCount,
      defaultValue: '{{failed}} 个失败',
    })
  }
  return t('checkpoint.layerResourcesRestored', {
    count: latestRollbackResourceDetails.restoredCount,
    defaultValue: '已恢复 {{count}} 个',
  })
}

export function deriveRollbackFilesLayerLabel(params: {
  latestRollbackHasFileFailure: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}): string {
  const { latestRollbackHasFileFailure, t } = params
  return latestRollbackHasFileFailure
    ? t('checkpoint.layerFilesFailed', { defaultValue: '恢复失败' })
    : t('checkpoint.layerFilesRolledBack', { defaultValue: '已回退' })
}

export function isAgentOriginCheckpoint(checkpointRecord: {
  anchor_type?: string | null
  anchor_agent_run_id?: string | null
}): boolean {
  return checkpointRecord.anchor_type === 'assistant_turn'
    || checkpointRecord.anchor_type === 'assistant'
    || checkpointRecord.anchor_type === 'agent'
    || !!checkpointRecord.anchor_agent_run_id
}

export function shouldShowDecisionSummary(checkpointRecord: {
  anchor_type?: string | null
  anchor_agent_run_id?: string | null
  context_summary?: {
    decision_summary?: { intent?: string; outcome?: string; status?: string } | null
    user_prompt?: string | null
  } | null
}): boolean {
  const ctx = checkpointRecord.context_summary
  if (!ctx || !isAgentOriginCheckpoint(checkpointRecord)) return false
  const ds = ctx.decision_summary
  const userPrompt = ctx.user_prompt?.trim() || ''
  const intent = ds?.intent?.trim() || userPrompt
  const outcome = ds?.outcome?.trim() || ''
  const status = ds?.status
  return Boolean(intent || outcome || status === 'pending' || status === 'failed')
}

export function deriveFilteredRestorePlan<T extends { resource_type: string; resource_id: string }>(
  plan: T[] | undefined,
  excludedResources: Set<string>,
): Array<T & { action: 'skip'; can_restore: false } | T> | undefined {
  return plan?.map(ri => {
    const key = `${ri.resource_type}:${ri.resource_id}`
    if (excludedResources.has(key)) {
      return { ...ri, action: 'skip' as const, can_restore: false }
    }
    return ri
  })
}
