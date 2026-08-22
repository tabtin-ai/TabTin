import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TableGridRuntimeApi } from '@tabtin/table-engine'
import { shouldActivateGridForSearchMatch, type DataGridSearchScope } from '@tabtin/table-ui'
import { cellTextMatchesSearchQuery, type Field } from '@tabtin/table-core'

export type SearchMatch = { rowIndex: number; field: string; rowId: string; fieldId: string }

export interface UseTablePaneSearchDeps {
  fields: readonly Field[]
  groupedRows: readonly Record<string, unknown>[]
  currentViewId: string | null
  fetchViewRecords: (viewId: string, query: Record<string, unknown>) => Promise<unknown>
  recordsQuery: Record<string, unknown> | null
  gridApiRef: React.RefObject<TableGridRuntimeApi | null>
  onFocusRecord?: (recordId: string) => void
}

export function useTablePaneSearch(deps: UseTablePaneSearchDeps) {
  const {
    fields,
    groupedRows,
    currentViewId,
    fetchViewRecords,
    recordsQuery,
    gridApiRef,
    onFocusRecord,
  } = deps

  const [searchQuery, setSearchQuery] = useState('')
  const [searchScope, setSearchScope] = useState<DataGridSearchScope>('all_fields')
  const [searchSelectedFieldIds, setSearchSelectedFieldIds] = useState<string[]>([])
  const [searchHideNotMatchRows, setSearchHideNotMatchRows] = useState(false)
  const [searchCurrentMatchIdx, setSearchCurrentMatchIdx] = useState(-1)

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recordsQueryRef = useRef(recordsQuery)
  recordsQueryRef.current = recordsQuery

  const fieldNameToFieldId = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of fields) {
      if (f.name && f.id) map.set(f.name, f.id)
    }
    return map
  }, [fields])

  // Debounced remote search
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!currentViewId) return

    searchDebounceRef.current = setTimeout(() => {
      const trimmedQuery = searchQuery.trim()
      const searchFieldIds =
        searchScope === 'current_field' && searchSelectedFieldIds.length > 0
          ? searchSelectedFieldIds
          : undefined

      void fetchViewRecords(currentViewId, {
        ...recordsQueryRef.current,
        search: trimmedQuery || undefined,
        search_field_ids: searchFieldIds,
        search_hide_not_match_rows: trimmedQuery ? searchHideNotMatchRows : undefined,
        page: 1,
      })
    }, 300)

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery, searchScope, searchSelectedFieldIds, searchHideNotMatchRows, currentViewId, fetchViewRecords])

  // Client-side matching
  const searchMatches = useMemo((): SearchMatch[] => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return []

    const rows = groupedRows ?? []
    const activeFieldNames: string[] = []
    if (searchScope === 'current_field' && searchSelectedFieldIds.length > 0) {
      const idSet = new Set(searchSelectedFieldIds)
      for (const f of fields) {
        if (idSet.has(f.id)) activeFieldNames.push(f.name)
      }
    } else {
      for (const f of fields) activeFieldNames.push(f.name)
    }
    if (activeFieldNames.length === 0) return []

    const matches: SearchMatch[] = []
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri] as Record<string, unknown>
      if (row.__rowType === 'group_header' || row.__rowType === 'group_add' || row.__rowType === 'add') continue
      const rowId = String(row.id ?? '')
      if (!rowId) continue

      for (const fn of activeFieldNames) {
        const val = row[fn]
        if (val == null) continue
        // 只匹配展示文本，避免 link/user UUID id 被数字查询误命中
        if (cellTextMatchesSearchQuery(q, val)) {
          const fid = fieldNameToFieldId.get(fn)
          if (fid) matches.push({ rowIndex: ri, field: fn, rowId, fieldId: fid })
        }
      }
    }
    return matches
  }, [searchQuery, groupedRows, fields, searchScope, searchSelectedFieldIds, fieldNameToFieldId])

  useEffect(() => {
    setSearchCurrentMatchIdx(searchMatches.length > 0 ? 0 : -1)
  }, [searchMatches])

  const searchHitIndex = useMemo(() => {
    if (searchMatches.length === 0) return undefined
    const hits: { fieldId: string; recordId: string }[] = []
    const seen = new Set<string>()
    for (const m of searchMatches) {
      const key = `${m.rowId}-${m.fieldId}`
      if (!seen.has(key)) {
        seen.add(key)
        hits.push({ fieldId: m.fieldId, recordId: m.rowId })
      }
    }
    return hits
  }, [searchMatches])

  const focusSearchMatch = useCallback((match: SearchMatch) => {
    if (onFocusRecord) {
      onFocusRecord(match.rowId)
      return
    }
    const api = gridApiRef.current
    if (!api) return
    api.ensureIndexVisible?.(match.rowIndex, 'middle')
    requestAnimationFrame(() => {
      if (!shouldActivateGridForSearchMatch()) return
      api.setFocusedCell?.(match.rowIndex, match.field)
    })
  }, [gridApiRef, onFocusRecord])

  const handleSearchNavigateNext = useCallback(() => {
    if (searchMatches.length === 0) return
    const nextIdx = searchCurrentMatchIdx + 1 >= searchMatches.length ? 0 : searchCurrentMatchIdx + 1
    setSearchCurrentMatchIdx(nextIdx)
    focusSearchMatch(searchMatches[nextIdx])
  }, [searchMatches, searchCurrentMatchIdx, focusSearchMatch])

  const handleSearchNavigatePrev = useCallback(() => {
    if (searchMatches.length === 0) return
    const prevIdx = searchCurrentMatchIdx - 1 < 0 ? searchMatches.length - 1 : searchCurrentMatchIdx - 1
    setSearchCurrentMatchIdx(prevIdx)
    focusSearchMatch(searchMatches[prevIdx])
  }, [searchMatches, searchCurrentMatchIdx, focusSearchMatch])

  return {
    searchQuery, setSearchQuery,
    searchScope, setSearchScope,
    searchSelectedFieldIds, setSearchSelectedFieldIds,
    searchHideNotMatchRows, setSearchHideNotMatchRows,
    searchCurrentMatchIdx,
    searchMatches,
    searchHitIndex,
    handleSearchNavigateNext,
    handleSearchNavigatePrev,
  }
}
