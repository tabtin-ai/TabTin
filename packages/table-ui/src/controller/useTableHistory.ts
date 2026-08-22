/**
 * useTableHistory — 表格操作历史列表 + 分页
 */

import { useState, useCallback } from 'react'
import { UndoRedoApiService } from '@tabtin/table-core'
import type { HistoryOperationOut } from '@tabtin/table-core'

const TABLE_HISTORY_PAGE_SIZE = 20

export interface UseTableHistoryInput {
  selectedTableId: string | null
  selectedTableName?: string | null
  translate: (key: string, opts?: Record<string, unknown>) => string
}

export interface UseTableHistoryResult {
  showTableHistory: boolean
  tableHistoryLabel: string
  tableHistoryOps: HistoryOperationOut[]
  tableHistoryTotal: number
  isLoadingTableHistory: boolean
  handleOpenTableHistory: () => void
  handleCloseTableHistory: () => void
  handleLoadMoreTableHistory: () => void
}

export function useTableHistory({
  selectedTableId,
  selectedTableName,
  translate,
}: UseTableHistoryInput): UseTableHistoryResult {
  const [showTableHistory, setShowTableHistory] = useState(false)
  const [tableHistoryLabel, setTableHistoryLabel] = useState('')
  const [tableHistoryOps, setTableHistoryOps] = useState<HistoryOperationOut[]>([])
  const [tableHistoryTotal, setTableHistoryTotal] = useState(0)
  const [isLoadingTableHistory, setIsLoadingTableHistory] = useState(false)
  const [tableHistoryNextCursor, setTableHistoryNextCursor] = useState<string | null>(null)

  const fetchTableHistory = useCallback(
    async (cursor: string | null = null) => {
      if (!selectedTableId) return
      setIsLoadingTableHistory(true)
      try {
        const result = await UndoRedoApiService.getTableHistory(selectedTableId, {
          cursor,
          include_undone: true,
          only_my_operations: false,
          limit: TABLE_HISTORY_PAGE_SIZE,
        })
        const operations = result.operations ?? result.history_list ?? []
        setTableHistoryOps(prev =>
          cursor ? [...prev, ...operations] : operations
        )
        setTableHistoryTotal(result.total)
        setTableHistoryNextCursor(result.next_cursor ?? null)
      } catch (error) {
        console.error('[useTableHistory] fetchTableHistory failed:', error)
      } finally {
        setIsLoadingTableHistory(false)
      }
    },
    [selectedTableId]
  )

  const handleOpenTableHistory = useCallback(() => {
    if (!selectedTableId) return
    setTableHistoryLabel(selectedTableName || translate('table:toolbar.tableHistory'))
    setShowTableHistory(true)
    setTableHistoryOps([])
    setTableHistoryTotal(0)
    setTableHistoryNextCursor(null)
    void fetchTableHistory(null)
  }, [selectedTableId, selectedTableName, fetchTableHistory, translate])

  const handleCloseTableHistory = useCallback(() => {
    setShowTableHistory(false)
    setTableHistoryLabel('')
    setTableHistoryOps([])
    setTableHistoryTotal(0)
    setTableHistoryNextCursor(null)
  }, [])

  const handleLoadMoreTableHistory = useCallback(() => {
    if (!selectedTableId || isLoadingTableHistory || !tableHistoryNextCursor) return
    void fetchTableHistory(tableHistoryNextCursor)
  }, [selectedTableId, tableHistoryNextCursor, isLoadingTableHistory, fetchTableHistory])

  return {
    showTableHistory,
    tableHistoryLabel,
    tableHistoryOps,
    tableHistoryTotal,
    isLoadingTableHistory,
    handleOpenTableHistory,
    handleCloseTableHistory,
    handleLoadMoreTableHistory,
  }
}
