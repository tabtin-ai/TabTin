/**
 * TableCollabContext — 表级协作运行时（跨视图共享）
 *
 * 背景：此前 Y.js 协作栈只挂在 grid 视图的 DataGridAdapter 内，切到
 * kanban / calendar / gallery / flashcard 等非 grid 视图时 DataGridAdapter 卸载、
 * 连接随之断开，导致非 grid 视图缺少实时协同（看不到他人变更、写操作走纯 REST）。
 *
 * 本 Provider 把协作生命周期上提到 ViewContainer（表级），与 view_type 解耦：
 *   - 单一 Y.js 连接随表存活，切换视图不再断连；
 *   - Y.Doc / REST / fallback 都作为远程输入通道，统一归一化后写入 view store / record store；
 *   - 所有视图（含 grid / 非 grid）只读 currentViewRecords，避免 UI 直接读 Y.Doc 派生快照；
 *   - 暴露 collab-wrapped 的 updateRecord / createRecord，供非 grid 视图协作写入；
 *   - 同步 presence（协作者 / 光标 / undo-redo）与视图配置协作入口到 useTableCollabStore，
 *     供 Header / ViewFilterGroupBar 跨视图消费。
 *
 * grid 视图（DataGridAdapter）改为从本 Context 消费协作桥接，而不再自建连接，
 * 保证全表只有一份 Y.js 连接。
 */

import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { CollabStatus } from '@tabtin/collab-core'
import type {
  Field,
  FieldType,
  FieldOptions,
  FieldDefaultValue,
  RecordOrderContext,
  TableRecord,
  ViewCreateRequest,
  ViewMeta,
  ViewStore,
} from '@tabtin/table-core'
import {
  getViewColumnMeta,
  insertFieldIntoViewConfig,
  reconcileCleanDraft,
  shouldSyncRestFieldsToYDoc,
} from '@tabtin/table-core'
import {
  applyViewUpdatePayload,
  buildCollabViewRecords,
  buildKanbanViewRecords,
  buildCalendarViewRecords,
  mergeViewsLifecycleIntoYDoc,
  resolveCollabViewUpdateBase,
  findFieldMetaIndex,
  orderFieldsMeta,
  COLLAB_ORIGIN_MIRROR,
} from '@tabtin/table-engine/collab'
import { useIncrementalViewMerge } from '@tabtin/table-engine/sync'
import { useTableStore } from '@stores/useTableStore'
import { isReadonlyTableRole } from './tablePermissions'
import { useRecordStore } from '@stores/useRecordStore'
import { useViewStore, useViewStoreApi } from '@stores/useViewStore'
import { useTableCollabStore } from '@stores/useTableCollabStore'
import {
  useDataGridCollabBridge,
  type UseDataGridCollabBridgeResult,
} from './controller/useDataGridCollabBridge'
import {
  buildFieldIdByName,
  buildFieldIdToHex,
  toFieldIdPayload,
  recordToHexCells,
} from './collabMirrorUtils'
import {
  useDataGridCollabSyncUI,
  type DisconnectPhase,
} from './hooks/useDataGridCollabSyncUI'
import { usePersonalViewResolution } from './hooks/usePersonalViewResolution'
import {
  collabYdocRecordsMissingFromStore,
  collabProjectionMetadataDropped,
  shouldFetchConfirmedRuntimeViewRecords,
  shouldProjectViewRecordsFromCollabYdoc,
  shouldUseRestRecordsQuery,
} from './collabViewRecordsSync'
import { useIsContextTabActive } from '@/hooks/useIsContextTabActive'
import { createLogger } from '@/utils/logger'
import {
  markDeletedFieldSchemaTombstone,
  planFieldSchemaViewRefresh,
  shouldReconcileSchemaOnCollabOnline,
  shouldReconcileSchemaOnTabActivate,
  shouldSkipFieldSchemaRefreshForRecentLocalDelete,
} from './collabFieldSchemaRefreshGuard'
import {
  createRestBackedCollabView,
  deleteRestBackedCollabView,
} from './collabViewLifecycle'

type UpdateViewFn = ViewStore['updateView']

const log = createLogger('TableCollabProvider')

export {
  shouldUseRestRecordsQuery,
  shouldProjectViewRecordsFromCollabYdoc,
  hasServerScopedRecordsQuery,
} from './collabViewRecordsSync'

