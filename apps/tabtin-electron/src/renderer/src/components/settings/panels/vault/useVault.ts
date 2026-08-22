/**
 * useVault —— 通用 vault state hook：filter + 搜索 + 选中。
 *
 * 用法：
 *   const vault = useVault({
 *     rows: vaultRows,        // 业务面板自己 build 的 VaultRow[]
 *     filters: [
 *       { value: 'all', label: '全部', count: vaultRows.length },
 *       { value: 'active', label: '启用', count: ... },
 *       ...
 *     ],
 *     defaultFilter: 'all',
 *     filterPredicate: (row, filter) => ...,
 *     searchAccessor: (row) => [row.primary, row.secondary, ...customFields],
 *   })
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VaultFilterOption, VaultRow } from './types'

export interface UseVaultOptions<T, F extends string> {
  rows: VaultRow<T>[]
  filters: VaultFilterOption<F>[]
  defaultFilter: F
  filterPredicate: (row: VaultRow<T>, filter: F) => boolean
  /** 用于搜索匹配的字段列表生成器 */
  searchAccessor?: (row: VaultRow<T>) => string[]
}

export interface UseVaultResult<T, F extends string> {
  filter: F
  setFilter: (f: F) => void
  search: string
  setSearch: (q: string) => void
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  filteredRows: VaultRow<T>[]
  selectedRow: VaultRow<T> | null
  filterActive: boolean
}

export function useVault<T, F extends string>(opts: UseVaultOptions<T, F>): UseVaultResult<T, F> {
  const { rows, defaultFilter, filterPredicate, searchAccessor } = opts
  const [filter, setFilter] = useState<F>(defaultFilter)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filteredRows = useMemo(() => {
    let list = rows
    list = list.filter((r) => filterPredicate(r, filter))
    const q = search.trim().toLowerCase()
    if (q && searchAccessor) {
      list = list.filter((r) =>
        searchAccessor(r).some((field) => field && field.toLowerCase().includes(q)),
      )
    }
    return list
  }, [rows, filter, filterPredicate, search, searchAccessor])

  // 自动选第一项（选中项消失或首次加载）
  useEffect(() => {
    if (filteredRows.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !filteredRows.some((r) => r.id === selectedId)) {
      setSelectedId(filteredRows[0].id)
    }
  }, [filteredRows, selectedId])

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  )

  const setFilterStable = useCallback((f: F) => setFilter(f), [])
  const setSearchStable = useCallback((q: string) => setSearch(q), [])
  const setSelectedIdStable = useCallback((id: string | null) => setSelectedId(id), [])

  return {
    filter,
    setFilter: setFilterStable,
    search,
    setSearch: setSearchStable,
    selectedId,
    setSelectedId: setSelectedIdStable,
    filteredRows,
    selectedRow,
    filterActive: filter !== defaultFilter || !!search.trim(),
  }
}
