/**
 * useShareSettings — 公开链接 CRUD（doc/table 对称）
 *
 * 继承自 packages/tabdoc-ui/src/ShareSettingsPanel.tsx 的 useDocShareSettings 行为，
 * 扩展支持 TabData 表格 + 「链接可见范围」（share_type = 'public' | 'organization'，PRD D6）。
 *
 * 后端契约：
 *  - GET    /tabdoc/documents/{id}/share                         → 当前唯一有效分享
 *  - POST   /tabdoc/documents/{id}/share                         → {share}
 *           扩到 public 须 acknowledge_public_exposure=true
 *  - DELETE /tabdoc/documents/{id}/share?share_type=...          → {disabled_count}
 *  - POST   /tabdoc/documents/{id}/share/refresh                 → {share}
 * 表格（无 refresh endpoint，本期 refresh 通过 DELETE+POST 兜底）：
 *  - GET    /tabdata/tables/{id}/share                           → 当前唯一有效分享
 *  - POST   /tabdata/tables/{id}/share
 *           扩到 data（任何人）须 acknowledge_public_exposure=true
 *  - DELETE /tabdata/tables/{id}/share?share_type=...
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import type { ResourceType, ShareSettings, ShareScope } from '../types'

interface RawShareResponse {
  share: ShareSettings | null
  enabled: boolean
}

export interface EnableShareOptions {
  /** D6 链接可见范围：public（任何人）/ organization（仅组织成员） */
  shareScope?: ShareScope
  permission?: string
  password?: string
  expireHours?: number | null
  allowDownload?: boolean
  allowCopy?: boolean
  /**
   * ：扩大到「任何人」时须显式确认。
   * TabDoc（public）与 TabData（data）后端均强制。
   */
  acknowledgePublicExposure?: boolean
}

export interface UseShareSettingsResult {
  share: ShareSettings | null
  enabled: boolean
  loading: boolean
  /** 当前正在切换或更新分享时为 true，UI 据此做 disabled */
  busy: boolean
  fetchShare: () => Promise<void>
  enableShare: (options?: EnableShareOptions) => Promise<ShareSettings | null>
  disableShare: () => Promise<void>
  refreshLink: () => Promise<ShareSettings | null>
}

interface EndpointConfig {
  base: string
  /** GET/DELETE 时附加的 share_type query 参数；doc 的 GET 不传以取有效分享 */
  defaultGetType: 'public' | 'data' | null
  /** TabData 不支持 /refresh endpoint，hook 内部用 delete+create 兜底 */
  hasRefreshEndpoint: boolean
}

function resolveEndpoint(resourceType: ResourceType, resourceId: string): EndpointConfig {
  if (resourceType === 'doc') {
    return {
      base: `/tabdoc/documents/${resourceId}/share`,
      // ：不传 share_type，由后端返回当前唯一有效分享
      defaultGetType: null,
      hasRefreshEndpoint: true,
    }
  }
  return {
    base: `/tabdata/tables/${resourceId}/share`,
    // 与 TabDoc 对齐：不传 share_type，由后端返回当前唯一有效分享
    defaultGetType: null,
    hasRefreshEndpoint: false,
  }
}

/**
 * 把前端的"链接可见范围"（PRD D6 ShareScope）翻译成后端 share_type。
 * - doc:  public → 'public' ；organization / undefined → 'organization'（ 安全缺省）
 * - table: public → 'data'  ；organization / undefined → 'organization'（安全缺省）
 */
export function scopeToShareType(resourceType: ResourceType, scope: ShareScope | undefined): string {
  if (scope === 'organization') return 'organization'
  if (scope === 'public') {
    return resourceType === 'doc' ? 'public' : 'data'
  }
  // undefined：doc / table 均安全缺省 organization
  return 'organization'
}

export function shareTypeToScope(shareType: string | undefined, resourceType: ResourceType): ShareScope {
  if (shareType === 'organization') return 'organization'
  // 无类型时按安全缺省视为组织内（doc / table 一致）
  if (!shareType) return 'organization'
  return 'public'
}

