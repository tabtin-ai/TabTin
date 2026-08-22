import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import type { TableGridRow, TableGridRuntimeApi } from '@tabtin/table-engine'
import type { RecordQueryParams, ViewMeta, ViewUpdateRequest } from '@tabtin/table-core'
import { getViewColumnMeta } from '@tabtin/table-core'
import { isViewLocked } from '@tabtin/table-ui'
import { useTableViewUiStore } from '@stores/useTableViewUiStore'

const FLOATING_OVERLAY_SELECTOR = [
  // Radix Popper wrappers (Popover/Dropdown/Select/ContextMenu/HoverCard)
  '[data-radix-popper-content-wrapper]',
  // Command palette root used by combobox-like selectors
  '[cmdk-root]',
  // Common semantic roles for floating menus
  '[role="menu"]',
  '[role="listbox"]',
  // Existing custom overlay menu (emoji picker)
  '.emoji-picker-menu',
].join(', ')

const isFloatingOverlayTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false
  }
  return Boolean(target.closest(FLOATING_OVERLAY_SELECTOR))
}

const isGridOverlayTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false
  }
  return Boolean(target.closest('[data-grid-overlay]'))
}

interface UseDataGridGridEventsInput {
  selectedRows: TableGridRow[]
  setSelectedRows: (rows: TableGridRow[]) => void
  gridContainerRef: MutableRefObject<HTMLDivElement | null>
  onPointerDownInsideGrid?: (target: EventTarget | null) => void
  onPointerDownOutsideGrid?: () => void
  useViewData: boolean
  selectedTableId: string | null
  setRecordSorting: (field: string, direction: 'asc' | 'desc') => void
  loadRecordsByTable: (tableId: string, params?: RecordQueryParams) => Promise<void>
  currentView: ViewMeta | null
  fieldIdByName: Map<string, string>
  updateView: (
    viewId: string,
    payload: ViewUpdateRequest,
    options?: {
      silent?: boolean
      refreshRecords?: boolean
      optimisticConfig?: Record<string, unknown>
    }
  ) => Promise<unknown>
  translate: (key: string, options?: Record<string, unknown>) => string
  isTableReadonly?: boolean
}

interface UseDataGridGridEventsResult {
  gridApiRef: MutableRefObject<TableGridRuntimeApi<TableGridRow> | null>
  handleTableApiReady: (api: TableGridRuntimeApi<TableGridRow> | null) => void
  handleSelectionChanged: (rows: TableGridRow[]) => void
  handleGridReady: (event: any) => void
  handleFirstDataRendered: (event: any) => void
  handleSortChanged: (sortModel: Array<{ field: string; direction: 'asc' | 'desc' }>) => void
  handleSortFromMenu: (fieldName: string, direction: 'asc' | 'desc') => void
  handleColumnResized: (columnWidths: Record<string, number>) => Promise<void>
  handleFreezeStateChange: (nextState: { leftColumnFields?: string[] }) => Promise<void>
}

