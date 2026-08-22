/**
 * useCollectionDnD — Collection 拖拽共享逻辑
 *
 * 从 CollectionsView 和 SidebarCollections 中提取的公共 DnD 行为：
 * - dragOverTarget 状态管理
 * - handleDragOver / handleDragLeave / timeout cleanup
 * - handleDropOnCollection（支持嵌套文件夹）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'
import { useUnifiedResources } from '@/stores/useUnifiedResources'
import { createLogger } from '@/utils/logger'
import { COLLECTION_FOLDER_MIME, COLLECTION_ITEM_MIME } from './collectionMime'

export { COLLECTION_FOLDER_MIME, COLLECTION_ITEM_MIME } from './collectionMime'

const DRAG_LEAVE_DELAY = 100

const log = createLogger('CollectionDnD')

export interface CollectionDragItem {
  id: string
  collection_id?: string | null
  title?: string
  resource_id?: string
  is_cross_space?: boolean
  foreign_shared?: boolean
  shared_resource_type?: 'doc' | 'table' | 'file'
  shared_resource_id?: string
}

interface UseCollectionDnDParams {
  spaceId: string
  moveItems: (spaceId: string, itemIds: string[], collectionId: string | null) => Promise<unknown>
  t: TFunction
  activeDragItem?: CollectionDragItem | null
  activeDragItemRef?: { current: CollectionDragItem | null }
  /**
   * 云盘 / organization 聚合视图：资源归属 workteam（organization），
   * 允许同 organization 下跨 Space 拖入当前锚点 Space 的文件夹。
   * Space 视图保持拒绝，避免误把外 Space 资源拖进本 Space 树。
   */
  allowOrganizationCrossSpaceMove?: boolean
  moveSharedResource?: (
    resourceType: 'doc' | 'table' | 'file',
    resourceId: string,
    collectionId: string | null,
  ) => Promise<void>
  onSharedResourceMoved?: () => void
}

/** ContextItem UUID 可用时才允许 move / pin；空 id 与 local: 乐观项不可移动。 */
export function isMovableContextItemId(id: string | null | undefined): boolean {
  return Boolean(id) && !id!.startsWith('local:')
}

export function buildCollectionDragItem(
  item: {
    id: string
    collection_id?: string | null
    resource_id?: string
    metadata?: {
      foreignShared?: boolean
      sharedResourceType?: 'doc' | 'table' | 'file'
      sharedResourceId?: string
    } | null
  },
  options?: { isCrossSpace?: boolean },
): CollectionDragItem | null {
  if (!isMovableContextItemId(item.id)) return null
  const dragItem: CollectionDragItem = {
    id: item.id,
    collection_id: item.collection_id,
    resource_id: item.resource_id,
    is_cross_space: options?.isCrossSpace,
  }
  if (item.metadata?.foreignShared) {
    dragItem.foreign_shared = true
    dragItem.shared_resource_type = item.metadata.sharedResourceType
    dragItem.shared_resource_id = item.metadata.sharedResourceId ?? item.resource_id
  }
  return dragItem
}

export function dataTransferHasType(dataTransfer: DataTransfer, type: string): boolean {
  const types = dataTransfer.types
  if (typeof types.includes === 'function') {
    return types.includes(type)
  }
  const legacyTypes = types as unknown as {
    contains?: (value: string) => boolean
    length: number
    item?: (index: number) => string | null
    [index: number]: string | undefined
  }
  if (typeof legacyTypes.contains === 'function') {
    return legacyTypes.contains(type)
  }
  for (let index = 0; index < legacyTypes.length; index += 1) {
    if ((legacyTypes.item?.(index) ?? legacyTypes[index]) === type) return true
  }
  return false
}

