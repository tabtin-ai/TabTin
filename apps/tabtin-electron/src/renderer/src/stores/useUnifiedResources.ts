/** @store-category domain */

/**
 * 统一资源 Store
 *
 * 所有 Space 资源（TabData, TabDoc, TabSlide 等）的唯一数据源。
 * 数据来源: GET /context/workspaces/{id}/context-items（Project 宿主走 /projects/...）
 * 实时更新:
 * - Space 视图: `context.sync.{spaceId}`
 * - Organization 聚合视图: `context.sync.organization.{organizationId}`
 */
import { useCallback } from 'react'
import { create } from 'zustand'
import { SpaceApiService, type SpaceContextItem as ContextItem } from '@/services/spaceApi'
import { contextRegistry } from '@/components/context-space/registry/instance'
import { useCanvasLayoutStore } from './useCanvasLayoutStore'
import { useSpaceContextTabsStore } from './useSpaceContextTabsStore'
import { useSpaceStore } from './useSpaceStore'
import { useKnowledgeTree } from './useKnowledgeTree'
import { createLogger } from '@/utils/logger'
import { isLoadableResourceHostSpaceId } from '@components/layout/cloud-docs/cloudDocsHostSpace'

const log = createLogger('UnifiedResources')

type ResourceBucketScope = 'space' | 'organization'

interface ResourceBucketMeta {
  cacheKey: string
  scope: ResourceBucketScope
  spaceId: string
  organizationId?: string | null
}

interface StructuralResourceWsEvent {
  type: string
  space_id: string
  organization_id?: string | null
  collection_id?: string | null
  collection_ids?: string[]
}

interface UnifiedResourcesState {
  /** 当前加载的 Space ID */
  currentSpaceId: string | null
  /** 当前 Space 的 legacy 投影视图（仅镜像 space bucket，用于兼容旧调用方） */
  resources: ContextItem[]
  /** 当前 Space 的 legacy 投影是否正在加载 */
  isLoading: boolean
  /** 当前 Space 的 legacy 投影错误 */
  error: string | null
  /** 按 cacheKey 分桶的资源缓存 */
  resourcesBySpaceId: Record<string, ContextItem[]>
  loadingBySpaceId: Record<string, boolean>
  errorBySpaceId: Record<string, string | null>
  bucketMetaByCacheKey: Record<string, ResourceBucketMeta>

  /** 按 resource_id 查找 */
  getByResourceId: (resourceId: string, spaceId?: string | null) => ContextItem | undefined
  getResources: (spaceId: string | null | undefined) => ContextItem[]
  getLoadState: (spaceId: string | null | undefined) => {
    resources: ContextItem[]
    isLoading: boolean
    error: string | null
  }

  /** 加载指定 bucket（如果已加载同一 bucket 则跳过） */
  load: (spaceId: string, force?: boolean, scope?: ResourceBucketScope) => Promise<void>
  setCurrentSpace: (spaceId: string | null) => void
  /** 处理资源级 WS 事件 */
  handleWsEvent: (event: ResourceWsEvent) => void
  /** 处理影响资源 bucket 的结构事件（items_moved / delete collection / delete section） */
  handleStructuralEvent: (event: StructuralResourceWsEvent) => void
  /**
   * 乐观回写 per-user last_visited_at。
   * 按 ContextItem.id 扫全部 bucket；未命中则 no-op。
   */
  touchLastVisitedAt: (itemId: string, visitedAt?: string) => void
  /** 清空 */
  clear: (spaceId?: string | null) => void
  /**
   * ：切组织时按 organizationId 剔除资源桶，避免新组织面板闪旧 org 列表。
   * 不碰其它组织的桶（Wave 3 切回可秒开）。
   */
  clearOrganizationBuckets: (organizationId: string) => void
}

export interface ResourceWsEvent {
  type: string // resource_created | resource_updated | resource_archived | resource_trashed | resource_deleted | resource_restored | resource_access_granted | resource_access_changed | resource_access_revoked
  resource_type: string
  resource_id: string
  title?: string
  space_id: string
  organization_id?: string | null
  user_id?: string | null
  metadata?: Record<string, unknown> | null
  status?: string
  preview?: string
  updated_at?: string | null
  is_pinned?: boolean
  pinned_at?: string | null
  collection_id?: string | null
  /** ContextItem UUID；WS 乐观插入应优先使用，避免空 id 导致无法拖拽进文件夹 */
  context_item_id?: string | null
}

type ResourceEventListener = (event: ResourceWsEvent) => void

const eventListenersByType = new Map<string, Set<ResourceEventListener>>()
const scheduledReloads = new Map<string, ReturnType<typeof setTimeout>>()
/** 按 cacheKey 递增；并发 load 时只采纳最新一代的响应，避免旧请求覆盖新数据 */
const loadGenerationByCacheKey = new Map<string, number>()
const RESOURCE_PAGE_SIZE = 500
const STRUCTURAL_RELOAD_EVENT_TYPES = new Set([
  'items_moved',
  'collection_deleted',
])
const RESOURCE_REMOVAL_EVENT_TYPES = new Set([
  'resource_archived',
  'resource_trashed',
  'resource_deleted',
  'resource_access_revoked',
])
const RESOURCE_TAB_CLOSE_EVENT_TYPES = new Set([
  'resource_archived',
  'resource_trashed',
  'resource_deleted',
])

/** 知识树仅收录文档/表格；资源事件须在云文档面板未挂载时也能收敛缓存。 */
const KNOWLEDGE_TREE_RESOURCE_TYPES = new Set(['tabdoc', 'tabdata'])
const KNOWLEDGE_TREE_REMOVAL_EVENT_TYPES = new Set([
  'resource_archived',
  'resource_trashed',
  'resource_deleted',
  'resource_access_revoked',
])

