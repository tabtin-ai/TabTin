import { useCallback, useEffect, useRef } from 'react'
import type { RecordQueryParams } from '@tabtin/table-core'

interface UseDataGridFallbackLoaderInput {
  selectedTableId: string | null
  useViewData: boolean
  requestedFieldIds: string[]
  loadFields: (tableId: string) => Promise<void>
  loadRecordsByTable: (tableId: string, params?: RecordQueryParams) => Promise<void>
}

export const useDataGridFallbackLoader = ({
  selectedTableId,
  useViewData,
  requestedFieldIds,
  loadFields,
  loadRecordsByTable,
}: UseDataGridFallbackLoaderInput) => {
  const lastLoadedSignatureRef = useRef<string | null>(null)
  const lastLoadedTableRef = useRef<string | null>(null)

  const fetchRecords = useCallback(
    async (tableId: string, extraParams?: RecordQueryParams) => {
      const fieldsParam = requestedFieldIds.length > 0 ? requestedFieldIds : undefined
      await loadRecordsByTable(tableId, {
        ...extraParams,
        fields: fieldsParam,
        field_key_type: 'id',
      })
    },
    [loadRecordsByTable, requestedFieldIds]
  )

  useEffect(() => {
    if (!selectedTableId) {
      lastLoadedTableRef.current = null
      return
    }

    if (lastLoadedTableRef.current === selectedTableId) {
      return
    }

    lastLoadedTableRef.current = selectedTableId
    void loadFields(selectedTableId)
  }, [selectedTableId, loadFields])

  useEffect(() => {
    if (!selectedTableId) {
      lastLoadedSignatureRef.current = null
      return
    }

    if (useViewData) {
      lastLoadedSignatureRef.current = null
      return
    }

    const signature = `${selectedTableId}::${requestedFieldIds.join('|')}`
    if (lastLoadedSignatureRef.current === signature) {
      return
    }

    lastLoadedSignatureRef.current = signature

    fetchRecords(selectedTableId).catch(error => {
      console.error('❌ 加载记录失败:', error)
    })
  }, [selectedTableId, useViewData, requestedFieldIds, fetchRecords])
}
