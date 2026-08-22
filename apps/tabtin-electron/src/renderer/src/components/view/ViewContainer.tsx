import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  cn,
  useLoadingTimeout,
  OverlayContainerProvider,
} from '@tabtin/smartsheet-ui'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { RefreshCw } from 'lucide-react'
import { useViewStore } from '@stores/useViewStore'
import { useTableStore } from '@stores/useTableStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useIsContextTabActive } from '@/hooks/useIsContextTabActive'
import { ViewToolbar } from '@components/view/ViewToolbar'
import { useTranslation } from 'react-i18next'
import { useViewContainerState } from './controller/useViewContainerState'
import { FlashcardView } from './FlashcardView'
import { useUndoRedo } from '@components/table/controller/useUndoRedo'
import { UndoRedoProvider, type UndoRedoContextValue } from './UndoRedoContext'
import { TablePreviewSkeleton } from '@components/common/ListSkeletons'
import { ViewLoadingOverlay } from './ViewShared'
import { FormToolBar, type FormMode } from './form/FormToolBar'
import { TableHistoryModal } from '@components/table/TableHistoryModal'
import { FieldBatchUndoConflictDialog } from '@components/table/FieldBatchUndoConflictDialog'
import { TableCollabProvider, useTableCollab } from '@components/table/TableCollabContext'
import { TableReadonlyProvider, useTableReadonly } from '@components/table/TableReadonlyContext'
import { type FieldRestoreNotSupportedDetail } from '@tabtin/table-ui'
import { shouldForceReconnectAfterTableRestore } from './tableRestoreSync'
import { buildTableHistoryRefreshKey } from './tableHistoryRefresh'
import { RecordApiService, type TableRecord } from '@tabtin/table-core'
import { RecordFormContainer } from '@components/record/RecordFormContainer'
import {
  parseRecordCommentNotificationIntent,
  selectRecordCommentNotificationIntent,
} from './recordCommentNotificationIntent'
import { ViewRecordCommentCountsProvider } from './RecordCommentCountBadge'

/** 视图数据加载超时阈值（毫秒） — 大表或慢网络场景下 3s 过短，放宽到 6s */
const VIEW_LOADING_TIMEOUT_MS = 6_000
const GridViewHost = lazy(() => import('./GridViewHost'))
const KanbanView = lazy(() => import('./KanbanView'))
const CalendarView = lazy(() => import('./CalendarView'))
const GalleryView = lazy(() => import('./GalleryView'))
const FormView = lazy(() => import('./FormView'))
const COMMENT_BADGE_VIEW_TYPES = new Set(['kanban', 'calendar', 'gallery', 'flashcard'])

const GridViewFallback: React.FC = () => (
  <div className="flex flex-1 overflow-hidden">
    <TablePreviewSkeleton />
  </div>
)

const renderGridView = (embedded?: boolean, onOpenTableHistory?: () => void) => (
  <Suspense fallback={<GridViewFallback />}>
    <GridViewHost embedded={embedded} onOpenTableHistory={onOpenTableHistory} />
  </Suspense>
)

// ---------------------------------------------------------------------------
// ViewContainer (router)
// ---------------------------------------------------------------------------

interface ViewContainerProps {
  className?: string
  /** When true, native toolbars (GridToolbar / ViewToolbar) are hidden — the embed header provides its own controls. */
  embedded?: boolean
  /** 公开分享场景的 shareId */
  shareId?: string
  /** 密码保护表单的密码 */
  formPassword?: string
  /**
   * TablePaneView 在外层已挂 TableCollabProvider + TableReadonlyProvider 时设为 false，
   * 避免重复连接协作栈；Embed 等其它入口保持默认 true。
   */
  withProviders?: boolean
  /** Parent TabDoc context required when this table is rendered as an embed. */
  parentDocumentId?: string | null
  /** 当前展示位置的本地身份；同一表多个 surface 共享资源运行时但独立仲裁焦点。 */
  surfaceId?: string
  /** 父宿主当前允许该 surface 接管键盘与 awareness。 */
  isSurfaceActive?: boolean
}

