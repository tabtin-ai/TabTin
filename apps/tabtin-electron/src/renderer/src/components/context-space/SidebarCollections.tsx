/**
 * SidebarCollections — 侧边栏文件夹树渲染
 *
 * 将资源列表按 Collection（嵌套文件夹）分组展示。
 * 支持：折叠/展开（localStorage 持久化）、拖拽移入文件夹、
 * 右键菜单（置顶/移动/移出/重命名/删除/新建子文件夹）、内联创建/重命名。
 */
import React, { useCallback, useMemo, useState } from 'react'
import {
  ChevronRight, Plus, Pin, PinOff,
  FolderPlus, Pencil, Trash2, FolderOutput, FolderInput, BookOpen, Folder,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { ContextMenu, ContextMenuItem, OVERLAY_SURFACE_CLASS, Popover, PopoverContent, PopoverTrigger, toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useCollections, useCollectionsBySpace, flattenCollections } from '@/stores/useCollections'
import { useSpaceUnifiedResources, useUnifiedResources } from '@/stores/useUnifiedResources'
import { SpaceApiService, type SpaceContextItem } from '@/services/spaceApi'
import type { SpaceCollection } from '@/services/spaceApi'
import { contextRegistry } from './registry'
import { CollectionIconPicker, getCollectionColorClass } from './CollectionIconPicker'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import { SidebarResourceListSkeleton } from '@components/common/ListSkeletons'
import { useInlineEdit } from './hooks/useInlineEdit'
import { useCollectionDnD } from './hooks/useCollectionDnD'
import { collectCollectionTreeIds, findCollectionById } from './hooks/collectionFolderTree'
import {
  buildSpaceItemChatContextDragPayload,
  writeChatContextDragPayload,
} from './hooks/chatContextDragPayload'
import {
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_SECTION_TOGGLE,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_COUNT,
  SIDEBAR_META,
  SIDEBAR_CHEVRON,
  SIDEBAR_CHEVRON_TRAILING,
  SIDEBAR_ICON_SM,
  SIDEBAR_ICON_INACTIVE,
  SIDEBAR_ICON_STROKE,
  SIDEBAR_INLINE_ACTION,
  SIDEBAR_DIVIDER,
  SIDEBAR_TREE_INDENT_BASE,
  SIDEBAR_TREE_INDENT_STEP,
  SIDEBAR_ROW_LIST,
  SIDEBAR_DIVIDER_SPACER,
  SIDEBAR_SECTION_FOOTER,
} from '@components/layout/sidebarUi'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'

interface SidebarCollectionsProps {
  spaceId: string
  searchQuery: string
  excludedResourceIds?: Set<string>
  onResourceNavigate?: (item: SpaceContextItem) => void
  createHandlers?: Record<string, () => void>
}

const INLINE_INPUT_CLASS = 'w-full bg-transparent border-none outline-none text-body text-foreground placeholder:text-muted-foreground/60 p-0'
const COLLAPSE_STORAGE_KEY = 'tabtin:sidebar:collapsed'

function treeIndent(depth: number): number {
  return SIDEBAR_TREE_INDENT_BASE + depth * SIDEBAR_TREE_INDENT_STEP
}

function treeMenuIndent(depth: number): number {
  return depth * SIDEBAR_TREE_INDENT_STEP
}

function loadCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

function saveCollapsedSet(s: Set<string>) {
  try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...s])) } catch { /* noop */ }
}