/**
 * 模块级同步知识树，不依赖 CloudDocs 组件 / onResourceEvent 订阅生命周期。
 * 删除/撤权必须立即移除；创建/恢复等结构事件由已挂载面板防抖刷新，
 * 未挂载时则在下次进入云文档时 force reload，避免事件突发触发无界请求。
 */
function syncKnowledgeTreeFromResourceEvent(
  event: ResourceWsEvent,
  organizationId: string | null | undefined,
): void {
  if (!organizationId) return
  if (!KNOWLEDGE_TREE_RESOURCE_TYPES.has(event.resource_type)) return
  const tree = useKnowledgeTree.getState()

  if (KNOWLEDGE_TREE_REMOVAL_EVENT_TYPES.has(event.type)) {
    tree.removeNodeAndPromoteChildren(organizationId, event.resource_id)
    return
  }
  if (event.type === 'resource_updated') {
    tree.patchNodeMeta(organizationId, {
      resourceId: event.resource_id,
      title: event.title,
      updatedAt: event.updated_at,
    })
  }
}

function removeResourceFromAllBuckets(
  resourcesBySpaceId: Record<string, ContextItem[]>,
  resourceId: string,
): Record<string, ContextItem[]> {
  const next: Record<string, ContextItem[]> = { ...resourcesBySpaceId }
  for (const [cacheKey, list] of Object.entries(resourcesBySpaceId)) {
    const filtered = list.filter((resource) => resource.resource_id !== resourceId)
    if (filtered.length !== list.length) {
      next[cacheKey] = filtered
    }
  }
  return next
}

export const EMPTY_RESOURCES: ContextItem[] = []

function isNewerResourceUpdatedAt(
  nextUpdatedAt: string,
  currentUpdatedAt: string | null | undefined,
): boolean {
  if (!currentUpdatedAt) return true
  const nextTime = Date.parse(nextUpdatedAt)
  const currentTime = Date.parse(currentUpdatedAt)
  if (!Number.isFinite(nextTime) || !Number.isFinite(currentTime)) {
    return nextUpdatedAt !== currentUpdatedAt
  }
  return nextTime > currentTime
}

function isStaleResourceUpdate(event: ResourceWsEvent, resource: ContextItem): boolean {
  return typeof event.updated_at === 'string'
    && !isNewerResourceUpdatedAt(event.updated_at, resource.updated_at)
}

/** ContextItem UUID 未就绪：空串或 local: 乐观前缀 → 不可拖拽 / 不可 moveItems。 */
export function isUnsyncedContextItemId(id: string | null | undefined): boolean {
  return !id || id.startsWith('local:')
}

/**
 * 可写入 ResourceAccess 的真实 ContextItem id。
 * 排除空 / local: / shared: 合成 id（分享并入项不是后端 ContextItem UUID）。
 */
export function isRecordableContextItemId(id: string | null | undefined): boolean {
  return Boolean(id) && !isUnsyncedContextItemId(id) && !id!.startsWith('shared:')
}

function applyResourceUpdatedEvent(resources: ContextItem[], event: ResourceWsEvent): ContextItem[] {
  let didUpdate = false
  const nextResources = resources.map((resource) => {
    if (resource.resource_id !== event.resource_id) return resource
    if (isStaleResourceUpdate(event, resource)) return resource
    const contextItemId = typeof event.context_item_id === 'string' ? event.context_item_id.trim() : ''
    // 空 id 乐观项：WS updated 若带 context_item_id，就地回填，不必等整桶 reload
    const shouldBackfillId = Boolean(contextItemId) && isUnsyncedContextItemId(resource.id)
    didUpdate = true
    return {
      ...resource,
      ...(shouldBackfillId ? { id: contextItemId } : {}),
      title: event.title !== undefined ? event.title : resource.title,
      updated_at: event.updated_at || new Date().toISOString(),
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
      ...(event.preview !== undefined ? { preview: event.preview } : {}),
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.is_pinned !== undefined ? { is_pinned: event.is_pinned } : {}),
      ...(event.pinned_at !== undefined ? { pinned_at: event.pinned_at } : {}),
      ...(event.collection_id !== undefined ? { collection_id: event.collection_id } : {}),
    }
  })
  return didUpdate ? nextResources : resources
}

function applyResourceUpdatedEventToCachedBuckets(
  state: Pick<UnifiedResourcesState, 'resourcesBySpaceId'>,
  event: ResourceWsEvent,
): Record<string, ContextItem[]> {
  let didUpdate = false
  const nextBuckets: Record<string, ContextItem[]> = {}

  for (const [cacheKey, resources] of Object.entries(state.resourcesBySpaceId)) {
    const nextResources = applyResourceUpdatedEvent(resources, event)
    nextBuckets[cacheKey] = nextResources
    if (nextResources !== resources) {
      didUpdate = true
    }
  }

  return didUpdate ? nextBuckets : state.resourcesBySpaceId
}

function removeCollectionResourcesFromCachedBuckets(
  state: Pick<UnifiedResourcesState, 'resourcesBySpaceId'>,
  collectionIds: Set<string>,
): Record<string, ContextItem[]> {
  if (collectionIds.size === 0) return state.resourcesBySpaceId

  let didUpdate = false
  const nextBuckets: Record<string, ContextItem[]> = {}
  for (const [cacheKey, resources] of Object.entries(state.resourcesBySpaceId)) {
    const nextResources = resources.filter(resource => !(
      resource.collection_id && collectionIds.has(resource.collection_id)
    ))
    nextBuckets[cacheKey] = nextResources
    if (nextResources.length !== resources.length) {
      didUpdate = true
    }
  }
  return didUpdate ? nextBuckets : state.resourcesBySpaceId
}

