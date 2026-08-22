import { useCallback, useMemo } from 'react'
import { isDraftGridRow, resolveRecordId } from '@tabtin/table-engine'

export type TableFontStyle = 'system' | 'serif' | 'mono' | 'rounded'
export type TableFontWeight = 'thin' | 'regular' | 'medium' | 'semibold'
export type TableFontSize = 12 | 13 | 14 | 16

export interface GridToolbarRowLike {
  id?: unknown
  record_id?: unknown
  row_id?: unknown
  __recordId?: unknown
  __rowType?: unknown
}

export interface GridToolbarTableLike {
  id: string
  name: string
  field_count?: number | null
  schema_history_id?: string | null
  default_source_url?: string | null
}

export interface UseGridToolbarControllerInput<Row extends GridToolbarRowLike = GridToolbarRowLike> {
  selectedTable: GridToolbarTableLike | null
  fieldsCount: number
  selectedRows: Row[]
  totalRowsCount: number
  setRecordSearchQuery: (query: string) => void
  loadRecordsByTable: (tableId: string, params: { page: number; search?: string }) => Promise<unknown>
  refreshCurrentView: () => Promise<void>
  deleteRecord: (recordId: string) => Promise<boolean>
  bulkDeleteRecords: (
    recordIds: string[],
  ) => Promise<{ ok: boolean; deletedIds: string[]; failedIds?: string[]; errors?: string[] }>
  setSelectedRows: (rows: Row[]) => void
  updateTable: (tableId: string, data: { name?: string; icon?: string }) => Promise<unknown>
  setTableFontStyle: (value: TableFontStyle) => void
  setTableFontWeight: (value: TableFontWeight) => void
  setTableFontSize: (value: TableFontSize) => void
}

export type SubmitTableNameResult =
  | 'missing_table'
  | 'invalid_name'
  | 'unchanged'
  | 'failed'
  | 'updated'

export interface GridToolbarControllerResult {
  selectedRowsCount: number
  totalRows: number
  totalColumns: number
  hasSelectedRows: boolean
  canDetailEdit: boolean
  handleFontStyleChange: (value: string) => void
  handleFontWeightChange: (value: string) => void
  handleFontSizeChange: (value: number | string) => void
  searchRecords: (query: string) => Promise<void>
  refreshView: () => Promise<void>
  deleteSelectedRecords: () => Promise<boolean>
  submitTableName: (editingTableName: string) => Promise<SubmitTableNameResult>
  updateTableIcon: (emoji: string) => Promise<boolean>
}

const FONT_STYLES: TableFontStyle[] = ['system', 'serif', 'mono', 'rounded']
const FONT_WEIGHTS: TableFontWeight[] = ['thin', 'regular', 'medium', 'semibold']
const FONT_SIZES: TableFontSize[] = [12, 13, 14, 16]

const isFontStyle = (value: string): value is TableFontStyle => {
  return FONT_STYLES.includes(value as TableFontStyle)
}

const isFontWeight = (value: string): value is TableFontWeight => {
  return FONT_WEIGHTS.includes(value as TableFontWeight)
}

const isFontSize = (value: number): value is TableFontSize => {
  return FONT_SIZES.includes(value as TableFontSize)
}

const resolveSelectedRecordId = (row: GridToolbarRowLike | null | undefined): string | null => {
  // Draft / structural rows must not participate in delete/export selection.
  if (isDraftGridRow(row)) return null
  if (
    row &&
    typeof row === 'object' &&
    typeof (row as { __rowType?: unknown }).__rowType === 'string' &&
    (row as { __rowType: string }).__rowType.length > 0
  ) {
    return null
  }
  return resolveRecordId(row)
}