export const SidebarCollections: React.FC<SidebarCollectionsProps> = ({
  spaceId,
  searchQuery,
  excludedResourceIds,
  onResourceNavigate,
  createHandlers,
}) => {
  const { t } = useTranslation('context')
  const { collections, isLoading: isCollLoading } = useCollectionsBySpace(spaceId)
  const { resources, isLoading: isResLoading } = useSpaceUnifiedResources(spaceId)
  const handleResourceWsEvent = useUnifiedResources(s => s.handleWsEvent)
  const handleStructuralEvent = useUnifiedResources(s => s.handleStructuralEvent)

  const {
    createCollection, updateCollection, deleteCollection, moveItems,
  } = useCollections.getState()

  const isSearchActive = Boolean(searchQuery.trim())
  const searchLower = searchQuery.toLowerCase()

  const allCollFlat = useMemo(() => flattenCollections(collections), [collections])

  // ── Derived data ──

  const activeResources = useMemo(() => {
    return resources.filter(r => {
      if (r.is_archived) return false
      if (excludedResourceIds?.has(r.resource_id)) return false
      if (isSearchActive && !r.title?.toLowerCase().includes(searchLower)) return false
      return true
    })
  }, [resources, excludedResourceIds, isSearchActive, searchLower])

  const pinnedItems = useMemo(() =>
    activeResources
      .filter(r => r.is_pinned)
      .sort((a, b) => {
        const pa = a.pinned_at ? new Date(a.pinned_at).getTime() : 0
        const pb = b.pinned_at ? new Date(b.pinned_at).getTime() : 0
        return pb - pa
      }),
    [activeResources],
  )

  const byCollection = useMemo(() => {
    const map = new Map<string | null, SpaceContextItem[]>()
    for (const r of activeResources) {
      if (r.is_pinned) continue
      const collId = r.collection_id || null
      if (!map.has(collId)) map.set(collId, [])
      map.get(collId)!.push(r)
    }
    for (const items of map.values()) {
      items.sort((a, b) => ((b.updated_at ?? '') > (a.updated_at ?? '') ? 1 : -1))
    }
    return map
  }, [activeResources])

  const uncategorized = useMemo(() => byCollection.get(null) ?? [], [byCollection])

  const totalResourceCount = activeResources.length
  const collectionCount = allCollFlat.length

  // ── Collapse state (persisted) ──

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedSet)
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveCollapsedSet(next)
      return next
    })
  }, [])

  // ── Inline creation ──
  const createEdit = useInlineEdit()

  const startInlineCreate = useCallback((type: 'collection' | 'subfolder', parentId?: string) => {
    createEdit.start('', undefined, { type, parentId })
  }, [createEdit])

  const onCommitCreate = useCallback(async (value: string, _id?: string, meta?: Record<string, unknown>) => {
    if (meta?.type === 'collection') {
      await createCollection(spaceId, value)
    } else if (meta?.type === 'subfolder' && meta?.parentId) {
      await createCollection(spaceId, value, '📁', meta.parentId as string)
    }
  }, [createCollection, spaceId])

  // ── Inline rename ──
  const renameEdit = useInlineEdit()

  const startRename = useCallback((id: string, currentName: string) => {
    renameEdit.start(currentName, id, { type: 'collection' })
  }, [renameEdit])

  const onCommitRename = useCallback(async (value: string, id?: string) => {
    if (!id) return
    await updateCollection(id, { name: value })
  }, [updateCollection])

  // ── Context menu ──

  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean
    pos: { x: number; y: number }
    target: { type: 'collection' | 'resource'; id: string; item?: SpaceContextItem; collectionId?: string }
  }>({ open: false, pos: { x: 0, y: 0 }, target: { type: 'resource', id: '' } })

  const handleContextMenu = useCallback((
    e: React.MouseEvent,
    type: 'collection' | 'resource',
    id: string,
    item?: SpaceContextItem,
    collectionId?: string,
  ) => {
    e.preventDefault()
    setCtxMenu({ open: true, pos: { x: e.clientX, y: e.clientY }, target: { type, id, item, collectionId } })
  }, [])

  // ── Move popover ──

  const [movePopover, setMovePopover] = useState<{
    open: boolean
    item: SpaceContextItem | null
    pos: { x: number; y: number }
  }>({ open: false, item: null, pos: { x: 0, y: 0 } })

  const handleTogglePin = useCallback(async (item: SpaceContextItem) => {
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
    } catch (err) { console.error('[SidebarCollections] pin/unpin failed:', err); toast.error(t('errorToast.pinFailed')) }
  }, [handleResourceWsEvent, t])

  const handleToggleCollectionPin = useCallback(async (collectionId: string) => {
    const coll = allCollFlat.find(c => c.id === collectionId)
    if (!coll) return
    try {
      await updateCollection(collectionId, { is_pinned: !coll.is_pinned })
      handleStructuralEvent({ type: 'collection_updated', space_id: spaceId })
    } catch (err) {
      console.error('[SidebarCollections] pin/unpin collection failed:', err)
      toast.error(t('errorToast.pinFailed'))
    }
  }, [allCollFlat, handleStructuralEvent, spaceId, t, updateCollection])

  const handleMoveToCollection = useCallback(async (
    item: SpaceContextItem, collectionId: string | null,
  ) => {
    try {
      await moveItems(spaceId, [item.id], collectionId)
      handleStructuralEvent({ type: 'items_moved', space_id: spaceId })
    } catch (err) { console.error('[SidebarCollections] move failed:', err); toast.error(t('errorToast.collectionMoveFailed')) }
    setMovePopover({ open: false, item: null, pos: { x: 0, y: 0 } })
  }, [moveItems, spaceId, handleStructuralEvent, t])

  const handleDeleteCollection = useCallback(async (id: string) => {
    try {
      const deletedCollectionIds = collectCollectionTreeIds(findCollectionById(collections, id))
      await deleteCollection(id)
      handleStructuralEvent({
        type: 'collection_deleted',
        space_id: spaceId,
        collection_id: id,
        collection_ids: deletedCollectionIds,
      })
    } catch (err) {
      console.error('[SidebarCollections] delete collection failed:', err)
      toast.error(t('errorToast.collectionDeleteFailed'))
    }
  }, [collections, deleteCollection, handleStructuralEvent, spaceId, t])

  // ── Drag & Drop ──

  const {
    dragOverTarget,
    handleDragOver,
    handleDragLeave,
    handleDropOnCollection,
    handleDropOnUncategorized,
  } = useCollectionDnD({ spaceId, moveItems, t })

  const [collReorderTarget, setCollReorderTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)

  const handleDragStart = useCallback((e: React.DragEvent, item: SpaceContextItem) => {
    e.dataTransfer.setData('application/x-collection-item', JSON.stringify({ id: item.id, collection_id: item.collection_id }))
    writeChatContextDragPayload(
      e.dataTransfer,
      buildSpaceItemChatContextDragPayload(item, contextRegistry),
    )
    e.dataTransfer.effectAllowed = 'copyMove'
  }, [])

  const handleCollDragStart = useCallback((e: React.DragEvent, collId: string) => {
    e.dataTransfer.setData('application/x-collection-reorder', collId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleCollDragOver = useCallback((e: React.DragEvent, collId: string) => {
    if (!e.dataTransfer.types.includes('application/x-collection-reorder')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    setCollReorderTarget({ id: collId, pos: e.clientY < midY ? 'before' : 'after' })
  }, [])

  const handleCollDrop = useCallback(async (e: React.DragEvent, targetCollId: string) => {
    e.preventDefault()
    const draggedId = e.dataTransfer.getData('application/x-collection-reorder')
    const target = collReorderTarget
    setCollReorderTarget(null)
    if (!draggedId || draggedId === targetCollId || !target) return

    const currentIds = collections.map(c => c.id)
    const filtered = currentIds.filter(id => id !== draggedId)
    const targetIdx = filtered.indexOf(targetCollId)
    if (targetIdx === -1) return
    const insertIdx = target.pos === 'after' ? targetIdx + 1 : targetIdx
    filtered.splice(insertIdx, 0, draggedId)

    try {
      await useCollections.getState().reorderCollections(spaceId, filtered)
    } catch (err) { console.error('[SidebarCollections] reorder failed:', err); toast.error(t('errorToast.collectionReorderFailed')) }
  }, [collReorderTarget, collections, spaceId, t])

  // ── Quick Actions ──
  const quickActions = useMemo(() => contextRegistry.getQuickActions(), [])
  const [quickActionOpen, setQuickActionOpen] = useState(false)

  // ── Render: resource item ──

  const renderResourceItem = (item: SpaceContextItem, indent = 0) => {
    return (
      <SidebarMenuItem
        key={item.id}
        draggable
        onDragStart={e => handleDragStart(e, item)}
        indent={treeMenuIndent(indent)}
        onClick={() => onResourceNavigate?.(item)}
        onContextMenu={e => handleContextMenu(e, 'resource', item.id, item, item.collection_id ?? undefined)}
        title={item.title}
        leading={(
          <SidebarTypeEmoji appIdOrType={item.item_type} className="text-caption" />
        )}
        label={item.title || t('home.untitled')}
        labelClassName="text-left"
        meta={item.updated_at ? formatRelativeTime(item.updated_at, t) : undefined}
      />
    )
  }

  // ── Render: collection (recursive) ──

  const renderCollection = (coll: SpaceCollection, depth = 0) => {
    const isCollapsed_ = collapsed.has(coll.id)
    const directItems = byCollection.get(coll.id) ?? []
    const totalItems = coll.item_count || 0
    const isRenaming = renameEdit.state?.meta?.type === 'collection' && renameEdit.state?.id === coll.id
    const isCreatingChild = createEdit.state?.meta?.type === 'subfolder' && createEdit.state?.meta?.parentId === coll.id
    const isDragOver = dragOverTarget === `coll:${coll.id}`
    const childCollections = coll.children || []

    if (isSearchActive && !byCollection.has(coll.id) && childCollections.length === 0) return null

    const colorClass = getCollectionColorClass(coll.color)
    const isReorderBefore = collReorderTarget?.id === coll.id && collReorderTarget.pos === 'before'
    const isReorderAfter = collReorderTarget?.id === coll.id && collReorderTarget.pos === 'after'

    return (
      <div key={coll.id} className="mb-0.5 relative">
        {colorClass && depth === 0 && (
          <div className={cn('absolute left-0 top-1 bottom-1 w-[3px] rounded-full', colorClass)} />
        )}
        {isReorderBefore && <div className="h-0.5 mx-2 rounded-full bg-accent/40" />}
        <SidebarMenuItem
          as="div"
          draggable={depth === 0}
          onDragStart={depth === 0 ? (e => handleCollDragStart(e, coll.id)) : undefined}
          className={cn('cursor-pointer group/coll', isDragOver && 'bg-foreground/[0.045] dark:bg-foreground/[0.06] ring-1 ring-ring/30', colorClass && depth === 0 && 'pl-4')}
          indent={depth > 0 || !colorClass ? treeMenuIndent(depth) : undefined}
          onClick={() => toggleCollapse(coll.id)}
          onContextMenu={e => handleContextMenu(e, 'collection', coll.id)}
          onDragOver={e => {
            handleDragOver(e, `coll:${coll.id}`)
            if (depth === 0) handleCollDragOver(e, coll.id)
          }}
          onDragLeave={() => { handleDragLeave(); setCollReorderTarget(null) }}
          onDrop={e => {
            if (depth === 0 && e.dataTransfer.types.includes('application/x-collection-reorder')) {
              void handleCollDrop(e, coll.id)
            } else {
              void handleDropOnCollection(e, coll.id)
            }
          }}
          leading={(
            <CollectionIconPicker
              icon={coll.icon || '📁'}
              color={coll.color || ''}
              onIconChange={icon => { void updateCollection(coll.id, { icon }) }}
              onColorChange={color => { void updateCollection(coll.id, { color }) }}
              trigger={
                <button
                  className="shrink-0 hover:scale-110 transition-transform"
                  onClick={e => e.stopPropagation()}
                  title={t('sidebar.changeIcon')}
                >
                  {coll.icon || '📁'}
                </button>
              }
            />
          )}
          label={isRenaming ? (
            <input
              className={cn(INLINE_INPUT_CLASS, 'font-medium')}
              {...renameEdit.getInputProps(onCommitRename)}
            />
          ) : coll.name}
          labelClassName="font-medium"
          count={!isRenaming && totalItems > 0 ? totalItems : undefined}
          countClassName="opacity-0 group-hover/coll:opacity-100 transition-opacity"
          trailing={(
            <span className={SIDEBAR_CHEVRON_TRAILING} aria-hidden>
              <ChevronRight className={cn(SIDEBAR_CHEVRON, 'transition-transform duration-150', !isCollapsed_ && 'rotate-90')} />
            </span>
          )}
        />

        {!isCollapsed_ && (
          <div className={cn('mt-0.5 transition-all duration-150', SIDEBAR_ROW_LIST)}>
            {childCollections.map(child => renderCollection(child, depth + 1))}
            {directItems.map(item => renderResourceItem(item, depth + 1))}
            {childCollections.length === 0 && directItems.length === 0 && !isCreatingChild && (
              <div className={cn('py-1.5', SIDEBAR_META)} style={{ paddingLeft: treeIndent(depth + 1) }}>
                {t('sidebar.collectionEmpty')}
              </div>
            )}
            {isCreatingChild && (
              <SidebarMenuItem
                as="div"
                className="bg-muted/10"
                indent={treeMenuIndent(depth + 1)}
                leading={(
                  <Folder className={cn(SIDEBAR_ICON_SM, 'shrink-0 text-muted-foreground/60')} strokeWidth={SIDEBAR_ICON_STROKE} />
                )}
                label={(
                  <input
                    className={cn(INLINE_INPUT_CLASS, 'font-medium')}
                    placeholder={t('sidebar.newFolderPlaceholder')}
                    {...createEdit.getInputProps(onCommitCreate)}
                  />
                )}
                labelClassName="font-medium"
              />
            )}
          </div>
        )}
        {isReorderAfter && <div className="h-0.5 mx-2 rounded-full bg-accent/40" />}
      </div>
    )
  }

  const isLoading = isCollLoading || isResLoading
  const hasAnyContent = collections.length > 0 || activeResources.length > 0

  return (
    <div className="pb-1.5">
      <div className={cn(SIDEBAR_SECTION_TOGGLE, 'pt-2 pb-1')}>
        <span className={cn(SIDEBAR_SECTION_LABEL, 'min-w-0 flex-1')}>
          {t('sidebar.resources')}
          {totalResourceCount > 0 && (
            <span className={cn('ml-1.5 normal-case tracking-normal font-normal', SIDEBAR_COUNT)}>
              {totalResourceCount}
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            className={SIDEBAR_INLINE_ACTION}
            title={t('sidebar.newCollection')}
            onClick={() => startInlineCreate('collection')}
          >
            <FolderPlus className={SIDEBAR_ICON_SM} />
          </button>
          <Popover open={quickActionOpen} onOpenChange={setQuickActionOpen}>
            <PopoverTrigger asChild>
              <button
                className={SIDEBAR_INLINE_ACTION}
                title={t('home.newItem')}
              >
                <Plus className={SIDEBAR_ICON_SM} />
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="start" className="w-48 p-1">
              <div className={cn('flex flex-col', SIDEBAR_ROW_LIST)}>
                {quickActions.map(action => (
                  <SidebarMenuItem
                    key={action.type}
                    onClick={() => {
                      createHandlers?.[action.appId ?? (action.type as string)]?.()
                      setQuickActionOpen(false)
                    }}
                    leading={<span className="shrink-0">{action.quickAction.icon}</span>}
                    label={t(action.quickAction.labelKey)}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {isLoading && !hasAnyContent ? (
        <SidebarResourceListSkeleton count={6} />
      ) : (
        <>
          {/* Pinned */}
          {pinnedItems.length > 0 && (
            <>
              <div className={SIDEBAR_ROW_LIST}>
                {pinnedItems.map(item => (
                  <SidebarMenuItem
                    key={item.id}
                    draggable
                    onDragStart={e => handleDragStart(e, item)}
                    onClick={() => onResourceNavigate?.(item)}
                    onContextMenu={e => handleContextMenu(e, 'resource', item.id, item)}
                    title={item.title}
                    leading={(
                      <>
                        <Pin className="h-2.5 w-2.5 shrink-0 text-warning/60 rotate-45" />
                        <SidebarTypeEmoji appIdOrType={item.item_type} className="text-caption" />
                      </>
                    )}
                    label={item.title || t('home.untitled')}
                  />
                ))}
              </div>
              <div className={cn(SIDEBAR_DIVIDER_SPACER, SIDEBAR_DIVIDER)} />
            </>
          )}

          {/* Collections (recursive tree) */}
          {collections.map(coll => renderCollection(coll))}

          {/* Inline create collection */}
          {createEdit.state?.meta?.type === 'collection' && (
            <SidebarMenuItem
              as="div"
              className="bg-muted/10"
              leading={(
                <>
                  <ChevronRight className={SIDEBAR_CHEVRON} />
                  <Folder className={cn(SIDEBAR_ICON_SM, 'shrink-0 text-muted-foreground/60')} strokeWidth={SIDEBAR_ICON_STROKE} />
                </>
              )}
              label={(
                <input
                  className={cn(INLINE_INPUT_CLASS, 'font-medium')}
                  placeholder={t('sidebar.newCollectionPlaceholder')}
                  {...createEdit.getInputProps(onCommitCreate)}
                />
              )}
              labelClassName="font-medium"
            />
          )}

          {/* Uncategorized */}
          {uncategorized.length > 0 && (
            <div
              className={cn(
                'mt-1',
                dragOverTarget === 'uncategorized' && 'bg-foreground/[0.045] dark:bg-foreground/[0.06] ring-1 ring-ring/30 rounded-interactive',
              )}
              onDragOver={e => handleDragOver(e, 'uncategorized')}
              onDragLeave={handleDragLeave}
              onDrop={handleDropOnUncategorized}
            >
              {collections.length > 0 && (
                <div className={SIDEBAR_SECTION_HEADER}>
                  <span className={SIDEBAR_SECTION_LABEL}>{t('sidebar.uncategorized')}</span>
                </div>
              )}
              <div className={SIDEBAR_ROW_LIST}>
                {uncategorized.map(item => renderResourceItem(item))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {!isSearchActive && activeResources.length === 0 && (
            <div className="px-3 py-6 flex flex-col items-center gap-2 text-center">
              <BookOpen className={cn('h-8 w-8', SIDEBAR_ICON_INACTIVE)} />
              <div className={cn('text-body', SIDEBAR_META)}>
                {t('sidebar.noResources')}
              </div>
              <button
                className="text-caption text-accent-text/80 hover:text-accent-text transition-colors"
                onClick={() => startInlineCreate('collection')}
              >
                {t('sidebar.createFirstCollection')}
              </button>
            </div>
          )}
          {isSearchActive && activeResources.length === 0 && (
            <div className={cn('px-3 py-3 text-center text-body', SIDEBAR_META)}>
              {t('sidebar.noResourceResults')}
            </div>
          )}
        </>
      )}

      {/* Footer */}
      {hasAnyContent && (
        <div className={cn(SIDEBAR_SECTION_FOOTER, SIDEBAR_META)}>
          {collectionCount > 0
            ? t('sidebar.footerWithCollections', { collectionCount, resourceCount: totalResourceCount })
            : t('sidebar.footerResourcesOnly', { count: totalResourceCount })
          }
        </div>
      )}

      {/* Context Menu */}
      <ContextMenu
        open={ctxMenu.open}
        onClose={() => setCtxMenu(prev => ({ ...prev, open: false }))}
        anchorPosition={ctxMenu.pos}
        className="w-48"
      >
        {ctxMenu.target.type === 'resource' && ctxMenu.target.item && (() => {
          const item = ctxMenu.target.item
          return (
            <>
              <ContextMenuItem
                icon={item.is_pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                label={item.is_pinned ? t('home.unpin', '取消置顶') : t('home.pin', '置顶')}
                onClick={() => handleTogglePin(item)}
              />
              {allCollFlat.length > 0 && (
                <ContextMenuItem
                  icon={<FolderInput className="h-4 w-4" />}
                  label={t('sidebar.moveToCollection')}
                  onClick={() => {
                    setMovePopover({ open: true, item, pos: ctxMenu.pos })
                    setCtxMenu(prev => ({ ...prev, open: false }))
                  }}
                />
              )}
              {item.collection_id && (
                <ContextMenuItem
                  icon={<FolderOutput className="h-4 w-4" />}
                  label={t('sidebar.removeFromCollection')}
                  onClick={() => handleMoveToCollection(item, null)}
                />
              )}
            </>
          )
        })()}

        {ctxMenu.target.type === 'collection' && (() => {
          const coll = allCollFlat.find(c => c.id === ctxMenu.target.id)
          return (
            <>
              <ContextMenuItem
                icon={coll?.is_pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                label={coll?.is_pinned ? t('home.unpin', '取消置顶') : t('home.pin', '置顶')}
                onClick={() => { void handleToggleCollectionPin(ctxMenu.target.id) }}
              />
              <ContextMenuItem
                icon={<FolderPlus className="h-4 w-4" />}
                label={t('sidebar.addSubfolder')}
                onClick={() => startInlineCreate('subfolder', ctxMenu.target.id)}
              />
              <ContextMenuItem
                icon={<Pencil className="h-4 w-4" />}
                label={t('sidebar.rename')}
                onClick={() => {
                  if (coll) startRename(coll.id, coll.name)
                }}
              />
              <div className="mx-1 my-0.5 border-t border-border/20" />
              <ContextMenuItem
                icon={<Trash2 className="h-4 w-4 text-destructive" />}
                label={t('sidebar.deleteCollection')}
                onClick={() => handleDeleteCollection(ctxMenu.target.id)}
                className="text-destructive"
              />
            </>
          )
        })()}
      </ContextMenu>

      {/* Move to Folder popover */}
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
            <div className="px-2 py-1.5 text-caption font-medium text-muted-foreground/60">
              {t('sidebar.moveToCollectionTitle')}
            </div>
            {(() => {
              const renderMoveOption = (coll: SpaceCollection, indent = 0): React.ReactNode => (
                <React.Fragment key={coll.id}>
                  <button
                    className={cn(
                      'flex items-center gap-2 py-1.5 rounded-interactive text-body w-full hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors text-left',
                      movePopover.item?.collection_id === coll.id && 'bg-muted/30',
                    )}
                    style={{ paddingLeft: 8 + indent * 16 }}
                    onClick={() => movePopover.item && handleMoveToCollection(movePopover.item, coll.id)}
                  >
                    <span>{coll.icon || '📁'}</span>
                    <span className="truncate">{coll.name}</span>
                  </button>
                  {(coll.children ?? []).map(child => renderMoveOption(child, indent + 1))}
                </React.Fragment>
              )
              return collections.map(coll => renderMoveOption(coll))
            })()}
            {movePopover.item?.collection_id && (
              <>
                <div className="mx-1 my-0.5 border-t border-border/20" />
                <button
                  className="flex items-center gap-2 px-2 py-1.5 rounded-interactive text-body w-full hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors text-left text-muted-foreground"
                  onClick={() => movePopover.item && handleMoveToCollection(movePopover.item, null)}
                >
                  <FolderOutput className="h-3.5 w-3.5" />
                  <span>{t('sidebar.removeFromCollection')}</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

SidebarCollections.displayName = 'SidebarCollections'