export function useShareSettings(
  resourceType: ResourceType,
  resourceId: string,
  organizationId?: string,
): UseShareSettingsResult {
  const client = useAppHostClient()
  const endpointConfig = useMemo(() => resolveEndpoint(resourceType, resourceId), [resourceType, resourceId])
  const [share, setShare] = useState<ShareSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const fetchShare = useCallback(async () => {
    setLoading(true)
    try {
      const result = await client.request<RawShareResponse>({
        method: 'GET',
        endpoint: endpointConfig.base,
        ...(endpointConfig.defaultGetType
          ? { params: { share_type: endpointConfig.defaultGetType } }
          : {}),
      })
      setShare(result?.share ?? null)
      setEnabled(Boolean(result?.enabled))
    } catch {
      setShare(null)
      setEnabled(false)
    } finally {
      setLoading(false)
    }
  }, [client, endpointConfig])

  useEffect(() => {
    if (!resourceId) return
    void fetchShare()
  }, [fetchShare, resourceId])

  const enableShare = useCallback<UseShareSettingsResult['enableShare']>(
    async (options = {}) => {
      setBusy(true)
      try {
        const shareType = scopeToShareType(resourceType, options.shareScope)
        // Wave 5 §C PATCH 语义：未传 password 不动密码（保留旧 hash）；
        // 显式传 "" 清空；传非空字符串设新密码。
        const body: Record<string, unknown> = {
          share_type: shareType,
          permission: options.permission ?? share?.permission ?? 'view',
          expire_hours: options.expireHours ?? null,
          allow_download: options.allowDownload ?? true,
        }
        if (options.password !== undefined) {
          body.password = options.password
        }
        if (resourceType === 'doc') {
          body.allow_copy = options.allowCopy ?? true
        }
        // doc: public；table: data —— 扩大到「任何人」须显式确认
        const isPublicShareType =
          shareType === 'public' || (resourceType === 'table' && shareType === 'data')
        if (isPublicShareType && options.acknowledgePublicExposure) {
          body.acknowledge_public_exposure = true
        }
        if (shareType === 'organization' && organizationId) {
          body.organization_id = organizationId
        }
        const result = await client.request<{ share: ShareSettings }>({
          method: 'POST',
          endpoint: endpointConfig.base,
          body,
        })
        setShare(result?.share ?? null)
        setEnabled(true)
        return result?.share ?? null
      } finally {
        setBusy(false)
      }
    },
    [client, endpointConfig, resourceType, share, organizationId],
  )

  const disableShare = useCallback<UseShareSettingsResult['disableShare']>(async () => {
    setBusy(true)
    try {
      // 用当前 share_type 关闭；doc 无当前类型时不传，由后端关有效分享
      const shareType = share?.share_type as string | undefined
      const params =
        shareType
          ? { share_type: shareType }
          : endpointConfig.defaultGetType
            ? { share_type: endpointConfig.defaultGetType }
            : undefined
      await client.request({
        method: 'DELETE',
        endpoint: endpointConfig.base,
        ...(params ? { params } : {}),
      })
      setShare(null)
      setEnabled(false)
    } finally {
      setBusy(false)
    }
  }, [client, endpointConfig, share])

  const refreshLink = useCallback<UseShareSettingsResult['refreshLink']>(async () => {
    setBusy(true)
    try {
      if (endpointConfig.hasRefreshEndpoint) {
        const shareType = share?.share_type as string | undefined
        const result = await client.request<{ share: ShareSettings }>({
          method: 'POST',
          endpoint: `${endpointConfig.base}/refresh`,
          ...(shareType ? { params: { share_type: shareType } } : {}),
        })
        setShare(result?.share ?? null)
        return result?.share ?? null
      }
      // TabData 兜底：删除后用同样 settings 重建。
      // refreshLink 不暴露密码到前端（出于安全 has_password 永远为 false 时无密码），
      // 所以重建时不传 password 字段——后端走 PATCH 语义保留 hash。
      // 注：DELETE→POST 是物理新建，后端实际拿不到旧 hash；TabData refresh 在 Wave 5
      // 之前就有此问题，独立修复登记到 [后续] R10 撤销范畴。
      const cached = share
      if (!cached) return null
      const shareType = (cached.share_type as string | undefined) ?? endpointConfig.defaultGetType
      if (!shareType) return null
      await client.request({
        method: 'DELETE',
        endpoint: endpointConfig.base,
        params: { share_type: shareType },
      })
      const recreateBody: Record<string, unknown> = {
        share_type: shareType,
        permission: cached.permission,
        expire_hours: null,
        allow_download: cached.allow_download ?? true,
      }
      // DELETE 后重建 data 分享仍属「扩到公网」，须带确认标记
      if (shareType === 'data') {
        recreateBody.acknowledge_public_exposure = true
      }
      if (shareType === 'organization' && organizationId) {
        recreateBody.organization_id = organizationId
      }
      const recreate = await client.request<{ share: ShareSettings }>({
        method: 'POST',
        endpoint: endpointConfig.base,
        body: recreateBody,
      })
      setShare(recreate?.share ?? null)
      return recreate?.share ?? null
    } finally {
      setBusy(false)
    }
  }, [client, endpointConfig, organizationId, share])

  return { share, enabled, loading, busy, fetchShare, enableShare, disableShare, refreshLink }
}
