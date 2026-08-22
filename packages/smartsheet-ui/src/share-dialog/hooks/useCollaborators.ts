/**
 * useCollaborators — 协作者列表 / 邀请 / 改权限 / 移除
 *
 * 对接 Wave 2 后端 8 个 endpoint 中的 4 个 collaborators endpoint。
 * 调用方传入 resourceType + resourceId，hook 内部按规则拼 endpoint。
 *
 * 后端契约（同时适用 doc 与 table）：
 *  - POST  /tabdoc/documents/{id}/collaborators        — invite (batch)
 *  - GET   /tabdoc/documents/{id}/collaborators        — list
 *  - PATCH /tabdoc/documents/{id}/collaborators/{uid}  — update permission
 *  - DELETE /tabdoc/documents/{id}/collaborators/{uid} — remove
 * （TabData 对称：/tabdata/tables/{id}/collaborators 系列）
 * （TabFiles ：/context/files/{id}/collaborators 系列）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import { resolvePublicAvatarUrl } from '../resolvePublicAvatarUrl'
import type { ResourceType, UserBrief, CollaboratorOut, SkippedItem, InviteResult } from '../types'

interface CollaboratorListResponse {
  owner: UserBrief
  collaborators: CollaboratorOut[]
}

function withResolvedAvatar<T extends { avatar?: string | null }>(user: T, hint?: string | null): T {
  return {
    ...user,
    avatar: resolvePublicAvatarUrl(user.avatar, hint),
  }
}

export interface UseCollaboratorsResult {
  owner: UserBrief | null
  collaborators: CollaboratorOut[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  /** 邀请：返回 {notified, skipped}，调用方负责按 skipped[].reason 渲染 toast */
  invite: (userIds: string[], permission: string) => Promise<InviteResult>
  updatePermission: (userId: string, permission: string) => Promise<CollaboratorOut>
  remove: (userId: string) => Promise<void>
}

function basePath(resourceType: ResourceType, resourceId: string): string {
  if (resourceType === 'doc') {
    return `/tabdoc/documents/${resourceId}/collaborators`
  }
  if (resourceType === 'file') {
    return `/context/files/${resourceId}/collaborators`
  }
  return `/tabdata/tables/${resourceId}/collaborators`
}

export function useCollaborators(
  resourceType: ResourceType,
  resourceId: string,
): UseCollaboratorsResult {
  const client = useAppHostClient()
  const [owner, setOwner] = useState<UserBrief | null>(null)
  const [collaborators, setCollaborators] = useState<CollaboratorOut[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const endpoint = useMemo(() => basePath(resourceType, resourceId), [resourceType, resourceId])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await client.request<CollaboratorListResponse>({
        method: 'GET',
        endpoint,
      })
      const owner = data.owner ? withResolvedAvatar(data.owner) : null
      setOwner(owner)
      // Prefer owner's resolved absolute URL as CDN origin for peer object keys.
      const assetHint = owner?.avatar && /^https?:/i.test(owner.avatar) ? owner.avatar : null
      setCollaborators(
        Array.isArray(data.collaborators)
          ? data.collaborators.map((c) => withResolvedAvatar(c, assetHint))
          : [],
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setOwner(null)
      setCollaborators([])
    } finally {
      setLoading(false)
    }
  }, [client, endpoint])

  useEffect(() => {
    if (!resourceId) return
    void reload()
  }, [reload, resourceId])

  const invite = useCallback<UseCollaboratorsResult['invite']>(
    async (userIds, permission) => {
      const result = await client.request<{ notified: number; skipped: SkippedItem[] }>({
        method: 'POST',
        endpoint,
        body: { user_ids: userIds, permission },
      })
      // 邀请成功后刷新列表
      void reload()
      return {
        notified: result?.notified ?? 0,
        skipped: Array.isArray(result?.skipped) ? result.skipped : [],
      }
    },
    [client, endpoint, reload],
  )

  const updatePermission = useCallback<UseCollaboratorsResult['updatePermission']>(
    async (userId, permission) => {
      const result = await client.request<CollaboratorOut>({
        method: 'PATCH',
        endpoint: `${endpoint}/${encodeURIComponent(userId)}`,
        body: { permission },
      })
      // 乐观更新本地列表
      setCollaborators((prev) =>
        prev.map((c) => (c.user_id === userId ? { ...c, permission: result?.permission ?? permission } : c)),
      )
      return result
    },
    [client, endpoint],
  )

  const remove = useCallback<UseCollaboratorsResult['remove']>(
    async (userId) => {
      await client.request({
        method: 'DELETE',
        endpoint: `${endpoint}/${encodeURIComponent(userId)}`,
      })
      setCollaborators((prev) => prev.filter((c) => c.user_id !== userId))
    },
    [client, endpoint],
  )

  return { owner, collaborators, loading, error, reload, invite, updatePermission, remove }
}
