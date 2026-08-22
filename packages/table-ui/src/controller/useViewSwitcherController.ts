import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTableViewUiStore } from '../stores/useTableViewUiStore'
import type { ViewCreateRequest, ViewMeta, ViewUpdateRequest } from '../types'
import { getViewColumnMeta, type ViewColumnMeta } from '@tabtin/table-core'

export interface ViewSwitcherNotifyOptions {
  title: string
  description?: string
  variant?: 'default' | 'destructive'
}

export interface UseViewSwitcherControllerInput<V extends ViewMeta = ViewMeta> {
  views: V[]
  currentViewId: string | null
  tableId: string | null
  fields: { id: string; name: string }[]
  isLoading: boolean

  selectView: (viewId: string, options?: { preserveQuery?: boolean }) => Promise<void> | void
  createView: (request: Omit<ViewCreateRequest, 'table_id'> & { table_id?: string }) => Promise<V | null>
  updateView: (
    viewId: string,
    updates: ViewUpdateRequest,
    options?: { silent?: boolean; refreshRecords?: boolean }
  ) => Promise<V | null>
  deleteView: (viewId: string) => Promise<boolean>
  setFirstView: (viewId: string) => Promise<boolean>

  notify: (options: ViewSwitcherNotifyOptions) => void
  t: (key: string, options?: Record<string, unknown>) => string
}

const EMPTY_PINNED: readonly string[] = []

const safeClone = <T,>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

