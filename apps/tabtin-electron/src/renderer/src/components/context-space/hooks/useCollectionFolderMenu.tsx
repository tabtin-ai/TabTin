import React, { useCallback, useRef, useState } from 'react'
import { FolderInput, MessageSquare, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import {
  ConfirmDialog,
  ContextMenu,
  ContextMenuItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'

import { useCollections } from '@/stores/useCollections'
import { useUnifiedResources } from '@/stores/useUnifiedResources'
import type { SpaceCollection } from '@/services/spaceApi'
import { createLogger } from '@/utils/logger'

import {
  canMoveCollectionTo,
  collectCollectionTreeIds,
  findCollectionById,
} from './collectionFolderTree'
import { COLLECTION_FOLDER_MIME } from './collectionMime'
import { CollectionMovePickerOverlay } from '../CollectionMovePickerOverlay'

const log = createLogger('CollectionFolderDnD')

interface UseCollectionFolderMenuOptions {
  spaceId: string
  collections: SpaceCollection[]
  currentBrowseFolderId: string | null
  onBrowseFolderChange: (folderId: string | null) => void
}

export function useCollectionFolderMenu({
  spaceId,
  collections,
  currentBrowseFolderId,
  onBrowseFolderChange,
}: UseCollectionFolderMenuOptions) {
  const { t } = useTranslation('context')
  const updateCollection = useCollections(s => s.updateCollection)
  const deleteCollection = useCollections(s => s.deleteCollection)
  const handleStructuralEvent = useUnifiedResources(s => s.handleStructuralEvent)

  const [folderMenu, setFolderMenu] = useState<{
    open: boolean
    pos: { x: number; y: number }
    collection: SpaceCollection | null
  }>({ open: false, pos: { x: 0, y: 0 }, collection: null })
  const [renamingFolder, setRenamingFolder] = useState<SpaceCollection | null>(null)
  const [renameFolderValue, setRenameFolderValue] = useState('')
  const [deletingFolder, setDeletingFolder] = useState<SpaceCollection | null>(null)
  const [movePicker, setMovePicker] = useState<{
    open: boolean
    pos: { x: number; y: number }
    collection: SpaceCollection | null
  }>({ open: false, pos: { x: 0, y: 0 }, collection: null })
  // Windows/Chromium：dragStart 同步 setState 会取消原生拖拽；载荷走 ref，视觉态延后 rAF。
  const draggingFolderIdRef = useRef<string | null>(null)
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)

  const closeFolderMenu = useCallback(() => {
    setFolderMenu(prev => ({ ...prev, open: false }))
  }, [])

  const openFolderMenu = useCallback((event: React.MouseEvent, collection: SpaceCollection) => {
    event.preventDefault()
    event.stopPropagation()
    setFolderMenu({ open: true, pos: { x: event.clientX, y: event.clientY }, collection })
  }, [])

  const openMovePicker = useCallback(() => {
    if (!folderMenu.collection) return
    setMovePicker({
      open: true,
      pos: folderMenu.pos,
      collection: folderMenu.collection,
    })
    closeFolderMenu()
  }, [closeFolderMenu, folderMenu.collection, folderMenu.pos])

  const startRenameFolder = useCallback((collection: SpaceCollection) => {
    setRenamingFolder(collection)
    setRenameFolderValue(collection.name)
    closeFolderMenu()
  }, [closeFolderMenu])

  const confirmRenameFolder = useCallback(async () => {
    if (!renamingFolder) return
    const nextName = renameFolderValue.trim()
    if (!nextName || nextName === renamingFolder.name) {
      setRenamingFolder(null)
      return
    }
    try {
      await updateCollection(renamingFolder.id, { name: nextName })
      handleStructuralEvent({ type: 'collection_updated', space_id: spaceId })
      setRenamingFolder(null)
    } catch (err) {
      console.error('[CollectionFolderMenu] rename collection failed:', err)
      toast.error(t('errorToast.collectionRenameFailed', { defaultValue: 'Rename failed' }))
    }
  }, [handleStructuralEvent, renameFolderValue, renamingFolder, spaceId, t, updateCollection])

  const handleToggleFolderPin = useCallback(async () => {
    const collection = folderMenu.collection
    if (!collection) return
    closeFolderMenu()
    try {
      await updateCollection(collection.id, { is_pinned: !collection.is_pinned })
      handleStructuralEvent({ type: 'collection_updated', space_id: spaceId })
    } catch (err) {
      console.error('[CollectionFolderMenu] pin/unpin collection failed:', err)
      toast.error(t('errorToast.pinFailed', { defaultValue: 'Pin failed' }))
    }
  }, [closeFolderMenu, folderMenu.collection, handleStructuralEvent, spaceId, t, updateCollection])

  const confirmDeleteFolder = useCallback(async () => {
    if (!deletingFolder) return
    try {
      const deletedCollectionIds = collectCollectionTreeIds(deletingFolder)
      await deleteCollection(deletingFolder.id)
      if (currentBrowseFolderId === deletingFolder.id) {
        onBrowseFolderChange(null)
      }
      handleStructuralEvent({
        type: 'collection_deleted',
        space_id: spaceId,
        collection_id: deletingFolder.id,
        collection_ids: deletedCollectionIds,
      })
      setDeletingFolder(null)
    } catch (err) {
      console.error('[CollectionFolderMenu] delete collection failed:', err)
      toast.error(t('errorToast.collectionDeleteFailed'))
    }
  }, [
    currentBrowseFolderId,
    deleteCollection,
    deletingFolder,
    handleStructuralEvent,
    onBrowseFolderChange,
    spaceId,
    t,
  ])

  const moveFolder = useCallback(async (collection: SpaceCollection, parentId: string | null) => {
    if (!canMoveCollectionTo(collections, collection, parentId)) return
    try {
      await updateCollection(collection.id, { parent_id: parentId })
      handleStructuralEvent({ type: 'collection_updated', space_id: spaceId })
    } catch (err) {
      console.error('[CollectionFolderMenu] move collection failed:', err)
      toast.error(t('errorToast.collectionMoveFailed'))
    } finally {
      closeFolderMenu()
    }
  }, [closeFolderMenu, collections, handleStructuralEvent, spaceId, t, updateCollection])

  const handleFolderDragStart = useCallback((event: React.DragEvent, collection: SpaceCollection) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(COLLECTION_FOLDER_MIME, collection.id)
    draggingFolderIdRef.current = collection.id
    log.info('folder dragStart', { folderId: collection.id })
    requestAnimationFrame(() => {
      if (draggingFolderIdRef.current === collection.id) {
        setDraggingFolderId(collection.id)
      }
    })
  }, [])

  const handleFolderDragEnd = useCallback(() => {
    draggingFolderIdRef.current = null
    setDraggingFolderId(null)
    log.info('folder dragEnd')
  }, [])

  const isFolderDragActive = useCallback(() => Boolean(draggingFolderIdRef.current), [])

  const handleFolderDragOver = useCallback((event: React.DragEvent, target: SpaceCollection) => {
    const sourceId = draggingFolderIdRef.current || event.dataTransfer.getData(COLLECTION_FOLDER_MIME)
    if (!sourceId) return
    const source = findCollectionById(collections, sourceId)
    if (!source || !canMoveCollectionTo(collections, source, target.id)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
  }, [collections])

  /** 拖到面包屑祖先 / 根（parentId=null），对齐资源  */
  const handleFolderDragOverParent = useCallback((event: React.DragEvent, parentId: string | null): boolean => {
    const sourceId = draggingFolderIdRef.current || event.dataTransfer.getData(COLLECTION_FOLDER_MIME)
    if (!sourceId) return false
    const source = findCollectionById(collections, sourceId)
    if (!source || !canMoveCollectionTo(collections, source, parentId)) return false
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    return true
  }, [collections])

  const handleFolderDrop = useCallback((event: React.DragEvent, target: SpaceCollection) => {
    const sourceId = draggingFolderIdRef.current || event.dataTransfer.getData(COLLECTION_FOLDER_MIME)
    const usedRefFallback = !event.dataTransfer.getData(COLLECTION_FOLDER_MIME)
    if (!sourceId) return
    const source = findCollectionById(collections, sourceId)
    if (!source) return
    event.preventDefault()
    event.stopPropagation()
    draggingFolderIdRef.current = null
    setDraggingFolderId(null)
    log.info('folder drop', {
      sourceId,
      targetId: target.id,
      usedRefFallback,
    })
    void moveFolder(source, target.id)
  }, [collections, moveFolder])

  const handleFolderDropToParent = useCallback((event: React.DragEvent, parentId: string | null) => {
    const sourceId = draggingFolderIdRef.current || event.dataTransfer.getData(COLLECTION_FOLDER_MIME)
    const usedRefFallback = !event.dataTransfer.getData(COLLECTION_FOLDER_MIME)
    if (!sourceId) return
    const source = findCollectionById(collections, sourceId)
    if (!source) return
    event.preventDefault()
    event.stopPropagation()
    draggingFolderIdRef.current = null
    setDraggingFolderId(null)
    log.info('folder drop to breadcrumb parent', {
      sourceId,
      parentId,
      usedRefFallback,
    })
    void moveFolder(source, parentId)
  }, [collections, moveFolder])

  const renderCollectionFolderMenuLayer = () => (
    <>
      <ContextMenu
        open={folderMenu.open}
        onClose={closeFolderMenu}
        anchorPosition={folderMenu.pos}
        className="w-48"
      >
        {folderMenu.collection && (
          <>
            <ContextMenuItem
              icon={folderMenu.collection.is_pinned
                ? <PinOff className="h-4 w-4" />
                : <Pin className="h-4 w-4" />}
              label={folderMenu.collection.is_pinned
                ? t('home.unpin', { defaultValue: '取消置顶' })
                : t('home.pin', { defaultValue: '置顶' })}
              onClick={() => { void handleToggleFolderPin() }}
            />
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="w-full">
                    <ContextMenuItem
                      icon={<MessageSquare className="h-4 w-4" />}
                      label={t('home.sendToChat', { defaultValue: '发送到对话' })}
                      disabled
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[220px]">
                  {t('home.sendToChatSupportedTypesHint', {
                    defaultValue: '文件夹不支持发送到对话',
                  })}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <ContextMenuItem
              icon={<FolderInput className="h-4 w-4" />}
              label={t('sidebar.moveToCollection', { defaultValue: 'Move to...' })}
              onClick={openMovePicker}
            />
            <ContextMenuItem
              icon={<Pencil className="h-4 w-4" />}
              label={t('collectionsView.rename', { defaultValue: 'Rename' })}
              onClick={() => folderMenu.collection && startRenameFolder(folderMenu.collection)}
            />
            <div className="mx-1 my-0.5 border-t border-border/20" />
            <ContextMenuItem
              icon={<Trash2 className="h-4 w-4 text-destructive" />}
              label={t('collectionsView.delete', { defaultValue: 'Delete collection' })}
              onClick={() => {
                if (folderMenu.collection) setDeletingFolder(folderMenu.collection)
                closeFolderMenu()
              }}
              className="text-destructive"
            />
          </>
        )}
      </ContextMenu>

      <CollectionMovePickerOverlay
        open={movePicker.open}
        anchorPosition={movePicker.pos}
        collections={collections}
        onClose={() => setMovePicker({ open: false, pos: { x: 0, y: 0 }, collection: null })}
        onSelect={collId => {
          if (movePicker.collection) void moveFolder(movePicker.collection, collId)
          setMovePicker({ open: false, pos: { x: 0, y: 0 }, collection: null })
        }}
        onSelectRoot={
          movePicker.collection && canMoveCollectionTo(collections, movePicker.collection, null)
            ? () => {
                if (movePicker.collection) void moveFolder(movePicker.collection, null)
                setMovePicker({ open: false, pos: { x: 0, y: 0 }, collection: null })
              }
            : undefined
        }
        canSelectCollection={coll =>
          movePicker.collection
            ? canMoveCollectionTo(collections, movePicker.collection, coll.id)
            : false
        }
      />

      <ConfirmDialog
        open={!!renamingFolder}
        onOpenChange={(open: boolean) => { if (!open) setRenamingFolder(null) }}
        title={t('collectionsView.rename', { defaultValue: 'Rename' })}
        confirmText={t('home.renameDialog.confirm', { defaultValue: 'Save' })}
        onConfirm={confirmRenameFolder}
      >
        <input
          autoFocus
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-body outline-none focus:ring-1 focus:ring-primary/60"
          value={renameFolderValue}
          onChange={event => setRenameFolderValue(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void confirmRenameFolder() }}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deletingFolder}
        onOpenChange={(open: boolean) => { if (!open) setDeletingFolder(null) }}
        title={t('collectionsView.deleteConfirmTitle', { defaultValue: 'Delete collection' })}
        description={t('collectionsView.deleteConfirmDesc', {
          name: deletingFolder?.name ?? '',
          count: deletingFolder?.item_count ?? 0,
        })}
        confirmText={t('collectionsView.confirmDelete', { defaultValue: 'Delete' })}
        cancelText={t('collectionsView.cancel', { defaultValue: 'Cancel' })}
        variant="destructive"
        onConfirm={confirmDeleteFolder}
      />
    </>
  )

  return {
    openFolderMenu,
    draggingFolderId,
    isFolderDragActive,
    handleFolderDragStart,
    handleFolderDragEnd,
    handleFolderDragOver,
    handleFolderDragOverParent,
    handleFolderDrop,
    handleFolderDropToParent,
    renderCollectionFolderMenuLayer,
  }
}
