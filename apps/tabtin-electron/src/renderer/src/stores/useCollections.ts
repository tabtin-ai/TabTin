/** @store-category domain */

/**
 * Collection Store — 文件夹的前端状态管理
 *
 * 数据来源: GET /context/workspaces/{id}/collections（返回树形结构）
 * 实时更新: WS topic context.sync.{spaceId}（collection_* 事件）
 */
import { useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { SpaceApiService } from '@/services/spaceApi'
import type { SpaceCollection, SpaceContextItem } from '@/services/spaceApi'
import { useUnifiedResources } from './useUnifiedResources'
import { useSpaceStore } from './useSpaceStore'
import { registerResetAction } from './sessionResetRegistry'
import { createLogger } from '@/utils/logger'

const log = createLogger('Collections')

interface CollectionsState {
  currentSpaceId: string | null
  collections: SpaceCollection[]
  isLoading: boolean
  error: string | null
  collectionsBySpaceId: Record<string, SpaceCollection[]>
  loadingBySpaceId: Record<string, boolean>
  errorBySpaceId: Record<string, string | null>

  // ：Organization Collection（组织级文件夹）独立缓存桶，不投影到上面的
  // currentSpaceId/collections 单例字段——云盘/云文档按 organizationId 直接读取。
  collectionsByOrganizationId: Record<string, SpaceCollection[]>
  loadingByOrganizationId: Record<string, boolean>
  errorByOrganizationId: Record<string, string | null>

  load: (spaceId: string, force?: boolean) => Promise<void>
  setCurrentSpace: (spaceId: string | null) => void
  getCollections: (spaceId: string | null | undefined) => SpaceCollection[]
  getLoadState: (spaceId: string | null | undefined) => {
    collections: SpaceCollection[]
    isLoading: boolean
    error: string | null
  }
  clear: (spaceId?: string | null) => void
  /** ：切组织时剔除指定 org 的组织级文件夹缓存 */
  clearOrganization: (organizationId: string) => void

  createCollection: (spaceId: string, name: string, icon?: string, parentId?: string | null) => Promise<SpaceCollection>
  updateCollection: (collectionId: string, data: { name?: string; parent_id?: string | null; icon?: string; color?: string; is_expanded?: boolean; is_pinned?: boolean }) => Promise<void>
  deleteCollection: (collectionId: string) => Promise<void>
  reorderCollections: (
    spaceId: string,
    collectionIds: string[],
    parentId?: string | null,
  ) => Promise<void>
  reorderItems: (
    spaceId: string,
    itemIds: string[],
    collectionId?: string | null,
  ) => Promise<number>

  moveItems: (spaceId: string, itemIds: string[], collectionId?: string | null) => Promise<number>

  // ── Organization Collection──
  loadOrganization: (organizationId: string, force?: boolean) => Promise<void>
  getOrganizationCollections: (organizationId: string | null | undefined) => SpaceCollection[]
  getOrganizationLoadState: (organizationId: string | null | undefined) => {
    collections: SpaceCollection[]
    isLoading: boolean
    error: string | null
  }
  createOrganizationCollection: (
    organizationId: string,
    name: string,
    icon?: string,
    parentId?: string | null,
  ) => Promise<SpaceCollection>
  reorderOrganizationCollections: (organizationId: string, collectionIds: string[]) => Promise<void>
  moveItemsOrganization: (
    organizationId: string,
    itemIds: string[],
    collectionId?: string | null,
  ) => Promise<number>

  handleWsEvent: (event: {
    type: string
    space_id?: string | null
    organization_id?: string | null
    [key: string]: any
  }) => void
}

const EMPTY_COLLECTIONS: SpaceCollection[] = []

function getSpaceCollections(
  state: Pick<CollectionsState, 'collectionsBySpaceId'>,
  spaceId: string | null | undefined,
): SpaceCollection[] {
  if (!spaceId) return EMPTY_COLLECTIONS
  return state.collectionsBySpaceId[spaceId] ?? EMPTY_COLLECTIONS
}

function getOrganizationCollectionsFromState(
  state: Pick<CollectionsState, 'collectionsByOrganizationId'>,
  organizationId: string | null | undefined,
): SpaceCollection[] {
  if (!organizationId) return EMPTY_COLLECTIONS
  return state.collectionsByOrganizationId[organizationId] ?? EMPTY_COLLECTIONS
}

function getOrganizationLoadStateFromState(
  state: Pick<
    CollectionsState,
    'collectionsByOrganizationId' | 'loadingByOrganizationId' | 'errorByOrganizationId'
  >,
  organizationId: string | null | undefined,
) {
  return {
    collections: getOrganizationCollectionsFromState(state, organizationId),
    isLoading: organizationId ? Boolean(state.loadingByOrganizationId[organizationId]) : false,
    error: organizationId ? state.errorByOrganizationId[organizationId] ?? null : null,
  }
}

function getSpaceLoadState(
  state: Pick<
    CollectionsState,
    'collectionsBySpaceId' | 'loadingBySpaceId' | 'errorBySpaceId'
  >,
  spaceId: string | null | undefined,
) {
  return {
    collections: getSpaceCollections(state, spaceId),
    isLoading: spaceId ? Boolean(state.loadingBySpaceId[spaceId]) : false,
    error: spaceId ? state.errorBySpaceId[spaceId] ?? null : null,
  }
}

function withCurrentSpaceProjection(
  state: CollectionsState,
  spaceId: string | null,
): Partial<CollectionsState> {
  if (!spaceId) {
    return {
      currentSpaceId: null,
      collections: EMPTY_COLLECTIONS,
      isLoading: false,
      error: null,
    }
  }
  const slice = getSpaceLoadState(state, spaceId)
  return {
    currentSpaceId: spaceId,
    collections: slice.collections,
    isLoading: slice.isLoading,
    error: slice.error,
  }
}

function projectCurrentSpaceIfNeeded(
  draft: Partial<CollectionsState>,
  state: CollectionsState,
  targetSpaceId: string,
) {
  const projectedCurrentSpaceId = draft.currentSpaceId ?? state.currentSpaceId
  if (projectedCurrentSpaceId !== targetSpaceId) return draft
  const collectionsBySpaceId = draft.collectionsBySpaceId ?? state.collectionsBySpaceId
  const loadingBySpaceId = draft.loadingBySpaceId ?? state.loadingBySpaceId
  const errorBySpaceId = draft.errorBySpaceId ?? state.errorBySpaceId
  return {
    ...draft,
    currentSpaceId: projectedCurrentSpaceId,
    collections: collectionsBySpaceId[targetSpaceId] ?? EMPTY_COLLECTIONS,
    isLoading: loadingBySpaceId[targetSpaceId] ?? false,
    error: errorBySpaceId[targetSpaceId] ?? null,
  }
}

/** 在树中递归查找 collection 所在的 spaceId */
function findSpaceIdByCollectionId(
  state: Pick<CollectionsState, 'collectionsBySpaceId'>,
  collectionId: string,
): string | null {
  function findInTree(nodes: SpaceCollection[]): boolean {
    for (const node of nodes) {
      if (node.id === collectionId) return true
      if (node.children?.length && findInTree(node.children)) return true
    }
    return false
  }
  for (const [spaceId, collections] of Object.entries(state.collectionsBySpaceId)) {
    if (findInTree(collections)) return spaceId
  }
  return null
}

/** 在 Organization Collection 树中递归查找 collection 所在的 organizationId。 */
function findOrganizationIdByCollectionId(
  state: Pick<CollectionsState, 'collectionsByOrganizationId'>,
  collectionId: string,
): string | null {
  function findInTree(nodes: SpaceCollection[]): boolean {
    for (const node of nodes) {
      if (node.id === collectionId) return true
      if (node.children?.length && findInTree(node.children)) return true
    }
    return false
  }
  for (const [organizationId, collections] of Object.entries(state.collectionsByOrganizationId)) {
    if (findInTree(collections)) return organizationId
  }
  return null
}

function findCollectionById(nodes: SpaceCollection[], collectionId: string): SpaceCollection | null {
  for (const node of nodes) {
    if (node.id === collectionId) return node
    const child = findCollectionById(node.children ?? [], collectionId)
    if (child) return child
  }
  return null
}

function collectCollectionTreeIds(collection: SpaceCollection | null | undefined): Set<string> {
  if (!collection) return new Set()
  const ids = new Set<string>([collection.id])
  for (const child of collection.children ?? []) {
    for (const id of collectCollectionTreeIds(child)) ids.add(id)
  }
  return ids
}

function resourcesInCollectionTree(spaceId: string | null, collectionIds: Set<string>): SpaceContextItem[] {
  if (!spaceId || collectionIds.size === 0) return []
  return useUnifiedResources
    .getState()
    .getResources(spaceId)
    .filter(resource => Boolean(resource.collection_id && collectionIds.has(resource.collection_id)))
}

async function moveResourcesToTrash(
  resources: SpaceContextItem[],
  fallbackOrganizationId?: string | null,
) {
  if (resources.length === 0) return
  const results = await Promise.allSettled(
    resources.map(async (resource) => {
      // ：与云盘批删对齐，缺 organization_id 时回填，避免 file/tabfiles silent archive
      const organizationId = resource.organization_id ?? fallbackOrganizationId ?? null
      const movedToTrash = await SpaceApiService.trashContextResource({
        ...resource,
        organization_id: organizationId,
      })
      if (!movedToTrash) await SpaceApiService.archiveContextItem(resource.id)
    }),
  )
  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length > 0) {
    log.warn('failed to move collection resources to trash', {
      failed: failed.length,
      total: resources.length,
    })
  }
}

