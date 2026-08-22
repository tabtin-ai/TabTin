import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  toast,
} from '@tabtin/smartsheet-ui'
import { Download, List } from 'lucide-react'
import type { ViewMeta, ViewCreateRequest, ViewUpdateRequest } from '@tabtin/table-core'
import { useTableStore } from '@/stores/table/useTableStore'
import { useViewStore } from '@/stores/table/useViewStore'
import { WebViewEditorDialog } from './WebViewEditorDialog'
import { ExportDialog } from '../export/ExportDialog'
import { createLooseTranslate } from '@/types/table-adapters'
import {
  useViewSwitcherController,
  PopoverSearchInput,
  VIEW_TYPE_ICONS,
  ViewContextMenuContent,
  AddViewDropdown,
  ViewTabButton,
  ViewDraggableWrapper,
  horizontalListSortingStrategy,
  isViewLocked,
} from '@tabtin/table-ui'

export interface WebViewSwitcherProps {
  /** 表级权限只读；不要把视图锁定塞进来，否则无法打开右键菜单解锁 */
  isReadonly?: boolean
}

export function WebViewSwitcher({ isReadonly = false }: WebViewSwitcherProps) {
  const { t } = useTranslation(['view', 'common', 'table'])
  const tl = useMemo(() => createLooseTranslate(t), [t])
  const fields = useTableStore((state) => state.fields)
  const selectedTable = useTableStore((state) => state.selectedTable)
  const views = useViewStore((state) => state.views)
  const currentViewId = useViewStore((state) => state.currentViewId)
  const tableId = useViewStore((state) => state.tableId)
  const isLoading = useViewStore((state) => state.isLoading)
  const selectView = useViewStore((state) => state.selectView)
  const createView = useViewStore((state) => state.createView)
  const updateView = useViewStore((state) => state.updateView)
  const deleteViewAction = useViewStore((state) => state.deleteView)
  const setFirstView = useViewStore((state) => state.setDefaultView)
  const reorderViews = useViewStore((state) => state.reorderViews)

  const ctrl = useViewSwitcherController({
    views,
    currentViewId,
    tableId,
    fields,
    isLoading,
    selectView,
    createView,
    updateView,
    deleteView: deleteViewAction,
    setFirstView,
    notify: toast,
    t: tl,
  })

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingView, setEditingView] = useState<ViewMeta | null>(null)
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isAddViewOpen, setIsAddViewOpen] = useState(false)
  const [exportViewId, setExportViewId] = useState<string | null>(null)
  const [isExpandListOpen, setIsExpandListOpen] = useState(false)
  const [expandListSearch, setExpandListSearch] = useState('')
  const [expandListHighlightedViewId, setExpandListHighlightedViewId] = useState<string | undefined>(undefined)
  const filteredExpandViewItems = useMemo(() => {
    const normalizedSearch = expandListSearch.trim().toLowerCase()
    if (!normalizedSearch) return ctrl.viewItems
    return ctrl.viewItems.filter(view => view.name.toLowerCase().includes(normalizedSearch))
  }, [expandListSearch, ctrl.viewItems])

  React.useEffect(() => {
    if (!ctrl.renamingViewId) return
    const animationFrameId = window.requestAnimationFrame(() => {
      const input = ctrl.renameInputRef.current
      if (!input) return
      input.focus()
      input.select()
      ctrl.releaseRenameInputFocus()
    })
    return () => window.cancelAnimationFrame(animationFrameId)
  }, [ctrl.renamingViewId, ctrl.renameInputRef, ctrl.releaseRenameInputFocus])

  React.useEffect(() => {
    if (!isReadonly) return
    ctrl.cancelRename()
    ctrl.setMenuOpenViewId(null)
    ctrl.setIsDeleteDialogOpen(false)
    setIsDialogOpen(false)
    setEditingView(null)
    setIsAddViewOpen(false)
  }, [
    ctrl.cancelRename,
    ctrl.setIsDeleteDialogOpen,
    ctrl.setMenuOpenViewId,
    isReadonly,
  ])

  const handleExpandListOpenChange = React.useCallback(
    (open: boolean) => {
      setIsExpandListOpen(open)
      if (open) {
        setExpandListHighlightedViewId(currentViewId ?? undefined)
        return
      }
      setExpandListSearch('')
    },
    [currentViewId]
  )

  const notifyViewLocked = useCallback(() => {
    toast({
      title: t('table:header.lockedEditDeniedTitle', { defaultValue: '视图已锁定' }),
      description: t('table:header.lockedEditDeniedDesc', {
        defaultValue: '请先启用个人视图，或解锁后再修改视图配置。',
      }),
      variant: 'destructive',
    })
  }, [t])

  const handleEditClick = (view: ViewMeta) => {
    if (isReadonly) return
    if (isViewLocked(view.is_locked)) {
      notifyViewLocked()
      return
    }
    setEditingView(view)
    setEditorMode('edit')
    setIsDialogOpen(true)
  }

  const handleSubmit = async (payload: ViewCreateRequest | ViewUpdateRequest) => {
    if (isReadonly) return
    if (editingView && isViewLocked(editingView.is_locked) && editorMode === 'edit') {
      notifyViewLocked()
      return
    }
    if (!tableId) return
    setIsSubmitting(true)
    try {
      if (editorMode === 'create') {
        const createName = typeof payload.name === 'string' ? payload.name.trim() : ''
        if (!createName) {
          throw new Error(t('switcher.createFailed'))
        }
        const createPayload: Omit<ViewCreateRequest, 'table_id'> & { table_id: string } = {
          ...payload,
          table_id: tableId,
          name: createName,
        }
        const created = await createView(createPayload)
        if (!created) throw new Error(t('switcher.createFailed'))
        toast({ title: `${t('switcher.createSuccess')} · ${created.name}` })
      } else if (editingView) {
        const updated = await updateView(editingView.id, payload)
        if (!updated) throw new Error(t('switcher.updateFailed'))
        toast({ title: t('switcher.updateSuccess') })
      }
      setIsDialogOpen(false)
    } catch (error) {
      toast({
        title: editorMode === 'create' ? t('switcher.createFailed') : t('switcher.updateFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const beginRenameLocal = React.useCallback(
    (view: ViewMeta, options?: { fromMenu?: boolean }) => {
      if (isReadonly) return
      if (isViewLocked(view.is_locked)) {
        notifyViewLocked()
        return
      }
      // 先 arm pending / blur-guard，再关菜单，避免 onCloseAutoFocus 早于 pending 置位
      ctrl.beginRename(view, options)
      ctrl.setMenuOpenViewId(null)
    },
    [ctrl, isReadonly, notifyViewLocked]
  )

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/50 bg-background px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {/* ---- Expand View List ---- */}
          <div className="shrink-0">
            <Popover open={isExpandListOpen} onOpenChange={handleExpandListOpenChange}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('view:switcher.allViews')}
                  title={t('view:switcher.allViews')}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/8 hover:text-foreground"
                >
                  <List className="h-4 w-4" />
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
                    onValueChange={setExpandListSearch}
                    placeholder={t('view:switcher.searchPlaceholder')}
                    containerClassName="px-2 py-2"
                    onKeyDown={event => event.stopPropagation()}
                  />
                  <CommandEmpty>{t('view:switcher.noResult')}</CommandEmpty>
                  <CommandList className="max-h-[70vh] p-0.5">
                    {filteredExpandViewItems.map(view => {
                      const icon = VIEW_TYPE_ICONS[view.view_type] ?? VIEW_TYPE_ICONS.grid
                      return (
                        <CommandItem
                          key={`expanded-${view.id}`}
                          value={view.id}
                          keywords={[view.name]}
                          className="group flex w-full items-center gap-2 rounded-sm p-1 text-body text-muted-foreground hover:bg-accent/8 hover:text-foreground"
                          onSelect={() => {
                            ctrl.handleSelectView(view.id)
                            setIsExpandListOpen(false)
                            setExpandListSearch('')
                            setExpandListHighlightedViewId(view.id)
                          }}
                        >
                          <span className="flex-shrink-0">{icon}</span>
                          <span className="ml-1 truncate text-body" title={view.name}>
                            {view.name}
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* ---- Horizontal View Tab Bar ---- */}
          <ScrollArea className="min-w-0 flex-1" scrollBar="horizontal">
            <div className="flex min-w-max items-center gap-1">
              <ViewDraggableWrapper
                views={ctrl.viewItems}
                strategy={horizontalListSortingStrategy}
                disabled={isReadonly}
                reorderViews={reorderViews}
              >
                {({ setNodeRef, attributes, listeners, style, isDragging, view }) => {
                  const isActive = view.id === currentViewId
                  const isBusy = ctrl.duplicatingViewId === view.id || ctrl.lockingViewId === view.id
                  const isRenaming = ctrl.renamingViewId === view.id
                  const isRenamingSubmitting = ctrl.renamingSubmittingViewId === view.id
                  const isPinned = ctrl.pinnedViewIds.includes(view.id)
                  const viewLocked = isViewLocked(view.is_locked)
                  const mutationsDisabled = isReadonly || viewLocked

                  return (
                    <div
                      ref={setNodeRef}
                      {...attributes}
                      {...(mutationsDisabled ? {} : listeners)}
                      style={style}
                      className={`relative${isDragging ? ' opacity-50' : ''}`}
                      onContextMenu={event => {
                        event.preventDefault()
                        // 表级只读挡菜单；视图锁定仍允许打开以便解锁
                        if (isReadonly) return
                        if (!isRenaming) ctrl.setMenuOpenViewId(view.id)
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
                        onSelect={() => ctrl.handleSelectView(view.id)}
                        onBeginRename={mutationsDisabled ? () => undefined : () => beginRenameLocal(view)}
                        onOpenContextMenu={() => {
                          if (isReadonly) return
                          ctrl.setMenuOpenViewId(view.id)
                        }}
                        onRenameDraftChange={ctrl.setRenameDraftName}
                        onCommitRename={() => {
                          if (mutationsDisabled) {
                            ctrl.cancelRename()
                            return
                          }
                          void ctrl.commitRename(view)
                        }}
                        onBlurRename={() => {
                          if (mutationsDisabled) {
                            ctrl.cancelRename()
                            return
                          }
                          ctrl.commitRenameFromBlur(view)
                        }}
                        onRenameInputFocus={ctrl.releaseRenameInputFocus}
                        onCancelRename={ctrl.cancelRename}
                        canRename={!mutationsDisabled}
                        extraButtonClassName={!mutationsDisabled && !isLoading && !isRenaming ? 'cursor-grab active:cursor-grabbing' : undefined}
                      />

                      <DropdownMenu
                        open={ctrl.menuOpenViewId === view.id}
                        onOpenChange={open => {
                          if (!open) {
                            ctrl.setMenuOpenViewId(current => current === view.id ? null : current)
                          } else {
                            if (isReadonly) return
                            ctrl.setMenuOpenViewId(view.id)
                          }
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
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
                          isReadonly={isReadonly}
                          isViewLocked={viewLocked}
                          tableId={tableId}
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
                            if (isReadonly) return
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
        </div>

        <AddViewDropdown
          open={isAddViewOpen && !isReadonly}
          onOpenChange={open => setIsAddViewOpen(!isReadonly && open)}
          disabled={isReadonly || isLoading || !!ctrl.addingViewType}
          translate={t}
          onAddView={type => {
            if (isReadonly) return
            setIsAddViewOpen(false)
            void ctrl.handleAddView(type)
          }}
        />
      </div>

      <WebViewEditorDialog
        mode={editorMode}
        open={isDialogOpen && !isReadonly}
        onOpenChange={open => setIsDialogOpen(!isReadonly && open)}
        fields={fields}
        isSubmitting={isSubmitting}
        initialView={editingView}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={ctrl.isDeleteDialogOpen && !isReadonly}
        onOpenChange={open => ctrl.setIsDeleteDialogOpen(!isReadonly && open)}
        title={t('view:switcher.deleteTitle')}
        description={t('view:switcher.deleteDescription', { name: ctrl.viewToDelete?.name ?? '' })}
        confirmText={t('view:switcher.delete')}
        cancelText={t('common:cancel')}
        variant="destructive"
        onConfirm={() => {
          if (isReadonly) {
            ctrl.setIsDeleteDialogOpen(false)
            return
          }
          ctrl.handleConfirmDelete()
        }}
      />

      {tableId && exportViewId && (
        <ExportDialog
          open
          onOpenChange={open => { if (!open) setExportViewId(null) }}
          tableId={tableId}
          tableName={selectedTable?.name ?? 'export'}
          viewId={exportViewId}
          fields={fields}
        />
      )}
    </>
  )
}
