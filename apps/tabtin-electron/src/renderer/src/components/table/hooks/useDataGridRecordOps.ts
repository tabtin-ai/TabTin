/**
 * useDataGridRecordOps - 记录 CRUD 操作 hook
 *
 * 职责：
 * 1. 记录删除（批量） → handleDeleteRecords
 * 2. 记录复制 → handleDuplicateRecord
 * 3. 记录插入 → handleInsertRecord
 * 4. 复制记录链接 → handleCopyRecordUrl
 * 5. 子记录插入 → handleInsertSubRecord
 * 6. 创建记录排序上下文 → buildCreateRecordOrderContext
 * 7. 分组值预填 → buildDraftPrefillValues
 */

import React from 'react';
import { toast, ToastAction } from '@tabtin/smartsheet-ui';
import { message } from '@tabtin/smartsheet-ui/message';
import type { TableGridRow } from '@tabtin/table-engine';
import { resolveRecordId as resolveEngineRecordId } from '@tabtin/table-engine';
import { RecordApiService, type Field, type TableRecord, type ViewMeta } from '@tabtin/table-core';
import { useRecordStore } from '@stores/useRecordStore';
import {
  resolveCreatedRecordVisibility,
  type ViewAwareCreatePlan,
} from '@tabtin/table-ui/clipboard';
import type { LocalCreateOverlayTreePatch } from '../utils/viewLocalCreateOverlay';
import { MAX_SUB_RECORD_DEPTH } from '../utils/gridRowUtils';
import { buildRecordResourceLink } from '../utils/recordResourceLink';
import { waitForCondition } from './waitForCondition';
import {
  isDataRecordRow,
  normalizeGroupValue,
  isGroupValuesMatch,
  resolveFilterPrefillValues as resolveFilterPrefillValuesShared,
} from '@tabtin/table-ui';
import { createLogger } from '@/utils/logger';

const log = createLogger('TableRecordOps');

type AddRowContext = {
  group_path?: string;
  group_values?: Record<string, unknown>;
  order_context?: ViewAwareCreatePlan['orderContext'];
};

type GridDisplayRow = TableGridRow | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseDataGridRecordOpsParams {
  selectedTable: { id: string; name?: string; space_id?: string } | null;
  fields: Field[];
  records: any[];
  currentViewRecords: any;
  currentView: ViewMeta | null;
  currentViewId: string | null;
  useViewData: boolean;
  isTableReadonly: boolean;
  isPersonalViewEnabled: boolean;
  allowViewMutation: boolean;
  fieldById: Map<string, Field>;
  gridApiRef: React.RefObject<any>;
  selectedRows: any[];
  /** 删除选中记录后清空选择（与工具栏删除一致） */
  setSelectedRows?: (rows: any[]) => void;
  firstEditableField: string | null;
  groupedRows: GridDisplayRow[];
  rowsData: any[];
  subRecordParentFieldId: string | null;
  resolvedCurrentView: ViewMeta | null;
  recordsQuery: { page: number; page_size: number };
  createRecord: (params: any) => Promise<any>;
  /**
   * 协作态写 Y.Doc 单元格的入口（= collabBridge.updateRecord）。
   * link 字段值存 LinkRecord（不在 record.data），后端创建子记录时 RecordCreated.after
   * 不含父链，CollabYDocSubscriber 不会把父字段同步进 Y.Doc。协作在线创建子记录后
   * 需用它把父链值乐观写进 Y.Doc，子记录才能挂到父记录下。
   */
  updateRecord?: (
    recordId: string,
    data: { fields?: Record<string, unknown>; data?: Record<string, unknown> },
  ) => Promise<unknown>;
  refreshCurrentView: () => Promise<void>;
  /**
   * 重新拉取表字段 schema。刚开启层级时父链 link 字段可能已写入视图 config，
   * 但尚未同步进 fields / 协作字段映射，首次写父关联会被判为 stale field 而失败。
   * handleInsertSubRecord 在创建前用它兜底同步 schema。
   */
  loadFields?: (tableId: string) => Promise<void>;
  /**
   * 协作（Y.Doc）在线且非 fallback 时为 true。在线时新建子记录会经
   * `Django RecordCreated → collab-live → Y.Doc → 客户端 observer` 同步到视图，
   * 此时跳过 `refreshCurrentView` 的全量取数：全量取数会整条替换视图记录，
   * 一旦它赢过「单元格编辑经 Y.Doc 异步落库」的竞态，就会把尚未落库的乐观编辑刷没。
   */
  isCollabSyncActive?: boolean;
  loadRecordsByTable: (
    tableId: string,
    params: { page: number; page_size: number },
  ) => Promise<void>;
  updateView: (viewId: string, data: any, options?: any) => Promise<any>;
  setPersonalViewDraft: (
    tableId: string,
    viewId: string,
    draft: any,
  ) => void;
  is403Error: (error: unknown) => boolean;
  mark403Readonly: (error?: unknown) => void;
  onRevealHiddenRecord?: (record: TableRecord) => void | Promise<void>;
  onRecordCreated?: (record: TableRecord) => void | Promise<void>;
  onRecordCreatedContinueEditing?: (record: TableRecord) => void | Promise<void>;
  applyLocalCreateOverlay?: (
    createdRecords: TableRecord[],
    orderContext?: ViewAwareCreatePlan['orderContext'],
    options?: { subRecordTreePatch?: LocalCreateOverlayTreePatch },
  ) => TableRecord[];
  patchLocalCreateOverlayRecord?: (recordId: string | number, updatedRecord: TableRecord) => void;
  removeOverlayRecords?: (recordIds: (string | number)[]) => void;
  onRecordsDeleted?: (recordIds: string[]) => void;
  /**
   * 协作新建尚未服务端确认时，折叠删除为取消（撤 Y.Doc / 投影），返回实际取消的 ID。
   * 这些 ID 不得再发 REST bulk-delete。
   */
  cancelPendingCollabCreates?: (recordIds: readonly string[]) => string[];
  /** ：协作在线时把 REST 创建的记录镜像进本地 Y.Doc（由 DataGridAdapter 注入）。 */
  mirrorRecordsToCollab?: (records: TableRecord[]) => void;
  viewStoreApi?: {
    getState: () => {
      currentViewRecords?: {
        records?: TableRecord[];
        metadata?: Record<string, unknown>;
      } | null;
      treeExpandedRecords?: Record<string, Set<string>>;
      expandAllTreeRecords?: (viewId: string, recordIds: string[]) => void;
    };
  };
  t: (key: string, options?: Record<string, unknown>) => string;
}

export type { ViewAwareCreatePlan } from '@tabtin/table-ui/clipboard';

export interface DeleteConfirmState {
  open: boolean;
  recordIds: string[];
  count: number;
  /** Number of descendant records that will be orphaned (parent link removed) */
  descendantCount?: number;
}

