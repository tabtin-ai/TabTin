/**
 * DataGridContext — shared data grid context for toolbar ↔ grid coordination.
 *
 * Platform-agnostic React context that manages:
 * - Row selection state
 * - Search state (client-side + server-side)
 * - Record editor registration
 * - Cell highlight coordination
 * - Readonly mode
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TableGridRow } from '@tabtin/table-engine'
import type { SearchIndexHit } from '@tabtin/table-core'

export type DataGridSearchScope = 'all_fields' | 'current_field'

export type DataGridSearchNavigateDirection = 'next' | 'prev'

export interface DataGridSearchNavigateRequest {
  sequence: number
  direction: DataGridSearchNavigateDirection
}

export interface DataGridSearchStatePayload {
  matchCount: number
  currentMatchIndex: number
  currentField: string | null
  searchLimitReached?: boolean
}

export interface DataGridContextValue {
  selectedRows: TableGridRow[]
  setSelectedRows: (rows: TableGridRow[]) => void
  openRecordEditor: (row: TableGridRow | null) => void
  registerRecordEditor: (handler: (row: TableGridRow | null) => void) => void
  requestAddRow: () => void
  registerAddRowHandler: (handler: () => void) => void
  totalRowsCount: number
  setTotalRowsCount: (count: number) => void
  searchQuery: string
  setSearchQuery: (query: string) => void
  searchScope: DataGridSearchScope
  setSearchScope: (scope: DataGridSearchScope) => void
  searchSelectedFieldIds: string[]
  setSearchSelectedFieldIds: (fieldIds: string[]) => void
  searchHideNotMatchRows: boolean
  setSearchHideNotMatchRows: (value: boolean) => void
  searchNavigateRequest: DataGridSearchNavigateRequest | null
  requestSearchNavigate: (direction: DataGridSearchNavigateDirection) => void
  searchMatchCount: number
  searchCurrentMatchIndex: number
  searchCurrentField: string | null
  searchLimitReached: boolean
  reportSearchState: (payload: DataGridSearchStatePayload) => void

  serverSearchHits: SearchIndexHit[] | null
  setServerSearchHits: (hits: SearchIndexHit[] | null) => void
  serverSearchLoading: boolean
  setServerSearchLoading: (loading: boolean) => void
  serverSearchTotalCount: number | null
  setServerSearchTotalCount: (count: number | null) => void
  useServerSearch: boolean
  setUseServerSearch: (enabled: boolean) => void
  serverSearchHasMore: boolean
  setServerSearchHasMore: (hasMore: boolean) => void
  serverSearchLoadNextPage: () => void
  setServerSearchLoadNextPage: (fn: () => void) => void

  highlightCells: (recordId: string, fieldKeys: string[]) => void
  registerHighlightCells: (handler: (recordId: string, fieldKeys: string[]) => void) => void

  isTableReadonly: boolean
  setTableReadonly: (readonly: boolean) => void
}

const DataGridContext = createContext<DataGridContextValue | undefined>(undefined)

export const useDataGridContext = () => {
  const context = useContext(DataGridContext)
  if (!context) {
    throw new Error('useDataGridContext must be used within DataGridProvider')
  }
  return context
}

export const DataGridProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [selectedRows, setSelectedRows] = useState<TableGridRow[]>([])
  const [totalRowsCount, setTotalRowsCount] = useState<number>(0)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [searchScope, setSearchScope] = useState<DataGridSearchScope>('all_fields')
  const [searchSelectedFieldIds, setSearchSelectedFieldIds] = useState<string[]>([])
  const [searchHideNotMatchRows, setSearchHideNotMatchRows] = useState<boolean>(false)
  const [searchNavigateRequest, setSearchNavigateRequest] =
    useState<DataGridSearchNavigateRequest | null>(null)
  const [searchMatchCount, setSearchMatchCount] = useState<number>(0)
  const [searchCurrentMatchIndex, setSearchCurrentMatchIndex] = useState<number>(-1)
  const [searchCurrentField, setSearchCurrentField] = useState<string | null>(null)
  const [searchLimitReached, setSearchLimitReached] = useState<boolean>(false)
  const [serverSearchHits, setServerSearchHits] = useState<SearchIndexHit[] | null>(null)
  const [serverSearchLoading, setServerSearchLoading] = useState<boolean>(false)
  const [serverSearchTotalCount, setServerSearchTotalCount] = useState<number | null>(null)
  const [useServerSearch, setUseServerSearch] = useState<boolean>(false)
  const [serverSearchHasMore, setServerSearchHasMore] = useState<boolean>(false)
  const serverSearchLoadNextPageRef = useRef<() => void>(() => {})
  const serverSearchLoadNextPage = useCallback(() => {
    serverSearchLoadNextPageRef.current()
  }, [])
  const setServerSearchLoadNextPage = useCallback((fn: () => void) => {
    serverSearchLoadNextPageRef.current = fn
  }, [])
  const [isTableReadonly, setTableReadonly] = useState<boolean>(false)

  const highlightCellsHandlerRef = useRef<(recordId: string, fieldKeys: string[]) => void>(() => {})

  const highlightCells = useCallback((recordId: string, fieldKeys: string[]) => {
    highlightCellsHandlerRef.current(recordId, fieldKeys)
  }, [])

  const registerHighlightCells = useCallback((handler: (recordId: string, fieldKeys: string[]) => void) => {
    highlightCellsHandlerRef.current = handler
  }, [])

  const recordEditorHandlerRef = useRef<(row: TableGridRow | null) => void>(() => {})

  const openRecordEditor = useCallback((row: TableGridRow | null) => {
    recordEditorHandlerRef.current(row)
  }, [])

  const registerRecordEditor = useCallback((handler: (row: TableGridRow | null) => void) => {
    recordEditorHandlerRef.current = handler
  }, [])

  const addRowHandlerRef = useRef<() => void>(() => {})

  const requestAddRow = useCallback(() => {
    addRowHandlerRef.current()
  }, [])

  const registerAddRowHandler = useCallback((handler: () => void) => {
    addRowHandlerRef.current = handler
  }, [])

  const requestSearchNavigate = useCallback((direction: DataGridSearchNavigateDirection) => {
    setSearchNavigateRequest(prev => ({
      sequence: (prev?.sequence ?? 0) + 1,
      direction,
    }))
  }, [])

  const reportSearchState = useCallback((payload: DataGridSearchStatePayload) => {
    setSearchMatchCount(payload.matchCount)
    setSearchCurrentMatchIndex(payload.currentMatchIndex)
    setSearchCurrentField(payload.currentField)
    setSearchLimitReached(Boolean(payload.searchLimitReached))
  }, [])

  const value = useMemo(() => ({
    selectedRows,
    setSelectedRows,
    openRecordEditor,
    registerRecordEditor,
    requestAddRow,
    registerAddRowHandler,
    totalRowsCount,
    setTotalRowsCount,
    searchQuery,
    setSearchQuery,
    searchScope,
    setSearchScope,
    searchSelectedFieldIds,
    setSearchSelectedFieldIds,
    searchHideNotMatchRows,
    setSearchHideNotMatchRows,
    searchNavigateRequest,
    requestSearchNavigate,
    searchMatchCount,
    searchCurrentMatchIndex,
    searchCurrentField,
    searchLimitReached,
    reportSearchState,
    serverSearchHits,
    setServerSearchHits,
    serverSearchLoading,
    setServerSearchLoading,
    serverSearchTotalCount,
    setServerSearchTotalCount,
    useServerSearch,
    setUseServerSearch,
    serverSearchHasMore,
    setServerSearchHasMore,
    serverSearchLoadNextPage,
    setServerSearchLoadNextPage,
    highlightCells,
    registerHighlightCells,
    isTableReadonly,
    setTableReadonly,
  }), [
    selectedRows,
    openRecordEditor,
    registerRecordEditor,
    requestAddRow,
    registerAddRowHandler,
    totalRowsCount,
    searchQuery,
    searchScope,
    searchSelectedFieldIds,
    searchHideNotMatchRows,
    searchNavigateRequest,
    requestSearchNavigate,
    searchMatchCount,
    searchCurrentMatchIndex,
    searchCurrentField,
    searchLimitReached,
    reportSearchState,
    serverSearchHits,
    serverSearchLoading,
    serverSearchTotalCount,
    useServerSearch,
    serverSearchHasMore,
    serverSearchLoadNextPage,
    setServerSearchLoadNextPage,
    highlightCells,
    registerHighlightCells,
    isTableReadonly,
  ])

  return (
    <DataGridContext.Provider value={value}>
      {children}
    </DataGridContext.Provider>
  )
}
