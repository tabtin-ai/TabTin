/**
 * CollectionsView — 合集标签的完整视图
 *
 * 类似 macOS Finder 的文件夹体验：
 * - 根视图：合集文件夹卡片 + 未归类资源卡片 平铺展示
 * - 合集详情视图：点击合集进入，面包屑导航返回
 * - 拖拽资源到资源 → 自动创建合集
 * - 拖拽资源到合集文件夹 → 移入合集
 * - 右键空白处 → 创建合集
 * - 右键合集 → 重命名 / 删除（含确认）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MIN_CARD_WIDTH_DEFAULT, resourceGridTemplateColumns } from './constants'
import {
  ChevronRight, FolderPlus, Pencil, Trash2,
  FolderInput, FolderOutput, Plus,
} from 'lucide-react'
import { ContextMenu, ContextMenuItem, ConfirmDialog, toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useCollections, useCollectionsBySpace } from '@/stores/useCollections'
import { useSpaceUnifiedResources, useUnifiedResources } from '@/stores/useUnifiedResources'
import { useInlineEdit } from './hooks/useInlineEdit'
import { useCollectionDnD } from './hooks/useCollectionDnD'
import { ResourceGridCard } from './registry/homeSections/ResourceGridCard'
import { ResourceListItem } from './registry/homeSections/ResourceListItem'
import { ContextListPanelBreadcrumb } from './ContextListPanelBreadcrumb'
import { ResourceCollectionSkeleton } from '@components/common/ListSkeletons'
import { extractThumbnail } from './registry/homeSections/resourcePreview'
import { collectCollectionTreeIds } from './hooks/collectionFolderTree'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { OVERLAY_SURFACE_CLASS, ScrollArea } from '@components/ui'
import { SIDEBAR_LIST_PANEL, SIDEBAR_LIST_PANEL_HEADER, SIDEBAR_LIST_PANEL_SCROLL } from '@components/layout/sidebarUi'
import type { SpaceContextItem as SearchResultItem } from '@/services/spaceApi'
import type { SpaceCollection } from '@/services/spaceApi'
import type { Table as TableType } from '@tabtin/table-core'
import type { HomeViewMode } from './registry/homeSections/HomeGridCard'

function findCollectionById(nodes: SpaceCollection[], id: string): SpaceCollection | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children?.length) {
      const f = findCollectionById(n.children, id)
      if (f) return f
    }
  }
  return null
}

function getCollectionPath(nodes: SpaceCollection[], id: string): SpaceCollection[] {
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

function sortChildren(coll: SpaceCollection): SpaceCollection[] {
  return [...(coll.children ?? [])].sort((a, b) => a.order - b.order)
}

interface CollectionsViewProps {
  spaceId: string
  tables: TableType[]
  viewMode: HomeViewMode
  onSearchNavigate?: (item: SearchResultItem) => void
}

export const CollectionsView: React.FC<CollectionsViewProps> = ({
  spaceId,
  tables,
  viewMode,
  onSearchNavigate,
}) => {
  const { t } = useTranslation('context')
  const { collections, isLoading: isCollLoading } = useCollectionsBySpace(spaceId)
  const createCollection = useCollections(s => s.createCollection)
  const deleteCollection = useCollections(s => s.deleteCollection)
  const updateCollection = useCollections(s => s.updateCollection)
  const moveItemsFn = useCollections(s => s.moveItems)
  const { resources, isLoading: isResLoading } = useSpaceUnifiedResources(spaceId)
  const handleStructuralEvent = useUnifiedResources(s => s.handleStructuralEvent)

  const systemTableIds = useMemo(() => {
    return new Set(tables.filter(tbl => tbl.visibility === 'system').map(tbl => tbl.id))
  }, [tables])

  const allItems = useMemo(() => {
    return resources
      .filter(r => !r.is_archived && !(r.item_type === 'tabdata' && systemTableIds.has(r.resource_id)))
      .sort((a, b) => {
        const dateA = a.updated_at ? new Date(a.updated_at).getTime() : 0
        const dateB = b.updated_at ? new Date(b.updated_at).getTime() : 0
        return dateB - dateA
      })
  }, [resources, systemTableIds])

  const uncategorizedItems = useMemo(() => allItems.filter(r => !r.collection_id), [allItems])
  const itemsByCollection = useMemo(() => {
    const map = new Map<string, SearchResultItem[]>()
    for (const item of allItems) {
      if (item.collection_id) {
        if (!map.has(item.collection_id)) map.set(item.collection_id, [])
        map.get(item.collection_id)!.push(item)
      }
    }
    return map
  }, [allItems])

  const [currentCollectionId, setCurrentCollectionId] = useState<string | null>(null)

  const currentCollection = currentCollectionId ? findCollectionById(collections, currentCollectionId) : null
  const breadcrumbPath = useMemo(
    () => (currentCollectionId ? getCollectionPath(collections, currentCollectionId) : []),
    [collections, currentCollectionId],
  )

  useEffect(() => {
    if (currentCollectionId && !currentCollection) setCurrentCollectionId(null)
  }, [currentCollectionId, currentCollection])

  const createEdit = useInlineEdit()
  const renameEdit = useInlineEdit()
  const subfolderCreateEdit = useInlineEdit()

  const onCommitCreate = useCallback(async (value: string) => {
    const coll = await createCollection(spaceId, value)
    setCurrentCollectionId(coll.id)
  }, [createCollection, spaceId])

  const onCommitRename = useCallback(async (value: string, id?: string) => {
    if (id) await updateCollection(id, { name: value })
  }, [updateCollection])

  const onCommitSubfolderCreate = useCallback(async (value: string) => {
    if (!currentCollectionId) return
    await createCollection(spaceId, value, undefined, currentCollectionId)
  }, [createCollection, spaceId, currentCollectionId])

  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string; itemCount: number } | null>(null)

  const handleDeleteCollection = useCallback(async () => {
    if (!deleteConfirm) return
    try {
      const deletedCollectionIds = collectCollectionTreeIds(findCollectionById(collections, deleteConfirm.id))
      await deleteCollection(deleteConfirm.id)
      if (currentCollectionId === deleteConfirm.id) setCurrentCollectionId(null)
      handleStructuralEvent({
        type: 'collection_deleted',
        space_id: spaceId,
        collection_id: deleteConfirm.id,
        collection_ids: deletedCollectionIds,
      })
    } catch (err) {
      toast.error(t('errorToast.collectionDeleteFailed'))
      throw err
    }
  }, [deleteConfirm, collections, deleteCollection, currentCollectionId, handleStructuralEvent, spaceId, t])

  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean
    pos: { x: number; y: number }
    target: { type: 'blank' | 'collection' | 'resource'; coll?: SpaceCollection; item?: SearchResultItem }
    inDetail: boolean
  }>({ open: false, pos: { x: 0, y: 0 }, target: { type: 'blank' }, inDetail: false })

  const handleBlankContextMenu = useCallback((e: React.MouseEvent, inDetail = false) => {
    if ((e.target as HTMLElement).closest('[data-collection-card], [data-resource-card]')) return
    e.preventDefault()
    setCtxMenu({ open: true, pos: { x: e.clientX, y: e.clientY }, target: { type: 'blank' }, inDetail })
  }, [])

  const handleCollectionContextMenu = useCallback((e: React.MouseEvent, coll: SpaceCollection) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ open: true, pos: { x: e.clientX, y: e.clientY }, target: { type: 'collection', coll }, inDetail: false })
  }, [])

  const handleResourceContextMenu = useCallback((e: React.MouseEvent, item: SearchResultItem, inDetail = false) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ open: true, pos: { x: e.clientX, y: e.clientY }, target: { type: 'resource', item }, inDetail })
  }, [])

  // Windows/Chromium：dragStart 同步 setState 会取消原生拖拽；视觉态延后 rAF。
  const draggingIdRef = useRef<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const {
    dragOverTarget,
    handleDragOver,
    handleDragLeave,
    clearDragState,
    parseDragData,
    handleDropOnCollection,
  } = useCollectionDnD({
    spaceId,
    moveItems: moveItemsFn,
    t,
  })

  const handleResourceDragStart = useCallback((e: React.DragEvent, item: SearchResultItem) => {
    e.dataTransfer.setData('application/x-collection-item', JSON.stringify({
      id: item.id,
      resource_id: item.resource_id,
      title: item.title,
      collection_id: item.collection_id,
    }))
    e.dataTransfer.effectAllowed = 'move'
    draggingIdRef.current = item.id
    requestAnimationFrame(() => {
      if (draggingIdRef.current === item.id) {
        setDraggingId(item.id)
      }
    })
  }, [])

  const handleDragEnd = useCallback(() => {
    draggingIdRef.current = null
    setDraggingId(null)
    clearDragState()
  }, [clearDragState])

  const handleDropOnResource = useCallback(async (e: React.DragEvent, targetItem: SearchResultItem) => {
    e.preventDefault()
    clearDragState()
    draggingIdRef.current = null
    setDraggingId(null)
    try {
      const data = parseDragData(e)
      if (!data) return
      if (data.id === targetItem.id) return

      const baseName = t('collectionsView.newCollectionDefault')
      const existingNames = new Set(collections.map(c => c.name))
      let collName = baseName
      let suffix = 2
      while (existingNames.has(collName)) {
        collName = `${baseName} ${suffix}`
        suffix++
      }
      const coll = await createCollection(spaceId, collName)
      await moveItemsFn(spaceId, [data.id, targetItem.id], coll.id)
      handleStructuralEvent({ type: 'items_moved', space_id: spaceId })
      setCurrentCollectionId(coll.id)
    } catch (err) {
      console.error('[CollectionsView] drop-to-create failed:', err)
      toast.error(t('errorToast.collectionDropFailed'))
    }
  }, [clearDragState, parseDragData, createCollection, moveItemsFn, spaceId, handleStructuralEvent, t, collections])

  const handleMoveToCollection = useCallback(async (item: SearchResultItem, collectionId: string | null) => {
    try {
      await moveItemsFn(spaceId, [item.id], collectionId)
      handleStructuralEvent({ type: 'items_moved', space_id: spaceId })
    } catch (err) {
      console.error('[CollectionsView] move failed:', err)
      toast.error(t('errorToast.collectionMoveFailed'))
    }
    setCtxMenu(prev => ({ ...prev, open: false }))
    setMovePopover({ open: false, item: null, pos: { x: 0, y: 0 } })
  }, [moveItemsFn, spaceId, handleStructuralEvent, t])

  const [movePopover, setMovePopover] = useState<{
    open: boolean; item: SearchResultItem | null; pos: { x: number; y: number }
  }>({ open: false, item: null, pos: { x: 0, y: 0 } })

  const wrapDraggable = (item: SearchResultItem, content: React.ReactNode, allowDropCreate = true) => {
    const isDragOver = allowDropCreate && dragOverTarget === `res:${item.id}`
    const isDragging = draggingId === item.id
    return (
      <div
        key={item.resource_id || item.id}
        data-resource-card
        draggable
        onDragStart={e => handleResourceDragStart(e, item)}
        onDragEnd={handleDragEnd}
        onDragOver={allowDropCreate ? (e => handleDragOver(e, `res:${item.id}`)) : undefined}
        onDragLeave={allowDropCreate ? handleDragLeave : undefined}
        onDrop={allowDropCreate ? (e => handleDropOnResource(e, item)) : undefined}
        className={cn(
          'transition-all rounded-lg',
          isDragOver && 'ring-2 ring-primary/30 shadow-md scale-[1.02]',
          isDragging && 'opacity-40',
        )}
      >
        {content}
      </div>
    )
  }

  const collThumbnails = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [collId, items] of itemsByCollection) {
      const thumbs: string[] = []
      for (const item of items) {
        if (thumbs.length >= 3) break
        const t = extractThumbnail(item.metadata, item.item_type)
        if (t) thumbs.push(t)
      }
      if (thumbs.length > 0) map.set(collId, thumbs)
    }
    return map
  }, [itemsByCollection])

  const renderCollectionCard = (
    coll: SpaceCollection,
    opts?: { onContextMenu?: (e: React.MouseEvent, c: SpaceCollection) => void },
  ) => {
    const itemCount = itemsByCollection.get(coll.id)?.length ?? 0
    const isRenaming = renameEdit.state?.id === coll.id
    const isDragOver = dragOverTarget === `coll:${coll.id}`
    const thumbs = collThumbnails.get(coll.id)
    const onCtx = opts?.onContextMenu ?? handleCollectionContextMenu

    return (
      <button
        key={coll.id}
        type="button"
        data-collection-card
        className={cn(
          'group relative flex min-w-0 w-full flex-col overflow-hidden rounded-lg border bg-background text-left transition-all hover:border-primary/30 hover:shadow-sm',
          isDragOver ? 'border-primary/60 ring-2 ring-primary/20 shadow-md' : 'border-border/40',
        )}
        onClick={() => { if (!isRenaming) setCurrentCollectionId(coll.id) }}
        onContextMenu={e => onCtx(e, coll)}
        onDragOver={e => handleDragOver(e, `coll:${coll.id}`)}
        onDragLeave={handleDragLeave}
        onDrop={e => {
          draggingIdRef.current = null
          setDraggingId(null)
          void handleDropOnCollection(e, coll.id)
        }}
      >
        <div className="relative w-full h-20 overflow-hidden bg-gradient-to-br from-primary/10 to-primary/5 dark:from-primary/15 dark:to-primary/5 flex items-center justify-center">
          {thumbs && thumbs.length > 0 ? (
            <div className="relative w-full h-full flex items-center justify-center">
              {thumbs.map((url, i) => (
                <img
                  key={`thumb-${i}`}
                  src={url}
                  alt=""
                  className="absolute rounded-[3px] object-cover shadow-sm border border-white/20 transition-transform group-hover:scale-105"
                  style={{
                    width: thumbs.length === 1 ? '80%' : '52%',
                    height: thumbs.length === 1 ? '80%' : '68%',
                    left: thumbs.length === 1 ? '10%' : `${8 + i * 18}%`,
                    top: thumbs.length === 1 ? '10%' : `${8 + i * 6}%`,
                    zIndex: i,
                    transform: thumbs.length > 1 ? `rotate(${(i - 1) * 4}deg)` : undefined,
                  }}
                />
              ))}
            </div>
          ) : (
            <span
              // eslint-disable-next-line tabtin/no-design-system-violations -- emoji 图标显示尺寸，非文字字号
              className="text-[28px] leading-none drop-shadow-sm transition-transform group-hover:scale-110"
            >
              {coll.icon || '📁'}
            </span>
          )}
          <ChevronRight className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/20 opacity-0 group-hover:opacity-100 transition-opacity" />
          {itemCount > 0 && (
            <span className={cn('absolute', 'top-1.5', 'left-1.5', 'bg-background/80', 'backdrop-blur-sm', 'rounded-full', 'px-1.5', 'py-0.5', 'text-muted-foreground/60', 'font-medium', CANVAS_TEXT_META)}>
              {itemCount}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-1.5 min-h-[34px]">
          {isRenaming ? (
            <input
              className="bg-transparent border-none outline-none text-body text-foreground font-medium p-0 w-full"
              {...renameEdit.getInputProps(onCommitRename)}
            />
          ) : (
            <span className="block min-w-0 truncate text-body font-medium text-foreground/80">{coll.name}</span>
          )}
          <span className={CANVAS_TEXT_META}>
            {t('collectionsView.itemCount', { count: itemCount })}
          </span>
        </div>
      </button>
    )
  }

  const renderCreateCard = () => (
    <div className="flex min-w-0 w-full flex-col overflow-hidden rounded-lg border border-dashed border-border/40 bg-background/60 text-left">
      <div className="relative w-full h-16 overflow-hidden bg-gradient-to-br from-muted/20 to-muted/5 flex items-center justify-center">
        <span
          // eslint-disable-next-line tabtin/no-design-system-violations -- emoji 图标显示尺寸，非文字字号
          className="text-[28px] leading-none opacity-40"
        >
          📁
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-1.5 min-h-[34px]">
        <input
          className="bg-transparent border-none outline-none text-body text-foreground font-medium p-0 w-full placeholder:text-muted-foreground/40"
          placeholder={t('collectionsView.namePlaceholder')}
          {...createEdit.getInputProps(onCommitCreate)}
        />
      </div>
    </div>
  )

  const renderCollectionListItem = (
    coll: SpaceCollection,
    opts?: { onContextMenu?: (e: React.MouseEvent, c: SpaceCollection) => void },
  ) => {
    const itemCount = itemsByCollection.get(coll.id)?.length ?? 0
    const isRenaming = renameEdit.state?.id === coll.id
    const isDragOver = dragOverTarget === `coll:${coll.id}`
    const onCtx = opts?.onContextMenu ?? handleCollectionContextMenu

    return (
      <button
        key={coll.id}
        type="button"
        data-collection-card
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/30 min-w-0',
          isDragOver && 'ring-2 ring-primary/30 bg-primary/5',
        )}
        onClick={() => { if (!isRenaming) setCurrentCollectionId(coll.id) }}
        onContextMenu={e => onCtx(e, coll)}
        onDragOver={e => handleDragOver(e, `coll:${coll.id}`)}
        onDragLeave={handleDragLeave}
        onDrop={e => {
          draggingIdRef.current = null
          setDraggingId(null)
          void handleDropOnCollection(e, coll.id)
        }}
      >
        <span className="shrink-0 text-body leading-none">{coll.icon || '📁'}</span>
        {isRenaming ? (
          <input
            className="bg-transparent border-none outline-none text-body text-foreground font-medium p-0 flex-1 min-w-0"
            {...renameEdit.getInputProps(onCommitRename)}
          />
        ) : (
          <span className="truncate flex-1 text-body font-medium text-foreground/80">{coll.name}</span>
        )}
        <span className={cn('shrink-0', 'text-muted-foreground/40', CANVAS_TEXT_META)}>{itemCount}</span>
        <ChevronRight className="shrink-0 h-3 w-3 text-muted-foreground/30" />
      </button>
    )
  }

  const renderMoveCollectionBranch = (coll: SpaceCollection, depth: number, item: SearchResultItem): React.ReactNode => (
    <div key={coll.id}>
      <button
        type="button"
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 rounded-md text-body w-full hover:bg-muted/60 transition-colors text-left min-w-0',
          item.collection_id === coll.id && 'bg-muted/30',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => handleMoveToCollection(item, coll.id)}
      >
        <span className="shrink-0">{coll.icon || '📁'}</span>
        <span className="truncate flex-1">{coll.name}</span>
      </button>
      {sortChildren(coll).map(child => renderMoveCollectionBranch(child, depth + 1, item))}
    </div>
  )

  const isLoading = (isCollLoading || isResLoading) && allItems.length === 0

  if (isLoading) {
    return <ResourceCollectionSkeleton mode={viewMode} count={viewMode === 'grid' ? 6 : 7} minCardWidth={MIN_CARD_WIDTH_DEFAULT} />
  }

  const overlays = (
    <>
      <ContextMenu
        open={ctxMenu.open}
        onClose={() => setCtxMenu(prev => ({ ...prev, open: false }))}
        anchorPosition={ctxMenu.pos}
        className="w-48"
      >
        {ctxMenu.target.type === 'blank' && (
          <>
            <ContextMenuItem
              icon={<FolderPlus className="h-4 w-4" />}
              label={t('collectionsView.newCollection')}
              onClick={() => createEdit.start('')}
            />
            {ctxMenu.inDetail && (
              <ContextMenuItem
                icon={<Plus className="h-4 w-4" />}
                label={t('collectionsView.newSection')}
                onClick={() => subfolderCreateEdit.start('')}
              />
            )}
          </>
        )}
        {ctxMenu.target.type === 'collection' && ctxMenu.target.coll && (() => {
          const coll = ctxMenu.target.coll
          return (
            <>
              <ContextMenuItem
                icon={<Pencil className="h-4 w-4" />}
                label={t('collectionsView.rename')}
                onClick={() => renameEdit.start(coll.name, coll.id)}
              />
              <div className="mx-1 my-0.5 border-t border-border/20" />
              <ContextMenuItem
                icon={<Trash2 className="h-4 w-4 text-destructive" />}
                label={t('collectionsView.delete')}
                onClick={() => {
                  setDeleteConfirm({ id: coll.id, name: coll.name, itemCount: itemsByCollection.get(coll.id)?.length ?? 0 })
                }}
                className="text-destructive"
              />
            </>
          )
        })()}
        {ctxMenu.target.type === 'resource' && ctxMenu.target.item && (() => {
          const item = ctxMenu.target.item
          return (
            <>
              {collections.length > 0 && (
                <ContextMenuItem
                  icon={<FolderInput className="h-4 w-4" />}
                  label={t('collectionsView.moveTo')}
                  onClick={() => {
                    setMovePopover({ open: true, item, pos: ctxMenu.pos })
                    setCtxMenu(prev => ({ ...prev, open: false }))
                  }}
                />
              )}
              {item.collection_id && (
                <ContextMenuItem
                  icon={<FolderOutput className="h-4 w-4" />}
                  label={t('collectionsView.removeFromCollection')}
                  onClick={() => handleMoveToCollection(item, null)}
                />
              )}
            </>
          )
        })()}
      </ContextMenu>

      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={open => { if (!open) setDeleteConfirm(null) }}
        title={t('collectionsView.deleteConfirmTitle')}
        description={t('collectionsView.deleteConfirmDesc', {
          name: deleteConfirm?.name ?? '',
          count: deleteConfirm?.itemCount ?? 0,
        })}
        confirmText={t('collectionsView.confirmDelete')}
        cancelText={t('collectionsView.cancel')}
        variant="destructive"
        onConfirm={handleDeleteCollection}
      />

      {movePopover.open && movePopover.item && (
        <div className="fixed inset-0 z-modal" onClick={() => setMovePopover({ open: false, item: null, pos: { x: 0, y: 0 } })}>
          <div
            className={cn(
              OVERLAY_SURFACE_CLASS,
              'absolute rounded-interactive p-1 w-56 max-h-72 overflow-y-auto',
            )}
            style={{ left: movePopover.pos.x, top: movePopover.pos.y }}
            onClick={e => e.stopPropagation()}
          >
            <div className={cn('px-2', 'py-1.5', 'font-medium', CANVAS_TEXT_META)}>
              {t('collectionsView.moveTo')}
            </div>
            {[...collections].sort((a, b) => a.order - b.order).map(coll => renderMoveCollectionBranch(coll, 0, movePopover.item!))}
            {movePopover.item.collection_id && (
              <>
                <div className="mx-1 my-0.5 border-t border-border/20" />
                <button
                  type="button"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-body w-full hover:bg-muted/60 transition-colors text-left text-muted-foreground"
                  onClick={() => movePopover.item && handleMoveToCollection(movePopover.item, null)}
                >
                  <FolderOutput className="h-3.5 w-3.5" />
                  <span>{t('collectionsView.removeFromCollection')}</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )

  if (currentCollectionId && currentCollection) {
    const collItems = itemsByCollection.get(currentCollectionId) ?? []
    const childrenOrdered = sortChildren(currentCollection)

    const renderDirectItems = (items: SearchResultItem[]) => {
      if (items.length === 0) return null
      if (viewMode === 'grid') {
        return (
          <div className="grid gap-3 mt-1" style={{ gridTemplateColumns: resourceGridTemplateColumns() }}>
            {items.map(item => wrapDraggable(item,
              <ResourceGridCard
                item={item}
                onClick={() => onSearchNavigate?.(item)}
                onContextMenu={e => handleResourceContextMenu(e, item, true)}
              />,
              false,
            ))}
          </div>
        )
      }
      return (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {items.map(item => wrapDraggable(item,
            <ResourceListItem
              item={item}
              onClick={() => onSearchNavigate?.(item)}
              onContextMenu={e => handleResourceContextMenu(e, item, true)}
            />,
            false,
          ))}
        </div>
      )
    }

    const subfolderCreateInline = subfolderCreateEdit.isActive && (
      <div className="flex items-center gap-1.5 py-1.5 px-1 rounded-md bg-muted/10">
        <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
        <input
          className="bg-transparent border-none outline-none text-body text-foreground/80 font-medium p-0 flex-1 min-w-0 placeholder:text-muted-foreground/40"
          placeholder={t('collectionsView.sectionNamePlaceholder')}
          {...subfolderCreateEdit.getInputProps(onCommitSubfolderCreate)}
        />
      </div>
    )

    const directDropTargetId = `direct:${currentCollectionId}`

    const folderSection = (() => {
      if (childrenOrdered.length === 0) {
        return subfolderCreateInline ? <div className="mb-2 min-w-0 w-full">{subfolderCreateInline}</div> : null
      }
      if (viewMode === 'grid') {
        return (
          <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
            {childrenOrdered.map(c => renderCollectionCard(c, { onContextMenu: handleCollectionContextMenu }))}
            {subfolderCreateEdit.isActive && (
              <div className="col-span-full">{subfolderCreateInline}</div>
            )}
          </div>
        )
      }
      return (
        <div className="flex flex-col gap-0.5 mb-2 min-w-0 w-full">
          {childrenOrdered.map(c => renderCollectionListItem(c, { onContextMenu: handleCollectionContextMenu }))}
          {subfolderCreateEdit.isActive && subfolderCreateInline}
        </div>
      )
    })()

    const hasDetailContent = childrenOrdered.length > 0 || collItems.length > 0 || subfolderCreateEdit.isActive

    const detailContent = (
      <div className={cn(SIDEBAR_LIST_PANEL, 'flex h-full w-full flex-col')}>
        <div className={SIDEBAR_LIST_PANEL_HEADER}>
          <div className="min-w-0 flex-1">
            <ContextListPanelBreadcrumb
              separator={<ChevronRight className="h-3 w-3 text-muted-foreground/30" />}
              items={[
                { id: null, label: t('collectionsView.allCollections') },
                ...breadcrumbPath.map((node, idx) => ({
                  id: node.id,
                  label: node.name,
                  icon: node.icon || (idx === breadcrumbPath.length - 1 ? '📁' : null),
                  current: idx === breadcrumbPath.length - 1,
                })),
              ]}
              onSelect={setCurrentCollectionId}
            />
            <span className={cn('ml-1', 'shrink-0', 'text-muted-foreground/40', CANVAS_TEXT_META)}>{collItems.length}</span>
          </div>
          <button
            type="button"
            className={cn('flex', 'shrink-0', 'items-center', 'gap-1', 'transition-colors', 'hover:text-muted-foreground', CANVAS_TEXT_META)}
            onClick={() => subfolderCreateEdit.start('')}
            title={t('collectionsView.newSection')}
          >
            <Plus className="h-3 w-3" />
            <span className="hidden sm:inline">{t('collectionsView.newSection')}</span>
          </button>
        </div>
        <ScrollArea className={cn(SIDEBAR_LIST_PANEL_SCROLL, '[&>[data-radix-scroll-area-viewport]>div]:!block')}>
          <div className="flex min-h-full min-w-0 w-full flex-col gap-1">
          {hasDetailContent ? (
            <>
              {folderSection}
              <div>
                <div
                  className={cn(
                    'flex items-center gap-1.5 py-1.5 px-1 CANVAS_TEXT_META text-muted-foreground/40 rounded-md transition-colors min-h-[28px]',
                    dragOverTarget === directDropTargetId && 'bg-primary/10 ring-1 ring-primary/20',
                  )}
                  onDragOver={e => handleDragOver(e, directDropTargetId)}
                  onDragLeave={handleDragLeave}
                  onDrop={e => {
                    if (!currentCollectionId) return
                    draggingIdRef.current = null
                    setDraggingId(null)
                    void handleDropOnCollection(e, currentCollectionId)
                  }}
                >
                  {t('collectionsView.unsectioned')}
                </div>
                {renderDirectItems(collItems)}
              </div>
            </>
          ) : (
            <div
              className={cn(
                'px-2.5 py-6 text-center text-body text-muted-foreground/60 rounded-md transition-colors',
                dragOverTarget === directDropTargetId && 'bg-primary/10 ring-1 ring-primary/20',
              )}
              onDragOver={e => handleDragOver(e, directDropTargetId)}
              onDragLeave={handleDragLeave}
              onDrop={e => {
                if (!currentCollectionId) return
                draggingIdRef.current = null
                setDraggingId(null)
                void handleDropOnCollection(e, currentCollectionId)
              }}
            >
              {t('collectionsView.collectionEmpty')}
            </div>
          )}
          </div>
        </ScrollArea>
      </div>
    )

    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-2" onContextMenu={e => handleBlankContextMenu(e, true)}>
        {detailContent}

        {overlays}
      </div>
    )
  }

  const hasContent = collections.length > 0 || uncategorizedItems.length > 0

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3" onContextMenu={e => handleBlankContextMenu(e, false)}>
      {hasContent ? (
        viewMode === 'grid' ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: resourceGridTemplateColumns() }}>
            {collections.map(c => renderCollectionCard(c))}
            {createEdit.isActive && renderCreateCard()}
            {uncategorizedItems.map(item => wrapDraggable(item,
              <ResourceGridCard
                item={item}
                onClick={() => onSearchNavigate?.(item)}
                onContextMenu={e => handleResourceContextMenu(e, item)}
              />,
            ))}
          </div>
        ) : (
          <ScrollArea className={cn(SIDEBAR_LIST_PANEL, 'h-full w-full [&>[data-radix-scroll-area-viewport]>div]:!block')}>
            <div className="flex min-h-full min-w-0 w-full flex-col gap-0.5">
              {collections.map(c => renderCollectionListItem(c))}
              {createEdit.isActive && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/10">
                  <span className="shrink-0 text-body leading-none">📁</span>
                  <input
                    className="bg-transparent border-none outline-none text-body text-foreground font-medium p-0 flex-1 min-w-0 placeholder:text-muted-foreground/40"
                    placeholder={t('collectionsView.namePlaceholder')}
                    {...createEdit.getInputProps(onCommitCreate)}
                  />
                </div>
              )}
              {collections.length > 0 && uncategorizedItems.length > 0 && (
                <div className="mx-2 my-1 border-t border-border/20" />
              )}
              {uncategorizedItems.map(item => wrapDraggable(item,
                <ResourceListItem
                  item={item}
                  onClick={() => onSearchNavigate?.(item)}
                  onContextMenu={e => handleResourceContextMenu(e, item)}
                />,
              ))}
            </div>
          </ScrollArea>
        )
      ) : (
        <div className="px-2.5 py-8 flex flex-col items-center gap-3">
          <div className="text-body text-muted-foreground/60">
            {t('collectionsView.empty')}
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 text-body text-primary/80 hover:text-primary transition-colors"
            onClick={() => createEdit.start('')}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t('collectionsView.newCollection')}
          </button>
        </div>
      )}

      {overlays}
    </div>
  )
}

CollectionsView.displayName = 'CollectionsView'
