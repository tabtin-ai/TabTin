import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LinkRecordPicker,
  sliceDisplayColumns,
  type LinkPickerField,
  type LinkPickerListMode,
  type LinkPickerRecord,
} from '@tabtin/smartsheet-ui'
import {
  FieldApiService,
  LinkFieldApiService,
  type Field,
} from '@tabtin/table-core'

const PAGE_SIZE = 200

export const normalizeLinkCellValue = (
  value: unknown,
): Array<{ id: string; title?: string }> => {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.flatMap(item => {
    if (typeof item === 'string') return [{ id: item, title: item }]
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const id = String(record.id ?? '')
    if (!id) return []
    return [{ id, title: record.title ? String(record.title) : undefined }]
  })
}

interface WebLinkCellEditorProps {
  open: boolean
  onClose: () => void
  tableId: string
  recordId: string
  field: Field
  currentValue: unknown
  foreignTableName?: string
  onSave: (value: Array<{ id: string; title?: string }>) => Promise<void>
}

export const WebLinkCellEditor: React.FC<WebLinkCellEditorProps> = ({
  open,
  onClose,
  tableId,
  recordId,
  field,
  currentValue,
  foreignTableName,
  onSave,
}) => {
  const options = field.options as Record<string, unknown> | undefined
  const relationship = String(options?.relationship ?? 'ManyMany')
  const isSingleSelect = relationship === 'OneOne' || relationship === 'ManyOne'
  const visibleFieldIds = Array.isArray(options?.visibleFieldIds)
    ? options.visibleFieldIds.map(String).filter(Boolean)
    : undefined
  const initialSelected = useMemo(() => normalizeLinkCellValue(currentValue), [currentValue])
  const [selected, setSelected] = useState<Map<string, { id: string; title?: string }>>(
    () => new Map(initialSelected.map(item => [item.id, item])),
  )
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [foreignFields, setForeignFields] = useState<LinkPickerField[]>([])
  const [candidates, setCandidates] = useState<LinkPickerRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [searchFieldId, setSearchFieldId] = useState('')
  const [listMode, setListMode] = useState<LinkPickerListMode>('all')
  const requestSequenceRef = useRef(0)
  const saveSequenceRef = useRef<Promise<void>>(Promise.resolve())
  const editorSessionRef = useRef(0)

  useEffect(() => {
    if (!open) return
    editorSessionRef.current += 1
    const next = new Map(initialSelected.map(item => [item.id, item] as const))
    setSelected(next)
    selectedRef.current = next
    setSearchText('')
    setSearchFieldId('')
    setListMode('all')
    setPage(1)
  }, [initialSelected, open])

  useEffect(() => {
    const foreignTableId = String(options?.foreignTableId ?? '')
    if (!open || !foreignTableId) return
    let cancelled = false
    FieldApiService.getFields(foreignTableId).then(response => {
      if (cancelled) return
      const fields = Array.isArray(response) ? response : response?.fields ?? []
      setForeignFields(fields.map(item => ({
        id: String(item.id),
        name: item.name ?? '',
        field_type: item.field_type ?? 'text',
        is_primary: Boolean(item.is_primary),
      })))
    }).catch(() => {
      if (!cancelled) setForeignFields([])
    })
    return () => { cancelled = true }
  }, [open, options?.foreignTableId])

  const displayColumns = useMemo(
    () => sliceDisplayColumns(foreignFields, visibleFieldIds),
    [foreignFields, visibleFieldIds],
  )
  const searchFieldIds = useMemo(() => displayColumns.map(item => item.id), [displayColumns])

  const fetchCandidates = useCallback(async (nextPage: number, append: boolean) => {
    const sequence = ++requestSequenceRef.current
    setIsLoading(true)
    setLoadError(null)
    try {
      const selectedIds = Array.from(selectedRef.current.keys())
      const result = await LinkFieldApiService.getLinkableRecords(tableId, field.id, {
        search: searchText || undefined,
        search_field_id: searchFieldId || undefined,
        search_field_ids: !searchFieldId ? searchFieldIds : undefined,
        page: nextPage,
        page_size: PAGE_SIZE,
        exclude_record_id: listMode === 'all' ? recordId : undefined,
        selected_record_ids: listMode === 'selected' ? selectedIds : undefined,
        only_selected: listMode === 'selected',
      })
      if (sequence !== requestSequenceRef.current) return
      setCandidates(current => append ? [...current, ...result.records] : result.records)
      setTotal(result.total)
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return
      setLoadError(error instanceof Error ? error.message : '加载关联记录失败')
    } finally {
      if (sequence === requestSequenceRef.current) setIsLoading(false)
    }
  }, [field.id, listMode, recordId, searchFieldId, searchFieldIds, searchText, tableId])

  useEffect(() => {
    if (!open) return
    setPage(1)
    void fetchCandidates(1, false)
  }, [fetchCandidates, open])

  const persist = useCallback(async (
    next: Map<string, { id: string; title?: string }>,
    closeAfter = false,
  ) => {
    const previous = selectedRef.current
    const session = editorSessionRef.current
    setSelected(next)
    selectedRef.current = next
    const save = saveSequenceRef.current
      .catch(() => undefined)
      .then(() => onSave(Array.from(next.values())))
    saveSequenceRef.current = save
    try {
      await save
      if (closeAfter && editorSessionRef.current === session) onClose()
    } catch (error) {
      // Do not erase a newer optimistic selection when an older request fails.
      if (selectedRef.current === next) {
        setSelected(previous)
        selectedRef.current = previous
      }
      setLoadError(error instanceof Error ? error.message : '保存关联失败')
    }
  }, [onClose, onSave])

  const toggleRecord = useCallback((record: LinkPickerRecord) => {
    if (isSingleSelect) {
      void persist(new Map([[record.id, { id: record.id, title: record.title }]]), true)
      return
    }
    const next = new Map(selectedRef.current)
    next.set(record.id, { id: record.id, title: record.title })
    void persist(next)
  }, [isSingleSelect, persist])

  const removeRecord = useCallback((id: string) => {
    const next = new Map(selectedRef.current)
    next.delete(id)
    void persist(next)
  }, [persist])

  return (
    <LinkRecordPicker
      open={open}
      onClose={onClose}
      isSingleSelect={isSingleSelect}
      foreignTableName={foreignTableName}
      selected={selected}
      candidates={candidates}
      displayColumns={displayColumns}
      searchFields={displayColumns}
      isLoading={isLoading}
      hasMore={candidates.length < total}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      listMode={listMode}
      onListModeChange={setListMode}
      searchFieldId={searchFieldId}
      onSearchFieldIdChange={setSearchFieldId}
      onToggleRecord={toggleRecord}
      onRemoveRecord={removeRecord}
      onLoadMore={() => {
        const nextPage = page + 1
        setPage(nextPage)
        void fetchCandidates(nextPage, true)
      }}
      loadError={loadError}
      onRetry={() => void fetchCandidates(1, false)}
    />
  )
}