export interface UseDataGridRecordOpsReturn {
  isDataRecordRow: (row: unknown) => row is Record<string, unknown>;
  normalizeGroupValue: (value: unknown) => string;
  isGroupValuesMatch: (
    sourceValues: Record<string, unknown> | undefined,
    targetValues: Record<string, unknown> | undefined,
  ) => boolean;
  resolveAnchorRow: (
    addRowContext?: AddRowContext,
  ) => Record<string, unknown> | null;
  resolveGroupValuesFromAnchor: (
    anchorRow: Record<string, unknown> | null,
    addRowContext?: AddRowContext,
  ) => Record<string, unknown> | undefined;
  buildDraftPrefillValues: (
    addRowContext?: AddRowContext,
  ) => Record<string, unknown> | undefined;
  resolveDraftAddRowContext: (
    draftRow: TableGridRow,
    addRowContext?: AddRowContext,
  ) => AddRowContext | undefined;
  resolveGroupAnchorRecordId: (
    addRowContext?: AddRowContext,
  ) => string | undefined;
  buildCreateRecordOrderContext: (addRowContext?: AddRowContext) => {
    view_id?: string;
    anchor_record_id?: string;
    position?: 'before' | 'after' | 'end';
    group_values?: Record<string, unknown>;
  };
  buildCreatePlanFromDisplayRowIndex: (
    displayRowIndex: number,
    position?: 'before' | 'after' | 'end',
  ) => ViewAwareCreatePlan;
  handleDeleteRecords: (recordIds: string[]) => Promise<void>;
  /** 跳过确认框，直接执行权威删除（探针 / 自动化用） */
  executeDeleteRecords: (recordIds: string[]) => Promise<void>;
  deleteConfirmState: DeleteConfirmState | null;
  confirmDeleteRecords: () => Promise<void>;
  cancelDeleteRecords: () => void;
  handleDuplicateRecord: (recordId: string) => Promise<void>;
  handleInsertRecord: (
    position: 'before' | 'after',
    anchorRowIndex: number,
    count: number,
  ) => Promise<void>;
  handleCopyRecordUrl: (recordId: string) => Promise<void>;
  handleInsertSubRecord: (parentRowId: string) => Promise<void>;
}

