import React from 'react';
import { ConfirmDialog, toast } from '@tabtin/smartsheet-ui';
import {
  TableApiService,
  type TableSearchIndexStatus,
} from '@tabtin/table-core';
import { tableStore, useTableStore } from '@stores/useTableStore';
import { useRecordStore } from '@stores/useRecordStore';
import {
  useTableAppearanceStore,
  type TableFontStyle,
  type TableFontWeight,
  type TableFontSize,
} from '@stores/useTableAppearanceStore';
import { useViewStore } from '@stores/useViewStore';
import { useOrganizationStore } from '@tabtin/app-shell';
import { useIsContextTabActive } from '@/hooks/useIsContextTabActive';
import { useTranslation } from 'react-i18next';
import { ShareDialog } from '@tabtin/smartsheet-ui';
import { useDataGridContext } from './DataGridContext';
import { useTableReadonly } from './TableReadonlyContext';
import { useTableCollab } from './TableCollabContext';
import { useGridToolbarController } from './controller/useGridToolbarController';
import { useGridToolbarUiState } from '@tabtin/table-ui';
import { useGridToolbarInteractions } from './controller/useGridToolbarInteractions';
import { useServerSearch } from './controller/useServerSearch';
import { useFieldSettingStore } from '@stores/useFieldSettingStore';
import { GridToolbarMainBar } from './toolbar/GridToolbarMainBar';
import { GridToolbarDialogs } from './toolbar/GridToolbarDialogs';
import { SendToIMDialog } from '@/components/tabchat/SendToIMDialog';
import type { SendToIMResource } from '@/components/tabchat/sendToIM/types';
import { requestResourceEditAccess } from '@/services/tabchatApi';
import { COMMON_TABLE_EMOJIS } from '@tabtin/table-ui';
import { useUndoRedoContext } from '@components/view/UndoRedoContext';
import { buildPublicShareUrlPrefix } from '@/config/api';
import { useTableOverlayDrawerContainer } from './utils/TableOverlayDrawerHost';
import { resolveShouldUseServerSearch } from './utils/serverSearchGating';
import { isReadonlyTableRole } from './tablePermissions';
import { createLogger } from '@/utils/logger';

const log = createLogger('GridToolbar');

const SEARCH_INDEX_CACHE_TTL = 30_000;
const searchIndexCache = new Map<
  string,
  { data: TableSearchIndexStatus; ts: number }
>();

interface GridToolbarProps {
  onOpenTableHistory?: () => void;
}

