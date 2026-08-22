import type {
  RollbackPartialSuccessDetails,
  RollbackWarningView,
  SessionRollbackState,
} from '@tabtin/chat-client'
import type { ResourceRestoreItem } from '../../../../services/chatExtraApi'

type RetryableResourceCandidate = {
  resource_type?: unknown
  resource_id?: unknown
  action?: unknown
  restore_to_version_id?: unknown
}

function normalizeRetryableResourceItem(candidate: unknown): ResourceRestoreItem | null {
  if (!candidate || typeof candidate !== 'object') return null

  const value = candidate as RetryableResourceCandidate
  if (typeof value.resource_type !== 'string' || value.resource_type.length === 0) return null
  if (typeof value.resource_id !== 'string' || value.resource_id.length === 0) return null
  if (value.action !== 'restore_version' && value.action !== 'trash' && value.action !== 'skip') return null

  return {
    resource_type: value.resource_type,
    resource_id: value.resource_id,
    action: value.action,
    restore_to_version_id:
      typeof value.restore_to_version_id === 'string' || value.restore_to_version_id == null
        ? value.restore_to_version_id ?? null
        : null,
  }
}

export function extractRetryableResourceRestoreItems(
  details?: RollbackPartialSuccessDetails | null,
): ResourceRestoreItem[] {
  const retryable = details?.resources?.retryable
  if (!Array.isArray(retryable)) return []
  return retryable
    .map(normalizeRetryableResourceItem)
    .filter((item): item is ResourceRestoreItem => item != null)
}

export function extractRetryableResourceRestoreItemsFromRollbackState(
  rollbackState?: SessionRollbackState | null,
): ResourceRestoreItem[] {
  return extractRetryableResourceRestoreItems(rollbackState?.partial_success_details)
}

export function getRollbackResourceDetails(details?: RollbackPartialSuccessDetails | null): {
  restoredCount: number
  failedCount: number
  retryableItems: ResourceRestoreItem[]
  collabWarnings: RollbackWarningView[]
} {
  return {
    restoredCount: details?.resources?.restored_count ?? 0,
    failedCount: details?.resources?.failed_count ?? 0,
    retryableItems: extractRetryableResourceRestoreItems(details),
    collabWarnings: Array.isArray(details?.resources?.collab_sync_warnings)
      ? details?.resources?.collab_sync_warnings ?? []
      : [],
  }
}

export function getRollbackResourceDetailsFromState(
  rollbackState?: SessionRollbackState | null,
): {
  restoredCount: number
  failedCount: number
  retryableItems: ResourceRestoreItem[]
  collabWarnings: RollbackWarningView[]
} {
  return getRollbackResourceDetails(rollbackState?.partial_success_details)
}

export function hasWorkspaceFilesFailure(details?: RollbackPartialSuccessDetails | null): boolean {
  // Wave 1 A2 改造：后端嵌套字段从 `success: false` 改为 `status: 'failed'`，
  // 避免 `success` 跟 envelope 顶层 `ok` 字段重名造成"假装成功"反模式。
  // 旧字段名仍在 chat-client TS 类型定义里（W2 preload shim 严格化时一并删），
  // 这里同时认两种值，前端 caller 不需要再做兼容。
  const wf = details?.workspace_files as { status?: string; success?: boolean } | undefined
  if (!wf) return false
  if (wf.status === 'failed') return true
  if (wf.success === false) return true
  return false
}
