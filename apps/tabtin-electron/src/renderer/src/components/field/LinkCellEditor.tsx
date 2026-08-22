/**
 * LinkCellEditor — Electron 宿主：注入 API / 导航 / toast，UI 用共享 LinkRecordPicker
 *
 * 「全部」不排除已选；「已选择」走 only_selected。
 * 「+ 添加记录」打开目标表完整 RecordFormDialog（LinkedRecordCreateHost）。
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  toast,
  LinkRecordPicker,
  sliceDisplayColumns,
  type LinkPickerRecord,
  type LinkPickerListMode,
} from '@tabtin/smartsheet-ui'
import { FieldApiService, LinkFieldApiService, TableApiService } from '@tabtin/table-core'
import type { LinkableRecordItem, LinkableFieldItem } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'
import { LinkedRecordCreateHost } from '@/components/record/LinkedRecordCreateHost'
import { resolveForegroundTabScopeKey } from '@/components/chat/subagent/openSubagentTab'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useTableStore } from '@/stores/useTableStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('LinkCellEditor')

export interface LinkCellEditorProps {
  open: boolean
  onClose: () => void
  tableId: string
  recordId: string
  fieldId: string
  fieldConfig: {
    foreignTableId: string
    relationship: string
    lookupFieldId?: string
    isOneWay?: boolean
    visibleFieldIds?: string[]
    filterByViewId?: string
  }
  currentValue: Array<{ id: string; title?: string }>
  onSave: (newValue: Array<{ id: string; title?: string }>) => Promise<void>
  spaceId?: string
  /** 打开目标表记录完整详情（复用主字段展开 → 编辑记录侧栏） */
  onOpenLinkedRecord?: (payload: {
    foreignTableId: string
    recordId: string
    title?: string
  }) => void
}

const PAGE_SIZE = 200
const SAVE_DEBOUNCE_MS = 200

type SelectedMap = Map<string, { id: string; title?: string }>