export function getResourceCacheKey(
  spaceId: string | null | undefined,
  scope: ResourceBucketScope = 'space',
): string | null {
  if (!spaceId) return null
  return scope === 'organization' ? `${spaceId}:organization` : spaceId
}

function resolveOrganizationIdForSpace(spaceId: string | null | undefined): string | null {
  if (!spaceId) return null
  const space = useSpaceStore.getState().spaces.find(item => item.id === spaceId)
  return typeof space?.organization_id === 'string' ? space.organization_id : null
}

function normalizeContextItems(items: ContextItem[]): ContextItem[] {
  return items.map(item => {
    const itemType = contextRegistry.normalizeBackendType(item.item_type)
    if (itemType !== 'tabfiles') return { ...item, item_type: itemType }
    // 云端文件预览需要 ContextItem ID 换取短期下载 URL；旧接口有时只返回
    // resource_id，导致导入后首次打开被误判为“文件已删除”。
    const metadata = { ...(item.metadata ?? {}) }
    if (typeof metadata.context_item_id !== 'string') metadata.context_item_id = item.id
    if (typeof metadata.resource_id !== 'string') metadata.resource_id = item.resource_id
    if (typeof item.organization_id === 'string') {
      if (typeof metadata.organization_id !== 'string') metadata.organization_id = item.organization_id
      if (typeof metadata.organizationId !== 'string') metadata.organizationId = item.organization_id
    }
    return { ...item, item_type: itemType, metadata }
  })
}

async function fetchAllContextItems(
  spaceId: string,
  scope: ResourceBucketScope,
): Promise<ContextItem[]> {
  const mergedItems: ContextItem[] = []
  const seenIds = new Set<string>()
  let page = 1
  let total = 0

  while (true) {
    const resp = await SpaceApiService.listContextItems(spaceId, {
      is_archived: false,
      page,
      page_size: RESOURCE_PAGE_SIZE,
      ...(scope === 'organization' ? { scope: 'organization' } : {}),
    })
    const pageItems = normalizeContextItems(resp.items)
    for (const item of pageItems) {
      const dedupeKey = item.id || `${item.item_type}:${item.resource_id}`
      if (seenIds.has(dedupeKey)) continue
      seenIds.add(dedupeKey)
      mergedItems.push(item)
    }

    total = typeof resp.total === 'number' ? resp.total : mergedItems.length
    const currentPageSize = resp.page_size ?? RESOURCE_PAGE_SIZE
    if (pageItems.length === 0) break
    if (mergedItems.length >= total) break
    if (pageItems.length < currentPageSize) break
    page += 1
  }

  return mergedItems
}

function clearScheduledReload(cacheKey: string | null | undefined) {
  if (!cacheKey) return
  const timer = scheduledReloads.get(cacheKey)
  if (!timer) return
  clearTimeout(timer)
  scheduledReloads.delete(cacheKey)
}

/** 取消指定 Space 的 space/organization 延迟 reload（批量导入结束前调用，避免中间态覆盖） */
export function cancelPendingResourceReloads(spaceId: string | null | undefined): void {
  if (!spaceId) return
  clearScheduledReload(spaceId)
  clearScheduledReload(getResourceCacheKey(spaceId, 'organization'))
}

function getSpaceResources(
  state: Pick<UnifiedResourcesState, 'resourcesBySpaceId'>,
  cacheKey: string | null | undefined,
): ContextItem[] {
  if (!cacheKey) return EMPTY_RESOURCES
  return state.resourcesBySpaceId[cacheKey] ?? EMPTY_RESOURCES
}

function getSpaceLoadState(
  state: Pick<
    UnifiedResourcesState,
    'resourcesBySpaceId' | 'loadingBySpaceId' | 'errorBySpaceId'
  >,
  cacheKey: string | null | undefined,
) {
  return {
    resources: getSpaceResources(state, cacheKey),
    isLoading: cacheKey ? Boolean(state.loadingBySpaceId[cacheKey]) : false,
    error: cacheKey ? state.errorBySpaceId[cacheKey] ?? null : null,
  }
}

function getLegacyProjectionCacheKey(spaceId: string | null | undefined): string | null {
  return getResourceCacheKey(spaceId, 'space')
}

function withCurrentSpaceProjection(
  state: UnifiedResourcesState,
  spaceId: string | null,
): Partial<UnifiedResourcesState> {
  if (!spaceId) {
    return {
      currentSpaceId: null,
      resources: EMPTY_RESOURCES,
      isLoading: false,
      error: null,
    }
  }
  const slice = getSpaceLoadState(state, getLegacyProjectionCacheKey(spaceId))
  return {
    currentSpaceId: spaceId,
    resources: slice.resources,
    isLoading: slice.isLoading,
    error: slice.error,
  }
}

function projectCurrentSpaceIfNeeded(
  draft: Partial<UnifiedResourcesState>,
  state: UnifiedResourcesState,
  targetSpaceId: string,
) {
  const projectedCurrentSpaceId = draft.currentSpaceId ?? state.currentSpaceId
  if (projectedCurrentSpaceId !== targetSpaceId) return draft
  const projectionCacheKey = getLegacyProjectionCacheKey(targetSpaceId)
  const resourcesBySpaceId = draft.resourcesBySpaceId ?? state.resourcesBySpaceId
  const loadingBySpaceId = draft.loadingBySpaceId ?? state.loadingBySpaceId
  const errorBySpaceId = draft.errorBySpaceId ?? state.errorBySpaceId
  return {
    ...draft,
    currentSpaceId: projectedCurrentSpaceId,
    resources: projectionCacheKey ? resourcesBySpaceId[projectionCacheKey] ?? EMPTY_RESOURCES : EMPTY_RESOURCES,
    isLoading: projectionCacheKey ? loadingBySpaceId[projectionCacheKey] ?? false : false,
    error: projectionCacheKey ? errorBySpaceId[projectionCacheKey] ?? null : null,
  }
}

