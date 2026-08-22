import { toErrorMessage } from '@/table-host/value-utils'
import {
  FieldApiService,
  RecordApiService,
  type Table,
  TableApiService,
  ViewApiService,
} from '@tabtin/table-core'
import type { TableField, TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-ui'
import { useCallback, useEffect, useState } from 'react'

interface UseTableHostDataParams {
  hasAccessToken: boolean
  activeOrganizationId: string
  activeSpaceId: string
  refreshTick: number
  pageSize: number
}

export interface UseTableHostDataResult {
  tables: Table[]
  selectedTableId: string
  setSelectedTableId: (tableId: string) => void
  fields: TableField[]
  views: ViewMeta[]
  selectedViewId: string | null
  setSelectedViewId: (viewId: string | null) => void
  records: TableRecord[]
  viewRecords: ViewRecordsResponse | null
  tablesLoading: boolean
  metadataLoading: boolean
  recordsLoading: boolean
  error: string | null
  setError: (message: string | null) => void
  resetData: () => void
}

export const useTableHostData = ({
  hasAccessToken,
  activeOrganizationId,
  activeSpaceId,
  refreshTick,
  pageSize,
}: UseTableHostDataParams): UseTableHostDataResult => {
  const [tables, setTables] = useState<Table[]>([])
  const [selectedTableId, setSelectedTableId] = useState('')
  const [fields, setFields] = useState<TableField[]>([])
  const [views, setViews] = useState<ViewMeta[]>([])
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null)
  const [records, setRecords] = useState<TableRecord[]>([])
  const [viewRecords, setViewRecords] = useState<ViewRecordsResponse | null>(null)

  const [tablesLoading, setTablesLoading] = useState(false)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetData = useCallback(() => {
    setTables([])
    setSelectedTableId('')
    setFields([])
    setViews([])
    setSelectedViewId(null)
    setRecords([])
    setViewRecords(null)
  }, [])

  useEffect(() => {
    if (hasAccessToken) {
      return
    }
    resetData()
  }, [hasAccessToken, resetData])

  useEffect(() => {
    if (!hasAccessToken || !activeOrganizationId || !activeSpaceId) {
      return
    }
    void refreshTick

    let cancelled = false

    const loadTables = async () => {
      setTablesLoading(true)
      setError(null)

      try {
        const response = await TableApiService.getTablesBySpace(activeOrganizationId, activeSpaceId)
        if (cancelled) {
          return
        }

        const nextTables = response.tables ?? []
        setTables(nextTables)
        setSelectedTableId((prevId) =>
          nextTables.some((table) => table.id === prevId) ? prevId : (nextTables[0]?.id ?? '')
        )
      } catch (loadError) {
        if (cancelled) {
          return
        }
        setTables([])
        setSelectedTableId('')
        setError(`加载表格失败：${toErrorMessage(loadError)}`)
      } finally {
        if (!cancelled) {
          setTablesLoading(false)
        }
      }
    }

    void loadTables()

    return () => {
      cancelled = true
    }
  }, [hasAccessToken, activeOrganizationId, activeSpaceId, refreshTick])

  useEffect(() => {
    if (!hasAccessToken || !selectedTableId) {
      setFields([])
      setViews([])
      setSelectedViewId(null)
      setViewRecords(null)
      setRecords([])
      return
    }
    void refreshTick

    let cancelled = false

    const loadTableMetadata = async () => {
      setMetadataLoading(true)
      setError(null)

      try {
        const [fieldResponse, viewResponse] = await Promise.all([
          FieldApiService.getFields(selectedTableId),
          ViewApiService.getViewsByTable(selectedTableId),
        ])

        if (cancelled) {
          return
        }

        const nextFields = (fieldResponse.fields ?? []) as TableField[]
        const nextViews = (viewResponse.views ?? []) as ViewMeta[]

        setFields(nextFields)
        setViews(nextViews)
        setSelectedViewId((prevViewId) => {
          if (prevViewId && nextViews.some((view) => view.id === prevViewId)) {
            return prevViewId
          }
          const defaultView = nextViews.find((view) => view.is_default)
          return defaultView?.id ?? nextViews[0]?.id ?? null
        })
      } catch (loadError) {
        if (cancelled) {
          return
        }
        setFields([])
        setViews([])
        setSelectedViewId(null)
        setError(`加载字段或视图失败：${toErrorMessage(loadError)}`)
      } finally {
        if (!cancelled) {
          setMetadataLoading(false)
        }
      }
    }

    void loadTableMetadata()

    return () => {
      cancelled = true
    }
  }, [hasAccessToken, selectedTableId, refreshTick])

  useEffect(() => {
    if (!hasAccessToken || !selectedTableId) {
      return
    }
    void refreshTick

    let cancelled = false

    const loadRecords = async () => {
      setRecordsLoading(true)
      setError(null)

      try {
        if (selectedViewId) {
          const response = await ViewApiService.getViewRecords(selectedViewId, {
            page: 1,
            page_size: pageSize,
          })

          if (cancelled || response.status === 304) {
            return
          }

          const nextViewRecords = response.data as ViewRecordsResponse | null
          setViewRecords(nextViewRecords)
          setRecords(nextViewRecords?.records ?? [])
        } else {
          const response = await RecordApiService.getRecordsByTable(selectedTableId, {
            page: 1,
            page_size: pageSize,
          })

          if (cancelled || response.status === 304) {
            return
          }

          const nextRecords = (response.data?.records ?? []) as TableRecord[]
          setViewRecords(null)
          setRecords(nextRecords)
        }
      } catch (loadError) {
        if (cancelled) {
          return
        }
        setRecords([])
        setViewRecords(null)
        setError(`加载记录失败：${toErrorMessage(loadError)}`)
      } finally {
        if (!cancelled) {
          setRecordsLoading(false)
        }
      }
    }

    void loadRecords()

    return () => {
      cancelled = true
    }
  }, [hasAccessToken, selectedTableId, selectedViewId, refreshTick, pageSize])

  return {
    tables,
    selectedTableId,
    setSelectedTableId,
    fields,
    views,
    selectedViewId,
    setSelectedViewId,
    records,
    viewRecords,
    tablesLoading,
    metadataLoading,
    recordsLoading,
    error,
    setError,
    resetData,
  }
}
