/**
 * useSharedContextItems —「分享给我」资源并入「全部」列表的适配层
 *
 * 背景：Agent 私有化后，被分享的文档/表格在 owner 的私有 workspace，协作者
 * 没有该 Space 的成员身份，因此不会出现在普通 context-items（「全部」）列表里。
 * 历史上「分享给我」是一条独立数据源 + 独立简化 UI。
 *
 * 本 hook 把 `listSharedWithMe` 的结果映射成 `SpaceContextItem` 形状，使其能
 * 与「全部」列表统一渲染（含位置列）。`metadata.sharedLocation` 承载权限裁剪后的
 * 原位置，`metadata.sharedBy` 独立承载分享来源。点击需走 `openForeignSharedItem`
 * 而非普通 Space 导航（资源不在当前 Space）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  listSharedWithMe,
  listSharedResourcePlacements,
  type SharedResourceItem,
  type SharedResourceLocation,
} from '@/services/sharedResourcesApi'
import { openSharedResourceTab } from '@/services/openSharedResource'
import { useSpaceStore } from '@stores/useSpaceStore'
import type { SpaceContextItem } from '@/services/spaceApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('SharedContextItems')

/** 分享条目在 metadata 上的标记：用于位置/分享来源渲染与点击/拖拽路由判定 */
interface ForeignSharedMeta {
  foreignShared: true
  sharedBy: { id: string; display_name: string; avatar: string } | null
  /** 资源真实归属（owner 的 workspace / organization），打开 tab 时回填 */
  sharedSpaceId: string
  sharedOrganizationId: string
  sharedResourceType: 'doc' | 'table' | 'file'
  sharedResourceId: string
  /** 后端按接收者目录权限裁剪后的原位置。 */
  sharedLocation: SharedResourceLocation | null
}

export function mapSharedToContextItem(
  shared: SharedResourceItem,
  collectionId: string | null = null,
): SpaceContextItem {
  const itemType =
    shared.resourceType === 'doc'
      ? 'tabdoc'
      : shared.resourceType === 'table'
        ? 'tabdata'
        : 'tabfiles'
  const meta: ForeignSharedMeta = {
    foreignShared: true,
    sharedBy: shared.sharedBy
      ? { id: shared.sharedBy.id, display_name: shared.sharedBy.displayName, avatar: shared.sharedBy.avatar }
      : null,
    sharedSpaceId: shared.spaceId,
    sharedOrganizationId: shared.organizationId,
    sharedResourceType: shared.resourceType,
    sharedResourceId: shared.resourceId,
    sharedLocation: shared.location,
  }
  return {
    id: `shared:${shared.resourceType}:${shared.resourceId}`,
    item_type: itemType,
    title: shared.title,
    preview: '',
    resource_id: shared.resourceId,
    space_id: shared.spaceId,
    metadata: meta,
    is_archived: false,
    is_pinned: false,
    collection_id: collectionId,
    can_move: true,
    // 分享人即资源真实所有者；owner 为正典字段，created_by 兼容旧列
    created_by: shared.sharedBy
      ? { id: shared.sharedBy.id, display_name: shared.sharedBy.displayName, avatar: shared.sharedBy.avatar }
      : null,
    owner_id: shared.sharedBy?.id ?? null,
    owner: shared.sharedBy
      ? { id: shared.sharedBy.id, display_name: shared.sharedBy.displayName, avatar: shared.sharedBy.avatar }
      : null,
    last_visited_at: null,
    updated_at: shared.updatedAt,
    created_at: null,
  }
}

/** 判断一个 context item 是否为「分享给我」并入的外部资源 */
export function isForeignSharedItem(item: Pick<SpaceContextItem, 'metadata'>): boolean {
  return Boolean((item.metadata as ForeignSharedMeta | undefined)?.foreignShared)
}