export const useGridToolbarController = <Row extends GridToolbarRowLike = GridToolbarRowLike>(
  input: UseGridToolbarControllerInput<Row>
): GridToolbarControllerResult => {
  const {
    selectedTable,
    fieldsCount,
    selectedRows,
    totalRowsCount,
    setRecordSearchQuery,
    loadRecordsByTable,
    refreshCurrentView,
    deleteRecord,
    bulkDeleteRecords,
    setSelectedRows,
    updateTable,
    setTableFontStyle,
    setTableFontWeight,
    setTableFontSize,
  } = input

  const selectedRowsCount = selectedRows.length
  const hasSelectedRows = selectedRowsCount > 0
  const canDetailEdit = selectedRowsCount === 1

  const totalColumns = useMemo(() => {
    if (fieldsCount > 0) {
      return fieldsCount
    }
    return selectedTable?.field_count ?? 0
  }, [fieldsCount, selectedTable?.field_count])

  const handleFontStyleChange = useCallback(
    (value: string) => {
      if (isFontStyle(value)) {
        setTableFontStyle(value)
      }
    },
    [setTableFontStyle]
  )

  const handleFontWeightChange = useCallback(
    (value: string) => {
      if (isFontWeight(value)) {
        setTableFontWeight(value)
      }
    },
    [setTableFontWeight]
  )

  const handleFontSizeChange = useCallback(
    (value: number | string) => {
      const parsed =
        typeof value === 'number'
          ? value
          : Number.parseInt(String(value).trim(), 10)
      if (isFontSize(parsed)) {
        setTableFontSize(parsed)
      }
    },
    [setTableFontSize]
  )

  const searchRecords = useCallback(
    async (query: string) => {
      if (!selectedTable) {
        return
      }

      setRecordSearchQuery(query)
      await loadRecordsByTable(selectedTable.id, {
        page: 1,
        search: query || undefined,
      })
    },
    [selectedTable, setRecordSearchQuery, loadRecordsByTable]
  )

  const refreshView = useCallback(async () => {
    await refreshCurrentView()
  }, [refreshCurrentView])

  const deleteSelectedRecords = useCallback(async () => {
    if (!selectedTable || selectedRows.length === 0) {
      return false
    }

    try {
      if (selectedRows.length === 1) {
        const recordId = resolveSelectedRecordId(selectedRows[0])
        if (!recordId) {
          return false
        }
        const deleted = await deleteRecord(recordId)
        if (!deleted) {
          return false
        }
      } else {
        const recordIds = selectedRows
          .map(resolveSelectedRecordId)
          .filter((recordId): recordId is string => Boolean(recordId))

        if (recordIds.length === 0) {
          return false
        }
        const result = await bulkDeleteRecords(recordIds)
        if (result.deletedIds.length === 0) {
          return false
        }
      }
    } catch {
      return false
    }

    setSelectedRows([])
    await refreshCurrentView()
    return true
  }, [
    selectedTable,
    selectedRows,
    deleteRecord,
    bulkDeleteRecords,
    setSelectedRows,
    refreshCurrentView,
  ])

  const submitTableName = useCallback(
    async (editingTableName: string): Promise<SubmitTableNameResult> => {
      if (!selectedTable) {
        return 'missing_table'
      }

      const nextName = editingTableName.trim()
      if (!nextName) {
        return 'invalid_name'
      }

      if (nextName === selectedTable.name) {
        return 'unchanged'
      }

      const updated = await updateTable(selectedTable.id, { name: nextName })
      if (updated === null) {
        return 'failed'
      }
      return 'updated'
    },
    [selectedTable, updateTable]
  )

  const updateTableIcon = useCallback(
    async (emoji: string) => {
      if (!selectedTable) {
        return false
      }
      await updateTable(selectedTable.id, { icon: emoji })
      return true
    },
    [selectedTable, updateTable]
  )

  return {
    selectedRowsCount,
    totalRows: totalRowsCount,
    totalColumns,
    hasSelectedRows,
    canDetailEdit,
    handleFontStyleChange,
    handleFontWeightChange,
    handleFontSizeChange,
    searchRecords,
    refreshView,
    deleteSelectedRecords,
    submitTableName,
    updateTableIcon,
  }
}