const ViewContainerInner: React.FC<ViewContainerProps> = React.memo(({ className, embedded, shareId, formPassword }) => {
  const { t } = useTranslation(['view', 'table'])
  const views = useViewStore(state => state.views)
  const currentViewId = useViewStore(state => state.currentViewId)
  const currentViewRecords = useViewStore(state => state.currentViewRecords)
  const isRecordsLoading = useViewStore(state => state.isRecordsLoading)
  const refreshCurrentView = useViewStore(state => state.refreshCurrentView)
  const { handleForceReconnect, collabBridge } = useTableCollab()
  const handleTableRestoreSuccess = useCallback(async (info?: { syncMode?: string }) => {
    await refreshCurrentView()
    // 服务端 resync 已把恢复结果广播到当前 Y.Doc；此时再次重连会让空的重连快照
    // 把刚刷新的行从本地 store 移除。仅 force-close / 失败 / 旧版响应需要重连兜底。
    if (shouldForceReconnectAfterTableRestore(info?.syncMode)) {
      handleForceReconnect()
    }
  }, [refreshCurrentView, handleForceReconnect])
  const loadViews = useViewStore(state => state.loadViews)
  const selectedTable = useTableStore(state => state.selectedTable)
  const fields = useTableStore(state => state.fields)
  const loadFields = useTableStore(state => state.loadFields)

  const tableTabKey = selectedTable?.id ? `tabdata:${selectedTable.id}` : null
  const isActiveTab = useIsContextTabActive(tableTabKey)
  const commentNotificationIntentRaw = useSpaceContextTabsStore(state => (
    selectRecordCommentNotificationIntent(state.itemsBySpace, tableTabKey)
  ))
  const commentNotificationIntent = useMemo(
    () => parseRecordCommentNotificationIntent(commentNotificationIntentRaw),
    [commentNotificationIntentRaw],
  )
  const [notificationRecord, setNotificationRecord] = useState<TableRecord | null>(null)
  const [notificationCommentId, setNotificationCommentId] = useState<string | undefined>()

  useEffect(() => {
    if (!commentNotificationIntent || !selectedTable?.id || embedded || !isActiveTab) {
      return undefined
    }
    // 新通知开始解析时先撤掉旧抽屉；消费 tab meta 后 intent 会变空，
    // 但已解析的抽屉必须继续保留到用户主动关闭。
    setNotificationRecord(null)
    setNotificationCommentId(undefined)
    let active = true

    void RecordApiService.getRecord(commentNotificationIntent.recordId)
      .then((record) => {
        if (!active) return
        if (record.table_id !== selectedTable.id) {
          throw new Error('通知中的记录不属于当前多维表')
        }
        setNotificationRecord(record)
        setNotificationCommentId(commentNotificationIntent.commentId)
      })
      .catch((error) => {
        if (!active) return
        toast({
          variant: 'destructive',
          title: t('comments.openFailed', { defaultValue: '无法打开评论' }),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        if (!active || !tableTabKey) return
        useSpaceContextTabsStore.getState().setItemMeta(
          commentNotificationIntent.scopeKey,
          tableTabKey,
          {
            openComments: false,
            recordId: undefined,
            commentId: undefined,
            notificationIntentKey: undefined,
          },
        )
      })

    return () => {
      active = false
    }
  }, [commentNotificationIntent, embedded, isActiveTab, selectedTable?.id, t, tableTabKey])

  useEffect(() => {
    setNotificationRecord(null)
    setNotificationCommentId(undefined)
  }, [embedded, selectedTable?.id])

  const openRecordCommentsSeqRef = useRef(0)

  const handleOpenRecordComments = useCallback((recordId: string) => {
    const tableId = selectedTable?.id
    if (!recordId || !tableId) return
    const seq = openRecordCommentsSeqRef.current + 1
    openRecordCommentsSeqRef.current = seq

    setNotificationRecord(null)
    setNotificationCommentId(undefined)

    void RecordApiService.getRecord(recordId)
      .then((record) => {
        if (seq !== openRecordCommentsSeqRef.current) return
        if (record.table_id !== tableId) {
          throw new Error('记录不属于当前多维表')
        }
        setNotificationRecord(record)
      })
      .catch((error) => {
        if (seq !== openRecordCommentsSeqRef.current) return
        toast({
          variant: 'destructive',
          title: t('comments.openFailed', { defaultValue: '无法打开评论' }),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }, [selectedTable?.id, t])

  const { currentView, shouldShowFallbackGrid, shouldShowLoading } = useViewContainerState({
    views,
    currentViewId,
    currentViewRecords,
    isRecordsLoading,
  })
  const tableHistoryRefreshKey = useMemo(
    () => buildTableHistoryRefreshKey(currentViewRecords),
    [currentViewRecords],
  )

  const paneContainerRef = useRef<HTMLDivElement>(null)
  const [formMode, setFormMode] = useState<FormMode>('edit')
  const [showTableHistoryModal, setShowTableHistoryModal] = useState(false)
  const handleOpenTableHistory = useCallback(() => setShowTableHistoryModal(true), [])

  // ── W1.4 / C1:字段批量恢复 409 (FIELD_RESTORE_NOT_SUPPORTED) 提示 ──
  // tableUndo 涉及复杂字段时弹出分类对话框,提供「打开版本历史」快捷入口
  const [fieldRestoreConflict, setFieldRestoreConflict] =
    useState<FieldRestoreNotSupportedDetail | null>(null)
  const handleFieldRestoreNotSupported = useCallback(
    (detail: FieldRestoreNotSupportedDetail) => setFieldRestoreConflict(detail),
    [],
  )

  const { isTableReadonly: tableReadonlyFromContext } = useTableReadonly()
  // 视图锁定只拦配置，不把整表（含看板/日历等记录编辑）标成只读
  const isTableReadonly = tableReadonlyFromContext

  // ── 移动端检测：移动端强制预览模式 ──
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)')
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const hideEditTab = isTableReadonly || isMobile
  const effectiveFormMode: FormMode = hideEditTab ? 'fill' : formMode

  const translate = useCallback(
    (key: string, opts?: Record<string, unknown>) => String(t(key as any, opts as any)),
    [t],
  )

  const refreshViewMetadataAfterUndoRedo = useCallback(async () => {
    if (selectedTable?.id) {
      await loadFields(selectedTable.id)
      await loadViews(selectedTable.id)
    }
  }, [loadFields, loadViews, selectedTable?.id])

  const {
    handleUndo,
    handleRedo,
    canUndo,
    canRedo,
    isUndoing,
    isRedoing,
    refreshStacks,
    recordBackendUndoable,
  } = useUndoRedo({
    selectedTableId: selectedTable?.id ?? null,
    selectedTableName: selectedTable?.name ?? null,
    refreshRecords: refreshCurrentView,
    refreshViews: refreshViewMetadataAfterUndoRedo,
    translate,
    containerRef: paneContainerRef,
    isActive: embedded || isActiveTab,
    collabUndoRedo: {
      isOnline: collabBridge.collab.isOnline && !collabBridge.collab.isFallback,
      canUndo: collabBridge.collab.collabCanUndo,
      canRedo: collabBridge.collab.collabCanRedo,
      undoFn: collabBridge.collab.collabUndo,
      redoFn: collabBridge.collab.collabRedo,
      subscribeStackEvent: collabBridge.collab.onUndoManagerEvent,
    },
    onFieldRestoreNotSupported: handleFieldRestoreNotSupported,
  })

  const undoRedoCtx = useMemo<UndoRedoContextValue>(
    () => ({
      handleUndo: isTableReadonly ? async () => {} : handleUndo,
      handleRedo: isTableReadonly ? async () => {} : handleRedo,
      canUndo: isTableReadonly ? false : canUndo,
      canRedo: isTableReadonly ? false : canRedo,
      isUndoing,
      isRedoing,
      refreshStacks,
      recordBackendUndoable,
    }),
    [
      handleUndo,
      handleRedo,
      canUndo,
      canRedo,
      isTableReadonly,
      isUndoing,
      isRedoing,
      refreshStacks,
      recordBackendUndoable,
    ],
  )

  // ⭐ 加载超时兜底：超过阈值后显示刷新按钮
  const { timedOut: viewLoadingTimedOut, retry: handleViewRetry } = useLoadingTimeout(
    shouldShowLoading,
    { timeoutMs: VIEW_LOADING_TIMEOUT_MS, onRetry: () => void refreshCurrentView() },
  )

  if (shouldShowLoading) {
    return (
      <div className={cn('flex flex-1 flex-col overflow-hidden', className)}>
        <div className="flex-1 overflow-hidden">
          <TablePreviewSkeleton />
        </div>
        <div className="border-t px-4 py-3">
          <div className="flex flex-col items-center gap-2 text-center text-body text-muted-foreground">
            <span>{t('loading.viewRecords')}</span>
            {viewLoadingTimedOut && (
              <>
                <span className="text-caption text-muted-foreground/80">{t('loading.viewRecordsTooLong')}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-body"
                  onClick={handleViewRetry}
                >
                  <RefreshCw className="size-3" />
                  {t('loading.retry')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const isNonGridLoading = isRecordsLoading && currentView && currentView.view_type !== 'grid'
  const shouldLoadNonGridCommentCounts = Boolean(
    currentView && COMMENT_BADGE_VIEW_TYPES.has(currentView.view_type),
  )

  let viewContent: React.ReactNode
  if (shouldShowFallbackGrid || !currentView) {
    viewContent = renderGridView(embedded, handleOpenTableHistory)
  } else {
    switch (currentView.view_type) {
      case 'kanban':
        viewContent = (
          <>
            {!embedded && <ViewToolbar onOpenTableHistory={handleOpenTableHistory} />}
            <div className="relative flex-1 overflow-hidden">
              <Suspense fallback={<TablePreviewSkeleton />}>
                <KanbanView embedded={embedded} isReadonly={isTableReadonly} />
              </Suspense>
              {isNonGridLoading && <ViewLoadingOverlay />}
            </div>
          </>
        )
        break
      case 'calendar':
        viewContent = (
          <>
            {!embedded && <ViewToolbar onOpenTableHistory={handleOpenTableHistory} />}
            <div className="relative flex-1 overflow-hidden">
              <Suspense fallback={<TablePreviewSkeleton />}>
                <CalendarView embedded={embedded} isReadonly={isTableReadonly} />
              </Suspense>
              {isNonGridLoading && <ViewLoadingOverlay />}
            </div>
          </>
        )
        break
      case 'gallery':
        viewContent = (
          <>
            {!embedded && <ViewToolbar onOpenTableHistory={handleOpenTableHistory} />}
            <div className="relative flex-1 overflow-hidden">
              <Suspense fallback={<TablePreviewSkeleton />}>
                <GalleryView embedded={embedded} isReadonly={isTableReadonly} />
              </Suspense>
              {isNonGridLoading && <ViewLoadingOverlay />}
            </div>
          </>
        )
        break
      case 'flashcard':
        viewContent = (
          <>
            {!embedded && <ViewToolbar onOpenTableHistory={handleOpenTableHistory} />}
            <div className="relative flex-1 overflow-hidden">
              <FlashcardView isReadonly={isTableReadonly} />
              {isNonGridLoading && <ViewLoadingOverlay />}
            </div>
          </>
        )
        break
      case 'form':
        viewContent = (
          <>
            {!embedded && (
              <FormToolBar
                mode={effectiveFormMode}
                onModeChange={setFormMode}
                viewId={currentViewId}
                hideEditTab={hideEditTab}
              />
            )}
            <div className="relative flex-1 overflow-hidden">
              <Suspense fallback={<TablePreviewSkeleton />}>
                <FormView embedded={embedded} mode={effectiveFormMode} shareId={shareId} formPassword={formPassword} isReadonly={isTableReadonly} />
              </Suspense>
              {isNonGridLoading && <ViewLoadingOverlay />}
            </div>
          </>
        )
        break
      default:
        viewContent = renderGridView(embedded, handleOpenTableHistory)
    }
  }

  return (
    <div
      ref={paneContainerRef}
      tabIndex={-1}
      className={cn('relative flex h-full flex-1 flex-col overflow-hidden outline-none', className)}
    >
      {/* ：把记录抽屉等 overlay portal 进当前 tab pane（与 grid 的 GridViewHost 行为一致），
          否则非 grid 视图的 RecordForm 抽屉会 portal 到 document.body、脱离 tab 窗口。
          grid 自身在 GridViewHost 内有更内层的 OverlayContainerProvider，会覆盖此处。 */}
      <OverlayContainerProvider containerRef={paneContainerRef}>
        <UndoRedoProvider value={undoRedoCtx}>
          <ViewRecordCommentCountsProvider
            tableId={selectedTable?.id ?? null}
            viewRecords={currentViewRecords}
            enabled={shouldLoadNonGridCommentCounts}
            onOpenRecordComments={handleOpenRecordComments}
          >
            {viewContent}
          </ViewRecordCommentCountsProvider>
        </UndoRedoProvider>

      {selectedTable && (
        <TableHistoryModal
          open={showTableHistoryModal}
          onOpenChange={setShowTableHistoryModal}
          tableId={selectedTable.id}
          tableName={selectedTable.name || ''}
          fields={fields}
          views={views}
          currentViewId={currentViewId}
          refreshKey={tableHistoryRefreshKey}
          isReadonly={isTableReadonly}
          onRestoreSuccess={handleTableRestoreSuccess}
        />
      )}

      {selectedTable && notificationRecord ? (
        <RecordFormContainer
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setNotificationRecord(null)
          }}
          mode="edit"
          record={notificationRecord}
          isReadonly={isTableReadonly}
          initialCommentsOpen
          targetCommentId={notificationCommentId}
        />
      ) : null}

      <FieldBatchUndoConflictDialog
        open={fieldRestoreConflict !== null}
        onOpenChange={(open) => { if (!open) setFieldRestoreConflict(null) }}
        restorableFields={fieldRestoreConflict?.restorable_fields ?? []}
        unrestorableFields={fieldRestoreConflict?.unrestorable_fields ?? []}
        onOpenVersionHistory={() => {
          setFieldRestoreConflict(null)
          setShowTableHistoryModal(true)
        }}
      />
      </OverlayContainerProvider>
    </div>
  )
})
ViewContainerInner.displayName = 'ViewContainerInner'

/**
 * ViewContainer
 *
 * ：把表级协作运行时（TableCollabProvider）放在最外层——它在表打开期间始终挂载，
 * 不随视图切换或加载态早返回而卸载，从而让 Y.js 连接跨视图常驻，非 grid 视图也具备实时协同。
 */
const ViewContainerWithReadonly: React.FC<ViewContainerProps> = (props) => {
  const selectedTableId = useTableStore(state => state.selectedTable?.id ?? null)
  return (
    <TableReadonlyProvider tableId={selectedTableId}>
      <ViewContainerInner {...props} />
    </TableReadonlyProvider>
  )
}

export const ViewContainer: React.FC<ViewContainerProps> = ({
  withProviders = true,
  parentDocumentId = null,
  surfaceId,
  isSurfaceActive = true,
  ...props
}) => {
  if (!withProviders) {
    return <ViewContainerInner {...props} />
  }

  return (
    <TableCollabProvider
      parentDocumentId={parentDocumentId}
      surfaceId={surfaceId}
      isSurfaceActive={isSurfaceActive}
      publishGlobalRuntime={!props.embedded}
    >
      <ViewContainerWithReadonly {...props} />
    </TableCollabProvider>
  )
}