/** 取「由 xxx 分享」中的 xxx 展示名（owner display_name），缺省返回空串 */
export function getSharedByName(item: Pick<SpaceContextItem, 'metadata'>): string {
  return (item.metadata as ForeignSharedMeta | undefined)?.sharedBy?.display_name ?? ''
}

export function getSharedLocation(
  item: Pick<SpaceContextItem, 'metadata'>,
): SharedResourceLocation | null {
  return (item.metadata as ForeignSharedMeta | undefined)?.sharedLocation ?? null
}

export interface OpenForeignSharedItemOptions {
  /**
   * 标签落入的 UI scope。云文档侧栏必须传 `cloud-docs:…`，否则会默认落到
   * `desktop:…`，前台画布看不到 tab（用户体感「打不开」）。
   */
  tabScopeKey?: string
}

/** 在当前 host Space 打开一个「分享给我」资源 tab（按资源真实归属挂载） */
export function openForeignSharedItem(
  hostSpaceId: string,
  item: SpaceContextItem,
  options?: OpenForeignSharedItemOptions,
): void {
  const meta = item.metadata as ForeignSharedMeta | undefined
  if (!meta?.foreignShared) return
  openSharedResourceTab({
    hostSpaceId,
    resourceType: meta.sharedResourceType,
    resourceId: item.resource_id,
    resourceSpaceId: meta.sharedSpaceId,
    organizationId: meta.sharedOrganizationId,
    title: item.title,
    tabScopeKey: options?.tabScopeKey,
  })
}

interface UseSharedContextItemsResult {
  items: SpaceContextItem[]
  dismissedResourceKeys: ReadonlySet<string>
  loading: boolean
  error: boolean
  /** 手动重新拉取「分享给我」列表（失败态「重新加载」按钮） */
  reload: () => void
}

/**
 * 拉取当前 Space 所属 organization 下「分享给我」的资源，映射为 context item。
 *
 * @param spaceId 当前 Space（用于解析 organization）
 * @param enabled 关闭时不发请求（如 recent 模式 / 未就绪）
 */
export function useSharedContextItems(
  spaceId: string,
  enabled = true,
): UseSharedContextItemsResult {
  const organizationId = useSpaceStore(s => {
    const sp = s.spaces.find(x => x.id === spaceId)
    return sp?.organization_id ? String(sp.organization_id) : undefined
  })

  const [raw, setRaw] = useState<SharedResourceItem[]>([])
  const [dismissedResourceKeys, setDismissedResourceKeys] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => {
    setReloadToken(token => token + 1)
  }, [])

  useEffect(() => {
    if (!enabled || !organizationId) {
      setRaw([])
      setDismissedResourceKeys(new Set())
      setError(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(false)
    Promise.all([
      listSharedWithMe(organizationId),
      listSharedResourcePlacements(organizationId).catch(error => {
        log.warn('shared resource placements unavailable; using root placement', error)
        return []
      }),
    ])
      .then(([list, placements]) => {
        if (cancelled) return
        const collectionByResource = new Map(
          placements.map(placement => [
            `${placement.resourceType}:${placement.resourceId}`,
            placement,
          ]),
        )
        setDismissedResourceKeys(new Set(
          placements.filter(placement => placement.dismissed)
            .map(placement => `${placement.resourceType}:${placement.resourceId}`),
        ))
        setRaw(list.flatMap(item => {
          const placement = collectionByResource.get(`${item.resourceType}:${item.resourceId}`)
          if (placement?.dismissed) return []
          return [{ ...item, placementCollectionId: placement?.collectionId ?? null }]
        }))
      })
      .catch(() => { if (!cancelled) { setError(true); setRaw([]) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [enabled, organizationId, reloadToken])

  const items = useMemo(() => raw.map(item => mapSharedToContextItem(
    item,
    (item as SharedResourceItem & { placementCollectionId?: string | null }).placementCollectionId ?? null,
  )), [raw])

  return { items, dismissedResourceKeys, loading, error, reload }
}