export interface TableCollabContextValue {
  /** 内嵌表格宿主文档；用于所有访问链路携带相同权限上下文。 */
  parentDocumentId: string | null
  /** 完整协作桥接结果（grid 视图深度消费） */
  collabBridge: UseDataGridCollabBridgeResult
  /** 协作实时运行中（在线且非降级 fallback） */
  isCollabRuntime: boolean
  /** collab-aware 记录写入：在线写 Y.Doc + 乐观合并，否则回退 REST */
  updateRecord: UseDataGridCollabBridgeResult['updateRecord']
  /**
   * 按「字段名」写入记录（内部转字段 id 后走协作桥接）。
   * 供非 grid 视图（kanban 拖拽 / RecordForm 等）使用——它们的 payload 以字段名为键，
   * 而协作桥接要求字段 id，故在此集中转换，避免各处重复且防止键空间不匹配丢写。
   */
  updateRecordFields: (
    recordId: string,
    fieldValuesByName: Record<string, unknown>,
  ) => Promise<TableRecord | null>
  /** 按「字段名」创建记录（内部转字段 id 后走协作桥接） */
  createRecordFields: (
    fieldValuesByName: Record<string, unknown>,
    orderContext?: RecordOrderContext,
  ) => Promise<TableRecord | null>
  /**
   * 把 REST 已持久化的记录镜像进本地 Y.Doc（协作在线时）。
   * 用于剪贴板批量 / 插入 / 子记录 / 回收站恢复等走 REST 的写入点，使本端不回弹、他端实时。
   * 已存在记录 → 更新单元格；新记录 → addRecord（行序追加，刷新后归位）。离线为 no-op。
   */
  mirrorRecordsToCollab: (records: TableRecord[]) => void
  /** 把 REST 已删除的记录从本地 Y.Doc 移除（协作在线时）。离线为 no-op。 */
  mirrorRecordDeletesToCollab: (recordIds: string[]) => void
  /**
   * 取消尚未服务端确认的协作新建（折叠删除）。
   * 返回实际取消的 ID；这些 ID 不得再发 REST bulk-delete。
   * 同时会调用 grid 注册的 overlay 清理，避免工具栏路径残留本地插入层。
   */
  cancelPendingCollabCreates: (recordIds: readonly string[]) => string[]
  /**
   * DataGrid 注册本地新建 overlay 清理器，供折叠取消 / 跨入口删除共用。
   * 返回反注册函数。
   */
  registerLocalCreateOverlayRemover: (
    remover: ((recordIds: readonly string[]) => void) | null,
  ) => () => void
  /**
   * 当前视图的「权威配置」快照：协作在线时取 Y.Doc viewsMeta 派生（含个人视图解析），
   * 否则回退 view store。非 grid 视图（calendar / kanban / gallery）的「首次配置卡」
   * 与 controller 应消费它而非裸 store views——否则 `updateViewForRuntime` 写完 Y.Doc 后
   * store views 要等协作服务端回流 REST 才更新，配置卡会延迟刷新（ 回归）。
   */
  effectiveCurrentView: ViewMeta | null
  /** collab-aware 视图配置更新：在线写 Y.Doc viewsMeta，否则走 REST */
  updateViewForRuntime: UpdateViewFn
  /** 先持久化删除，再从 Y.Doc viewsMeta 移除视图。 */
  deleteViewForRuntime: (viewId: string) => Promise<boolean>
  /** 协作在线时先持久化视图，再镜像到 Y.Doc viewsMeta */
  createViewForRuntime: (
    payload: Omit<ViewCreateRequest, 'table_id'> & { table_id?: string },
  ) => Promise<ViewMeta | null>
  /** 协作在线时在 Y.Doc meta.fields 新建字段 */
  createFieldForRuntime: (payload: {
    name: string
    field_type: string
    description?: string
    default_value?: FieldDefaultValue | null
    options?: Record<string, unknown>
    order?: number
    insert_position?: 'before' | 'after'
    reference_field_id?: string
  }) => Promise<Record<string, unknown> | null>
  /** 协作在线时更新 Y.Doc meta.fields */
  updateFieldForRuntime: (
    fieldId: string,
    payload: {
      name?: string
      field_type?: string
      options?: Record<string, unknown>
      default_value?: FieldDefaultValue | null
    },
  ) => Promise<void>
  /** 协作在线时从 Y.Doc meta.fields 移除字段 */
  deleteFieldForRuntime: (fieldId: string) => void
  /** 断连三阶段（grid banner 消费） */
  disconnectPhase: DisconnectPhase
  disconnectSeconds: number
  handleForceReconnect: () => void
  /** 选中 cell 时广播 Awareness 光标（grid canvas 消费） */
  handleCollabCellFocus: (selState: {
    activeCell?: { rowId?: string; field?: string } | null
  }) => void
}

const TableCollabContext = createContext<TableCollabContextValue | null>(null)

/**
 * 消费表级协作运行时。必须在 TableCollabProvider 下使用。
 */
export function useTableCollab(): TableCollabContextValue {
  const value = useContext(TableCollabContext)
  if (!value) {
    throw new Error('useTableCollab 必须在 TableCollabProvider 内使用')
  }
  return value
}

/**
 * 可选消费表级协作运行时——provider 外返回 null（不抛错）。
 * 供既能在表内、也可能被复用到表外的共享组件（如 RecordFormContainer）使用。
 */
export function useTableCollabOptional(): TableCollabContextValue | null {
  return useContext(TableCollabContext)
}

