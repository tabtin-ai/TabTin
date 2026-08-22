import React, { useMemo, useState, useCallback } from 'react'
import {
  toast,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuItem,
  Command,
  CommandList,
  CommandEmpty,
  CommandItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
  ConfirmDialog,
  ScrollArea,
} from '@tabtin/smartsheet-ui'
import {
  List,
  Download,
  GripVertical,
} from 'lucide-react'
import { useTableReadonly } from '@components/table/TableReadonlyContext'
import { useTableStore } from '@stores/useTableStore'
import { useViewStore } from '@stores/useViewStore'
import {
  useTableCollabStore,
  useCollabViewDeleterForTable,
  useCollabViewCreatorForTable,
  useCollabViewUpdaterForTable,
} from '@stores/useTableCollabStore'
import { notifyBackendUndoable } from '@tabtin/table-ui'
import type { ViewMeta, ViewCreateRequest, ViewUpdateRequest } from '@tabtin/table-core'
import { ViewEditorDialog } from './ViewEditorDialog'
import { useTranslation } from 'react-i18next'
import { ExportContainer } from '@/components/export'
import { TabScrollIndicator } from '@components/context-space/ContextTabs/TabScrollIndicator'
import { scrollHorizontallyWithVerticalWheel } from '@utils/horizontalWheelScroll'
import {
  useViewSwitcherController,
  PopoverSearchInput,
  VIEW_TYPE_ICONS,
  ViewContextMenuContent,
  AddViewDropdown,
  ViewTabButton,
  ViewDraggableWrapper,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  isViewLocked,
} from '@tabtin/table-ui'
import { selectViewCreator } from './viewCreationStrategy'

interface ViewSwitcherProps {
  className?: string
}

