export const getRecordMenuRowId = (
  row: Record<string, unknown> | null | undefined
): string | null => {
  const id = row?.id
  if (typeof id === 'string' && id.length > 0) {
    return id
  }

  const rowId = row?.row_id
  if (typeof rowId === 'string' && rowId.length > 0) {
    return rowId
  }

  return null
}

const isActionableRecordMenuRow = (
  row: Record<string, unknown> | null | undefined
): row is Record<string, unknown> => {
  return Boolean(row) && !(typeof row?.__rowType === 'string' && row.__rowType.length > 0)
}

export const resolveDisplayRowIndexForRecordMenu = (
  rows: Array<Record<string, unknown>>,
  rowData: Record<string, unknown> | null | undefined,
  fallbackIndex?: number
): number | undefined => {
  const targetRowId = getRecordMenuRowId(rowData)
  if (targetRowId) {
    const displayIndex = rows.findIndex((row) => getRecordMenuRowId(row) === targetRowId)
    if (displayIndex >= 0) {
      return displayIndex
    }
  }

  if (rowData) {
    const displayIndex = rows.findIndex((row) => row === rowData)
    if (displayIndex >= 0) {
      return displayIndex
    }
  }

  if (typeof fallbackIndex === 'number' && fallbackIndex >= 0) {
    return fallbackIndex
  }

  return undefined
}

const normalizeComparableGroupValue = (value: unknown): string => {
  if (value === undefined || value === null) return '__empty__'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const hasMatchingGroupValues = (
  row: Record<string, unknown>,
  groupValues: Record<string, unknown>
): boolean => {
  const rowGroupValues = row.__groupValues as Record<string, unknown> | undefined
  if (rowGroupValues === groupValues) return true
  if (!rowGroupValues) return false

  const keys = Object.keys(groupValues)
  return (
    keys.length > 0 &&
    keys.every(
      (key) =>
        normalizeComparableGroupValue(rowGroupValues[key]) ===
        normalizeComparableGroupValue(groupValues[key])
    )
  )
}

export const resolveAppendDisplayRowIndex = (
  rows: Array<Record<string, unknown>>,
  options: {
    groupPath?: string | null
    groupValues?: Record<string, unknown>
    anchorRow?: Record<string, unknown>
    fallbackIndex?: number
  }
): number | undefined => {
  const groupPath = options.groupPath?.trim()
  if (groupPath) {
    const groupAddIndex = rows.findIndex(
      (row) => row.__rowType === 'group_add' && row.__groupPath === groupPath
    )
    if (groupAddIndex >= 0) return groupAddIndex
  }

  const groupValues = options.groupValues
  if (groupValues) {
    const groupAddIndex = rows.findIndex(
      (row) => row.__rowType === 'group_add' && hasMatchingGroupValues(row, groupValues)
    )
    if (groupAddIndex >= 0) return groupAddIndex
  }

  if (!groupPath && !options.groupValues) {
    const addIndex = rows.findIndex((row) => row.__rowType === 'add')
    if (addIndex >= 0) return addIndex
  }

  return resolveDisplayRowIndexForRecordMenu(
    rows,
    options.anchorRow,
    options.fallbackIndex
  )
}

export const resolveRealRowIndexFromDisplayIndex = (
  rows: Array<Record<string, unknown>>,
  dataRows: Array<Record<string, unknown>>,
  displayRowIndex: number
): number | undefined => {
  if (!Number.isInteger(displayRowIndex) || displayRowIndex < 0) {
    return undefined
  }

  const displayRow = rows[displayRowIndex]
  if (!displayRow) {
    return undefined
  }

  const targetRowId = getRecordMenuRowId(displayRow)
  if (targetRowId) {
    const realIndex = dataRows.findIndex((row) => getRecordMenuRowId(row) === targetRowId)
    if (realIndex >= 0) {
      return realIndex
    }
  }

  const realIndex = dataRows.findIndex((row) => row === displayRow)
  if (realIndex >= 0) {
    return realIndex
  }

  return undefined
}

export interface RecordMenuCellSelectionState {
  rowIndex?: number
  row?: Record<string, unknown>
  rowId?: string
  displayRowIndex?: number
  selectedRowIndexes: number[]
  selectedRowIds: string[]
  /** 选区覆盖的列索引（Canvas colIndex），用于「发送到对话」落到 field 索引 */
  selectedColumnIndexes: number[]
  primarySelectedRowIndex?: number
  primarySelectedRow?: Record<string, unknown>
  primarySelectedRowId?: string
  isMultipleSelected: boolean
}

export const resolveCellSelectionStateForRecordMenu = (
  selectionRanges: Array<[number, number]>,
  dataRows: Array<Record<string, unknown>>,
  rows: Array<Record<string, unknown>>
): RecordMenuCellSelectionState => {
  const primaryCell = selectionRanges[0]
  const rowIndex = primaryCell?.[1]
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    return {
      selectedRowIndexes: [],
      selectedRowIds: [],
      selectedColumnIndexes: [],
      isMultipleSelected: false,
    }
  }

  const startColIndex = primaryCell?.[0]
  const endColIndex = selectionRanges[1]?.[0] ?? startColIndex
  const selectedColumnIndexes: number[] = []
  if (Number.isInteger(startColIndex) && Number.isInteger(endColIndex)) {
    const minCol = Math.min(startColIndex as number, endColIndex as number)
    const maxCol = Math.max(startColIndex as number, endColIndex as number)
    for (let index = minCol; index <= maxCol; index += 1) {
      if (index >= 0) selectedColumnIndexes.push(index)
    }
  }

  const row = dataRows[rowIndex]
  const endRowIndex = selectionRanges[1]?.[1] ?? rowIndex
  const minRowIndex = Math.min(rowIndex, endRowIndex)
  const maxRowIndex = Math.max(rowIndex, endRowIndex)
  const selectedRowIndexes: number[] = []
  for (let index = minRowIndex; index <= maxRowIndex; index += 1) {
    if (Number.isInteger(index) && index >= 0 && isActionableRecordMenuRow(dataRows[index])) {
      selectedRowIndexes.push(index)
    }
  }
  const selectedRowIds = selectedRowIndexes
    .map((index) => getRecordMenuRowId(dataRows[index]))
    .filter((selectedRowId): selectedRowId is string => Boolean(selectedRowId))
  const primarySelectedRowIndex = selectedRowIndexes[0]
  const primarySelectedRow =
    primarySelectedRowIndex != null ? dataRows[primarySelectedRowIndex] : undefined
  const primarySelectedRowId = primarySelectedRow
    ? getRecordMenuRowId(primarySelectedRow) ?? undefined
    : undefined

  if (!row) {
    return {
      rowIndex,
      selectedRowIndexes,
      selectedRowIds,
      selectedColumnIndexes,
      primarySelectedRowIndex,
      primarySelectedRow,
      primarySelectedRowId,
      isMultipleSelected: selectedRowIds.length > 1,
    }
  }

  const rowId = getRecordMenuRowId(row) ?? undefined
  const displayRowIndex = resolveDisplayRowIndexForRecordMenu(rows, row, rowIndex)

  return {
    rowIndex,
    row,
    rowId,
    displayRowIndex,
    selectedRowIndexes,
    selectedRowIds,
    selectedColumnIndexes,
    primarySelectedRowIndex,
    primarySelectedRow,
    primarySelectedRowId,
    isMultipleSelected: selectedRowIds.length > 1,
  }
}

