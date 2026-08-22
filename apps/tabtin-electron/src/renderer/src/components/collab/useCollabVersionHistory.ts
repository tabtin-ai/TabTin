/**
 * @deprecated 已废弃 — 请使用 `@tabtin/collab-core` 的 `useVersionHistory`。
 *
 * 此文件保留仅为向后兼容。所有新代码应直接引用
 * `import { useVersionHistory } from '@tabtin/collab-core'`。
 *
 * 迁移指南:
 *   旧: useCollabVersionHistory({ resourceType, resourceId, enabled })
 *   新: useVersionHistory({ resourceType, resourceId, apiBase, token, enabled, autoFetch })
 *
 * 字段映射:
 *   histories        → versions
 *   isLoadingHistories → loading
 *   refreshHistories → fetchVersions
 *   restoreFromHistory → restoreVersion
 *   deleteNamedVersion → unnameVersion
 */
import { joinApiPath } from '@tabtin/config'
import { useCallback } from 'react'
import { useVersionHistory, type OperationResult, type VersionHistoryItem } from '@tabtin/collab-core'
import { useAuthStore } from '@/stores/useAuthStore'
import { API_BASE_URL } from '@/config/api'

export interface CollabHistoryItem {
  id: string
  document_id: string
  is_snapshot: boolean
  editor_type: string
  editor_id: string
  expired_at: string | null
  created_at: string | null
  is_named: boolean
  name: string
  pinned: boolean
}

interface UseCollabVersionHistoryOptions {
  resourceType: string
  resourceId: string | null
  enabled?: boolean
  /** 恢复成功后的回调，调用方应在此触发 CollabProvider.forceReconnect() */
  onRestoreSuccess?: () => void
}

/**
 * @deprecated 请迁移至 `useVersionHistory` from `@tabtin/collab-core`。
 */
export function useCollabVersionHistory({
  resourceType,
  resourceId,
  enabled = true,
  onRestoreSuccess,
}: UseCollabVersionHistoryOptions) {
  const token = useAuthStore((s) => s.accessToken)

  const vh = useVersionHistory({
    resourceType,
    resourceId,
    apiBase: joinApiPath(API_BASE_URL, `/collab/v1`),
    token: token || '',
    enabled,
    autoFetch: enabled && !!resourceId,
    onRestoreSuccess,
  })

  const restoreFromHistory = useCallback(
    async (versionId: string): Promise<OperationResult> => {
      return vh.restoreVersion(versionId)
    },
    [vh.restoreVersion],
  )

  return {
    histories: vh.versions as unknown as CollabHistoryItem[],
    isLoadingHistories: vh.loading,
    restoringVersion: vh.restoringVersion,
    refreshHistories: vh.fetchVersions,
    restoreFromHistory,
    createNamedVersion: vh.createNamedVersion,
    renameVersion: vh.renameVersion,
    deleteNamedVersion: vh.unnameVersion,
  }
}