export const TableCollabProvider: React.FC<{
  children: React.ReactNode
  parentDocumentId?: string | null
  surfaceId?: string
  isSurfaceActive?: boolean
  publishGlobalRuntime?: boolean
}> = ({
  children,
  parentDocumentId = null,
  surfaceId,
  isSurfaceActive = true,
  publishGlobalRuntime = true,
}) => {
  const { t } = useTranslation('table')
  const runtimeOwnerId = useId()
  const effectiveSurfaceId = surfaceId ?? `table-pane:${runtimeOwnerId}`

  const { selectedTable, fields, pendingOptimisticFieldIds, loadFields, getTable, upsertFieldLocal, removeFieldLocal } = useTableStore(
    useShallow(state => ({
      selectedTable: state.selectedTable,
      fields: state.fields,
      pendingOptimisticFieldIds: state.pendingOptimisticFieldIds,
      loadFields: state.loadFields,
      getTable: state.getTable,
      upsertFieldLocal: state.upsertFieldLocal,
      removeFieldLocal: state.removeFieldLocal,
    })),
  )

  const { updateRecord, createRecord, mergeIncrementalRecords, removeRecordsByIds } = useRecordStore(
    useShallow(state => ({
      updateRecord: state.updateRecord,
      createRecord: state.createRecord,
      mergeIncrementalRecords: state.mergeIncrementalRecords,
      removeRecordsByIds: state.removeRecordsByIds,
    })),
  )

  const {
    views,
    lastLoadedRestViewIds,
    currentViewId,
    recordsQuery,
    updateView,
    refreshCurrentView,
    loadViews,
  } = useViewStore(
    useShallow(state => ({
      views: state.views,
      lastLoadedRestViewIds: state.lastLoadedRestViewIds,
      currentViewId: state.currentViewId,
      recordsQuery: state.recordsQuery,
      updateView: state.updateView,
      refreshCurrentView: state.refreshCurrentView,
      loadViews: state.loadViews,
    })),
  )
  const viewStoreApi = useViewStoreApi()

  const selectedTableId = selectedTable?.id ?? null
  const isCollabRuntimeRef = useRef(false)
  const isCollabProjectionReadyRef = useRef(false)
  const isTruncatedRef = useRef(false)
  const createdViewsAwaitingRestConfirmationRef = useRef(new Set<string>())
  const deletedFieldSchemaTombstonesRef = useRef(new Map<string, number>())

  // ── 远端变更 → 共享 view store / record store ──
  // 所有视图（含非 grid）都读 view store 的 currentViewRecords，因此把远端变更合进
  // view store 即可让非 grid 视图实时反映他人编辑/删除。
  const { merge: mergeViewRecords, remove: removeViewRecords } = useIncrementalViewMerge(viewStoreApi)

  const mergeIncrementalViewRecordsForCollab = useCallback(
    (incomingRecords: TableRecord[], newVersion: number) => {
      if (shouldProjectViewRecordsFromCollabYdoc(
        isCollabRuntimeRef.current,
        isTruncatedRef.current,
        isCollabProjectionReadyRef.current,
      )) {
        // Y.Doc 投影是协作在线时的视图记录真相源；此处 merge 会与投影竞态。
        return
      }

      const serverRecordIds = new Set(
        (viewStoreApi.getState().currentViewRecords?.records ?? []).map(record => String(record.id)),
      )
      const existingOnly = incomingRecords.filter(record => serverRecordIds.has(String(record.id)))
      if (existingOnly.length > 0) {
        mergeViewRecords(existingOnly, newVersion)
      }
      // 降级 / 服务端限定查询：未知 record 仍走 REST，避免漏显。
      if (existingOnly.length < incomingRecords.length) {
        void refreshCurrentView().catch(() => {})
      }
    },
    [viewStoreApi, mergeViewRecords, refreshCurrentView],
  )

  const removeRecordsForCollab = useCallback(
    (recordIds: string[], newVersion?: number) => {
      removeRecordsByIds(recordIds, newVersion)
      // 非 grid 视图读 view store，删除也要从 view store 同步移除。
      removeViewRecords(recordIds, newVersion)
    },
    [removeRecordsByIds, removeViewRecords],
  )

  // ── WS / Y.js 结构变更刷新（字段 / 视图） ──
  const handleFieldChange = useCallback(
    (info: { action: string; field_ids?: string[] }) => {
      const tableId = selectedTableId
      if (!tableId) return
      // : 撤销/恢复后清 tombstone，否则会挡住 restore 后的 loadFields，
      // Y.Doc meta 继续缺字段，随后 fields_sync 再把刚恢复的列回删。
      // : batch_create_fields（CSV import auto-create）同属新建字段，须清 tombstone。
      if (
        info.action === 'restore_field'
        || info.action === 'create_field'
        || info.action === 'batch_create_fields'
        || info.action === 'schema_stack_sync'
      ) {
        for (const fieldId of info.field_ids ?? []) {
          deletedFieldSchemaTombstonesRef.current.delete(fieldId)
        }
      }
      if (
        isCollabRuntimeRef.current &&
        shouldSkipFieldSchemaRefreshForRecentLocalDelete(info, deletedFieldSchemaTombstonesRef.current)
      ) {
        return
      }
      const run = async () => {
        await getTable(tableId)
        await loadFields(tableId)
        // update_field（如选项 choices 变更）只需刷新字段定义；记录数据由 delta 路径处理。
        // create_field / delete_field / restore_field：刷新视图元数据，但禁止 resetToViewId，
        // 否则会清空 currentViewRecords → 骨架屏 → 卸载 GridToolbar（首次导入 drawer 闪关）。
        if (planFieldSchemaViewRefresh(info.action) === 'none') return
        if (currentViewId) {
          await loadViews(tableId)
        } else {
          await refreshCurrentView()
        }
      }
      void run().catch(error => {
        console.error('[TableCollabProvider] 字段结构刷新失败', error)
      })
    },
    [selectedTableId, currentViewId, getTable, loadFields, loadViews, refreshCurrentView],
  )

  const handleViewChange = useCallback(() => {
    if (!selectedTableId) return
    void loadViews(selectedTableId)
  }, [selectedTableId, loadViews])

  // ── 单一 Y.js 协作桥接（表级，随表存活，切视图不断连） ──
  const collabBridge = useDataGridCollabBridge({
    selectedTableId,
    parentDocumentId,
    fields,
    updateRecord,
    createRecord,
    mergeIncrementalRecords,
    mergeIncrementalViewRecords: mergeIncrementalViewRecordsForCollab,
    removeRecordsByIds: removeRecordsForCollab,
    onFieldChange: handleFieldChange,
    onViewChange: handleViewChange,
  })
  const isCollabRuntime = collabBridge.collab.isOnline && !collabBridge.collab.isFallback
  const isCollabProjectionReady =
    isCollabRuntime && collabBridge.collab.status === CollabStatus.SYNCED
  const isTruncated = collabBridge.collab.isTruncated
  const tableTabKey = selectedTableId ? `tabdata:${selectedTableId}` : null
  const isActiveTab = useIsContextTabActive(tableTabKey)
  const wasCollabRuntimeRef = useRef(false)
  const wasActiveTabRef = useRef(isActiveTab)
  const reconcileSchemaFromRest = useCallback(async (tableId: string, reason: string) => {
    try {
      await getTable(tableId)
      await loadFields(tableId)
      await loadViews(tableId)
    } catch (error) {
      console.error(`[TableCollabProvider] schema reconcile failed (${reason})`, error)
    }
  }, [getTable, loadFields, loadViews])
  // ：协作刚恢复在线时强制 REST 对账 schema（CLI import 可能在标签未激活时改过字段/视图）
  useEffect(() => {
    const wasRuntime = wasCollabRuntimeRef.current
    wasCollabRuntimeRef.current = isCollabRuntime
    if (!shouldReconcileSchemaOnCollabOnline(wasRuntime, isCollabRuntime)) return
    if (!selectedTableId) return
    void reconcileSchemaFromRest(selectedTableId, 'collab-online')
  }, [isCollabRuntime, selectedTableId, reconcileSchemaFromRest])
  // ：标签 inactive→active（导入时常挂在后台）也补一次，避免协作保持 online 时漏对账
  useEffect(() => {
    const wasActive = wasActiveTabRef.current
    wasActiveTabRef.current = isActiveTab
    if (!shouldReconcileSchemaOnTabActivate(wasActive, isActiveTab)) return
    if (!selectedTableId) return
    void reconcileSchemaFromRest(selectedTableId, 'tab-activate')
  }, [isActiveTab, selectedTableId, reconcileSchemaFromRest])
  isCollabRuntimeRef.current = isCollabRuntime
  isCollabProjectionReadyRef.current = isCollabProjectionReady
  isTruncatedRef.current = isTruncated

  // ── Y.Doc → store ingestion ──
  // 前端展示层以 view store 为唯一真相源。协作在线时只把 Y.Doc 快照派生后写入 store；
  // 投影必须使用 effective view（共享 draft + 个人视图），避免工具栏与记录集口径分裂。
  const collabBaseView = useMemo<ViewMeta | null>(() => {
    if (!currentViewId) return null
    const ydocView = collabBridge.collab.viewsMeta.find(
      view => String(view.id) === currentViewId,
    )
    if (ydocView) return ydocView as unknown as ViewMeta
    return (views.find(view => view.id === currentViewId) as ViewMeta | undefined) ?? null
  }, [collabBridge.collab.viewsMeta, views, currentViewId])

  const {
    resolvedCurrentView: effectiveCollabView,
  } = usePersonalViewResolution({
    selectedTableId: selectedTableId ?? undefined,
    currentViewId,
    currentView: collabBaseView,
  })

  const ydocViewRecordsForStore = useMemo(() => {
    if (!shouldProjectViewRecordsFromCollabYdoc(
      isCollabRuntime,
      isTruncated,
      isCollabProjectionReady,
    )) return null

    const searchText =
      typeof recordsQuery.search === 'string' && recordsQuery.search.trim().length > 0
        ? recordsQuery.search.trim()
        : null
    const searchFieldIds = (() => {
      const raw = recordsQuery.search_field_ids
      if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
      if (typeof raw === 'string' && raw.trim().length > 0) {
        return raw.split(',').map(id => id.trim()).filter(Boolean)
      }
      return [] as string[]
    })()

    const collabInput = {
      tableId: selectedTableId,
      recordsSnapshot: collabBridge.collab.recordsSnapshot,
      rowOrder: collabBridge.collab.rowOrder,
      fieldsMeta: collabBridge.collab.fieldsMeta,
      view: effectiveCollabView,
      search: searchText
        ? { query: searchText, fieldIds: searchFieldIds }
        : null,
    }

    if (effectiveCollabView?.view_type === 'kanban') {
      return buildKanbanViewRecords({
        ...collabInput,
        perGroupLimit:
          typeof recordsQuery.per_group_limit === 'number' && recordsQuery.per_group_limit > 0
            ? recordsQuery.per_group_limit
            : undefined,
        groupOffsets: recordsQuery.group_offsets,
      })
    }

    if (effectiveCollabView?.view_type === 'calendar') {
      return buildCalendarViewRecords({
        ...collabInput,
        dateRange:
          typeof recordsQuery.date_range === 'string' && recordsQuery.date_range.trim().length > 0
            ? recordsQuery.date_range.trim()
            : undefined,
        page: recordsQuery.page,
        pageSize: recordsQuery.page_size,
      })
    }

    return buildCollabViewRecords({
      ...collabInput,
      page: recordsQuery.page,
      pageSize: recordsQuery.page_size,
    })
  }, [
    isCollabRuntime,
    isCollabProjectionReady,
    isTruncated,
    selectedTableId,
    collabBridge.collab.recordsSnapshot,
    collabBridge.collab.rowOrder,
    collabBridge.collab.fieldsMeta,
    effectiveCollabView,
    recordsQuery.date_range,
    recordsQuery.group_offsets,
    recordsQuery.search,
    recordsQuery.search_field_ids,
    recordsQuery.search_hide_not_match_rows,
    recordsQuery.per_group_limit,
    recordsQuery.page,
    recordsQuery.page_size,
  ])

  const ydocViewRecordsForStoreRef = useRef(ydocViewRecordsForStore)
  ydocViewRecordsForStoreRef.current = ydocViewRecordsForStore

  useEffect(() => {
    if (!ydocViewRecordsForStore || !currentViewId) return
    viewStoreApi.setState((state) => {
      if (state.currentViewId !== currentViewId) return {}
      if (state.currentViewRecords === ydocViewRecordsForStore) return {}
      return {
        currentViewRecords: ydocViewRecordsForStore,
        isRecordsLoading: false,
      }
    })
  }, [currentViewId, viewStoreApi, ydocViewRecordsForStore])

  useEffect(() => {
    if (!currentViewId) return
    const isAwaitingRestConfirmation = createdViewsAwaitingRestConfirmationRef.current.has(currentViewId)
    const isRestConfirmed = lastLoadedRestViewIds.includes(currentViewId)
    if (isAwaitingRestConfirmation && isRestConfirmed) {
      createdViewsAwaitingRestConfirmationRef.current.delete(currentViewId)
    }
    if (!shouldFetchConfirmedRuntimeViewRecords({
      isCollabRuntime,
      isTruncated,
      currentViewId,
      lastLoadedRestViewIds,
      isAwaitingRestConfirmation,
    })) {
      return
    }

    const state = viewStoreApi.getState()
    const pageSize = state.recordsQuery.page_size ?? 100
    void state.fetchViewRecords(currentViewId, { page: 1, page_size: pageSize })
  }, [
    currentViewId,
    isCollabRuntime,
    isTruncated,
    lastLoadedRestViewIds,
    viewStoreApi,
  ])

  // 协作在线时若其它路径（历史 refresh / 增量 merge / 保存后 REST fetch）把 store
  // 写成缺行、或丢失分组/层级 metadata 的 REST 快照，在 Y.Doc 投影仍含该行/分组时
  // 立即 re-assert，避免新建行「闪没再出现」或分层瞬间回退平铺。
  useEffect(() => {
    if (!shouldProjectViewRecordsFromCollabYdoc(
      isCollabRuntime,
      isTruncated,
      isCollabProjectionReady,
    ) || !currentViewId) {
      return
    }

    return viewStoreApi.subscribe((state) => {
      const ydocRecords = ydocViewRecordsForStoreRef.current
      if (!ydocRecords || state.currentViewId !== currentViewId) return
      if (state.currentViewRecords === ydocRecords) return
      if (
        !collabYdocRecordsMissingFromStore(ydocRecords, state.currentViewRecords) &&
        !collabProjectionMetadataDropped(ydocRecords, state.currentViewRecords)
      ) {
        return
      }

      viewStoreApi.setState((current) => {
        const latestYdoc = ydocViewRecordsForStoreRef.current
        if (!latestYdoc || current.currentViewId !== currentViewId) return {}
        if (current.currentViewRecords === latestYdoc) return {}
        return {
          currentViewRecords: latestYdoc,
          isRecordsLoading: false,
        }
      })
    })
  }, [isCollabRuntime, isTruncated, isCollabProjectionReady, currentViewId, viewStoreApi])

  useEffect(() => {
    if (!shouldUseRestRecordsQuery(isCollabRuntime, isTruncated) || !currentViewId) return
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        void refreshCurrentView().catch(() => {})
      }, 500)
    }
    const unsubChange = collabBridge.collab.onRemoteChange(scheduleRefresh)
    const unsubDelete = collabBridge.collab.onRemoteDelete(scheduleRefresh)
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubChange()
      unsubDelete()
    }
  }, [
    collabBridge.collab,
    currentViewId,
    isCollabRuntime,
    isTruncated,
    refreshCurrentView,
  ])

  // IS-05: fields 从 REST 刷新后同步到 Y.Doc metaMap，防止 fieldsMeta 显示旧顺序。
  // 若 store 仍缺未确认的乐观字段，禁止回写，避免把 Y.Doc 打成旧 schema（连续建字段闪消失）。
  useEffect(() => {
    if (fields.length === 0) return
    if (
      !shouldSyncRestFieldsToYDoc({
        nextFieldIds: fields.map((f: Field) => f.id),
        pendingOptimisticFieldIds,
      })
    ) {
      return
    }
    const fieldsMeta = fields.map((f: Field) => ({
      id: f.id,
      id_hex: f.id.replace(/-/g, ''),
      name: f.name,
      field_type: f.field_type,
      config: (f.options ?? {}) as Record<string, unknown>,
      default_value: f.default_value ?? null,
      order: f.sort_order,
    }))
    collabBridge.collab.updateFieldsMeta(fieldsMeta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, pendingOptimisticFieldIds])

  // 视图生命周期镜像：协作在线时把 REST 视图列表的生命周期 + 元信息同步到 Y.Doc viewsMeta。
  useEffect(() => {
    const ydocViews = collabBridge.collab.viewsMeta as Array<Record<string, unknown>>
    const pendingOptimisticViews = selectedTableId
      ? useTableCollabStore.getState().reconcilePendingOptimisticViews(
          selectedTableId,
          lastLoadedRestViewIds,
        )
      : []
    // 嵌入式表格切走后会重建自己的 view store。回填不依赖协作连接恢复，避免 UI
    // 在新 surface 仅拿到旧 REST 快照时短暂丢失刚复制的视图。
    if (pendingOptimisticViews.length > 0) {
      viewStoreApi.setState(state => {
        const existingViewIds = new Set(state.views.map(view => view.id))
        const viewsToRestore = pendingOptimisticViews.filter(view => !existingViewIds.has(view.id))
        if (viewsToRestore.length === 0) return state
        return {
          views: [...state.views, ...viewsToRestore],
          pendingOptimisticViewIds: Array.from(new Set([
            ...state.pendingOptimisticViewIds,
            ...viewsToRestore.map(view => view.id),
          ])),
        }
      })
    }
    // 在成功加载 REST 快照前，`views` 可能包含本地回填的乐观视图；不能把它当成
    // REST 权威数据，否则远端已删除的视图会被重新写回 Y.Doc。
    if (!isCollabRuntime || lastLoadedRestViewIds.length === 0) return
    if (views.length === 0) return
    // 回填后的 `views` 不是 REST 权威快照。生命周期同步只能消费原始 REST 条目，
    // 否则远端在确认前删除 pending 视图时，本端会将其重新写回 Y.Doc。
    const restViewIdSet = new Set(lastLoadedRestViewIds)
    const restViews = views.filter(view => restViewIdSet.has(view.id))
    const { next, changed } = mergeViewsLifecycleIntoYDoc(
      restViews as unknown as Array<Record<string, unknown>>,
      ydocViews,
      pendingOptimisticViews.map(view => view.id),
    )
    if (changed) {
      collabBridge.collab.updateViewsMeta(next)
    }
  }, [
    isCollabRuntime,
    views,
    lastLoadedRestViewIds,
    selectedTableId,
    viewStoreApi,
    collabBridge.collab.viewsMeta,
    collabBridge.collab.updateViewsMeta,
  ])

  // 长时间离线后重连提示
  useEffect(() => {
    if (collabBridge.collab.longOfflineDetected) {
      toast({
        title: t('collab.longOfflineWarning'),
        description: t('collab.longOfflineWarningDesc'),
      })
      collabBridge.collab.acknowledgeLongOffline()
    }
  }, [collabBridge.collab.longOfflineDetected, collabBridge.collab.acknowledgeLongOffline, t])

  // ── presence / 光标 / undo-redo → useTableCollabStore（供 Header 等跨视图消费） ──
  const { disconnectPhase, disconnectSeconds, handleForceReconnect, handleCollabCellFocus } =
    useDataGridCollabSyncUI({
      collabBridge,
      selectedTableId,
      fields,
      surfaceId: effectiveSurfaceId,
      isSurfaceActive,
      publishRuntimeControls: publishGlobalRuntime,
      t: (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never)),
    })

  // ── collab-aware 视图配置更新（在线写 Y.Doc viewsMeta） ──
  // useTableCollaboration 的返回对象（collabBridge.collab）未 memo，每帧都是新引用；
  // 若直接进 useCallback 依赖，updateViewForRuntime 会每帧 churn，进而让下方
  // syncViewRuntime effect 每帧 set → Maximum update depth 死循环（ 回归）。
  // 这里把易变依赖收进 ref，让 updateViewForRuntime 引用稳定（仅随 isCollabRuntime 变）。
  const viewRuntimeDepsRef = useRef({
    collab: collabBridge.collab,
    updateView,
    currentUserRole: selectedTable?.current_user_role,
    upsertFieldLocal,
    removeFieldLocal,
    selectedTableId,
  })
  viewRuntimeDepsRef.current = {
    collab: collabBridge.collab,
    updateView,
    currentUserRole: selectedTable?.current_user_role,
    upsertFieldLocal,
    removeFieldLocal,
    selectedTableId,
  }
  const updateViewForRuntime = useCallback<UpdateViewFn>(
    async (...args) => {
      const { collab, updateView: restUpdateView, currentUserRole } = viewRuntimeDepsRef.current
      if (isReadonlyTableRole(currentUserRole)) {
        return null
      }
      const [viewId, payload] = args
      if (!isCollabRuntime) {
        return restUpdateView(...args)
      }
      if (!collab.canEdit) return null
      // 单视图事务内写入：以 Y.Doc 现值为基线只覆盖目标视图，并递增 config_rev，
      // 避免整批重写把他端刚写入的其它视图配置回退。
      const nextView = collab.updateSingleViewMeta(
        viewId,
        (current) => {
          const base = resolveCollabViewUpdateBase(
            viewId,
            current,
            collab.viewsMeta,
            viewStoreApi.getState().views as unknown as Array<Record<string, unknown>>,
          )
          if (!base) return null
          // config / column_meta 必须深合并：调用方常只传局部 patch
          // （如 column_statistic_funcs），整段替换会冲掉既有视图配置。
          return applyViewUpdatePayload(
            base,
            payload as Record<string, unknown>,
            { viewId, updatedAt: new Date().toISOString() },
          )
        },
        { bumpConfigRev: true },
      )
      if (!nextView) return null
      const mergedView = nextView as unknown as ViewMeta
      viewStoreApi.setState(state => ({
        views: state.views.map(view =>
          String(view.id) === viewId ? mergedView : view,
        ),
        draftStates: reconcileCleanDraft(state.draftStates, viewId, mergedView),
      }))
      return nextView as unknown as Awaited<ReturnType<UpdateViewFn>>
    },
    [isCollabRuntime, viewStoreApi],
  )

  const deleteViewForRuntime = useCallback(
    async (viewId: string) => {
      const { collab, currentUserRole, selectedTableId: runtimeTableId } = viewRuntimeDepsRef.current
      if (isReadonlyTableRole(currentUserRole)) return false
      const deleted = await deleteRestBackedCollabView({
        viewId,
        deletePersistedView: viewStoreApi.getState().deleteView,
        removeMirroredView: id => collab.removeSingleViewMeta(id),
        onMirrorError: error => {
          log.warn('视图已删除，但移除协作文档镜像失败', error)
        },
      })
      if (!deleted) return false

      createdViewsAwaitingRestConfirmationRef.current.delete(viewId)
      if (runtimeTableId) {
        useTableCollabStore.getState().clearPendingOptimisticView(runtimeTableId, viewId)
      }
      return true
    },
    [viewStoreApi],
  )

  const createViewForRuntime = useCallback(
    async (payload: Omit<ViewCreateRequest, 'table_id'> & { table_id?: string }) => {
      const { collab, currentUserRole } = viewRuntimeDepsRef.current
      if (isReadonlyTableRole(currentUserRole)) return null
      if (!isCollabRuntime || !collab.canEdit) return null

      const tableId = payload.table_id ?? selectedTableId ?? ''
      if (!tableId) return null

      return createRestBackedCollabView({
        tableId,
        payload,
        createPersistedView: viewStoreApi.getState().createView,
        mirrorPersistedView: collab.updateSingleViewMeta,
        onMirrorError: error => {
          log.warn('视图已持久化，但写入协作文档失败', error)
        },
      })
    },
    [isCollabRuntime, selectedTableId, viewStoreApi],
  )

  const createFieldForRuntime = useCallback(
    async (payload: {
      name: string
      field_type: string
      description?: string
      default_value?: FieldDefaultValue | null
      options?: Record<string, unknown>
      order?: number
      insert_position?: 'before' | 'after'
      reference_field_id?: string
    }) => {
      const { collab, currentUserRole, upsertFieldLocal: upsertField, selectedTableId: tableId } =
        viewRuntimeDepsRef.current
      if (isReadonlyTableRole(currentUserRole)) return null
      if (!isCollabRuntime || !collab.canEdit) return null

      const fieldId = crypto.randomUUID()
      const fieldsMeta = orderFieldsMeta(collab.fieldsMeta)
      const referenceFieldId = payload.reference_field_id
      const refIndex = referenceFieldId
        ? findFieldMetaIndex(fieldsMeta, referenceFieldId)
        : -1

      let order: number
      if (refIndex >= 0) {
        order = payload.insert_position === 'before' ? refIndex : refIndex + 1
      } else {
        const maxOrder = fieldsMeta.reduce(
          (max, field) => Math.max(max, typeof field.order === 'number' ? field.order : 0),
          -1,
        )
        order = typeof payload.order === 'number' ? payload.order : maxOrder + 1
      }

      const newField = {
        id: fieldId,
        id_hex: fieldId.replace(/-/g, ''),
        name: payload.name,
        field_type: payload.field_type,
        config: payload.options ?? {},
        default_value: payload.default_value ?? null,
        order,
      }

      // 写 Y.Doc：协作广播 + 触发后端异步持久化
      let nextFieldsMeta: typeof fieldsMeta
      if (refIndex >= 0) {
        const next = [...fieldsMeta]
        next.splice(order, 0, newField)
        nextFieldsMeta = next.map((field, index) => ({ ...field, order: index }))
        collab.updateFieldsMeta(nextFieldsMeta)
      } else {
        nextFieldsMeta = [...fieldsMeta, newField]
        collab.updateFieldsMeta(nextFieldsMeta)
      }

      // 乐观写入 fields store（grid 渲染源），避免持久化未完成时被 REST 旧数据覆盖。
      if (tableId) {
        const now = new Date().toISOString()
        const optimisticField: Field = {
          id: fieldId,
          table_id: tableId,
          name: payload.name,
          field_type: payload.field_type as FieldType,
          is_primary: false,
          default_value: payload.default_value ?? null,
          is_hidden: false,
          sort_order: order,
          description: payload.description,
          options: payload.options as FieldOptions | undefined,
          created_at: now,
          updated_at: now,
        }
        upsertField(
          tableId,
          optimisticField,
          refIndex >= 0 && referenceFieldId
            ? {
                referenceFieldId,
                position: payload.insert_position === 'before' ? 'before' : 'after',
              }
            : undefined,
        )
      }

      // Grid 列序读 viewsMeta.column_meta；缺条目会被追加到最右。
      // 左/右插入时按参考列乐观写入全部视图配置（对齐后端 _add_field_to_views_at_position）。
      const insertPosition = payload.insert_position
      if (
        referenceFieldId &&
        (insertPosition === 'before' || insertPosition === 'after')
      ) {
        const activeFieldIdsByOrder = nextFieldsMeta.map(field => String(field.id))
        const patchedViews = new Map<string, ViewMeta>()
        for (const view of collab.viewsMeta) {
          const viewId = String(view.id)
          if (!viewId) continue
          const patch = insertFieldIntoViewConfig({
            fieldId,
            referenceFieldId,
            position: insertPosition,
            viewType: String(view.view_type ?? ''),
            columnMeta: getViewColumnMeta(view) ?? {},
            visibleFields: Array.isArray(view.visible_fields)
              ? view.visible_fields.map(String)
              : [],
            fieldOrder: Array.isArray(view.field_order)
              ? view.field_order.map(String)
              : [],
            activeFieldIdsByOrder,
          })
          const nextView = collab.updateSingleViewMeta(
            viewId,
            current => {
              const base = current ?? view
              if (!base) return null
              return {
                ...base,
                column_meta: patch.column_meta,
                ...(patch.visible_fields ? { visible_fields: patch.visible_fields } : {}),
                ...(patch.field_order ? { field_order: patch.field_order } : {}),
                id: viewId,
                updated_at: new Date().toISOString(),
              }
            },
            { bumpConfigRev: true },
          )
          if (nextView) {
            patchedViews.set(viewId, nextView as unknown as ViewMeta)
          }
        }
        if (patchedViews.size > 0) {
          viewStoreApi.setState(state => ({
            views: state.views.map(view =>
              patchedViews.get(String(view.id)) ?? view,
            ),
          }))
        }
      }

      return newField
    },
    [isCollabRuntime, viewStoreApi],
  )

  const updateFieldForRuntime = useCallback(
    async (
      fieldId: string,
      payload: {
        name?: string
        field_type?: string
        options?: Record<string, unknown>
        default_value?: FieldDefaultValue | null
      },
    ) => {
      const { collab, currentUserRole } = viewRuntimeDepsRef.current
      if (isReadonlyTableRole(currentUserRole)) return
      if (!isCollabRuntime || !collab.canEdit) return

      const nextFields = collab.fieldsMeta.map(field => {
        if (String(field.id) !== fieldId) return field
        return {
          ...field,
          ...(payload.name != null ? { name: payload.name } : {}),
          ...(payload.field_type != null ? { field_type: payload.field_type } : {}),
          ...(payload.options != null ? { config: payload.options } : {}),
          ...(payload.default_value !== undefined ? { default_value: payload.default_value } : {}),
        }
      })
      collab.updateFieldsMeta(nextFields)
    },
    [isCollabRuntime],
  )

  const deleteFieldForRuntime = useCallback(
    (fieldId: string) => {
      const {
        collab,
        currentUserRole,
        removeFieldLocal: removeField,
        selectedTableId: tableId,
      } = viewRuntimeDepsRef.current
      if (isReadonlyTableRole(currentUserRole)) return
      if (!isCollabRuntime || !collab.canEdit) return
      const nextFields = collab.fieldsMeta.filter(
        field => String(field.id) !== fieldId,
      )
      if (nextFields.length === collab.fieldsMeta.length) return
      collab.updateFieldsMeta(nextFields.map((field, index) => ({ ...field, order: index })))
      if (tableId) {
        removeField(tableId, fieldId)
        markDeletedFieldSchemaTombstone(deletedFieldSchemaTombstonesRef.current, fieldId)
      }
    },
    [isCollabRuntime],
  )

  // ── 按字段名写入的便捷方法（键空间转换纯函数见 collabMirrorUtils，已单测） ──
  const fieldIdByName = useMemo(() => buildFieldIdByName(fields), [fields])

  const updateRecordFields = useCallback(
    (recordId: string, fieldValuesByName: Record<string, unknown>) =>
      collabBridge.updateRecord(recordId, {
        fields: toFieldIdPayload(fieldValuesByName, fieldIdByName),
        fieldKeyType: 'id',
      }),
    [collabBridge.updateRecord, fieldIdByName],
  )

  const createRecordFields = useCallback(
    (fieldValuesByName: Record<string, unknown>, orderContext?: RecordOrderContext) =>
      collabBridge.createRecord({
        table_id: selectedTableId ?? '',
        fields: toFieldIdPayload(fieldValuesByName, fieldIdByName),
        fieldKeyType: 'id',
        ...(orderContext ? { order_context: orderContext } : {}),
      }),
    [collabBridge.createRecord, fieldIdByName, selectedTableId],
  )

  // ── REST 写入的 Y.Doc 镜像 ──
  // 部分操作（剪贴板批量、插入、子记录、删除、回收站恢复）走 REST 持久化，协作在线时
  // 需把结果镜像进本地 Y.Doc，使本端不被旧快照回弹、他端经 collab-live 实时可见。
  // 安全性：后端 persist_changes 按 record id 过滤已存在记录，镜像 addRecord(已存在 id)
  // 不会重复建记录（与 grid 删除「REST 权威落库 + COLLAB_ORIGIN_MIRROR 镜像」同款模式）。
  const fieldIdToHex = useMemo(() => buildFieldIdToHex(fields), [fields])

  const mirrorRecordsToCollab = useCallback(
    (records: TableRecord[]) => {
      if (!isCollabRuntime || !collabBridge.collab.canEdit || records.length === 0) return
      const snapshot = collabBridge.collab.recordsSnapshot
      for (const record of records) {
        const id = record?.id ? String(record.id) : ''
        if (!id) continue
        const hexCells = recordToHexCells(record, fieldIdToHex, fieldIdByName)
        if (snapshot.has(id)) {
          const changes = Object.entries(hexCells).map(([fieldId, value]) => ({
            recordId: id,
            fieldId,
            value,
          }))
          // : REST 镜像不得用 local origin，否则污染 Yjs UndoManager
          if (changes.length > 0) {
            collabBridge.collab.batchSetCellValues(changes, COLLAB_ORIGIN_MIRROR)
          }
        } else {
          const order = typeof record.order === 'number' ? record.order : 0
          collabBridge.collab.addRecord(id, hexCells, order, undefined, COLLAB_ORIGIN_MIRROR)
        }
      }
    },
    [isCollabRuntime, collabBridge.collab, fieldIdToHex, fieldIdByName],
  )

  const mirrorRecordDeletesToCollab = useCallback(
    (recordIds: string[]) => {
      if (!isCollabRuntime || !collabBridge.collab.canEdit) return
      for (const recordId of recordIds) {
        if (recordId) collabBridge.collab.deleteRecord(String(recordId), COLLAB_ORIGIN_MIRROR)
      }
    },
    [isCollabRuntime, collabBridge.collab],
  )

  const localCreateOverlayRemoverRef = useRef<
    ((recordIds: readonly string[]) => void) | null
  >(null)

  const registerLocalCreateOverlayRemover = useCallback(
    (remover: ((recordIds: readonly string[]) => void) | null) => {
      localCreateOverlayRemoverRef.current = remover
      return () => {
        if (localCreateOverlayRemoverRef.current === remover) {
          localCreateOverlayRemoverRef.current = null
        }
      }
    },
    [],
  )

  const cancelPendingCollabCreates = useCallback(
    (recordIds: readonly string[]) => {
      if (!isCollabRuntime) return [] as string[]
      const cancelled = collabBridge.cancelPendingCreates(recordIds)
      if (cancelled.length > 0) {
        localCreateOverlayRemoverRef.current?.(cancelled)
      }
      return cancelled
    },
    [isCollabRuntime, collabBridge.cancelPendingCreates],
  )

  // : 字段/视图 undo/redo 后若 Y.Doc 行被掏空，REST refreshCurrentView
  // 在协作在线态仍读空投影，等于空转。必须直打 Record REST，再 mirror 进 Y.Doc。
  useEffect(() => {
    if (!selectedTableId || !isCollabRuntime) return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tableId?: string }>).detail
      if (detail?.tableId && detail.tableId !== selectedTableId) return
      void (async () => {
        try {
          const { RecordApiService } = await import('@tabtin/table-core')
          const result = await RecordApiService.getRecordsByTable(selectedTableId, {
            page_size: 500,
            field_key_type: 'id',
          })
          const records = (result.data?.records ?? []) as TableRecord[]
          if (records.length > 0) {
            mirrorRecordsToCollab(records)
            const currentViewId = viewStoreApi.getState().currentViewId
            if (currentViewId) {
              viewStoreApi.setState((state) => {
                if (state.currentViewId !== currentViewId) return {}
                const prev = state.currentViewRecords
                if (!prev) return { isRecordsLoading: false }
                return {
                  currentViewRecords: {
                    ...prev,
                    records,
                    total: result.data?.total ?? records.length,
                  },
                  isRecordsLoading: false,
                }
              })
            }
          }
        } catch (error) {
          console.warn('[TableCollabProvider] schema stack op REST reseed failed', error)
        }
      })()
    }
    window.addEventListener('tabtin:table-schema-stack-op', handler)
    return () => window.removeEventListener('tabtin:table-schema-stack-op', handler)
  }, [selectedTableId, isCollabRuntime, viewStoreApi, mirrorRecordsToCollab])

  // 向全局 store 暴露视图协作入口 + Y.Doc viewsMeta 快照（供 Header / ViewFilterGroupBar）。
  useEffect(() => {
    if (!publishGlobalRuntime) return
    const tableId = selectedTableId
    const runtimeViewsMeta = collabBridge.collab.viewsMeta as unknown as ViewMeta[]
    useTableCollabStore.getState().syncViewRuntime({
      tableId,
      updateViewFn: tableId ? updateViewForRuntime : null,
      deleteViewFn: tableId ? deleteViewForRuntime : null,
      createViewFn: tableId && isCollabRuntime ? createViewForRuntime : null,
      viewsMeta: tableId && isCollabRuntime ? runtimeViewsMeta : null,
    })
    return () => {
      if (tableId) {
        useTableCollabStore.getState().syncViewRuntime({
          tableId,
          updateViewFn: null,
          deleteViewFn: null,
          createViewFn: null,
          viewsMeta: null,
        })
      }
    }
  }, [
    selectedTableId,
    updateViewForRuntime,
    deleteViewForRuntime,
    createViewForRuntime,
    isCollabRuntime,
    collabBridge.collab.viewsMeta,
    publishGlobalRuntime,
  ])

  // 多 surface 可共享同一表资源；只有最后一个 owner 离开才清理协作切片。
  useEffect(() => {
    if (!selectedTableId) return
    useTableCollabStore.getState().retainTable(selectedTableId, runtimeOwnerId)
    return () => {
      useTableCollabStore.getState().releaseTable(selectedTableId, runtimeOwnerId)
    }
  }, [selectedTableId, runtimeOwnerId])

  const value = useMemo<TableCollabContextValue>(
    () => ({
      parentDocumentId,
      collabBridge,
      isCollabRuntime,
      effectiveCurrentView: effectiveCollabView,
      updateRecord: collabBridge.updateRecord,
      updateRecordFields,
      createRecordFields,
      mirrorRecordsToCollab,
      mirrorRecordDeletesToCollab,
      cancelPendingCollabCreates,
      registerLocalCreateOverlayRemover,
      updateViewForRuntime,
      deleteViewForRuntime,
      createViewForRuntime,
      createFieldForRuntime,
      updateFieldForRuntime,
      deleteFieldForRuntime,
      disconnectPhase,
      disconnectSeconds,
      handleForceReconnect,
      handleCollabCellFocus,
    }),
    [
      parentDocumentId,
      collabBridge,
      isCollabRuntime,
      effectiveCollabView,
      updateRecordFields,
      createRecordFields,
      mirrorRecordsToCollab,
      mirrorRecordDeletesToCollab,
      cancelPendingCollabCreates,
      registerLocalCreateOverlayRemover,
      updateViewForRuntime,
      deleteViewForRuntime,
      createViewForRuntime,
      createFieldForRuntime,
      updateFieldForRuntime,
      deleteFieldForRuntime,
      disconnectPhase,
      disconnectSeconds,
      handleForceReconnect,
      handleCollabCellFocus,
    ],
  )

  return <TableCollabContext.Provider value={value}>{children}</TableCollabContext.Provider>
}