export interface RecordMenuRowSelectionState {
  selectedRowIndexes: number[]
  selectedRowIds: string[]
  primaryRowIndex?: number
  primaryRow?: Record<string, unknown>
  primaryRowId?: string
  primaryDisplayRowIndex?: number
  isMultipleSelected: boolean
}

export const resolveRowSelectionStateForRecordMenu = (
  selectionRanges: Array<[number, number]>,
  dataRows: Array<Record<string, unknown>>,
  rows: Array<Record<string, unknown>>
): RecordMenuRowSelectionState => {
  const selectedRowIndexes = [
    ...new Set(
      selectionRanges.flatMap(([start, end]) => {
        const min = Math.min(start, end)
        const max = Math.max(start, end)
        const indexes: number[] = []
        for (let index = min; index <= max; index += 1) {
          indexes.push(index)
        }
        return indexes
      })
    ),
  ]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((left, right) => left - right)

  const selectedRows = selectedRowIndexes
    .map((index) => dataRows[index])
    .filter((row): row is Record<string, unknown> => Boolean(row))
  const selectedRowIds = selectedRows
    .map((row) => getRecordMenuRowId(row))
    .filter((rowId): rowId is string => Boolean(rowId))
  const primaryRowIndex = selectedRowIndexes[0]
  const primaryRow = selectedRows[0]
  const primaryRowId = primaryRow ? getRecordMenuRowId(primaryRow) ?? undefined : undefined
  const primaryDisplayRowIndex =
    primaryRow && primaryRowIndex != null
      ? resolveDisplayRowIndexForRecordMenu(rows, primaryRow, primaryRowIndex)
      : undefined

  return {
    selectedRowIndexes,
    selectedRowIds,
    primaryRowIndex,
    primaryRow,
    primaryRowId,
    primaryDisplayRowIndex,
    isMultipleSelected: selectedRowIndexes.length > 1,
  }
}
