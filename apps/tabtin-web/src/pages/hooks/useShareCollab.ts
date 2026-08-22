/**
 * 分享页协作 token 获取与 collab provider 封装。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CollabStatus, getUserColor, useCollabProvider } from '@tabtin/collab-core'
import { useTableCollaboration } from '@tabtin/table-engine/collab'
import { API_BASE_URL, COLLAB_WS_URLS } from '@/config/api'
import { useAuthStore } from '@/stores/auth-store'
import type { UserInfo } from '@/types/auth'
import { shareAuthHeaders } from '../shareAuth'

export interface ShareCollabTokenPayload {
  share_collab_token: string
  resource_type: string
  resource_id: string
  permission: string
  /** ：full = 可进 Y.Doc；rest_projection = 强制 REST 投影 */
  collab_mode?: 'full' | 'rest_projection'
  reason?: string | null
  visible_field_count?: number
  total_field_count?: number
  hidden_field_count?: number
  authorized?: boolean
}

/** 字段可见性受限时后端返回的降级契约（无 share_collab_token） */
export interface ShareCollabDegradationPayload {
  collab_mode: 'rest_projection'
  reason: string
  authorized: false
  resource_type?: string
  resource_id?: string
  permission?: string
  visible_field_count?: number
  total_field_count?: number
  hidden_field_count?: number
}

export interface ShareCollabUser {
  id: string
  name: string
  color: string
  type: string
}

export function buildShareCollabUser(shareId: string, user: UserInfo | null): ShareCollabUser {
  const userId = user?.id
  const guestId = userId ? `share:${shareId}:${userId}` : `share:${shareId}:guest`
  const name = user?.nickname || user?.username || user?.email || '访客'
  return {
    id: guestId,
    name,
    color: getUserColor(userId || shareId),
    type: userId ? 'human' : 'guest',
  }
}