export const GridToolbar: React.FC<GridToolbarProps> = ({
  onOpenTableHistory,
}) => {
  const { t } = useTranslation(['table', 'common']);
  const uiState = useGridToolbarUiState();
  const tableNameInputRef = React.useRef<HTMLInputElement>(null);
  const emojiButtonRef = React.useRef<HTMLDivElement>(null);
  const [searchIndexStatus, setSearchIndexStatus] =
    React.useState<TableSearchIndexStatus | null>(null);
  const [searchIndexLoading, setSearchIndexLoading] =
    React.useState<boolean>(false);
  const [searchIndexActionLoading, setSearchIndexActionLoading] =
    React.useState<boolean>(false);

  const selectedTable = useTableStore((state) => state.selectedTable);
  const fields = useTableStore((state) => state.fields);
  const updateTable = useTableStore((state) => state.updateTable);
  const getTable = useTableStore((state) => state.getTable);

  const tableTabKey = selectedTable?.id ? `tabdata:${selectedTable.id}` : null;
  const isActiveTab = useIsContextTabActive(tableTabKey);

  const deleteRecordRaw = useRecordStore((state) => state.deleteRecord);
  const bulkDeleteRecordsRaw = useRecordStore((state) => state.bulkDeleteRecords);
  // 明确删除必须以 REST 为权威落库；协作在线时仅在服务端确认成功后再镜像进 Y.Doc。
  // 不能把「本地 Y.Doc 已删」当成「数据库已删」——否则  会把全删 diff 静默丢弃。
  // 协作新建尚未 persist 确认时先折叠取消，避免对未知 ID 发 bulk-delete。
  const { mirrorRecordDeletesToCollab, cancelPendingCollabCreates } = useTableCollab();
  const deleteRecord = React.useCallback(
    async (recordId: string, ...rest: unknown[]) => {
      const cancelled = cancelPendingCollabCreates([recordId]);
      if (cancelled.includes(recordId)) {
        return true as Awaited<ReturnType<typeof deleteRecordRaw>>;
      }
      const result = await (deleteRecordRaw as (...a: unknown[]) => Promise<unknown>)(recordId, ...rest);
      if (result) {
        mirrorRecordDeletesToCollab([recordId]);
      }
      return result as Awaited<ReturnType<typeof deleteRecordRaw>>;
    },
    [cancelPendingCollabCreates, deleteRecordRaw, mirrorRecordDeletesToCollab],
  );
  const bulkDeleteRecords = React.useCallback(
    async (recordIds: string[], ...rest: unknown[]) => {
      const cancelled = cancelPendingCollabCreates(recordIds);
      const cancelledSet = new Set(cancelled);
      const authoritativeIds = recordIds.filter((id) => !cancelledSet.has(id));
      if (authoritativeIds.length === 0) {
        return {
          ok: true,
          deletedIds: [...cancelled],
          failedIds: [],
          errors: [],
        };
      }
      const result = await bulkDeleteRecordsRaw(authoritativeIds, ...(rest as []));
      if (result.deletedIds.length > 0) {
        mirrorRecordDeletesToCollab(result.deletedIds);
      }
      return {
        ...result,
        deletedIds: [...cancelled, ...result.deletedIds],
        ok: result.ok,
      };
    },
    [bulkDeleteRecordsRaw, cancelPendingCollabCreates, mirrorRecordDeletesToCollab],
  );
  const setRecordSearchQuery = useRecordStore((state) => state.setSearchQuery);
  const loadRecordsByTable = useRecordStore((state) => state.loadRecordsByTable);
  const refreshCurrentView = useViewStore((state) => state.refreshCurrentView);

  const {
    selectedRows,
    setSelectedRows,
    openRecordEditor,
    totalRowsCount,
    searchQuery,
    setSearchQuery,
    searchScope,
    setSearchScope,
    searchSelectedFieldIds,
    setSearchSelectedFieldIds,
    searchHideNotMatchRows,
    setSearchHideNotMatchRows,
    searchMatchCount,
    searchCurrentMatchIndex,
    searchCurrentField,
    searchLimitReached,
    requestSearchNavigate,
    setServerSearchHits,
    setServerSearchLoading,
    setServerSearchTotalCount,
    setUseServerSearch,
    setServerSearchHasMore,
    setServerSearchLoadNextPage,
    requestAddRow,
    isTableReadonly: dataGridReadonly,
  } = useDataGridContext();
  const { isTableReadonly: paneReadonly } = useTableReadonly();

  // 字体外观按 tableId 独立存储。读当前表的那套，未设过则回落
  // defaultAppearance；写入也只针对当前表，互不串库。
  const tableIdForAppearance = selectedTable?.id ?? null;
  const tableAppearanceEntry = useTableAppearanceStore((state) =>
    tableIdForAppearance ? state.byTable[tableIdForAppearance] : undefined,
  );
  const defaultAppearance = useTableAppearanceStore(
    (state) => state.defaultAppearance,
  );
  const appearance = tableAppearanceEntry ?? defaultAppearance;
  const tableFontStyle = appearance.style;
  const tableFontWeight = appearance.weight;
  const tableFontSize = appearance.size;
  const setTableFontStyleScoped = useTableAppearanceStore(
    (state) => state.setTableFontStyle,
  );
  const setTableFontWeightScoped = useTableAppearanceStore(
    (state) => state.setTableFontWeight,
  );
  const setTableFontSizeScoped = useTableAppearanceStore(
    (state) => state.setTableFontSize,
  );

  const setTableFontStyle = React.useCallback(
    (value: TableFontStyle) => {
      if (tableIdForAppearance)
        setTableFontStyleScoped(tableIdForAppearance, value);
    },
    [tableIdForAppearance, setTableFontStyleScoped],
  );
  const setTableFontWeight = React.useCallback(
    (value: TableFontWeight) => {
      if (tableIdForAppearance)
        setTableFontWeightScoped(tableIdForAppearance, value);
    },
    [tableIdForAppearance, setTableFontWeightScoped],
  );
  const setTableFontSize = React.useCallback(
    (value: TableFontSize) => {
      if (tableIdForAppearance)
        setTableFontSizeScoped(tableIdForAppearance, value);
    },
    [tableIdForAppearance, setTableFontSizeScoped],
  );

  const currentViewId = useViewStore((state) => state.currentViewId);
  // 视图锁定不禁用加行/导入/字段管理等记录侧操作
  const isTableReadonly = paneReadonly || dataGridReadonly;
  // 大表无限滚动只加载首屏时，本地搜索只能扫已加载行；用「已加载 < 总数」判定
  // 视图未全量加载，未加载时改走服务端全表扫描（后端 LIKE 扫描不依赖搜索索引）。
  const loadedRecordCount = useViewStore(
    (state) => state.currentViewRecords?.records?.length ?? 0,
  );
  const totalRecordCount = useViewStore((state) => {
    const records = state.currentViewRecords;
    return (
      records?.matched_total ?? records?.total ?? records?.records?.length ?? 0
    );
  });

  const translate = (key: string, options?: Record<string, unknown>) =>
    String(t(key as any, options as any));

  const undoRedoCtx = useUndoRedoContext();
  const handleUndo = isTableReadonly ? undefined : undoRedoCtx?.handleUndo;
  const handleRedo = isTableReadonly ? undefined : undoRedoCtx?.handleRedo;
  const canUndo = !isTableReadonly && (undoRedoCtx?.canUndo ?? false);
  const canRedo = !isTableReadonly && (undoRedoCtx?.canRedo ?? false);
  const isUndoing = undoRedoCtx?.isUndoing ?? false;
  const isRedoing = undoRedoCtx?.isRedoing ?? false;

  const gridToolbarController = useGridToolbarController({
    selectedTable,
    fields,
    selectedRows,
    totalRowsCount,
    setRecordSearchQuery,
    loadRecordsByTable,
    refreshCurrentView,
    deleteRecord,
    bulkDeleteRecords,
    setSelectedRows,
    updateTable,
    setTableFontStyle,
    setTableFontWeight,
    setTableFontSize,
  });

  const {
    handleRefresh,
    handleAddRow,
    handleDeleteSelected,
    handleConfirmDelete,
    handleEmojiSelect,
  } = useGridToolbarInteractions({
    selectedTable,
    selectedRows,
    uiState,
    gridToolbarController,
    tableNameInputRef,
    emojiButtonRef,
    onAddRow: requestAddRow,
  });

  const handleSearch = React.useCallback(
    (query: string) => {
      setSearchQuery(query);
    },
    [setSearchQuery],
  );

  const handleSearchScopeChange = React.useCallback(
    (scope: 'all_fields' | 'current_field') => {
      setSearchScope(scope);
    },
    [setSearchScope],
  );

  const handleSearchSelectedFieldIdsChange = React.useCallback(
    (fieldIds: string[]) => {
      setSearchSelectedFieldIds(fieldIds);
    },
    [setSearchSelectedFieldIds],
  );

  const handleSearchHideNotMatchRowsChange = React.useCallback(
    (value: boolean) => {
      setSearchHideNotMatchRows(value);
    },
    [setSearchHideNotMatchRows],
  );

  const handleSearchNavigateNext = React.useCallback(() => {
    requestSearchNavigate('next');
  }, [requestSearchNavigate]);

  const handleSearchNavigatePrev = React.useCallback(() => {
    requestSearchNavigate('prev');
  }, [requestSearchNavigate]);

  const searchableFields = React.useMemo(
    () => fields.filter((field) => !field.is_hidden),
    [fields],
  );
  const searchableFieldSignature = React.useMemo(
    () => searchableFields.map((field) => field.id).join(','),
    [searchableFields],
  );

  const searchScopeStorageKey = React.useMemo(() => {
    if (!selectedTable?.id) {
      return null;
    }
    return `tabtin.table.search.scope.${selectedTable.id}:${currentViewId ?? '__default__'}`;
  }, [currentViewId, selectedTable?.id]);

  const searchFieldIdsStorageKey = React.useMemo(() => {
    if (!selectedTable?.id) {
      return null;
    }
    return `tabtin.table.search.fields.${selectedTable.id}:${currentViewId ?? '__default__'}`;
  }, [currentViewId, selectedTable?.id]);

  const searchHideRowsStorageKey = React.useMemo(() => {
    if (!selectedTable?.id) {
      return null;
    }
    return `tabtin.table.search.hideRows.${selectedTable.id}:${currentViewId ?? '__default__'}`;
  }, [currentViewId, selectedTable?.id]);

  const fetchSeqRef = React.useRef(0);
  const actionLoadingRef = React.useRef(false);
  actionLoadingRef.current = searchIndexActionLoading;

  const fetchSearchIndexStatus = React.useCallback(
    async (bypassCache = false) => {
      if (!selectedTable?.id) {
        setSearchIndexStatus(null);
        return;
      }

      const tableId = selectedTable.id;
      if (!bypassCache) {
        const cached = searchIndexCache.get(tableId);
        if (cached && Date.now() - cached.ts < SEARCH_INDEX_CACHE_TTL) {
          setSearchIndexStatus(cached.data);
          return;
        }
      }

      const seq = ++fetchSeqRef.current;
      setSearchIndexLoading(true);
      try {
        const status = await TableApiService.getSearchIndexStatus(tableId);
        if (seq !== fetchSeqRef.current) return;
        if (actionLoadingRef.current) return;
        searchIndexCache.set(tableId, { data: status, ts: Date.now() });
        setSearchIndexStatus(status);
      } catch (error) {
        if (seq !== fetchSeqRef.current) return;
        console.warn('获取搜索索引状态失败', error);
        setSearchIndexStatus(null);
      } finally {
        if (seq === fetchSeqRef.current) {
          setSearchIndexLoading(false);
        }
      }
    },
    [selectedTable?.id],
  );

  const normalizedSelectedFieldIds = React.useCallback(
    (fieldIds: string[]) => {
      const allowedFieldIds = new Set(
        searchableFields.map((field) => field.id),
      );
      const uniqueIds: string[] = [];
      const visited = new Set<string>();
      for (const fieldId of fieldIds) {
        if (!allowedFieldIds.has(fieldId) || visited.has(fieldId)) {
          continue;
        }
        visited.add(fieldId);
        uniqueIds.push(fieldId);
      }
      return uniqueIds;
    },
    [searchableFields],
  );

  const isSameFieldIdList = React.useCallback(
    (left: string[], right: string[]) => {
      if (left.length !== right.length) {
        return false;
      }
      return left.every((fieldId, index) => fieldId === right[index]);
    },
    [],
  );

  const searchPreferenceReadyKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (
      !searchScopeStorageKey ||
      !searchFieldIdsStorageKey ||
      !searchHideRowsStorageKey
    ) {
      searchPreferenceReadyKeyRef.current = null;
      return;
    }

    const readyKey = `${searchScopeStorageKey}|${searchFieldIdsStorageKey}|${searchHideRowsStorageKey}|${searchableFieldSignature}`;
    if (searchPreferenceReadyKeyRef.current === readyKey) {
      return;
    }

    let nextScope: 'all_fields' | 'current_field' = 'all_fields';
    let nextFieldIds: string[] = searchableFields[0]
      ? [searchableFields[0].id]
      : [];
    let nextHideRows = false;

    try {
      const storedScope = window.localStorage.getItem(searchScopeStorageKey);
      if (storedScope === 'all_fields' || storedScope === 'current_field') {
        nextScope = storedScope;
      }
    } catch {
      // ignore local storage read errors
    }

    try {
      const rawFieldIds = window.localStorage.getItem(searchFieldIdsStorageKey);
      if (rawFieldIds) {
        const parsed = JSON.parse(rawFieldIds);
        if (Array.isArray(parsed)) {
          const normalized = normalizedSelectedFieldIds(
            parsed.filter((item): item is string => typeof item === 'string'),
          );
          if (normalized.length > 0) {
            nextFieldIds = normalized;
          }
        }
      }
    } catch {
      // ignore local storage read/parse errors
    }

    try {
      nextHideRows =
        window.localStorage.getItem(searchHideRowsStorageKey) === '1';
    } catch {
      // ignore local storage read errors
    }

    if (nextScope === 'current_field' && nextFieldIds.length === 0) {
      nextScope = 'all_fields';
    }

    setSearchScope(nextScope);
    setSearchSelectedFieldIds(nextFieldIds);
    setSearchHideNotMatchRows(nextHideRows);

    searchPreferenceReadyKeyRef.current = readyKey;
  }, [
    normalizedSelectedFieldIds,
    searchFieldIdsStorageKey,
    searchHideRowsStorageKey,
    searchableFieldSignature,
    searchableFields,
    searchScopeStorageKey,
    setSearchHideNotMatchRows,
    setSearchScope,
    setSearchSelectedFieldIds,
  ]);

  React.useEffect(() => {
    if (
      !searchScopeStorageKey ||
      !searchFieldIdsStorageKey ||
      !searchHideRowsStorageKey
    ) {
      return;
    }
    const readyKey = `${searchScopeStorageKey}|${searchFieldIdsStorageKey}|${searchHideRowsStorageKey}|${searchableFieldSignature}`;
    if (searchPreferenceReadyKeyRef.current !== readyKey) {
      return;
    }
    try {
      window.localStorage.setItem(searchScopeStorageKey, searchScope);
    } catch {
      // ignore local storage write errors
    }
  }, [
    searchFieldIdsStorageKey,
    searchHideRowsStorageKey,
    searchScope,
    searchScopeStorageKey,
    searchableFieldSignature,
  ]);

  React.useEffect(() => {
    if (isActiveTab) {
      void fetchSearchIndexStatus();
    }
  }, [fetchSearchIndexStatus, searchableFieldSignature, isActiveTab]);

  React.useEffect(() => {
    if (
      !searchScopeStorageKey ||
      !searchFieldIdsStorageKey ||
      !searchHideRowsStorageKey
    ) {
      return;
    }
    const readyKey = `${searchScopeStorageKey}|${searchFieldIdsStorageKey}|${searchHideRowsStorageKey}|${searchableFieldSignature}`;
    if (searchPreferenceReadyKeyRef.current !== readyKey) {
      return;
    }
    const normalized = normalizedSelectedFieldIds(searchSelectedFieldIds);
    try {
      window.localStorage.setItem(
        searchFieldIdsStorageKey,
        JSON.stringify(normalized),
      );
    } catch {
      // ignore local storage write errors
    }
    if (!isSameFieldIdList(searchSelectedFieldIds, normalized)) {
      setSearchSelectedFieldIds(normalized);
    }
  }, [
    isSameFieldIdList,
    normalizedSelectedFieldIds,
    searchFieldIdsStorageKey,
    searchHideRowsStorageKey,
    searchScopeStorageKey,
    searchSelectedFieldIds,
    searchableFieldSignature,
    setSearchSelectedFieldIds,
  ]);

  React.useEffect(() => {
    if (
      !searchScopeStorageKey ||
      !searchFieldIdsStorageKey ||
      !searchHideRowsStorageKey
    ) {
      return;
    }
    const readyKey = `${searchScopeStorageKey}|${searchFieldIdsStorageKey}|${searchHideRowsStorageKey}|${searchableFieldSignature}`;
    if (searchPreferenceReadyKeyRef.current !== readyKey) {
      return;
    }
    try {
      window.localStorage.setItem(
        searchHideRowsStorageKey,
        searchHideNotMatchRows ? '1' : '0',
      );
    } catch {
      // ignore local storage write errors
    }
  }, [
    searchFieldIdsStorageKey,
    searchHideNotMatchRows,
    searchHideRowsStorageKey,
    searchScopeStorageKey,
    searchableFieldSignature,
  ]);

  const selectedRowsCount = gridToolbarController.selectedRowsCount;

  const handleAddField = React.useCallback(() => {
    if (isTableReadonly) return;
    const tableId = selectedTable?.id;
    if (!tableId) return;
    useFieldSettingStore.getState().openForAdd(tableId);
  }, [isTableReadonly, selectedTable?.id]);

  const handleSearchIndexToggle = React.useCallback(
    async (enabled: boolean) => {
      if (isTableReadonly || !selectedTable?.id) {
        return;
      }

      setSearchIndexActionLoading(true);
      try {
        const status = await TableApiService.toggleSearchIndex(
          selectedTable.id,
          { enabled },
        );
        searchIndexCache.set(selectedTable.id, {
          data: status,
          ts: Date.now(),
        });
        setSearchIndexStatus(status);
        toast({
          title: enabled
            ? translate('table:toolbar.searchIndexEnabledTitle')
            : translate('table:toolbar.searchIndexDisabledTitle'),
          description: enabled
            ? translate('table:toolbar.searchIndexEnabledDesc')
            : translate('table:toolbar.searchIndexDisabledDesc'),
        });
      } catch (error) {
        toast({
          title: translate('table:toolbar.searchIndexToggleFailedTitle'),
          description:
            error instanceof Error
              ? error.message
              : translate('table:toolbar.searchIndexToggleFailedDesc'),
          variant: 'destructive',
        });
      } finally {
        setSearchIndexActionLoading(false);
      }
    },
    [isTableReadonly, selectedTable?.id, translate],
  );

  const handleSearchIndexRepair = React.useCallback(async () => {
    if (isTableReadonly || !selectedTable?.id) {
      return;
    }

    setSearchIndexActionLoading(true);
    try {
      const status = await TableApiService.repairSearchIndex(selectedTable.id);
      searchIndexCache.set(selectedTable.id, { data: status, ts: Date.now() });
      setSearchIndexStatus(status);
      toast({
        title: translate('table:toolbar.searchIndexRepairSuccessTitle'),
        description: translate('table:toolbar.searchIndexRepairSuccessDesc'),
      });
    } catch (error) {
      toast({
        title: translate('table:toolbar.searchIndexRepairFailedTitle'),
        description:
          error instanceof Error
            ? error.message
            : translate('table:toolbar.searchIndexRepairFailedDesc'),
        variant: 'destructive',
      });
    } finally {
      setSearchIndexActionLoading(false);
    }
  }, [isTableReadonly, selectedTable?.id, translate]);

  // 服务端搜索模式判定见 resolveShouldUseServerSearch。
  const shouldUseServerSearch = resolveShouldUseServerSearch({
    supported: searchIndexStatus?.supported,
    enabled: searchIndexStatus?.enabled,
    abnormalCount: searchIndexStatus?.abnormal_count,
    loadedRecordCount,
    totalRecordCount,
  });

  React.useEffect(() => {
    setUseServerSearch(shouldUseServerSearch);
  }, [shouldUseServerSearch, setUseServerSearch]);

  // 构建 field_id 参数
  const serverFieldId = React.useMemo(() => {
    if (searchScope === 'all_fields') return 'all_fields';
    if (searchSelectedFieldIds.length > 0)
      return searchSelectedFieldIds.join(',');
    return undefined;
  }, [searchScope, searchSelectedFieldIds]);

  // 使用 useServerSearch hook（内部处理防抖、缓存、分页）
  const serverSearch = useServerSearch({
    tableId: selectedTable?.id ?? null,
    searchValue: searchQuery,
    fieldId: serverFieldId,
    hideNotMatchRow: searchHideNotMatchRows,
    viewId: currentViewId ?? null,
    enabled: shouldUseServerSearch,
  });

  // 将 hook 状态同步到 DataGridContext（供 DataGridAdapter 消费）
  React.useEffect(() => {
    setServerSearchHits(serverSearch.hits);
  }, [serverSearch.hits, setServerSearchHits]);

  React.useEffect(() => {
    setServerSearchTotalCount(serverSearch.totalCount);
  }, [serverSearch.totalCount, setServerSearchTotalCount]);

  React.useEffect(() => {
    setServerSearchLoading(serverSearch.loading);
  }, [serverSearch.loading, setServerSearchLoading]);

  React.useEffect(() => {
    setServerSearchHasMore(serverSearch.hasMore);
  }, [serverSearch.hasMore, setServerSearchHasMore]);

  React.useEffect(() => {
    setServerSearchLoadNextPage(serverSearch.loadNextPage);
  }, [serverSearch.loadNextPage, setServerSearchLoadNextPage]);

  // ── Wave 3: 分享对话框 ──
  const [showShareDialog, setShowShareDialog] = React.useState(false);
  const shareDrawer = useTableOverlayDrawerContainer(showShareDialog);
  const handleOpenShareDialog = React.useCallback(() => {
    setShowShareDialog(true);
  }, []);
  const [sendToIMOpen, setSendToIMOpen] = React.useState(false);
  const handleOpenSendToIM = React.useCallback(() => {
    setSendToIMOpen(true);
  }, []);
  const sendToIMResource = React.useMemo((): SendToIMResource | null => {
    if (!selectedTable?.id) return null;
    return {
      kind: 'resource_card',
      ref: {
        type: 'table',
        resourceId: selectedTable.id,
        name: selectedTable.name ?? '',
        spaceId: selectedTable.space_id ?? undefined,
        hintCarrierAppId: 'tabdata',
      },
    };
  }, [selectedTable]);
  const [requestEditConfirmOpen, setRequestEditConfirmOpen] = React.useState(false);
  const [requestingEditAccess, setRequestingEditAccess] = React.useState(false);
  const [editAccessRequested, setEditAccessRequested] = React.useState(false);
  React.useEffect(() => {
    setEditAccessRequested(false);
    setRequestingEditAccess(false);
    setRequestEditConfirmOpen(false);
  }, [selectedTable?.id]);
  const canRequestEditAccess = isReadonlyTableRole(selectedTable?.current_user_role);
  const handleOpenRequestEditConfirm = React.useCallback(() => {
    if (!canRequestEditAccess || requestingEditAccess || editAccessRequested) return;
    setRequestEditConfirmOpen(true);
  }, [canRequestEditAccess, editAccessRequested, requestingEditAccess]);
  const handleConfirmRequestEditAccess = React.useCallback(async () => {
    if (!selectedTable?.id || !canRequestEditAccess || requestingEditAccess || editAccessRequested) {
      return;
    }
    setRequestingEditAccess(true);
    try {
      await requestResourceEditAccess('table', selectedTable.id);
      setEditAccessRequested(true);
      setRequestEditConfirmOpen(false);
      toast({
        title: String(translate('table:toolbar.requestEditAccessSubmitted', {
          defaultValue: '已提交编辑申请',
        })),
        description: String(translate('table:toolbar.requestEditAccessSubmittedDesc', {
          defaultValue: '已通知资源所有者，通过后即可编辑',
        })),
      });
    } catch (err) {
      log.warn('request edit access failed', { tableId: selectedTable.id, error: err });
      toast({
        title: String(translate('table:toolbar.requestEditAccessFailed', {
          defaultValue: '申请失败',
        })),
        description: err instanceof Error
          ? err.message
          : String(translate('table:toolbar.requestEditAccessFailedDesc', {
            defaultValue: '请稍后重试',
          })),
        variant: 'destructive',
      });
    } finally {
      setRequestingEditAccess(false);
    }
  }, [
    canRequestEditAccess,
    editAccessRequested,
    requestingEditAccess,
    selectedTable?.id,
    translate,
  ]);
  const selectedOrganizationId = useOrganizationStore(
    (s) => s.selectedOrganization?.id ?? null,
  );
  const canManageShare = React.useMemo(() => {
    // D10：owner 或 admin 才能管理分享。
    // Wave 5 §D：后端 GET /tabdata/tables/{id} 已回填 current_user_role；
    // 这是 SSOT，前端不再做 owner_id / organization role 旁路（避免与后端判定不一致）。
    const role = selectedTable?.current_user_role;
    return role === 'owner' || role === 'admin';
  }, [selectedTable]);
  if (!selectedTable) {
    return null;
  }

  return (
    <div className="relative border-b border-border/60 bg-background">
      <GridToolbarMainBar
        fields={searchableFields}
        canDetailEdit={gridToolbarController.canDetailEdit}
        hasSelectedRows={gridToolbarController.hasSelectedRows}
        tableFontStyle={tableFontStyle}
        tableFontWeight={tableFontWeight}
        tableFontSize={tableFontSize}
        searchQuery={searchQuery}
        searchTargetId={selectedTable.id}
        searchScope={searchScope}
        searchSelectedFieldIds={searchSelectedFieldIds}
        searchHideNotMatchRows={searchHideNotMatchRows}
        searchMatchCount={searchMatchCount}
        searchCurrentMatchIndex={searchCurrentMatchIndex}
        searchCurrentField={searchCurrentField}
        searchLimitReached={searchLimitReached}
        searchIndexSupported={searchIndexStatus?.supported ?? true}
        searchIndexEnabled={searchIndexStatus?.enabled ?? false}
        searchIndexAbnormalCount={searchIndexStatus?.abnormal_count ?? 0}
        searchIndexLoading={searchIndexLoading}
        searchIndexActionLoading={searchIndexActionLoading}
        totalRowsCount={totalRowsCount}
        translate={translate}
        onSearch={handleSearch}
        onSearchScopeChange={handleSearchScopeChange}
        onSearchSelectedFieldIdsChange={handleSearchSelectedFieldIdsChange}
        onSearchHideNotMatchRowsChange={handleSearchHideNotMatchRowsChange}
        onSearchIndexToggle={handleSearchIndexToggle}
        onSearchIndexRepair={handleSearchIndexRepair}
        onSearchNavigateNext={handleSearchNavigateNext}
        onSearchNavigatePrev={handleSearchNavigatePrev}
        onAddRow={handleAddRow}
        onAddField={handleAddField}
        onRefresh={handleRefresh}
        onDeleteSelected={handleDeleteSelected}
        onOpenDetailEdit={
          isTableReadonly ? undefined : () => openRecordEditor(selectedRows[0] ?? null)
        }
        onShowFieldManagement={
          isTableReadonly ? undefined : () => uiState.setShowFieldManagement(true)
        }
        onShowExportDialog={() => uiState.setShowExportDialog(true)}
        onShowImportDialog={
          isTableReadonly ? undefined : () => uiState.setShowImportDialog(true)
        }
        onFontStyleChange={gridToolbarController.handleFontStyleChange}
        onFontWeightChange={gridToolbarController.handleFontWeightChange}
        onFontSizeChange={gridToolbarController.handleFontSizeChange}
        canUndo={canUndo}
        canRedo={canRedo}
        isUndoing={isUndoing}
        isRedoing={isRedoing}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onOpenTableHistory={onOpenTableHistory}
        onShare={handleOpenShareDialog}
        canShare={canManageShare}
        onSendToIM={sendToIMResource ? handleOpenSendToIM : undefined}
        onRequestEditAccess={
          canRequestEditAccess && !editAccessRequested
            ? handleOpenRequestEditConfirm
            : undefined
        }
        isReadonly={isTableReadonly}
      />

      <GridToolbarDialogs
        selectedTable={selectedTable}
        currentViewId={currentViewId}
        selectedRows={selectedRows}
        selectedRowsCount={selectedRowsCount}
        renderedViewRecordCount={totalRowsCount}
        uiState={uiState}
        commonEmojis={COMMON_TABLE_EMOJIS}
        translate={translate}
        onConfirmDelete={handleConfirmDelete}
        onEmojiSelect={handleEmojiSelect}
        isReadonly={isTableReadonly}
      />

      {shareDrawer.host}
      {showShareDialog && shareDrawer.ready && (
        <ShareDialog
          open={showShareDialog}
          onOpenChange={setShowShareDialog}
          container={shareDrawer.container ?? undefined}
          resourceType="table"
          resourceId={selectedTable.id}
          resourceTitle={selectedTable.name ?? ''}
          organizationId={selectedOrganizationId ?? ''}
          shareUrlPrefix={buildPublicShareUrlPrefix('table')}
          canManage={canManageShare}
        />
      )}

      {sendToIMOpen && sendToIMResource && (
        <SendToIMDialog
          open={sendToIMOpen}
          onOpenChange={setSendToIMOpen}
          resource={sendToIMResource}
          organizationId={selectedOrganizationId ?? undefined}
          canGrantResourceAccess={canManageShare}
        />
      )}

      <ConfirmDialog
        open={requestEditConfirmOpen}
        onOpenChange={setRequestEditConfirmOpen}
        title={String(translate('table:toolbar.requestEditAccessConfirmTitle', {
          defaultValue: '申请编辑权限？',
        }))}
        description={String(translate('table:toolbar.requestEditAccessConfirmDesc', {
          defaultValue: '将向资源所有者发送编辑申请，通过后你才能编辑此表格。',
        }))}
        confirmText={String(translate('table:toolbar.requestEditAccessConfirmAction', {
          defaultValue: '确认申请',
        }))}
        cancelText={String(translate('common:cancel', { defaultValue: '取消' }))}
        onConfirm={handleConfirmRequestEditAccess}
        isLoading={requestingEditAccess}
        container={null}
      />
    </div>
  );
};