function scheduleCacheKeyReload(cacheKey: string, delayMs: number) {
  clearScheduledReload(cacheKey)
  const timer = setTimeout(() => {
    scheduledReloads.delete(cacheKey)
    const state = useUnifiedResources.getState()
    if (!Object.prototype.hasOwnProperty.call(state.resourcesBySpaceId, cacheKey)) return
    const meta = state.bucketMetaByCacheKey[cacheKey]
    if (meta) {
      void state.load(meta.spaceId, true, meta.scope)
      return
    }
    // WS 乐观写入可能早于 load() 写入 bucketMeta；缺 meta 时仍强制回填真实 ContextItem.id
    // （：空 id 乐观项长期滞留会导致拖拽 moveItems 无效）
    if (cacheKey.endsWith(':organization')) {
      const spaceId = cacheKey.slice(0, -':organization'.length)
      if (!spaceId) return
      log.warn('scheduleCacheKeyReload missing bucketMeta; falling back to organization load', { cacheKey, spaceId })
      void state.load(spaceId, true, 'organization')
      return
    }
    log.warn('scheduleCacheKeyReload missing bucketMeta; falling back to space load', { cacheKey })
    void state.load(cacheKey, true, 'space')
  }, delayMs)
  scheduledReloads.set(cacheKey, timer)
}

function scheduleSpaceBucketReload(
  state: Pick<
    UnifiedResourcesState,
    'currentSpaceId' | 'resourcesBySpaceId'
  >,
  spaceId: string,
  delayMs: number,
) {
  if (Object.prototype.hasOwnProperty.call(state.resourcesBySpaceId, spaceId)) {
    scheduleCacheKeyReload(spaceId, delayMs)
    return
  }
  if (state.currentSpaceId !== spaceId) return
  clearScheduledReload(spaceId)
  const timer = setTimeout(() => {
    scheduledReloads.delete(spaceId)
    void useUnifiedResources.getState().load(spaceId, true, 'space')
  }, delayMs)
  scheduledReloads.set(spaceId, timer)
}

function getTrackedOrganizationCacheKeys(
  state: Pick<UnifiedResourcesState, 'bucketMetaByCacheKey' | 'resourcesBySpaceId'>,
  organizationId: string | null | undefined,
): string[] {
  if (!organizationId) return []
  const keys: string[] = []
  for (const meta of Object.values(state.bucketMetaByCacheKey)) {
    if (meta.scope !== 'organization') continue
    if (meta.organizationId !== organizationId) continue
    if (!Object.prototype.hasOwnProperty.call(state.resourcesBySpaceId, meta.cacheKey)) continue
    keys.push(meta.cacheKey)
  }
  return keys
}

function scheduleOrganizationBucketReloads(
  state: Pick<UnifiedResourcesState, 'bucketMetaByCacheKey' | 'resourcesBySpaceId'>,
  organizationId: string | null | undefined,
  delayMs: number,
) {
  for (const cacheKey of getTrackedOrganizationCacheKeys(state, organizationId)) {
    scheduleCacheKeyReload(cacheKey, delayMs)
  }
}

function scheduleAffectedBucketReloads(
  state: Pick<
    UnifiedResourcesState,
    'currentSpaceId' | 'resourcesBySpaceId' | 'bucketMetaByCacheKey'
  >,
  event: Pick<StructuralResourceWsEvent, 'space_id' | 'organization_id'>,
  delays: { space: number; organization: number },
) {
  scheduleSpaceBucketReload(state, event.space_id, delays.space)
  scheduleOrganizationBucketReloads(state, event.organization_id, delays.organization)
}

/** 空 id 乐观项二次自愈延迟：首轮 schedule（~500–650ms）失败/竞态后仍滞留时再刷一次。 */
const UNSYNCED_ID_HEAL_DELAY_MS = 3000
const unsyncedHealTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleUnsyncedIdHeal(spaceId: string, organizationId?: string | null) {
  const key = `${spaceId}:${organizationId ?? ''}`
  const existing = unsyncedHealTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    unsyncedHealTimers.delete(key)
    const healed = healUnsyncedContextItems(spaceId)
    if (healed > 0) {
      log.warn('unsynced context item id heal reload scheduled', {
        spaceId,
        organizationId: organizationId ?? null,
        buckets: healed,
      })
    }
  }, UNSYNCED_ID_HEAL_DELAY_MS)
  unsyncedHealTimers.set(key, timer)
}

/**
 * 扫描资源桶，对仍含空 id / local: 项的 cacheKey 强制 reload。
 * @returns 触发 reload 的 bucket 数量
 */
export function healUnsyncedContextItems(spaceId?: string | null): number {
  const state = useUnifiedResources.getState()
  const targets: Array<{ spaceId: string; scope: ResourceBucketScope }> = []
  for (const [cacheKey, list] of Object.entries(state.resourcesBySpaceId)) {
    if (!list.some(item => isUnsyncedContextItemId(item.id))) continue
    const meta = state.bucketMetaByCacheKey[cacheKey]
    if (meta) {
      if (spaceId && meta.spaceId !== spaceId) continue
      targets.push({ spaceId: meta.spaceId, scope: meta.scope })
      continue
    }
    if (cacheKey.endsWith(':organization')) {
      const sid = cacheKey.slice(0, -':organization'.length)
      if (!sid || (spaceId && sid !== spaceId)) continue
      targets.push({ spaceId: sid, scope: 'organization' })
    } else {
      if (spaceId && cacheKey !== spaceId) continue
      targets.push({ spaceId: cacheKey, scope: 'space' })
    }
  }
  for (const target of targets) {
    void state.load(target.spaceId, true, target.scope)
  }
  return targets.length
}