export async function fetchShareCollabToken(
  resource: 'doc' | 'table',
  shareId: string,
  password?: string,
): Promise<ShareCollabTokenPayload | null> {
  const basePath = resource === 'doc' ? '/tabdoc/shared' : '/tabdata/shared'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...shareAuthHeaders(),
  }
  if (resource === 'table' && password) {
    // 与 CORS / web table bootstrap / TabData 中间件统一；勿用未放行的 X-Share-Password
    headers['X-Table-Share-Password'] = password
  }

  const resp = await fetch(`${API_BASE_URL || '/api'}${basePath}/${shareId}/collab-token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: password ?? '' }),
  })
  if (!resp.ok) return null
  const json = await resp.json().catch(() => null)
  const data = json?.data ?? json
  // ：字段角色受限 → rest_projection，不进全量 Y.Doc，走 REST
  if (
    data?.collab_mode === 'rest_projection'
    || data?.reason === 'field_visibility_restricted'
    || data?.authorized === false
  ) {
    console.info('[ShareCollab] degraded to REST projection', {
      shareId,
      reason: data?.reason,
      visible_field_count: data?.visible_field_count,
      total_field_count: data?.total_field_count,
    })
    return null
  }
  if (!data?.share_collab_token || !data?.resource_id) return null
  return data as ShareCollabTokenPayload
}

function useShareCollabToken(input: {
  resource: 'doc' | 'table'
  shareId: string
  password?: string
  enabled?: boolean
}) {
  const enabled = input.enabled !== false
  const [token, setToken] = useState('')
  const [permission, setPermission] = useState('view')
  const [resourceId, setResourceId] = useState<string | null>(null)
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null)

  const applyPayload = useCallback((payload: ShareCollabTokenPayload | null) => {
    if (!payload) {
      setToken('')
      setPermission('view')
      setResourceId(null)
      return null
    }
    setToken(payload.share_collab_token)
    setPermission(payload.permission || 'view')
    setResourceId(payload.resource_id)
    return payload.share_collab_token
  }, [])

  const refreshToken = useCallback(async () => {
    if (!input.shareId) return null
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    const promise = fetchShareCollabToken(input.resource, input.shareId, input.password)
      .then(applyPayload)
      .finally(() => {
        refreshPromiseRef.current = null
      })
    refreshPromiseRef.current = promise
    return promise
  }, [applyPayload, input.password, input.resource, input.shareId])

  useEffect(() => {
    if (!enabled || !input.shareId) {
      applyPayload(null)
      return
    }
    void refreshToken()
  }, [enabled, input.shareId, input.password, input.resource, refreshToken, applyPayload])

  const getAuthToken = useCallback(async () => {
    if (token) return token
    const nextToken = await refreshToken()
    if (!nextToken) throw new Error('Share collab token unavailable')
    return nextToken
  }, [refreshToken, token])

  return {
    token,
    permission,
    resourceId,
    refreshToken,
    getAuthToken,
  }
}

export function useSharedDocCollab(input: {
  shareId: string
  password?: string
  enabled?: boolean
}) {
  const enabled = input.enabled !== false
  const currentUser = useAuthStore((state) => state.user)
  const tokenState = useShareCollabToken({
    resource: 'doc',
    shareId: input.shareId,
    password: input.password,
    enabled,
  })

  const collabUser = useMemo(
    () => buildShareCollabUser(input.shareId, currentUser),
    [currentUser, input.shareId],
  )

  const collabOptions = useMemo(() => {
    if (!enabled || !tokenState.token || !tokenState.resourceId || !COLLAB_WS_URLS.docs) return null
    return {
      serverUrl: COLLAB_WS_URLS.docs,
      documentName: `docs:${tokenState.resourceId}`,
      token: tokenState.token,
      user: collabUser,
      enableIndexedDB: tokenState.permission === 'edit',
      onTokenRefreshRequired: () => { void tokenState.refreshToken() },
    }
  }, [collabUser, enabled, tokenState.permission, tokenState.refreshToken, tokenState.resourceId, tokenState.token])

  const collab = useCollabProvider(collabOptions)
  const isFallback = collab.syncMode === 'legacy'
  const isRealtime = Boolean(
    collab.ydoc
    && !isFallback
    && collab.status !== CollabStatus.INITIAL
    && collab.status !== CollabStatus.FORCE_CLOSED,
  )
  const canEdit = tokenState.permission === 'edit' && collab.canEdit && !collab.readOnly

  return {
    ...collab,
    resourceId: tokenState.resourceId,
    permission: tokenState.permission,
    collabUser,
    isRealtime,
    isFallback,
    canEdit,
    refreshToken: tokenState.refreshToken,
    getAuthToken: tokenState.getAuthToken,
  }
}

export function useSharedTableCollab(input: {
  shareId: string
  tableId: string | null
  password?: string
  enabled?: boolean
}) {
  const currentUser = useAuthStore((state) => state.user)
  const tokenState = useShareCollabToken({
    resource: 'table',
    shareId: input.shareId,
    password: input.password,
    enabled: input.enabled !== false && Boolean(input.tableId),
  })
  const collabUser = useMemo(
    () => buildShareCollabUser(input.shareId, currentUser),
    [currentUser, input.shareId],
  )

  const collab = useTableCollaboration({
    tableId: input.tableId,
    getAuthToken: tokenState.getAuthToken,
    serverUrl: COLLAB_WS_URLS.table,
    user: collabUser,
    collabDisabled: input.enabled === false || !input.tableId || !tokenState.token,
    enabled: input.enabled !== false,
    onTokenRefreshRequired: () => { void tokenState.refreshToken() },
  })

  const isFallback = collab.syncMode === 'legacy'
  const isRealtime = Boolean(
    collab.ydoc
    && !isFallback
    && collab.status !== CollabStatus.INITIAL
    && collab.status !== CollabStatus.FORCE_CLOSED,
  )
  const canEdit = tokenState.permission === 'edit' && collab.canEdit && !collab.readOnly

  return {
    ...collab,
    permission: tokenState.permission,
    collabUser,
    isRealtime,
    isFallback,
    canEdit,
    refreshToken: tokenState.refreshToken,
    getAuthToken: tokenState.getAuthToken,
  }
}