export const LinkCellEditor: React.FC<LinkCellEditorProps> = ({
  open,
  onClose,
  tableId,
  recordId,
  fieldId,
  fieldConfig,
  currentValue,
  onSave,
  spaceId: spaceIdProp,
  onOpenLinkedRecord,
}) => {
  const { t } = useTranslation('field')

  const isSingleSelect =
    fieldConfig.relationship === 'OneOne' || fieldConfig.relationship === 'ManyOne'

  const openTableTab = useSpaceContextTabsStore((s) => s.openTableTab)
  const storeSpaceId = useSpaceStore((s) => s.selectedSpace?.id)
  const resolvedSpaceId = spaceIdProp || storeSpaceId
  const storeTables = useTableStore((s) => s.tables)

  const [selected, setSelected] = useState<SelectedMap>(new Map())
  const [foreignFields, setForeignFields] = useState<LinkableFieldItem[]>([])
  const [foreignTableName, setForeignTableName] = useState<string>('')
  const [candidates, setCandidates] = useState<LinkableRecordItem[]>([])
  const [candidatesTotal, setCandidatesTotal] = useState(0)
  const [candidatesPage, setCandidatesPage] = useState(1)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [searchFieldId, setSearchFieldId] = useState('')
  const [listMode, setListMode] = useState<LinkPickerListMode>('all')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [previewRecord, setPreviewRecord] = useState<LinkPickerRecord | null>(null)

  const fetchRequestSeqRef = useRef(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  /** 最近一次服务端已确认的选择，失败时回滚到此 */
  const confirmedSelectedRef = useRef<SelectedMap>(new Map())
  const latestSelectedRef = useRef(selected)
  latestSelectedRef.current = selected
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const saveVersionRef = useRef(0)

  const displayColumns = useMemo(
    () => sliceDisplayColumns(foreignFields, fieldConfig.visibleFieldIds),
    [foreignFields, fieldConfig.visibleFieldIds],
  )

  /** 搜索范围 = 表头可见列（不含隐藏字段 / 非表头噪声项） */
  const searchScopeFieldIds = useMemo(
    () => displayColumns.map((col) => col.id).filter(Boolean),
    [displayColumns],
  )

  // 当前选中的搜索字段若不在表头列中，回退到「全局」
  useEffect(() => {
    if (!searchFieldId) return
    if (!searchScopeFieldIds.includes(searchFieldId)) {
      setSearchFieldId('')
    }
  }, [searchFieldId, searchScopeFieldIds])

  const cloneSelected = (source: SelectedMap): SelectedMap =>
    new Map(Array.from(source.entries()).map(([id, item]) => [id, { ...item }]))

  // ── Initialize ──
  useEffect(() => {
    if (!open) return
    const map = new Map<string, { id: string; title?: string }>()
    for (const item of currentValue) {
      map.set(item.id, item)
    }
    setSelected(map)
    confirmedSelectedRef.current = cloneSelected(map)
    latestSelectedRef.current = map
    setSearchText('')
    setSearchFieldId('')
    setListMode('all')
    setCandidatesPage(1)
    setShowCreateDialog(false)
    setPreviewRecord(null)
    setLoadError(null)
    saveVersionRef.current = 0

    const fromStore = storeTables.find((tb) => tb.id === fieldConfig.foreignTableId)
    if (fromStore?.name) {
      setForeignTableName(fromStore.name)
    } else {
      TableApiService.getTable(fieldConfig.foreignTableId)
        .then((tb: { name?: string } | null) => {
          if (tb?.name) setForeignTableName(tb.name)
        })
        .catch(() => {
          /* ignore — 标题旁数据源可缺省 */
        })
    }
  }, [open, currentValue, fieldConfig.foreignTableId, storeTables])

  // ── Load foreign fields ──
  // 按目标表拉字段元数据（与字段设置面板一致），避免 getLinkableFields
  // 静默失败时 displayColumns 为空，选择器退回只显示「显示字段」标题。
  useEffect(() => {
    if (!open || !fieldConfig.foreignTableId) return
    let cancelled = false
    FieldApiService.getFields(fieldConfig.foreignTableId)
      .then((resp) => {
        if (cancelled) return
        const fieldList = resp?.fields ?? resp
        const mapped: LinkableFieldItem[] = (Array.isArray(fieldList) ? fieldList : []).map((f) => ({
          id: String(f.id),
          name: f.name || '',
          field_type: f.field_type || 'text',
          is_primary: Boolean(f.is_primary),
        }))
        setForeignFields(mapped)
      })
      .catch((err) => {
        if (cancelled) return
        log.error('Failed to load foreign fields:', err)
        setForeignFields([])
        toast({
          title: t('fieldSettingPanel.linkEditor.loadFieldsFailed'),
          variant: 'destructive',
        })
      })
    return () => {
      cancelled = true
    }
  }, [open, fieldConfig.foreignTableId, t])

  const fetchCandidates = useCallback(
    async (
      search: string,
      page: number,
      append: boolean,
      mode: LinkPickerListMode = listMode,
      fieldIdForSearch: string = searchFieldId,
      _retried = false,
    ) => {
      const requestSeq = ++fetchRequestSeqRef.current
      setIsLoading(true)
      setLoadError(null)
      try {
        const selectedRecordIds = Array.from(selectedRef.current.keys())
        // 「全部」：不传 selected_record_ids，列表含已选并可勾选/取消
        // 「已选择」：only_selected + selected_record_ids，按选中顺序
        const result = await LinkFieldApiService.getLinkableRecords(tableId, fieldId, {
          search: search || undefined,
          search_field_id: fieldIdForSearch || undefined,
          // 全局：只搜表头列展示文本，不扫隐藏列 / record id
          search_field_ids:
            !fieldIdForSearch && searchScopeFieldIds.length > 0
              ? searchScopeFieldIds
              : undefined,
          page,
          page_size: PAGE_SIZE,
          exclude_record_id: mode === 'all' ? recordId : undefined,
          selected_record_ids:
            mode === 'selected' && selectedRecordIds.length > 0
              ? selectedRecordIds
              : undefined,
          only_selected: mode === 'selected',
        })
        if (requestSeq !== fetchRequestSeqRef.current) return
        if (mode === 'selected' && selectedRecordIds.length === 0) {
          setCandidates([])
          setCandidatesTotal(0)
          return
        }
        if (append) {
          setCandidates((prev) => [...prev, ...result.records])
        } else {
          setCandidates(result.records)
        }
        setCandidatesTotal(result.total)
      } catch (err) {
        if (requestSeq !== fetchRequestSeqRef.current) return
        log.error('Failed to fetch linkable records:', err)
        if (!_retried) {
          void fetchCandidates(search, page, append, mode, fieldIdForSearch, true)
          return
        }
        setLoadError(
          t('fieldSettingPanel.linkEditor.loadRecordsFailed', {
            defaultValue: '加载记录失败，请重试',
          }),
        )
      } finally {
        if (requestSeq !== fetchRequestSeqRef.current) return
        setIsLoading(false)
      }
    },
    [tableId, fieldId, recordId, listMode, searchFieldId, searchScopeFieldIds, t],
  )

  // 搜索触发防抖在 LinkRecordPicker 输入侧完成；此处 searchText 变更即拉数
  useEffect(() => {
    if (!open) return
    setCandidatesPage(1)
    void fetchCandidates(searchText, 1, false, listMode, searchFieldId)
  }, [open, searchText, searchFieldId, listMode, fetchCandidates])

  const handleLoadMore = useCallback(() => {
    const nextPage = candidatesPage + 1
    setCandidatesPage(nextPage)
    void fetchCandidates(searchText, nextPage, true, listMode, searchFieldId)
  }, [candidatesPage, searchText, listMode, searchFieldId, fetchCandidates])

  const handleListModeChange = useCallback((mode: LinkPickerListMode) => {
    setListMode(mode)
    setCandidatesPage(1)
    setPreviewRecord(null)
  }, [])

  const persistSelection = useCallback(
    async (next: SelectedMap, closeAfter = false) => {
      const version = ++saveVersionRef.current
      const snapshot = cloneSelected(next)

      const run = async () => {
        setIsSaving(true)
        try {
          await onSave(Array.from(snapshot.values()))
          // 仅采纳最新版本；旧请求成功也不覆盖 confirmed
          if (version === saveVersionRef.current) {
            confirmedSelectedRef.current = cloneSelected(snapshot)
          }
          if (closeAfter && version === saveVersionRef.current) {
            onClose()
          }
        } catch (err) {
          log.error('Save failed:', err)
          if (version === saveVersionRef.current) {
            toast({
              title: t('fieldSettingPanel.linkEditor.saveFailed', {
                defaultValue: '保存关联失败',
              }),
              variant: 'destructive',
            })
            const rollback = cloneSelected(confirmedSelectedRef.current)
            setSelected(rollback)
            latestSelectedRef.current = rollback
            // 已选择 Tab 下需刷新列表
            setCandidatesPage(1)
            void fetchCandidates(searchText, 1, false, listMode, searchFieldId)
          }
        } finally {
          if (version === saveVersionRef.current) {
            setIsSaving(false)
          }
        }
      }

      saveQueueRef.current = saveQueueRef.current.then(run, run)
      await saveQueueRef.current
    },
    [onSave, onClose, t, fetchCandidates, searchText, listMode, searchFieldId],
  )

  const schedulePersist = useCallback(
    (next: SelectedMap) => {
      latestSelectedRef.current = next
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        void persistSelection(latestSelectedRef.current, false)
      }, SAVE_DEBOUNCE_MS)
    },
    [persistSelection],
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  const refreshIfSelectedTab = useCallback(
    (next: SelectedMap) => {
      if (listMode !== 'selected') return
      selectedRef.current = next
      setCandidatesPage(1)
      void fetchCandidates(searchText, 1, false, 'selected', searchFieldId)
    },
    [listMode, fetchCandidates, searchText, searchFieldId],
  )

  const toggleRecord = useCallback(
    (record: LinkPickerRecord) => {
      if (isSingleSelect) {
        const value = [{ id: record.id, title: record.title }]
        const next = new Map([[record.id, value[0]]])
        setSelected(next)
        latestSelectedRef.current = next
        void persistSelection(next, true)
        return
      }
      setSelected((prev) => {
        const next = new Map(prev)
        if (next.has(record.id)) {
          next.delete(record.id)
        } else {
          next.set(record.id, { id: record.id, title: record.title })
        }
        schedulePersist(next)
        refreshIfSelectedTab(next)
        return next
      })
    },
    [isSingleSelect, persistSelection, schedulePersist, refreshIfSelectedTab],
  )

  const removeRecord = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Map(prev)
        next.delete(id)
        if (isSingleSelect) {
          latestSelectedRef.current = next
          void persistSelection(next, false)
        } else {
          schedulePersist(next)
        }
        refreshIfSelectedTab(next)
        return next
      })
    },
    [isSingleSelect, persistSelection, schedulePersist, refreshIfSelectedTab],
  )

  const handleClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      void persistSelection(latestSelectedRef.current, false).finally(() => onClose())
      return
    }
    void saveQueueRef.current.finally(() => onClose())
  }, [onClose, persistSelection])

  const handleGoToForeignTable = useCallback(() => {
    if (!resolvedSpaceId || !fieldConfig.foreignTableId) return
    const tabScopeKey = resolveForegroundTabScopeKey(resolvedSpaceId) || resolvedSpaceId
    log.info('goToForeignTable', {
      foreignTableId: fieldConfig.foreignTableId,
      tabScopeKey,
    })
    openTableTab(tabScopeKey, fieldConfig.foreignTableId)
    handleClose()
  }, [resolvedSpaceId, fieldConfig.foreignTableId, openTableTab, handleClose])

  const handleOpenFullRecord = useCallback(
    (record: LinkPickerRecord) => {
      if (!onOpenLinkedRecord || !fieldConfig.foreignTableId) return
      // 先关选择器，再开详情侧栏，避免 Dialog/Sheet 叠层
      const openDetail = () => {
        onOpenLinkedRecord({
          foreignTableId: fieldConfig.foreignTableId,
          recordId: record.id,
          title: record.title,
        })
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        void persistSelection(latestSelectedRef.current, false).finally(() => {
          onClose()
          openDetail()
        })
        return
      }
      void saveQueueRef.current.finally(() => {
        onClose()
        openDetail()
      })
    },
    [onOpenLinkedRecord, fieldConfig.foreignTableId, persistSelection, onClose],
  )

  const handleCreatedRecord = useCallback(
    (created: { id: string; title?: string }) => {
      const next = new Map(selectedRef.current)
      if (isSingleSelect) next.clear()
      next.set(created.id, { id: created.id, title: created.title })
      setSelected(next)
      latestSelectedRef.current = next
      selectedRef.current = next
      void persistSelection(next, isSingleSelect)
      setCandidatesPage(1)
      void fetchCandidates(searchText, 1, false, listMode, searchFieldId)
      toast({ title: t('fieldSettingPanel.linkEditor.createRecordSuccess') })
    },
    [
      isSingleSelect,
      persistSelection,
      fetchCandidates,
      searchText,
      listMode,
      searchFieldId,
      t,
    ],
  )

  // 新建表单打开时挂起选择器：modal Dialog 的 RemoveScroll 会吃掉外侧 Sheet 滚轮
  const pickerOpen = open && !showCreateDialog

  return (
    <>
      <LinkRecordPicker
        open={pickerOpen}
        onClose={handleClose}
        isSingleSelect={isSingleSelect}
        foreignTableName={foreignTableName || undefined}
        selected={selected}
        candidates={candidates}
        displayColumns={displayColumns}
        searchFields={displayColumns}
        isLoading={isLoading || isSaving}
        hasMore={candidates.length < candidatesTotal}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        listMode={listMode}
        onListModeChange={handleListModeChange}
        searchFieldId={searchFieldId}
        onSearchFieldIdChange={setSearchFieldId}
        onToggleRecord={toggleRecord}
        onRemoveRecord={removeRecord}
        onLoadMore={handleLoadMore}
        onGoToForeignTable={
          resolvedSpaceId && fieldConfig.foreignTableId ? handleGoToForeignTable : undefined
        }
        onCreateRecord={
          fieldConfig.foreignTableId ? () => setShowCreateDialog(true) : undefined
        }
        previewRecord={previewRecord}
        onPreviewRecordChange={setPreviewRecord}
        onOpenFullRecord={onOpenLinkedRecord ? handleOpenFullRecord : undefined}
        loadError={loadError}
        onRetry={() => {
          setCandidatesPage(1)
          void fetchCandidates(searchText, 1, false, listMode, searchFieldId)
        }}
      />
      {fieldConfig.foreignTableId ? (
        <LinkedRecordCreateHost
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          foreignTableId={fieldConfig.foreignTableId}
          onCreated={handleCreatedRecord}
          coordinateDrawers={false}
        />
      ) : null}
    </>
  )
}
