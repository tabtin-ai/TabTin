import React, { useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import {
  resolveTableGridEngine,
  resolveRecordId,
  isDraftGridRow,
  type TableGridAttachmentDownloadItem,
  type TableGridRow,
  type TableGridConfig,
  type TableGridRowControlItem,
  type TableGridRendererProps,
} from '@tabtin/table-engine';
import {
  CANVAS_TABLE_ENGINE,
} from '@tabtin/table-engine-canvas/engine';
import {
  useGridOverlayStore,
} from '@tabtin/table-engine-canvas/overlays';
import {
  DataGridFullWidthRowRenderer,
  isDataGridFullWidthRow,
  postSortRowsKeepSpecialRowsAtBottom,
  buildRowsWithDraft,
  buildGroupOrderSnapshot,
  type DataGridAddRowContext,
  registerProbeIntent,
  unregisterProbeIntent,
  isViewConfigMutationAllowed,
  isViewLocked,
} from '@tabtin/table-ui';
import {
  ConfirmDialog,
  normalizeSelectChoices,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui';
import { useTranslation } from 'react-i18next';
import { useFieldSettingStore } from '@/stores/useFieldSettingStore';
import { useAuthStore } from '@stores/useAuthStore';
import {
  buildAttachmentUploadKey,
  useAttachmentStore,
} from '@/stores/useAttachmentStore';
import { createAttachmentFileRefHandler } from '@/components/attachments/attachmentFileRef';
import {
  downloadTabDataAttachment,
  downloadTabDataAttachmentsBatch,
} from '@/components/attachments/downloadTabDataAttachments';
import { loadElectronAttachmentPreviewUi } from '@/components/attachments/electronAttachmentPreviewUi';
import { formatNumber } from '@/utils/i18n/format';
import type { SearchIndexHit, TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-core';
import { FieldApiService, type Field } from '@tabtin/table-core';
import type { FieldChangeInfo } from '@tabtin/table-engine/sync';
import { resolveRestSafeRecordId } from '@tabtin/table-engine/collab';
import { getChatClient } from '@/services/chatApi';
import { openResourceUrlInSpace } from '@/services/openResourceLink';
import { resolveBrowserOpenTabScopeKey } from '@/components/chat/subagent/openSubagentTab';
import { useContextTabScopeKey } from '@/hooks/useIsContextTabActive';
import { useOptionalSpaceContextState } from '@components/context-space/SpaceContextAreaContext';
import { buildTableKey } from '@/stores/contextTabs/helpers';
import { useSpaceStore } from '@/stores/useSpaceStore';
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore';
import { useDataGridDataset } from './controller/useDataGridDataset';
import { useDataGridColumns } from './controller/useDataGridColumns';
import { useDataGridEditingController } from './controller/useDataGridEditingController';
import { resolveRecordFocusIntentMeta } from './recordFocusIntent';
import { isRecordFocusCollabBootstrapPending } from './recordFocusCollabReadiness';
import { useColumnReorderPersistence } from './controller/useColumnReorderPersistence';
import { useViewFilterSync } from './controller/useViewFilterSync';
import { useDataGridGridEvents } from './controller/useDataGridGridEvents';
import { useDataGridFieldContextMenu } from './controller/useDataGridFieldContextMenu';
import { useUndoRedo } from './controller/useUndoRedo';
import { useDataGridFallbackLoader } from './controller/useDataGridFallbackLoader';
import { useDataGridRecordEditor } from './controller/useDataGridRecordEditor';
import { RecordFormFocusTarget } from '@/components/record/recordFormFocusTarget';
import { useIncrementalViewMerge as useDataGridIncrementalViewMerge } from '@tabtin/table-engine/sync';
import { useDataGridPresentationModel } from './controller/useDataGridPresentationModel';
import { useDataGridAdapterStores } from './controller/useDataGridAdapterStores';
import { useDataGridViewRuntime } from './controller/useDataGridViewRuntime';
import { CollabStatus } from '@tabtin/collab-core';
import { useCollabPeerCursorsForTable } from '@stores/useTableCollabStore';
import { useTableCollab } from './TableCollabContext';
import { useTableReadonly } from './TableReadonlyContext';
import { useTableEngineObservability } from './controller/useTableEngineObservability';
import { DataGridOverlayLayer } from './DataGridOverlayLayer';
import { useTableAppearanceStore } from '@stores/useTableAppearanceStore';
import { useDataGridContext } from './DataGridContext';
import { useDataGridPermission } from './hooks/useDataGridPermission';
import { useDataGridClipboard } from './hooks/useDataGridClipboard';
import { useDataGridFieldOps } from './hooks/useDataGridFieldOps';
import { useDataGridRecordOps } from './hooks/useDataGridRecordOps';
import { useDataGridSearch } from './hooks/useDataGridSearch';
import { useDataGridFocusHighlight } from './hooks/useDataGridFocusHighlight';
import { useDataGridLinkEditor } from './hooks/useDataGridLinkEditor';
import { useDataGridStatistics } from './hooks/useDataGridStatistics';
import { useRecordCommentCounts } from './hooks/useRecordCommentCounts';
import { useDataGridContextMenus } from './hooks/useDataGridContextMenus';
import { resolveCreatedRecordVisibility } from '@tabtin/table-ui/clipboard';
import { resolveFreezeColumnCountFromViewConfig } from './utils/gridDisplayUtils';
import { type TreeDataNodeMeta } from './utils/gridRowUtils';
import { type LocalCreateOverlayOrderContext } from './utils/viewLocalCreateOverlay';
import { useCanvasRowReorder } from './hooks/useCanvasRowReorder';
import { waitForCondition } from './hooks/waitForCondition';
import { useTableMemberDisplayNames } from './hooks/useTableMemberDisplayNames';
import { useLocalCreateOverlay } from './hooks/useLocalCreateOverlay';
import { useAttachmentPreview } from './hooks/useAttachmentPreview';
import { useRowReorderOptimistic } from './hooks/useRowReorderOptimistic';
import { usePersonalViewResolution } from './hooks/usePersonalViewResolution';
import { useRowCounterDisplay } from './hooks/useRowCounterDisplay';
import { useTabDataRuntimeMetrics } from './hooks/useTabDataRuntimeMetrics';
import { createLogger } from '@/utils/logger';
import { useGridRowAssembly } from './hooks/useGridRowAssembly';

const DRAFT_ROW_ID = '__draft_row__';
const DATA_GRID_ENGINES = [CANVAS_TABLE_ENGINE] as const;
const DEFAULT_VIEW_LOAD_PAGE_SIZE = 200;
const INFINITE_SCROLL_ROW_THRESHOLD = 30;
const log = createLogger('DataGridAdapter');
// REST 路径下为定位服务端搜索命中行最多连续 loadMore 的页数上限，
// 防止命中行极靠后或数据异常时无限翻页。
const ENSURE_HIT_MAX_LOAD_MORE_ITERATIONS = 25;

// ── Memo 子组件：避免父组件 re-render 导致不必要的子树重绘 ──

interface RowCounterWidgetProps {
  label: React.ReactNode
  ariaLabel: string
  tooltipLabel: string | null
}

const RowCounterWidget = React.memo<RowCounterWidgetProps>(({
  label,
  ariaLabel,
  tooltipLabel,
}) => {
  const labelNode = (
    <span
      className={tooltipLabel ? 'pointer-events-auto cursor-default' : undefined}
      aria-label={ariaLabel}
    >
      {label}
    </span>
  );

  return (
    <div className="pointer-events-none absolute bottom-3 left-2 z-floating whitespace-nowrap text-caption text-muted-foreground">
      {tooltipLabel ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>{labelNode}</TooltipTrigger>
            <TooltipContent side="top" className="px-2 py-1 text-caption">
              {tooltipLabel}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        labelNode
      )}
    </div>
  );
})
RowCounterWidget.displayName = 'RowCounterWidget'

interface DataGridAdapterProps {
  /** W1.4 / C1:打开表级版本历史(供 FieldDeleteConfirmDialog 引导用户) */
  onOpenTableHistory?: () => void
  /** 同一表格存在多个嵌入实例时，将字段设置面板绑定到实际点击的宿主。 */
  fieldSettingHostId?: string
}

export const DataGridAdapter: React.FC<DataGridAdapterProps> = ({
  onOpenTableHistory,
  fieldSettingHostId,
}) => {
  const { t, i18n } = useTranslation(['table', 'field', 'common', 'view']);
  const { t: tChat } = useTranslation('chat');
  const translateTable = React.useCallback(
    (key: string) => String(i18n.t(key as any)),
    [i18n, i18n.language],
  );
  const translateWithOptions = React.useCallback(
    (key: string, options?: Record<string, unknown>) =>
      String(i18n.t(key as any, options as any)),
    [i18n, i18n.language],
  );
  const {
    searchQuery,
    searchScope,
    searchSelectedFieldIds,
    searchHideNotMatchRows,
    searchNavigateRequest,
    reportSearchState,
    openRecordEditor,
    serverSearchHits,
    serverSearchLoading,
    serverSearchTotalCount,
    useServerSearch,
    serverSearchHasMore,
    serverSearchLoadNextPage,
    registerHighlightCells,
    registerAddRowHandler,
    isTableReadonly,
    setTableReadonly,
  } = useDataGridContext();
  const { attachmentTasks, removeAttachmentTask } = useAttachmentStore(
    useShallow(state => ({
      attachmentTasks: state.tasks,
      removeAttachmentTask: state.removeTask,
    }))
  );
  const {
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
    loadRecordsByTable,
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
    draftFilters,
    collapsedGroupIds,
    treeExpandedRecords,
    runtimeTableId,
    wsLoadViews,
    viewStoreApi,
    recordStoreApi,
  } = useDataGridAdapterStores();
  const normalizedSearchRevealKey = searchQuery.trim().toLowerCase();
  const [searchRevealedGroupIds, setSearchRevealedGroupIds] = React.useState<
    Set<string>
  >(() => new Set());

  React.useEffect(() => {
    setSearchRevealedGroupIds((current) =>
      current.size === 0 ? current : new Set(),
    );
  }, [currentViewId, normalizedSearchRevealKey]);

  const collapsedGroupIdsForDisplay = React.useMemo(
    () =>
      searchRevealedGroupIds.size === 0
        ? collapsedGroupIds
        : collapsedGroupIds.filter((id) => !searchRevealedGroupIds.has(id)),
    [collapsedGroupIds, searchRevealedGroupIds],
  );
  // 渲染同步的 fields：协作 fieldId→hex 也在同帧由 input.fields 重建。
  // 异步拖入须等此 ref，勿读全局 tableStore，也不宜只读 store.getState()（可能早一帧）。
  const fieldsRef = React.useRef(fields);
  fieldsRef.current = fields;

  const tableTabKey = selectedTable?.id ? buildTableKey(selectedTable.id) : null;
  // 优先用 SpaceContext 权威 scope（与「新建网页」同桶）；反查 findSpaceByTabKey 仅作兜底。
  // 若仍是裸 spaceId，升到前台 desktop:/conversation:（ key not in tabOrder）。
  const spaceContext = useOptionalSpaceContextState();
  const spaceContextTabScopeKey = spaceContext?.tabScopeKey ?? null;
  const tabScopeFromTabKey = useContextTabScopeKey(tableTabKey);
  const recordFocusIntentMeta = useSpaceContextTabsStore(useShallow((state) => {
    return resolveRecordFocusIntentMeta(
      state.itemsBySpace,
      tableTabKey,
      spaceContextTabScopeKey ?? tabScopeFromTabKey,
    );
  }));
  const recordFocusIntent = React.useMemo(() => (
    recordFocusIntentMeta.requestId !== null && recordFocusIntentMeta.recordId
      ? {
          requestId: recordFocusIntentMeta.requestId,
          recordId: recordFocusIntentMeta.recordId,
        }
      : null
  ), [recordFocusIntentMeta.recordId, recordFocusIntentMeta.requestId]);
  const consumeRecordFocusIntent = React.useCallback((requestId: string | number) => {
    if (!tableTabKey || !recordFocusIntentMeta.scopeKey) return;
    const store = useSpaceContextTabsStore.getState();
    const item = store.itemsBySpace[recordFocusIntentMeta.scopeKey]?.[tableTabKey];
    if (item?.meta?.recordFocusRequestId !== requestId) return;
    store.setItemMeta(recordFocusIntentMeta.scopeKey, tableTabKey, {
      recordFocusRecordId: null,
      recordFocusRequestId: null,
    });
  }, [recordFocusIntentMeta.scopeKey, tableTabKey]);
  const selectedSpaceId = useSpaceStore((s) => s.selectedSpace?.id ?? null);
  const tabScopeKey = resolveBrowserOpenTabScopeKey(
    spaceContext?.spaceId || selectedSpaceId,
    spaceContextTabScopeKey || tabScopeFromTabKey,
  );
  const handleUrlCellClick = useCallback(
    (href: string) => {
      void openResourceUrlInSpace(href, tabScopeKey);
    },
    [tabScopeKey],
  );

  // 表格自适应行高用的字号——按 tableId 取，未设过回落默认。
  const tableFontSize = useTableAppearanceStore((state) => {
    const id = selectedTable?.id;
    const entry = id ? state.byTable[id] : undefined;
    return (entry ?? state.defaultAppearance).size;
  });

  const { is403Error, mark403Readonly } = useDataGridPermission({
    selectedTableId: selectedTable?.id ?? null,
    isTableReadonly,
    setTableReadonly,
    t: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
  });
  const formatAttachmentCount = useCallback(
    (count: number) => {
      const value = formatNumber(count);
      return translateWithOptions(
        'table:attachments.count' as any,
        { count: value } as any,
      ) as string;
    },
    [translateWithOptions],
  );
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const commitDraftOnOutsideClickRef = useRef<() => void>(() => {});
  const commitDraftOnInsideGridClickRef = useRef<(target?: EventTarget | null) => void>(() => {});
  const { merge: mergeIncrementalViewRecords, remove: removeViewRecordsByIds } =
    useDataGridIncrementalViewMerge(viewStoreApi);

  const getRecordIds = useCallback(() => recordStoreApi.getState().recordIds, [recordStoreApi]);
  const getGateway = React.useCallback(() => getChatClient().getGateway(), []);
  const refreshFieldStructure = useCallback(async (tableId: string) => {
    await loadFields(tableId);
    if (currentViewId) {
      await wsLoadViews(tableId);
      return;
    }
    await refreshCurrentView();
  }, [currentViewId, loadFields, refreshCurrentView, wsLoadViews]);

  // WS 字段/视图结构变更时的刷新回调
  // update_field（如选项 choices 变更）只需重新加载字段定义，
  // 记录数据的更新由独立的 table.events.delta 事件处理，
  // 避免与正在进行的 record update API 竞态导致闪烁。
  const handleWsFieldChange = useCallback((info: FieldChangeInfo) => {
    const tableId = selectedTable?.id;
    if (!tableId) return;
    if (info.action !== 'update_field') {
      void refreshFieldStructure(tableId).catch((error) => {
        console.error('[DataGridAdapter] WS 字段结构刷新失败', error);
      });
      return;
    }
    void loadFields(tableId);
  }, [selectedTable?.id, loadFields, refreshFieldStructure]);

  const handleWsViewChange = useCallback(() => {
    const tableId = selectedTable?.id;
    if (!tableId) return;
    void wsLoadViews(tableId);
  }, [selectedTable?.id, wsLoadViews]);
  const currentViewRecordsRef = useRef(currentViewRecords);
  currentViewRecordsRef.current = currentViewRecords;

  // ── 表级协作运行时 ──
  // 连接 / 桥接 / presence / 视图配置协作入口由 TableCollabProvider（ViewContainer 层）
  // 统一持有，随表存活、跨视图共享。grid 在此消费同一份桥接，不再自建连接。
  const {
    parentDocumentId,
    collabBridge,
    isCollabRuntime,
    updateViewForRuntime,
    mirrorRecordsToCollab,
    mirrorRecordDeletesToCollab,
    registerLocalCreateOverlayRemover,
    createFieldForRuntime,
    deleteFieldForRuntime,
    disconnectPhase,
    disconnectSeconds,
    handleForceReconnect,
    handleCollabCellFocus,
  } = useTableCollab();
  const collabPermissionDenied = collabBridge.collab.syncModeReason === 'permission_denied';
  const collabAccessVerificationUnavailable =
    collabBridge.collab.syncModeReason === 'access_verification_unavailable';
  const collabAccessBlocked = collabPermissionDenied || collabAccessVerificationUnavailable;

  const embeddedRequestHeaders = React.useMemo(
    () => parentDocumentId
      ? { 'X-TabTin-Parent-Document-Id': parentDocumentId }
      : undefined,
    [parentDocumentId],
  );
  const tableEventTopicContext = React.useMemo(
    () => parentDocumentId
      ? { parent_document_id: parentDocumentId }
      : undefined,
    [parentDocumentId],
  );

  const { isTableReadonly: paneReadonly } = useTableReadonly()
  const effectiveTableReadonly = paneReadonly || isTableReadonly || collabAccessBlocked

  const reloadCurrentRecords = useCallback(async () => {
    if (currentViewId) {
      await refreshCurrentView();
      return;
    }

    const tableId = selectedTable?.id;
    if (!tableId) {
      return;
    }

    await loadRecordsByTable(tableId, {
      page: recordsQuery.page,
      page_size: recordsQuery.page_size,
    });
  }, [
    currentViewId,
    loadRecordsByTable,
    recordsQuery.page,
    recordsQuery.page_size,
    refreshCurrentView,
    selectedTable?.id,
  ]);

  const handleWsRecordOrderChanged = useCallback(() => {
    if (reorderInFlightRef.current) return;
    void reloadCurrentRecords().catch((error) => {
      console.error('[DataGridAdapter] WS 行排序刷新失败', error);
    });
  }, [reloadCurrentRecords]);

  const handleIncrementalFullReload = useCallback(
    () => (currentViewId
      ? refreshCurrentView({ throwOnError: true })
      : reloadCurrentRecords()
    ).catch((error) => {
      console.error('[DataGridAdapter] 增量同步全量刷新失败', error);
      throw error;
    }),
    [currentViewId, refreshCurrentView, reloadCurrentRecords],
  );

  // CMS-004: 协作在线时，field 变更通过 Y.js stateless `table.schema.changed`
  // 到达（collabBridge.onFieldChange），此时 WS `table.events.field` 也会到达，
  // 两条路径都调用 handleWsFieldChange 导致 loadFields 双发竞态。
  // 解法：协作在线时屏蔽 WS 路径的 onFieldChange，只保留 Y.js stateless 路径。
  const handleWsFieldChangeForRuntime = useCallback((info: FieldChangeInfo) => {
    if (collabBridge.collab.isOnline && !collabBridge.collab.isFallback) return;
    handleWsFieldChange(info);
  }, [collabBridge.collab.isOnline, collabBridge.collab.isFallback, handleWsFieldChange]);

  const { currentView, useViewData, startPolling, checkIfTriggersAutoField, isCollabDegraded, triggerSync } =
    useDataGridViewRuntime({
      getGateway,
      views,
      currentViewId,
      initializeDraft,
      selectedTableId: selectedTable?.id ?? null,
      currentViewLatestVersion,
      currentViewEtag,
      latestVersion,
      recordsEtag,
      recordsQuery,
      requestHeaders: embeddedRequestHeaders,
      tableEventTopicContext,
      fields,
      mergeIncrementalRecords,
      mergeIncrementalViewRecords,
      removeRecordsByIds,
      removeViewRecordsByIds,
      onFieldChange: handleWsFieldChangeForRuntime,
      onViewChange: handleWsViewChange,
      onRecordOrderChanged: handleWsRecordOrderChanged,
      onFullReloadRequired: handleIncrementalFullReload,
      syncMode: collabBridge.collab.syncMode,
      collabActive: collabBridge.collab.isOnline && !collabBridge.collab.isFallback,
      isCollabSynced: () => collabBridge.collab.status === CollabStatus.SYNCED,
      getRecordIds,
    });
  const normalizedViewLoadRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!useViewData || !currentViewId) {
      normalizedViewLoadRef.current = null;
      return;
    }

    if (normalizedViewLoadRef.current === currentViewId) {
      return;
    }

    normalizedViewLoadRef.current = currentViewId;
    if (
      recordsQuery.page !== 1 ||
      recordsQuery.page_size !== DEFAULT_VIEW_LOAD_PAGE_SIZE
    ) {
      if (isCollabRuntime) {
        viewStoreApi.setState((state) => ({
          recordsQuery: {
            ...state.recordsQuery,
            page: 1,
            page_size: DEFAULT_VIEW_LOAD_PAGE_SIZE,
          },
        }));
      } else {
        void viewStoreApi.getState().setPageSize(DEFAULT_VIEW_LOAD_PAGE_SIZE);
      }
    }
  }, [
    currentViewId,
    isCollabRuntime,
    recordsQuery.page,
    recordsQuery.page_size,
    useViewData,
    viewStoreApi,
  ]);
  const collabBaseView = React.useMemo(() => {
    if (!isCollabRuntime) return currentView;
    if (!currentViewId) {
      return (
        (collabBridge.collab.viewsMeta[0] as unknown as ViewMeta | undefined) ??
        currentView
      );
    }
    const ydocView = collabBridge.collab.viewsMeta.find(
      (view) => String(view.id) === currentViewId,
    );
    // Y.Doc 尚未投影到该视图时回退 REST/store，避免汇总等视图配置读到 null
    return (ydocView as unknown as ViewMeta | undefined) ?? currentView;
  }, [collabBridge.collab.viewsMeta, currentView, currentViewId, isCollabRuntime]);

  const {
    resolvedCurrentView: effectiveCurrentView,
    isPersonalViewEnabled,
    setPersonalViewDraft,
  } = usePersonalViewResolution({
    selectedTableId: selectedTable?.id,
    currentViewId,
    currentView: collabBaseView,
  });
  // is_locked = 锁定「视图配置」，不是锁定记录编辑。单元格/加行/粘贴只跟表级只读走。
  const isCurrentViewLocked = isViewLocked(effectiveCurrentView?.is_locked);
  const effectiveReadonly = effectiveTableReadonly;
  const viewConfigLocked = isCurrentViewLocked && !isPersonalViewEnabled;

  const {
    currentViewRecordsForDisplay: currentViewRecordsForRestDisplay,
    applyLocalCreateOverlay,
    patchLocalCreateOverlayRecord,
    removeOverlayRecords,
    localCreateOverlayScopeKey,
  } = useLocalCreateOverlay({
    selectedTableId: selectedTable?.id,
    currentViewId,
    currentViewRecords,
    resolvedCurrentView: effectiveCurrentView,
    useViewData,
    searchQuery,
    searchHideNotMatchRows,
    useServerSearch,
  });

  React.useEffect(() => {
    return registerLocalCreateOverlayRemover((recordIds) => {
      removeOverlayRecords([...recordIds]);
    });
  }, [registerLocalCreateOverlayRemover, removeOverlayRecords]);

  const currentViewRecordsForDisplay = currentViewRecordsForRestDisplay;
  // 用户字段存储稳定 ID；分组标题与单元格共用组织成员姓名来源。
  const { organizationMembers, userDisplayNameById } = useTableMemberDisplayNames();
  const currentUserId = useAuthStore((state) => state.user?.id != null ? String(state.user.id) : undefined);
  const applyDraftForRuntime = React.useCallback(
    async (viewId: string) => {
      // 预览：表级只读或「锁定且未开个人视图」时拒绝；不写共享视图 / Y.Doc
      if (effectiveTableReadonly || viewConfigLocked) return
      if (!isCollabRuntime) {
        await applyDraft(viewId);
        return;
      }
      const draft = viewStoreApi.getState().draftStates[viewId];
      if (!draft) return;
      const tableId = selectedTable?.id;
      if (!tableId) return;
      // 协作在线：只写入会话级 personalViewDraft，由 resolveEffectiveCurrentView 投影
      setPersonalViewDraft(tableId, viewId, {
        filters: draft.filters ?? [],
        groups: draft.groups ?? [],
        filter_logic: draft.filter_logic === 'or' ? 'or' : 'and',
      });
    },
    [
      applyDraft,
      effectiveTableReadonly,
      isCollabRuntime,
      selectedTable?.id,
      setPersonalViewDraft,
      viewConfigLocked,
      viewStoreApi,
    ],
  );

  const {
    fieldIdByName,
    fieldNameById,
    orderedFields,
    requestedFieldIds,
    hasGrouping,
    rowsData,
    searchableRows,
    groupPathByRecordId,
    groupedRows,
    gridLoading,
    currentPage,
    currentPageSize,
    totalCount,
  } = useDataGridDataset({
    fields,
    currentView: effectiveCurrentView,
    currentViewRecords: currentViewRecordsForDisplay,
    records,
    userDisplayNameById,
    useViewData,
    collapsedGroupIds: collapsedGroupIdsForDisplay,
    treeExpandedRecords,
    isRecordsLoading,
    isRecordLoading,
    recordsQueryPage: recordsQuery.page,
    recordsQueryPageSize: recordsQuery.page_size,
    page,
    pageSize,
    total,
    t: translateTable,
    locale: i18n.language,
  });
  const groupPathByNormalizedRecordId = React.useMemo(() => {
    const paths = new Map<string, string>();
    groupPathByRecordId.forEach((path, recordId) => {
      paths.set(recordId.trim().toLowerCase().replace(/-/g, ''), path);
    });
    return paths;
  }, [groupPathByRecordId]);

  const ensureCollapsedGroupsVisible = React.useCallback(
    (recordIds: string[]) => {
      if (recordIds.length === 0 || collapsedGroupIdsForDisplay.length === 0) return;

      const collapsed = new Set(collapsedGroupIdsForDisplay);
      const pathsToReveal = new Set<string>();
      recordIds.forEach((recordId) => {
        const normalizedRecordId = recordId.trim().toLowerCase().replace(/-/g, '');
        const leafPath = groupPathByNormalizedRecordId.get(normalizedRecordId);
        if (!leafPath) return;

        let ancestorPath = '';
        leafPath.split('||').forEach((segment) => {
          ancestorPath = ancestorPath ? `${ancestorPath}||${segment}` : segment;
          if (collapsed.has(ancestorPath)) {
            pathsToReveal.add(ancestorPath);
          }
        });
      });

      if (pathsToReveal.size === 0) return;
      setSearchRevealedGroupIds((current) => {
        const next = new Set(current);
        let changed = false;
        pathsToReveal.forEach((path) => {
          if (next.has(path)) return;
          next.add(path);
          changed = true;
        });
        return changed ? next : current;
      });
    },
    [collapsedGroupIdsForDisplay, groupPathByNormalizedRecordId],
  );
  const allowViewMutation = isViewConfigMutationAllowed(
    effectiveTableReadonly,
    effectiveCurrentView?.is_locked,
    isPersonalViewEnabled,
  );
  const subRecordParentFieldId = React.useMemo(() => {
    const config = effectiveCurrentView?.config as
      | Record<string, unknown>
      | null
      | undefined;
    const value = config?.subRecordParentFieldId;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }, [effectiveCurrentView?.config]);
  const treeDataForMove = React.useMemo(() => {
    const metadata = (currentViewRecords as Record<string, unknown> | null)
      ?.metadata as Record<string, unknown> | undefined;
    const subRecords = metadata?.sub_records as
      | Record<string, unknown>
      | undefined;
    const treeData = subRecords?.tree_data;
    if (!treeData || typeof treeData !== 'object' || Array.isArray(treeData)) {
      return null;
    }
    return treeData as Record<string, TreeDataNodeMeta>;
  }, [currentViewRecords]);

  const theme = resolvedTheme;
  const activeEngine = React.useMemo(
    () =>
      resolveTableGridEngine(DATA_GRID_ENGINES, {
        preferredEngineId: CANVAS_TABLE_ENGINE.id,
        fallbackEngineId: CANVAS_TABLE_ENGINE.id,
      }),
    [],
  );
  const GridEngineView = activeEngine.component;

  const {
    snapshot: tableEngineMetricsSnapshot,
    trackMutationLatency,
    reportRendererError,
  } = useTableEngineObservability({
    engineId: activeEngine.id,
    scopeId: runtimeTableId ?? selectedTable?.id ?? null,
    gridContainerRef,
  });

  const showTableEngineMetricsOverlay = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('tableEngineMetrics') === '1') {
      return true;
    }

    try {
      return window.localStorage.getItem('tabtin.tableEngineMetrics') === '1';
    } catch {
      return false;
    }
  }, []);

  useDataGridFallbackLoader({
    selectedTableId: selectedTable?.id ?? null,
    useViewData,
    requestedFieldIds,
    loadFields,
    loadRecordsByTable,
  });

  const { columns, firstEditableField } = useDataGridColumns({
    orderedFields,
    currentView: effectiveCurrentView,
    hasGrouping,
    formatAttachmentCount,
    t: translateWithOptions,
    locale: i18n.language,
    isReadonly: effectiveReadonly,
  });
  const openHeaderMenu = useGridOverlayStore((state) => state.openHeaderMenu);
  const {
    gridApiRef,
    handleTableApiReady,
    handleSelectionChanged,
    handleGridReady,
    handleFirstDataRendered,
    handleSortChanged,
    handleSortFromMenu,
    handleColumnResized,
    handleFreezeStateChange,
  } = useDataGridGridEvents({
    selectedRows,
    setSelectedRows,
    gridContainerRef,
    onPointerDownInsideGrid: (target) => commitDraftOnInsideGridClickRef.current(target),
    onPointerDownOutsideGrid: () => commitDraftOnOutsideClickRef.current(),
    useViewData,
    selectedTableId: selectedTable?.id ?? null,
    setRecordSorting,
    loadRecordsByTable,
    currentView: effectiveCurrentView,
    fieldIdByName,
    updateView: updateViewForRuntime,
    translate: translateWithOptions,
    isTableReadonly: effectiveReadonly,
  });

  const fieldById = React.useMemo(() => {
    const map = new Map<string, (typeof fields)[number]>();
    for (const field of fields) {
      map.set(field.id, field);
    }
    return map;
  }, [fields]);

  const fieldByName = React.useMemo(() => {
    const map = new Map<string, (typeof fields)[number]>();
    for (const field of fields) {
      map.set(field.name, field);
    }
    return map;
  }, [fields]);

  const ensureRecordFocusTargetAvailable = React.useCallback(
    async (recordId: string): Promise<boolean> => {
      const normalizedRecordId = recordId.trim().toLowerCase().replace(/-/g, '');
      const hasRecord = (records?: ViewRecordsResponse | null): boolean => Boolean(
        records?.records?.some(record =>
          String(record.id ?? '').trim().toLowerCase().replace(/-/g, '') === normalizedRecordId,
        ),
      );

      const state = viewStoreApi.getState();
      const records =
        (state.currentViewRecords as ViewRecordsResponse | null | undefined)
        ?? currentViewRecordsRef.current;
      if (hasRecord(records)) return true;

      const loadedCount = records?.records?.length ?? 0;
      const totalCount = records?.matched_total ?? records?.total ?? loadedCount;
      if (loadedCount >= totalCount) return false;

      if (isCollabRuntime) {
        const nextPageSize = Math.min(
          Math.max(recordsQuery.page_size, loadedCount) + DEFAULT_VIEW_LOAD_PAGE_SIZE,
          totalCount,
        );
        if (nextPageSize <= recordsQuery.page_size) return false;
        viewStoreApi.setState(current => ({
          recordsQuery: { ...current.recordsQuery, page: 1, page_size: nextPageSize },
        }));
        return true;
      }

      if (!useViewData || !currentViewId || state.isLoadingMoreRecords) return false;
      await state.loadMoreCurrentViewRecords?.();
      const nextRecords =
        (viewStoreApi.getState().currentViewRecords as ViewRecordsResponse | null | undefined)
        ?? currentViewRecordsRef.current;
      return hasRecord(nextRecords) || (nextRecords?.records?.length ?? 0) > loadedCount;
    },
    [currentViewId, isCollabRuntime, recordsQuery.page_size, useViewData, viewStoreApi],
  );
  // Deep-link focus must not run against the REST snapshot while the table's
  // initial Y.Doc projection is still arriving. That snapshot is rebuilt from
  // the collaboration row order shortly afterwards, which otherwise moves the
  // focused row/viewport and makes the user click the link a second time.
  const recordFocusCollabBootstrapPending = isRecordFocusCollabBootstrapPending({
    hasFocusIntent: Boolean(recordFocusIntent),
    syncMode: collabBridge.collab.syncMode,
    status: collabBridge.collab.status,
    syncModeReason: collabBridge.collab.syncModeReason,
  });
  const collabReady = collabBridge.collab.status === CollabStatus.SYNCED;
  const previousCollabReadyRef = React.useRef(collabReady);
  const [recordFocusCollabBootstrapGeneration, setRecordFocusCollabBootstrapGeneration] = React.useState(0);
  React.useEffect(() => {
    if (previousCollabReadyRef.current && !collabReady) {
      setRecordFocusCollabBootstrapGeneration((generation) => generation + 1);
    }
    previousCollabReadyRef.current = collabReady;
  }, [collabReady]);

  const recordFocusCollabTimeoutCandidateKey = selectedTable?.id && recordFocusIntent
    ? `${selectedTable.id}:${String(recordFocusIntent.requestId)}:${recordFocusCollabBootstrapGeneration}`
    : null;
  const [recordFocusCollabTimedOutKey, setRecordFocusCollabTimedOutKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (
      !recordFocusCollabTimeoutCandidateKey ||
      !recordFocusCollabBootstrapPending ||
      recordFocusCollabTimedOutKey === recordFocusCollabTimeoutCandidateKey
    ) {
      return;
    }

    // A broken/unavailable collaboration channel must not strand a deep-link
    // forever. The regular REST path remains a safe fallback after this bound.
    const timer = window.setTimeout(() => {
      setRecordFocusCollabTimedOutKey(recordFocusCollabTimeoutCandidateKey);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [
    recordFocusCollabBootstrapPending,
    recordFocusCollabTimedOutKey,
    recordFocusCollabTimeoutCandidateKey,
  ]);

  const isRecordFocusCollabDataLoading =
    recordFocusCollabBootstrapPending && recordFocusCollabTimedOutKey !== recordFocusCollabTimeoutCandidateKey;
  const isRecordFocusDataLoading =
    (!useViewData && Boolean(currentViewId)) ||
    (useViewData ? isRecordsLoading || isLoadingMoreRecords : isRecordLoading) ||
    isRecordFocusCollabDataLoading;
  const ensureRecordFocusGroupsVisible = React.useCallback(
    (recordId: string) => ensureCollapsedGroupsVisible([recordId]),
    [ensureCollapsedGroupsVisible],
  );

  const {
    focusRecordRow,
    focusRecordRowWithRetry,
    resolveFieldIdFromHistoryKey,
    resolveColumnFieldFromHistoryKey,
    highlightCellsImpl,
    handleRecordCreatedVisible,
    handleRecordCreatedVisibleForEditing,
    handleRevealHiddenRecord,
  } = useDataGridFocusHighlight({
    gridApiRef,
    fieldById,
    fieldByName,
    columns,
    firstEditableField,
    useViewData,
    currentViewId,
    clearGroupCollapse,
    setDraftFilters,
    applyDraft: applyDraftForRuntime,
    registerHighlightCells,
    recordFocusIntent,
    isRecordFocusDataLoading,
    ensureRecordAvailable: ensureRecordFocusTargetAvailable,
    ensureRecordFocusGroupsVisible,
    onRecordFocusIntentConsumed: consumeRecordFocusIntent,
  });

  const isCreatedRecordVisible = React.useCallback(
    async (record: { id?: string }) => {
      if (!record?.id) {
        return false;
      }
      const { firstVisibleRecord } = await resolveCreatedRecordVisibility({
        gridApiRef,
        createdRecords: [record],
      });
      return Boolean(firstVisibleRecord);
    },
    [gridApiRef],
  );

  // ── 协作降级 Banner（最短展示 10 秒，避免闪烁） ──
  const degradedSinceRef = React.useRef<number | null>(null);
  const [showDegradedBanner, setShowDegradedBanner] = React.useState(false);

  React.useEffect(() => {
    if (isCollabDegraded) {
      degradedSinceRef.current = Date.now();
      setShowDegradedBanner(true);
      return;
    }
    if (!degradedSinceRef.current) {
      setShowDegradedBanner(false);
      return;
    }
    const elapsed = Date.now() - degradedSinceRef.current;
    const remaining = Math.max(0, 10_000 - elapsed);
    if (remaining === 0) {
      setShowDegradedBanner(false);
      degradedSinceRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => {
      setShowDegradedBanner(false);
      degradedSinceRef.current = null;
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [isCollabDegraded]);

  const handleDegradedRefresh = React.useCallback(() => {
    void triggerSync();
  }, [triggerSync]);

  const hasSubRecordTreeRuntime = React.useMemo(() => {
    const metadata = (currentViewRecords as Record<string, unknown> | null)
      ?.metadata as { sub_records?: { tree_data?: unknown } } | undefined;
    return Boolean(metadata?.sub_records?.tree_data);
  }, [currentViewRecords]);

  useTabDataRuntimeMetrics({
    runtimeTableId,
    selectedTable,
    totalCount,
    rowsDataLength: rowsData.length,
    groupedRowsLength: groupedRows.length,
    fieldsLength: fields.length,
    orderedFieldsLength: orderedFields.length,
    resolvedCurrentView: effectiveCurrentView,
    hasGrouping,
    hasSubRecordTreeRuntime,
    isPersonalViewEnabled,
    currentPage,
    currentPageSize,
    gridLoading,
    isRecordsLoading,
    isRecordLoading,
    selectedRowsLength: selectedRows.length,
    useViewData,
    collabStatus: collabBridge.collab.status
      ? String(collabBridge.collab.status)
      : null,
    collabConnectionStatus: collabBridge.collab.connectionStatus
      ? String(collabBridge.collab.connectionStatus)
      : null,
    isCollabOnline: collabBridge.collab.isOnline,
    peerCount: collabBridge.collab.peers.length,
    isCollabFallback: collabBridge.collab.isFallback,
    tableEngineMetricsSnapshot,
  });

  const createRecordWithMetrics = React.useCallback(
    async (...args: Parameters<typeof collabBridge.createRecord>) => {
      const createData = args[0] as
        | ({ order_context?: LocalCreateOverlayOrderContext; orderContext?: LocalCreateOverlayOrderContext })
        | undefined;
      const createdRecord = await trackMutationLatency('create', () =>
        collabBridge.createRecord(...args),
      );
      if (!createdRecord) {
        return createdRecord;
      }
      try {
        const [overlayRecord] = applyLocalCreateOverlay(
          [createdRecord],
          createData?.order_context ?? createData?.orderContext
        );
        return overlayRecord ?? createdRecord;
      } catch {
        return createdRecord;
      }
    },
    [
      applyLocalCreateOverlay,
      collabBridge.createRecord,
      trackMutationLatency,
    ],
  );

  const updateRecordWithMetrics = React.useCallback(
    async (...args: Parameters<typeof collabBridge.updateRecord>) => {
      const [recordId] = args;
      const updatedRecord = await trackMutationLatency('update', () =>
        collabBridge.updateRecord(...args),
      );

      if (localCreateOverlayScopeKey && updatedRecord) {
        patchLocalCreateOverlayRecord(recordId, updatedRecord);
      }

      return updatedRecord;
    },
    [collabBridge.updateRecord, localCreateOverlayScopeKey, patchLocalCreateOverlayRecord, trackMutationLatency],
  );

  const {
    isFallback: isCollabFallback,
    isOnline: isCollabOnline,
  } = collabBridge.collab;

  const syncDeletedRecordsToCollab = React.useCallback(
    (recordIds: string[]) => {
      mirrorRecordDeletesToCollab(recordIds);
    },
    [mirrorRecordDeletesToCollab],
  );

  const {
    isDataRecordRow,
    normalizeGroupValue,
    isGroupValuesMatch,
    resolveAnchorRow,
    resolveGroupValuesFromAnchor,
    buildDraftPrefillValues,
    resolveDraftAddRowContext,
    resolveGroupAnchorRecordId,
    buildCreateRecordOrderContext,
    buildCreatePlanFromDisplayRowIndex,
    handleDeleteRecords,
    executeDeleteRecords,
    deleteConfirmState,
    confirmDeleteRecords,
    cancelDeleteRecords,
    handleDuplicateRecord,
    handleInsertRecord,
    handleCopyRecordUrl,
    handleInsertSubRecord,
  } = useDataGridRecordOps({
    selectedTable,
    fields,
    records,
    currentViewRecords: currentViewRecordsForDisplay,
    currentView,
    currentViewId,
    useViewData,
    isTableReadonly: effectiveReadonly,
    isPersonalViewEnabled,
    allowViewMutation,
    fieldById,
    gridApiRef,
    selectedRows,
    setSelectedRows,
    firstEditableField,
    groupedRows,
    rowsData,
    subRecordParentFieldId,
    resolvedCurrentView: effectiveCurrentView,
    recordsQuery,
    createRecord: createRecordWithMetrics,
    updateRecord: updateRecordWithMetrics,
    refreshCurrentView,
    loadFields,
    isCollabSyncActive: isCollabOnline && !isCollabFallback,
    loadRecordsByTable,
    updateView: updateViewForRuntime,
    setPersonalViewDraft,
    is403Error,
    mark403Readonly,
    onRevealHiddenRecord: handleRevealHiddenRecord,
    onRecordCreated: handleRecordCreatedVisible,
    onRecordCreatedContinueEditing: handleRecordCreatedVisibleForEditing,
    applyLocalCreateOverlay,
    patchLocalCreateOverlayRecord,
    removeOverlayRecords,
    onRecordsDeleted: syncDeletedRecordsToCollab,
    cancelPendingCollabCreates: collabBridge.cancelPendingCreates,
    mirrorRecordsToCollab,
    viewStoreApi,
    t: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
  });

  const {
    draftRowData,
    draftAddRowContext,
    isDraftSubmitting,
    handleAddRowClick,
    handleCellValueChanged,
    handleCellEditingStopped,
    handleCommitDraftRow,
    handleCancelDraftRow,
    handleDraftShortcutKeyDown,
  } = useDataGridEditingController({
    orderedFields,
    fields,
    selectedTableId: selectedTable?.id ?? null,
    useViewData,
    firstEditableField,
    isReadonly: effectiveReadonly,
    gridApiRef,
    viewStoreApi,
    createRecord: createRecordWithMetrics,
    updateRecord: updateRecordWithMetrics,
    refreshCurrentView,
    startPolling,
    checkIfTriggersAutoField,
    getLastConflicts: () => recordStoreApi.getState().lastConflicts,
    translate: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
    draftRowId: DRAFT_ROW_ID,
    buildCreateRecordOrderContext,
    buildDraftPrefillValues,
    currentUserId,
    resolveDraftAddRowContext,
    onRevealHiddenRecord: handleRevealHiddenRecord,
    onRecordCreated: handleRecordCreatedVisible,
    isRecordVisible: isCreatedRecordVisible,
    rollbackCellValue: React.useCallback(
      ({ recordId, fieldName, fieldId, oldValue }: {
        recordId: string
        fieldName: string
        fieldId: string
        oldValue: unknown
      }) => {
        const partial: TableRecord = {
          id: recordId,
          data: { [fieldName]: oldValue },
          fields: { [fieldId]: oldValue },
        } as TableRecord
        mergeIncrementalRecords([partial], 0)
        mergeIncrementalViewRecords([partial], 0)
      },
      [mergeIncrementalRecords, mergeIncrementalViewRecords]
    ),
  });

  React.useEffect(() => {
    if (!effectiveReadonly) return;
    handleCancelDraftRow();
  }, [effectiveReadonly, handleCancelDraftRow]);

  // dev-only：注册编辑器级探针意图（复用 UI 同款 handler）。
  // 解除「必须手点单元格/菜单」的人工前置，让 CDP / 无人值守可驱动真实编辑，
  // 观测 editing.cell.commit → cell.commitOk(version) / cell.rollback 黄金序列。
  // 生产为 no-op（import.meta.env.DEV guard）。详见 docs/agent/tabdata-interaction-probe.md。
  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    const tableId = selectedTable?.id ?? null;
    if (!tableId) return;
    registerProbeIntent(
      'tabdata.editCell',
      async (args) => {
        const recordId = String((args?.recordId ?? args?.id) ?? '').trim();
        const field = String(args?.field ?? '').trim();
        const value = args?.value;
        if (!recordId) throw new Error('tabdata.editCell 需要 recordId');
        if (!field) throw new Error('tabdata.editCell 需要 field（字段名或 id）');
        const records = currentViewRecordsRef.current?.records ?? [];
        const row = records.find((r) => String(r.id) === recordId);
        if (!row) {
          throw new Error(
            `tabdata.editCell 未找到记录 ${recordId}（当前视图未加载或该记录不在视图内？先 tabdata.open）`,
          );
        }
        const oldValue =
          (row.data as Record<string, unknown> | undefined)?.[field] ??
          (row.fields as Record<string, unknown> | undefined)?.[field];
        const rowData = {
          __recordId: row.id,
          id: row.id,
          row_id: row.id,
        } as unknown as TableGridRow;
        await handleCellValueChanged(rowData, field, value, oldValue);
        return { recordId, field, ok: true };
      },
      'tabdata.editCell：用 UI 同款 handleCellValueChanged 改一个已存在记录的单元格，参数 {recordId, field, value}',
    );
    registerProbeIntent(
      'tabdata.insertSubRecord',
      async (args) => {
        const parentRecordId = String((args?.parentRecordId ?? args?.recordId ?? args?.id) ?? '').trim();
        if (!parentRecordId) throw new Error('tabdata.insertSubRecord 需要 parentRecordId');
        await handleInsertSubRecord(parentRecordId);
        return { parentRecordId, ok: true };
      },
      'tabdata.insertSubRecord：用 UI 同款 handleInsertSubRecord 创建子记录，参数 {parentRecordId}',
    );
    registerProbeIntent(
      'tabdata.insertRecord',
      async (args) => {
        const rawPosition = String(args?.position ?? 'after');
        const position = rawPosition === 'before' ? 'before' : 'after';
        const anchorRecordId = String(args?.anchorRecordId ?? args?.recordId ?? '').trim();
        let anchorRowIndex = Number(args?.anchorRowIndex ?? args?.rowIndex ?? 0);
        if (anchorRecordId) {
          const api = gridApiRef.current;
          const rowCount = Number(api?.getDisplayedRowCount?.() ?? 0);
          let matchedIndex = -1;
          for (let index = 0; index < rowCount; index += 1) {
            const row = api?.getDisplayedRowAtIndex?.(index)?.data as
              | { id?: unknown; row_id?: unknown }
              | undefined;
            const rowId = row?.id ?? row?.row_id;
            if (String(rowId) === anchorRecordId) {
              matchedIndex = index;
              break;
            }
          }
          if (matchedIndex < 0) {
            throw new Error(`tabdata.insertRecord 未找到 anchorRecordId ${anchorRecordId}`);
          }
          anchorRowIndex = matchedIndex;
        }
        const count = Number(args?.count ?? 1);
        if (!Number.isInteger(anchorRowIndex) || anchorRowIndex < 0) {
          throw new Error('tabdata.insertRecord 需要非负整数 anchorRowIndex');
        }
        if (!Number.isInteger(count) || count <= 0) {
          throw new Error('tabdata.insertRecord 需要正整数 count');
        }
        await handleInsertRecord(position, anchorRowIndex, count);
        return { position, anchorRecordId: anchorRecordId || undefined, anchorRowIndex, count, ok: true };
      },
      'tabdata.insertRecord：用 UI 同款 handleInsertRecord 插入记录，参数 {position,before|after, anchorRowIndex 或 anchorRecordId, count}',
    );
    registerProbeIntent(
      'tabdata.deleteRecords',
      async (args) => {
        const rawIds = Array.isArray(args?.recordIds)
          ? args.recordIds
          : Array.isArray(args?.ids)
            ? args.ids
            : [];
        const recordIds = rawIds.map((id) => String(id)).filter(Boolean);
        if (recordIds.length === 0) {
          throw new Error('tabdata.deleteRecords 需要 recordIds');
        }
        // 与 UI 同款权威删除：跳过确认框，直接 REST + 镜像
        await executeDeleteRecords(recordIds);
        return { recordIds, ok: true };
      },
      'tabdata.deleteRecords：dev-only 清理记录，参数 {recordIds}',
    );
    return () => {
      unregisterProbeIntent('tabdata.editCell');
      unregisterProbeIntent('tabdata.insertSubRecord');
      unregisterProbeIntent('tabdata.insertRecord');
      unregisterProbeIntent('tabdata.deleteRecords');
    };
  }, [
    selectedTable?.id,
    handleCellValueChanged,
    handleInsertSubRecord,
    handleInsertRecord,
    executeDeleteRecords,
  ]);

  const {
    handleClipboardCopy,
    handleClipboardPaste,
    pasteConfirmState,
    confirmPaste,
    cancelPaste,
  } = useDataGridClipboard({
    columns,
    gridApiRef,
    tableId: selectedTable?.id ?? null,
    refreshAfterPaste: refreshCurrentView,
    useViewData,
    buildCreatePlanFromDisplayRowIndex,
    applyLocalCreateOverlay,
    onRevealHiddenRecord: handleRevealHiddenRecord,
    onRecordCreated: handleRecordCreatedVisible,
    startPolling,
    checkIfTriggersAutoField,
    isCollabSyncActive: isCollabOnline && !isCollabFallback,
    createRecord: createRecordWithMetrics,
    updateRecord: updateRecordWithMetrics,
    mirrorRecordsToCollab,
    t: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
  });

  commitDraftOnOutsideClickRef.current = () => {
    void handleCommitDraftRow();
  };

  commitDraftOnInsideGridClickRef.current = (target?: EventTarget | null) => {
    if (!draftRowData || isDraftSubmitting) {
      return;
    }
    if (
      target instanceof Element &&
      (
        target.closest('[data-grid-overlay]') ||
        target.closest('input, textarea, select, [contenteditable="true"]')
      )
    ) {
      return;
    }
    const api = gridApiRef.current;
    const editingCells = api?.getEditingCells?.() ?? [];
    if (editingCells.length > 0) {
      return;
    }
    const focusedCell = api?.getFocusedCell?.();
    if (focusedCell && focusedCell.rowIndex >= 0) {
      const focusedRowNode = api?.getDisplayedRowAtIndex?.(focusedCell.rowIndex);
      const focusedRowData = focusedRowNode?.data as
        | Record<string, unknown>
        | undefined;
      if (isDraftGridRow(focusedRowData, DRAFT_ROW_ID)) {
        return;
      }
    }
    void handleCommitDraftRow();
  };

  const groupedRowsForDisplay = React.useMemo(
    () => buildRowsWithDraft({
      groupedRows,
      draftRowData: effectiveReadonly ? null : draftRowData,
      hasGrouping,
      draftAddRowContext: effectiveReadonly ? null : draftAddRowContext,
      viewGroups: effectiveCurrentView?.groups ?? currentView?.groups,
      getFieldById: (id) => fieldById.get(id),
    }),
    [groupedRows, effectiveReadonly, draftRowData, hasGrouping, draftAddRowContext, effectiveCurrentView?.groups, currentView?.groups, fieldById],
  );

  const ensureSearchRowsVisible = ensureCollapsedGroupsVisible;

  const groupOrderSnapshot = React.useMemo(
    () => buildGroupOrderSnapshot(groupedRows),
    [groupedRows],
  );

  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    const tableId = selectedTable?.id ?? null;
    if (!tableId) return;

    registerProbeIntent(
      'tabdata.groupOrderSnapshot',
      () => ({
        capturedAt: Date.now(),
        tableId,
        viewId: effectiveCurrentView?.id ?? currentViewId ?? null,
        viewName: effectiveCurrentView?.name ?? null,
        source: isCollabRuntime
          ? (isCollabOnline && !isCollabFallback ? 'collaboration' : 'rest-fallback')
          : 'rest',
        hasGrouping,
        rules: (effectiveCurrentView?.groups ?? []).map(group => ({
          fieldId: group.field_id ?? null,
          direction: group.direction === 'desc' ? 'desc' : 'asc',
        })),
        ...groupOrderSnapshot,
      }),
      'tabdata.groupOrderSnapshot：只读返回当前画布实际使用的组头顺序、稳定签名与未分组置底断言',
    );

    return () => {
      unregisterProbeIntent('tabdata.groupOrderSnapshot');
    };
  }, [
    currentViewId,
    effectiveCurrentView?.groups,
    effectiveCurrentView?.id,
    effectiveCurrentView?.name,
    groupOrderSnapshot,
    hasGrouping,
    isCollabFallback,
    isCollabOnline,
    isCollabRuntime,
    selectedTable?.id,
  ]);

  const ensureSearchHitVisible = React.useCallback(
    async (hit: SearchIndexHit): Promise<boolean> => {
      const recordId = String(hit.recordId ?? '').trim();
      if (!recordId) return false;
      const normalizedRecordId = recordId.toLowerCase().replace(/-/g, '');

      if (isCollabRuntime) {
        const targetLimit = Math.max(DEFAULT_VIEW_LOAD_PAGE_SIZE, Math.ceil(hit.index || 1));
        const currentRecords = currentViewRecordsRef.current;
        const loadedCount = currentRecords?.records?.length ?? 0;
        const totalCount =
          currentRecords?.matched_total ?? currentRecords?.total ?? Math.max(loadedCount, targetLimit);
        const nextPageSize = Math.min(
          Math.max(recordsQuery.page_size, loadedCount, targetLimit),
          Math.max(totalCount, targetLimit),
        );
        if (nextPageSize > recordsQuery.page_size) {
          viewStoreApi.setState((state) => ({
            recordsQuery: {
              ...state.recordsQuery,
              page: 1,
              page_size: nextPageSize,
            },
          }));
        }
        return true;
      }

      if (!useViewData || !currentViewId) {
        return false;
      }

      const hasRecord = (records?: ViewRecordsResponse | null): boolean =>
        Boolean(
          records?.records?.some(
            record =>
              String(record.id ?? '')
                .trim()
                .toLowerCase()
                .replace(/-/g, '') === normalizedRecordId,
          ),
        );

      const targetLoadedCount = Math.max(1, Math.ceil(hit.index || 1));
      for (
        let iteration = 0;
        iteration < ENSURE_HIT_MAX_LOAD_MORE_ITERATIONS;
        iteration += 1
      ) {
        const state = viewStoreApi.getState();
        const currentRecords =
          (state.currentViewRecords as ViewRecordsResponse | null | undefined) ??
          currentViewRecordsRef.current;
        if (hasRecord(currentRecords)) {
          return true;
        }

        const loadedCount = currentRecords?.records?.length ?? 0;
        const totalRecordCount =
          currentRecords?.matched_total ?? currentRecords?.total ?? loadedCount;
        if (loadedCount >= totalRecordCount || loadedCount >= targetLoadedCount) {
          return false;
        }

        await state.loadMoreCurrentViewRecords?.();

        const nextRecords =
          (viewStoreApi.getState().currentViewRecords as
            | ViewRecordsResponse
            | null
            | undefined) ?? currentViewRecordsRef.current;
        const nextLoadedCount = nextRecords?.records?.length ?? loadedCount;
        if (hasRecord(nextRecords)) {
          return true;
        }
        if (nextLoadedCount <= loadedCount) {
          return false;
        }
      }

      return hasRecord(
        (viewStoreApi.getState().currentViewRecords as ViewRecordsResponse | null | undefined) ??
          currentViewRecordsRef.current,
      );
    },
    [
      currentViewId,
      isCollabRuntime,
      recordsQuery.page_size,
      useViewData,
      viewStoreApi,
    ],
  );


  const {
    canvasSearchCursor,
    canvasSearchTargets,
    canvasSearchHitIndex,
    normalizedSearchQuery,
    searchFilteredRowsForDisplay,
    searchMetricRowsForDisplay,
  } = useDataGridSearch({
    searchQuery,
    searchScope,
    searchSelectedFieldIds,
    searchHideNotMatchRows,
    searchNavigateRequest,
    reportSearchState,
    serverSearchHits,
    serverSearchLoading,
    serverSearchTotalCount,
    useServerSearch,
    serverSearchHasMore,
    serverSearchLoadNextPage,
    orderedFields,
    organizationMembers,
    columns,
    gridApiRef,
    firstEditableField,
    fieldIdByName,
    groupedRowsForDisplay,
    searchableRows,
    ensureSearchRowsVisible,
    useViewData,
    currentViewId,
    resolvedCurrentView: effectiveCurrentView,
    recordsQuery,
    viewStoreApi,
    isCollabRuntime,
    ensureSearchHitVisible,
  });


  const visibleCommentRecordIds = React.useMemo(
    () => searchFilteredRowsForDisplay
      .filter((row) => {
        const rowType = (row as Record<string, unknown>).__rowType;
        return !(typeof rowType === 'string' && rowType.length > 0);
      })
      .map((row) => resolveRecordId(row as Record<string, unknown>))
      .filter((id): id is string => Boolean(id)),
    [searchFilteredRowsForDisplay],
  );
  const subscribeCommentChanges = React.useCallback(
    (onChange: () => void) => collabBridge.collab.onStatelessEvent(
      'table.comment.changed',
      onChange,
    ),
    [collabBridge.collab.onStatelessEvent],
  );
  const { counts: recordCommentCountMap } = useRecordCommentCounts({
    tableId: selectedTable?.id ?? null,
    recordIds: visibleCommentRecordIds,
    enabled: activeEngine.id === CANVAS_TABLE_ENGINE.id,
    subscribe: subscribeCommentChanges,
  });

  const {
    canvasColumnStatistics,
    canvasCommentCountMap,
    handleCanvasColumnStatisticAction,
    configuredColumnStatisticFuncs,
  } = useDataGridStatistics({
    activeEngineId: activeEngine.id,
    columns,
    resolvedCurrentView: effectiveCurrentView,
    fieldById,
    searchFilteredRowsForDisplay: searchMetricRowsForDisplay,
    searchHideNotMatchRows,
    normalizedSearchQuery,
    selectedTableId: selectedTable?.id ?? null,
    currentViewId,
    allowViewMutation,
    isPersonalViewEnabled,
    setPersonalViewDraft,
    updateView: updateViewForRuntime,
    t: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
    useCollabLocalStatistics:
      isCollabRuntime && !collabBridge.collab.isTruncated,
    recordCommentCountMap,
  });

  const {
    rowCounterLabel,
    rowCounterTooltipLabel,
    rowCounterAriaLabel,
    canvasStatisticSummaryLabel,
  } = useRowCounterDisplay({
    searchFilteredRowsForDisplay: searchMetricRowsForDisplay,
    searchHideNotMatchRows,
    totalCount,
    normalizedSearchQueryLength: normalizedSearchQuery.length,
    translateWithOptions,
  });

  const {
    canvasOptimisticRows,
    setCanvasOptimisticRows,
    reorderInFlightRef,
  } = useRowReorderOptimistic({
    searchFilteredRowsForDisplay,
    currentViewId,
    selectedTableId: selectedTable?.id,
  });

  const attachmentPreviewUrls = useAttachmentPreview(attachmentTasks);

  const rowsForGridDisplay = useGridRowAssembly({
    canvasOptimisticRows,
    searchFilteredRowsForDisplay,
    selectedTableId: selectedTable?.id,
    fields,
    attachmentTasks,
    attachmentPreviewUrls,
    removeAttachmentTask,
  });
  const loadMoreRecordsInFlightRef = React.useRef(false);
  const handleVisibleRegionChanged = React.useCallback<
    NonNullable<TableGridRendererProps['onVisibleRegionChanged']>
  >(
    (region) => {
      if (!useViewData || !currentViewId || isRecordsLoading || isLoadingMoreRecords) {
        return;
      }

      const recordsForScroll = currentViewRecordsForDisplay ?? currentViewRecords;
      const loadedRecordCount = recordsForScroll?.records.length ?? 0;
      const totalRecordCount =
        recordsForScroll?.matched_total ??
        recordsForScroll?.total ??
        loadedRecordCount;
      if (loadedRecordCount >= totalRecordCount || region.rowCount === 0) {
        return;
      }

      const shouldLoadMore =
        region.stopRowIndex >= region.rowCount - INFINITE_SCROLL_ROW_THRESHOLD;
      if (!shouldLoadMore || loadMoreRecordsInFlightRef.current) {
        return;
      }

      loadMoreRecordsInFlightRef.current = true;
      if (isCollabRuntime) {
        const nextPageSize = Math.min(
          Math.max(recordsQuery.page_size, loadedRecordCount) + DEFAULT_VIEW_LOAD_PAGE_SIZE,
          totalRecordCount,
        );
        if (nextPageSize > recordsQuery.page_size) {
          viewStoreApi.setState((state) => ({
            recordsQuery: {
              ...state.recordsQuery,
              page: 1,
              page_size: nextPageSize,
            },
          }));
        }
        queueMicrotask(() => {
          loadMoreRecordsInFlightRef.current = false;
        });
        return;
      }

      void loadMoreCurrentViewRecords().finally(() => {
        loadMoreRecordsInFlightRef.current = false;
      });
    },
    [
      currentViewId,
      currentViewRecords,
      currentViewRecordsForDisplay,
      isCollabRuntime,
      isLoadingMoreRecords,
      isRecordsLoading,
      loadMoreCurrentViewRecords,
      recordsQuery.page_size,
      useViewData,
      viewStoreApi,
    ],
  );

  const {
    showRecordHistory,
    recordHistoryRecordLabel,
    recordHistoryOps,
    recordHistoryTotal,
    isLoadingRecordHistory,
    handleOpenRecordHistory,
    handleCloseRecordHistory,
    handleLoadMoreRecordHistory,
    snapshotData,
    snapshotLoading,
    restoreLoading,
    handleRequestSnapshot,
    handleRequestRestore,
    clearSnapshotPreview,
  } = useUndoRedo({
    selectedTableId: selectedTable?.id ?? null,
    refreshRecords: refreshCurrentView,
    translate: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
    enableUndoRedo: false,
    enableKeyboardShortcuts: false,
  });

  const rawCurrentViewRecordIdSet = React.useMemo(
    () =>
      new Set(
        (currentViewRecords?.records ?? []).map((record) => String(record.id))
      ),
    [currentViewRecords]
  );
  const recordEditorVisibleRecordIds = React.useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();

    rowsForGridDisplay.forEach((row) => {
      const rowData = row as Record<string, unknown>;
      if (!isDataRecordRow(rowData)) {
        return;
      }

      const recordId = resolveRecordId(rowData);
      if (
        !recordId ||
        seen.has(recordId) ||
        (useViewData && !rawCurrentViewRecordIdSet.has(recordId))
      ) {
        return;
      }

      seen.add(recordId);
      ids.push(recordId);
    });

    return ids;
  }, [isDataRecordRow, rawCurrentViewRecordIdSet, rowsForGridDisplay, useViewData]);

  const {
    showEditDialog,
    editingRecord,
    initialCommentsOpen,
    initialFocusTarget,
    openRecordEditorWithComments,
    handleRecordDialogOpenChange,
    canNavigatePrev,
    canNavigateNext,
    navigateToPrevRecord,
    navigateToNextRecord,
  } = useDataGridRecordEditor({
    useViewData,
    records,
    currentViewRecords,
    visibleRecordIds: recordEditorVisibleRecordIds,
    registerRecordEditor,
  });

  const hasInlineAddRow = React.useMemo(() => {
    const hasAddRow = groupedRows.some(
      (row) => row?.__rowType === 'add' || row?.__rowType === 'group_add',
    );
    const hasCollapsedGroupHeader = groupedRows.some(
      (row) =>
        row?.__rowType === 'group_header' &&
        Boolean((row as Record<string, unknown>).__groupCollapsed),
    );
    return hasAddRow || hasCollapsedGroupHeader;
  }, [groupedRows]);

  const draftGroupPath = React.useMemo(() => {
    if (!draftRowData || !hasGrouping) {
      return undefined;
    }
    if (draftAddRowContext?.group_path) {
      return draftAddRowContext.group_path;
    }
    const inlineDraft = groupedRowsForDisplay.find((row) => {
      const rowData = row as Record<string, unknown>;
      return (
        rowData.__rowType === 'draft' &&
        isDraftGridRow(rowData, DRAFT_ROW_ID) &&
        typeof rowData.__groupPath === 'string'
      );
    }) as Record<string, unknown> | undefined;
    return inlineDraft?.__groupPath as string | undefined;
  }, [
    draftAddRowContext?.group_path,
    draftRowData,
    groupedRowsForDisplay,
    hasGrouping,
  ]);

  const { pinnedBottomRowData, handleToggleGroup, config } =
    useDataGridPresentationModel({
      currentViewId,
      currentViewConfig:
        (effectiveCurrentView?.config as Record<string, unknown> | undefined) ??
        null,
      currentViewSorts: effectiveCurrentView?.sorts as
        | Array<{
            field_id: string;
            direction: 'asc' | 'desc';
            priority?: number;
          }>
        | null
        | undefined,
      tableFontSize,
      fieldNameById,
      toggleGroupCollapse,
      hasInlineAddRow,
      draftRowData,
      rowsDataLength: rowsData.length,
      setTotalRowsCount,
    });

  const { handleFilterChanged } = useViewFilterSync({
    currentViewId,
    draftFilters,
    fieldIdByName,
    setDraftFilters,
    applyDraft: applyDraftForRuntime,
    allowMutation: allowViewMutation,
    translate: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
  });

  const { handleColumnMoved } = useColumnReorderPersistence({
    selectedTableId: selectedTable?.id ?? null,
    fields,
    currentView: effectiveCurrentView,
    allowMutation: allowViewMutation,
    isPersonalViewEnabled,
    setPersonalViewDraft,
    updateView: updateViewForRuntime,
    translate: (key) => String(t(key as any)),
  });

  const {
    showFieldDeleteConfirm,
    deletingField,
    setShowFieldDeleteConfirm,
    handleDeleteField,
    handleConfirmDeleteField,
    handleHideField,
    handleSetPrimaryField,
    refreshFieldsAndView,
  } = useDataGridFieldContextMenu({
    fields,
    currentView: effectiveCurrentView,
    selectedTableId: selectedTable?.id ?? null,
    selectedTableSchemaVersion: selectedTable?.schema_version,
    loadFields,
    refreshTable: getTable,
    loadViews: wsLoadViews,
    refreshCurrentView,
    updateView: updateViewForRuntime,
    translate: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
    isPersonalViewEnabled,
    isCollabSyncActive: isCollabOnline && !isCollabFallback,
    deleteFieldForRuntime,
  });


  const {
    notifyLockedViewDenied,
    handleDuplicateFieldFromMenu,
    handleFilterFieldFromMenu,
    handleGroupFieldFromMenu,
  } = useDataGridFieldOps({
    fields,
    selectedTableId: selectedTable?.id ?? null,
    currentViewId,
    resolvedCurrentView: effectiveCurrentView,
    allowViewMutation,
    draftFilters,
    setDraftFilters,
    setDraftGroups,
    applyDraft: applyDraftForRuntime,
    refreshFieldsAndView,
    t: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
    isTableReadonly: effectiveReadonly,
    isCollabSyncActive: isCollabOnline && !isCollabFallback,
    createFieldForRuntime: isCollabRuntime ? createFieldForRuntime : undefined,
  });

  // Build field name map and field type map for record history display
  const fieldNameMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields) {
      map[f.id] = f.name;
    }
    return map;
  }, [fields]);

  const fieldTypeMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields) {
      map[f.id] = f.field_type;
    }
    return map;
  }, [fields]);

  const tableEngineMetricsSummary = tableEngineMetricsSnapshot.current;

  const formatMetricValue = React.useCallback(
    (value: number | null, options?: { digits?: number; suffix?: string }) => {
      if (value == null || !Number.isFinite(value)) {
        return '--';
      }
      const digits = options?.digits ?? 1;
      const suffix = options?.suffix ?? '';
      return `${value.toFixed(digits)}${suffix}`;
    },
    [],
  );

  const tableEngineMetricsLabel = React.useMemo(() => {
    if (!tableEngineMetricsSummary) {
      return null;
    }
    const fpsP95 = formatMetricValue(tableEngineMetricsSummary.scrollFps.p95);
    const latencyP95 = formatMetricValue(
      tableEngineMetricsSummary.inputLatencyMs.p95,
      {
        suffix: 'ms',
      },
    );
    const errorRate = formatMetricValue(
      tableEngineMetricsSummary.errorRate.ratePct,
      {
        digits: 2,
        suffix: '%',
      },
    );
    return String(
      t('table:engineMetrics.values', {
        fpsP95,
        latencyP95,
        errorRate,
      }),
    );
  }, [formatMetricValue, tableEngineMetricsSummary, t]);

  const handleCanvasRowExpand = React.useCallback(
    (rowData: unknown) => {
      if (!rowData || typeof rowData !== 'object') {
        return;
      }
      const row = rowData as Record<string, unknown>;

      // Group header row: toggle collapse
      if (row.__rowType === 'group_header') {
        const groupPath =
          typeof row.__groupPath === 'string' ? row.__groupPath : '';
        if (groupPath) {
          handleToggleGroup(groupPath);
        }
        return;
      }

      // 打开行详情前收起分组草稿 Prefilling，避免「新增条 + 编辑侧栏」两层叠出
      handleCancelDraftRow();
      // Data row: open record detail editor
      openRecordEditor(row as TableGridRow);
    },
    [handleCancelDraftRow, handleToggleGroup, openRecordEditor],
  );

  const handleCanvasCommentCountClick = React.useCallback(
    (rowData: unknown) => {
      if (!rowData || typeof rowData !== 'object') return;
      handleCancelDraftRow();
      openRecordEditorWithComments(rowData as TableGridRow);
    },
    [handleCancelDraftRow, openRecordEditorWithComments],
  );

  const handleCanvasRecordComment = React.useCallback(
    (rowData: unknown) => {
      if (!rowData || typeof rowData !== 'object') return;
      handleCancelDraftRow();
      openRecordEditorWithComments(rowData as TableGridRow, {
        focusTarget: RecordFormFocusTarget.CommentInput,
      });
    },
    [handleCancelDraftRow, openRecordEditorWithComments],
  );

  // -- Link cell editor --
  const {
    showLinkEditor,
    linkEditorState,
    linkedRecordDetail,
    handleLinkCellExpand,
    handleLinkTagClick,
    handleCloseLinkEditor,
    handleSaveLinkEditor,
    handleOpenLinkedRecord,
    handleCloseLinkedRecordDetail,
  } = useDataGridLinkEditor({
    fields,
    records,
    selectedTableId: selectedTable?.id ?? null,
    updateRecord: updateRecordWithMetrics,
    mergeIncrementalRecords,
    latestVersion,
    onSymmetricLinkSaved: React.useCallback(
      (foreignTableId: string) => {
        // 自关联时刷新当前视图；跨表下次进入读服务端真值
        if (foreignTableId && foreignTableId === selectedTable?.id) {
          void refreshCurrentView?.();
        }
      },
      [selectedTable?.id, refreshCurrentView],
    ),
  });

  // 协作在线时，子记录层级移动 + 排序都走 Y.Doc：
  // 1) 把被拖根记录的父字段写进 Y.Doc，由 collab persist 同步 LinkRecord（见
  //    CollabService._sync_collab_link_cell）。只发 {id}，标题由后端按目标主字段重建
  //    后经 Y.Doc 回流；本端 computeSubRecordTreeOrder 以父 cell 为准立即重聚类。
  // 2) 按落点更新 Y.Doc 行序（collab.reorderRows），否则同父纯排序父级不变、行序
  //    不动，拖动排序不可见。两步都在 Y.Doc 上完成，避免 REST 在协作态被旧 Y.Doc
  //    覆盖而「回弹」。
  const applyCollabTreeMove = React.useCallback(
    async (args: {
      movedRootId: string;
      changeParent: boolean;
      newParentId: string | null;
      movedRowIds: string[];
      anchorRowId?: string | null;
      position: 'before' | 'after' | 'end';
    }): Promise<boolean> => {
      if (!isCollabRuntime) {
        return false;
      }
      const { movedRootId, changeParent, newParentId, movedRowIds, anchorRowId, position } = args;
      // 刚创建父记录字段后，fields / 协作 fieldId→hex 映射可能尚未就绪。
      // 等到字段进入 store（映射随 fields 同步重建）再写；超时则交由调用方回滚，
      // 切勿退回 REST（协作态 Y.Doc 未写会回弹，表现为前几次拖入失败）。
      if (changeParent && subRecordParentFieldId) {
        // 等渲染同步的 fields（与协作 fieldId→hex 同帧），勿读全局 tableStore
        const parentFieldReady = await waitForCondition(
          () =>
            fieldsRef.current.some(
              (field) => field.id === subRecordParentFieldId,
            ),
          { timeoutMs: 3000 },
        );
        if (!parentFieldReady) {
          return false;
        }
        const parentValue = newParentId ? { id: newParentId } : null;
        void updateRecordWithMetrics(movedRootId, {
          fields: { [subRecordParentFieldId]: parentValue },
        });
      }

      const orderedIds =
        Array.isArray(movedRowIds) && movedRowIds.length > 0
          ? movedRowIds
          : [movedRootId];
      const currentRowOrder = collabBridge.collab.rowOrder;
      const movedSet = new Set(orderedIds);
      const remaining = currentRowOrder.filter((id) => !movedSet.has(id));
      let targetIndex = remaining.length;
      if (position !== 'end' && anchorRowId) {
        const anchorIdx = remaining.indexOf(anchorRowId);
        if (anchorIdx >= 0) {
          targetIndex = position === 'after' ? anchorIdx + 1 : anchorIdx;
        }
      }
      collabBridge.collab.reorderRows(orderedIds, targetIndex);
      return true;
    },
    [isCollabRuntime, subRecordParentFieldId, updateRecordWithMetrics, collabBridge.collab],
  );

  const { handleCanvasRowMoved } = useCanvasRowReorder({
    selectedTableId: selectedTable?.id ?? null,
    rowsForGridDisplay,
    setCanvasOptimisticRows,
    rowsData,
    treeDataForMove,
    subRecordParentFieldId,
    fieldById,
    resolvedCurrentView: effectiveCurrentView,
    useViewData,
    currentViewId,
    refreshCurrentView,
    loadRecordsByTable,
    page,
    pageSize,
    t: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
    reorderInFlightRef,
    isTableReadonly: effectiveReadonly,
    collabActive: isCollabRuntime,
    applyCollabTreeMove,
  });

  const {
    resolveContextRowId,
    resolveContextRowLabel,
    handleCanvasRowContextMenu,
    handleFieldMenuAction,
    canvasFieldMenuLabels,
    canvasRecordMenuLabels,
    canvasStatisticMenuLabels,
    canvasEditorLabels,
    allRecordsCheckboxTooltip,
  } = useDataGridContextMenus({
    selectedTable,
    fields,
    fieldById,
    fieldByName,
    firstEditableField,
    resolvedCurrentView: effectiveCurrentView,
    allowViewMutation,
    isPersonalViewEnabled,
    isTableReadonly: effectiveReadonly,
    fieldSettingHostId,
    setPersonalViewDraft,
    updateView: updateViewForRuntime,
    handleSortFromMenu,
    handleDeleteField,
    handleHideField,
    handleSetPrimaryField,
    handleOpenRecordHistory,
    handleDuplicateFieldFromMenu,
    handleFilterFieldFromMenu,
    handleGroupFieldFromMenu,
    notifyLockedViewDenied,
    t: (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
  });

  const handleTreeToggle = React.useCallback(
    (recordId: string) => {
      if (!currentViewId) return;
      // 首次从「默认根展开」进入显式 Set 时，把当前已展开的根节点一并写入，
      // 否则点子记录箭头只会把 child 放进 Set，父级因不在 Set 里被误折叠。
      const seedExpandedIds =
        treeExpandedRecords == null
          ? rowsForGridDisplay
              .filter(
                (row) =>
                  (row as { __treeDepth?: number }).__treeDepth === 0 &&
                  (row as { __treeHasChildren?: boolean }).__treeHasChildren === true &&
                  (row as { __treeExpanded?: boolean }).__treeExpanded === true,
              )
              .map((row) => resolveRecordId(row) ?? '')
              .filter((id) => id.length > 0)
          : undefined;
      toggleTreeRecordExpanded(
        currentViewId,
        recordId,
        seedExpandedIds ? { seedExpandedIds } : undefined,
      );
    },
    [currentViewId, toggleTreeRecordExpanded, treeExpandedRecords, rowsForGridDisplay],
  );


  // ── 协作者光标 → canvasOverlay.collaborators（按 tableId 隔离） ──
  const peerCursors = useCollabPeerCursorsForTable(selectedTable?.id ?? null);
  const canvasCollaborators = React.useMemo(() => {
    if (!peerCursors.length) return undefined;
    return peerCursors.map(pc => ({
      userId: pc.userId,
      userName: pc.userName,
      borderColor: pc.userColor,
      activeCellId: [pc.recordId, pc.fieldId] as [string, string],
      timeStamp: Date.now(),
    }));
  }, [peerCursors]);

  const resolvedEngineConfig = React.useMemo<TableGridConfig>(() => {
    const baseConfig = (config as TableGridConfig) ?? {};
    if (activeEngine.id !== CANVAS_TABLE_ENGINE.id) {
      return baseConfig;
    }

    const baseFreezeState = baseConfig.freeze?.state;
    const hasExplicitFreezeState = Array.isArray(
      baseFreezeState?.leftColumnFields,
    );
    const freezeColumnCount = hasExplicitFreezeState
      ? null
      : resolveFreezeColumnCountFromViewConfig(
          (effectiveCurrentView?.config as
            | Record<string, unknown>
            | null
            | undefined) ?? null,
          columns.length,
        );

    const derivedLeftColumnFields = hasExplicitFreezeState
      ? baseFreezeState?.leftColumnFields
      : freezeColumnCount == null
        ? undefined
        : columns.slice(0, freezeColumnCount).map((column) => column.field);

    const resolvedFreezeConfig =
      derivedLeftColumnFields === undefined
        ? baseConfig.freeze
        : {
            ...baseConfig.freeze,
            state: {
              ...baseFreezeState,
              leftColumnFields: derivedLeftColumnFields,
            },
          };

    return {
      ...baseConfig,
      ...(resolvedFreezeConfig ? { freeze: resolvedFreezeConfig } : {}),
      clipboard: {
        ...baseConfig.clipboard,
        copyHeaders: true,
      },
      canvasOverlay: {
        ...(baseConfig.canvasOverlay ?? {}),
        fieldMenuLabels: {
          ...(baseConfig.canvasOverlay?.fieldMenuLabels ?? {}),
          ...canvasFieldMenuLabels,
        },
        recordMenuLabels: {
          ...(baseConfig.canvasOverlay?.recordMenuLabels ?? {}),
          ...canvasRecordMenuLabels,
        },
        statisticMenuLabels: {
          ...(baseConfig.canvasOverlay?.statisticMenuLabels ?? {}),
          ...canvasStatisticMenuLabels,
        },
        editorLabels: {
          ...(baseConfig.canvasOverlay?.editorLabels ?? {}),
          ...canvasEditorLabels,
        },
        editorShiftEnterHint: String(t('table:grid.editorShiftEnterHint')),
        allRecordsCheckboxTooltip,
        searchCursor: canvasSearchCursor,
        searchTargets: canvasSearchTargets,
        searchHitIndex: canvasSearchHitIndex,
        collaborators: canvasCollaborators,
        statisticSummaryLabel: canvasStatisticSummaryLabel,
        prefilling: {
          visible: Boolean(draftRowData),
          isLoading: isDraftSubmitting,
          title: String(t('table:grid.prefillingRowTitle')),
          cancelLabel: String(t('table:actions.cancelDraft')),
          onCancel: handleCancelDraftRow,
          onClickOutside: () => { void handleCommitDraftRow() },
        },
      },
    };
  }, [
    activeEngine.id,
    canvasFieldMenuLabels,
    canvasRecordMenuLabels,
    canvasStatisticMenuLabels,
    canvasEditorLabels,
    allRecordsCheckboxTooltip,
    canvasStatisticSummaryLabel,
    canvasSearchCursor,
    canvasSearchTargets,
    canvasSearchHitIndex,
    canvasCollaborators,
    columns,
    config,
    draftRowData,
    handleCancelDraftRow,
    handleCommitDraftRow,
    isDraftSubmitting,
    effectiveCurrentView?.config,
    t,
  ]);

  const canvasRowControls = React.useMemo<TableGridRowControlItem[]>(() => {
    if (activeEngine.id !== CANVAS_TABLE_ENGINE.id) {
      return [];
    }
    if (effectiveReadonly) {
      return [{ type: 'checkbox' }];
    }
    return [{ type: 'drag' }, { type: 'checkbox' }];
  }, [activeEngine.id, effectiveReadonly]);
  const createBlankAddRowInflightRef = React.useRef(false);
  const startDraftRow = React.useCallback(
    async (
      addRowContext?: DataGridAddRowContext,
      displayRowIndex?: number,
    ) => {
      if (createBlankAddRowInflightRef.current) {
        return;
      }
      const tableId = selectedTable?.id;
      if (!tableId || effectiveReadonly) {
        return;
      }
      if (draftRowData) {
        handleAddRowClick(addRowContext);
        return;
      }

      // 起草稿时关掉编辑侧栏，避免 Prefilling 与 RecordForm 叠两层
      if (showEditDialog) {
        handleRecordDialogOpenChange(false)
      }

      const createPlan =
        typeof displayRowIndex === 'number' && displayRowIndex >= 0
          ? buildCreatePlanFromDisplayRowIndex(displayRowIndex)
          : undefined;
      const prefillValues = createPlan?.prefillValues ?? buildDraftPrefillValues(addRowContext) ?? {};
      const orderContext = createPlan?.orderContext ?? buildCreateRecordOrderContext(addRowContext);
      const hasActiveFilters = Boolean(
        effectiveCurrentView?.filters?.some((filter) => filter?.enabled !== false),
      );
      const hasActiveSorts = Boolean(effectiveCurrentView?.sorts?.length);
      const isCollapsedGroupAppend = Boolean(
        addRowContext?.group_path &&
          groupedRows.some(
            (row) =>
              (row as Record<string, unknown>).__rowType === 'group_header' &&
              (row as Record<string, unknown>).__groupPath === addRowContext.group_path &&
              Boolean((row as Record<string, unknown>).__groupCollapsed),
          ),
      );

      if (isCollapsedGroupAppend || (createPlan && (hasActiveFilters || hasActiveSorts))) {
        log.debug('视图投影或折叠分组保留行内草稿', {
          tableId,
          displayRowIndex,
          hasActiveFilters,
          hasActiveSorts,
          isCollapsedGroupAppend,
          orderPosition: orderContext?.position,
          anchorRecordId: orderContext?.anchor_record_id,
        });
        handleAddRowClick({
          ...addRowContext,
          ...(createPlan ? { order_context: createPlan.orderContext } : {}),
        });
        return;
      }
      const createPayload = Object.entries(prefillValues).reduce<Record<string, unknown>>(
        (payload, [fieldKey, value]) => {
          if (value === undefined || value === null || value === '') {
            return payload;
          }
          const fieldMeta = fields.find((field) => field.id === fieldKey || field.name === fieldKey);
          if (!fieldMeta) {
            return payload;
          }
          payload[fieldMeta.id] = value;
          return payload;
        },
        {},
      );

      createBlankAddRowInflightRef.current = true;
      try {
        log.debug('创建空记录追加意图', {
          tableId,
          displayRowIndex,
          groupPath: addRowContext?.group_path,
          groupFieldCount: Object.keys(addRowContext?.group_values ?? {}).length,
          orderPosition: orderContext?.position,
          anchorRecordId: orderContext?.anchor_record_id,
        });
        const createdRecord = await createRecordWithMetrics({
          table_id: tableId,
          data: createPayload,
          fields: createPayload,
          fieldKeyType: 'id',
          order_context: orderContext,
        });
        if (createdRecord) {
          await handleRecordCreatedVisibleForEditing(createdRecord as TableRecord);
        }
      } catch (error) {
        log.warn('空记录立即创建失败，回退到行内草稿', {
          tableId,
          displayRowIndex,
          groupPath: addRowContext?.group_path,
          error: error instanceof Error ? error.message : String(error),
        });
        handleAddRowClick({
          ...addRowContext,
          ...(createPlan ? { order_context: createPlan.orderContext } : {}),
        });
      } finally {
        createBlankAddRowInflightRef.current = false;
      }
    },
    [
      buildCreateRecordOrderContext,
      buildCreatePlanFromDisplayRowIndex,
      buildDraftPrefillValues,
      createRecordWithMetrics,
      draftRowData,
      effectiveCurrentView?.filters,
      effectiveCurrentView?.sorts,
      effectiveReadonly,
      fields,
      groupedRows,
      handleAddRowClick,
      handleRecordCreatedVisibleForEditing,
      handleRecordDialogOpenChange,
      selectedTable?.id,
      showEditDialog,
    ],
  )

  const handleCanvasRowAppend = React.useCallback(
    (context?: {
      rowIndex?: number
      rowData?: unknown
      groupPath?: string | null
      groupValues?: Record<string, unknown>
    }) => {
      if (
        (typeof context?.groupPath === 'string' && context.groupPath.length > 0) ||
        (context?.groupValues && Object.keys(context.groupValues).length > 0)
      ) {
        void startDraftRow({
          group_path:
            typeof context?.groupPath === 'string' && context.groupPath.length > 0
              ? context.groupPath
              : undefined,
          group_values:
            context?.groupValues && typeof context.groupValues === 'object'
              ? context.groupValues
              : undefined,
        }, context?.rowIndex);
        return;
      }

      const rowData = context?.rowData as Record<string, unknown> | undefined;
      if (!rowData || typeof rowData !== 'object') {
        void startDraftRow(undefined, context?.rowIndex);
        return;
      }

      if (rowData.__rowType === 'group_add') {
        void startDraftRow({
          group_path:
            typeof context?.groupPath === 'string'
              ? context.groupPath
              : typeof rowData.__groupPath === 'string'
                ? rowData.__groupPath
                : undefined,
          group_values:
            rowData.__groupValues && typeof rowData.__groupValues === 'object'
              ? (rowData.__groupValues as Record<string, unknown>)
              : undefined,
        }, context?.rowIndex);
        return;
      }

      if (
        rowData.__rowType === 'group_header' &&
        Boolean(rowData.__groupCollapsed)
      ) {
        void startDraftRow({
          group_path:
            typeof context?.groupPath === 'string'
              ? context.groupPath
              : typeof rowData.__groupPath === 'string'
                ? rowData.__groupPath
                : undefined,
          group_values:
            rowData.__groupValues && typeof rowData.__groupValues === 'object'
              ? (rowData.__groupValues as Record<string, unknown>)
              : undefined,
        }, context?.rowIndex);
        return;
      }

      void startDraftRow(undefined, context?.rowIndex);
    },
    [startDraftRow],
  );

  React.useEffect(() => {
    registerAddRowHandler(() => {
      if (!effectiveReadonly) {
        void startDraftRow();
      }
    });
  }, [effectiveReadonly, registerAddRowHandler, startDraftRow]);

  const handleCanvasColumnAppend = React.useCallback(() => {
    useFieldSettingStore
      .getState()
      .openForAdd(selectedTable?.id ?? null, fieldSettingHostId);
  }, [fieldSettingHostId, selectedTable?.id]);

  const selectOptionCreateInflightRef = React.useRef<Map<string, Promise<void>>>(new Map());
  const selectOptionCreateChainRef = React.useRef<Map<string, Promise<void>>>(new Map());
  const selectOptionChoicesCacheRef = React.useRef<Map<string, Array<string | Record<string, unknown>>>>(new Map());
  const normalizeSelectOptionValue = React.useCallback((value: unknown) => String(value ?? '').trim(), []);
  const extractSelectOptionValue = React.useCallback(
    (choice: string | Record<string, unknown>) => (
      typeof choice === 'string'
        ? normalizeSelectOptionValue(choice)
        : normalizeSelectOptionValue(choice.value ?? choice.id ?? choice.name ?? choice.label)
    ),
    [normalizeSelectOptionValue],
  );
  React.useEffect(() => {
    for (const field of fields) {
      selectOptionChoicesCacheRef.current.set(field.id, field.options?.choices ?? []);
    }
  }, [fields]);

  // Add a new option to a select/multi_select field's choices and persist it
  const handleSelectOptionAdd = React.useCallback(
    async (fieldName: string, optionName: string) => {
      const fieldMeta = fields.find((f) => f.id === fieldName || f.name === fieldName);
      if (!fieldMeta) return;

      const normalizedOptionName = normalizeSelectOptionValue(optionName);
      if (!normalizedOptionName) return;

      const currentChoices = selectOptionChoicesCacheRef.current.get(fieldMeta.id) ?? fieldMeta.options?.choices ?? [];
      const currentValues = currentChoices.map((c) => extractSelectOptionValue(c as string | Record<string, unknown>));

      if (currentValues.includes(normalizedOptionName)) return;

      const inflightKey = `${fieldMeta.id}:${normalizedOptionName}`;
      const existingPromise = selectOptionCreateInflightRef.current.get(inflightKey);
      if (existingPromise) {
        await existingPromise;
        return;
      }

      const previousFieldCreate = selectOptionCreateChainRef.current.get(fieldMeta.id) ?? Promise.resolve();
      const createPromise = previousFieldCreate.catch(() => undefined).then(async () => {
        const latestChoices = selectOptionChoicesCacheRef.current.get(fieldMeta.id) ?? fieldMeta.options?.choices ?? [];
        const latestValues = latestChoices.map((c) => extractSelectOptionValue(c as string | Record<string, unknown>));
        if (latestValues.includes(normalizedOptionName)) {
          return;
        }

        const updatedChoices = normalizeSelectChoices([...latestChoices, normalizedOptionName]);
        // CMS-005: 更新成功后刷新 fields，触发 IS-05 将新 choices 同步到 Y.Doc metaMap
        const updatedField = await FieldApiService.updateField(fieldMeta.id, {
          options: { ...fieldMeta.options, choices: updatedChoices },
        });
        const confirmedChoices = updatedField.options?.choices ?? updatedChoices;
        const confirmedValues = confirmedChoices.map((c) => extractSelectOptionValue(c as string | Record<string, unknown>));
        if (!confirmedValues.includes(normalizedOptionName)) {
          throw new Error(`Create option failed: ${normalizedOptionName}`);
        }
        selectOptionChoicesCacheRef.current.set(fieldMeta.id, confirmedChoices as Array<string | Record<string, unknown>>);
        const tableId = selectedTable?.id;
        if (tableId) await loadFields(tableId);
      });

      selectOptionCreateInflightRef.current.set(inflightKey, createPromise);
      selectOptionCreateChainRef.current.set(fieldMeta.id, createPromise);
      try {
        await createPromise;
      } catch (err) {
        reportRendererError('handleSelectOptionAdd', err);
        throw err;
      } finally {
        selectOptionCreateInflightRef.current.delete(inflightKey);
        if (selectOptionCreateChainRef.current.get(fieldMeta.id) === createPromise) {
          selectOptionCreateChainRef.current.delete(fieldMeta.id);
        }
      }
    },
    [extractSelectOptionValue, fields, loadFields, normalizeSelectOptionValue, reportRendererError, selectedTable?.id],
  );

  const handleDownloadAttachment = React.useCallback(
    (item: TableGridAttachmentDownloadItem) => downloadTabDataAttachment(item, tChat, {
      tableId: selectedTable?.id,
    }),
    [selectedTable?.id, tChat],
  );
  const handleDownloadAllAttachments = React.useCallback(
    (items: TableGridAttachmentDownloadItem[]) =>
      downloadTabDataAttachmentsBatch(items, tChat, {
        tableId: selectedTable?.id,
      }),
    [selectedTable?.id, tChat],
  );
  const loadTabDataAttachmentPreviewUi = React.useCallback(
    () => loadElectronAttachmentPreviewUi({ tableId: selectedTable?.id }),
    [selectedTable?.id],
  );

  const handleCanvasAttachmentUpload = React.useCallback<
    NonNullable<TableGridRendererProps['onAttachmentUpload']>
  >(
    async ({ rowData, field, fieldId, files, currentValue, onProgress }) => {
      if (!files || files.length === 0) {
        return [];
      }

      const tableId = selectedTable?.id;
      if (!tableId) {
        throw new Error(String(t('table:grid.attachmentUploadMissingTable')));
      }

      const normalizedFieldId =
        typeof fieldId === 'string' && fieldId.trim().length > 0
          ? fieldId.trim()
          : fieldByName.get(field)?.id;
      if (!normalizedFieldId) {
        throw new Error(String(t('table:grid.attachmentUploadMissingField')));
      }

      // 网格进度合并用客户端行身份。
      const identityRecordId = isDraftGridRow(rowData, DRAFT_ROW_ID)
        ? undefined
        : resolveRecordId(rowData) ?? undefined;

      const mapUploadItems = (
        items: Array<{
          uploadItemId: string;
          file: File;
          status: 'pending' | 'uploading' | 'completed' | 'error' | 'cancelled';
          progress: number;
          error?: string;
        }>,
      ) =>
        items.map((item) => ({
          uploadItemId: item.uploadItemId,
          file: item.file,
          fileName: item.file.name,
          status: item.status,
          progress:
            Number.isFinite(item.progress) && item.progress >= 0
              ? Math.min(1, item.progress)
              : 0,
          error: item.error,
        }));

      const uploadKey = buildAttachmentUploadKey(
        tableId,
        normalizedFieldId,
        identityRecordId,
      );
      const attachmentStore = useAttachmentStore.getState();
      const unsubscribe =
        typeof onProgress === 'function'
          ? useAttachmentStore.subscribe((state) => {
              const taskItems = state.tasks[uploadKey]?.items ?? [];
              onProgress(mapUploadItems(taskItems));
            })
          : null;
      try {
        const references = await attachmentStore.startUpload({
          tableId,
          fieldId: normalizedFieldId,
          // 上传先创建未绑定引用，随后由同一次 updateRecord 绑定到记录。
          // 若在完成上传前关联 record，服务端读取旧值时已能看见该附件，
          // 首次新增会被历史误写成“附件 → 同一附件”。
          recordId: undefined,
          taskRecordId: identityRecordId,
          files,
          onRetrySuccess: async (retryReferences) => {
            const currentAttachments = Array.isArray(currentValue)
              ? currentValue
              : currentValue == null
                ? []
                : [currentValue];
            await handleCellValueChanged(
              rowData,
              field,
              [...currentAttachments, ...retryReferences],
              currentValue,
            );
          },
        });

        const latestUploads =
          useAttachmentStore.getState().tasks[uploadKey]?.items ?? [];
        if (typeof onProgress === 'function') {
          onProgress(mapUploadItems(latestUploads));
        }
        return references;
      } catch (error) {
        attachmentStore.removeTask(uploadKey);
        throw error;
      } finally {
        unsubscribe?.();
      }
    },
    [fieldByName, handleCellValueChanged, selectedTable?.id, t],
  );

  const handleCanvasAttachmentFileRef = React.useMemo(
    () =>
      createAttachmentFileRefHandler({
        tableId: selectedTable?.id,
        resolveFieldId: (field, fieldId) => {
          if (typeof fieldId === 'string' && fieldId.trim().length > 0) {
            return fieldId.trim();
          }
          return fieldByName.get(field)?.id;
        },
        resolveRecordId: (rowData) =>
          resolveRestSafeRecordId(
            rowData,
            collabBridge.getCreateLifecycle,
            DRAFT_ROW_ID,
          ),
        missingTableMessage: String(t('table:grid.attachmentUploadMissingTable')),
        missingFieldMessage: String(t('table:grid.attachmentUploadMissingField')),
        missingRecordMessage: String(t('tips.saveBeforeUpload', {
          ns: 'attachments',
          defaultValue: '请先保存记录后再上传附件',
        })),
        fileTypeNotAllowedMessage: String(t('table:grid.attachmentFileTypeNotAllowed', {
          defaultValue: '不支持的文件类型',
        })),
      }),
    [collabBridge.getCreateLifecycle, fieldByName, selectedTable?.id, t],
  );

  const gridRendererProps = React.useMemo<TableGridRendererProps>(
    () => ({
      theme,
      isLoading: gridLoading,
      columns,
      rows: rowsForGridDisplay,
      rowControls:
        activeEngine.id === CANVAS_TABLE_ENGINE.id
          ? canvasRowControls
          : undefined,
      rowIndexVisible: true,
      commentCountMap:
        activeEngine.id === CANVAS_TABLE_ENGINE.id
          ? canvasCommentCountMap
          : undefined,
      columnStatistics:
        activeEngine.id === CANVAS_TABLE_ENGINE.id
          ? canvasColumnStatistics
          : undefined,
      pinnedBottomRowData,
      config: resolvedEngineConfig,
      isFullWidthRow: isDataGridFullWidthRow,
      fullWidthCellRenderer: DataGridFullWidthRowRenderer,
      fullWidthCellRendererParams: {
        isReadonly: effectiveReadonly,
        onAddRow: effectiveReadonly ? undefined : startDraftRow,
        onCommitDraft: effectiveReadonly
          ? undefined
          : () => {
              void handleCommitDraftRow();
            },
        onCancelDraft: effectiveReadonly ? undefined : handleCancelDraftRow,
        onToggleGroup: handleToggleGroup,
        addRowLabel: String(t('table:actions.addRow')),
        groupAddRowLabel: String(t('table:actions.addRowInGroup')),
        addRowDraftLabel: String(t('table:actions.addRowDraft')),
        saveDraftLabel: String(t('table:actions.saveDraft')),
        cancelDraftLabel: String(t('table:actions.cancelDraft')),
        submittingDraftLabel: String(t('table:actions.submittingDraft')),
        hasDraft: effectiveReadonly ? false : Boolean(draftRowData),
        draftGroupPath,
        isDraftSubmitting,
        ungroupedLabel: String(t('table:group.ungrouped')),
      },
      postSortRows: postSortRowsKeepSpecialRowsAtBottom,
      onGridReady: handleGridReady,
      onFirstDataRendered: handleFirstDataRendered,
      onTableApiReady: handleTableApiReady,
      onVisibleRegionChanged: handleVisibleRegionChanged,
      onSelectionChanged: handleSelectionChanged,
      onSelectionStateChange: handleCollabCellFocus,
      onSortChanged: effectiveReadonly ? undefined : handleSortChanged,
      onFilterChanged: effectiveReadonly ? undefined : handleFilterChanged,
      // viewer 等只读角色：移除所有写操作 handler。Canvas 依据 handler 是否存在
      // 决定是否渲染 add-row / add-column「+」及右键菜单的写动作（见 InteractionLayer
      // isRowAppendEnable / isColumnAppendEnable），因此只读时这些入口会一并消失。
      onCellValueChanged: effectiveReadonly
        ? undefined
        : (rowData, field, newValue, oldValue) => {
            void handleCellValueChanged(rowData, field, newValue, oldValue).catch(
              (error) => {
                reportRendererError('onCellValueChanged', error);
              },
            );
          },
      onSelectOptionAdd: effectiveReadonly ? undefined : handleSelectOptionAdd,
      onCellEditingStopped: effectiveReadonly ? undefined : handleCellEditingStopped,
      onColumnHeaderContextMenu: effectiveReadonly ? undefined : handleFieldMenuAction,
      onColumnMoved: effectiveReadonly ? undefined : handleColumnMoved,
      onColumnResized: effectiveReadonly ? undefined : handleColumnResized,
      onClipboardCopy: handleClipboardCopy,
      onClipboardPaste: effectiveReadonly ? undefined : handleClipboardPaste,
      ...(activeEngine.id === CANVAS_TABLE_ENGINE.id
        ? {
            onFreezeStateChange: effectiveReadonly ? undefined : handleFreezeStateChange,
            onRowExpand: handleCanvasRowExpand,
            onCommentCountClick: handleCanvasCommentCountClick,
            onRecordComment: handleCanvasRecordComment,
            onColumnStatisticClick: effectiveReadonly
              ? undefined
              : handleCanvasColumnStatisticAction,
            onRowContextMenu: handleCanvasRowContextMenu,
            onCopyRecordUrl: handleCopyRecordUrl,
            onTreeToggle: handleTreeToggle,
            onLinkCellExpand: handleLinkCellExpand,
            onLinkTagClick: handleLinkTagClick,
            onUrlCellClick: handleUrlCellClick,
            organizationMembers,
            userDisplayNameById,
            subRecordParentFieldId,
            // 预览 / 下载在只读模式下也可用（主进程拉字节）
            loadAttachmentPreviewUi: loadTabDataAttachmentPreviewUi,
            onDownloadAttachment: handleDownloadAttachment,
            onDownloadAllAttachments: handleDownloadAllAttachments,
            ...(effectiveReadonly
              ? {}
              : {
                  onAttachmentUpload: handleCanvasAttachmentUpload,
                  onAttachmentFileRef: handleCanvasAttachmentFileRef,
                  onRowAppend: handleCanvasRowAppend,
                  onRowMoved: handleCanvasRowMoved,
                  onColumnAppend: handleCanvasColumnAppend,
                  onInsertSubRecord: handleInsertSubRecord,
                  onDeleteRecords: handleDeleteRecords,
                  onDuplicateRecord: handleDuplicateRecord,
                  onInsertRecord: handleInsertRecord,
                }),
          }
        : {}),
      className: 'tt-data-grid',
    }),
    [
      activeEngine.id,
      effectiveReadonly,
      canvasColumnStatistics,
      canvasCommentCountMap,
      canvasRowControls,
      resolvedEngineConfig,
      draftGroupPath,
      draftRowData,
      rowsForGridDisplay,
      gridLoading,
      startDraftRow,
      handleCancelDraftRow,
      handleCellEditingStopped,
      handleCellValueChanged,
      handleSelectOptionAdd,
      handleCanvasAttachmentUpload,
      handleCanvasAttachmentFileRef,
      handleDownloadAttachment,
      handleDownloadAllAttachments,
      loadTabDataAttachmentPreviewUi,
      handleFieldMenuAction,
      handleClipboardCopy,
      handleClipboardPaste,
      handleColumnMoved,
      handleColumnResized,
      handleCanvasRowExpand,
      handleCanvasCommentCountClick,
      handleCanvasRecordComment,
      handleCanvasRowAppend,
      handleCanvasRowMoved,
      handleCanvasRowContextMenu,
      handleInsertSubRecord,
      handleDeleteRecords,
      handleDuplicateRecord,
      handleInsertRecord,
      handleCopyRecordUrl,
      handleTreeToggle,
      handleCanvasColumnAppend,
      handleCanvasColumnStatisticAction,
      handleFreezeStateChange,
      handleLinkCellExpand,
      handleLinkTagClick,
      handleUrlCellClick,
      handleCommitDraftRow,
      handleFilterChanged,
      handleFirstDataRendered,
      handleGridReady,
      handleVisibleRegionChanged,
      handleSelectionChanged,
      handleCollabCellFocus,
      handleSortChanged,
      handleTableApiReady,
      handleToggleGroup,
      isDraftSubmitting,
      pinnedBottomRowData,
      reportRendererError,
      organizationMembers,
      userDisplayNameById,
      subRecordParentFieldId,
      t,
      theme,
    ],
  );

  return (
    <>
      <div className="flex h-full w-full flex-col">
        <div
          ref={gridContainerRef}
          className="relative min-h-0 flex-1 w-full"
          onKeyDownCapture={handleDraftShortcutKeyDown}
        >
          <GridEngineView {...gridRendererProps} />
          {!collabAccessBlocked && disconnectPhase === 'disconnected' && (
            <div className="absolute top-0 left-0 right-0 z-banner flex items-center justify-center gap-2 bg-warning/90 px-3 py-1.5 text-body font-medium text-white shadow-sm">
              <WifiOff className="size-3.5 shrink-0" />
              <span>{t('table:collab.disconnectedTimer', { seconds: disconnectSeconds })}</span>
              <span className="text-white/80">{t('table:collab.editsBuffered')}</span>
              <button
                type="button"
                onClick={handleForceReconnect}
                className="ml-1 inline-flex items-center gap-1 rounded bg-white/20 px-2 py-0.5 text-caption font-medium text-white hover:bg-white/30 transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                {t('table:collab.retryConnect')}
              </button>
            </div>
          )}
          {!collabAccessBlocked && disconnectPhase === 'restored' && (
            <div className="absolute top-0 left-0 right-0 z-banner flex items-center justify-center gap-2 bg-success/90 px-3 py-1.5 text-body font-medium text-white shadow-sm transition-opacity duration-500">
              <span>{t('table:collab.connectionRestored')}</span>
            </div>
          )}
          {!collabAccessBlocked && showDegradedBanner && disconnectPhase === 'none' && (
            <div className="absolute top-0 left-0 right-0 z-banner flex items-center justify-center gap-2 bg-warning/10 border-b border-warning/30 px-3 py-1.5 text-body text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{t('table:collab.degradedWarning')}</span>
              <button
                type="button"
                onClick={handleDegradedRefresh}
                className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption font-medium text-warning hover:bg-warning/20 transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                {t('table:collab.degradedRefresh')}
              </button>
            </div>
          )}
          {!collabAccessBlocked && collabBridge.collab.isTruncated && !collabBridge.collab.isFallback && !showDegradedBanner && disconnectPhase === 'none' && (
            <div className="absolute top-0 left-0 right-0 z-banner flex items-center justify-center gap-2 bg-warning/10 border-b border-warning/30 px-3 py-1.5 text-caption text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {t('table:collab.truncatedWarning', {
                  count: collabBridge.collab.truncatedTotalRecords,
                })}
              </span>
            </div>
          )}
          {activeEngine.id === CANVAS_TABLE_ENGINE.id && (
            <RowCounterWidget
              label={rowCounterLabel}
              ariaLabel={rowCounterAriaLabel}
              tooltipLabel={rowCounterTooltipLabel}
            />
          )}
          {showTableEngineMetricsOverlay && tableEngineMetricsLabel && (
            <div className="pointer-events-none absolute bottom-3 right-3 z-floating rounded border border-border/80 bg-background/95 px-2 py-1 text-caption font-medium text-muted-foreground shadow-sm">
              {t('table:engineMetrics.prefix', {
                engine: activeEngine.id.toUpperCase(),
              })}{' '}
              {tableEngineMetricsLabel}
            </div>
          )}
        </div>
      </div>

      <DataGridOverlayLayer
        showEditDialog={showEditDialog}
        editingRecord={editingRecord}
        initialCommentsOpen={initialCommentsOpen}
        initialFocusTarget={initialFocusTarget}
        onRecordDialogOpenChange={handleRecordDialogOpenChange}
        canNavigatePrev={canNavigatePrev}
        canNavigateNext={canNavigateNext}
        onNavigatePrev={navigateToPrevRecord}
        onNavigateNext={navigateToNextRecord}
        showFieldDeleteConfirm={showFieldDeleteConfirm}
        setShowFieldDeleteConfirm={setShowFieldDeleteConfirm}
        deletingField={deletingField}
        onConfirmDeleteField={handleConfirmDeleteField}
        onOpenFieldVersionHistory={onOpenTableHistory}
        translate={translateWithOptions}
        showRecordHistory={showRecordHistory}
        recordHistoryRecordLabel={recordHistoryRecordLabel}
        recordHistoryOps={recordHistoryOps}
        recordHistoryTotal={recordHistoryTotal}
        isLoadingRecordHistory={isLoadingRecordHistory}
        onCloseRecordHistory={handleCloseRecordHistory}
        onLoadMoreRecordHistory={handleLoadMoreRecordHistory}
        fieldNameMap={fieldNameMap}
        fieldTypeMap={fieldTypeMap}
        onViewRecordHistory={handleOpenRecordHistory}
        onHighlightCells={highlightCellsImpl}
        snapshotData={snapshotData}
        snapshotLoading={snapshotLoading}
        onRequestSnapshot={handleRequestSnapshot}
        onRequestRestore={effectiveReadonly ? undefined : handleRequestRestore}
        restoreLoading={effectiveReadonly ? false : restoreLoading}
        showLinkEditor={showLinkEditor}
        linkEditorTableId={selectedTable?.id ?? ''}
        linkEditorRecordId={linkEditorState?.recordId ?? ''}
        linkEditorFieldId={linkEditorState?.fieldId ?? ''}
        linkEditorFieldConfig={linkEditorState?.fieldConfig}
        linkEditorCurrentValue={linkEditorState?.currentValue ?? []}
        linkEditorSpaceId={selectedTable?.space_id}
        onCloseLinkEditor={handleCloseLinkEditor}
        onSaveLinkEditor={effectiveReadonly ? undefined : handleSaveLinkEditor}
        onOpenLinkedRecordFromPicker={handleOpenLinkedRecord}
        linkedRecordDetail={linkedRecordDetail}
        onCloseLinkedRecordDetail={handleCloseLinkedRecordDetail}
        onLinkedRecordSaved={() => {
          void refreshCurrentView?.();
        }}
        isReadonly={effectiveReadonly}
      />
      {pasteConfirmState && (
        <ConfirmDialog
          open={pasteConfirmState.open}
          onOpenChange={(open) => { if (!open) cancelPaste(); }}
          title={t('table:clipboard.pasteConfirmTitle')}
          description={[
            pasteConfirmState.newRowCount > 0
              ? t('table:clipboard.pasteConfirmWithNewRows', {
                  rows: pasteConfirmState.rowCount,
                  cells: pasteConfirmState.cellCount,
                  newRows: pasteConfirmState.newRowCount,
                })
              : t('table:clipboard.pasteConfirmDescription', {
                  rows: pasteConfirmState.rowCount,
                  cells: pasteConfirmState.cellCount,
                }),
            ...(pasteConfirmState.truncatedRows > 0
              ? [
                  t('table:clipboard.pasteConfirmTruncated', {
                    count: pasteConfirmState.truncatedRows,
                  }),
                ]
              : []),
            ...(pasteConfirmState.skippedRows > pasteConfirmState.truncatedRows
              ? [
                  t('table:clipboard.pasteConfirmSkipped', {
                    count:
                      pasteConfirmState.skippedRows -
                      pasteConfirmState.truncatedRows,
                  }),
                ]
              : []),
          ].join(' ')}
          variant="default"
          confirmText={t('table:clipboard.pasteConfirmButton')}
          cancelText={t('common:cancel')}
          onConfirm={confirmPaste}
        />
      )}
      {deleteConfirmState && (
        <ConfirmDialog
          open={deleteConfirmState.open}
          onOpenChange={(open) => { if (!open) cancelDeleteRecords(); }}
          title={t('table:toolbar.confirmDeleteTitle')}
          description={
            deleteConfirmState.descendantCount
              ? t('table:toolbar.confirmDeleteWithChildrenDescription', {
                  count: deleteConfirmState.count,
                  childCount: deleteConfirmState.descendantCount,
                })
              : t('table:toolbar.confirmDeleteDescription', {
                  count: deleteConfirmState.count,
                })
          }
          variant="destructive"
          confirmText={t('common:delete')}
          cancelText={t('common:cancel')}
          onConfirm={confirmDeleteRecords}
          restoreFocusOnClose
        />
      )}
      {/* EditFieldDialog 已迁移到 FieldSettingPanel，由 useFieldSettingStore 控制 */}

    </>
  );
};