export const useDataGridGridEvents = ({
  selectedRows,
  setSelectedRows,
  gridContainerRef,
  onPointerDownInsideGrid,
  onPointerDownOutsideGrid,
  useViewData,
  selectedTableId,
  setRecordSorting,
  loadRecordsByTable,
  currentView,
  fieldIdByName,
  updateView,
  translate,
  isTableReadonly = false,
}: UseDataGridGridEventsInput): UseDataGridGridEventsResult => {
  const gridApiRef = useRef<TableGridRuntimeApi<TableGridRow> | null>(null)
  const personalViewByScope = useTableViewUiStore(state => state.personalViewByScope)
  const setPersonalViewDraft = useTableViewUiStore(state => state.setPersonalViewDraft)

  const personalScopeKey = currentView?.id && selectedTableId ? `${selectedTableId}:${currentView.id}` : null
  const isPersonalViewEnabled = personalScopeKey ? Boolean(personalViewByScope[personalScopeKey]) : false
  const lockToastTsRef = useRef(0)

  const notifyLockedEditDenied = useCallback(() => {
    const now = Date.now()
    if (now - lockToastTsRef.current < 1200) {
      return
    }
    lockToastTsRef.current = now
    toast({
      title: translate('table:header.lockedEditDeniedTitle'),
      description: translate('table:header.lockedEditDeniedDesc'),
      variant: 'destructive',
    })
  }, [translate])

  const normalizeViewSorts = useCallback(
    (
      sortModel: Array<{ field: string; direction: 'asc' | 'desc' }>
    ): Array<{ field_id: string; direction: 'asc' | 'desc'; priority: number }> => {
      return sortModel
        .map((item, index) => {
          const fieldId = fieldIdByName.get(item.field)
          if (!fieldId) {
            return null
          }
          return {
            field_id: fieldId,
            direction: item.direction,
            priority: index + 1,
          }
        })
        .filter(
          (
            item
          ): item is {
            field_id: string
            direction: 'asc' | 'desc'
            priority: number
          } => item !== null
        )
    },
    [fieldIdByName]
  )

  const areViewSortsEqual = useCallback(
    (
      left: Array<{ field_id: string; direction: 'asc' | 'desc'; priority?: number }>,
      right: Array<{ field_id: string; direction: 'asc' | 'desc'; priority?: number }>
    ) => {
      if (left.length !== right.length) {
        return false
      }
      return left.every((sort, index) => {
        const rightSort = right[index]
        if (!rightSort) {
          return false
        }
        return sort.field_id === rightSort.field_id && sort.direction === rightSort.direction
      })
    },
    []
  )

  const handleTableApiReady = useCallback((api: TableGridRuntimeApi<TableGridRow> | null) => {
    gridApiRef.current = api
  }, [])

  const handleSelectionChanged = useCallback(
    (rows: TableGridRow[]) => {
      setSelectedRows(rows)
    },
    [setSelectedRows]
  )

  const handleGridReady = useCallback((_event: any) => {
  }, [])

  const handleFirstDataRendered = useCallback((_event: any) => {
  }, [])

  const clearGridSelection = useCallback(() => {
    const api = gridApiRef.current
    const hasFocus = Boolean(api?.getFocusedCell?.())
    const hasSelection = selectedRows.length > 0
    if (!hasFocus && !hasSelection) {
      return
    }
    api?.clearFocusedCell?.()
    api?.deselectAll?.()
    if (hasSelection) {
      setSelectedRows([])
    }
  }, [selectedRows.length, setSelectedRows])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) {
        return
      }

      if (isFloatingOverlayTarget(target) || isGridOverlayTarget(target)) {
        return
      }

      const container = gridContainerRef.current
      if (container && container.contains(target)) {
        setTimeout(() => {
          onPointerDownInsideGrid?.(target)
        }, 0)
        return
      }

      const runtimeApi = gridApiRef.current
      if (runtimeApi?.isOverlayTarget?.(target)) {
        return
      }

      runtimeApi?.stopEditing?.()
      clearGridSelection()
      queueMicrotask(() => {
        onPointerDownOutsideGrid?.()
      })
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [clearGridSelection, gridContainerRef, onPointerDownInsideGrid, onPointerDownOutsideGrid])

  const applyColumnSortFromMenu = useCallback((fieldName: string, direction: 'asc' | 'desc') => {
    const api = gridApiRef.current
    if (!api) {
      console.warn('[DataGridAdapter] grid 运行时未就绪，无法设置排序')
      return
    }
    if (!api.applyColumnSort) {
      console.warn('[DataGridAdapter] 当前表格引擎未实现菜单排序能力，已跳过排序操作')
      return
    }

    api.applyColumnSort(fieldName, direction)
  }, [])

  const handleSortFromMenu = useCallback(
    (fieldName: string, direction: 'asc' | 'desc') => {
      applyColumnSortFromMenu(fieldName, direction)
    },
    [applyColumnSortFromMenu]
  )

  const handleSortChanged = useCallback(
    (sortModel: Array<{ field: string; direction: 'asc' | 'desc' }>) => {
      if (isTableReadonly) {
        return
      }
      if (!useViewData) {
        if (sortModel.length > 0 && sortModel[0] && selectedTableId) {
          const { field, direction } = sortModel[0]
          setRecordSorting(field, direction)
          void loadRecordsByTable(selectedTableId).catch(error => {
            console.error('❌ 更新排序后加载记录失败:', error)
          })
        }
        return
      }

      if (!currentView || currentView.view_type !== 'grid') {
        return
      }

      if (isViewLocked(currentView.is_locked) && !isPersonalViewEnabled) {
        notifyLockedEditDenied()
        return
      }

      if (isPersonalViewEnabled) {
        if (selectedTableId && currentView?.id) {
          const nextSorts = normalizeViewSorts(sortModel)
          setPersonalViewDraft(selectedTableId, currentView.id, {
            sorts: nextSorts,
          })
        }
        return
      }

      const nextSorts = normalizeViewSorts(sortModel)
      if (sortModel.length > 0 && nextSorts.length !== sortModel.length) {
        console.warn('[DataGridAdapter] 部分字段名无法映射到ID，仅应用可映射的排序', {
          sortModel,
          mappedSorts: nextSorts,
          fieldIdByNameKeys: [...fieldIdByName.keys()].slice(0, 10),
        })
        // Continue with partial sorts instead of silently dropping all sorts
        if (nextSorts.length === 0) {
          return
        }
      }

      const currentSorts = (currentView.sorts ?? []).map((sort, index) => ({
        field_id: sort.field_id,
        direction: sort.direction,
        priority: sort.priority ?? index + 1,
      }))

      if (areViewSortsEqual(currentSorts, nextSorts)) {
        return
      }

      void updateView(currentView.id, { sorts: nextSorts }, { silent: true }).catch(error => {
        console.error('❌ 同步视图排序配置失败:', error)
      })
    },
    [
      useViewData,
      currentView,
      selectedTableId,
      setRecordSorting,
      loadRecordsByTable,
      normalizeViewSorts,
      areViewSortsEqual,
      updateView,
      setPersonalViewDraft,
      isPersonalViewEnabled,
      notifyLockedEditDenied,
      fieldIdByName,
      isTableReadonly,
    ]
  )

  const handleColumnResized = useCallback(
    async (columnWidths: Record<string, number>) => {
      if (isTableReadonly) {
        return
      }
      if (!currentView || currentView.view_type !== 'grid') {
        return
      }

      if (isViewLocked(currentView.is_locked) && !isPersonalViewEnabled) {
        notifyLockedEditDenied()
        return
      }

      const currentColumnMeta = (getViewColumnMeta(currentView) ?? {}) as Record<string, Record<string, unknown>>
      const baseWidths = {
        ...((currentView.config as any)?.column_widths ?? {}),
      } as Record<string, number>
      const nextColumnMeta = Object.fromEntries(
        Object.entries(currentColumnMeta).map(([fieldId, meta]) => [fieldId, { ...meta }])
      ) as Record<string, Record<string, unknown> & { width?: number }>

      let hasChanges = false
      let hasColumnMetaChanges = false
      Object.entries(columnWidths).forEach(([fieldName, width]) => {
        const fieldId = fieldIdByName.get(fieldName)
        if (!fieldId) {
          return
        }
        const nextWidth = Math.round(width)
        if (baseWidths[fieldId] !== nextWidth) {
          baseWidths[fieldId] = nextWidth
          if (Number.isFinite(nextWidth) && nextWidth > 0) {
            nextColumnMeta[fieldId] = { ...(nextColumnMeta[fieldId] ?? {}), width: nextWidth }
            hasColumnMetaChanges = true
          }
          hasChanges = true
        }
      })

      if (!hasChanges) {
        return
      }

      if (isPersonalViewEnabled) {
        if (selectedTableId && currentView?.id) {
          setPersonalViewDraft(selectedTableId, currentView.id, {
            config: { column_widths: baseWidths },
            ...(hasColumnMetaChanges ? { column_meta: nextColumnMeta } : {}),
          })
        }
        return
      }

      if (!hasColumnMetaChanges) {
        await updateView(
          currentView.id,
          {
            config: { column_widths: baseWidths },
          },
          {
            silent: true,
            refreshRecords: false,
            optimisticConfig: { column_widths: baseWidths },
          }
        )
        return
      }

      await updateView(
        currentView.id,
        {
          column_meta: nextColumnMeta,
        },
        {
          silent: true,
          refreshRecords: false,
          optimisticConfig: { column_widths: baseWidths },
        }
      )
    },
    [
      currentView,
      fieldIdByName,
      updateView,
      isPersonalViewEnabled,
      notifyLockedEditDenied,
      selectedTableId,
      setPersonalViewDraft,
      isTableReadonly,
    ]
  )

  const handleFreezeStateChange = useCallback(
    async (nextState: { leftColumnFields?: string[] }) => {
      if (isTableReadonly) {
        return
      }
      if (!currentView || currentView.view_type !== 'grid') {
        return
      }

      if (isViewLocked(currentView.is_locked) && !isPersonalViewEnabled) {
        notifyLockedEditDenied()
        return
      }

      const nextLeftColumnFields = Array.isArray(nextState.leftColumnFields)
        ? nextState.leftColumnFields.filter(fieldName => fieldIdByName.has(fieldName))
        : []
      const nextFreezeColumns = Math.max(0, nextLeftColumnFields.length)

      const rawCurrentFreezeColumns = Number((currentView.config as any)?.freeze_columns)
      const currentFreezeColumns = Number.isFinite(rawCurrentFreezeColumns)
        ? Math.max(0, Math.floor(rawCurrentFreezeColumns))
        : 0

      if (nextFreezeColumns === currentFreezeColumns) {
        return
      }

      if (isPersonalViewEnabled) {
        if (selectedTableId && currentView?.id) {
          setPersonalViewDraft(selectedTableId, currentView.id, {
            config: { freeze_columns: nextFreezeColumns },
          })
        }
        return
      }

      await updateView(
        currentView.id,
        { config: { freeze_columns: nextFreezeColumns } },
        {
          silent: true,
          refreshRecords: false,
          optimisticConfig: { freeze_columns: nextFreezeColumns },
        }
      )
    },
    [
      currentView,
      fieldIdByName,
      updateView,
      isPersonalViewEnabled,
      notifyLockedEditDenied,
      selectedTableId,
      setPersonalViewDraft,
      isTableReadonly,
    ]
  )

  return {
    gridApiRef,
    handleTableApiReady,
    handleSelectionChanged,
    handleGridReady,
    handleFirstDataRendered,
    handleSortChanged,
    handleSortFromMenu,
    handleColumnResized,
    handleFreezeStateChange,
  }
}