/** 递归统计树中所有节点数 */
function countAllNodes(nodes: SpaceCollection[]): number {
  let count = nodes.length
  for (const node of nodes) {
    if (node.children?.length) count += countAllNodes(node.children)
  }
  return count
}

export const useCollections = create<CollectionsState>((set, get) => ({
  currentSpaceId: null,
  collections: EMPTY_COLLECTIONS,
  isLoading: false,
  error: null,
  collectionsBySpaceId: {},
  loadingBySpaceId: {},
  errorBySpaceId: {},
  collectionsByOrganizationId: {},
  loadingByOrganizationId: {},
  errorByOrganizationId: {},

  load: async (spaceId: string, force = false) => {
    const state = get()
    const cached = getSpaceCollections(state, spaceId)
    if (!force && countAllNodes(cached) > 0) return

    set(prev => projectCurrentSpaceIfNeeded({
      currentSpaceId: spaceId,
      loadingBySpaceId: {
        ...prev.loadingBySpaceId,
        [spaceId]: true,
      },
      errorBySpaceId: {
        ...prev.errorBySpaceId,
        [spaceId]: null,
      },
    }, prev, spaceId))
    try {
      const resp = await SpaceApiService.listCollections(spaceId)
      set(prev => projectCurrentSpaceIfNeeded({
        collectionsBySpaceId: {
          ...prev.collectionsBySpaceId,
          [spaceId]: resp.collections,
        },
        loadingBySpaceId: {
          ...prev.loadingBySpaceId,
          [spaceId]: false,
        },
        errorBySpaceId: {
          ...prev.errorBySpaceId,
          [spaceId]: null,
        },
      }, prev, spaceId))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('load collections failed:', { spaceId, error: err })
      set(prev => projectCurrentSpaceIfNeeded({
        loadingBySpaceId: {
          ...prev.loadingBySpaceId,
          [spaceId]: false,
        },
        errorBySpaceId: {
          ...prev.errorBySpaceId,
          [spaceId]: msg,
        },
      }, prev, spaceId))
    }
  },

  setCurrentSpace: (spaceId) => {
    set(state => withCurrentSpaceProjection(state, spaceId))
  },

  getCollections: (spaceId) => getSpaceCollections(get(), spaceId),

  getLoadState: (spaceId) => getSpaceLoadState(get(), spaceId),

  clear: (spaceId) => {
    if (!spaceId) {
      set({
        currentSpaceId: null,
        collections: EMPTY_COLLECTIONS,
        isLoading: false,
        error: null,
        collectionsBySpaceId: {},
        loadingBySpaceId: {},
        errorBySpaceId: {},
        collectionsByOrganizationId: {},
        loadingByOrganizationId: {},
        errorByOrganizationId: {},
      })
      return
    }

    set(prev => {
      const { [spaceId]: _removedCollections, ...restCollections } = prev.collectionsBySpaceId
      const { [spaceId]: _removedLoading, ...restLoading } = prev.loadingBySpaceId
      const { [spaceId]: _removedError, ...restErrors } = prev.errorBySpaceId
      if (prev.currentSpaceId === spaceId) {
        return {
          collectionsBySpaceId: restCollections,
          loadingBySpaceId: restLoading,
          errorBySpaceId: restErrors,
          ...withCurrentSpaceProjection(
            {
              ...prev,
              collectionsBySpaceId: restCollections,
              loadingBySpaceId: restLoading,
              errorBySpaceId: restErrors,
            },
            null,
          ),
        }
      }
      return {
        collectionsBySpaceId: restCollections,
        loadingBySpaceId: restLoading,
        errorBySpaceId: restErrors,
      }
    })
  },

  clearOrganization: (organizationId) => {
    if (!organizationId) return
    set(prev => {
      if (!(organizationId in prev.collectionsByOrganizationId)
        && !(organizationId in prev.loadingByOrganizationId)
        && !(organizationId in prev.errorByOrganizationId)) {
        return prev
      }
      const {
        [organizationId]: _removedCollections,
        ...restCollections
      } = prev.collectionsByOrganizationId
      const {
        [organizationId]: _removedLoading,
        ...restLoading
      } = prev.loadingByOrganizationId
      const {
        [organizationId]: _removedError,
        ...restErrors
      } = prev.errorByOrganizationId
      return {
        collectionsByOrganizationId: restCollections,
        loadingByOrganizationId: restLoading,
        errorByOrganizationId: restErrors,
      }
    })
  },

  createCollection: async (spaceId, name, icon, parentId) => {
    const coll = await SpaceApiService.createCollection(spaceId, { name, icon, parent_id: parentId })
    void get().load(spaceId, true)
    return coll
  },

  updateCollection: async (collectionId, data) => {
    await SpaceApiService.updateCollection(collectionId, data)
    const spaceId = findSpaceIdByCollectionId(get(), collectionId)
    if (spaceId) void get().load(spaceId, true)
    const organizationId = findOrganizationIdByCollectionId(get(), collectionId)
    if (organizationId) void get().loadOrganization(organizationId, true)
  },

  deleteCollection: async (collectionId) => {
    const state = get()
    const spaceId = findSpaceIdByCollectionId(state, collectionId)
    const organizationId = spaceId ? null : findOrganizationIdByCollectionId(state, collectionId)
    const collectionTreeIds = collectCollectionTreeIds(
      spaceId
        ? findCollectionById(getSpaceCollections(state, spaceId), collectionId)
        : organizationId
          ? findCollectionById(getOrganizationCollectionsFromState(state, organizationId), collectionId)
          : null,
    )
    const resourcesToTrash = resourcesInCollectionTree(spaceId, collectionTreeIds)
    await SpaceApiService.deleteCollection(collectionId)
    const spaceOrgId = spaceId
      ? useSpaceStore.getState().spaces.find(s => s.id === spaceId)?.organization_id
      : null
    await moveResourcesToTrash(
      resourcesToTrash,
      organizationId ?? (spaceOrgId ? String(spaceOrgId) : null),
    )
    if (spaceId) void get().load(spaceId, true)
    if (spaceId) void useUnifiedResources.getState().load(spaceId, true)
    if (organizationId) void get().loadOrganization(organizationId, true)
  },

  reorderCollections: async (spaceId, collectionIds, parentId) => {
    await SpaceApiService.reorderCollections(spaceId, collectionIds, parentId)
    void get().load(spaceId, true)
  },

  reorderItems: async (spaceId, itemIds, collectionId) => {
    const result = await SpaceApiService.reorderCollectionItems(spaceId, {
      item_ids: itemIds,
      collection_id: collectionId ?? null,
    })
    const updated = Number(result?.updated ?? 0)
    if (!Number.isFinite(updated) || updated <= 0) {
      throw new Error('REORDER_DENIED: 未能重排所选资源')
    }
    return updated
  },

  moveItems: async (spaceId, itemIds, collectionId) => {
    const result = await SpaceApiService.moveItemsToCollection(spaceId, {
      item_ids: itemIds,
      collection_id: collectionId,
    })
    const updated = Number(result?.updated ?? 0)
    // ：后端曾对 org-only / 无权限返回 updated=0 仍 200；禁止前端假成功
    if (!Number.isFinite(updated) || updated <= 0) {
      throw new Error('MOVE_DENIED: 未能移动所选资源')
    }
    // ：move 成功后立刻重载文件夹树，刷新 item_count（勿只等 WS）
    void get().load(spaceId, true)
    return updated
  },

  // ── Organization Collection──

  loadOrganization: async (organizationId: string, force = false) => {
    const state = get()
    const cached = getOrganizationCollectionsFromState(state, organizationId)
    if (!force && countAllNodes(cached) > 0) return

    set(prev => ({
      loadingByOrganizationId: { ...prev.loadingByOrganizationId, [organizationId]: true },
      errorByOrganizationId: { ...prev.errorByOrganizationId, [organizationId]: null },
    }))
    try {
      const resp = await SpaceApiService.listOrganizationCollections(organizationId)
      set(prev => ({
        collectionsByOrganizationId: {
          ...prev.collectionsByOrganizationId,
          [organizationId]: resp.collections,
        },
        loadingByOrganizationId: { ...prev.loadingByOrganizationId, [organizationId]: false },
        errorByOrganizationId: { ...prev.errorByOrganizationId, [organizationId]: null },
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('load organization collections failed:', { organizationId, error: err })
      set(prev => ({
        loadingByOrganizationId: { ...prev.loadingByOrganizationId, [organizationId]: false },
        errorByOrganizationId: { ...prev.errorByOrganizationId, [organizationId]: msg },
      }))
    }
  },

  getOrganizationCollections: (organizationId) => getOrganizationCollectionsFromState(get(), organizationId),

  getOrganizationLoadState: (organizationId) => getOrganizationLoadStateFromState(get(), organizationId),

  createOrganizationCollection: async (organizationId, name, icon, parentId) => {
    const coll = await SpaceApiService.createOrganizationCollection(organizationId, { name, icon, parent_id: parentId })
    void get().loadOrganization(organizationId, true)
    return coll
  },

  reorderOrganizationCollections: async (organizationId, collectionIds) => {
    await SpaceApiService.reorderOrganizationCollections(organizationId, collectionIds)
    void get().loadOrganization(organizationId, true)
  },

  moveItemsOrganization: async (organizationId, itemIds, collectionId) => {
    const result = await SpaceApiService.moveItemsToOrganizationCollection(organizationId, {
      item_ids: itemIds,
      collection_id: collectionId,
    })
    const updated = Number(result?.updated ?? 0)
    if (!Number.isFinite(updated) || updated <= 0) {
      throw new Error('MOVE_DENIED: 未能移动所选资源')
    }
    // ：云盘 org 文件夹数量依赖 org 桶；本地 move 后立即重载
    void get().loadOrganization(organizationId, true)
    return updated
  },

  handleWsEvent: (event) => {
    const eventType = event.type
    const isCollectionEvent =
      eventType.startsWith('collection_') ||
      eventType === 'collections_reordered' ||
      eventType === 'items_moved' ||
      eventType === 'items_reordered'
    if (!isCollectionEvent) return

    const state = get()
    const spaceId = event.space_id ?? null
    const organizationId = event.organization_id ?? null

    if (spaceId) {
      const hasBucket = Boolean(state.collectionsBySpaceId[spaceId])
      if (hasBucket || spaceId === state.currentSpaceId) {
        void get().load(spaceId, true)
      }
    }

    //  /  / ：space 桶与 org 桶独立；带 organization_id 时强制刷 org 树
    // （含 item_count / collection_created）。不要求桶已存在——CLI 建夹时云盘可能尚未 mount。
    if (organizationId) {
      log.info('organization collections refresh', {
        source: 'ws',
        organizationId,
        eventType,
      })
      void get().loadOrganization(organizationId, true)
    }
  },
}))

export function useCollectionsBySpace(spaceId: string | null | undefined) {
  const collections = useCollections(
    useCallback(state => getSpaceCollections(state, spaceId), [spaceId]),
  )
  const isLoading = useCollections(
    useCallback(state => (spaceId ? Boolean(state.loadingBySpaceId[spaceId]) : false), [spaceId]),
  )
  const error = useCollections(
    useCallback(state => (spaceId ? state.errorBySpaceId[spaceId] ?? null : null), [spaceId]),
  )

  return {
    collections,
    isLoading,
    error,
  }
}

/** ：按 organizationId 读取 Organization Collection（组织级文件夹）树。 */
export function useCollectionsByOrganization(organizationId: string | null | undefined) {
  const collections = useCollections(
    useCallback(state => getOrganizationCollectionsFromState(state, organizationId), [organizationId]),
  )
  const isLoading = useCollections(
    useCallback(
      state => (organizationId ? Boolean(state.loadingByOrganizationId[organizationId]) : false),
      [organizationId],
    ),
  )
  const error = useCollections(
    useCallback(
      state => (organizationId ? state.errorByOrganizationId[organizationId] ?? null : null),
      [organizationId],
    ),
  )

  return {
    collections,
    isLoading,
    error,
  }
}

/** 递归遍历树，返回所有节点的扁平数组 */
export function flattenCollections(nodes: SpaceCollection[]): SpaceCollection[] {
  const result: SpaceCollection[] = []
  function walk(items: SpaceCollection[]) {
    for (const item of items) {
      result.push(item)
      if (item.children?.length) walk(item.children)
    }
  }
  walk(nodes)
  return result
}

export function findCollectionPathInTree(nodes: SpaceCollection[], id: string): SpaceCollection[] {
  function walk(arr: SpaceCollection[], stack: SpaceCollection[]): SpaceCollection[] | null {
    for (const n of arr) {
      const next = [...stack, n]
      if (n.id === id) return next
      if (n.children?.length) {
        const r = walk(n.children, next)
        if (r) return r
      }
    }
    return null
  }
  return walk(nodes, []) ?? []
}

function compareCollectionsPinnedFirst(a: SpaceCollection, b: SpaceCollection): number {
  const aPinned = a.is_pinned ? 1 : 0
  const bPinned = b.is_pinned ? 1 : 0
  if (aPinned !== bPinned) return bPinned - aPinned
  if (aPinned && bPinned) {
    const aPinnedAt = a.pinned_at ? Date.parse(a.pinned_at) : 0
    const bPinnedAt = b.pinned_at ? Date.parse(b.pinned_at) : 0
    if (aPinnedAt !== bPinnedAt) return bPinnedAt - aPinnedAt
  }
  return a.order - b.order
}

export function getCollectionChildrenSorted(
  nodes: SpaceCollection[],
  parentId: string | null,
): SpaceCollection[] {
  if (parentId === null) {
    return [...nodes].sort(compareCollectionsPinnedFirst)
  }
  const chain = findCollectionPathInTree(nodes, parentId)
  const parent = chain[chain.length - 1]
  if (!parent?.children?.length) return []
  return [...parent.children].sort(compareCollectionsPinnedFirst)
}

export type FolderBreadcrumbSegment = { id: string | null; name: string }

export function useFolderBreadcrumb(
  folderId: string | null | undefined,
  collections: SpaceCollection[],
  rootLabel: string,
): FolderBreadcrumbSegment[] {
  return useMemo(() => {
    const segments: FolderBreadcrumbSegment[] = [{ id: null, name: rootLabel }]
    if (!folderId) return segments
    const chain = findCollectionPathInTree(collections, folderId)
    for (const n of chain) {
      segments.push({ id: n.id, name: n.name })
    }
    return segments
  }, [folderId, collections, rootLabel])
}

registerResetAction('collections', 'reset', () => useCollections.getState().clear())