export const ViewSwitcher: React.FC<ViewSwitcherProps> = ({ className }) => {
  const { t } = useTranslation(['view', 'common', 'table'])
  const fields = useTableStore(state => state.fields)
  const views = useViewStore(state => state.views)
  const currentViewId = useViewStore(state => state.currentViewId)
  const createViewAction = useViewStore(state => state.createView)
  const updateViewAction = useViewStore(state => state.updateView)
  const deleteViewAction = useViewStore(state => state.deleteView)
  const selectView = useViewStore(state => state.selectView)
  const setFirstView = useViewStore(state => state.setDefaultView)
  const reorderViews = useViewStore(state => state.reorderViews)
  const tableId = useViewStore(state => state.tableId)
  const deleteViewForRuntime = useCollabViewDeleterForTable(tableId)
  const createViewForRuntime = useCollabViewCreatorForTable(tableId)
  const updateViewForRuntime = useCollabViewUpdaterForTable(tableId)
  const deleteView = useCallback(
    async (viewId: string) => {
      if (deleteViewForRuntime) {
        const ok = await deleteViewForRuntime(viewId)
        if (ok && tableId) notifyBackendUndoable(tableId)
        return ok
      }
      const ok = await deleteViewAction(viewId)
      if (ok && tableId) {
        useTableCollabStore.getState().clearPendingOptimisticView(tableId, viewId)
        notifyBackendUndoable(tableId)
      }
      return ok
    },
    [deleteViewAction, deleteViewForRuntime, tableId],
  )
  const createView = useCallback(
    async (request: Parameters<typeof createViewAction>[0]) => {
      return selectViewCreator(createViewForRuntime, createViewAction)(request)
    },
    [createViewAction, createViewForRuntime],
  )
  const updateView = useCallback(
    async (
      viewId: string,
      payload: ViewUpdateRequest,
      options?: { silent?: boolean; refreshRecords?: boolean; optimisticConfig?: Record<string, unknown> },
    ): Promise<ViewMeta | null> => {
      if (updateViewForRuntime) {
        const updated = await updateViewForRuntime(viewId, payload, options)
        if (updated) return updated as ViewMeta
      }
      return updateViewAction(viewId, payload, options)
    },
    [updateViewAction, updateViewForRuntime],
  )
  const isLoading = useViewStore(state => state.isLoading)
  // 表级只读；视图锁定在每个 tab 上用 isViewLocked(view.is_locked) 单独处理
  const { isTableReadonly } = useTableReadonly()

  const ctrl = useViewSwitcherController<ViewMeta>({
    views,
    currentViewId,
    tableId,
    fields,
    isLoading,
    selectView,
    createView,
    updateView,
    deleteView,
    setFirstView,
    notify: toast,
    t: (key: string, opts?: Record<string, unknown>) => String(t(key, opts as Record<string, string>)),
  })

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingView, setEditingView] = useState<ViewMeta | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isAddViewOpen, setIsAddViewOpen] = useState(false)
  const [exportViewId, setExportViewId] = useState<string | null>(null)
  const [isExpandListOpen, setIsExpandListOpen] = useState(false)
  const [expandListSearch, setExpandListSearch] = useState('')
  const [isExpandListDraggable, setIsExpandListDraggable] = useState(true)
  const [expandListHighlightedViewId, setExpandListHighlightedViewId] = useState<
    string | undefined
  >(undefined)
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const [isViewTabBarHovered, setIsViewTabBarHovered] = useState(false)

  const filteredExpandViewItems = useMemo(() => {
    const normalizedSearch = expandListSearch.trim().toLowerCase()
    if (!normalizedSearch) {
      return ctrl.viewItems
    }
    return ctrl.viewItems.filter(view => view.name.toLowerCase().includes(normalizedSearch))
  }, [expandListSearch, ctrl.viewItems])

  React.useEffect(() => {
    if (!ctrl.renamingViewId) {
      return
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      const input = ctrl.renameInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.select()
      ctrl.releaseRenameInputFocus()
    })

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [ctrl.renamingViewId, ctrl.renameInputRef, ctrl.releaseRenameInputFocus])

  const handleExpandListOpenChange = React.useCallback(
    (open: boolean) => {
      setIsExpandListOpen(open)
      if (open) {
        setExpandListHighlightedViewId(currentViewId ?? undefined)
        return
      }
      setExpandListSearch('')
      setIsExpandListDraggable(true)
    },
    [currentViewId]
  )

  const notifyViewLocked = React.useCallback(() => {
    toast({
      title: t('table:header.lockedEditDeniedTitle'),
      description: t('table:header.lockedEditDeniedDesc'),
      variant: 'destructive',
    })
  }, [t])

  const handleEditClick = (view: ViewMeta) => {
    if (isTableReadonly) return
    if (isViewLocked(view.is_locked)) {
      notifyViewLocked()
      return
    }
    setEditingView(view)
    setIsDialogOpen(true)
  }

  const handleSubmit = async (payload: ViewCreateRequest | ViewUpdateRequest) => {
    if (!editingView || isTableReadonly) return
    if (isViewLocked(editingView.is_locked)) {
      notifyViewLocked()
      return
    }

    setIsSubmitting(true)
    try {
      const result = await updateView(editingView.id, payload as ViewUpdateRequest)

      if (!result) {
        toast({
          title: t('view:switcher.saveFailedTitle'),
          description: t('view:switcher.saveFailedDesc'),
          variant: 'destructive',
        })
        return
      }

      toast({ title: t('view:switcher.updateSuccessTitle') })
      setIsDialogOpen(false)
    } catch (error) {
      toast({
        title: t('view:switcher.saveFailedTitle'),
        description: error instanceof Error ? error.message : t('view:switcher.saveFailedDesc'),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const beginRenameLocal = React.useCallback(
    (view: ViewMeta, options?: { fromMenu?: boolean }) => {
      if (isTableReadonly) return
      if (isViewLocked(view.is_locked)) {
        notifyViewLocked()
        return
      }
      // 先 arm pending / blur-guard，再关菜单，避免 onCloseAutoFocus 早于 pending 置位
      ctrl.beginRename(view, options)
      ctrl.setMenuOpenViewId(null)
    },
    [ctrl, isTableReadonly, notifyViewLocked]
  )

  const cancelRenameLocal = React.useCallback(() => {
    ctrl.cancelRename()
  }, [ctrl])

  React.useEffect(() => {
    if (isTableReadonly && ctrl.renamingViewId) {
      cancelRenameLocal()
    }
    if (!isTableReadonly) {
      return
    }
    ctrl.setMenuOpenViewId(null)
    ctrl.setIsDeleteDialogOpen(false)
    setIsDialogOpen(false)
    setEditingView(null)
    setIsAddViewOpen(false)
  }, [
    cancelRenameLocal,
    ctrl.renamingViewId,
    ctrl.setIsDeleteDialogOpen,
    ctrl.setMenuOpenViewId,
    isTableReadonly,
  ])

  return (
    <div className={cn('flex items-center justify-between gap-1.5 px-0.5', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        {/* ---- Expand View List (vertical, dropdown) ---- */}
        <div className="shrink-0 pb-0.5">
          <Popover open={isExpandListOpen} onOpenChange={handleExpandListOpenChange}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t('view:switcher.allViews')}
                title={t('view:switcher.allViews')}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/8 hover:text-foreground"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="bottom"
              sideOffset={6}
              className="w-auto max-w-[456px] p-1"
              onOpenAutoFocus={event => event.preventDefault()}
            >
              <Command
                value={expandListHighlightedViewId}
                onValueChange={setExpandListHighlightedViewId}
              >
                <PopoverSearchInput
                  value={expandListSearch}
                  onValueChange={value => {
                    setExpandListSearch(value)
                    setIsExpandListDraggable(value.trim().length === 0)
                  }}
                  placeholder={t('view:switcher.searchPlaceholder')}
                  containerClassName="px-2 py-2"
                  onKeyDown={event => event.stopPropagation()}
                />
                <CommandEmpty>{t('view:switcher.noResult')}</CommandEmpty>
                <CommandList className="max-h-[70vh] p-0.5">
                  <ViewDraggableWrapper
                    views={filteredExpandViewItems}
                    strategy={verticalListSortingStrategy}
                    disabled={
                      isTableReadonly ||
                      !isExpandListDraggable ||
                      isLoading ||
                      !!ctrl.renamingViewId
                    }
                    reorderViews={reorderViews}
                  >
                    {({ setNodeRef, attributes, listeners, style, isDragging, view }) => {
                      const icon = VIEW_TYPE_ICONS[view.view_type] ?? VIEW_TYPE_ICONS.grid
                      const viewLocked = isViewLocked(view.is_locked)
                      const canDrag =
                        !isTableReadonly &&
                        !viewLocked &&
                        isExpandListDraggable &&
                        !isLoading &&
                        !ctrl.renamingViewId
                      return (
                        <CommandItem
                          key={`expanded-${view.id}`}
                          value={view.id}
                          keywords={[view.name]}
                          ref={setNodeRef}
                          style={{
                            ...style,
                            opacity: isDragging ? 0.6 : 1,
                          }}
                          className="group flex w-full items-center gap-2 rounded-sm p-1 text-body text-muted-foreground hover:bg-accent/8 hover:text-foreground"
                          onSelect={() => {
                            ctrl.handleSelectView(view.id)
                            setIsExpandListOpen(false)
                            setExpandListSearch('')
                            setIsExpandListDraggable(true)
                            setExpandListHighlightedViewId(view.id)
                          }}
                        >
                          <span className="flex-shrink-0">{icon}</span>
                          <span className="ml-1 truncate text-body" title={view.name}>
                            {view.name}
                          </span>
                          <span className="grow" />
                          {canDrag && (
                            <div
                              {...attributes}
                              {...listeners}
                              className="shrink-0 cursor-grab pr-1 text-muted-foreground active:cursor-grabbing"
                            >
                              <GripVertical className="h-3 w-3" />
                            </div>
                          )}
                        </CommandItem>
                      )
                    }}
                  </ViewDraggableWrapper>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {/* ---- Horizontal View Tab Bar ---- */}
        <div
          className="relative min-w-0 flex-1"
          onWheel={event => {
            scrollHorizontallyWithVerticalWheel(event, scrollViewportRef.current)
          }}
          onMouseEnter={() => setIsViewTabBarHovered(true)}
          onMouseLeave={() => setIsViewTabBarHovered(false)}
        >
          <ScrollArea
            className="min-w-0 flex-1 scrollbar-none"
            scrollBar="horizontal"
            viewportRef={scrollViewportRef}
          >
            <div
              data-view-tab-list
              className="flex min-w-max items-center gap-0.5 pb-0.5 pr-0.5"
            >
              <ViewDraggableWrapper
                views={ctrl.viewItems}
                strategy={horizontalListSortingStrategy}
                disabled={isTableReadonly}
                reorderViews={reorderViews}
              >
                {({ setNodeRef, attributes, listeners, style, isDragging, view }) => {
                  const isActive = view.id === currentViewId
                  const isBusy = ctrl.duplicatingViewId === view.id || ctrl.lockingViewId === view.id
                  const isRenaming = ctrl.renamingViewId === view.id
                  const isRenamingSubmitting = ctrl.renamingSubmittingViewId === view.id
                  const isPinned = ctrl.pinnedViewIds.includes(view.id)
                  const viewLocked = isViewLocked(view.is_locked)
                  const mutationsDisabled = isTableReadonly || viewLocked

                  return (
                    <div
                      ref={setNodeRef}
                      {...attributes}
                      {...(mutationsDisabled || !!ctrl.renamingViewId ? {} : listeners)}
                      style={style}
                      className={cn('relative', {
                        'opacity-50': isDragging,
                      })}
                      onContextMenu={event => {
                        event.preventDefault()
                        // 表级只读挡菜单；视图锁定仍允许打开以便解锁
                        if (isTableReadonly) {
                          return
                        }
                        if (isRenaming) {
                          return
                        }
                        ctrl.setMenuOpenViewId(view.id)
                      }}
                    >
                      <ViewTabButton
                        view={view}
                        isActive={isActive}
                        isPinned={isPinned}
                        isLoading={isLoading}
                        isRenaming={isRenaming && !mutationsDisabled}
                        isRenamingSubmitting={isRenamingSubmitting}
                        renameDraftName={ctrl.renameDraftName}
                        renameInputRef={ctrl.renameInputRef}
                        canRename={!mutationsDisabled}
                        onSelect={() => ctrl.handleSelectView(view.id)}
                        onBeginRename={() => {
                          if (!mutationsDisabled) beginRenameLocal(view)
                        }}
                        onOpenContextMenu={() => {
                          if (isTableReadonly) return
                          ctrl.setMenuOpenViewId(view.id)
                        }}
                        onRenameDraftChange={ctrl.setRenameDraftName}
                        onCommitRename={() => {
                          if (!mutationsDisabled) void ctrl.commitRename(view)
                        }}
                        onBlurRename={() => {
                          if (!mutationsDisabled) ctrl.commitRenameFromBlur(view)
                          else cancelRenameLocal()
                        }}
                        onRenameInputFocus={ctrl.releaseRenameInputFocus}
                        onCancelRename={cancelRenameLocal}
                        extraButtonClassName={
                          !mutationsDisabled && !isLoading && !isRenaming
                            ? 'cursor-grab active:cursor-grabbing'
                            : undefined
                        }
                      />

                      <DropdownMenu
                        open={ctrl.menuOpenViewId === view.id}
                        onOpenChange={open => {
                          if (!open) {
                            ctrl.setMenuOpenViewId(current =>
                              current === view.id ? null : current
                            )
                          } else {
                            if (isTableReadonly) return
                            ctrl.setMenuOpenViewId(view.id)
                          }
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            data-no-drag="true"
                            aria-hidden
                            tabIndex={-1}
                            className="pointer-events-none absolute inset-0 opacity-0"
                          />
                        </DropdownMenuTrigger>
                        <ViewContextMenuContent
                          view={view}
                          isPinned={isPinned}
                          isFirstView={ctrl.firstViewId === view.id}
                          canDelete={ctrl.canDeleteViews}
                          isBusy={isBusy}
                          tableId={tableId}
                          isReadonly={isTableReadonly}
                          isViewLocked={viewLocked}
                          translate={t}
                          onRename={() => beginRenameLocal(view, { fromMenu: true })}
                          onEdit={() => handleEditClick(view)}
                          onDuplicate={() => {
                            if (mutationsDisabled) return
                            void ctrl.handleDuplicateView(view)
                          }}
                          onTogglePin={() => {
                            if (mutationsDisabled) return
                            ctrl.handleTogglePinnedView(view.id)
                          }}
                          onToggleLock={() => {
                            if (isTableReadonly) return
                            void ctrl.handleToggleLock(view)
                          }}
                          onSetFirstView={() => {
                            if (mutationsDisabled) return
                            ctrl.handleSetFirstView(view)
                          }}
                          onDelete={() => {
                            if (mutationsDisabled) return
                            ctrl.handleDeleteView(view)
                          }}
                          onCloseAutoFocus={event => {
                            if (ctrl.pendingMenuRenameViewIdRef.current === view.id) {
                              event.preventDefault()
                              // 不在此处清空 pending：input 可能尚未挂载；由 focus effect / onFocus 收口
                              ctrl.renameInputRef.current?.focus()
                              ctrl.renameInputRef.current?.select()
                            }
                          }}
                          extraItems={
                            view.view_type === 'grid' ? (
                              <DropdownMenuItem
                                onSelect={() => setExportViewId(view.id)}
                                disabled={!tableId}
                              >
                                <Download className="h-3.5 w-3.5" />
                                {t('view:switcher.export')}
                              </DropdownMenuItem>
                            ) : undefined
                          }
                        />
                      </DropdownMenu>
                    </div>
                  )
                }}
              </ViewDraggableWrapper>
            </div>
          </ScrollArea>
          <TabScrollIndicator
            viewportRef={scrollViewportRef}
            isHovered={isViewTabBarHovered}
            contentSelector="[data-view-tab-list]"
            indicatorLabel={t('view:switcher.allViews')}
          />
        </div>
      </div>

      {!isTableReadonly && (
        <div className="shrink-0">
          <AddViewDropdown
            open={isAddViewOpen}
            onOpenChange={setIsAddViewOpen}
            disabled={isLoading || !!ctrl.addingViewType}
            translate={t}
            onAddView={type => void ctrl.handleAddView(type)}
          />
        </div>
      )}

      <ViewEditorDialog
        mode="edit"
        open={isDialogOpen && !isTableReadonly}
        onOpenChange={open => setIsDialogOpen(!isTableReadonly && open)}
        fields={fields}
        initialView={editingView ?? undefined}
        isSubmitting={isSubmitting}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={ctrl.isDeleteDialogOpen && !isTableReadonly}
        onOpenChange={open => ctrl.setIsDeleteDialogOpen(!isTableReadonly && open)}
        title={t('view:switcher.deleteTitle')}
        description={t('view:switcher.deleteDescription', { name: ctrl.viewToDelete?.name ?? '' })}
        confirmText={t('view:switcher.delete')}
        cancelText={t('common:cancel')}
        variant="destructive"
        onConfirm={() => {
          if (isTableReadonly) {
            ctrl.setIsDeleteDialogOpen(false)
            return
          }
          void ctrl.handleConfirmDelete()
        }}
      />

      {tableId && exportViewId && (
        <ExportContainer
          open
          onOpenChange={open => {
            if (!open) {
              setExportViewId(null)
            }
          }}
          tableId={tableId}
          viewId={exportViewId}
        />
      )}
    </div>
  )
}
