/**
 * useRecordHistory — 单条记录历史 + 快照预览 / 还原
 */

import { useState, useCallback, useRef } from 'react'
import { UndoRedoApiService } from '@tabtin/table-core'
import { useToast } from '@tabtin/smartsheet-ui'
import type { HistoryOperationOut } from '@tabtin/table-core'

const RECORD_HISTORY_PAGE_SIZE = 20

export interface UseRecordHistoryInput {
  refreshRecords: () => Promise<void>
  refreshStacks: () => Promise<void>
  translate: (key: string, opts?: Record<string, unknown>) => string
}

export interface UseRecordHistoryResult {
  showRecordHistory: boolean
  recordHistoryRecordId: string | null
  recordHistoryRecordLabel: string
  recordHistoryOps: HistoryOperationOut[]
  recordHistoryTotal: number
  isLoadingRecordHistory: boolean
  handleOpenRecordHistory: (recordId: string, label: string) => void
  handleCloseRecordHistory: () => void
  handleLoadMoreRecordHistory: () => void
  snapshotData: Record<string, unknown> | null
  snapshotLoading: boolean
  restoreLoading: boolean
  handleRequestSnapshot: (
    recordId: string,
    historyId: string,
    _fieldKeys?: string[]
  ) => Promise<void>
  handleRequestRestore: (recordId: string, historyId: string) => Promise<void>
  clearSnapshotPreview: () => void
}

export function useRecordHistory({
  refreshRecords,
  refreshStacks,
  translate,
}: UseRecordHistoryInput): UseRecordHistoryResult {
  const { toast } = useToast()

  const [showRecordHistory, setShowRecordHistory] = useState(false)
  const [recordHistoryRecordId, setRecordHistoryRecordId] = useState<string | null>(null)
  const [recordHistoryRecordLabel, setRecordHistoryRecordLabel] = useState('')
  const [recordHistoryOps, setRecordHistoryOps] = useState<HistoryOperationOut[]>([])
  const [recordHistoryTotal, setRecordHistoryTotal] = useState(0)
  const [isLoadingRecordHistory, setIsLoadingRecordHistory] = useState(false)
  const [recordHistoryNextCursor, setRecordHistoryNextCursor] = useState<string | null>(null)

  const [snapshotData, setSnapshotData] = useState<Record<string, unknown> | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [restoreLoading, setRestoreLoading] = useState(false)
  const snapshotRequestIdRef = useRef(0)

  const fetchRecordHistory = useCallback(
    async (recordId: string, cursor: string | null = null) => {
      setIsLoadingRecordHistory(true)
      try {
        const result = await UndoRedoApiService.getRecordHistory(recordId, {
          cursor,
          include_undone: true,
          limit: RECORD_HISTORY_PAGE_SIZE,
        })
        const operations = result.operations ?? result.history_list ?? []
        setRecordHistoryOps(prev =>
          cursor ? [...prev, ...operations] : operations
        )
        setRecordHistoryTotal(result.total)
        setRecordHistoryNextCursor(result.next_cursor ?? null)
      } catch (error) {
        console.error('[useRecordHistory] fetchRecordHistory failed:', error)
      } finally {
        setIsLoadingRecordHistory(false)
      }
    },
    []
  )

  const handleOpenRecordHistory = useCallback(
    (recordId: string, label: string) => {
      setRecordHistoryRecordId(recordId)
      setRecordHistoryRecordLabel(label)
      setShowRecordHistory(true)
      setRecordHistoryOps([])
      setRecordHistoryTotal(0)
      setRecordHistoryNextCursor(null)
      void fetchRecordHistory(recordId, null)
    },
    [fetchRecordHistory]
  )

  const handleCloseRecordHistory = useCallback(() => {
    setShowRecordHistory(false)
    setRecordHistoryRecordId(null)
    setRecordHistoryRecordLabel('')
    setRecordHistoryOps([])
    setRecordHistoryTotal(0)
    setRecordHistoryNextCursor(null)
    snapshotRequestIdRef.current += 1
    setSnapshotData(null)
    setSnapshotLoading(false)
    setRestoreLoading(false)
  }, [])

  const handleLoadMoreRecordHistory = useCallback(() => {
    if (!recordHistoryRecordId || isLoadingRecordHistory || !recordHistoryNextCursor) return
    void fetchRecordHistory(recordHistoryRecordId, recordHistoryNextCursor)
  }, [
    recordHistoryRecordId,
    recordHistoryNextCursor,
    isLoadingRecordHistory,
    fetchRecordHistory,
  ])

  const handleRequestSnapshot = useCallback(
    async (recordId: string, historyId: string, _fieldKeys?: string[]) => {
      if (!recordId || !historyId) return
      const requestId = snapshotRequestIdRef.current + 1
      snapshotRequestIdRef.current = requestId
      setSnapshotLoading(true)
      setSnapshotData(null)
      try {
        const result = await UndoRedoApiService.getRecordSnapshot(recordId, historyId)
        if (snapshotRequestIdRef.current !== requestId) return
        setSnapshotData(result.snapshot)
      } catch (e: unknown) {
        if (snapshotRequestIdRef.current !== requestId) return
        const errMsg = e instanceof Error ? e.message : undefined
        toast({ title: translate('table:toolbar.snapshotFailed'), description: errMsg, variant: 'destructive' })
        setSnapshotData(null)
      } finally {
        if (snapshotRequestIdRef.current === requestId) {
          setSnapshotLoading(false)
        }
      }
    },
    [toast, translate]
  )

  const clearSnapshotPreview = useCallback(() => {
    snapshotRequestIdRef.current += 1
    setSnapshotData(null)
    setSnapshotLoading(false)
  }, [])

  const handleRequestRestore = useCallback(async (recordId: string, historyId: string) => {
    if (!recordId || !historyId) return
    setRestoreLoading(true)
    try {
      const result = await UndoRedoApiService.restoreRecord(recordId, { history_id: historyId })
      toast({
        title: translate('table:toolbar.restoreSuccess'),
        description: result.changed_fields != null
          ? translate('table:toolbar.restoreChangedFields', { count: result.changed_fields })
          : undefined,
      })
      await refreshRecords()
      await refreshStacks()
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : undefined
      toast({ title: translate('table:toolbar.restoreFailed'), description: errMsg, variant: 'destructive' })
    } finally {
      setRestoreLoading(false)
    }
  }, [toast, translate, refreshRecords, refreshStacks])

  return {
    showRecordHistory,
    recordHistoryRecordId,
    recordHistoryRecordLabel,
    recordHistoryOps,
    recordHistoryTotal,
    isLoadingRecordHistory,
    handleOpenRecordHistory,
    handleCloseRecordHistory,
    handleLoadMoreRecordHistory,
    snapshotData,
    snapshotLoading,
    restoreLoading,
    handleRequestSnapshot,
    handleRequestRestore,
    clearSnapshotPreview,
  }
}
