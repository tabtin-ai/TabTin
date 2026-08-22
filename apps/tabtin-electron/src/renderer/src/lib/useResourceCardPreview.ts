import { useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_RESOURCES,
  onResourceEvent,
  useUnifiedResources,
} from '@/stores/useUnifiedResources'
import {
  getResourceCardPreview,
  type ResourceCardPreviewData,
  type ResourceCardPreviewResult,
} from '@/services/tabchatApi'
import type { IMResourceCardTablePreview } from '@/lib/imResourceCardPreview'
import { buildTablePreviewFromMetadata, mergeTablePreview } from '@/lib/imResourceCardPreview'

/** 资源相对当前用户的可用性：loading 拉取中、available 正常、deleted 已删除/回收站、forbidden 无权、unknown 拉取失败。 */
export type ResourceCardAvailability =
  | 'loading'
  | 'available'
  | 'deleted'
  | 'forbidden'
  | 'unknown'

export interface ResourceCardPreviewContext {
  previewText?: string
  metadata?: Record<string, unknown> | null
  previewTable?: IMResourceCardTablePreview
  /** ContextItem / 后端实时返回的标题，随文件重命名更新。 */
  liveTitle?: string
  /** 资源可用性，供卡片渲染失效态。 */
  availability: ResourceCardAvailability
  /** 后端按资源 ACL 计算的实际角色，不使用组织角色推断。 */
  currentUserRole?: ResourceCardPreviewData['current_user_role']
}