export const useViewSwitcherController = <V extends ViewMeta = ViewMeta>(input: UseViewSwitcherControllerInput<V>) => {
  const {
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
    notify,
    t,
  } = input

  const pinnedViewIdsByTable = useTableViewUiStore(s => s.pinnedViewIdsByTable)
  const toggleViewPinned = useTableViewUiStore(s => s.toggleViewPinned)
  const unpinView = useTableViewUiStore(s => s.unpinView)

  const pinnedViewIds = useMemo(
    () => (tableId ? pinnedViewIdsByTable[tableId] ?? EMPTY_PINNED : EMPTY_PINNED),
    [pinnedViewIdsByTable, tableId]
  )

  // ── Sort: pinned first, then by order ──
  const viewItems = useMemo(() => {
    const pinnedOrder = new Map<string, number>()
    pinnedViewIds.forEach((viewId, index) => {
      pinnedOrder.set(viewId, index)
    })
    return views.slice().sort((a, b) => {
      const ap = pinnedOrder.get(a.id)
      const bp = pinnedOrder.get(b.id)
      if (ap != null && bp != null) return ap - bp
      if (ap != null) return -1
      if (bp != null) return 1
      return a.order - b.order
    })
  }, [pinnedViewIds, views])

  const firstViewId = useMemo(
    () => views.slice().sort((a, b) => a.order - b.order)[0]?.id ?? null,
    [views]
  )
  const canDeleteViews = views.length > 1

  // ── Add view ──
  const [addingViewType, setAddingViewType] = useState<string | null>(null)

  const handleAddView = useCallback(
    async (type: string) => {
      if (!tableId || addingViewType) return
      if (!fields.length) {
        notify({
          title: t('view:addView.createFailedTitle'),
          description: t('view:addView.fieldsNotReady', { defaultValue: '字段数据尚未加载完成，请稍后重试' }),
          variant: 'destructive',
        })
        return
      }
      setAddingViewType(type)
      try {
        const existingNames = new Set(views.map(v => v.name))
        const baseName = t(`view:addView.${type}`)
        let uniqueName = baseName
        if (existingNames.has(baseName)) {
          let i = 2
          while (existingNames.has(`${baseName} ${i}`)) i++
          uniqueName = `${baseName} ${i}`
        }
        const result = await createView({
          table_id: tableId,
          name: uniqueName,
          view_type: type,
        })
        if (result) {
          notify({ title: t('view:switcher.createSuccessTitle') })
        } else {
          notify({
            title: t('view:addView.createFailedTitle'),
            description: t('view:addView.createFailedDesc'),
            variant: 'destructive',
          })
        }
      } catch (error) {
        notify({
          title: t('view:addView.createFailedTitle'),
          description: error instanceof Error ? error.message : t('view:addView.createFailedDesc'),
          variant: 'destructive',
        })
      } finally {
        setAddingViewType(null)
      }
    },
    [addingViewType, createView, fields.length, notify, t, tableId, views]
  )

  // ── Select view ──
  const handleSelectView = useCallback(
    (viewId: string) => {
      if (isLoading || currentViewId === viewId) return
      void selectView(viewId)
    },
    [currentViewId, isLoading, selectView]
  )

  // ── Delete view ──
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [viewToDelete, setViewToDelete] = useState<V | null>(null)

  const handleDeleteView = useCallback(
    (view: V) => {
      if (!canDeleteViews) {
        notify({
          title: t('view:switcher.deleteFailedTitle'),
          description: t('view:switcher.deleteLastDeniedDesc'),
          variant: 'destructive',
        })
        return
      }
      setViewToDelete(view)
      setIsDeleteDialogOpen(true)
    },
    [canDeleteViews, notify, t]
  )

  const handleConfirmDelete = useCallback(async () => {
    if (!viewToDelete) return
    const success = await deleteView(viewToDelete.id)
    if (!success) {
      notify({
        title: t('view:switcher.deleteFailedTitle'),
        description: t('view:switcher.deleteFailedDesc'),
        variant: 'destructive',
      })
    } else {
      if (tableId) unpinView(tableId, viewToDelete.id)
      notify({ title: t('view:switcher.deleteSuccessTitle') })
    }
  }, [deleteView, notify, t, tableId, unpinView, viewToDelete])

  // ── Duplicate view ──
  const [duplicatingViewId, setDuplicatingViewId] = useState<string | null>(null)

  const handleDuplicateView = useCallback(
    async (view: V) => {
      if (!tableId || duplicatingViewId) return
      setDuplicatingViewId(view.id)
      try {
        const duplicated = await createView({
          table_id: tableId,
          name: t('view:saveAs.defaultName', { name: view.name }),
          view_type: view.view_type,
          description: view.description,
          filters: safeClone(view.filters),
          sorts: safeClone(view.sorts),
          groups: safeClone(view.groups),
          visible_fields: safeClone(view.visible_fields),
          field_order: safeClone(view.field_order),
          column_meta: safeClone(
            getViewColumnMeta(view) ?? {}
          ) as ViewColumnMeta,
          config: safeClone(view.config),
        })
        if (!duplicated) throw new Error(t('view:switcher.duplicateFailedDesc'))
        await selectView(duplicated.id, { preserveQuery: true })
        notify({ title: t('view:switcher.duplicateSuccessTitle') })
      } catch (error) {
        notify({
          title: t('view:switcher.duplicateFailedTitle'),
          description: error instanceof Error ? error.message : t('view:switcher.duplicateFailedDesc'),
          variant: 'destructive',
        })
      } finally {
        setDuplicatingViewId(null)
      }
    },
    [createView, duplicatingViewId, notify, selectView, t, tableId]
  )

  // ── Lock / Unlock ──
  const [lockingViewId, setLockingViewId] = useState<string | null>(null)

  const handleToggleLock = useCallback(
    async (view: V) => {
      if (lockingViewId) return
      setLockingViewId(view.id)
      try {
        const updated = await updateView(view.id, { is_locked: !view.is_locked })
        if (!updated) throw new Error(t('view:switcher.lockFailedDesc'))
        notify({
          title: view.is_locked
            ? t('view:switcher.unlockSuccessTitle')
            : t('view:switcher.lockSuccessTitle'),
        })
      } catch (error) {
        notify({
          title: t('view:switcher.lockFailedTitle'),
          description: error instanceof Error ? error.message : t('view:switcher.lockFailedDesc'),
          variant: 'destructive',
        })
      } finally {
        setLockingViewId(null)
      }
    },
    [lockingViewId, notify, t, updateView]
  )

  // ── Pin / Unpin ──
  const handleTogglePinnedView = useCallback(
    (viewId: string) => {
      if (!tableId) return
      toggleViewPinned(tableId, viewId)
    },
    [tableId, toggleViewPinned]
  )

  // ── Set first view ──
  const handleSetFirstView = useCallback(
    async (view: V) => {
      if (firstViewId === view.id) return
      const success = await setFirstView(view.id)
      if (!success) {
        notify({
          title: t('view:switcher.setFirstFailedTitle'),
          description: t('view:switcher.setFirstFailedDesc'),
          variant: 'destructive',
        })
      }
    },
    [firstViewId, notify, setFirstView, t]
  )

  // ── Rename ──
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null)
  const [renameDraftName, setRenameDraftName] = useState('')
  const [renamingSubmittingViewId, setRenamingSubmittingViewId] = useState<string | null>(null)
  const renameCommittedRef = useRef(false)
  const pendingMenuRenameViewIdRef = useRef<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  /**
   * 菜单「重命名」关闭 Dropdown 时，Radix teardown 会在 input 出现后仍持续丢焦点。
   * 固定短超时（如 200ms）不够：输入框刚出来就被 blur→同名 cancel。
   * 改为：抑制 blur-commit，直到 input **连续聚焦稳定**一段时间；伪 blur 只 refocus 并重置稳定计时。
   */
  const suppressRenameBlurCommitRef = useRef(false)
  const renameFocusStableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renameSuppressFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const MENU_RENAME_FOCUS_STABLE_MS = 400
  const MENU_RENAME_SUPPRESS_FALLBACK_MS = 2500

  const clearRenameFocusStableTimer = useCallback(() => {
    if (renameFocusStableTimerRef.current != null) {
      clearTimeout(renameFocusStableTimerRef.current)
      renameFocusStableTimerRef.current = null
    }
  }, [])

  const clearSuppressRenameBlurCommit = useCallback(() => {
    clearRenameFocusStableTimer()
    if (renameSuppressFallbackTimerRef.current != null) {
      clearTimeout(renameSuppressFallbackTimerRef.current)
      renameSuppressFallbackTimerRef.current = null
    }
    suppressRenameBlurCommitRef.current = false
  }, [clearRenameFocusStableTimer])

  const armSuppressRenameBlurCommit = useCallback(() => {
    suppressRenameBlurCommitRef.current = true
    clearRenameFocusStableTimer()
    if (renameSuppressFallbackTimerRef.current != null) {
      clearTimeout(renameSuppressFallbackTimerRef.current)
    }
    // 极端情况 focus 一直被抢：兜底解除，避免永远锁在 rename
    renameSuppressFallbackTimerRef.current = setTimeout(() => {
      suppressRenameBlurCommitRef.current = false
      pendingMenuRenameViewIdRef.current = null
      renameSuppressFallbackTimerRef.current = null
      clearRenameFocusStableTimer()
    }, MENU_RENAME_SUPPRESS_FALLBACK_MS)
  }, [clearRenameFocusStableTimer])

  useEffect(() => {
    return () => {
      clearSuppressRenameBlurCommit()
    }
  }, [clearSuppressRenameBlurCommit])

  const beginRename = useCallback((view: V, options?: { fromMenu?: boolean }) => {
    if (options?.fromMenu) {
      pendingMenuRenameViewIdRef.current = view.id
      armSuppressRenameBlurCommit()
    } else {
      pendingMenuRenameViewIdRef.current = null
      clearSuppressRenameBlurCommit()
    }
    renameCommittedRef.current = false
    setRenamingViewId(view.id)
    setRenameDraftName(view.name)
  }, [armSuppressRenameBlurCommit, clearSuppressRenameBlurCommit])

  const cancelRename = useCallback(() => {
    pendingMenuRenameViewIdRef.current = null
    clearSuppressRenameBlurCommit()
    setRenamingViewId(null)
    setRenameDraftName('')
  }, [clearSuppressRenameBlurCommit])

  const releaseRenameInputFocus = useCallback(() => {
    // 每次真正拿到焦点：重启「稳定计时」；只有连续聚焦满阈值才解除 suppress
    if (!suppressRenameBlurCommitRef.current) {
      pendingMenuRenameViewIdRef.current = null
      return
    }
    clearRenameFocusStableTimer()
    renameFocusStableTimerRef.current = setTimeout(() => {
      suppressRenameBlurCommitRef.current = false
      pendingMenuRenameViewIdRef.current = null
      renameFocusStableTimerRef.current = null
      if (renameSuppressFallbackTimerRef.current != null) {
        clearTimeout(renameSuppressFallbackTimerRef.current)
        renameSuppressFallbackTimerRef.current = null
      }
    }, MENU_RENAME_FOCUS_STABLE_MS)
  }, [clearRenameFocusStableTimer])

  const commitRename = useCallback(
    async (view: V) => {
      if (renameCommittedRef.current) return
      renameCommittedRef.current = true

      const nextName = renameDraftName.trim()
      if (!nextName || nextName === view.name) {
        cancelRename()
        return
      }

      setRenamingSubmittingViewId(view.id)
      try {
        const updated = await updateView(
          view.id,
          { name: nextName },
          { silent: true, refreshRecords: false }
        )
        if (!updated) throw new Error(t('view:switcher.renameFailedDesc'))
        notify({ title: t('view:switcher.renameSuccessTitle') })
        cancelRename()
      } catch (error) {
        notify({
          title: t('view:switcher.renameFailedTitle'),
          description: error instanceof Error ? error.message : t('view:switcher.renameFailedDesc'),
          variant: 'destructive',
        })
        renameCommittedRef.current = false
      } finally {
        setRenamingSubmittingViewId(null)
      }
    },
    [cancelRename, notify, renameDraftName, t, updateView]
  )

  const commitRenameFromBlur = useCallback(
    (view: V) => {
      if (suppressRenameBlurCommitRef.current) {
        // 稳定前的伪 blur：打断稳定计时，拉回焦点，继续抑制
        clearRenameFocusStableTimer()
        window.requestAnimationFrame(() => {
          renameInputRef.current?.focus()
        })
        return
      }
      void commitRename(view)
    },
    [clearRenameFocusStableTimer, commitRename]
  )

  // ── Menu state ──
  const [menuOpenViewId, setMenuOpenViewId] = useState<string | null>(null)

  return {
    viewItems,
    pinnedViewIds,
    firstViewId,
    canDeleteViews,

    addingViewType,
    handleAddView,

    handleSelectView,

    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    viewToDelete,
    handleDeleteView,
    handleConfirmDelete,

    duplicatingViewId,
    handleDuplicateView,

    lockingViewId,
    handleToggleLock,

    handleTogglePinnedView,
    handleSetFirstView,

    renamingViewId,
    renameDraftName,
    setRenameDraftName,
    renamingSubmittingViewId,
    beginRename,
    cancelRename,
    commitRename,
    commitRenameFromBlur,
    releaseRenameInputFocus,
    renameInputRef,
    pendingMenuRenameViewIdRef,
    suppressRenameBlurCommitRef,

    menuOpenViewId,
    setMenuOpenViewId,
  }
}

export type ViewSwitcherControllerResult = ReturnType<typeof useViewSwitcherController>