export function useDataGridRecordOps({
  selectedTable,
  fields,
  records,
  currentViewRecords,
  currentView,
  currentViewId,
  useViewData,
  isTableReadonly,
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
  resolvedCurrentView,
  recordsQuery,
  createRecord,
  updateRecord,
  refreshCurrentView,
  loadFields,
  isCollabSyncActive,
  loadRecordsByTable,
  updateView,
  setPersonalViewDraft,
  is403Error,
  mark403Readonly,
  onRevealHiddenRecord,
  onRecordCreated,
  onRecordCreatedContinueEditing,
  applyLocalCreateOverlay,
  patchLocalCreateOverlayRecord,
  removeOverlayRecords,
  onRecordsDeleted,
  cancelPendingCollabCreates,
  mirrorRecordsToCollab: mirrorRecordsToCollabInput,
  viewStoreApi,
  t,
}: UseDataGridRecordOpsParams): UseDataGridRecordOpsReturn {
  const activeView = resolvedCurrentView ?? currentView;
  // 最新 fields 的引用：供异步流程（如 handleInsertSubRecord 等字段就绪）在回调闭包外
  // 读取渲染期同步更新后的字段列表，避免闭包捕获旧值。
  const fieldsRef = React.useRef(fields);
  fieldsRef.current = fields;
  const areGroupValuesEquivalent = React.useCallback(
    (
      leftValues: Record<string, unknown> | undefined,
      rightValues: Record<string, unknown> | undefined,
    ) => {
      if (!leftValues || !rightValues) {
        return false;
      }
      const leftKeys = Object.keys(leftValues);
      const rightKeys = Object.keys(rightValues);
      if (leftKeys.length !== rightKeys.length) {
        return false;
      }
      return leftKeys.every(
        (key) =>
          normalizeGroupValue(leftValues[key]) ===
          normalizeGroupValue(rightValues[key]),
      );
    },
    [],
  );

  const resolveRecordId = React.useCallback((row: unknown): string | null => {
    return resolveEngineRecordId(row);
  }, []);

  const resolveValueFromRow = React.useCallback(
    (row: Record<string, unknown>, keys: string[]): unknown => {
      const containers = [
        row,
        row.fields,
        row.data,
      ].filter((value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === 'object',
      );
      for (const container of containers) {
        for (const key of keys) {
          if (key in container && container[key] != null) {
            return container[key];
          }
        }
      }
      return undefined;
    },
    [],
  );

  const resolveParentLinkValue = React.useCallback(
    (parentRowId: string) => {
      const candidateRows = [
        ...((currentViewRecords?.records as unknown[]) ?? []),
        ...rowsData,
        ...groupedRows,
        ...records,
      ];
      const primaryField = fields.find((field) => Boolean((field as any).is_primary));
      const titleKeys = [
        primaryField?.id,
        primaryField?.name,
        firstEditableField,
        'title',
        'name',
      ].filter((key): key is string => typeof key === 'string' && key.length > 0);
      const matchingRows = candidateRows.filter((row) => resolveRecordId(row) === parentRowId);
      const parentRowWithTitle = matchingRows.find((row) => {
        if (!row || typeof row !== 'object') {
          return false;
        }
        const value = resolveValueFromRow(row as Record<string, unknown>, titleKeys);
        return value != null && typeof value !== 'object';
      });
      const parentRow = parentRowWithTitle ?? matchingRows[0];
      const rawTitle =
        parentRow && typeof parentRow === 'object'
          ? resolveValueFromRow(parentRow as Record<string, unknown>, titleKeys)
          : undefined;
      const title =
        rawTitle == null || typeof rawTitle === 'object'
          ? parentRowId
          : String(rawTitle);
      return { id: parentRowId, title };
    },
    [
      currentViewRecords?.records,
      fields,
      firstEditableField,
      groupedRows,
      records,
      resolveRecordId,
      resolveValueFromRow,
      rowsData,
    ],
  );

  const resolveAnchorRow = React.useCallback(
    (addRowContext?: AddRowContext) => {
      if (
        addRowContext?.group_values &&
        Object.keys(addRowContext.group_values).length > 0
      ) {
        return null;
      }

      const api = gridApiRef.current;
      const focusedCell = api?.getFocusedCell?.();

      if (api && focusedCell && !focusedCell.rowPinned) {
        const focusedNode = api.getDisplayedRowAtIndex?.(focusedCell.rowIndex);
        const focusedData = focusedNode?.data as
          | Record<string, unknown>
          | undefined;
        if (isDataRecordRow(focusedData)) {
          return focusedData;
        }
      }

      const selectedDataRow = selectedRows.find(isDataRecordRow);
      return selectedDataRow ?? null;
    },
    [gridApiRef, selectedRows],
  );

  const resolveGroupValuesFromAnchor = React.useCallback(
    (
      anchorRow: Record<string, unknown> | null,
      addRowContext?: AddRowContext,
    ) => {
      const contextValues = addRowContext?.group_values;
      if (contextValues && Object.keys(contextValues).length > 0) {
        return contextValues;
      }

      if (!activeView?.groups?.length || !anchorRow) {
        return undefined;
      }

      const groupValues: Record<string, unknown> = {};
      for (const group of activeView.groups as any[]) {
        const fieldMeta = fieldById.get(group.field_id);
        if (!fieldMeta) {
          continue;
        }

        const groupValue = anchorRow[fieldMeta.name];
        if (groupValue === undefined || groupValue === null) {
          continue;
        }
        if (typeof groupValue === 'string' && groupValue.trim().length === 0) {
          continue;
        }
        groupValues[fieldMeta.name] = groupValue;
      }

      if (Object.keys(groupValues).length === 0) {
        return undefined;
      }
      return groupValues;
    },
    [activeView?.groups, fieldById],
  );

  const resolveFilterPrefillValues = React.useCallback(() => {
    const activeFilters = Array.isArray(activeView?.filters)
      ? activeView.filters.filter((filter) => filter?.enabled !== false)
      : [];
    const filterLogic = (
      (activeView?.config as Record<string, unknown> | undefined)
        ?.filter_logic
    ) as string | undefined;

    return resolveFilterPrefillValuesShared({
      activeFilters,
      filterLogic,
      getFieldById: (id) => fieldById.get(id),
    });
  }, [activeView?.config, activeView?.filters, fieldById]);

  const buildDraftPrefillValues = React.useCallback(
    (addRowContext?: AddRowContext) => {
      const anchorRow = resolveAnchorRow(addRowContext);
      const groupPrefillValues = resolveGroupValuesFromAnchor(
        anchorRow,
        addRowContext,
      );
      const filterPrefillValues = resolveFilterPrefillValues();
      if (!groupPrefillValues && !filterPrefillValues) {
        return undefined;
      }
      return {
        ...(filterPrefillValues ?? {}),
        ...(groupPrefillValues ?? {}),
      };
    },
    [
      resolveAnchorRow,
      resolveFilterPrefillValues,
      resolveGroupValuesFromAnchor,
    ],
  );

  const resolveDraftAddRowContext = React.useCallback(
    (draftRow: TableGridRow, addRowContext?: AddRowContext) => {
      if (!activeView?.groups?.length) {
        return addRowContext;
      }

      const nextGroupValues: Record<string, unknown> = {};
      for (const group of activeView.groups as any[]) {
        const fieldMeta = fieldById.get(group.field_id);
        if (!fieldMeta) {
          continue;
        }
        const nextValue = draftRow[fieldMeta.name];
        if (
          nextValue === undefined ||
          nextValue === null ||
          nextValue === ''
        ) {
          continue;
        }
        nextGroupValues[fieldMeta.name] = nextValue;
      }

      const hasNextGroupValues = Object.keys(nextGroupValues).length > 0;
      if (!hasNextGroupValues) {
        const hasExplicitEmptyGroupContext = Boolean(
          addRowContext?.group_values &&
            Object.keys(addRowContext.group_values).length > 0 &&
            Object.values(addRowContext.group_values).every(
              (value) =>
                value === undefined ||
                value === null ||
                value === '' ||
                (Array.isArray(value) && value.length === 0),
            ),
        );
        if (hasExplicitEmptyGroupContext) {
          return addRowContext;
        }
        if (!addRowContext?.group_path && !addRowContext?.group_values) {
          return addRowContext;
        }
        return undefined;
      }

      const shouldKeepGroupPath =
        typeof addRowContext?.group_path === 'string' &&
        addRowContext.group_path.length > 0 &&
        areGroupValuesEquivalent(addRowContext.group_values, nextGroupValues);

      return {
        group_path: shouldKeepGroupPath ? addRowContext?.group_path : undefined,
        group_values: nextGroupValues,
        ...(shouldKeepGroupPath && addRowContext?.order_context
          ? { order_context: addRowContext.order_context }
          : {}),
      };
    },
    [activeView?.groups, areGroupValuesEquivalent, fieldById],
  );

  const resolveGroupAnchorRecordId = React.useCallback(
    (addRowContext?: AddRowContext) => {
      const groupPath = addRowContext?.group_path;
      if (groupPath && groupedRows.length > 0) {
        const groupAddIndex = groupedRows.findIndex(
          (row) =>
            (row as any)?.__rowType === 'group_add' &&
            (row as any)?.__groupPath === groupPath,
        );
        if (groupAddIndex > 0) {
          for (let index = groupAddIndex - 1; index >= 0; index -= 1) {
            const rowCandidate = groupedRows[index] as unknown;
            if (isDataRecordRow(rowCandidate)) {
              const candidateId = resolveEngineRecordId(rowCandidate);
              if (candidateId) return candidateId;
            }
            const rowType = (
              rowCandidate as { __rowType?: unknown } | null | undefined
            )?.__rowType;
            if (rowType === 'group_header') {
              break;
            }
          }
        }
      }

      const groupValues = addRowContext?.group_values;
      if (!groupValues || Object.keys(groupValues).length === 0) {
        return undefined;
      }

      for (let index = rowsData.length - 1; index >= 0; index -= 1) {
        const row = rowsData[index] as Record<string, unknown>;
        const isMatched = Object.entries(groupValues).every(
          ([fieldName, value]) =>
            normalizeGroupValue(row[fieldName]) === normalizeGroupValue(value),
        );
        if (isMatched) {
          const candidateId = resolveEngineRecordId(row);
          if (candidateId) return candidateId;
        }
      }
      return undefined;
    },
    [groupedRows, rowsData],
  );

  const buildCreateRecordOrderContext = React.useCallback(
    (addRowContext?: AddRowContext) => {
      if (addRowContext?.order_context) {
        return addRowContext.order_context;
      }

      const anchorRow = resolveAnchorRow(addRowContext);
      const groupValues = resolveGroupValuesFromAnchor(
        anchorRow,
        addRowContext,
      );

      const context: {
        view_id?: string;
        anchor_record_id?: string;
        position?: 'before' | 'after' | 'end';
        group_values?: Record<string, unknown>;
      } = {};

      if (useViewData && currentViewId) {
        context.view_id = currentViewId;
      }

      const hasExplicitGroupContext = Boolean(
        addRowContext?.group_values &&
          Object.keys(addRowContext.group_values).length > 0,
      );
      const rawGroupAnchorRecordId = hasExplicitGroupContext
        ? resolveGroupAnchorRecordId(addRowContext)
        : undefined;
      const groupAnchorRecordId =
        typeof rawGroupAnchorRecordId === 'string'
          ? rawGroupAnchorRecordId
          : undefined;
      const anchorRecordId = anchorRow ? resolveEngineRecordId(anchorRow) ?? undefined : undefined;
      if (groupAnchorRecordId) {
        context.anchor_record_id = groupAnchorRecordId;
        context.position = 'after';
      } else if (anchorRecordId && !hasExplicitGroupContext) {
        context.anchor_record_id = anchorRecordId;
        context.position = 'after';
      } else {
        context.position = 'end';
      }

      if (groupValues) {
        context.group_values = groupValues;
      }

      return context;
    },
    [
      currentViewId,
      resolveGroupAnchorRecordId,
      resolveAnchorRow,
      resolveGroupValuesFromAnchor,
      useViewData,
    ],
  );

  const getDisplayRowData = React.useCallback(
    (displayRowIndex: number) => {
      const api = gridApiRef.current;
      const displayedRow = api?.getDisplayedRowAtIndex?.(displayRowIndex)?.data as
        | Record<string, unknown>
        | undefined;
      if (displayedRow && typeof displayedRow === 'object') {
        return displayedRow;
      }
      const groupedRow = groupedRows[displayRowIndex];
      if (groupedRow && typeof groupedRow === 'object') {
        return groupedRow as Record<string, unknown>;
      }
      return undefined;
    },
    [gridApiRef, groupedRows],
  );

  const getPreviousDisplayDataRow = React.useCallback(
    (displayRowIndex: number) => {
      for (let index = displayRowIndex - 1; index >= 0; index -= 1) {
        const row = getDisplayRowData(index);
        if (isDataRecordRow(row)) return row;
      }
      return undefined;
    },
    [getDisplayRowData],
  );

  const resolveAddRowContextFromDisplayRowIndex = React.useCallback(
    (displayRowIndex: number): AddRowContext | undefined => {
      const rowData = getDisplayRowData(displayRowIndex);
      if (!rowData) {
        return undefined;
      }

      if (rowData.__rowType === 'group_add') {
        return {
          group_path:
            typeof rowData.__groupPath === 'string'
              ? rowData.__groupPath
              : undefined,
          group_values:
            rowData.__groupValues && typeof rowData.__groupValues === 'object'
              ? (rowData.__groupValues as Record<string, unknown>)
              : undefined,
        };
      }

      if (
        rowData.__rowType === 'group_header' &&
        Boolean(rowData.__groupCollapsed)
      ) {
        return {
          group_path:
            typeof rowData.__groupPath === 'string'
              ? rowData.__groupPath
              : undefined,
          group_values:
            rowData.__groupValues && typeof rowData.__groupValues === 'object'
              ? (rowData.__groupValues as Record<string, unknown>)
              : undefined,
        };
      }

      return undefined;
    },
    [getDisplayRowData],
  );

  const buildCreatePlanFromDisplayRowIndex = React.useCallback(
    (
      displayRowIndex: number,
      position: 'before' | 'after' | 'end' = 'after',
    ): ViewAwareCreatePlan => {
      const addRowContext =
        resolveAddRowContextFromDisplayRowIndex(displayRowIndex);
      if (addRowContext) {
        return {
          orderContext: buildCreateRecordOrderContext(addRowContext),
          prefillValues: buildDraftPrefillValues(addRowContext),
        };
      }

      const displayRow = getDisplayRowData(displayRowIndex);
      const anchorRow =
        displayRow?.__rowType === 'add'
          ? getPreviousDisplayDataRow(displayRowIndex)
          : displayRow;
      if (isDataRecordRow(anchorRow)) {
        const groupValues = resolveGroupValuesFromAnchor(anchorRow);
        const filterPrefillValues = resolveFilterPrefillValues();
        const anchorRecordId = resolveEngineRecordId(anchorRow);
        return {
          orderContext: {
            ...(useViewData && currentViewId ? { view_id: currentViewId } : {}),
            ...(anchorRecordId
              ? { anchor_record_id: anchorRecordId, position }
              : { position: 'end' }),
            ...(groupValues ? { group_values: groupValues } : {}),
          },
          prefillValues: {
            ...(filterPrefillValues ?? {}),
            ...(groupValues ?? {}),
          },
        };
      }

      const fallbackContext = buildCreateRecordOrderContext();
      return {
        orderContext: fallbackContext,
        prefillValues: buildDraftPrefillValues(),
      };
    },
    [
      buildCreateRecordOrderContext,
      buildDraftPrefillValues,
      currentViewId,
      getDisplayRowData,
      getPreviousDisplayDataRow,
      resolveAddRowContextFromDisplayRowIndex,
      resolveFilterPrefillValues,
      resolveGroupValuesFromAnchor,
      useViewData,
    ],
  );

  // ── Record CRUD handlers ──

  const bulkCreateRecords = useRecordStore(
    (state) => state.bulkCreateRecords,
  );
  const bulkDeleteRecords = useRecordStore(
    (state) => state.bulkDeleteRecords,
  );
  // ：REST 批量写入（插入 / 子记录）后，协作在线镜像进本地 Y.Doc。
  // 由 DataGridAdapter 注入（依赖注入，避免在被测 hook 内 import 协作上下文导致单测解析失败）。
  const mirrorRecordsToCollab = React.useCallback(
    (records: TableRecord[]) => mirrorRecordsToCollabInput?.(records),
    [mirrorRecordsToCollabInput],
  );

  const refreshViewAfterPostCreateFailure = React.useCallback(async () => {
    if (!useViewData) {
      return;
    }
    try {
      await refreshCurrentView();
    } catch {
      // The record write has already succeeded; avoid turning a recovery refresh
      // failure into a user-visible insert failure.
    }
  }, [refreshCurrentView, useViewData]);

  const notifyHiddenCreatedRecords = React.useCallback(
    (hiddenRecords: TableRecord[]) => {
      if (!useViewData || hiddenRecords.length === 0) {
        return;
      }
      const firstHiddenRecord = hiddenRecords[0];

      const actionLabel = String(t('table:record.createdHiddenAction' as any));
      const actionElement = onRevealHiddenRecord
        ? (React.createElement(
          ToastAction,
          {
            altText: actionLabel,
            onClick: () => {
              void onRevealHiddenRecord(firstHiddenRecord);
            },
          },
          actionLabel,
        ) as any)
        : undefined;
      toast({
        title: String(t('table:record.createdTitle' as any)),
        description: String(
          t('table:record.createdHiddenDesc' as any, {
            count: hiddenRecords.length,
          }),
        ),
        action: actionElement,
      });
    },
    [onRevealHiddenRecord, t, useViewData],
  );

  const handleCreatedRecordsVisibility = React.useCallback(
    async (
      createdRecords: TableRecord[],
      options?: { continueEditing?: boolean },
    ) => {
      if (createdRecords.length === 0) {
        return;
      }

      const notifyCreatedRecord = async (record: TableRecord) => {
        const callback = options?.continueEditing
          ? onRecordCreatedContinueEditing ?? onRecordCreated
          : onRecordCreated;
        if (!callback) {
          return;
        }
        try {
          await callback(record);
        } catch {
          // 定位失败不应影响新增主流程
        }
      };

      if (!useViewData) {
        await notifyCreatedRecord(createdRecords[0]);
        return;
      }

      const storeRecords = viewStoreApi?.getState?.()?.currentViewRecords?.records ?? [];
      const storeVisibleIds = new Set(storeRecords.map(r => r.id).filter(Boolean));
      const storeVisible = createdRecords.filter(r => r.id && storeVisibleIds.has(r.id));
      const storeHidden = createdRecords.filter(r => !r.id || !storeVisibleIds.has(r.id));

      if (storeVisible.length > 0) {
        if (storeHidden.length > 0) {
          notifyHiddenCreatedRecords(storeHidden);
        }
        await notifyCreatedRecord(storeVisible[0]);
        return;
      }

      const { firstVisibleRecord, hiddenRecords } =
        await resolveCreatedRecordVisibility({
          gridApiRef,
          createdRecords,
        });
      if (hiddenRecords.length > 0) {
        notifyHiddenCreatedRecords(hiddenRecords);
      }
      if (firstVisibleRecord) {
        await notifyCreatedRecord(firstVisibleRecord);
      }
    },
    [
      gridApiRef,
      notifyHiddenCreatedRecords,
      onRecordCreated,
      onRecordCreatedContinueEditing,
      useViewData,
      viewStoreApi,
    ],
  );
  const isViewOverlayEligibleRecord = React.useCallback(
    (record: TableRecord | null | undefined) =>
      Boolean(record && (record as Record<string, unknown>).__viewOverlayEligible === true),
    [],
  );

  const [deleteConfirmState, setDeleteConfirmState] =
    React.useState<DeleteConfirmState | null>(null);

  const executeDeleteRecords = React.useCallback(
    async (recordIds: string[]) => {
      if (isTableReadonly) return;
      const tableId = selectedTable?.id;
      if (!tableId || recordIds.length === 0) return;
      try {
        // 协作 Y.Doc-first 新建在 persist 确认前对 REST 是未知 ID。
        // 先折叠为取消：撤 Y.Doc / overlay / 投影，禁止对这些 ID 发 bulk-delete。
        const pendingCancelIds = cancelPendingCollabCreates?.(recordIds) ?? [];
        if (pendingCancelIds.length > 0) {
          removeOverlayRecords?.(pendingCancelIds);
          log.info('折叠取消未确认的协作新建', {
            tableId,
            count: pendingCancelIds.length,
          });
        }
        const pendingCancelSet = new Set(pendingCancelIds);
        const authoritativeIds = recordIds.filter((id) => !pendingCancelSet.has(id));

        if (pendingCancelIds.length > 0 && authoritativeIds.length === 0) {
          const gridApi = gridApiRef.current;
          gridApi?.clearFocusedCell?.();
          gridApi?.deselectAll?.();
          setSelectedRows?.([]);
          return;
        }
        if (authoritativeIds.length === 0) return;

        // 明确删除始终走权威 REST；协作在线也不得只改 Y.Doc。
        // 服务端确认成功后再镜像 Y.Doc，避免  把「删光」当成异常 diff 丢弃。
        //  / ：只镜像成功或已不存在的 ID；无权限失败才 toast，并刷新投影重建失败行。
        const result = await bulkDeleteRecords(authoritativeIds);
        if (result.deletedIds.length > 0) {
          try {
            onRecordsDeleted?.(result.deletedIds);
            removeOverlayRecords?.(result.deletedIds);
          } catch (syncError) {
            log.warn('同步协作删除状态失败', { tableId: selectedTable?.id, count: result.deletedIds.length }, syncError);
            await refreshCurrentView();
            toast({
              title: String(t('table:error.deleteRecordFailed' as any)),
              description: String(t('table:error.deleteCollabSyncFailed' as any)),
              variant: 'destructive',
            });
            return;
          }
        }
        if (!result.ok) {
          await refreshCurrentView();
          toast({
            title: String(t('table:error.deleteRecordFailed' as any)),
            description: result.errors[0] ? String(result.errors[0]) : undefined,
            variant: 'destructive',
          });
          const gridApi = gridApiRef.current;
          gridApi?.clearFocusedCell?.();
          gridApi?.deselectAll?.();
          setSelectedRows?.([]);
          return;
        }
        // 多选删除后清空选择：必须先清 canvas 引擎选择（deselectAll），否则引擎仍持有
        // 旧选择并通过 onSelectionChanged 把它再同步回 setSelectedRows，导致 [] 被覆盖。
        const gridApi = gridApiRef.current;
        gridApi?.clearFocusedCell?.();
        gridApi?.deselectAll?.();
        setSelectedRows?.([]);
        await refreshCurrentView();
      } catch (error) {
        if (is403Error(error)) {
          mark403Readonly(error);
          return;
        }
        toast({
          title: String(t('table:error.deleteRecordFailed' as any)),
          variant: 'destructive',
        });
      }
    },
    [
      selectedTable?.id,
      bulkDeleteRecords,
      cancelPendingCollabCreates,
      onRecordsDeleted,
      removeOverlayRecords,
      setSelectedRows,
      refreshCurrentView,
      t,
      isTableReadonly,
      is403Error,
      mark403Readonly,
      gridApiRef,
    ],
  );

  const handleDeleteRecords = React.useCallback(
    async (recordIds: string[]) => {
      if (isTableReadonly) return;
      if (!selectedTable?.id || recordIds.length === 0) return;

      // In tree mode, count descendant records that will be orphaned
      let descendantCount = 0;
      if (subRecordParentFieldId) {
        const storeState = viewStoreApi?.getState();
        const metadata = storeState?.currentViewRecords?.metadata;
        const subRecords = metadata?.sub_records as
          { tree_data?: Record<string, { parent_id?: string | null }> } | undefined;
        const treeData = subRecords?.tree_data;
        if (treeData) {
          const deletingSet = new Set(recordIds);
          const childrenByParent = new Map<string, string[]>();
          for (const [rid, meta] of Object.entries(treeData)) {
            if (meta?.parent_id) {
              const children = childrenByParent.get(meta.parent_id) ?? [];
              children.push(rid);
              childrenByParent.set(meta.parent_id, children);
            }
          }
          // BFS to count all descendants of records being deleted
          const queue = [...recordIds];
          const visited = new Set(recordIds);
          while (queue.length > 0) {
            const current = queue.shift()!;
            for (const child of childrenByParent.get(current) ?? []) {
              if (!visited.has(child)) {
                visited.add(child);
                if (!deletingSet.has(child)) descendantCount++;
                queue.push(child);
              }
            }
          }
        }
      }

      setDeleteConfirmState({
        open: true,
        recordIds,
        count: recordIds.length,
        descendantCount: descendantCount > 0 ? descendantCount : undefined,
      });
    },
    [isTableReadonly, selectedTable?.id, subRecordParentFieldId, viewStoreApi],
  );

  const confirmDeleteRecords = React.useCallback(async () => {
    const state = deleteConfirmState;
    if (state) {
      await executeDeleteRecords(state.recordIds);
    }
  }, [deleteConfirmState, executeDeleteRecords]);

  const cancelDeleteRecords = React.useCallback(() => {
    setDeleteConfirmState(null);
  }, []);

  const resolveRecordFieldValue = React.useCallback(
    (record: Record<string, unknown>, field: Field): unknown => {
      const fieldMap =
        record.fields && typeof record.fields === 'object'
          ? (record.fields as Record<string, unknown>)
          : undefined;
      const dataMap =
        record.data && typeof record.data === 'object'
          ? (record.data as Record<string, unknown>)
          : undefined;

      return (
        record[field.id] ??
        record[field.name] ??
        fieldMap?.[field.id] ??
        fieldMap?.[field.name] ??
        dataMap?.[field.id] ??
        dataMap?.[field.name]
      );
    },
    [],
  );

  const handleDuplicateRecord = React.useCallback(
    async (recordId: string) => {
      if (isTableReadonly) return;
      const tableId = selectedTable?.id;
      if (!tableId) return;
      const sourceRow = (currentViewRecords?.records ?? records).find(
        (r: any) => r.id === recordId || r.row_id === recordId,
      ) as Record<string, unknown> | undefined;
      if (!sourceRow) return;
      try {
        const COMPUTED_TYPES = new Set([
          'created_time',
          'last_modified_time',
          'created_by',
          'last_modified_by',
        ]);
        const payload: Record<string, unknown> = {};
        const sourceAnchorRecordId =
          typeof sourceRow.id === 'string'
            ? sourceRow.id
            : typeof sourceRow.row_id === 'string'
              ? sourceRow.row_id
              : undefined;
        const groupValues = resolveGroupValuesFromAnchor(
          sourceRow as Record<string, unknown>,
        );
        for (const field of fields) {
          if (COMPUTED_TYPES.has(field.field_type)) continue;
          const val = resolveRecordFieldValue(sourceRow, field);
          if (val != null) payload[field.id] = val;
        }
        const createdRecord = await createRecord({
          table_id: tableId,
          data: payload,
          fields: payload,
          fieldKeyType: 'id',
          order_context: {
            ...(useViewData && currentViewId ? { view_id: currentViewId } : {}),
            ...(sourceAnchorRecordId
              ? { anchor_record_id: sourceAnchorRecordId, position: 'after' as const }
              : { position: 'end' as const }),
            ...(groupValues ? { group_values: groupValues } : {}),
          },
        });
        if (!createdRecord) {
          return;
        }
        const createdRecords = [createdRecord as TableRecord];
        const hasOverlayVisibleRecord = createdRecords.some(isViewOverlayEligibleRecord);
        let canResolveVisibility = true;
        if (useViewData && !hasOverlayVisibleRecord) {
          try {
            await refreshCurrentView();
          } catch {
            canResolveVisibility = false;
          }
        }
        if (canResolveVisibility) {
          await handleCreatedRecordsVisibility(createdRecords, {
            continueEditing: true,
          });
        }
      } catch (error) {
        if (is403Error(error)) {
          mark403Readonly(error);
          return;
        }
        toast({
          title: String(t('table:error.duplicateRecordFailed' as any)),
          variant: 'destructive',
        });
      }
    },
    [
      selectedTable?.id,
      fields,
      records,
      currentViewRecords,
      createRecord,
      currentViewId,
      refreshCurrentView,
      handleCreatedRecordsVisibility,
      t,
      isTableReadonly,
      is403Error,
      mark403Readonly,
      isViewOverlayEligibleRecord,
      resolveGroupValuesFromAnchor,
      resolveRecordFieldValue,
      useViewData,
    ],
  );

  const handleInsertRecord = React.useCallback(
    async (
      position: 'before' | 'after',
      anchorRowIndex: number,
      count: number,
    ) => {
      if (isTableReadonly) return;
      const tid = selectedTable?.id;
      if (!tid) return;
      try {
        const createPlan = buildCreatePlanFromDisplayRowIndex(
          anchorRowIndex,
          position,
        );
        const recordsToCreate = Array.from({ length: count }, () => ({}));
        let createdRecords: TableRecord[];
        if (isCollabSyncActive) {
          createdRecords = [];
          let nextOrderContext = createPlan.orderContext;
          for (const recordData of recordsToCreate) {
            const created = await createRecord({
              table_id: tid,
              data: recordData,
              ...(nextOrderContext
                ? { order_context: nextOrderContext }
                : {}),
            });
            if (created) {
              createdRecords.push(created as TableRecord);
              const createdRecordId =
                typeof (created as TableRecord).id === 'string'
                  ? (created as TableRecord).id
                  : undefined;
              if (
                nextOrderContext?.position === 'after'
                && createdRecordId
              ) {
                nextOrderContext = {
                  ...nextOrderContext,
                  anchor_record_id: createdRecordId,
                };
              }
            }
          }
        } else {
          createdRecords = await bulkCreateRecords({
            table_id: tid,
            records: recordsToCreate,
            ...(createPlan.orderContext
              ? { order_context: createPlan.orderContext }
              : {}),
          });
          try {
            mirrorRecordsToCollab(createdRecords);
          } catch {
            await refreshViewAfterPostCreateFailure();
          }
        }
        try {
          const createdRecordsForVisibility = applyLocalCreateOverlay
            ? applyLocalCreateOverlay(createdRecords, createPlan.orderContext)
            : createdRecords;
          const hasOverlayVisibleRecord =
            createdRecordsForVisibility.some(isViewOverlayEligibleRecord);
          let canResolveVisibility = !useViewData || hasOverlayVisibleRecord;
          if (useViewData && !hasOverlayVisibleRecord) {
            try {
              await refreshCurrentView();
              canResolveVisibility = true;
            } catch {
              // 主写入已成功，视图刷新失败不应误报为插入失败
              canResolveVisibility = false;
            }
          }
          if (canResolveVisibility) {
            await handleCreatedRecordsVisibility(createdRecordsForVisibility, {
              continueEditing: true,
            });
          }
        } catch {
          await refreshViewAfterPostCreateFailure();
        }
      } catch (err) {
        log.error('插入记录失败', { tableId: selectedTable?.id }, err);
        toast({
          title: String(
            t('table:error.insertRecordFailed' as any, {
              defaultValue: 'Failed to insert record',
            }),
          ),
          variant: 'destructive',
        });
      }
    },
    [
      selectedTable?.id,
      buildCreatePlanFromDisplayRowIndex,
      bulkCreateRecords,
      createRecord,
      isCollabSyncActive,
      mirrorRecordsToCollab,
      refreshCurrentView,
      refreshViewAfterPostCreateFailure,
      handleCreatedRecordsVisibility,
      applyLocalCreateOverlay,
      isViewOverlayEligibleRecord,
      t,
      isTableReadonly,
      useViewData,
    ],
  );

  const handleCopyRecordUrl = React.useCallback(
    async (recordId: string) => {
      const tableId = selectedTable?.id;
      if (!tableId) return;
      const url = buildRecordResourceLink(tableId, recordId);
      try {
        await navigator.clipboard.writeText(url);
        toast({
          title: String(t('table:actions.copiedToClipboard' as any)),
        });
      } catch {
        toast({
          title: String(t('table:error.copyFailed' as any)),
          variant: 'destructive',
        });
      }
    },
    [selectedTable?.id, t],
  );

  const subRecordCreatingRef = React.useRef(false);

  const buildSubRecordOverlayTreePatch = React.useCallback(
    (parentRowId: string, tempId: string): LocalCreateOverlayTreePatch | undefined => {
      const storeMetadata = viewStoreApi?.getState?.()?.currentViewRecords?.metadata;
      const metadata = storeMetadata ?? currentViewRecords?.metadata;
      const subRecords = metadata?.sub_records as
        | { tree_data?: Record<string, { depth?: number; has_children?: boolean; parent_id?: string | null }> }
        | undefined;
      const treeData = subRecords?.tree_data;
      if (!treeData) {
        return undefined;
      }

      const parentMeta = treeData[parentRowId] ?? {
        depth: 0,
        has_children: false,
        parent_id: null,
      };
      const parentDepth =
        typeof parentMeta.depth === 'number' && Number.isFinite(parentMeta.depth)
          ? parentMeta.depth
          : 0;

      return {
        [parentRowId]: {
          ...parentMeta,
          depth: parentDepth,
          has_children: true,
          parent_id: parentMeta.parent_id ?? null,
        },
        [tempId]: {
          depth: parentDepth + 1,
          has_children: false,
          parent_id: parentRowId,
        },
      };
    },
    [currentViewRecords?.metadata, viewStoreApi],
  );

  const expandSubRecordParent = React.useCallback(
    (parentRowId: string) => {
      if (!currentViewId) {
        return;
      }
      const state = viewStoreApi?.getState?.();
      const expandAllTreeRecords = state?.expandAllTreeRecords;
      if (!expandAllTreeRecords) {
        return;
      }
      const treeMap = state.treeExpandedRecords ?? {};
      const hasExplicitEntry = Object.prototype.hasOwnProperty.call(
        treeMap,
        currentViewId,
      );
      if (!hasExplicitEntry) {
        // 无显式 entry 时渲染默认展开所有根。若写成「仅含当前父」，其它根会被误折叠。
        // 用当前 tree_data 里的根节点做种子，再并入要展开的父。
        const storeMetadata = state.currentViewRecords?.metadata;
        const metadata = storeMetadata ?? currentViewRecords?.metadata;
        const treeData = (
          metadata?.sub_records as
            | {
                tree_data?: Record<
                  string,
                  { depth?: number; has_children?: boolean }
                >;
              }
            | undefined
        )?.tree_data;
        const rootIds = treeData
          ? Object.entries(treeData)
              .filter(
                ([, meta]) =>
                  (meta.depth ?? 0) === 0 && meta.has_children === true,
              )
              .map(([id]) => id)
          : [];
        expandAllTreeRecords(currentViewId, [
          ...new Set([...rootIds, parentRowId]),
        ]);
        return;
      }
      const currentExpanded = treeMap[currentViewId] ?? new Set<string>();
      if (currentExpanded.has(parentRowId)) {
        return;
      }
      expandAllTreeRecords(currentViewId, [...currentExpanded, parentRowId]);
    },
    [currentViewId, currentViewRecords?.metadata, viewStoreApi],
  );

  const resolveSubRecordParentDepth = React.useCallback(
    (parentRowId: string): number | null => {
      const storeMetadata = viewStoreApi?.getState?.()?.currentViewRecords?.metadata;
      const metadata = storeMetadata ?? currentViewRecords?.metadata;
      const treeData = (
        metadata?.sub_records as
          | { tree_data?: Record<string, { depth?: number }> }
          | undefined
      )?.tree_data;
      const metaDepth = treeData?.[parentRowId]?.depth;
      if (typeof metaDepth === 'number' && Number.isFinite(metaDepth)) {
        return metaDepth;
      }

      for (const row of [...rowsData, ...groupedRows]) {
        const candidate = row as Record<string, unknown>;
        if (resolveEngineRecordId(candidate) !== parentRowId) continue;
        const rowDepth = candidate.__treeDepth;
        if (typeof rowDepth === 'number' && Number.isFinite(rowDepth)) {
          return rowDepth;
        }
      }
      return null;
    },
    [currentViewRecords?.metadata, groupedRows, rowsData, viewStoreApi],
  );

  const handleInsertSubRecord = React.useCallback(
    async (parentRowId: string) => {
      if (subRecordCreatingRef.current) return;
      if (isTableReadonly) {
        toast({
          title: String(t('table:permission.readonlyTitle' as any)),
          description: String(t('table:permission.cannotAddSubRecord' as any, { defaultValue: 'Table is read-only, cannot add sub-records' })),
          variant: 'destructive',
        });
        return;
      }
      const tableId = selectedTable?.id;
      if (!tableId) {
        console.warn('[handleInsertSubRecord] selectedTable.id 不存在，无法创建子记录');
        toast({
          title: String(t('table:subRecord.createFailed' as any, { defaultValue: 'Failed to create sub-record' })),
          description: '未选中表格',
          variant: 'destructive',
        });
        return;
      }

      const parentDepth = resolveSubRecordParentDepth(parentRowId);
      if (parentDepth !== null && parentDepth >= MAX_SUB_RECORD_DEPTH) {
        toast({
          title: String(t('table:subRecord.maxDepthReached' as any, { defaultValue: 'Maximum depth (4 levels) reached' })),
          description: String(t('table:subRecord.maxDepthReached' as any, { defaultValue: 'Maximum depth (4 levels) reached' })),
        });
        return;
      }

      subRecordCreatingRef.current = true;

      const parentLinkValue = resolveParentLinkValue(parentRowId);
      const orderContext = { position: 'after' as const, anchor_record_id: parentRowId };

      if (isCollabSyncActive && subRecordParentFieldId) {
        // 刚开启层级时父链 link 字段可能已写入视图 config，但尚未同步进 fields /
        // 协作字段映射（fieldId→hex）。此时写父关联会被判为 stale field，首次添加子记录
        // 失败并误弹「被撤销」类 toast。创建前先兜底同步一轮 schema，让协作映射就绪。
        if (loadFields && !fieldsRef.current.some((f) => f.id === subRecordParentFieldId)) {
          try {
            await loadFields(tableId);
            // 确定性等待父链字段真正进入最新 fields（协作 fieldId→hex 映射已改为渲染期
            // 同步构建，故 fields 就绪即映射就绪）。替代此前 setTimeout(0) 的单宏任务
            // 时序赌博——映射未就绪时创建会被误判 stale field，误弹「字段已被删除，编辑
            // 已跳过」。轮询到就绪或超时（超时则退回原有兜底行为，不阻断创建）。
            const ready = await waitForCondition(() =>
              fieldsRef.current.some((f) => f.id === subRecordParentFieldId),
            );
            if (!ready) {
              console.warn(
                '[handleInsertSubRecord] 等待父链字段进入 fields 超时，仍尝试创建',
                { subRecordParentFieldId },
              );
            }
          } catch (schemaErr) {
            console.warn('[handleInsertSubRecord] 预加载字段以同步父链映射失败', schemaErr);
          }
        }
        expandSubRecordParent(parentRowId);
        let loadingToast: { destroy: () => void } | undefined;
        loadingToast = message.loading(
          String(t('table:subRecord.creating' as any, { defaultValue: 'Creating sub-record...' })),
        );
        try {
          // 协作态 createRecord 已通过 addRecord 把父链值写进 Y.Doc，无需再补一次
          // updateRecord（那次冗余写在映射未就绪时会再触发 stale field 误报）。
          const createdRecord = await createRecord({
            table_id: tableId,
            fields: { [subRecordParentFieldId]: parentLinkValue },
            fieldKeyType: 'id',
            order_context: orderContext,
          });
          if (!createdRecord?.id) {
            throw new Error(String(t('table:subRecord.createFailed' as any, { defaultValue: 'Failed to create sub-record' })));
          }
          loadingToast?.destroy();
          message.success(String(t('table:subRecord.created' as any, { defaultValue: 'Sub-record created' })));
        } catch (err) {
          loadingToast?.destroy();
          if (is403Error(err)) {
            mark403Readonly(err);
            return;
          }
          const errorText =
            err instanceof Error
              ? err.message
              : String(t('table:subRecord.createFailed'));
          message.error(errorText);
        } finally {
          subRecordCreatingRef.current = false;
        }
        return;
      }

      const tempId = crypto.randomUUID();
      const now = new Date().toISOString();
      const parentFieldData: Record<string, unknown> = {};
      if (subRecordParentFieldId) {
        parentFieldData[subRecordParentFieldId] = parentLinkValue;
      }
      const tempRecord: TableRecord = {
        id: tempId,
        table_id: tableId,
        data: parentFieldData,
        fields: parentFieldData,
        created_by_id: '',
        created_at: now,
        updated_at: now,
      };

      const orderContextRest = { position: 'after' as const, anchor_record_id: parentRowId };
      expandSubRecordParent(parentRowId);
      const subRecordTreePatch = buildSubRecordOverlayTreePatch(parentRowId, tempId);
      const appliedRecords = applyLocalCreateOverlay?.(
        [tempRecord],
        orderContextRest,
        subRecordTreePatch ? { subRecordTreePatch } : undefined,
      );
      const overlayApplied = appliedRecords?.some(
        (r) => (r as Record<string, unknown>).__viewOverlayEligible === true,
      );

      let loadingToast: { destroy: () => void } | undefined;
      if (!overlayApplied) {
        loadingToast = message.loading(
          String(t('table:subRecord.creating' as any, { defaultValue: 'Creating sub-record...' })),
        );
      }

      try {
        const created = await RecordApiService.createSubRecord({
          table_id: tableId,
          parent_record_id: parentRowId,
          ...(subRecordParentFieldId
            ? { parent_field_id: subRecordParentFieldId }
            : {}),
          ...(Object.keys(parentFieldData).length > 0
            ? { data: parentFieldData }
            : {}),
        });

        if (
          !subRecordParentFieldId &&
          created.parent_field_id &&
          resolvedCurrentView?.id
        ) {
          try {
            if (isPersonalViewEnabled) {
              setPersonalViewDraft(
                tableId,
                resolvedCurrentView.id as string,
                {
                  config: {
                    subRecordParentFieldId: created.parent_field_id,
                  },
                },
              );
            } else if (allowViewMutation) {
              await updateView(
                resolvedCurrentView.id as string,
                {
                  config: {
                    ...((currentView?.config as
                      | Record<string, unknown>
                      | undefined) ?? {}),
                    subRecordParentFieldId: created.parent_field_id,
                  },
                },
                { silent: true },
              );
            }
          } catch (syncErr) {
            console.warn('子记录父字段写回视图配置失败', syncErr);
          }
        }

        if (created.record?.id) {
          patchLocalCreateOverlayRecord?.(tempId, created.record);
        } else {
          removeOverlayRecords?.([tempId]);
        }

        loadingToast?.destroy();
        if (!overlayApplied) {
          message.success(String(t('table:subRecord.created' as any, { defaultValue: 'Sub-record created' })));
        }

        if (isCollabSyncActive) {
          // REST 创建子记录（无 parent_field_id 时后端会补链字段）：镜像 + 父链写 Y.Doc
          if (created.record?.id) {
            mirrorRecordsToCollab([created.record as TableRecord]);
          }
          const effectiveParentFieldId = subRecordParentFieldId ?? created.parent_field_id;
          if (created.record?.id && effectiveParentFieldId && updateRecord) {
            const serializedParent = (created.record.fields as Record<string, unknown> | undefined)?.[
              effectiveParentFieldId
            ];
            const parentValue =
              serializedParent !== undefined && serializedParent !== null
                ? serializedParent
                : parentLinkValue;
            void updateRecord(created.record.id, {
              fields: { [effectiveParentFieldId]: parentValue },
            });
          }
        } else if (useViewData && currentViewId) {
          void refreshCurrentView();
        } else {
          void loadRecordsByTable(tableId, {
            page: recordsQuery.page,
            page_size: recordsQuery.page_size,
          });
        }
      } catch (err) {
        removeOverlayRecords?.([tempId]);
        loadingToast?.destroy();

        if (is403Error(err)) {
          mark403Readonly(err);
          return;
        }
        const message =
          err instanceof Error
            ? err.message
            : String(t('table:subRecord.createFailed'));
        toast({
          title: message,
          variant: 'destructive',
        });
      } finally {
        subRecordCreatingRef.current = false;
      }
    },
    [
      allowViewMutation,
      applyLocalCreateOverlay,
      buildSubRecordOverlayTreePatch,
      createRecord,
      currentViewId,
      expandSubRecordParent,
      fields,
      is403Error,
      isPersonalViewEnabled,
      isTableReadonly,
      loadFields,
      loadRecordsByTable,
      mark403Readonly,
      patchLocalCreateOverlayRecord,
      recordsQuery.page,
      recordsQuery.page_size,
      refreshCurrentView,
      resolveParentLinkValue,
      resolveSubRecordParentDepth,
      isCollabSyncActive,
      mirrorRecordsToCollab,
      removeOverlayRecords,
      currentView?.config,
      resolvedCurrentView?.id,
      selectedTable?.id,
      setPersonalViewDraft,
      subRecordParentFieldId,
      t,
      updateRecord,
      updateView,
      useViewData,
    ],
  );

  return {
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
  };
}
