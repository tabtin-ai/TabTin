import { useShallow } from 'zustand/react/shallow'
import { useDataGridContext } from '../DataGridContext'
import { useTableStore } from '@stores/useTableStore'
import { useRecordStore, useRecordStoreApi } from '@stores/useRecordStore'
import { useUIStore } from '@stores/useUIStore'
import { useViewStore, useViewStoreApi } from '@stores/useViewStore'
import type { ViewDraftState, ViewFilter } from '@tabtin/table-core'

const EMPTY_GROUP_IDS: string[] = []
const EMPTY_FILTERS: ViewFilter[] = []

/**
 * 将 30+ 个细粒度 store selector 合并为 6 个粗粒度"切片"selector，
 * 通过 useShallow 进行浅比较，减少不必要的 re-render。
 *
 * 优化前：36+ 个 zustand 订阅 → 任一 store 属性变化都触发 selector 评估
 * 优化后：6 个 zustand 订阅 → useShallow 确保仅当切片内属性变化时才 re-render
 */
export const useDataGridAdapterStores = () => {
  // ── Table Store: 3 个调用 → 1 个订阅 ──
  const { selectedTable, fields, loadFields, getTable } = useTableStore(
    useShallow(state => ({
      selectedTable: state.selectedTable,
      fields: state.fields,
      loadFields: state.loadFields,
      getTable: state.getTable,
    }))
  )

  // ── Record Store（数据）: 7 个调用 → 1 个订阅 ──
  const {
    records, page, pageSize, total,
    isRecordLoading, latestVersion, recordsEtag,
  } = useRecordStore(
    useShallow(state => ({
      records: state.records,
      page: state.page,
      pageSize: state.pageSize,
      total: state.total,
      isRecordLoading: state.isLoading,
      latestVersion: state.latestVersion,
      recordsEtag: state.recordsEtag,
    }))
  )

  // ── Record Store（操作）: 6 个调用 → 1 个订阅 ──
  const {
    setRecordSorting, updateRecord, loadRecordsByTable,
    createRecord, mergeIncrementalRecords, removeRecordsByIds,
  } = useRecordStore(
    useShallow(state => ({
      setRecordSorting: state.setSorting,
      updateRecord: state.updateRecord,
      loadRecordsByTable: state.loadRecordsByTable,
      createRecord: state.createRecord,
      mergeIncrementalRecords: state.mergeIncrementalRecords,
      removeRecordsByIds: state.removeRecordsByIds,
    }))
  )

  // ── UI Store: 1 个订阅（不变） ──
  const resolvedTheme = useUIStore(state => state.resolvedTheme)

  const { selectedRows, setSelectedRows, registerRecordEditor, setTotalRowsCount } = useDataGridContext()

  // ── View Store（数据 + 派生值）: 14 个调用 → 1 个订阅 ──
  // 将 currentViewId 依赖的派生值（draftFilters、collapsedGroupIds、treeExpandedRecords）
  // 内联在 selector 中，避免外部闭包依赖带来的额外订阅
  const {
    views, currentViewId, currentViewRecords, isRecordsLoading,
    isLoadingMoreRecords, recordsQuery, currentViewLatestVersion, currentViewEtag,
    currentViewDraft, draftFilters, collapsedGroupIds, treeExpandedRecords,
    runtimeTableId, wsLoadViews,
  } = useViewStore(
    useShallow(state => {
      const viewId = state.currentViewId
      return {
        views: state.views,
        currentViewId: viewId,
        currentViewRecords: state.currentViewRecords,
        isRecordsLoading: state.isRecordsLoading,
        isLoadingMoreRecords: state.isLoadingMoreRecords,
        recordsQuery: state.recordsQuery,
        currentViewLatestVersion: state.currentViewLatestVersion,
        currentViewEtag: state.currentViewEtag,
        currentViewDraft: viewId
          ? state.draftStates[viewId]
          : undefined,
        draftFilters: viewId
          ? state.draftStates[viewId]?.filters ?? EMPTY_FILTERS
          : EMPTY_FILTERS,
        collapsedGroupIds: viewId
          ? state.collapsedGroups[viewId] ?? EMPTY_GROUP_IDS
          : EMPTY_GROUP_IDS,
        treeExpandedRecords: viewId
          ? state.treeExpandedRecords[viewId]
          : undefined,
        runtimeTableId: state.tableId,
        wsLoadViews: state.loadViews,
      }
    })
  )

  // ── View Store（操作）: 11 个调用 → 1 个订阅 ──
  const {
    updateView, initializeDraft, setDraftFilters, setDraftGroups,
    applyDraft, toggleGroupCollapse, toggleTreeRecordExpanded,
    clearGroupCollapse, refreshCurrentView, loadMoreCurrentViewRecords,
  } = useViewStore(
    useShallow(state => ({
      updateView: state.updateView,
      initializeDraft: state.initializeDraft,
      setDraftFilters: state.setDraftFilters,
      setDraftGroups: state.setDraftGroups,
      applyDraft: state.applyDraft,
      toggleGroupCollapse: state.toggleGroupCollapse,
      toggleTreeRecordExpanded: state.toggleTreeRecordExpanded,
      clearGroupCollapse: state.clearGroupCollapse,
      refreshCurrentView: state.refreshCurrentView,
      loadMoreCurrentViewRecords: state.loadMoreCurrentViewRecords,
    }))
  )

  const viewStoreApi = useViewStoreApi()
  const recordStoreApi = useRecordStoreApi()

  return {
    selectedTable,
    fields,
    loadFields,
    getTable,
    records,
    page,
    pageSize,
    total,
    isRecordLoading,
    setRecordSorting,
    updateRecord,
    loadRecordsByTable,
    createRecord,
    mergeIncrementalRecords,
    removeRecordsByIds,
    latestVersion,
    recordsEtag,
    resolvedTheme,
    selectedRows,
    setSelectedRows,
    registerRecordEditor,
    setTotalRowsCount,
    views,
    currentViewId,
    updateView,
    currentViewRecords,
    isRecordsLoading,
    isLoadingMoreRecords,
    recordsQuery,
    currentViewLatestVersion,
    currentViewEtag,
    initializeDraft,
    setDraftFilters,
    setDraftGroups,
    applyDraft,
    toggleGroupCollapse,
    toggleTreeRecordExpanded,
    clearGroupCollapse,
    refreshCurrentView,
    loadMoreCurrentViewRecords,
    currentViewDraft: currentViewDraft as ViewDraftState | undefined,
    draftFilters,
    collapsedGroupIds,
    treeExpandedRecords,
    runtimeTableId,
    wsLoadViews,
    viewStoreApi,
    recordStoreApi,
  }
}