/**
 * 注册 WS 资源变更事件的外部监听器。
 * 当 handleWsEvent 处理完指定 resource_type 的事件后会通知注册方。
 * 返回 unsubscribe 函数，适合在 useEffect cleanup 中调用。
 *
 * @param options.spaceId 可选，传入后只接收该 Space 的事件
 */
export function onResourceEvent(
  resourceType: string,
  listener: ResourceEventListener,
  options?: {
    spaceId?: string
  },
): () => void {
  const targetSpaceId = options?.spaceId
  const wrappedListener: ResourceEventListener = targetSpaceId
    ? (event) => { if (event.space_id === targetSpaceId) listener(event) }
    : listener

  if (!eventListenersByType.has(resourceType)) {
    eventListenersByType.set(resourceType, new Set())
  }
  eventListenersByType.get(resourceType)!.add(wrappedListener)
  return () => {
    eventListenersByType.get(resourceType)?.delete(wrappedListener)
  }
}

function notifyExternalListeners(event: ResourceWsEvent) {
  const listeners = eventListenersByType.get(event.resource_type)
  if (!listeners) return
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      log.error('listener error:', { resourceType: event.resource_type, error: err })
    }
  }
}

export const useUnifiedResources = create<UnifiedResourcesState>((set, get) => ({
  currentSpaceId: null,
  resources: EMPTY_RESOURCES,
  isLoading: false,
  error: null,
  resourcesBySpaceId: {},
  loadingBySpaceId: {},
  errorBySpaceId: {},
  bucketMetaByCacheKey: {},

  getByResourceId: (resourceId: string, spaceId?: string | null) => {
    const state = get()
    const targetSpaceId = spaceId ?? state.currentSpaceId
    const inSpaceBucket = getSpaceResources(state, targetSpaceId).find((r) => r.resource_id === resourceId)
    if (inSpaceBucket) return inSpaceBucket
    const organizationCacheKey = targetSpaceId ? getResourceCacheKey(targetSpaceId, 'organization') : null
    if (!organizationCacheKey) return undefined
    return getSpaceResources(state, organizationCacheKey).find((r) => r.resource_id === resourceId)
  },

  getResources: (spaceId) => getSpaceResources(get(), spaceId),

  getLoadState: (spaceId) => getSpaceLoadState(get(), spaceId),

  setCurrentSpace: (spaceId) => {
    set(state => withCurrentSpaceProjection(state, spaceId))
  },

  load: async (spaceId: string, force = false, scope: ResourceBucketScope = 'space') => {
    if (!isLoadableResourceHostSpaceId(spaceId)) {
      log.warn('skip load for invalid spaceId', { spaceId, scope })
      return
    }
    const cacheKey = getResourceCacheKey(spaceId, scope) ?? spaceId
    const state = get()
    const hasCachedBucket = Object.prototype.hasOwnProperty.call(state.resourcesBySpaceId, cacheKey)
    const organizationId = resolveOrganizationIdForSpace(spaceId) ?? state.bucketMetaByCacheKey[cacheKey]?.organizationId ?? null
    const bucketMeta: ResourceBucketMeta = {
      cacheKey,
      scope,
      spaceId,
      organizationId,
    }

    if (!force && hasCachedBucket && state.bucketMetaByCacheKey[cacheKey]) {
      return
    }

    // 强制刷新时先取消同 bucket 的延迟 reload，并 bump generation 作废进行中的旧请求
    clearScheduledReload(cacheKey)
    const generation = (loadGenerationByCacheKey.get(cacheKey) ?? 0) + 1
    loadGenerationByCacheKey.set(cacheKey, generation)

    set(prev => projectCurrentSpaceIfNeeded({
      bucketMetaByCacheKey: {
        ...prev.bucketMetaByCacheKey,
        [cacheKey]: bucketMeta,
      },
      loadingBySpaceId: {
        ...prev.loadingBySpaceId,
        [cacheKey]: true,
      },
      errorBySpaceId: {
        ...prev.errorBySpaceId,
        [cacheKey]: null,
      },
    }, prev, spaceId))

    const MAX_RETRIES = 2
    const BASE_DELAY = 1000

    for (let i = 0; i <= MAX_RETRIES; i += 1) {
      try {
        const items = await fetchAllContextItems(spaceId, scope)
        if (loadGenerationByCacheKey.get(cacheKey) !== generation) {
          log.info('忽略过期 load 响应', { spaceId, scope, cacheKey, generation })
          return
        }
        set(prev => projectCurrentSpaceIfNeeded({
          bucketMetaByCacheKey: {
            ...prev.bucketMetaByCacheKey,
            [cacheKey]: bucketMeta,
          },
          resourcesBySpaceId: {
            ...prev.resourcesBySpaceId,
            [cacheKey]: items,
          },
          loadingBySpaceId: {
            ...prev.loadingBySpaceId,
            [cacheKey]: false,
          },
          errorBySpaceId: {
            ...prev.errorBySpaceId,
            [cacheKey]: null,
          },
        }, prev, spaceId))
        return
      } catch (err: unknown) {
        if (loadGenerationByCacheKey.get(cacheKey) !== generation) {
          log.info('忽略过期 load 错误', { spaceId, scope, cacheKey, generation })
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        if (i < MAX_RETRIES) {
          const delay = BASE_DELAY * 2 ** i
          log.warn('load failed, retrying:', { spaceId, scope, attempt: i + 1, delayMs: delay, message: msg })
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
        log.error('load failed (exhausted retries):', { spaceId, scope, error: err })
        set(prev => projectCurrentSpaceIfNeeded({
          bucketMetaByCacheKey: {
            ...prev.bucketMetaByCacheKey,
            [cacheKey]: bucketMeta,
          },
          loadingBySpaceId: {
            ...prev.loadingBySpaceId,
            [cacheKey]: false,
          },
          errorBySpaceId: {
            ...prev.errorBySpaceId,
            [cacheKey]: msg,
          },
        }, prev, spaceId))
      }
    }
  },

  handleWsEvent: (rawEvent: ResourceWsEvent) => {
    const event: ResourceWsEvent = {
      ...rawEvent,
      resource_type: contextRegistry.normalizeBackendType(rawEvent.resource_type),
    }
    const resolvedOrganizationId = event.organization_id ?? resolveOrganizationIdForSpace(event.space_id)
    const state = get()
    const targetSpaceId = event.space_id
    const hasSpaceBucket = Object.prototype.hasOwnProperty.call(state.resourcesBySpaceId, targetSpaceId)
    const shouldMutateSpaceBucket = hasSpaceBucket || targetSpaceId === state.currentSpaceId

    if (event.type === 'resource_updated' && event.title !== undefined) {
      useSpaceContextTabsStore.getState().syncOpenResourceTabTitle({
        type: event.resource_type,
        id: event.resource_id,
        title: event.title,
        spaceId: event.space_id,
      })
    }
    if (event.type === 'resource_updated' && event.metadata && Object.prototype.hasOwnProperty.call(event.metadata, 'icon')) {
      const rawIcon = event.metadata.icon
      useSpaceContextTabsStore.getState().syncOpenResourceTabIcon({
        type: event.resource_type,
        id: event.resource_id,
        icon: typeof rawIcon === 'string' ? rawIcon : '',
        spaceId: event.space_id,
      })
    }
    if (RESOURCE_TAB_CLOSE_EVENT_TYPES.has(event.type)) {
      const tabKey = `${event.resource_type}:${event.resource_id}`
      useCanvasLayoutStore.getState().closeTabEverywhere(tabKey)
      useSpaceContextTabsStore.getState().closeResourceTabEverywhere(
        event.resource_type,
        event.resource_id,
      )
    }

    // ：与 UI 挂载无关——对话/云盘删除时云文档侧栏可能未挂载
    syncKnowledgeTreeFromResourceEvent(event, resolvedOrganizationId)

    if (!shouldMutateSpaceBucket) {
      if (event.type === 'resource_updated') {
        set(prev => projectCurrentSpaceIfNeeded({
          resourcesBySpaceId: applyResourceUpdatedEventToCachedBuckets(prev, event),
        }, prev, targetSpaceId))
      }
      // ：trash/archive/delete/撤权即使当前 Space bucket 未缓存，也立即清掉 organization 等所有桶
      if (RESOURCE_REMOVAL_EVENT_TYPES.has(event.type)) {
        set(prev => projectCurrentSpaceIfNeeded({
          resourcesBySpaceId: removeResourceFromAllBuckets(
            prev.resourcesBySpaceId,
            event.resource_id,
          ),
        }, prev, targetSpaceId))
        if (event.type !== 'resource_access_revoked') {
          scheduleAffectedBucketReloads(state, { ...event, organization_id: resolvedOrganizationId }, { space: 500, organization: 650 })
        }
        notifyExternalListeners(event)
        return
      }
      scheduleAffectedBucketReloads(state, { ...event, organization_id: resolvedOrganizationId }, { space: 500, organization: 650 })
      notifyExternalListeners(event)
      return
    }

    const currentResources = getSpaceResources(state, targetSpaceId)

    switch (event.type) {
      case 'resource_created':
      case 'resource_access_granted': {
        if (currentResources.some(r => r.resource_id === event.resource_id)) break
        const contextItemId = typeof event.context_item_id === 'string' ? event.context_item_id.trim() : ''
        if (!contextItemId) {
          log.warn('resource_created without context_item_id; inserting empty id optimistic item', {
            resource_id: event.resource_id,
            space_id: event.space_id,
            organization_id: resolvedOrganizationId,
            event_type: event.type,
          })
        }
        const newItem: ContextItem = {
          id: contextItemId,
          item_type: event.resource_type,
          title: event.title || '',
          preview: event.preview ?? '',
          resource_id: event.resource_id,
          space_id: event.space_id,
          metadata: event.metadata ?? {},
          is_archived: false,
          is_pinned: event.is_pinned ?? false,
          pinned_at: event.pinned_at ?? null,
          collection_id: event.collection_id ?? null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }
        set(prev => {
          const nextBuckets: Record<string, ContextItem[]> = { ...prev.resourcesBySpaceId }
          if (shouldMutateSpaceBucket) {
            const spaceList = getSpaceResources(prev, targetSpaceId)
            if (!spaceList.some(r => r.resource_id === event.resource_id)) {
              nextBuckets[targetSpaceId] = [newItem, ...spaceList]
            }
          }
          for (const cacheKey of getTrackedOrganizationCacheKeys(prev, resolvedOrganizationId)) {
            const orgList = getSpaceResources(prev, cacheKey)
            if (orgList.some(r => r.resource_id === event.resource_id)) continue
            nextBuckets[cacheKey] = [newItem, ...orgList]
          }
          return projectCurrentSpaceIfNeeded({
            resourcesBySpaceId: nextBuckets,
          }, prev, targetSpaceId)
        })
        scheduleAffectedBucketReloads(state, { ...event, organization_id: resolvedOrganizationId }, { space: 500, organization: 650 })
        if (!contextItemId) {
          scheduleUnsyncedIdHeal(event.space_id, resolvedOrganizationId)
        }
        break
      }
      case 'resource_updated': {
        set(prev => projectCurrentSpaceIfNeeded({
          resourcesBySpaceId: applyResourceUpdatedEventToCachedBuckets(prev, event),
        }, prev, targetSpaceId))
        scheduleAffectedBucketReloads(state, { ...event, organization_id: resolvedOrganizationId }, { space: 800, organization: 900 })
        break
      }
      case 'resource_archived':
      case 'resource_trashed':
      case 'resource_deleted': {
        // ：立即从 space + organization 全部 bucket 移除，避免云盘/云文档仍短暂展示已删项
        set(prev => projectCurrentSpaceIfNeeded({
          resourcesBySpaceId: removeResourceFromAllBuckets(
            prev.resourcesBySpaceId,
            event.resource_id,
          ),
        }, prev, targetSpaceId))
        scheduleAffectedBucketReloads(state, { ...event, organization_id: resolvedOrganizationId }, { space: 500, organization: 650 })
        break
      }
      case 'resource_access_revoked': {
        // 撤权后从资源列表移除，但保留已打开标签，由资源面板原位展示无权状态。
        set(prev => projectCurrentSpaceIfNeeded({
          resourcesBySpaceId: removeResourceFromAllBuckets(
            prev.resourcesBySpaceId,
            event.resource_id,
          ),
        }, prev, targetSpaceId))
        break
      }
      case 'resource_restored': {
        scheduleAffectedBucketReloads(state, { ...event, organization_id: resolvedOrganizationId }, { space: 500, organization: 650 })
        break
      }
      default:
        break
    }

    notifyExternalListeners(event)
  },

  handleStructuralEvent: (event) => {
    if (!STRUCTURAL_RELOAD_EVENT_TYPES.has(event.type)) return
    if (event.type === 'collection_deleted') {
      const collectionIds = new Set([
        ...(event.collection_ids ?? []),
        ...(event.collection_id ? [event.collection_id] : []),
      ])
      if (collectionIds.size > 0) {
        set(prev => projectCurrentSpaceIfNeeded({
          resourcesBySpaceId: removeCollectionResourcesFromCachedBuckets(prev, collectionIds),
        }, prev, event.space_id))
      }
    }
    scheduleAffectedBucketReloads(
      get(),
      {
        ...event,
        organization_id: event.organization_id ?? resolveOrganizationIdForSpace(event.space_id),
      },
      { space: 350, organization: 500 },
    )
  },

  touchLastVisitedAt: (itemId, visitedAt = new Date().toISOString()) => {
    if (!isRecordableContextItemId(itemId)) return
    set(prev => {
      let didUpdate = false
      const nextBuckets: Record<string, ContextItem[]> = { ...prev.resourcesBySpaceId }
      for (const [cacheKey, resources] of Object.entries(prev.resourcesBySpaceId)) {
        let bucketChanged = false
        const nextResources = resources.map(resource => {
          if (resource.id !== itemId) return resource
          if (resource.last_visited_at === visitedAt) return resource
          bucketChanged = true
          didUpdate = true
          return { ...resource, last_visited_at: visitedAt }
        })
        if (bucketChanged) nextBuckets[cacheKey] = nextResources
      }
      if (!didUpdate) return prev
      if (!prev.currentSpaceId) {
        return { resourcesBySpaceId: nextBuckets }
      }
      return {
        resourcesBySpaceId: nextBuckets,
        ...withCurrentSpaceProjection(
          { ...prev, resourcesBySpaceId: nextBuckets },
          prev.currentSpaceId,
        ),
      }
    })
  },

  clear: (spaceId) => {
    if (!spaceId) {
      for (const timer of scheduledReloads.values()) {
        clearTimeout(timer)
      }
      scheduledReloads.clear()
      set({
        currentSpaceId: null,
        resources: EMPTY_RESOURCES,
        isLoading: false,
        error: null,
        resourcesBySpaceId: {},
        loadingBySpaceId: {},
        errorBySpaceId: {},
        bucketMetaByCacheKey: {},
      })
      return
    }

    set(prev => {
      const organizationCacheKey = getResourceCacheKey(spaceId, 'organization') ?? `${spaceId}:organization`
      clearScheduledReload(spaceId)
      clearScheduledReload(organizationCacheKey)
      const {
        [spaceId]: _removedResources,
        [organizationCacheKey]: _removedOrganizationResources,
        ...restResources
      } = prev.resourcesBySpaceId
      const {
        [spaceId]: _removedLoading,
        [organizationCacheKey]: _removedOrganizationLoading,
        ...restLoading
      } = prev.loadingBySpaceId
      const {
        [spaceId]: _removedError,
        [organizationCacheKey]: _removedOrganizationError,
        ...restErrors
      } = prev.errorBySpaceId
      const {
        [spaceId]: _removedSpaceMeta,
        [organizationCacheKey]: _removedOrganizationMeta,
        ...restBucketMeta
      } = prev.bucketMetaByCacheKey

      const nextState: Partial<UnifiedResourcesState> = {
        resourcesBySpaceId: restResources,
        loadingBySpaceId: restLoading,
        errorBySpaceId: restErrors,
        bucketMetaByCacheKey: restBucketMeta,
      }

      if (prev.currentSpaceId !== spaceId) {
        return nextState
      }

      return {
        ...nextState,
        ...withCurrentSpaceProjection(
          {
            ...prev,
            resourcesBySpaceId: restResources,
            loadingBySpaceId: restLoading,
            errorBySpaceId: restErrors,
            bucketMetaByCacheKey: restBucketMeta,
          },
          null,
        ),
      }
    })
  },

  clearOrganizationBuckets: (organizationId) => {
    if (!organizationId) return
    // 复用 clear(spaceId)：Space→Org 1:1，清该 org 下出现过的 space 桶即可。
    const spaceIds = new Set(
      Object.values(get().bucketMetaByCacheKey)
        .filter(meta => meta.organizationId === organizationId)
        .map(meta => meta.spaceId)
        .filter(Boolean),
    )
    for (const spaceId of spaceIds) {
      get().clear(spaceId)
    }
  },
}))

export function useSpaceUnifiedResources(spaceId: string | null | undefined) {
  return useScopedUnifiedResources(spaceId, 'space')
}

export function useScopedUnifiedResources(
  spaceId: string | null | undefined,
  scope: ResourceBucketScope = 'space',
) {
  const cacheKey = getResourceCacheKey(spaceId, scope)
  const resources = useUnifiedResources(
    useCallback(state => getSpaceResources(state, cacheKey), [cacheKey]),
  )
  const isLoading = useUnifiedResources(
    useCallback(state => (cacheKey ? Boolean(state.loadingBySpaceId[cacheKey]) : false), [cacheKey]),
  )
  const error = useUnifiedResources(
    useCallback(state => (cacheKey ? state.errorBySpaceId[cacheKey] ?? null : null), [cacheKey]),
  )

  return {
    resources,
    isLoading,
    error,
  }
}

/**
 * 记录最近访问并乐观更新统一资源缓存。
 * fire-and-forget：不阻断打开主流程；API 失败仅丢失乐观时间戳，下次 load 纠正。
 */
export function recordContextItemAccess(itemId: string | null | undefined): void {
  if (!isRecordableContextItemId(itemId)) return
  const visitedAt = new Date().toISOString()
  useUnifiedResources.getState().touchLastVisitedAt(itemId!, visitedAt)
  void SpaceApiService.recordResourceAccess(itemId!)
}

/** 在统一资源缓存中按 resource_id 反查可记访问的 ContextItem.id。 */
export function findContextItemIdByResourceId(
  resourceId: string | null | undefined,
): string | null {
  if (!resourceId) return null
  const buckets = Object.values(useUnifiedResources.getState().resourcesBySpaceId)
  for (const resources of buckets) {
    for (const resource of resources) {
      if (resource.resource_id !== resourceId) continue
      if (isRecordableContextItemId(resource.id)) return resource.id
    }
  }
  return null
}

const PENDING_RESOURCE_ACCESS_TIMEOUT_MS = 8_000
const pendingResourceAccessCleanups = new Map<string, () => void>()

/**
 * 按 resource_id 记最近访问（ /  残余）。
 *
 * 新建打开时 ContextItem 常在 create API 返回后经 on_commit + WS 才进缓存：
 * 缓存已有 id 则立刻记；否则订阅 resource_created/updated，拿到 context_item_id 后记一次。
 */
export function recordResourceAccessByResourceId(
  resourceId: string | null | undefined,
  options?: {
    resourceType?: string | null
  },
): void {
  if (!resourceId) return

  const tryRecord = (itemId?: string | null): boolean => {
    const resolved = itemId && isRecordableContextItemId(itemId)
      ? itemId
      : findContextItemIdByResourceId(resourceId)
    if (!resolved) return false
    pendingResourceAccessCleanups.get(resourceId)?.()
    pendingResourceAccessCleanups.delete(resourceId)
    recordContextItemAccess(resolved)
    return true
  }

  if (tryRecord()) return

  pendingResourceAccessCleanups.get(resourceId)?.()

  const resourceType = options?.resourceType?.trim() || null
  const unsubscribers: Array<() => void> = []
  let settled = false

  const settle = (itemId?: string | null) => {
    if (settled) return
    if (!tryRecord(itemId)) return
    settled = true
  }

  const onEvent = (event: ResourceWsEvent) => {
    if (event.resource_id !== resourceId) return
    if (
      event.type !== 'resource_created'
      && event.type !== 'resource_updated'
      && event.type !== 'resource_restored'
    ) {
      return
    }
    settle(event.context_item_id)
  }

  if (resourceType) {
    unsubscribers.push(onResourceEvent(resourceType, onEvent))
  } else {
    // 创建路径通常已知 tabdoc/tabdata；未知时两边都挂，避免漏等
    unsubscribers.push(onResourceEvent('tabdoc', onEvent))
    unsubscribers.push(onResourceEvent('tabdata', onEvent))
  }

  const timer = setTimeout(() => {
    if (settled) return
    // 最后再扫一次缓存（refreshResources 可能已落库但未再发 WS）
    settle()
    cleanup()
  }, PENDING_RESOURCE_ACCESS_TIMEOUT_MS)

  const cleanup = () => {
    for (const unsub of unsubscribers) unsub()
    clearTimeout(timer)
    if (pendingResourceAccessCleanups.get(resourceId) === cleanup) {
      pendingResourceAccessCleanups.delete(resourceId)
    }
  }

  pendingResourceAccessCleanups.set(resourceId, cleanup)
}

import { registerResetAction } from './sessionResetRegistry'
registerResetAction('unified-resources', 'reset', () => useUnifiedResources.getState().clear())
