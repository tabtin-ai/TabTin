import { useCallback, useEffect, useMemo } from 'react'
import type { TableGridRow, TableGridConfig } from '@tabtin/table-engine'

const ADD_ROW_ID = '__add_row__'

interface ViewSortItem {
  field_id: string
  direction: 'asc' | 'desc'
  priority?: number
}

interface UseDataGridPresentationModelInput {
  currentViewId: string | null
  currentViewConfig?: Record<string, unknown> | null
  currentViewSorts?: ViewSortItem[] | null
  tableFontSize?: number
  fieldNameById: Map<string, string>
  toggleGroupCollapse: (viewId: string, groupId: string) => void
  hasInlineAddRow: boolean
  draftRowData?: TableGridRow | null
  rowsDataLength: number
  setTotalRowsCount: (count: number) => void
}

interface UseDataGridPresentationModelResult {
  pinnedBottomRowData: TableGridRow[]
  handleToggleGroup: (groupId: string) => void
  config: TableGridConfig
}

export const useDataGridPresentationModel = ({
  currentViewId,
  currentViewConfig,
  currentViewSorts,
  tableFontSize,
  fieldNameById,
  toggleGroupCollapse,
  hasInlineAddRow,
  draftRowData,
  rowsDataLength,
  setTotalRowsCount,
}: UseDataGridPresentationModelInput): UseDataGridPresentationModelResult => {
  const adaptiveMinRowHeight = useMemo<number>(() => {
    const normalizedFontSize = Number.isFinite(tableFontSize ?? Number.NaN)
      ? Math.min(20, Math.max(10, Math.round(tableFontSize as number)))
      : 12
    const adaptive = 32 + Math.max(0, normalizedFontSize - 12) * 3
    return Math.min(160, Math.max(24, adaptive))
  }, [tableFontSize])

  const gridRowHeight = useMemo<number>(() => {
    const rawRowHeight = Number((currentViewConfig as any)?.row_height)
    const normalizedAdaptiveMin = Math.round(adaptiveMinRowHeight)
    if (!Number.isFinite(rawRowHeight)) {
      return normalizedAdaptiveMin
    }
    const normalized = Math.min(160, Math.max(24, Math.round(rawRowHeight)))
    return Math.max(normalized, normalizedAdaptiveMin)
  }, [currentViewConfig, adaptiveMinRowHeight])

  const addRow = useMemo<TableGridRow>(
    () => ({ id: ADD_ROW_ID, row_id: ADD_ROW_ID, __rowType: 'add' }),
    []
  )

  const pinnedBottomRowData = useMemo<TableGridRow[]>(
    () => {
      if (hasInlineAddRow) {
        return []
      }
      return draftRowData ? [draftRowData, addRow] : [addRow]
    },
    [addRow, draftRowData, hasInlineAddRow]
  )

  const handleToggleGroup = useCallback(
    (groupId: string) => {
      if (!currentViewId) {
        return
      }
      toggleGroupCollapse(currentViewId, groupId)
    },
    [currentViewId, toggleGroupCollapse]
  )

  useEffect(() => {
    setTotalRowsCount(rowsDataLength)
  }, [rowsDataLength, setTotalRowsCount])

  // Map view sorts (field_id based) to canvas engine sort model (field name based)
  const gridSorting = useMemo(() => {
    if (!currentViewSorts || currentViewSorts.length === 0) {
      return []
    }
    return currentViewSorts
      .map(sort => {
        const fieldName = fieldNameById.get(sort.field_id)
        if (!fieldName) return null
        return { field: fieldName, direction: sort.direction }
      })
      .filter((item): item is { field: string; direction: 'asc' | 'desc' } => item !== null)
  }, [currentViewSorts, fieldNameById])

  const config = useMemo<TableGridConfig>(
    () => ({
      pagination: {
        enabled: false,
      },
      selection: {
        mode: 'multiple',
        enableClickSelection: false,
      },
      sorting: gridSorting,
      filters: [],
      rowHeight: gridRowHeight,
    }),
    [gridRowHeight, gridSorting]
  )

  return {
    pinnedBottomRowData,
    handleToggleGroup,
    config,
  }
}
