/**
 * TablePaneView — Web 表格入口组件
 *
 * 对齐 Electron 的 TablePaneView：
 * - 通过 tableStorePool 获取 per-table 的 Store 三件套
 * - 用 Provider 包裹 TablePaneInner
 * - Inner 负责 table → selectTable → initializeView → 渲染
 *
 * 与 Electron 的差异：
 * - 无 tab 系统（Web 靠路由导航）
 * - 简化的 Header（personalView 已支持，Presence 待补）
 * - Grid 渲染复用 @tabtin/table-engine-canvas + @tabtin/table-ui
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutList, Plus, Table2, WifiOff } from 'lucide-react'
import {
  Button,
  toast,
  ToastAction,
  type ToastActionElement,
  ConversionPreviewDialog,
  useFieldConversion,
  ShareDialog,
} from '@tabtin/smartsheet-ui'
import {
  RemovedFromResourceOverlay,
  useResourceShareDowngrade,
  isPermissionInsufficientForEditing,
  shouldShowRemovedOverlay,
  selectResourceShareNotifications,
} from '@tabtin/smartsheet-ui'
import { useLocation, useNavigate } from 'react-router-dom'
import { useOrganizationStore } from '@tabtin/app-shell'
import { useNotificationStore } from '@/stores/useNotificationStore'
import { buildPublicShareUrlPrefix } from '@/config/api'
import { useStore } from 'zustand'
import {
  AttachmentApiService,
  FieldApiService,
  RecordApiService,
  buildViewDraftSavePayload,
  type AttachmentReference,
  type AttachmentUploadFileOut,
  type Field,
  type FieldType,
  type Table,
  type ViewMeta,
} from '@tabtin/table-core'
import { CanvasGridAdapter } from '@tabtin/table-engine-canvas/engine'
import {
  useDataGridColumns,
  useDataGridDataset,
  DataGridPaginationBar,
  useDataGridEditingController,
  useTableInitFlow,
  useUndoRedo,
  useTableViewUiStore,
  TableLoadingView,
  TableErrorView,
  type DataGridAddRowContext,
  GridToolbarMainBar,
  type TableRecord as TableUiRecord,
  type ViewRecordsResponse as TableUiViewRecordsResponse,
  type ViewPopoverControls,
  buildCanvasMenuLabels,
  buildRowsWithDraft,
  mergePrefillValues,
  resolveFilterPrefillValues,
  resolveGroupPrefillValuesFromAnchor,
  isViewLocked,
  toOrganizationMembers,
} from '@tabtin/table-ui'
import {
  useDataGridClipboard,
  resolveCreatedRecordVisibility,
  type ViewAwareCreatePlan,
} from '@tabtin/table-ui/clipboard'
import type {
  TableGridAttachmentUploadHandler,
  TableGridAttachmentUploadProgressItem,
  TableGridPagination,
  TableGridRow,
  TableGridRuntimeApi,
  TableGridRowMoveContext,
} from '@tabtin/table-engine'
import {
  applyViewUpdatePayload,
  mergeViewsLifecycleIntoYDoc,
} from '@tabtin/table-engine/collab'
import {
  TableStoreProvider,
  useTableStore,
  tableStore as globalTableStore,
} from '@/stores/table/useTableStore'
import {
  ViewStoreProvider,
  useViewStore,
  useViewStoreApi,
} from '@/stores/table/useViewStore'
import { RecordStoreProvider, useRecordStore, useRecordStoreApi } from '@/stores/table/useRecordStore'
import { CollabStatus } from '@tabtin/collab-core'
import { useWebCollabBridge } from './hooks/useWebCollabBridge'
import { useShareWebCollabBridge } from './hooks/useShareWebCollabBridge'
import {
  getOrCreateTableStore,
  getOrCreateViewStore,
  getOrCreateRecordStore,
  retainStoreForTable,
  releaseStoreForTable,
} from '@/stores/table/tableStorePool'
import { useUIStore } from '@/stores/ui-store'
import { useTableLaunchContext } from '@/features/table/useTableLaunchContext'
import { TablePaneHeader } from './TablePaneHeader'
import { WebViewSwitcher } from './view/WebViewSwitcher'
import { WebViewRenderer } from './view/WebViewRenderer'
import { WebViewFilterGroupBar } from './view/WebViewFilterGroupBar'
import { resolveTableOrganizationId, resolveTableReadonly } from './tablePaneAccess'
import { buildWebCollabViewRecords } from './view/webCollabViewProjection'
import { useWebPresentation } from '@/components/layout/WebPresentationContext'
import {
  isPhoneWebPresentation,
  isTabletWebPresentation,
} from '@/components/layout/WebPresentationEnvironment'
import { useNativeTabDataFocusReport } from './hooks/useNativeTabDataFocusReport'
import { WebRecordFormContainer } from './record/WebRecordFormContainer'
import {
  clearRecordCommentRouteIntent,
  parseRecordCommentRouteIntent,
  type RecordCommentRouteIntent,
} from './recordCommentRouteIntent'
import { useDataGridSyncRuntime, useIncrementalViewMerge } from '@tabtin/table-engine/sync'
import { getChatClient } from '@/services/chatApi'
import { CreateFieldDialog, type CreateFieldData, type InsertFieldContext } from './field/CreateFieldDialog'
import { EditFieldDialog, type EditFieldData } from './field/EditFieldDialog'
import { FieldManagementPanel } from './field/FieldManagementPanel'
import { ExportDialog } from './export/ExportDialog'
import { ImportDialog } from './import/ImportDialog'
import { useMeasuredContainer } from './hooks/useMeasuredContainer'
import { useTableFontStyle } from './hooks/useTableFontStyle'
import { useTablePaneSearch } from './hooks/useTablePaneSearch'
import { useTablePaneColumnOps } from './hooks/useTablePaneColumnOps'
import { GridErrorBoundary } from './GridErrorBoundary'
import { WebTableEmptyState } from './WebTableEmptyState'
import { TablePaneDialogs } from './TablePaneDialogs'
import { createLooseTranslate } from '@/types/table-adapters'
import { WebLinkCellEditor } from './field/WebLinkCellEditor'
import { MobileTableCardList } from './mobile/MobileTableCardList'
import { resolveMobileCreateInitialValues } from './mobile/mobileTableProjection'
import { resolveMobileVisibleFields } from './mobile/mobileTablePrimitives'
import {
  resolveTableRecordSurfacePreference,
  resolveTableRecordSurfacePolicy,
  selectTableRecordSurface,
  type TableRecordSurfaceSelection,
} from './mobile/tableRecordSurfacePolicy'

const DRAFT_ROW_ID = '__draft_row__'
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500, 1000]
const EMPTY_RECORDS: TableUiRecord[] = []
const EMPTY_COLLAPSED_GROUP_IDS: string[] = []
const LAST_VIEW_ID_STORAGE_PREFIX = 'tabtin.table.lastViewId.'

const readLastViewId = (tableId: string): string => {
  try {
    return window.localStorage.getItem(`${LAST_VIEW_ID_STORAGE_PREFIX}${tableId}`) ?? ''
  } catch {
    return ''
  }
}

const writeLastViewId = (tableId: string, viewId: string) => {
  try {
    window.localStorage.setItem(`${LAST_VIEW_ID_STORAGE_PREFIX}${tableId}`, viewId)
  } catch {
    // localStorage can be unavailable in restricted browsers; the current session still has ViewStore state.
  }
}

interface AttachmentFieldGridPatch {
  recordId: string
  fieldId: string
  fieldName: string
  value: AttachmentReference[]
}

interface GridAttachmentUploadProgressState {
  uploadItemId: string
  file: File
  fileName: string
  status: TableGridAttachmentUploadProgressItem['status']
  progress: number
  error?: string
}

const getAttachmentFieldGridPatchKey = (patch: Pick<AttachmentFieldGridPatch, 'recordId' | 'fieldId'>): string =>
  `${patch.recordId}:${patch.fieldId}`

const patchAttachmentFieldRecord = (
  record: TableUiRecord,
  patch: AttachmentFieldGridPatch,
): TableUiRecord => ({
  ...record,
  data: {
    ...(record.data ?? {}),
    [patch.fieldName]: patch.value,
  },
  fields: {
    ...(record.fields ?? {}),
    [patch.fieldId]: patch.value,
  },
})

const areAttachmentPatchValuesEqual = (left: unknown, right: AttachmentReference[]): boolean => {
  try {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
  } catch {
    return false
  }
}

const mapGridAttachmentProgressItems = (
  items: GridAttachmentUploadProgressState[],
): TableGridAttachmentUploadProgressItem[] =>
  items.map((item) => ({
    uploadItemId: item.uploadItemId,
    file: item.file,
    fileName: item.fileName,
    status: item.status,
    progress: item.progress,
    error: item.error,
  }))

const prepareGridAttachmentUploadFiles = (files: File[]) => {
  const seenNames = new Map<string, number>()
  const deduplicateName = (name: string): string => {
    const count = seenNames.get(name) ?? 0
    seenNames.set(name, count + 1)
    if (count === 0) return name
    const dotIndex = name.lastIndexOf('.')
    return dotIndex > 0
      ? `${name.slice(0, dotIndex)}_${count}${name.slice(dotIndex)}`
      : `${name}_${count}`
  }

  return files.map(file => ({
    file,
    metadata: {
      file_name: deduplicateName(file.name || `file_${Date.now()}`),
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
      chunk_size: AttachmentApiService.resolveChunkSize(file.size),
      is_public: false,
    },
  }))
}

const getGridAttachmentPartPresignedUrl = (
  file: AttachmentUploadFileOut,
  partNumber: number,
): string | undefined => {
  const record = file as AttachmentUploadFileOut & {
    part_presigned_urls?: Record<string, string>
    direct_upload?: boolean
  }
  if (!record.direct_upload) return undefined
  return record.part_presigned_urls?.[String(partNumber)]
}

interface TablePaneInnerProps {
  tableId: string
  disableCollab?: boolean
  shareCollab?: {
    shareId: string
    password?: string
    permission: string
    canComment: boolean
    getAuthToken: () => Promise<string>
    refreshToken: () => Promise<string | null>
    collabDisabled?: boolean
  }
}

const TablePaneInner: React.FC<TablePaneInnerProps> = ({ tableId, disableCollab = false, shareCollab }) => {
  const { t, i18n } = useTranslation(['table', 'view'])
  const tl = useMemo(() => createLooseTranslate(t), [t])
  const { buildHomePath } = useTableLaunchContext()
  const { isEmbedded, layout, input, orientation, mobileHost } = useWebPresentation()
  const isTabletPresentation = isTabletWebPresentation({ layout, input, mobileHost })
  const isPhonePresentation = !isTabletPresentation
    && isPhoneWebPresentation({ layout, mobileHost })
  const resolvedTheme = useUIStore(state => state.resolvedTheme)
  const gridContainer = useMeasuredContainer()

  const globalTables = useStore(globalTableStore, state => state.tables)
  const getGlobalTable = useStore(globalTableStore, state => state.getTable)

  const selectTable = useTableStore(state => state.selectTable)
  const selectedTable = useTableStore(state => state.selectedTable)
  const updateTable = useTableStore(state => state.updateTable)
  const fields = useTableStore(state => state.fields)
  const loadFields = useTableStore(state => state.loadFields)

  const initializeView = useViewStore(state => state.initialize)
  const viewTableId = useViewStore(state => state.tableId)
  const currentViewId = useViewStore(state => state.currentViewId)

  // ：embedded 壳把 current_view_id 回传原生 Focus（无 host 时 no-op）
  useNativeTabDataFocusReport({
    isEmbedded,
    tableId,
    viewTableId,
    currentViewId,
  })
  const views = useViewStore(state => state.views)
  const viewLoading = useViewStore(state => state.isLoading)
  const currentViewRecords = useViewStore(state => state.currentViewRecords)
  const isRecordsLoading = useViewStore(state => state.isRecordsLoading)
  const recordsQuery = useViewStore(state => state.recordsQuery)
  const setViewPage = useViewStore(state => state.setPage)
  const setViewPageSize = useViewStore(state => state.setPageSize)
  const refreshCurrentView = useViewStore(state => state.refreshCurrentView)
  const fetchViewRecords = useViewStore(state => state.fetchViewRecords)
  const setDraftFilters = useViewStore(state => state.setDraftFilters)
  const applyDraft = useViewStore(state => state.applyDraft)
  const saveDraft = useViewStore(state => state.saveDraft)
  const updateView = useViewStore(state => state.updateView)
  const collapsedGroupIds = useViewStore(state => (
    currentViewId
      ? state.collapsedGroups[currentViewId] ?? EMPTY_COLLAPSED_GROUP_IDS
      : EMPTY_COLLAPSED_GROUP_IDS
  ))
  const toggleGroupCollapse = useViewStore(state => state.toggleGroupCollapse)
  const clearGroupCollapse = useViewStore(state => state.clearGroupCollapse)
  const currentViewLatestVersion = useViewStore(state => state.currentViewLatestVersion)
  const currentViewEtag = useViewStore(state => state.currentViewEtag)

  const recordStoreApi = useRecordStoreApi()
  const rawUpdateRecord = useRecordStore(state => state.updateRecord)
  const rawCreateRecord = useRecordStore(state => state.createRecord)
  const bulkDeleteRecords = useRecordStore(state => state.bulkDeleteRecords)
  const bulkUpdateRecords = useRecordStore(state => state.bulkUpdateRecords)
  const bulkCreateRecords = useRecordStore(state => state.bulkCreateRecords)

  const [fieldDialogOpen, setFieldDialogOpen] = useState(false)
  const [insertFieldContext, setInsertFieldContext] = useState<InsertFieldContext | null>(null)
  const [editFieldDialogOpen, setEditFieldDialogOpen] = useState(false)
  const [editingField, setEditingField] = useState<Field | null>(null)
  const [editFieldSubmitting, setEditFieldSubmitting] = useState(false)
  const [pendingEditData, setPendingEditData] = useState<EditFieldData | null>(null)
  const [forceConversion, setForceConversion] = useState(false)
  const [fieldMgmtOpen, setFieldMgmtOpen] = useState(false)
  const [attachmentGridPatches, setAttachmentGridPatches] = useState<Map<string, AttachmentFieldGridPatch>>(
    () => new Map(),
  )

  const fieldConversion = useFieldConversion()
  const {
    previewOpen: conversionPreviewOpen,
    preview: conversionPreview,
    previewLoading: conversionPreviewLoading,
    converting: conversionConverting,
    isStructuralType,
    startPreview,
    executeConversion,
    cancelPreview,
    setPreviewOpen: setConversionPreviewOpen,
    formatResultParts,
  } = fieldConversion
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [linkEditorState, setLinkEditorState] = useState<{
    recordId: string
    fieldId: string
  } | null>(null)

  // D10 + Wave 5 §D：后端 GET /tabdata/tables/{id} 已回填 current_user_role；
  // 这是 SSOT，前端不再做 owner_id / organization role 旁路（避免与后端判定不一致）。
  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const organizationStoreMembers = useOrganizationStore((s) => s.members)
  const organizationMembers = useMemo(
    () => toOrganizationMembers(organizationStoreMembers),
    [organizationStoreMembers],
  )
  const userDisplayNameById = useMemo(
    () => new Map(organizationMembers.map((member) => [member.id, member.name] as const)),
    [organizationMembers],
  )
  const canManageShare = useMemo(() => {
    const role = selectedTable?.current_user_role
    return role === 'owner' || role === 'admin'
  }, [selectedTable])

  // Wave 4 F6 (PRD §五块 2.3 末段):订阅 NotificationStore,实时降级响应。
  //  - resource_shared + action='removed'/'auto_removed' + 命中当前 tableId → 显示遮罩
  //  - resource_shared + action='permission_changed' + 新权限 < editor → toast 提示只读
  // 订阅整个 notifications(store 内引用稳定),外层 useMemo 派生 — 避免 selector 每次返回新数组
  // 触发 zustand v5 + React useSyncExternalStore 的 "getSnapshot should be cached" 无限循环。
  const navigate = useNavigate()
  const location = useLocation()
  const allNotifications = useNotificationStore((s) => s.notifications)
  const resourceNotifications = useMemo(
    () => selectResourceShareNotifications(allNotifications, 'table', tableId),
    [allNotifications, tableId],
  )
  const downgrade = useResourceShareDowngrade('table', tableId, resourceNotifications)
  const downgradeInsufficient = isPermissionInsufficientForEditing(downgrade.changedPermission)
  // ：仅当 role 在 removed 通知之后重新拉取确认 viewer+ 时，才压住历史遮罩
  const tableRole = selectedTable?.current_user_role
  const [roleFetchedAtMs, setRoleFetchedAtMs] = useState(0)
  useEffect(() => {
    if (tableId && tableRole) {
      setRoleFetchedAtMs(Date.now())
    }
  }, [tableId, tableRole])
  const showRemovedOverlay = shouldShowRemovedOverlay({
    isRemoved: downgrade.isRemoved,
    role: tableRole,
    removedAt: downgrade.sourceCreatedAt,
    roleFetchedAtMs,
  })

  const lastToastedNotifIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!downgradeInsufficient || !downgrade.sourceNotificationId) return
    if (lastToastedNotifIdRef.current === downgrade.sourceNotificationId) return
    lastToastedNotifIdRef.current = downgrade.sourceNotificationId
    const permLabel = downgrade.changedPermission
      ? t(`share.permission.${downgrade.changedPermission}Label`, {
          ns: 'common',
          defaultValue: downgrade.changedPermission,
        })
      : ''
    toast({
      title: t('share.editor.permissionChanged.toast', {
        ns: 'common',
        permission: permLabel,
        defaultValue: `你的权限已变更为 ${permLabel},编辑器已切换为只读`,
      }) as string,
    })
  }, [downgradeInsufficient, downgrade.sourceNotificationId, downgrade.changedPermission, t])

  const handleReturnFromRemoved = useCallback(() => {
    const wtId = selectedOrganizationId
    const spId = selectedTable?.space_id
    if (wtId && spId) {
      navigate(`/organizations/${wtId}/spaces/${spId}`)
    } else if (spId) {
      navigate(`/spaces/${spId}`)
    } else {
      navigate('/')
    }
  }, [selectedOrganizationId, selectedTable?.space_id, navigate])
  const {
    tableFontStyle, setTableFontStyle,
    tableFontWeight, setTableFontWeight,
    tableFontSize, setTableFontSize,
  } = useTableFontStyle(tableId)
  const [selectedRows, setSelectedRows] = useState<TableGridRow[]>([])
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null)
  const [creatingRecordInitialValues, setCreatingRecordInitialValues] = useState<Record<string, unknown> | null>(null)
  const [recordSurfaceSelection, setRecordSurfaceSelection] = useState<TableRecordSurfaceSelection | null>(null)
  const [recordCommentIntent, setRecordCommentIntent] = useState<RecordCommentRouteIntent | null>(null)
  const [pendingDeleteRecordIds, setPendingDeleteRecordIds] = useState<string[] | null>(null)
  const [pendingDeleteField, setPendingDeleteField] = useState<Field | null>(null)
  const viewPopoverRef = useRef<ViewPopoverControls | null>(null)
  const gridApiRef = useRef<TableGridRuntimeApi | null>(null)
  const rowExpandRequestRef = useRef(0)

  useEffect(() => {
    const intent = parseRecordCommentRouteIntent(location.search)
    if (!intent) return
    setRecordCommentIntent(intent)
    setEditingRecordId(intent.recordId)
    navigate({
      pathname: location.pathname,
      search: clearRecordCommentRouteIntent(location.search),
      hash: location.hash,
    }, { replace: true })
  }, [location.hash, location.pathname, location.search, navigate])

  const handleTableApiReady = useCallback((api: TableGridRuntimeApi | null) => {
    gridApiRef.current = api
  }, [])

  const openCreateFieldDialog = useCallback((context: InsertFieldContext | null) => {
    // Mobile browsers keep the software keyboard visible while Canvas retains
    // its hidden input focus. End the cell edit before mounting the dialog so
    // its first layout uses the full visible viewport.
    gridApiRef.current?.stopEditing?.()
    const focusedElement = document.activeElement
    if (focusedElement instanceof HTMLElement) focusedElement.blur()
    setInsertFieldContext(context)
    setFieldDialogOpen(true)
  }, [])

  const fieldsReadyRef = useRef<string | null>(null)
  const onTableReady = useCallback((_id: string, _table: Table) => {
    if (fieldsReadyRef.current === _id) return
    if (fields.length === 0) {
      fieldsReadyRef.current = _id
      void loadFields(_id)
    } else {
      fieldsReadyRef.current = _id
    }
  }, [fields.length, loadFields])

  const lastViewIdRef = useRef<string | null>(null)
  const lastViewTableIdRef = useRef<string | null>(null)
  if (lastViewTableIdRef.current !== tableId) {
    lastViewTableIdRef.current = tableId
    lastViewIdRef.current = readLastViewId(tableId)
  }

  const initializeViewWithFallback = useMemo(() => {
    return (id: string, options?: { defaultViewId?: string }) => {
      const persisted = lastViewIdRef.current || ''
      const defaultViewId = persisted || options?.defaultViewId
      return initializeView(id, defaultViewId ? { defaultViewId } : undefined)
    }
  }, [initializeView])

  const {
    displayTable,
    fetchFailed,
    showPaneLoading,
    loadingTimedOut,
    handleForceRetry,
  } = useTableInitFlow({
    tableId,
    globalTables,
    getGlobalTable,
    selectTable,
    selectedTable,
    initializeView: initializeViewWithFallback,
    viewTableId,
    currentViewId,
    viewLoading,
    onTableReady,
  })

  useEffect(() => {
    if (viewTableId !== tableId) return
    if (!currentViewId) return
    if (lastViewIdRef.current === currentViewId) return
    lastViewIdRef.current = currentViewId
    writeLastViewId(tableId, currentViewId)
  }, [tableId, viewTableId, currentViewId])

  // ── Grid dataset + columns（对齐 Electron 的 useDataGridDataset / useDataGridColumns）──
  const currentView = useMemo(
    () => views.find(v => v.id === currentViewId) ?? null,
    [views, currentViewId],
  )

  const rawViewStoreApi = useViewStoreApi()
  const { merge: mergeIncrementalViewRecords, remove: removeViewRecordsByIds } =
    useIncrementalViewMerge(rawViewStoreApi)
  const getRecordIds = useCallback((): string[] => {
    const records = rawViewStoreApi.getState().currentViewRecords?.records
    return records?.map((r: { id: string }) => r.id) ?? []
  }, [rawViewStoreApi])

  // ── Y.js 协作桥接层 ──
  const wsLoadViews = useViewStore(state => state.loadViews)
  const refreshFieldStructure = useCallback(async (targetTableId: string) => {
    await loadFields(targetTableId)
    if (currentViewId) {
      await wsLoadViews(targetTableId)
      return
    }
    await refreshCurrentView()
  }, [currentViewId, loadFields, refreshCurrentView, wsLoadViews])
  const handleCollabFieldChange = useCallback(
    (info: { action: string; field_ids?: string[] }) => {
      if (info.action !== 'update_field') {
        void refreshFieldStructure(tableId).catch(error => {
          console.error('[TablePaneView] 协作字段结构刷新失败:', error)
        })
        return
      }
      void loadFields(tableId)
    },
    [loadFields, refreshFieldStructure, tableId],
  )
  const handleCollabViewChange = useCallback(() => {
    void wsLoadViews(tableId)
  }, [wsLoadViews, tableId])

  const collabBridgeInput = {
    fields: fields as Field[],
    updateRecord: rawUpdateRecord,
    createRecord: rawCreateRecord,
    mergeIncrementalRecords: mergeIncrementalViewRecords,
    mergeIncrementalViewRecords,
    removeRecordsByIds: removeViewRecordsByIds,
    onFieldChange: handleCollabFieldChange,
    onViewChange: handleCollabViewChange,
  }
  const collabTableId = disableCollab ? null : displayTable?.id ?? null

  const shareCollabBridge = useShareWebCollabBridge({
    ...collabBridgeInput,
    shareId: shareCollab?.shareId ?? '',
    password: shareCollab?.password,
    getAuthToken: shareCollab?.getAuthToken ?? (async () => ''),
    refreshToken: shareCollab?.refreshToken ?? (async () => null),
    selectedTableId: shareCollab ? collabTableId : null,
    collabDisabled: !shareCollab || shareCollab.collabDisabled,
  })
  const webCollabBridge = useWebCollabBridge({
    ...collabBridgeInput,
    selectedTableId: shareCollab ? null : collabTableId,
  })
  const collabBridge = shareCollab ? shareCollabBridge : webCollabBridge
  const subscribeCommentChanges = useCallback(
    (onChange: () => void) => collabBridge.collab.onStatelessEvent(
      'table.comment.changed',
      onChange,
    ),
    [collabBridge.collab.onStatelessEvent],
  )
  const collabActive = !disableCollab && collabBridge.collab.isOnline && !collabBridge.collab.isFallback
  const collabProjectsViewRecords = collabActive && !collabBridge.collab.isTruncated
  const runtimeUpdateRecord = disableCollab ? rawUpdateRecord : collabBridge.updateRecord
  const runtimeCreateRecord = disableCollab ? rawCreateRecord : collabBridge.createRecord
  const isRuntimeViewLocked = useCallback(
    (viewId: string) => {
      const runtimeView = collabActive
        ? collabBridge.collab.viewsMeta.find(view => String(view.id) === viewId)
        : views.find(view => String(view.id) === viewId)
      return isViewLocked(runtimeView?.is_locked)
    },
    [collabActive, collabBridge.collab.viewsMeta, views],
  )

  const updateViewForRuntime = useCallback(
    async (...args: Parameters<typeof updateView>) => {
      const [viewId, payload] = args
      const payloadKeys = payload && typeof payload === 'object' ? Object.keys(payload) : []
      const isLockToggleOnly = payloadKeys.length > 0 && payloadKeys.every(key => key === 'is_locked')
      if (isRuntimeViewLocked(viewId) && !isLockToggleOnly) {
        toast({
          title: t('pane.lockedEditDeniedTitle', { defaultValue: '视图已锁定' }),
          description: t('pane.lockedEditDeniedDesc', {
            defaultValue: '请先启用个人视图，或解锁后再修改视图配置。',
          }),
          variant: 'destructive',
        })
        return null
      }
      if (!collabActive) {
        return updateView(...args)
      }
      if (!collabBridge.collab.canEdit) return null
      const currentViews = collabBridge.collab.viewsMeta
      const baseView = currentViews.find(view => String(view.id) === viewId)
      if (!baseView) return null
      // config / column_meta 深合并，避免局部 patch（如汇总函数）冲掉既有配置
      const nextView = applyViewUpdatePayload(
        baseView as Record<string, unknown>,
        payload as Record<string, unknown>,
        { viewId, updatedAt: new Date().toISOString() },
      )
      collabBridge.collab.updateViewsMeta(
        currentViews.map(view => String(view.id) === viewId ? nextView : view),
      )
      return nextView as unknown as Awaited<ReturnType<typeof updateView>>
    },
    [collabActive, collabBridge.collab, isRuntimeViewLocked, t, updateView],
  )

  // 视图生命周期镜像：协作在线时，把 REST 视图列表的生命周期 + 元信息维度
  // （新建/删除/重排/改名/默认/锁定）同步到 Y.Doc viewsMeta，配置维度保留 Y.Doc
  // 已同步值。否则这些只走 REST 的操作不会反映到正在渲染的 Y.Doc 视图。
  useEffect(() => {
    if (!collabActive) return
    if (views.length === 0) return
    const ydocViews = collabBridge.collab.viewsMeta as Array<Record<string, unknown>>
    const { next, changed } = mergeViewsLifecycleIntoYDoc(
      views as unknown as Array<Record<string, unknown>>,
      ydocViews,
    )
    if (changed) {
      collabBridge.collab.updateViewsMeta(next)
    }
  }, [collabActive, views, collabBridge.collab.viewsMeta, collabBridge.collab.updateViewsMeta])

  const setPersonalViewDraftForRuntime = useTableViewUiStore(state => state.setPersonalViewDraft)

  const applyDraftForRuntime = useCallback(
    async (viewId: string) => {
      if (isRuntimeViewLocked(viewId)) return
      if (!collabActive) {
        await applyDraft(viewId)
        return
      }
      const draft = rawViewStoreApi.getState().draftStates[viewId]
      if (!draft) return
      const tableId = displayTable?.id
      if (!tableId) return
      // 协作预览：只写会话草稿，不落共享视图 / Y.Doc（保存走 saveDraftForRuntime）
      setPersonalViewDraftForRuntime(tableId, viewId, {
        filters: draft.filters ?? [],
        groups: draft.groups ?? [],
        sorts: draft.sorts ?? [],
        filter_logic: draft.filter_logic === 'or' ? 'or' : 'and',
      })
    },
    [
      applyDraft,
      collabActive,
      displayTable?.id,
      isRuntimeViewLocked,
      rawViewStoreApi,
      setPersonalViewDraftForRuntime,
    ],
  )

  const saveDraftForRuntime = useCallback(
    async (viewId: string) => {
      if (isRuntimeViewLocked(viewId)) return null
      if (!collabActive) {
        return await saveDraft(viewId)
      }
      const draft = rawViewStoreApi.getState().draftStates[viewId]
      if (!draft) return null
      const baseView = collabBridge.collab.viewsMeta.find(view => String(view.id) === viewId)
      if (!baseView) return null
      const payload = buildViewDraftSavePayload(baseView as unknown as ViewMeta, draft)
      const result = await updateViewForRuntime(viewId, {
        filters: payload.filters,
        groups: payload.groups,
        sorts: payload.sorts,
        config: payload.config,
      }, { silent: true, refreshRecords: false })
      if (result) {
        rawViewStoreApi.setState(state => ({
          draftStates: {
            ...state.draftStates,
            [viewId]: {
              ...draft,
              groups: payload.groups,
              isDirty: false,
            },
          },
        }))
      }
      return result
    },
    [collabActive, collabBridge.collab.viewsMeta, isRuntimeViewLocked, rawViewStoreApi, saveDraft, updateViewForRuntime],
  )

  const isPersonalViewEnabled = useTableViewUiStore(state =>
    state.isPersonalViewEnabled(displayTable?.id, currentViewId)
  )
  const personalViewDraft = useTableViewUiStore(state =>
    displayTable?.id && currentViewId ? state.getPersonalViewDraft(displayTable.id, currentViewId) : null
  )
  const togglePersonalView = useTableViewUiStore(state => state.togglePersonalView)

  const collabCurrentView = useMemo(() => {
    if (!collabActive) return currentView
    if (!currentViewId) {
      return (collabBridge.collab.viewsMeta[0] as unknown as typeof currentView | undefined) ?? null
    }
    const ydocView = collabBridge.collab.viewsMeta.find(view => String(view.id) === currentViewId)
    return (ydocView as unknown as typeof currentView | undefined) ?? null
  }, [collabActive, collabBridge.collab.viewsMeta, currentView, currentViewId])

  const uiFields = fields
  const uiCurrentView = useMemo(() => {
    if (!collabCurrentView) return collabCurrentView

    // 会话级排序/筛选/分组草稿：关闭弹窗后仍生效，不依赖「个人视图」开关。
    if (!isPersonalViewEnabled || !personalViewDraft) {
      if (!personalViewDraft) return collabCurrentView
      let next = collabCurrentView
      if (personalViewDraft.sorts !== undefined) {
        next = { ...next, sorts: personalViewDraft.sorts }
      }
      if (personalViewDraft.filters !== undefined) {
        next = { ...next, filters: personalViewDraft.filters }
      }
      if (personalViewDraft.groups !== undefined) {
        next = { ...next, groups: personalViewDraft.groups }
      }
      if (personalViewDraft.filter_logic === 'and' || personalViewDraft.filter_logic === 'or') {
        next = {
          ...next,
          config: {
            ...((next.config as Record<string, unknown> | undefined) ?? {}),
            filter_logic: personalViewDraft.filter_logic,
          },
        }
      }
      return next
    }

    const nextConfig = {
      ...((collabCurrentView.config as Record<string, unknown> | undefined) ?? {}),
      ...((personalViewDraft.config as Record<string, unknown> | undefined) ?? {}),
    }
    const filterLogic = personalViewDraft.filter_logic ?? (personalViewDraft.config as Record<string, unknown> | undefined)?.filter_logic
    if (filterLogic === 'and' || filterLogic === 'or') {
      nextConfig.filter_logic = filterLogic
    }
    return {
      ...collabCurrentView,
      ...(personalViewDraft.filters !== undefined ? { filters: personalViewDraft.filters } : {}),
      ...(personalViewDraft.groups !== undefined ? { groups: personalViewDraft.groups } : {}),
      ...(personalViewDraft.sorts !== undefined ? { sorts: personalViewDraft.sorts } : {}),
      ...(personalViewDraft.visible_fields ? { visible_fields: personalViewDraft.visible_fields } : {}),
      ...(personalViewDraft.field_order ? { field_order: personalViewDraft.field_order } : {}),
      ...(personalViewDraft.column_meta ? { column_meta: personalViewDraft.column_meta } : {}),
      config: nextConfig,
    }
  }, [collabCurrentView, isPersonalViewEnabled, personalViewDraft])
  // 资源角色、分享权限、实时协作写权限与降级通知共同决定入口能力。
  const effectiveReadonly = resolveTableReadonly({
    currentUserRole: displayTable?.current_user_role,
    sharePermission: shareCollab?.permission,
    collabActive,
    collabCanEdit: collabBridge.collab.canEdit,
    downgradeInsufficient,
  })
  // 详情本身支持只读模式；viewer 也应能从移动卡片进入字段详情，而不是被困在摘要层。
  const canOpenRecordDetail = Boolean(displayTable || shareCollab)
  const updateRecord = useCallback<typeof runtimeUpdateRecord>(
    async (...args) => {
      if (effectiveReadonly) return null
      return runtimeUpdateRecord(...args)
    },
    [effectiveReadonly, runtimeUpdateRecord],
  )
  const createRecord = useCallback<typeof runtimeCreateRecord>(
    async (...args) => {
      if (effectiveReadonly) return null
      return runtimeCreateRecord(...args)
    },
    [effectiveReadonly, runtimeCreateRecord],
  )
  const updateViewWhenWritable = useCallback<typeof updateViewForRuntime>(
    async (...args) => {
      if (effectiveReadonly) return null
      return updateViewForRuntime(...args)
    },
    [effectiveReadonly, updateViewForRuntime],
  )

  const collabViewRecordsPayload = useMemo(
    () => collabActive
      ? buildWebCollabViewRecords({
          tableId: displayTable?.id ?? null,
          recordsSnapshot: collabBridge.collab.recordsSnapshot,
          rowOrder: collabBridge.collab.rowOrder,
          fieldsMeta: collabBridge.collab.fieldsMeta,
          view: uiCurrentView,
          query: recordsQuery,
        })
      : null,
    [
      collabActive,
      collabBridge.collab.fieldsMeta,
      collabBridge.collab.recordsSnapshot,
      collabBridge.collab.rowOrder,
      displayTable?.id,
      recordsQuery,
      uiCurrentView,
    ],
  )
  const uiRecordsPayloadBase = collabActive
    ? collabViewRecordsPayload
    : currentViewRecords as TableUiViewRecordsResponse | null
  const uiRecordsPayload = useMemo(() => {
    if (!uiRecordsPayloadBase || attachmentGridPatches.size === 0) {
      return uiRecordsPayloadBase
    }

    let changed = false
    const patches = Array.from(attachmentGridPatches.values())
    const nextRecords = uiRecordsPayloadBase.records.map((record) => {
      const recordPatches = patches.filter(item => item.recordId === record.id)
      if (recordPatches.length === 0) return record
      changed = true
      return recordPatches.reduce(
        (nextRecord, patch) => patchAttachmentFieldRecord(nextRecord, patch),
        record as TableUiRecord,
      )
    })

    return changed
      ? {
          ...uiRecordsPayloadBase,
          records: nextRecords,
        }
      : uiRecordsPayloadBase
  }, [attachmentGridPatches, uiRecordsPayloadBase])

  useEffect(() => {
    if (!uiRecordsPayloadBase || attachmentGridPatches.size === 0) return

    const matchedPatches: AttachmentFieldGridPatch[] = []
    for (const patch of attachmentGridPatches.values()) {
      const record = uiRecordsPayloadBase.records.find(item => item.id === patch.recordId)
      const currentValue = record?.fields?.[patch.fieldId] ?? record?.data?.[patch.fieldName]
      if (areAttachmentPatchValuesEqual(currentValue, patch.value)) {
        matchedPatches.push(patch)
      }
    }
    if (matchedPatches.length === 0) return

    setAttachmentGridPatches((current) => {
      const next = new Map(current)
      matchedPatches.forEach((matchedPatch) => {
        const key = getAttachmentFieldGridPatchKey(matchedPatch)
        const latestPatch = next.get(key)
        if (latestPatch && areAttachmentPatchValuesEqual(latestPatch.value, matchedPatch.value)) {
          next.delete(key)
        }
      })
      return next
    })
  }, [attachmentGridPatches, uiRecordsPayloadBase])

  const uiRecords = useMemo(
    () => uiRecordsPayload?.records ?? EMPTY_RECORDS,
    [uiRecordsPayload],
  )

  const page = recordsQuery?.page ?? 1
  const pageSize = recordsQuery?.page_size ?? 100
  const total = uiRecordsPayload?.total ?? 0
  const isGridView = uiCurrentView?.view_type === 'grid' || !uiCurrentView
  const recordSurfacePreference = resolveTableRecordSurfacePreference(
    recordSurfaceSelection,
    currentViewId,
    layout,
  )
  const recordSurfacePolicy = resolveTableRecordSurfacePolicy({
    isGridView,
    isPhonePresentation,
    isTabletPresentation,
    layout,
    orientation,
    preference: recordSurfacePreference,
  })
  const useMobileRecordSurface = recordSurfacePolicy.surface === 'cards'
  const selectRecordSurface = useCallback((surface: 'cards' | 'grid') => {
    setRecordSurfaceSelection((current) => selectTableRecordSurface(
      current,
      currentViewId,
      layout,
      surface,
    ))
  }, [currentViewId, layout])

  const dataset = useDataGridDataset({
    fields: uiFields,
    currentView: uiCurrentView,
    currentViewRecords: uiRecordsPayload,
    records: uiRecords,
    userDisplayNameById,
    useViewData: true,
    collapsedGroupIds,
    isRecordsLoading,
    isRecordLoading: false,
    recordsQueryPage: page,
    recordsQueryPageSize: pageSize,
    page,
    pageSize,
    total,
    t: (key) => tl(key, { defaultValue: key }),
    locale: i18n.language,
  })

  const {
    searchQuery, setSearchQuery,
    searchScope, setSearchScope,
    searchSelectedFieldIds, setSearchSelectedFieldIds,
    searchHideNotMatchRows, setSearchHideNotMatchRows,
    searchCurrentMatchIdx,
    searchMatches,
    searchHitIndex,
    handleSearchNavigateNext,
    handleSearchNavigatePrev,
  } = useTablePaneSearch({
    fields,
    groupedRows: dataset.groupedRows ?? [],
    currentViewId,
    fetchViewRecords,
    recordsQuery: recordsQuery as Record<string, unknown>,
    gridApiRef,
    onFocusRecord: useMobileRecordSurface ? () => undefined : undefined,
  })

  const mobileSearchRecordId = useMobileRecordSurface && searchCurrentMatchIdx >= 0
    ? searchMatches[searchCurrentMatchIdx]?.rowId ?? null
    : null

  const fallbackOrderedFields = useMemo(
    () => uiFields.filter(field => !field.is_hidden),
    [uiFields],
  )
  const gridOrderedFields = dataset.orderedFields.length > 0 ? dataset.orderedFields : fallbackOrderedFields
  const mobileHasVisibleFields = useMemo(
    () => resolveMobileVisibleFields(uiCurrentView, fields).length > 0,
    [fields, uiCurrentView],
  )

  useEffect(() => {
    if (!useMobileRecordSurface) return

    setSelectedRows([])
    gridApiRef.current = null
  }, [useMobileRecordSurface])

  useEffect(() => {
    if (!mobileSearchRecordId || !useMobileRecordSurface) return
    const recordCard = Array.from(
      document.querySelectorAll<HTMLElement>('[data-mobile-record-card]'),
    ).find((element) => element.dataset.mobileRecordCard === mobileSearchRecordId)
    recordCard?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [mobileSearchRecordId, useMobileRecordSurface])

  const { columns, firstEditableField } = useDataGridColumns({
    orderedFields: gridOrderedFields,
    currentView: uiCurrentView,
    hasGrouping: dataset.hasGrouping,
    formatAttachmentCount: (count) =>
      t('attachments.count', { defaultValue: '{{count}} attachments', count }),
    t: (key, options) => tl(key, { defaultValue: key, ...(options ?? {}) }),
    locale: i18n.language,
    isReadonly: effectiveReadonly,
  })

  // ── 协作断连/重连提示 ──
  const [showCollabDisconnected, setShowCollabDisconnected] = useState(false)
  const prevCollabConnectedRef = useRef(collabBridge.isConnected)
  const hadVisibleDisconnectRef = useRef(false)
  useEffect(() => {
    if (disableCollab) {
      setShowCollabDisconnected(false)
      hadVisibleDisconnectRef.current = false
      return
    }
    const prev = prevCollabConnectedRef.current
    prevCollabConnectedRef.current = collabBridge.isConnected

    if (collabBridge.isConnected) {
      setShowCollabDisconnected(false)
      if (!prev && !collabBridge.collab.isFallback && hadVisibleDisconnectRef.current) {
        toast({ title: tl('table:collab.reconnected') })
      }
      hadVisibleDisconnectRef.current = false
      return
    }
    if (collabBridge.collab.isFallback) return
    const timer = setTimeout(() => {
      setShowCollabDisconnected(true)
      hadVisibleDisconnectRef.current = true
    }, 3000)
    return () => clearTimeout(timer)
  }, [collabBridge.isConnected, collabBridge.collab.isFallback, disableCollab, tl])

  const getGateway = useCallback(() => getChatClient().getGateway(), [])

  const handleWsFieldChange = useCallback((info: { action: string; field_ids?: string[] }) => {
    if (info.action !== 'update_field') {
      void refreshFieldStructure(tableId).catch(error => {
        console.error('[TablePaneView] WS 字段结构刷新失败:', error)
      })
      return
    }
    void loadFields(tableId)
  }, [loadFields, refreshFieldStructure, tableId])

  const handleWsViewChange = useCallback(() => {
    void wsLoadViews(tableId)
  }, [wsLoadViews, tableId])

  const handleWsRecordOrderChanged = useCallback(() => {
    void refreshCurrentView().catch(error => {
      console.error('[TablePaneView] WS 行排序刷新失败:', error)
    })
  }, [refreshCurrentView])

  const handleIncrementalFullReload = useCallback(
    () => refreshCurrentView({ throwOnError: true }),
    [refreshCurrentView],
  )

  const { startPolling } = useDataGridSyncRuntime({
    getGateway,
    selectedTableId: disableCollab ? null : displayTable?.id ?? null,
    currentViewId,
    useViewData: true,
    syncLatestVersion: currentViewLatestVersion,
    syncEtag: currentViewEtag,
    recordsQuery: recordsQuery as Record<string, unknown>,
    fields: fields as Field[],
    mergeIncrementalRecords: mergeIncrementalViewRecords,
    mergeIncrementalViewRecords,
    removeRecordsByIds: removeViewRecordsByIds,
    removeViewRecordsByIds,
    onFieldChange: handleWsFieldChange,
    onViewChange: handleWsViewChange,
    onRecordOrderChanged: handleWsRecordOrderChanged,
    onFullReloadRequired: handleIncrementalFullReload,
    syncMode: collabBridge.collab.syncMode,
    collabActive,
    isCollabSynced: () => collabBridge.collab.status === CollabStatus.SYNCED,
    getRecordIds,
  })

  // ── Undo/Redo（暂走 API fallback，后续可切换到 CRDT UndoManager） ──

  const undoRedoContainerRef = useRef<HTMLDivElement>(null)
  const refreshViewMetadataAfterUndoRedo = useCallback(async () => {
    await loadFields(tableId)
    await wsLoadViews(tableId)
  }, [loadFields, tableId, wsLoadViews])
  const {
    handleUndo,
    handleRedo,
    canUndo,
    canRedo,
    isUndoing,
    isRedoing,
    handleOpenTableHistory,
    showTableHistory,
    tableHistoryLabel,
    tableHistoryOps,
    tableHistoryTotal,
    isLoadingTableHistory,
    handleCloseTableHistory,
    handleLoadMoreTableHistory,
  } = useUndoRedo({
    selectedTableId: displayTable?.id ?? null,
    selectedTableName: displayTable?.name,
    refreshRecords: refreshCurrentView,
    refreshViews: refreshViewMetadataAfterUndoRedo,
    translate: (key, opts) => tl(key, opts),
    enableUndoRedo: !effectiveReadonly,
    enableKeyboardShortcuts: !effectiveReadonly,
    containerRef: undoRedoContainerRef,
  })

  // ── Personal View（本地草稿覆盖） ──

  const handleTogglePersonalView = useCallback(() => {
    if (displayTable?.id && currentViewId) {
      togglePersonalView(displayTable.id, currentViewId)
      toast({
        title: isPersonalViewEnabled
          ? t('pane.personalViewDisabled')
          : t('pane.personalViewEnabled'),
      })
    }
  }, [displayTable?.id, currentViewId, isPersonalViewEnabled, t, togglePersonalView])
  // uiCurrentView 已合并会话级筛选/分组草稿（不依赖个人视图开关）
  const effectiveViewFilters = useMemo(
    () => uiCurrentView?.filters ?? [],
    [uiCurrentView?.filters],
  )
  const effectiveViewGroups = useMemo(
    () => uiCurrentView?.groups ?? [],
    [uiCurrentView?.groups],
  )
  const effectiveFilterLogic = useMemo(() => {
    return (
      (uiCurrentView?.config as Record<string, unknown> | undefined)?.filter_logic
    ) as string | undefined
  }, [uiCurrentView?.config])

  // ── Inline draft row editing (aligned with Electron) ──

  const viewStoreApi = useMemo(
    () => ({
      getState: () => ({
        currentViewRecords: collabActive ? uiRecordsPayload : rawViewStoreApi.getState().currentViewRecords,
        currentViewEtag: rawViewStoreApi.getState().currentViewEtag,
      }),
      setState: rawViewStoreApi.setState,
    }),
    [collabActive, rawViewStoreApi, uiRecordsPayload],
  )

  const focusRecordRow = useCallback((recordId: string) => {
    const api = gridApiRef.current
    if (!api) return false

    const displayedCount = api.getDisplayedRowCount?.() ?? 0
    for (let index = 0; index < displayedCount; index += 1) {
      const rowNode = api.getDisplayedRowAtIndex?.(index)
      const rowData = rowNode?.data as Record<string, unknown> | undefined
      if (!rowData) continue

      const rowId = typeof rowData.id === 'string' ? rowData.id : undefined
      const rowStableId = typeof rowData.row_id === 'string' ? rowData.row_id : undefined
      if (rowId !== recordId && rowStableId !== recordId) continue

      api.ensureIndexVisible?.(index, 'middle')
      ;(rowNode as { setSelected?: (selected: boolean, clearSelection?: boolean) => void } | undefined)
        ?.setSelected?.(true, true)
      setSelectedRows(rowNode?.data ? [rowNode.data as TableGridRow] : [])
      if (firstEditableField) {
        api.setFocusedCell?.(index, firstEditableField)
      }
      return true
    }

    return false
  }, [firstEditableField])

  const focusRecordRowWithRetry = useCallback((recordId: string) => {
    let attempts = 0
    const maxAttempts = 8

    const tryFocus = () => {
      attempts += 1
      const found = focusRecordRow(recordId)
      if (found || attempts >= maxAttempts) {
        return
      }
      setTimeout(tryFocus, 80)
    }

    tryFocus()
  }, [focusRecordRow])

  const handleRecordCreatedVisible = useCallback(async (record: { id?: string }) => {
    const recordId = record?.id
    if (!recordId) return
    setTimeout(() => {
      focusRecordRowWithRetry(recordId)
    }, 0)
  }, [focusRecordRowWithRetry])

  const handleRevealHiddenRecord = useCallback(async (record: { id?: string }) => {
    if (!currentViewId) return

    clearGroupCollapse(currentViewId)
    setDraftFilters(currentViewId, [])
    await applyDraftForRuntime(currentViewId)

    const recordId = record?.id
    if (!recordId) return
    setTimeout(() => {
      focusRecordRowWithRetry(recordId)
    }, 0)
  }, [applyDraftForRuntime, clearGroupCollapse, currentViewId, focusRecordRowWithRetry, setDraftFilters])

  const isCreatedRecordVisible = useCallback(async (record: { id?: string }) => {
    if (!record?.id) return false
    const { firstVisibleRecord } = await resolveCreatedRecordVisibility({
      gridApiRef,
      createdRecords: [record],
    })
    return Boolean(firstVisibleRecord)
  }, [])

  const {
    draftRowData,
    draftAddRowContext,
    isDraftSubmitting,
    handleAddRowClick,
    handleCellValueChanged: draftCellValueChanged,
    handleCellEditingStopped: draftCellEditingStopped,
    handleCancelDraftRow,
    handleCommitDraftRow,
  } = useDataGridEditingController({
    orderedFields: gridOrderedFields,
    fields: uiFields,
    selectedTableId: displayTable?.id ?? null,
    useViewData: true,
    firstEditableField,
    isReadonly: effectiveReadonly,
    gridApiRef,
    viewStoreApi,
    createRecord: async (data) => {
      const record = await createRecord(data)
      return record ?? null
    },
    updateRecord: async (recordId, data) => {
      const record = await updateRecord(recordId, data)
      return record ?? null
    },
    refreshCurrentView,
    startPolling,
    checkIfTriggersAutoField: (_fieldNameOrId: string): Field[] => [],
    getLastConflicts: () => recordStoreApi.getState().lastConflicts,
    translate: (key, options) => tl(key, options),
    draftRowId: DRAFT_ROW_ID,
    buildCreateRecordOrderContext: (addRowContext) => {
      if (!currentViewId) return undefined
      return {
        view_id: currentViewId,
        position: 'end' as const,
        ...(addRowContext?.group_values ? { group_values: addRowContext.group_values } : {}),
      }
    },
    notify: (notification) => {
      const actionElement: ToastActionElement | undefined = notification.action
        ? React.createElement(
            ToastAction,
            {
              altText: notification.action.altText ?? notification.action.label,
              onClick: notification.action.onAction,
            },
            notification.action.label,
          )
        : undefined
      toast({
        title: notification.title,
        description: notification.description,
        variant: notification.variant === 'destructive' ? 'destructive' : undefined,
        action: actionElement,
      })
    },
    onRevealHiddenRecord: handleRevealHiddenRecord,
    onRecordCreated: handleRecordCreatedVisible,
    isRecordVisible: isCreatedRecordVisible,
  })

  useEffect(() => {
    if (!effectiveReadonly) return
    handleCancelDraftRow()
    if (!canOpenRecordDetail) setEditingRecordId(null)
    setCreatingRecordInitialValues(null)
    setFieldDialogOpen(false)
    setEditFieldDialogOpen(false)
    setLinkEditorState(null)
    setFieldMgmtOpen(false)
    setImportDialogOpen(false)
    setConversionPreviewOpen(false)
    setPendingEditData(null)
    setForceConversion(false)
    setPendingDeleteRecordIds(null)
    setPendingDeleteField(null)
    setInsertFieldContext(null)
  }, [
    canOpenRecordDetail,
    effectiveReadonly,
    handleCancelDraftRow,
    setConversionPreviewOpen,
  ])

  const fieldByIdForDraft = useMemo(() => {
    const map = new Map<string, Field>()
    for (const f of fields) map.set(f.id, f)
    return map
  }, [fields])
  const fieldByNameForDraft = useMemo(() => {
    const map = new Map<string, Field>()
    for (const f of fields) map.set(f.name, f)
    return map
  }, [fields])

  const rowsWithDraft = useMemo(
    () => buildRowsWithDraft({
      groupedRows: dataset.groupedRows ?? [],
      draftRowData: effectiveReadonly ? null : draftRowData,
      hasGrouping: dataset.hasGrouping,
      draftAddRowContext: effectiveReadonly ? null : draftAddRowContext,
      viewGroups: effectiveViewGroups,
      getFieldById: (id) => fieldByIdForDraft.get(id),
    }),
    [dataset.groupedRows, dataset.hasGrouping, effectiveReadonly, draftRowData, draftAddRowContext, effectiveViewGroups, fieldByIdForDraft],
  )

  const handleCreatedRecordsVisibility = useCallback(async (createdRecords: TableUiRecord[]) => {
    if (createdRecords.length === 0) {
      return { hiddenCount: 0 }
    }

    const { firstVisibleRecord, hiddenRecords } = await resolveCreatedRecordVisibility({
      gridApiRef,
      createdRecords,
    })

    if (hiddenRecords.length > 0) {
      toast({
        title: t('record.createdTitle', { defaultValue: 'Record created' }),
        description: t('record.createdOffscreenDesc', {
          defaultValue: '{{count}} new records are not visible in the current table area',
          count: hiddenRecords.length,
        }),
      })
    }

    if (firstVisibleRecord) {
      await handleRecordCreatedVisible(firstVisibleRecord)
    }

    return { hiddenCount: hiddenRecords.length }
  }, [gridApiRef, handleRecordCreatedVisible, t])

  // ── Clipboard (对齐 Electron 的复制粘贴) ──

  const buildCreatePlanFromDisplayRowIndex = useCallback(
    (
      displayRowIndex: number,
      position: 'before' | 'after' | 'end' = 'after',
    ): ViewAwareCreatePlan => {
      const baseOrder: ViewAwareCreatePlan['orderContext'] = {
        ...(currentViewId ? { view_id: currentViewId } : {}),
        position: 'end',
      }

      const api = gridApiRef.current
      const runtimeRowData = api?.getDisplayedRowAtIndex?.(displayRowIndex)?.data as
        | Record<string, unknown>
        | undefined
      const rowData =
        runtimeRowData && typeof runtimeRowData === 'object'
          ? runtimeRowData
          : (rowsWithDraft[displayRowIndex] as Record<string, unknown> | undefined)

      const activeFilters = Array.isArray(effectiveViewFilters)
        ? effectiveViewFilters.filter((filter) => filter?.enabled !== false)
        : []
      const filterPrefillValues = resolveFilterPrefillValues({
        activeFilters,
        filterLogic: effectiveFilterLogic,
        getFieldById: (id) => fieldByIdForDraft.get(id),
      })

      if (!rowData) {
        return {
          orderContext: baseOrder,
          prefillValues: filterPrefillValues,
        }
      }

      const rowType = rowData.__rowType as string | undefined
      const explicitGroupValues =
        rowData.__groupValues && typeof rowData.__groupValues === 'object'
          ? (rowData.__groupValues as Record<string, unknown>)
          : undefined
      const safeExplicitGroupValues =
        explicitGroupValues &&
        Object.fromEntries(
          Object.entries(explicitGroupValues).filter(([fieldName]) => {
            const fieldMeta = fieldByNameForDraft.get(fieldName)
            if (!fieldMeta) return false
            return ![
              'created_time',
              'last_modified_time',
              'created_by',
              'last_modified_by',
            ].includes(fieldMeta.field_type)
          }),
        )
      const derivedGroupValues = resolveGroupPrefillValuesFromAnchor({
        activeGroups: effectiveViewGroups,
        anchorRow: rowType && rowType !== 'draft' ? null : rowData,
        getFieldById: (id) => fieldByIdForDraft.get(id),
        getFieldByName: (name) => fieldByNameForDraft.get(name),
      })
      const groupPrefillValues =
        safeExplicitGroupValues && Object.keys(safeExplicitGroupValues).length > 0
          ? safeExplicitGroupValues
          : derivedGroupValues
      const prefillValues = mergePrefillValues(filterPrefillValues, groupPrefillValues)

      if (rowType === 'group_add' || rowType === 'add') {
        return {
          orderContext: {
            ...baseOrder,
            ...(groupPrefillValues ? { group_values: groupPrefillValues } : {}),
          },
          prefillValues,
        }
      }

      if (!rowType || rowType === '' || rowType === 'draft') {
        const anchorId = typeof rowData.id === 'string' ? rowData.id : undefined
        return {
          orderContext: {
            ...baseOrder,
            ...(anchorId && rowType !== 'draft'
              ? { anchor_record_id: anchorId, position }
              : {}),
            ...(groupPrefillValues ? { group_values: groupPrefillValues } : {}),
          },
          prefillValues,
        }
      }

      return {
        orderContext: {
          ...baseOrder,
          ...(groupPrefillValues ? { group_values: groupPrefillValues } : {}),
        },
        prefillValues,
      }
    },
    [currentViewId, effectiveFilterLogic, effectiveViewFilters, effectiveViewGroups, fieldByIdForDraft, fieldByNameForDraft, gridApiRef, rowsWithDraft],
  )

  const {
    handleClipboardCopy,
    handleClipboardPaste,
    pasteConfirmState,
    confirmPaste,
    cancelPaste,
  } = useDataGridClipboard({
    columns,
    gridApiRef,
    tableId: displayTable?.id ?? null,
    refreshAfterPaste: refreshCurrentView,
    useViewData: true,
    buildCreatePlanFromDisplayRowIndex,
    bulkUpdateRecords,
    bulkCreateRecords,
    onRecordCreated: async () => {
      await refreshCurrentView()
    },
    startPolling,
    checkIfTriggersAutoField: (_fieldNameOrId: string): Field[] => [],
    t: tl,
  })

  useEffect(() => {
    if (effectiveReadonly) cancelPaste()
  }, [cancelPaste, effectiveReadonly])

  const handlePaginationChange = useCallback((pagination: TableGridPagination) => {
    if (pagination.pageSize !== pageSize) {
      void setViewPageSize(pagination.pageSize)
      return
    }
    if (pagination.page !== page) {
      void setViewPage(pagination.page)
    }
  }, [page, pageSize, setViewPage, setViewPageSize])

  const handleCellValueChanged = useCallback(
    async (rowData: TableGridRow, fieldName: string, newValue: unknown, oldValue: unknown) => {
      await draftCellValueChanged(rowData, fieldName, newValue, oldValue)
    },
    [draftCellValueChanged],
  )

  const handleImportComplete = useCallback(async () => {
    try {
      await loadFields(tableId)
      await refreshCurrentView()
      await getGlobalTable(tableId)
      toast({ title: t('import.refreshed', { defaultValue: 'Data refreshed' }) })
    } catch (error) {
      console.error('[TablePaneView] Post-import refresh failed:', error)
      toast({
        title: t('import.refreshFailed', { defaultValue: 'Refresh failed, please refresh manually' }),
        variant: 'destructive',
      })
    }
  }, [getGlobalTable, loadFields, refreshCurrentView, t, tableId])

  const handleRefreshView = useCallback(async () => {
    try {
      await loadFields(tableId)
      await refreshCurrentView()
      await getGlobalTable(tableId)
    } catch (error) {
      console.error('[TablePaneView] Refresh failed:', error)
      toast({
        title: t('toolbar.refreshFailed', { defaultValue: 'Refresh failed' }),
        variant: 'destructive',
      })
    }
  }, [getGlobalTable, loadFields, refreshCurrentView, t, tableId])

  const handleCreateField = useCallback(
    async (data: CreateFieldData) => {
      if (effectiveReadonly) return
      if (!displayTable) return

      try {
        const field = await FieldApiService.createField({
          table_id: displayTable.id,
          name: data.name,
          field_type: data.field_type as FieldType,
          ...(data.description ? { description: data.description } : {}),
          ...(data.options ? { options: data.options as Record<string, unknown> } : {}),
          ...(data.width ? { width: data.width } : {}),
          ...(insertFieldContext?.position ? { insert_position: insertFieldContext.position } : {}),
          ...(insertFieldContext?.referenceFieldId ? { reference_field_id: insertFieldContext.referenceFieldId } : {}),
        })

        if (!field) {
          toast({
            title: t('toolbar.fieldCreateFailed', { defaultValue: 'Failed to create field' }),
            variant: 'destructive',
          })
          throw new Error('create field returned empty')
        }

        await loadFields(displayTable.id)
        await getGlobalTable(displayTable.id)
        if (currentViewId) {
          await wsLoadViews(displayTable.id)
        } else {
          await refreshCurrentView()
        }
        toast({
          title: t('toolbar.fieldCreated', { defaultValue: 'Field created' }),
          description: data.name,
        })
        setFieldDialogOpen(false)
        setInsertFieldContext(null)
      } catch (error) {
        console.error('[TablePaneView] Create field failed:', error)
        toast({
          title: t('toolbar.fieldCreateFailed', { defaultValue: 'Failed to create field' }),
          variant: 'destructive',
        })
        throw error
      }
    },
    [currentViewId, displayTable, effectiveReadonly, getGlobalTable, insertFieldContext, loadFields, refreshCurrentView, t, wsLoadViews],
  )

  const {
    fieldById,
    handleColumnMoved,
    handleColumnResized,
    handleSelectOptionAdd,
    handleFreezeStateChange,
    handleColumnAppend,
    handleColumnHeaderContextMenu,
  } = useTablePaneColumnOps({
    fields,
    currentView: uiCurrentView,
    currentViewId,
    updateView: updateViewWhenWritable,
    refreshCurrentView,
    loadFields,
    viewPopoverRef,
    openCreateFieldDialog,
    setEditingField,
    setEditFieldDialogOpen,
    setPendingDeleteField,
    translate: (key, opts) => tl(key, opts),
  })

  const dataRows = useMemo(() => {
    const rows = dataset.groupedRows ?? []
    return rows.filter(r => {
      const rt = (r as Record<string, unknown>).__rowType
      return rt !== 'group_header' && rt !== 'group_add' && rt !== 'add'
    })
  }, [dataset.groupedRows])

  const handleRowMoved = useCallback(
    async (rowIds: string[], context?: TableGridRowMoveContext) => {
      if (!displayTable || !currentViewId || dataRows.length === 0) return
      const dropIdx = context?.dropRowIndex ?? -1
      let anchorRecordId: string | undefined
      let anchorRowData: Record<string, unknown> | undefined
      let position: 'before' | 'after' = 'after'

      if (dropIdx >= 0 && dropIdx < dataRows.length) {
        const dropRow = dataRows[dropIdx] as Record<string, unknown>
        anchorRecordId = String(dropRow.id ?? '')
        anchorRowData = dropRow
        position = 'before'
      } else if (dataRows.length > 0) {
        const lastRow = dataRows[dataRows.length - 1] as Record<string, unknown>
        anchorRecordId = String(lastRow.id ?? '')
        anchorRowData = lastRow
        position = 'after'
      }

      if (!anchorRecordId) return

      let groupValues: Record<string, unknown> | undefined
      const uiGroups = uiCurrentView?.groups
      const groups = Array.isArray(uiGroups) ? uiGroups : []
      if (anchorRowData && groups.length > 0) {
        const gv: Record<string, unknown> = {}
        for (const group of groups) {
          const gfId = group.field_id
          if (!gfId) continue
          const fMeta = fieldById.get(gfId)
          if (!fMeta) continue
          const val = anchorRowData[fMeta.name]
          gv[fMeta.name] = val === undefined ? null : val
        }
        if (Object.keys(gv).length > 0) groupValues = gv
      }

      try {
        await RecordApiService.reorderRecords({
          table_id: displayTable.id,
          record_ids: rowIds,
          anchor_record_id: anchorRecordId,
          position,
          view_id: currentViewId,
          ...(groupValues ? { group_values: groupValues } : {}),
        })
        await refreshCurrentView()
      } catch (e) {
        console.error('[TablePaneView] row reorder failed', e)
        toast({ title: t('actions.reorderFailed', { defaultValue: 'Row reorder failed' }), variant: 'destructive' })
      }
    },
    [displayTable, currentViewId, uiCurrentView, dataRows, fieldById, refreshCurrentView, t],
  )

  const handleDeleteRecords = useCallback(
    async (recordIds: string[]) => {
      if (recordIds.length === 0) return
      try {
        const result = await bulkDeleteRecords(recordIds)
        void refreshCurrentView()
        if (result.deletedIds.length > 0) {
          const deletedSet = new Set(result.deletedIds)
          setSelectedRows(prev => prev.filter(r => !deletedSet.has(String(r.id))))
        }
        if (!result.ok) {
          toast({
            title: t('toolbar.recordDeleteFailed'),
            description: result.errors[0],
            variant: 'destructive',
          })
          return
        }
        toast({ title: t('toolbar.recordDeleted') })
      } catch (err) {
        console.error('[TablePaneView] bulk delete failed:', err)
        toast({ title: t('toolbar.recordDeleteFailed'), variant: 'destructive' })
      }
    },
    [bulkDeleteRecords, refreshCurrentView, t],
  )

  const confirmDeleteField = useCallback(async () => {
    if (!pendingDeleteField) return
    try {
      await FieldApiService.deleteField(pendingDeleteField.id)
      void loadFields(tableId)
      void refreshCurrentView()
      toast({ title: t('toolbar.fieldDeleted') })
    } catch (err) {
      console.error('[TablePaneView] delete field failed:', err)
      toast({ title: t('toolbar.fieldDeleteFailed'), variant: 'destructive' })
    } finally {
      setPendingDeleteField(null)
    }
  }, [loadFields, pendingDeleteField, refreshCurrentView, t, tableId])

  const requestDeleteRecords = useCallback(
    async (recordIds: string[]) => {
      if (recordIds.length === 0) return
      setPendingDeleteRecordIds(recordIds)
    },
    [],
  )

  const confirmDeleteRecords = useCallback(async () => {
    if (!pendingDeleteRecordIds) return
    await handleDeleteRecords(pendingDeleteRecordIds)
    setPendingDeleteRecordIds(null)
  }, [handleDeleteRecords, pendingDeleteRecordIds])

  // ── Record detail editor ──
  const visibleRecordIds = useMemo(() => {
    const rows = dataset.groupedRows ?? []
    const ids: string[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const r = row as Record<string, unknown>
      if (r.__rowType === 'group_header' || r.__rowType === 'group_add' || r.__rowType === 'add') continue
      const id = String(r.id ?? '')
      if (id && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    return ids
  }, [dataset.groupedRows])

  const editingRecord = useMemo(() => {
    if (!editingRecordId) return null
    const records = uiRecordsPayload?.records ?? []
    return records.find(r => r.id === editingRecordId) ?? null
  }, [editingRecordId, uiRecordsPayload?.records])

  const editingRecordIndex = useMemo(() => {
    if (!editingRecordId) return -1
    return visibleRecordIds.indexOf(editingRecordId)
  }, [editingRecordId, visibleRecordIds])

  const totalPages = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)))
  const paginationPage = Math.max(1, Math.min(page, totalPages))

  useEffect(() => {
    if (!isGridView || isRecordsLoading || total <= 0 || page <= totalPages) {
      return
    }

    void setViewPage(totalPages)
  }, [isGridView, isRecordsLoading, page, setViewPage, total, totalPages])
  const canNavigatePrev = editingRecordIndex > 0 || page > 1
  const canNavigateNext = (editingRecordIndex >= 0 && editingRecordIndex < visibleRecordIds.length - 1) || page < totalPages

  const navigateToPrevRecord = useCallback(() => {
    setRecordCommentIntent(null)
    if (editingRecordIndex > 0) {
      setEditingRecordId(visibleRecordIds[editingRecordIndex - 1])
    } else if (page > 1) {
      void setViewPage(page - 1)
      setEditingRecordId('__pending_last__')
    }
  }, [editingRecordIndex, visibleRecordIds, page, setViewPage])

  const navigateToNextRecord = useCallback(() => {
    setRecordCommentIntent(null)
    if (editingRecordIndex >= 0 && editingRecordIndex < visibleRecordIds.length - 1) {
      setEditingRecordId(visibleRecordIds[editingRecordIndex + 1])
    } else if (page < totalPages) {
      void setViewPage(page + 1)
      setEditingRecordId('__pending_first__')
    }
  }, [editingRecordIndex, visibleRecordIds, page, totalPages, setViewPage])

  useEffect(() => {
    if (!editingRecordId) return
    if (editingRecordId === '__pending_first__' && visibleRecordIds.length > 0) {
      setEditingRecordId(visibleRecordIds[0])
    } else if (editingRecordId === '__pending_last__' && visibleRecordIds.length > 0) {
      setEditingRecordId(visibleRecordIds[visibleRecordIds.length - 1])
    }
  }, [editingRecordId, visibleRecordIds])

  const handleInsertRecord = useCallback(
    async (position: 'before' | 'after', anchorRowIndex: number, count: number) => {
      if (!displayTable || count <= 0) return

      try {
        const createPlan = buildCreatePlanFromDisplayRowIndex(anchorRowIndex, position)
        const recordsToCreate = Array.from({ length: count }, () => ({
          ...(createPlan.prefillValues ?? {}),
        }))

        const createdRecords = await bulkCreateRecords({
          table_id: displayTable.id,
          records: recordsToCreate,
          fieldKeyType: 'name',
          ...(createPlan.orderContext ? { order_context: createPlan.orderContext } : {}),
        })

        if (createdRecords.length === 0) {
          toast({
            title: t('toolbar.recordCreateFailed', { defaultValue: 'Failed to create record' }),
            variant: 'destructive',
          })
          return
        }
        const isPartialCreate = createdRecords.length < count

        try {
          await refreshCurrentView()
        } catch (refreshError) {
          console.error('[TablePaneView] Refresh after insert failed:', refreshError)
          toast({
            title: isPartialCreate
              ? t('record.createdPartialTitle', { defaultValue: 'Some records created' })
              : t('record.createdTitle', { defaultValue: 'Record created' }),
            description: isPartialCreate
              ? t('record.createdPartialRefreshFailedDesc', {
                  defaultValue:
                    'Requested {{requested}} rows; {{created}} rows were created. The current view failed to refresh. Please refresh manually.',
                  requested: count,
                  created: createdRecords.length,
                })
              : t('record.createdRefreshFailedDesc', {
                  defaultValue: 'The records were created, but the current view failed to refresh. Please refresh manually.',
                }),
          })
          return
        }

        const { hiddenCount } = await handleCreatedRecordsVisibility(createdRecords as TableUiRecord[])
        if (isPartialCreate) {
          toast({
            title: t('record.createdPartialTitle', { defaultValue: 'Some records created' }),
            description: t('record.createdPartialDesc', {
              defaultValue: 'Requested {{requested}} rows; {{created}} rows were created.',
              requested: count,
              created: createdRecords.length,
            }),
          })
          return
        }
        if (hiddenCount === 0) {
          toast({
            title: t('record.createdTitle', { defaultValue: 'Record created' }),
          })
        }
      } catch (error) {
        console.error('[TablePaneView] Insert record failed:', error)
        toast({
          title: t('toolbar.recordCreateFailed', { defaultValue: 'Failed to create record' }),
          variant: 'destructive',
        })
      }
    },
    [buildCreatePlanFromDisplayRowIndex, bulkCreateRecords, displayTable, handleCreatedRecordsVisibility, refreshCurrentView, t],
  )

  const handleRowAppend = useCallback(
    (context?: {
      rowIndex?: number
      rowData?: TableGridRow | null
      groupPath?: string | null
      groupValues?: Record<string, unknown>
    }) => {
      const createPlan =
        typeof context?.rowIndex === 'number'
          ? buildCreatePlanFromDisplayRowIndex(context.rowIndex)
          : undefined
      const addRowContext: DataGridAddRowContext | undefined =
        context?.groupPath || context?.groupValues || createPlan?.orderContext
          ? {
              group_path: context?.groupPath ?? undefined,
              group_values: context?.groupValues,
              ...(createPlan?.orderContext ? { order_context: createPlan.orderContext } : {}),
            }
          : undefined
      handleAddRowClick(addRowContext)
    },
    [buildCreatePlanFromDisplayRowIndex, handleAddRowClick],
  )

  const handleRowExpand = useCallback((row: TableGridRow) => {
    setRecordCommentIntent(null)
    const rowType = (row as Record<string, unknown>).__rowType
    if (rowType === 'group_header') {
      const groupId = String(row.__groupPath ?? row.id ?? '')
      if (currentViewId && groupId) toggleGroupCollapse(currentViewId, groupId)
      return
    }
    if (rowType === 'add' || rowType === 'group_add') return
    if (rowType === 'draft') {
      const requestId = ++rowExpandRequestRef.current
      void (async () => {
        const commitDraft = handleCommitDraftRow as unknown as () => Promise<{ id?: unknown } | null>
        const created = await commitDraft()
        if (requestId !== rowExpandRequestRef.current) return
        const createdId = created?.id ? String(created.id) : ''
        if (createdId) setEditingRecordId(createdId)
      })()
      return
    }
    rowExpandRequestRef.current += 1
    const recordId = String(row.id ?? '')
    if (recordId) setEditingRecordId(recordId)
  }, [currentViewId, handleCommitDraftRow, toggleGroupCollapse])

  const handleOpenMobileRecord = useCallback((recordId: string) => {
    setRecordCommentIntent(null)
    setEditingRecordId(recordId)
  }, [])

  const handleToggleMobileGroup = useCallback((groupId: string) => {
    if (!currentViewId) return
    toggleGroupCollapse(currentViewId, groupId)
  }, [currentViewId, toggleGroupCollapse])

  const handleOpenMobileCreate = useCallback((groupValues?: Record<string, unknown>) => {
    if (effectiveReadonly) return
    setCreatingRecordInitialValues(
      resolveMobileCreateInitialValues({
        currentView: uiCurrentView,
        fields,
        groupValues,
      }) ?? {},
    )
  }, [effectiveReadonly, fields, uiCurrentView])

  const syncAttachmentFieldToGrid = useCallback((payload: {
    recordId: string
    fieldId: string
    fieldName: string
    value: AttachmentReference[]
  }) => {
    const patch = { ...payload }
    setAttachmentGridPatches((current) => {
      const next = new Map(current)
      next.set(getAttachmentFieldGridPatchKey(patch), patch)
      return next
    })

    const current = rawViewStoreApi.getState().currentViewRecords
    if (current?.records?.length) {
      const nextRecords = current.records.map(record =>
        record.id === payload.recordId ? patchAttachmentFieldRecord(record as TableUiRecord, patch) : record,
      )
      rawViewStoreApi.setState({
        currentViewRecords: {
          ...current,
          records: nextRecords,
        },
      })
    }

    const fieldHex = collabBridge.collab.fieldsMeta.find(field => field.id === payload.fieldId)?.id_hex
      ?? payload.fieldId.replace(/-/g, '')
    if (collabActive && fieldHex) {
      collabBridge.collab.setCellValue(payload.recordId, fieldHex, payload.value)
    }
  }, [collabActive, collabBridge.collab, rawViewStoreApi])

  const handleGridAttachmentUpload = useCallback<TableGridAttachmentUploadHandler<TableGridRow>>(
    async ({ rowData, fieldId, files, onProgress }) => {
      const recordId = String(rowData?.id ?? rowData?.row_id ?? '')
      const rowType = (rowData as Record<string, unknown> | undefined)?.__rowType
      const isDraftLike =
        !recordId ||
        recordId === DRAFT_ROW_ID ||
        rowType === 'draft' ||
        rowType === 'add' ||
        rowType === 'group_add'
      if (!displayTable?.id) {
        throw new Error(t('attachments.errors.uploadFailed', { defaultValue: '附件上传失败' }))
      }
      if (!fieldId) {
        throw new Error(t('attachments.apiErrors.uploadTaskMissingField', { defaultValue: '上传任务缺少字段信息' }))
      }

      const uploadFiles = prepareGridAttachmentUploadFiles(files ?? [])
      if (uploadFiles.length === 0) return []

      // 草稿行省略 record_id（后端 orphan + 提交时 sync 认领），对齐 Electron 网格。
      const taskResponse = await AttachmentApiService.createUploadTask({
        table_id: displayTable.id,
        field_id: fieldId,
        ...(isDraftLike ? {} : { record_id: recordId }),
        files: uploadFiles.map(({ metadata }) => metadata),
      })

      const responseFilesMap = new Map<string, AttachmentUploadFileOut>()
      taskResponse.files.forEach(file => responseFilesMap.set(file.file_name, file))

      const progressItems: GridAttachmentUploadProgressState[] = uploadFiles.map(({ file, metadata }) => {
        const responseFile = responseFilesMap.get(metadata.file_name)
        if (!responseFile) {
          throw new Error(t('attachments.apiErrors.uploadTaskMissingItem', {
            defaultValue: '上传任务缺少文件 {{name}}',
            name: metadata.file_name,
          }))
        }
        return {
          uploadItemId: responseFile.upload_item_id,
          file,
          fileName: metadata.file_name,
          status: 'pending',
          progress: 0,
        }
      })

      const emitProgress = () => onProgress?.(mapGridAttachmentProgressItems(progressItems))
      emitProgress()

      const references: AttachmentReference[] = []
      try {
        for (let index = 0; index < uploadFiles.length; index += 1) {
          const upload = uploadFiles[index]
          const responseFile = responseFilesMap.get(upload.metadata.file_name)
          const progressItem = progressItems[index]
          if (!responseFile) continue

          progressItem.status = 'uploading'
          emitProgress()

          const totalParts = Math.max(1, responseFile.total_parts)
          const chunkSize = responseFile.chunk_size || upload.file.size
          for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
            const partNumber = partIndex + 1
            const start = partIndex * chunkSize
            const end = Math.min(upload.file.size, start + chunkSize)
            const chunk = upload.file.slice(start, end)
            const presignedUrl = getGridAttachmentPartPresignedUrl(responseFile, partNumber)

            await AttachmentApiService.uploadPart(
              taskResponse.task_id,
              responseFile.upload_item_id,
              partNumber,
              chunk,
              {
                presignedUrl,
                contentType: upload.file.type || 'application/octet-stream',
              },
            )

            progressItem.progress = Math.min(1, partNumber / totalParts)
            emitProgress()
          }

          const completed = await AttachmentApiService.completeUpload(
            taskResponse.task_id,
            responseFile.upload_item_id,
          )
          progressItem.status = 'completed'
          progressItem.progress = 1
          emitProgress()
          references.push(completed.reference)
        }

        return references
      } catch (error) {
        progressItems.forEach(item => {
          if (item.status !== 'completed') {
            item.status = 'error'
            item.error = error instanceof Error ? error.message : String(error)
          }
        })
        emitProgress()
        throw error
      }
    },
    [displayTable?.id, t],
  )

  const handleRecordSaved = useCallback(() => {
    void refreshCurrentView()
  }, [refreshCurrentView])

  const fetchRecordForDetail = useCallback(async (recordId: string) => {
    try {
      const rec = await RecordApiService.getRecord(recordId, { field_key_type: 'name' })
      if (!rec) return null
      const source = rec.data ?? (rec as Record<string, unknown>)
      const data: Record<string, unknown> = {}
      for (const f of fields) {
        if (f.name in source) {
          data[f.name] = source[f.name]
        }
      }
      return { id: rec.id, data }
    } catch {
      return null
    }
  }, [fields])

  const canvasOverlayLabels = useMemo(
    () => ({
      ...buildCanvasMenuLabels((key, opts) => tl(key, opts)),
      editorLabels: {
        selectSearchPlaceholder: String(
          t('grid.editorSelectSearchPlaceholder', { defaultValue: 'Find or create options' }),
        ),
        selectSearchPlaceholderEmpty: String(
          t('grid.editorSelectSearchPlaceholderEmpty', {
            defaultValue: 'Type to create an option',
          }),
        ),
        selectNoResults: String(
          t('grid.editorSelectNoResults', { defaultValue: 'No results' }),
        ),
        selectEmptyHint: String(
          t('grid.editorSelectEmptyHint', {
            defaultValue: 'No options yet. Type to create one.',
          }),
        ),
        selectAddOption: String(
          t('grid.editorSelectAddOption', { defaultValue: 'Create' }),
        ),
        selectDoneLabel: String(
          t('grid.editorSelectDoneLabel', { defaultValue: 'Done' }),
        ),
      },
    }),
    [tl, t, i18n.language],
  )

  const hasFields = fields.length > 0
  const hasVisibleColumns = gridOrderedFields.length > 0

  // ── Error state ──
  if (fetchFailed && !displayTable) {
    return (
      <TableErrorView
        title={t('pane.loadFailed', { defaultValue: 'Failed to open table' })}
        description={t('pane.loadFailedDesc', { defaultValue: 'Unable to load this table. Please check permissions or try again later.' })}
        retryLabel={t('pane.retry', { defaultValue: 'Retry' })}
        onRetry={handleForceRetry}
        onClose={() => void 0}
      />
    )
  }

  // ── Loading state ──
  if (showPaneLoading) {
    return (
      <TableLoadingView
        message={t('pane.loading', { defaultValue: 'Loading table...' })}
        timedOut={loadingTimedOut}
        timeoutMessage={t('pane.loadingTooLong', { defaultValue: 'Loading is taking longer than expected. Please check your network or retry.' })}
        retryLabel={t('pane.retry', { defaultValue: 'Retry' })}
        onRetry={handleForceRetry}
      />
    )
  }

  // ── Main view ──
  const subtitle = uiCurrentView
    ? `${uiCurrentView.name} · ${tl(`view:types.${uiCurrentView.view_type}`, { defaultValue: uiCurrentView.view_type })}`
    : ''

  const handleRenameTable = async (name: string): Promise<boolean> => {
    if (!displayTable?.id) return false
    const updated = await updateTable(displayTable.id, { name })
    if (!updated) {
      toast({
        title: t('apiErrors.updateFailed', { defaultValue: '重命名表格失败' }),
        variant: 'destructive',
      })
      return false
    }
    return true
  }

  return (
    <div ref={undoRedoContainerRef} tabIndex={-1} className="relative flex h-full flex-col overflow-hidden outline-none">
      <TablePaneHeader
        tableName={displayTable?.name}
        tableDescription={displayTable?.description}
        tableIcon={displayTable?.icon || '📄'}
        subtitle={subtitle}
        backPath={buildHomePath()}
        backTitle={t('pane.backHome', { defaultValue: 'Back to home' })}
        isPersonalViewEnabled={isPersonalViewEnabled}
        showPersonalViewToggle={Boolean(displayTable?.id && currentViewId)}
        personalViewLabel={t('pane.personalView')}
        personalViewEnableLabel={t('pane.personalViewEnable')}
        personalViewDisableLabel={t('pane.personalViewDisable')}
        renameTableLabel={t('toolbar.tableNameTitle', { defaultValue: '重命名表格' })}
        onTogglePersonalView={handleTogglePersonalView}
        onRenameTable={handleRenameTable}
        isReadonly={effectiveReadonly}
        isEmbedded={isEmbedded}
      />

      <div className={isPhonePresentation ? 'shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : undefined}>
        <WebViewSwitcher isReadonly={effectiveReadonly} />
      </div>

      <div className="shrink-0 border-b border-border/50 bg-background">
        <GridToolbarMainBar
          fields={fields.filter(f => !f.is_hidden)}
          hasSelectedRows={selectedRows.length > 0}
          tableFontStyle={tableFontStyle}
          tableFontWeight={tableFontWeight}
          tableFontSize={tableFontSize}
          onFontStyleChange={setTableFontStyle}
          onFontWeightChange={setTableFontWeight}
          onFontSizeChange={(v) => setTableFontSize(Number(v))}
          onShowFieldManagement={() => setFieldMgmtOpen(true)}
          onShowExportDialog={() => setExportDialogOpen(true)}
          onShowImportDialog={() => setImportDialogOpen(true)}
          searchQuery={searchQuery}
          searchScope={searchScope}
          searchSelectedFieldIds={searchSelectedFieldIds}
          searchHideNotMatchRows={searchHideNotMatchRows}
          searchMatchCount={searchMatches.length}
          searchCurrentMatchIndex={searchCurrentMatchIdx}
          searchCurrentField={null}
          searchIndexSupported={false}
          searchIndexEnabled={false}
          searchIndexAbnormalCount={0}
          searchIndexLoading={false}
          searchIndexActionLoading={false}
          totalRowsCount={total}
          translate={(key, options) => tl(key, options as Record<string, unknown>)}
          onSearch={setSearchQuery}
          onSearchScopeChange={setSearchScope}
          onSearchSelectedFieldIdsChange={setSearchSelectedFieldIds}
          onSearchHideNotMatchRowsChange={setSearchHideNotMatchRows}
          onSearchNavigateNext={handleSearchNavigateNext}
          onSearchNavigatePrev={handleSearchNavigatePrev}
          onAddRow={handleAddRowClick}
          onAddField={() => openCreateFieldDialog(null)}
          canUndo={canUndo}
          canRedo={canRedo}
          isUndoing={isUndoing}
          isRedoing={isRedoing}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onOpenTableHistory={handleOpenTableHistory}
          onRefresh={() => void handleRefreshView()}
          onDeleteSelected={() => {
            if (selectedRows.length === 0) return
            const ids = selectedRows.map(row => String(row.id)).filter(Boolean)
            if (ids.length === 0) return
            requestDeleteRecords(ids)
          }}
          onOpenDetailEdit={selectedRows.length === 1 && canOpenRecordDetail ? () => {
            const id = String(selectedRows[0].id ?? '')
            if (id) setEditingRecordId(id)
          } : undefined}
          canDetailEdit={selectedRows.length === 1}
          isReadonly={effectiveReadonly}
          showCreateActions={isGridView && !isPhonePresentation && !useMobileRecordSurface}
          onShare={() => setShowShareDialog(true)}
          canShare={canManageShare}
          filterGroupBar={
            <WebViewFilterGroupBar
              fields={fields}
              currentViewOverride={uiCurrentView}
              className="min-w-0"
              controlsRef={viewPopoverRef}
              tableFontStyle={tableFontStyle}
              tableFontWeight={tableFontWeight}
              tableFontSize={tableFontSize}
              onFontStyleChange={setTableFontStyle}
              onFontWeightChange={setTableFontWeight}
              onFontSizeChange={setTableFontSize}
              isPersonalViewEnabled={isPersonalViewEnabled}
              isReadonly={effectiveReadonly}
              tableId={displayTable?.id}
              updateViewOverride={effectiveReadonly ? undefined : updateViewForRuntime}
              saveDraftOverride={effectiveReadonly ? undefined : saveDraftForRuntime}
              skipSortRecordsFetch={collabProjectsViewRecords}
            />
          }
        />
      </div>

      {recordSurfacePolicy.showSwitcher ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border/50 bg-background px-3 py-2">
          <div className="text-body text-muted-foreground">
            {t('toolbar.mobileRecordCount', {
              defaultValue: '{{count}} 条记录',
              count: total,
            })}
          </div>
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={recordSurfacePolicy.surface === 'cards' ? 'min-h-11 gap-1.5 bg-background px-3 text-foreground shadow-sm' : 'min-h-11 gap-1.5 px-3 text-muted-foreground'}
              onClick={() => selectRecordSurface('cards')}
              aria-pressed={recordSurfacePolicy.surface === 'cards'}
            >
              <LayoutList className="size-4" />
              {t('toolbar.mobileCards', { defaultValue: '卡片' })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={recordSurfacePolicy.surface === 'grid' ? 'min-h-11 gap-1.5 bg-background px-3 text-foreground shadow-sm' : 'min-h-11 gap-1.5 px-3 text-muted-foreground'}
              onClick={() => selectRecordSurface('grid')}
              aria-pressed={recordSurfacePolicy.surface === 'grid'}
            >
              <Table2 className="size-4" />
              {t('toolbar.mobileGrid', { defaultValue: '表格' })}
            </Button>
          </div>
        </div>
      ) : null}

      <div
        ref={gridContainer.ref}
        className="relative flex-1 overflow-hidden"
        data-table-record-surface={isGridView ? recordSurfacePolicy.surface : 'alternate-view'}
        data-table-presentation={isPhonePresentation ? 'phone' : isTabletPresentation ? 'tablet' : 'desktop'}
      >
        {showCollabDisconnected && (
          <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-center gap-2 bg-warning/90 px-3 py-1.5 text-body font-medium text-warning-foreground shadow-sm dark:bg-warning/90">
            <WifiOff className="size-3.5 shrink-0" />
            <span>{tl('table:collab.disconnected')}</span>
          </div>
        )}
        <GridErrorBoundary>
          {useMobileRecordSurface ? (
            <div className="relative h-full bg-muted/20">
              <div className="h-full overflow-y-auto overscroll-contain">
              {!dataset.gridLoading && !hasFields ? (
                <WebTableEmptyState
                  title={t('pane.emptyTitle')}
                  description={t('pane.emptyDesc')}
                  primaryLabel={t('toolbar.addField')}
                  secondaryLabel={t('toolbar.refresh')}
                  onPrimaryClick={effectiveReadonly ? undefined : () => openCreateFieldDialog(null)}
                  onSecondaryClick={() => void handleRefreshView()}
                />
              ) : !dataset.gridLoading && !mobileHasVisibleFields ? (
                <WebTableEmptyState
                  title={t('pane.hiddenColumnsTitle')}
                  description={t('pane.hiddenColumnsDesc')}
                  primaryLabel={t('toolbar.refresh')}
                  secondaryLabel={t('toolbar.addField')}
                  onPrimaryClick={() => void handleRefreshView()}
                  onSecondaryClick={effectiveReadonly ? undefined : () => openCreateFieldDialog(null)}
                />
              ) : (
                <MobileTableCardList
                  rows={dataset.groupedRows ?? []}
                  records={uiRecords}
                  fields={fields}
                  currentView={uiCurrentView}
                  isLoading={dataset.gridLoading}
                  isReadonly={effectiveReadonly}
                  emptyTitle={t('pane.noDataTitle')}
                  emptyDescription={t('pane.noDataDesc')}
                  addRecordLabel={t('toolbar.addRecord')}
                  ungroupedLabel={tl('table:group.ungrouped')}
                  untitledRecordLabel={t('toolbar.mobileUntitledRecord', {
                    defaultValue: '未命名记录',
                  })}
                  currentSearchRecordId={mobileSearchRecordId ?? undefined}
                  userDisplayNameById={userDisplayNameById}
                  isTablet={isTabletPresentation}
                  onOpenRecord={handleOpenMobileRecord}
                  onToggleGroup={handleToggleMobileGroup}
                  onAddRecord={handleOpenMobileCreate}
                />
              )}
              </div>
              {!effectiveReadonly && hasFields && mobileHasVisibleFields ? (
                <button
                  type="button"
                  className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-20 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95"
                  onClick={() => handleOpenMobileCreate()}
                  aria-label={t('toolbar.addRecord')}
                  title={t('toolbar.addRecord')}
                >
                  <Plus className="size-7" />
                </button>
              ) : null}
            </div>
          ) : gridContainer.ready && isGridView ? (
            <>
              <CanvasGridAdapter
                theme={resolvedTheme}
                columns={columns}
                rows={rowsWithDraft}
                isLoading={isRecordsLoading}
                style={{ width: gridContainer.dims.w, height: gridContainer.dims.h }}
                singleClickEdit
                rowControls={[{ type: 'checkbox' }, { type: 'expand' }]}
                config={{
                  pagination: {
                    enabled: true,
                    page,
                    pageSize,
                    pageSizeOptions: PAGE_SIZE_OPTIONS,
                    total: dataset.totalCount,
                  },
                  canvasOverlay: {
                    ...canvasOverlayLabels,
                    ...(searchHitIndex ? { searchHitIndex } : {}),
                    prefilling: effectiveReadonly
                      ? { visible: false, isLoading: false }
                      : {
                          visible: Boolean(draftRowData),
                          isLoading: isDraftSubmitting,
                          title: String(t('grid.prefillingRowTitle', { defaultValue: 'New record' })),
                          cancelLabel: String(t('actions.cancelDraft', { defaultValue: 'Cancel' })),
                          onCancel: handleCancelDraftRow,
                          onClickOutside: () => { void handleCommitDraftRow() },
                        },
                  },
                }}
                onTableApiReady={handleTableApiReady}
                onPaginationChanged={handlePaginationChange}
                onCellValueChanged={effectiveReadonly ? undefined : handleCellValueChanged}
                onCellEditingStopped={effectiveReadonly ? undefined : draftCellEditingStopped}
                onAttachmentUpload={effectiveReadonly ? undefined : handleGridAttachmentUpload}
                onSelectOptionAdd={effectiveReadonly ? undefined : handleSelectOptionAdd}
                onColumnHeaderContextMenu={effectiveReadonly ? undefined : handleColumnHeaderContextMenu}
                onColumnMoved={effectiveReadonly ? undefined : handleColumnMoved}
                onColumnResized={effectiveReadonly ? undefined : handleColumnResized}
                onColumnAppend={effectiveReadonly ? undefined : handleColumnAppend}
                onFreezeStateChange={effectiveReadonly ? undefined : handleFreezeStateChange}
                onRowMoved={effectiveReadonly ? undefined : handleRowMoved}
                onRowAppend={effectiveReadonly ? undefined : handleRowAppend}
                onDeleteRecords={effectiveReadonly ? undefined : requestDeleteRecords}
                onInsertRecord={effectiveReadonly ? undefined : handleInsertRecord}
                onRowExpand={canOpenRecordDetail ? handleRowExpand : undefined}
                onLinkCellExpand={effectiveReadonly ? undefined : (recordId, fieldId) => {
                  setLinkEditorState({ recordId, fieldId })
                }}
                organizationMembers={organizationMembers}
                userDisplayNameById={userDisplayNameById}
                onSelectionChanged={(rows: TableGridRow[]) => setSelectedRows(rows)}
                onClipboardCopy={handleClipboardCopy}
                onClipboardPaste={effectiveReadonly ? undefined : handleClipboardPaste}
                emptyStateTitle={t('pane.emptyTitle')}
                emptyStateDescription={t('pane.emptyDesc')}
                noDataTitle={t('pane.noDataTitle')}
                noDataDescription={t('pane.noDataDesc')}
              />
              {!isRecordsLoading && !hasFields && (
                <WebTableEmptyState
                  title={t('pane.emptyTitle')}
                  description={t('pane.emptyDesc')}
                  primaryLabel={t('toolbar.addField')}
                  secondaryLabel={t('toolbar.refresh')}
                  onPrimaryClick={effectiveReadonly ? undefined : () => openCreateFieldDialog(null)}
                  onSecondaryClick={() => void handleRefreshView()}
                />
              )}
              {!isRecordsLoading && hasFields && !hasVisibleColumns && (
                <WebTableEmptyState
                  title={t('pane.hiddenColumnsTitle')}
                  description={t('pane.hiddenColumnsDesc')}
                  primaryLabel={t('toolbar.refresh')}
                  secondaryLabel={t('toolbar.addField')}
                  onPrimaryClick={() => void handleRefreshView()}
                  onSecondaryClick={effectiveReadonly ? undefined : () => openCreateFieldDialog(null)}
                />
              )}
              {/* ：有字段且有可见列、仅无记录时不再盖蒙版——工具栏已有添加入口，空网格即可 */}
            </>
          ) : gridContainer.ready ? (
            <WebViewRenderer
              currentView={uiCurrentView}
              currentViewId={currentViewId}
              views={views}
              fields={fields}
              currentViewRecords={uiRecordsPayload}
            />
          ) : null}
        </GridErrorBoundary>
      </div>
      {isGridView && (
        <DataGridPaginationBar
          currentPage={paginationPage}
          pageSize={pageSize}
          totalCount={dataset.totalCount}
          isLoading={isRecordsLoading}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          summary={t('view:pagination.summary', {
            page: paginationPage,
            totalPages,
            total: dataset.totalCount,
            defaultValue: '{{page}} / {{totalPages}} · {{total}}',
          })}
          pageSizeLabel={t('view:pagination.pageSize', { defaultValue: 'Rows / page' })}
          prevLabel={t('view:pagination.prev', { defaultValue: 'Previous' })}
          nextLabel={t('view:pagination.next', { defaultValue: 'Next' })}
          onPaginationChange={handlePaginationChange}
        />
      )}

      <CreateFieldDialog
        open={fieldDialogOpen}
        onOpenChange={(open) => {
          setFieldDialogOpen(open)
          if (!open) setInsertFieldContext(null)
        }}
        onSubmit={handleCreateField}
        tableFields={fields.map(f => ({ id: f.id, name: f.name, field_type: f.field_type }))}
        availableTables={globalTables?.map(t => ({ id: t.id, name: t.name })) ?? []}
      />

      <EditFieldDialog
        open={editFieldDialogOpen}
        onOpenChange={(open) => {
          setEditFieldDialogOpen(open)
          if (!open) setEditingField(null)
        }}
        field={editingField}
        isSubmitting={editFieldSubmitting}
        tableFields={fields.map(f => ({ id: f.id, name: f.name, field_type: f.field_type }))}
        onCheckConversion={editingField ? (targetType) => fieldConversion.checkConversion(editingField.id, targetType) : undefined}
        onSubmit={async (data: EditFieldData) => {
          if (effectiveReadonly) return false
          if (!editingField || !displayTable) return

          const typeChanged = data.field_type && data.field_type !== editingField.field_type

          if (typeChanged) {
            if (isStructuralType(data.field_type!)) {
              toast({
                title: t('actions.typeSwitchBlocked', {
                  defaultValue: 'Link fields require creating a new field and migrating data. Direct type conversion is not supported.',
                }),
                variant: 'destructive',
              })
              return false
            }

            setPendingEditData(data)
            await startPreview(
              editingField.id,
              editingField.name,
              editingField.field_type,
              data.field_type!,
              data.options as Record<string, unknown> | undefined,
            )
            return false
          }

          setEditFieldSubmitting(true)
          try {
            await FieldApiService.updateField(editingField.id, {
              name: data.name,
              description: data.description,
              options: data.options as Record<string, unknown> | undefined,
              width: data.width,
              validation_rules: data.validation_rules,
              visibility_roles: data.visibility_roles,
            })
            await loadFields(displayTable.id)
            await refreshCurrentView()
            toast({ title: t('actions.fieldUpdated', { defaultValue: 'Field updated' }) })
          } catch (e: unknown) {
            const err = e as Record<string, unknown> | null
            const resp = (err?.response as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined
            const msg =
              (resp?.message as string | undefined) ||
              (resp?.error as string | undefined) ||
              (err instanceof Error ? err.message : String(e))
            console.error('[TablePaneView] updateField failed', e)
            toast({
              title: t('actions.fieldUpdateFailed', { defaultValue: 'Failed to update field' }),
              description: msg,
              variant: 'destructive',
            })
            throw e
          } finally {
            setEditFieldSubmitting(false)
          }
        }}
      />

      <ConversionPreviewDialog
        open={conversionPreviewOpen}
        onOpenChange={(open) => {
          setConversionPreviewOpen(open)
          if (!open) {
            setPendingEditData(null)
            setForceConversion(false)
          }
        }}
        preview={conversionPreview}
        isLoading={conversionPreviewLoading}
        isConverting={conversionConverting}
        force={forceConversion}
        onForceChange={setForceConversion}
        onCancel={() => {
          cancelPreview()
          setPendingEditData(null)
          setForceConversion(false)
        }}
        onConfirm={async () => {
          if (effectiveReadonly) return
          if (!editingField || !displayTable || !pendingEditData) return
          const result = await executeConversion(
            editingField.id,
            pendingEditData.field_type! as FieldType,
            pendingEditData.options as Record<string, unknown> | undefined,
            {
              name: pendingEditData.name,
              description: pendingEditData.description,
              width: pendingEditData.width,
              validation_rules: pendingEditData.validation_rules,
              visibility_roles: pendingEditData.visibility_roles,
            },
            { force: forceConversion },
          )
          if (result) {
            await loadFields(displayTable.id)
            await refreshCurrentView()
            const parts = formatResultParts(result, t)
            toast({
              title: t('actions.fieldUpdated', { defaultValue: 'Field updated' }),
              description: parts.length > 0 ? parts.join('；') : undefined,
            })
            setPendingEditData(null)
            setForceConversion(false)
            setEditFieldDialogOpen(false)
            setEditingField(null)
          }
        }}
      />

      <TablePaneDialogs
        pasteConfirmState={pasteConfirmState}
        onCancelPaste={cancelPaste}
        onConfirmPaste={() => { confirmPaste() }}
        pendingDeleteRecordIds={pendingDeleteRecordIds}
        onDismissDeleteRecords={() => setPendingDeleteRecordIds(null)}
        onConfirmDeleteRecords={() => void confirmDeleteRecords()}
        pendingDeleteField={pendingDeleteField}
        onDismissDeleteField={() => setPendingDeleteField(null)}
        onConfirmDeleteField={() => void confirmDeleteField()}
        showTableHistory={showTableHistory}
        tableHistoryLabel={tableHistoryLabel}
        tableHistoryOps={tableHistoryOps}
        tableHistoryTotal={tableHistoryTotal}
        isLoadingTableHistory={isLoadingTableHistory}
        onCloseTableHistory={handleCloseTableHistory}
        onLoadMoreTableHistory={handleLoadMoreTableHistory}
        translate={(key, options) => tl(key, options)}
      />

      {/* Record detail editor */}
      <WebRecordFormContainer
        open={editingRecordId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingRecordId(null)
            setRecordCommentIntent(null)
          }
        }}
        mode="edit"
        table={displayTable ?? null}
        fields={fields}
        record={editingRecord ? { id: editingRecord.id, data: editingRecord.data } : null}
        editingRecordId={editingRecordId}
        canNavigatePrev={canNavigatePrev}
        canNavigateNext={canNavigateNext}
        isReadonly={effectiveReadonly}
        modal={layout === 'compact' || isPhonePresentation}
        touchOptimized={isPhonePresentation || isTabletPresentation}
        sharedRecordComments={shareCollab?.canComment ? {
          shareId: shareCollab.shareId,
          password: shareCollab.password,
        } : shareCollab ? null : undefined}
        initialCommentsOpen={recordCommentIntent?.recordId === editingRecordId}
        targetCommentId={recordCommentIntent?.recordId === editingRecordId
          ? recordCommentIntent.commentId
          : undefined}
        subscribeCommentChanges={!shareCollab || shareCollab.canComment
          ? subscribeCommentChanges
          : undefined}
        onNavigatePrev={navigateToPrevRecord}
        onNavigateNext={navigateToNextRecord}
        onSaved={handleRecordSaved}
        onAttachmentFieldCommitted={effectiveReadonly ? undefined : syncAttachmentFieldToGrid}
        createRecord={createRecord}
        updateRecord={(id, req) => updateRecord(id, req)}
        fetchRecord={fetchRecordForDetail}
      />

      <WebRecordFormContainer
        open={creatingRecordInitialValues !== null}
        onOpenChange={(open) => {
          if (!open) setCreatingRecordInitialValues(null)
        }}
        mode="create"
        table={displayTable ?? null}
        fields={fields}
        initialValues={creatingRecordInitialValues ?? undefined}
        isReadonly={effectiveReadonly}
        modal={layout === 'compact' || isPhonePresentation}
        touchOptimized={isPhonePresentation || isTabletPresentation}
        onSaved={handleRecordSaved}
        createRecord={createRecord}
        updateRecord={(id, req) => updateRecord(id, req)}
      />

      {linkEditorState && displayTable && (() => {
        const linkField = fields.find(item => item.id === linkEditorState.fieldId)
        const linkRecord = uiRecords.find(item => item.id === linkEditorState.recordId)
        if (!linkField || linkField.field_type !== 'link') return null
        const foreignTableId = String(linkField.options?.foreignTableId ?? '')
        return (
          <WebLinkCellEditor
            open
            onClose={() => setLinkEditorState(null)}
            tableId={displayTable.id}
            recordId={linkEditorState.recordId}
            field={linkField}
            currentValue={
              linkRecord?.fields?.[linkField.id]
              ?? linkRecord?.data?.[linkField.name]
              ?? linkRecord?.data?.[linkField.id]
            }
            foreignTableName={globalTables.find(item => item.id === foreignTableId)?.name}
            onSave={async (value) => {
              const isSingle = ['OneOne', 'ManyOne'].includes(
                String(linkField.options?.relationship ?? 'ManyMany'),
              )
              const cellValue = isSingle ? value[0] ?? null : value
              await updateRecord(linkEditorState.recordId, {
                data: { [linkField.id]: cellValue },
                fields: { [linkField.id]: cellValue },
                fieldKeyType: 'id',
              })
              await refreshCurrentView()
            }}
          />
        )
      })()}

      <FieldManagementPanel
        open={fieldMgmtOpen}
        onOpenChange={setFieldMgmtOpen}
        fields={fields as Field[]}
        currentView={uiCurrentView}
        updateView={updateViewWhenWritable}
      />

      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        tableId={displayTable?.id ?? ''}
        tableName={displayTable?.name ?? 'export'}
        viewId={currentViewId ?? undefined}
        fields={fields as Field[]}
      />

      <ImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        tableId={displayTable?.id ?? ''}
        tableName={displayTable?.name ?? 'table'}
        fields={fields as Field[]}
        onImportComplete={handleImportComplete}
      />

      {showShareDialog && displayTable && (
        <ShareDialog
          open={showShareDialog}
          onOpenChange={setShowShareDialog}
          resourceType="table"
          resourceId={displayTable.id}
          resourceTitle={displayTable.name ?? ''}
          organizationId={resolveTableOrganizationId(
            displayTable.organization_id,
            selectedOrganizationId,
          )}
          shareUrlPrefix={buildPublicShareUrlPrefix('table')}
          canManage={canManageShare}
        />
      )}

      {/* Wave 4 F6: 被移出表格后的全屏遮罩（ 有实时权限时不盖） */}
      {showRemovedOverlay && (
        <RemovedFromResourceOverlay
          resourceTitle={downgrade.resourceTitle || displayTable?.name || ''}
          action={downgrade.removalAction || 'removed'}
          onReturn={handleReturnFromRemoved}
          t={(key: string, opts?: Record<string, unknown>) => t(key, { ns: 'common', ...(opts ?? {}) }) as string}
        />
      )}

    </div>
  )
}

export interface TablePaneViewProps {
  tableId: string
  disableCollab?: boolean
  shareCollab?: TablePaneInnerProps['shareCollab']
}

export const TablePaneView: React.FC<TablePaneViewProps> = ({ tableId, disableCollab = false, shareCollab }) => {
  const stores = useMemo(() => {
    const ts = getOrCreateTableStore(tableId)
    const vs = getOrCreateViewStore(tableId)
    const rs = getOrCreateRecordStore(tableId, vs)
    return { ts, vs, rs }
  }, [tableId])

  useEffect(() => {
    retainStoreForTable(tableId)
    return () => releaseStoreForTable(tableId)
  }, [tableId])

  return (
    <TableStoreProvider store={stores.ts}>
      <ViewStoreProvider store={stores.vs}>
        <RecordStoreProvider store={stores.rs}>
          <TablePaneInner tableId={tableId} disableCollab={disableCollab} shareCollab={shareCollab} />
        </RecordStoreProvider>
      </ViewStoreProvider>
    </TableStoreProvider>
  )
}

TablePaneView.displayName = 'TablePaneView'
