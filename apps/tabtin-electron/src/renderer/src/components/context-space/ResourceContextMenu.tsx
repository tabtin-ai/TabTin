import React, { useCallback, useMemo, useState } from 'react'
import {
  Pin, PinOff, FolderMinus, FolderInput, FolderOutput,
  Pencil, Trash2, MessageSquare, Share2, Send,
} from 'lucide-react'
import {
  ContextMenu, ContextMenuItem, ConfirmDialog,
  ShareDialog,
  toast,
} from '@components/ui'
import { updateDocument } from '@tabtin/tabdoc-ui/api-client'
import { buildSpaceItemChatContextDragPayload } from './hooks/chatContextDragPayload'
import { deliverContextInjectToChat } from '@/services/deliverContextInjectToChat'
import { useTranslation } from 'react-i18next'
import { useUnifiedResources, type ResourceWsEvent } from '@/stores/useUnifiedResources'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  useCollections,
  useCollectionsByOrganization,
  useCollectionsBySpace,
  flattenCollections,
} from '@/stores/useCollections'
import { useSpaceStore } from '@stores/useSpaceStore'
import { tableStore } from '@stores/useTableStore'
import { SpaceApiService, type SpaceContextItem as SearchResultItem } from '@/services/spaceApi'
import { apiService } from '@/services/api'
import { updateTask as updateTrackerTask } from '@/services/trackerApi'
import { getSharedAppHostClient } from '@/adapters/sharedAppHostClient'
import { buildPublicShareUrlPrefix } from '@/config/api'
import { contextRegistry } from './registry'
import type { useRemoveFolderConfirm } from './hooks/useRemoveFolderConfirm'
import { CollectionMovePickerOverlay } from './CollectionMovePickerOverlay'
import { isMovableContextItemId } from './hooks/useCollectionDnD'
import { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from '@/lib/duplicateNameError'
import { SendToIMDialog } from '@/components/tabchat/SendToIMDialog'
import { canSendResourceToIM } from '@/components/tabchat/sendToIM/sendToIMHelpers'
import { dismissSharedResourcePlacement, moveSharedResourcePlacement } from '@/services/sharedResourcesApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('ResourceContextMenu')

function resolveSharedPlacementMeta(item: SearchResultItem, fallbackOrganizationId?: string) {
  const meta = item.metadata as {
    foreignShared?: boolean
    sharedOrganizationId?: string
    sharedResourceType?: 'doc' | 'table' | 'file'
    sharedResourceId?: string
  } | undefined
  if (!meta?.foreignShared) return null
  const resourceType = meta.sharedResourceType
    ?? (item.item_type === 'tabdoc' ? 'doc' : item.item_type === 'tabdata' ? 'table' : item.item_type === 'tabfiles' ? 'file' : undefined)
  // placement 属于接收者当前所在组织；sharedOrganizationId 是资源所有者组织，
  // 仅用于缺少当前组织上下文时的兼容回退。
  const organizationId = fallbackOrganizationId ?? meta.sharedOrganizationId ?? item.organization_id
  const resourceId = meta.sharedResourceId ?? item.resource_id
  if (!organizationId || !resourceType || !resourceId) return null
  return { organizationId: String(organizationId), resourceType, resourceId }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface MenuState {
  open: boolean
  pos: { x: number; y: number }
  item: SearchResultItem | null
}

const MENU_INITIAL: MenuState = { open: false, pos: { x: 0, y: 0 }, item: null }

interface NamedResourceUpdateResponse {
  id?: string
  name?: string
  space_id?: string
  updated_at?: string
}

/** 乐观更新本地标题，不触发 bucket reload */
function applyLocalResourceTitle(input: {
  resourceType: string
  resourceId: string
  title: string
  spaceId?: string
}) {
  const { resourceType, resourceId, title, spaceId } = input
  const normalizedId = resourceId?.trim()
  if (!normalizedId) return

  useSpaceContextTabsStore.getState().syncOpenResourceTabTitle({
    type: resourceType,
    id: normalizedId,
    title,
    spaceId,
  })

  const { resources, resourcesBySpaceId } = useUnifiedResources.getState()
  let didUpdateResources = false
  let didUpdateBuckets = false

  const patchResource = (resource: SearchResultItem): SearchResultItem => {
    if (resource.resource_id !== normalizedId) return resource
    if ((resource.title || '').trim() === title.trim()) return resource
    return {
      ...resource,
      title,
      updated_at: new Date().toISOString(),
    }
  }

  const nextResources = resources.map(item => {
    const next = patchResource(item)
    if (next !== item) didUpdateResources = true
    return next
  })

  const nextResourcesBySpaceId: Record<string, SearchResultItem[]> = {}
  for (const [cacheKey, bucket] of Object.entries(resourcesBySpaceId ?? {})) {
    let didUpdateBucket = false
    const nextBucket = bucket.map(resource => {
      const next = patchResource(resource)
      if (next !== resource) didUpdateBucket = true
      return next
    })
    if (didUpdateBucket) didUpdateBuckets = true
    nextResourcesBySpaceId[cacheKey] = didUpdateBucket ? nextBucket : bucket
  }

  if (didUpdateResources || didUpdateBuckets) {
    useUnifiedResources.setState({
      ...(didUpdateResources ? { resources: nextResources } : {}),
      ...(didUpdateBuckets ? { resourcesBySpaceId: nextResourcesBySpaceId } : {}),
    })
  }
}

export async function renameResourceContextItemTitle(input: {
  item: SearchResultItem
  title: string
  emitResourceUpdated: (event: ResourceWsEvent) => void
}): Promise<void> {
  const { item, emitResourceUpdated } = input
  const title = input.title.trim()
  if (!title) return

  const resourceType = contextRegistry.normalizeBackendType(item.item_type)
  const previousTitle = item.title

  applyLocalResourceTitle({
    resourceType,
    resourceId: item.resource_id,
    title,
    spaceId: item.space_id ?? undefined,
  })

  const resolveEventSpaceId = (nextSpaceId?: string | null) =>
    nextSpaceId ?? item.space_id ?? ''
  const resolveEventOrganizationId = (nextOrganizationId?: string | null) =>
    nextOrganizationId ?? item.organization_id

  try {
  if (resourceType === 'tabdoc') {
    const updated = await updateDocument(getSharedAppHostClient(), item.resource_id, { title })
    emitResourceUpdated({
      type: 'resource_updated',
      resource_type: resourceType,
      resource_id: updated.id || item.resource_id,
      title: updated.title,
      space_id: resolveEventSpaceId(updated.space_id),
      organization_id: resolveEventOrganizationId(),
      updated_at: updated.updated_at,
    })
    return
  }

  if (resourceType === 'tabdata') {
    const updated = await tableStore.getState().updateTable(item.resource_id, { name: title })
    if (!updated) {
      throw new Error(tableStore.getState().error ?? '更新表格失败')
    }
    emitResourceUpdated({
      type: 'resource_updated',
      resource_type: resourceType,
      resource_id: updated.id || item.resource_id,
      title: updated.name,
      space_id: resolveEventSpaceId(updated.space_id),
      organization_id: resolveEventOrganizationId(),
      updated_at: updated.updated_at,
    })
    return
  }

  if (resourceType === 'tabslide') {
    const updated = await apiService.request<NamedResourceUpdateResponse>({
      method: 'PATCH',
      url: `/tabslide/projects/${item.resource_id}/`,
      data: { name: title },
    })
    emitResourceUpdated({
      type: 'resource_updated',
      resource_type: resourceType,
      resource_id: updated.id || item.resource_id,
      title: updated.name || title,
      space_id: resolveEventSpaceId(updated.space_id),
      organization_id: resolveEventOrganizationId(),
      updated_at: updated.updated_at,
    })
    return
  }

  if (resourceType === 'tabtracker') {
    const updated = await updateTrackerTask(item.resource_id, { name: title })
    emitResourceUpdated({
      type: 'resource_updated',
      resource_type: resourceType,
      resource_id: updated.id || item.resource_id,
      title: updated.name || title,
      space_id: resolveEventSpaceId(updated.space_id),
      organization_id: resolveEventOrganizationId(),
      updated_at: updated.updated_at,
    })
    return
  }

  const updated = await SpaceApiService.renameContextItem(item.id, title)
  emitResourceUpdated({
    type: 'resource_updated',
    resource_type: updated.item_type,
    resource_id: updated.resource_id,
    title: updated.title,
    space_id: resolveEventSpaceId(updated.space_id),
    organization_id: resolveEventOrganizationId(updated.organization_id),
    metadata: updated.metadata,
    preview: updated.preview,
    updated_at: updated.updated_at,
    is_pinned: updated.is_pinned,
    pinned_at: updated.pinned_at,
  })
  } catch (err) {
    applyLocalResourceTitle({
      resourceType,
      resourceId: item.resource_id,
      title: previousTitle,
      spaceId: item.space_id ?? undefined,
    })
    throw err
  }
}

/** 重命名失败时弹出与右键菜单一致的 toast，并继续抛出供内联编辑回退。 */
export async function renameResourceWithFeedback(input: {
  item: SearchResultItem
  title: string
  emitResourceUpdated: (event: ResourceWsEvent) => void
  t: (key: string, opts?: Record<string, unknown>) => string
  logLabel?: string
}): Promise<void> {
  try {
    await renameResourceContextItemTitle({
      item: input.item,
      title: input.title,
      emitResourceUpdated: input.emitResourceUpdated,
    })
  } catch (err) {
    console.error(`[${input.logLabel ?? 'renameResource'}] rename failed:`, err)
    const errorMessage = err instanceof Error ? err.message : undefined
    const isDuplicateNameError = isDuplicateNameErrorMessage(errorMessage)
    toast.error(isDuplicateNameError ? undefined : errorMessage, {
      title: isDuplicateNameError
        ? DUPLICATE_NAME_ERROR_TITLE
        : input.t('errorToast.renameFailed', { defaultValue: '重命名失败' }),
      duration: 6000,
    })
    throw err
  }
}

export function useResourceContextMenu(
  spaceId: string,
  options?: { onForeignSharedMoved?: () => void; onForeignSharedRemoved?: () => void; organizationId?: string },
) {
  const { t } = useTranslation('context')
  const [menuState, setMenuState] = useState<MenuState>(MENU_INITIAL)
  const [deletingItemIds, setDeletingItemIds] = useState<Set<string>>(() => new Set())
  const handleResourceWsEvent = useUnifiedResources(s => s.handleWsEvent)
  const onForeignSharedMoved = options?.onForeignSharedMoved
  const onForeignSharedRemoved = options?.onForeignSharedRemoved
  const fallbackOrganizationId = options?.organizationId
  const handleStructuralEvent = useUnifiedResources(s => s.handleStructuralEvent)

  const handleContextMenu = useCallback((e: React.MouseEvent, item: SearchResultItem) => {
    e.preventDefault()
    if (deletingItemIds.has(item.id)) return
    setMenuState({ open: true, pos: { x: e.clientX, y: e.clientY }, item })
  }, [deletingItemIds])

  const closeMenu = useCallback(() => {
    setMenuState(prev => ({ ...prev, open: false }))
  }, [])

  const handleTogglePin = useCallback(async () => {
    const item = menuState.item
    if (!item || item.id.startsWith('local:')) return
    try {
      const updated = await SpaceApiService.pinContextItem(item.id, !item.is_pinned)
      handleResourceWsEvent({
        type: 'resource_updated',
        resource_type: updated.item_type,
        resource_id: updated.resource_id,
        title: updated.title,
        space_id: updated.space_id ?? item.space_id ?? '',
        organization_id: updated.organization_id ?? item.organization_id,
        metadata: updated.metadata,
        preview: updated.preview,
        is_pinned: updated.is_pinned,
        pinned_at: updated.pinned_at,
      })
    } catch (err) {
      console.error('[ResourceContextMenu] pin/unpin failed:', err)
      toast.error(t('errorToast.pinFailed'))
    }
  }, [handleResourceWsEvent, menuState.item, t])

  const handleMoveToCollection = useCallback(async (collectionId: string | null) => {
    const item = menuState.item
    const sharedMeta = item ? resolveSharedPlacementMeta(item, fallbackOrganizationId) : null
    if (item && sharedMeta) {
      try {
        await moveSharedResourcePlacement({
          organizationId: sharedMeta.organizationId,
          resourceType: sharedMeta.resourceType,
          resourceId: sharedMeta.resourceId,
          collectionId,
        })
        onForeignSharedMoved?.()
      } catch (err) {
        log.error('shared placement move failed', err)
        toast.error(t('errorToast.collectionMoveFailed', { defaultValue: 'Failed to move item' }))
      }
      closeMenu()
      return
    }
    if (!item || !isMovableContextItemId(item.id)) {
      if (item) {
        toast.warning(t('home.assetBrowser.itemStillSyncing', {
          defaultValue: '资源仍在同步，请稍后再试',
        }))
        void useUnifiedResources.getState().load(spaceId, true, 'organization')
        void useUnifiedResources.getState().load(spaceId, true, 'space')
      }
      return
    }
    try {
      const updated = await useCollections.getState().moveItems(spaceId, [item.id], collectionId)
      handleStructuralEvent({ type: 'items_moved', space_id: spaceId })
      console.info('[ResourceContextMenu] move succeeded', {
        spaceId,
        itemId: item.id,
        collectionId,
        updated,
        itemType: item.item_type,
      })
    } catch (err) {
      console.error('[ResourceContextMenu] move failed:', err)
      toast.error(t('errorToast.collectionMoveFailed', { defaultValue: 'Failed to move item' }))
    }
    closeMenu()
  }, [closeMenu, fallbackOrganizationId, handleStructuralEvent, menuState.item, onForeignSharedMoved, spaceId, t])

  const handleRemoveForeignShared = useCallback(async () => {
    const item = menuState.item
    const sharedMeta = item ? resolveSharedPlacementMeta(item, fallbackOrganizationId) : null
    if (!item || !sharedMeta) return
    try {
      await dismissSharedResourcePlacement({
        organizationId: sharedMeta.organizationId,
        resourceType: sharedMeta.resourceType,
        resourceId: sharedMeta.resourceId,
      })
      toast.success('已从云盘移除')
      onForeignSharedRemoved?.()
    } catch (err) {
      log.error('shared resource removal failed', err)
      toast.error(t('errorToast.collectionMoveFailed', { defaultValue: '移除失败' }))
    }
    closeMenu()
  }, [closeMenu, fallbackOrganizationId, menuState.item, onForeignSharedRemoved, t])

  const handleRenameItem = useCallback(async (item: SearchResultItem, newTitle: string) => {
    if (!item || item.id.startsWith('local:') || !newTitle.trim()) return
    await renameResourceWithFeedback({
      item,
      title: newTitle,
      emitResourceUpdated: handleResourceWsEvent,
      t,
      logLabel: 'ResourceContextMenu',
    })
  }, [handleResourceWsEvent, t])

  const handleRename = useCallback(async (newTitle: string) => {
    const item = menuState.item
    if (!item) return
    await handleRenameItem(item, newTitle)
  }, [handleRenameItem, menuState.item])

  const handleArchive = useCallback(async () => {
    const item = menuState.item
    if (!item || item.id.startsWith('local:') || deletingItemIds.has(item.id)) return
    setDeletingItemIds(prev => new Set(prev).add(item.id))
    // ：列表归一化后 tabfiles→file；组织级 trash 必须带 organization_id。
    // 与云盘批删对齐：缺省时从当前 Space 回填，避免 silent fallback 到 archive。
    const spaceOrgId = useSpaceStore.getState().spaces.find(s => s.id === spaceId)?.organization_id
    const organizationId = item.organization_id ?? (spaceOrgId ? String(spaceOrgId) : null)
    try {
      const movedToTrash = await SpaceApiService.trashContextResource({
        ...item,
        organization_id: organizationId,
      })
      if (!movedToTrash) {
        await SpaceApiService.archiveContextItem(item.id)
      }
      handleResourceWsEvent({
        type: movedToTrash ? 'resource_trashed' : 'resource_archived',
        resource_type: item.item_type,
        resource_id: item.resource_id,
        space_id: item.space_id ?? '',
        organization_id: organizationId,
      })
    } catch (err) {
      // 面包屑 / Sentry 对 Error 对象常序列化成 {}，显式带上 message 便于诊断包取证
      const message = err instanceof Error ? err.message : String(err ?? '')
      console.error('[ResourceContextMenu] archive failed:', message || err)
      setDeletingItemIds(prev => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
      toast.error(message || t('errorToast.archiveFailed', { defaultValue: 'Delete failed' }))
    }
    closeMenu()
  }, [closeMenu, deletingItemIds, handleResourceWsEvent, menuState.item, spaceId, t])

  return {
    menuState, handleContextMenu, closeMenu,
    handleTogglePin, handleMoveToCollection, handleRemoveForeignShared, handleRename, handleRenameItem, handleArchive,
    deletingItemIds,
    isDeletingItem: (itemId: string) => deletingItemIds.has(itemId),
  } as const
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ResourceContextMenuOverlayProps {
  spaceId: string
  organizationId?: string | null
  menuState: MenuState
  onClose: () => void
  onTogglePin: () => void
  onMoveToCollection?: (collectionId: string | null) => void
  onRename?: (newTitle: string) => void | Promise<void>
  onArchive?: () => void
  onRemoveForeignShared?: () => void
  folderConfirm: ReturnType<typeof useRemoveFolderConfirm>
}

export const ResourceContextMenuOverlay: React.FC<ResourceContextMenuOverlayProps> = ({
  spaceId,
  organizationId,
  menuState,
  onClose,
  onTogglePin,
  onMoveToCollection,
  onRename,
  onArchive,
  onRemoveForeignShared,
  folderConfirm,
}) => {
  const { t } = useTranslation('context')
  const { confirmState, requestRemove, executeRemove, cancelRemove } = folderConfirm
  const item = menuState.item
  const isLocal = item?.id.startsWith('local:') ?? false
  const isFolder = item?.item_type === 'tabfolder'
  // 列表归一化后后端 tabfiles 会变成前端 file；能力位 / 分享类型必须两边都认。
  const isCloudItem =
    item?.item_type === 'tabdoc'
    || item?.item_type === 'tabdata'
    || item?.item_type === 'tabfiles'
    || item?.item_type === 'file'
  // ：云资产严格按 can_*；非云资产缺省放行，避免误伤本地资源。
  // 注意：后端 enrich_item_capabilities 对非云资产会显式回填 can_edit/can_move/
  // can_trash=false（非 undefined），因此这里不能用 `!== false` 判空——那样等于
  // 恒为 false，会把 Rename/Move/Archive 菜单项对所有非云资产资源类型隐藏。
  const canEdit = isCloudItem ? item?.can_edit === true : true
  const isForeignShared = Boolean(
    (item?.metadata as { foreignShared?: boolean } | undefined)?.foreignShared,
  )
  // Shared resources are recipient-owned placements. Their legacy projection
  // may not carry can_move yet, but the placement endpoint is still movable.
  const canMove = isForeignShared || (isCloudItem ? item?.can_move === true : true)
  const canTrash = isCloudItem ? item?.can_trash === true : true
  const canInviteCollaborators = Boolean(
    !isLocal && isCloudItem && item?.resource_id && item?.can_share === true,
  )

  const spaceOrganizationId = useSpaceStore(s => {
    const sp = s.spaces.find(x => x.id === spaceId)
    return sp?.organization_id ? String(sp.organization_id) : ''
  })
  const shareOrganizationId = String(item?.organization_id || spaceOrganizationId || '')
  const shareResourceType =
    item?.item_type === 'tabdata'
      ? 'table' as const
      : (item?.item_type === 'tabfiles' || item?.item_type === 'file')
        ? 'file' as const
        : 'doc' as const

  const { collections: spaceCollections } = useCollectionsBySpace(spaceId)
  const { collections: organizationCollections } = useCollectionsByOrganization(organizationId)
  const collections = organizationId ? organizationCollections : spaceCollections
  const allCollFlat = useMemo(() => flattenCollections(collections), [collections])
  const hasCollections = allCollFlat.length > 0

  const [movePicker, setMovePicker] = useState<{
    open: boolean
    pos: { x: number; y: number }
  }>({ open: false, pos: { x: 0, y: 0 } })
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [sendToIMOpen, setSendToIMOpen] = useState(false)

  // ：除文件夹外均可发送；优先当前对话，否则走「新任务」草稿（与拖入对话同构）
  const canSendToChat = !isLocal && !isFolder
  const canSendToIM = Boolean(item && canSendResourceToIM(item))
  const sendToChatLabel = t('home.sendToChat', { defaultValue: '发送到对话' })
  const sendToIMLabel = t('home.sendToIM', { defaultValue: '发送到私信' })
  const inviteCollaboratorsLabel = shareResourceType === 'file'
    ? t('home.shareFile', { defaultValue: '分享文件' })
    : t('home.inviteCollaborators', { defaultValue: '邀请协作者' })

  const handleSendToChat = useCallback(() => {
    if (!canSendToChat || !item) return
    onClose()
    const payload = buildSpaceItemChatContextDragPayload(item, contextRegistry)
    if (!payload) {
      toast({
        title: t('tab.menu.addToChatFailedTitle', {
          defaultValue: '无法加入对话',
        }),
        description: t('tab.menu.addToChatFailedDesc', {
          defaultValue: '请等待页面加载完成后再试',
        }),
        variant: 'destructive',
      })
      return
    }
    const result = deliverContextInjectToChat(payload)
    // active-scope 路径由调用方补 toast；其余模式 deliver 内已提示
    if (result.ok && result.mode === 'active-scope') {
      toast({
        title: t('tab.menu.addToChatSuccess', { defaultValue: '已加入对话' }),
        description: payload.label,
      })
    }
  }, [canSendToChat, item, onClose, t])

  const handleSendToIM = useCallback(() => {
    if (!canSendToIM || !item) return
    onClose()
    setSendToIMOpen(true)
  }, [canSendToIM, item, onClose])

  const handleStartInvite = useCallback(() => {
    if (!canInviteCollaborators) return
    onClose()
    setInviteOpen(true)
  }, [canInviteCollaborators, onClose])

  const handleRemoveFolder = useCallback(() => {
    if (!item || !isFolder) return
    onClose()
    requestRemove(item.resource_id, item.title)
  }, [item, isFolder, onClose, requestRemove])

  const handleMoveSelect = useCallback((collId: string | null) => {
    setMovePicker({ open: false, pos: { x: 0, y: 0 } })
    onMoveToCollection?.(collId)
  }, [onMoveToCollection])

  const openMovePicker = useCallback(() => {
    setMovePicker({ open: true, pos: menuState.pos })
    onClose()
  }, [menuState.pos, onClose])

  const handleStartRename = useCallback(() => {
    if (!item) return
    setRenameValue(item.title || '')
    setRenameOpen(true)
    onClose()
  }, [item, onClose])

  const handleCommitRename = useCallback(async () => {
    if (renameValue.trim() && renameValue.trim() !== item?.title) {
      await onRename?.(renameValue.trim())
    }
    setRenameOpen(false)
  }, [item?.title, onRename, renameValue])

  const handleRenameInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    handleCommitRename().catch(() => {
      // onRename already reports the failure; keep the dialog open without leaking a rejected promise.
    })
  }, [handleCommitRename])

  const handleStartDelete = useCallback(() => {
    onClose()
    setDeleteConfirmOpen(true)
  }, [onClose])

  const handleConfirmDelete = useCallback(() => {
    setDeleteConfirmOpen(false)
    onArchive?.()
  }, [onArchive])

  return (
    <>
      <ContextMenu
        open={menuState.open}
        onClose={onClose}
        anchorPosition={menuState.pos}
        className="w-48"
      >
        {item && !isLocal && (
          <ContextMenuItem
            icon={item.is_pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            label={item.is_pinned ? t('home.unpin') : t('home.pin')}
            onClick={onTogglePin}
          />
        )}
        {item && !isLocal && onRename && canEdit && (
          <ContextMenuItem
            icon={<Pencil className="h-4 w-4" />}
            label={t('home.rename', { defaultValue: 'Rename' })}
            onClick={handleStartRename}
          />
        )}
        {item && canInviteCollaborators && (
          <ContextMenuItem
            icon={<Share2 className="h-4 w-4" />}
            label={inviteCollaboratorsLabel}
            onClick={handleStartInvite}
          />
        )}
        {item && canSendToChat && (
          <ContextMenuItem
            icon={<MessageSquare className="h-4 w-4" />}
            label={sendToChatLabel}
            onClick={handleSendToChat}
          />
        )}
        {item && canSendToIM && (
          <ContextMenuItem
            icon={<Send className="h-4 w-4" />}
            label={sendToIMLabel}
            onClick={handleSendToIM}
          />
        )}
        {item && !isLocal && hasCollections && onMoveToCollection && canMove && (
          <ContextMenuItem
            icon={<FolderInput className="h-4 w-4" />}
            label={t('sidebar.moveToCollection', { defaultValue: 'Move to folder' })}
            onClick={openMovePicker}
          />
        )}
        {item && !isLocal && item.collection_id && onMoveToCollection && canMove && (
          <ContextMenuItem
            icon={<FolderOutput className="h-4 w-4" />}
            label={t('sidebar.removeFromCollection', { defaultValue: 'Remove from folder' })}
            onClick={() => handleMoveSelect(null)}
          />
        )}
        {item && !isLocal && isForeignShared && onRemoveForeignShared && (
          <ContextMenuItem
            icon={<FolderOutput className="h-4 w-4" />}
            label="从云盘移除"
            onClick={onRemoveForeignShared}
          />
        )}
        {item && isFolder && (
          <ContextMenuItem
            icon={<FolderMinus className="h-4 w-4" />}
            label={t('home.removeFolder')}
            onClick={handleRemoveFolder}
            danger
          />
        )}
        {item && !isLocal && !isFolder && onArchive && canTrash && (
          <>
            <div className="mx-1 my-0.5 border-t border-border/20" />
            <ContextMenuItem
              icon={<Trash2 className="h-4 w-4" />}
              label={t('home.delete', { defaultValue: 'Delete' })}
              onClick={handleStartDelete}
              danger
            />
          </>
        )}
      </ContextMenu>

      {inviteOpen && item?.resource_id && (
        <ShareDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          resourceType={shareResourceType}
          resourceId={item.resource_id}
          resourceTitle={item.title || ''}
          organizationId={shareOrganizationId}
          shareUrlPrefix={
            shareResourceType === 'file'
              ? undefined
              : buildPublicShareUrlPrefix(shareResourceType)
          }
          canManage={canInviteCollaborators}
        />
      )}

      {sendToIMOpen && item && (
        <SendToIMDialog
          open={sendToIMOpen}
          onOpenChange={setSendToIMOpen}
          resource={item}
          organizationId={shareOrganizationId || undefined}
          canGrantResourceAccess={canInviteCollaborators}
        />
      )}

      <CollectionMovePickerOverlay
        open={movePicker.open}
        anchorPosition={movePicker.pos}
        collections={collections}
        onClose={() => setMovePicker({ open: false, pos: { x: 0, y: 0 } })}
        onSelect={collId => handleMoveSelect(collId)}
        onSelectRoot={item?.collection_id ? () => handleMoveSelect(null) : undefined}
        canSelectCollection={coll => coll.id !== item?.collection_id}
        highlightCollectionId={item?.collection_id ?? null}
      />

      {/* Rename dialog */}
      <ConfirmDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={t('home.renameDialog.title', { defaultValue: 'Rename' })}
        confirmText={t('home.renameDialog.confirm', { defaultValue: 'Save' })}
        onConfirm={handleCommitRename}
      >
        <input
          autoFocus
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-body outline-none focus:ring-1 focus:ring-primary/60"
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={handleRenameInputKeyDown}
        />
      </ConfirmDialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('home.deleteConfirm.title', { defaultValue: 'Delete resource' })}
        description={t('home.deleteConfirm.description', {
          defaultValue: 'This will move "{{name}}" to trash.',
          name: item?.title || '',
        })}
        confirmText={t('home.deleteConfirm.confirm', { defaultValue: 'Delete' })}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />

      {/* Folder removal confirm (pre-existing) */}
      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => { if (!open) cancelRemove() }}
        title={t('home.removeFolderConfirm.title')}
        description={t('home.removeFolderConfirm.description', { name: confirmState.title })}
        confirmText={t('home.removeFolderConfirm.confirm')}
        variant="destructive"
        onConfirm={executeRemove}
      />
    </>
  )
}