export function useCollectionDnD({
  spaceId,
  moveItems,
  t,
  activeDragItem = null,
  activeDragItemRef,
  allowOrganizationCrossSpaceMove = false,
  moveSharedResource,
  onSharedResourceMoved,
}: UseCollectionDnDParams) {
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)
  const dragTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const handleStructuralEvent = useUnifiedResources(s => s.handleStructuralEvent)

  useEffect(() => {
    return () => { if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current) }
  }, [])

  const getActiveDragItem = useCallback(() => (
    activeDragItemRef?.current ?? activeDragItem ?? null
  ), [activeDragItem, activeDragItemRef])

  const handleDragOver = useCallback((
    e: React.DragEvent,
    targetId: string,
    options?: { force?: boolean },
  ) => {
    const dragItem = getActiveDragItem()
    const isItem = Boolean(dragItem) || dataTransferHasType(e.dataTransfer, COLLECTION_ITEM_MIME)
    const isFolder = dataTransferHasType(e.dataTransfer, COLLECTION_FOLDER_MIME)
    // force：文件夹拖拽在 Windows 上 dragOver 读不到自定义 MIME，由调用方用 ref 判定后强制高亮
    if (!options?.force && !isItem && !isFolder) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverTarget(targetId)
    if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current)
  }, [getActiveDragItem])

  const handleDragLeave = useCallback(() => {
    dragTimeoutRef.current = setTimeout(() => setDragOverTarget(null), DRAG_LEAVE_DELAY)
  }, [])

  const clearDragState = useCallback(() => {
    setDragOverTarget(null)
  }, [])

  const parseDragData = useCallback((e: React.DragEvent): CollectionDragItem | null => {
    const raw = e.dataTransfer.getData(COLLECTION_ITEM_MIME)
    if (raw) {
      try { return JSON.parse(raw) as CollectionDragItem } catch { return null }
    }
    return getActiveDragItem()
  }, [getActiveDragItem])

  const rejectUnsyncedDragItem = useCallback((data: CollectionDragItem, target: string) => {
    log.warn('drop rejected: empty context item id', {
      spaceId,
      target,
      resource_id: data.resource_id ?? null,
      collection_id: data.collection_id ?? null,
    })
    toast.warning(t('home.assetBrowser.itemStillSyncing', {
      defaultValue: '资源仍在同步，请稍后再试',
    }))
    // 云盘读 organization bucket；同时刷 space/organization，避免空 id 滞留
    void useUnifiedResources.getState().load(spaceId, true, 'space')
    void useUnifiedResources.getState().load(spaceId, true, 'organization')
  }, [spaceId, t])

  const handleDropOnCollection = useCallback(async (e: React.DragEvent, collectionId: string) => {
    e.preventDefault()
    setDragOverTarget(null)
    try {
      const data = parseDragData(e)
      const usedRefFallback = !e.dataTransfer.getData(COLLECTION_ITEM_MIME)
      if (!data) {
        log.warn('drop on collection: no drag payload', { spaceId, collectionId, usedRefFallback })
        return
      }
      if (data.foreign_shared) {
        if (!data.shared_resource_type || !data.shared_resource_id || !moveSharedResource) return
        await moveSharedResource(data.shared_resource_type, data.shared_resource_id, collectionId)
        onSharedResourceMoved?.()
        return
      }
      log.info('drop on collection', {
        spaceId,
        collectionId,
        itemId: data.id || '(empty)',
        resource_id: data.resource_id ?? null,
        from_collection_id: data.collection_id ?? null,
        usedRefFallback,
        is_cross_space: Boolean(data.is_cross_space),
        allow_org_cross_space: allowOrganizationCrossSpaceMove,
      })
      if (data.is_cross_space && !allowOrganizationCrossSpaceMove) {
        toast.warning(t('home.assetBrowser.crossSpaceDragUnsupported', {
          defaultValue: '只可操作同一space下的文件',
        }))
        return
      }
      if (!isMovableContextItemId(data.id)) {
        rejectUnsyncedDragItem(data, `coll:${collectionId}`)
        return
      }
      if (data.collection_id === collectionId) return
      const updated = await moveItems(spaceId, [data.id], collectionId)
      handleStructuralEvent({ type: 'items_moved', space_id: spaceId })
      log.info('drop on collection succeeded', {
        spaceId,
        collectionId,
        itemId: data.id,
        updated,
        is_cross_space: Boolean(data.is_cross_space),
      })
    } catch (err) {
      log.error('drop on collection failed:', err)
      toast.error(t('errorToast.collectionDropFailed'))
    }
  }, [
    parseDragData,
    moveItems,
    spaceId,
    handleStructuralEvent,
    t,
    rejectUnsyncedDragItem,
    allowOrganizationCrossSpaceMove,
    moveSharedResource,
    onSharedResourceMoved,
  ])

  const handleDropOnUncategorized = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOverTarget(null)
    try {
      const data = parseDragData(e)
      const usedRefFallback = !e.dataTransfer.getData(COLLECTION_ITEM_MIME)
      if (!data) return
      if (data.foreign_shared) {
        if (!data.shared_resource_type || !data.shared_resource_id || !moveSharedResource) return
        await moveSharedResource(data.shared_resource_type, data.shared_resource_id, null)
        onSharedResourceMoved?.()
        return
      }
      if (!data.collection_id) return
      log.info('drop on root', {
        spaceId,
        itemId: data.id || '(empty)',
        resource_id: data.resource_id ?? null,
        from_collection_id: data.collection_id,
        usedRefFallback,
        is_cross_space: Boolean(data.is_cross_space),
        allow_org_cross_space: allowOrganizationCrossSpaceMove,
      })
      if (data.is_cross_space && !allowOrganizationCrossSpaceMove) {
        toast.warning(t('home.assetBrowser.crossSpaceDragUnsupported', {
          defaultValue: '只可操作同一space下的文件',
        }))
        return
      }
      if (!isMovableContextItemId(data.id)) {
        rejectUnsyncedDragItem(data, 'crumb:root')
        return
      }
      const updated = await moveItems(spaceId, [data.id], null)
      handleStructuralEvent({ type: 'items_moved', space_id: spaceId })
      log.info('drop on root succeeded', {
        spaceId,
        itemId: data.id,
        updated,
        is_cross_space: Boolean(data.is_cross_space),
      })
    } catch (err) {
      log.error('drop on uncategorized failed:', err)
      toast.error(t('errorToast.collectionDropFailed'))
    }
  }, [
    parseDragData,
    moveItems,
    spaceId,
    handleStructuralEvent,
    t,
    rejectUnsyncedDragItem,
    allowOrganizationCrossSpaceMove,
    moveSharedResource,
    onSharedResourceMoved,
  ])

  return {
    dragOverTarget,
    handleDragOver,
    handleDragLeave,
    clearDragState,
    parseDragData,
    handleDropOnCollection,
    handleDropOnUncategorized,
  }
}