/** 优先展示统一资源 Store 中的实时 preview，回退到消息 metadata.card.description。 */
export function resolveResourceCardPreviewText(
  description: string | undefined,
  livePreview: string | undefined,
): string | undefined {
  const live = livePreview?.trim()
  if (live) {
    const visibleText = live
      .replace(/<[^>]*>/g, '')
      .replace(/&(?:nbsp|#160|#x0*a0);/gi, '')
      .replace(/\u00a0/g, '')
      .trim()
    if (visibleText) return live
  }
  const stored = description?.trim()
  return stored || undefined
}

/** 后端 preview_table → 前端快照；列缺 key/label 的丢弃，无有效列返回 undefined。 */
export function normalizeFetchedTablePreview(
  table: ResourceCardPreviewData['preview_table'],
): IMResourceCardTablePreview | undefined {
  if (!table?.columns?.length) return undefined
  const columns = table.columns
    .filter((col): col is { key: string; label: string } =>
      typeof col?.key === 'string' && typeof col?.label === 'string')
    .map((col) => ({ key: col.key, label: col.label }))
  if (!columns.length) return undefined
  return { columns, rows: table.rows ?? [], total_rows: table.total_rows }
}

export function resolveResourceCardAvailability(
  result: ResourceCardPreviewResult | undefined,
): ResourceCardAvailability {
  if (!result) return 'loading'
  if (result.status === 'ok') return 'available'
  if (result.status === 'forbidden') return 'forbidden'
  // IM cards carry a send-time snapshot and open through the shared-resource path.
  // A preview 404 can also mean "not visible from this user's current resource index";
  // do not disable the card or label it deleted before the actual resource pane checks.
  return 'unknown'
}

/** 每个 spaceId 在当前会话中只强制刷新一次，避免多张卡片重复触发列表请求。 */
const _forcedSpaces = new Set<string>()

export function useResourceCardPreviewContext(
  resourceId: string | undefined,
  spaceId: string | undefined,
  description: string | undefined,
  previewTable?: IMResourceCardTablePreview,
  resourceType?: 'table' | 'document',
): ResourceCardPreviewContext {
  const load = useUnifiedResources((state) => state.load)
  const resources = useUnifiedResources((state) =>
    spaceId ? state.getResources(spaceId) : EMPTY_RESOURCES,
  )
  const [result, setResult] = useState<ResourceCardPreviewResult | undefined>(undefined)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const accessRevokedRef = useRef(false)
  const previewResourceKeyRef = useRef('')
  const contextItemRef = useRef<typeof contextItem>(undefined)

  useEffect(() => {
    if (!spaceId || !resourceId) return
    const shouldForce = !_forcedSpaces.has(spaceId)
    if (shouldForce) _forcedSpaces.add(spaceId)
    void load(spaceId, shouldForce)
  }, [load, resourceId, spaceId])

  const contextItem = useMemo(
    () => resources.find((item) => item.resource_id === resourceId),
    [resourceId, resources],
  )
  contextItemRef.current = contextItem
  const updatedAt = contextItem?.updated_at ?? ''

  useEffect(() => {
    accessRevokedRef.current = false
  }, [resourceId, resourceType])

  useEffect(() => {
    if (!resourceId || (resourceType !== 'document' && resourceType !== 'table')) return
    const backendType = resourceType === 'document' ? 'tabdoc' : 'tabdata'
    return onResourceEvent(backendType, (event) => {
      if (event.resource_id !== resourceId) return
      if (event.type === 'resource_access_revoked') {
        accessRevokedRef.current = true
        setResult({ status: 'forbidden' })
        // 使正在进行的旧预览请求失效；撤权前返回的 ok 结果不能覆盖实时无权态。
        setRefreshRevision((revision) => revision + 1)
        return
      }
      if (event.type === 'resource_access_granted' || event.type === 'resource_access_changed') {
        accessRevokedRef.current = false
        setResult(undefined)
        setRefreshRevision((revision) => revision + 1)
      }
    })
  }, [resourceId, resourceType])

  // 按需拉资源真实预览：存量卡片的 ContextItem.preview 可能 stale（发卡时快照），
  // 后端实时算出真实内容；updatedAt 变（编辑/重命名经 WS 推送）→ 重拉。
  // 重拉时保留上一帧结果，避免 deleted/forbidden 闪回 loading/unknown。
  useEffect(() => {
    if (!resourceId || (resourceType !== 'document' && resourceType !== 'table')) {
      setResult(undefined)
      previewResourceKeyRef.current = ''
      return
    }
    const resourceKey = `${resourceType}:${resourceId}`
    if (previewResourceKeyRef.current !== resourceKey) {
      setResult(undefined)
      previewResourceKeyRef.current = resourceKey
    }
    let cancelled = false
    void getResourceCardPreview(resourceType, resourceId).then((res) => {
      if (cancelled) return
      if (accessRevokedRef.current) {
        setResult({ status: 'forbidden' })
        return
      }
      setResult((prev) => {
        if (res.status !== 'error') return res
        if (!prev) return res
        const hasItem = !!contextItemRef.current
        if (prev.status === 'deleted' || prev.status === 'forbidden') {
          // 资源已从统一列表消失 → 保留失效态；若条目已恢复出现 → 允许 error 以便重试
          return hasItem ? res : prev
        }
        if (prev.status === 'ok' && !hasItem) {
          // 列表已无该资源但请求失败 → 不保留 stale ok
          return res
        }
        return prev
      })
    })
    return () => {
      cancelled = true
    }
  }, [refreshRevision, resourceId, resourceType, updatedAt])

  const fetched = result?.status === 'ok' ? result.data : undefined

  let availability: ResourceCardAvailability = 'available'
  if (resourceType === 'document' || resourceType === 'table') {
    availability = resolveResourceCardAvailability(result)
  }

  const liveTitle = (fetched?.name || contextItem?.title)?.trim() || undefined
  const previewText =
    resolveResourceCardPreviewText(description, fetched?.description)
    ?? (contextItem?.preview?.trim() || undefined)
  const fetchedTable = resourceType === 'table'
    ? normalizeFetchedTablePreview(fetched?.preview_table)
    : undefined
  const metadataTable = resourceType === 'table'
    ? buildTablePreviewFromMetadata(contextItem?.metadata ?? null, previewText)
    : undefined

  return {
    previewText,
    metadata: contextItem?.metadata ?? null,
    previewTable: fetchedTable ?? mergeTablePreview(previewTable, metadataTable),
    liveTitle,
    availability,
    currentUserRole: fetched?.current_user_role,
  }
}

/** @deprecated 使用 useResourceCardPreviewContext */
export function useResourceCardPreview(
  resourceId: string | undefined,
  spaceId: string | undefined,
  description: string | undefined,
): string | undefined {
  return useResourceCardPreviewContext(resourceId, spaceId, description).previewText
}
