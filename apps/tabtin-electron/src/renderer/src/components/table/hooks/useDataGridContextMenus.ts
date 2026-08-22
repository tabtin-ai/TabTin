/**
 * useDataGridContextMenus - 右键菜单处理 hook
 *
 * 职责：
 * 1. 行右键菜单操作（查看历史、发送到对话）
 * 2. 列右键菜单操作（排序、编辑、复制、插入、过滤、分组、隐藏、删除）
 * 3. 国际化菜单标签
 */

import React from 'react';
import { toast } from '@tabtin/smartsheet-ui';
import { StatFunc } from '@tabtin/table-engine-canvas/statistics';
import { buildCanvasMenuLabels, type CanvasFieldMenuLabels, type CanvasRecordMenuLabels } from '@tabtin/table-ui';
import type {
  TableGridHeaderContextMenuInfo,
} from '@tabtin/table-engine';
import { resolveRecordId } from '@tabtin/table-engine';
import type { Field, ViewMeta } from '@tabtin/table-core';
import { useFieldSettingStore } from '@/stores/useFieldSettingStore';
import { createLogger } from '@/utils/logger';
import { sendSelectionToChat } from '@/services/sendSelectionToChat';
import {
  dispatchOpenViewFilterPopover,
  dispatchOpenViewSortPopover,
} from '../../view/viewToolbarEvents';
import { buildTableSelectionInjectPayload } from './buildTableSelectionInjectPayload';

const log = createLogger('DataGridContextMenus');

const toReadableCellValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseDataGridContextMenusParams {
  selectedTable: { id: string; name?: string; space_id?: string } | null;
  fields: Field[];
  fieldById: Map<string, Field>;
  fieldByName: Map<string, Field>;
  firstEditableField: string | null;
  resolvedCurrentView: ViewMeta | null;
  allowViewMutation: boolean;
  isPersonalViewEnabled: boolean;
  isTableReadonly: boolean;
  fieldSettingHostId?: string;
  setPersonalViewDraft: (
    tableId: string,
    viewId: string,
    draft: any,
  ) => void;
  updateView: (viewId: string, data: any, options?: any) => Promise<any>;
  handleSortFromMenu: (fieldName: string, direction: 'asc' | 'desc') => void;
  handleDeleteField: (field: Field) => void;
  handleHideField: (field: Field) => void;
  handleSetPrimaryField: (field: Field) => Promise<void>;
  handleOpenRecordHistory: (recordId: string, label: string) => void;
  handleDuplicateFieldFromMenu: (field: Field) => Promise<void>;
  handleFilterFieldFromMenu: (field: Field) => Promise<boolean>;
  handleGroupFieldFromMenu: (field: Field) => Promise<void>;
  notifyLockedViewDenied: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface UseDataGridContextMenusReturn {
  resolveContextRowId: (rowData: Record<string, unknown>) => string | null;
  resolveContextRowLabel: (rowData: Record<string, unknown>) => string;
  handleCanvasRowContextMenu: (
    rowData: unknown,
    info: {
      clientX: number
      clientY: number
      api?: {
        action?: string
        selectedRowIds?: string[]
        selectedFieldKeys?: string[]
      }
    },
  ) => void;
  handleFieldMenuAction: (
    fieldName: string,
    info: TableGridHeaderContextMenuInfo,
  ) => void;
  canvasFieldMenuLabels: CanvasFieldMenuLabels;
  canvasRecordMenuLabels: CanvasRecordMenuLabels;
  canvasStatisticMenuLabels: Record<string, string>;
  canvasEditorLabels: Record<string, string>;
  allRecordsCheckboxTooltip: string;
}

export function useDataGridContextMenus({
  selectedTable,
  fields: _fields,
  fieldById,
  fieldByName,
  firstEditableField,
  resolvedCurrentView,
  allowViewMutation,
  isPersonalViewEnabled,
  isTableReadonly,
  fieldSettingHostId,
  setPersonalViewDraft,
  updateView,
  handleSortFromMenu,
  handleDeleteField,
  handleHideField,
  handleSetPrimaryField,
  handleOpenRecordHistory,
  handleDuplicateFieldFromMenu,
  handleFilterFieldFromMenu,
  handleGroupFieldFromMenu,
  notifyLockedViewDenied,
  t,
}: UseDataGridContextMenusParams): UseDataGridContextMenusReturn {
  const resolveContextRowId = React.useCallback(
    (rowData: Record<string, unknown>): string | null => {
      return resolveRecordId(rowData);
    },
    [],
  );

  const resolveContextRowLabel = React.useCallback(
    (rowData: Record<string, unknown>): string => {
      if (firstEditableField) {
        const value = rowData[firstEditableField];
        const text = toReadableCellValue(value).trim();
        if (text) return text;
      }
      const fallback = resolveContextRowId(rowData);
      return fallback ?? String(t('table:record.fallbackName' as any));
    },
    [firstEditableField, resolveContextRowId, t],
  );

  const handleCanvasRowContextMenu = React.useCallback(
    (
      rowData: unknown,
      info: {
        clientX: number
        clientY: number
        api?: {
          action?: string
          selectedRowIds?: string[]
          selectedFieldKeys?: string[]
        }
      },
    ) => {
      if (!rowData || typeof rowData !== 'object') return;
      const normalized = rowData as Record<string, unknown>;
      if (
        typeof normalized.__rowType === 'string' &&
        normalized.__rowType.length > 0
      )
        return;

      if (info.api?.action === 'view-history') {
        const rowId = resolveContextRowId(normalized);
        if (!rowId) return;
        handleOpenRecordHistory(rowId, resolveContextRowLabel(normalized));
        return;
      }

      if (info.api?.action === 'send-to-chat') {
        if (!selectedTable) {
          log.warn('send-to-chat skipped: no selected table');
          return;
        }

        const multiIds = info.api?.selectedRowIds;
        const singleRowId = resolveContextRowId(normalized);
        const recordIds =
          multiIds && multiIds.length > 0
            ? multiIds
            : singleRowId
              ? [singleRowId]
              : [];
        if (recordIds.length === 0) {
          log.warn('send-to-chat skipped: empty record ids', {
            tableId: selectedTable.id,
          });
          return;
        }

        const selectedFieldKeys = Array.isArray(info.api?.selectedFieldKeys)
          ? info.api.selectedFieldKeys.filter(
              (key): key is string => typeof key === 'string' && key.length > 0,
            )
          : [];
        const selectedFields = selectedFieldKeys
          .map((key) => fieldByName.get(key) ?? fieldById.get(key))
          .filter((field): field is Field => Boolean(field))
          .map((field) => ({ id: field.id, name: field.name }));

        const payload = buildTableSelectionInjectPayload({
          tableId: selectedTable.id,
          tableName: selectedTable.name,
          spaceId: selectedTable.space_id,
          recordIds,
          selectedFields,
          primaryRow: normalized,
          resolveRowLabel: resolveContextRowLabel,
          selectedRecordCountLabel: String(
            t('table:menu.selectedRecordCount' as any, {
              count: recordIds.length,
              defaultValue: `${recordIds.length} records`,
            }),
          ),
        });
        if (!payload) return;

        const viewId = resolvedCurrentView?.id;
        sendSelectionToChat({
          payload: {
            ...payload,
            tabType: 'tabdata',
          },
          resource: {
            kind: 'tabdata',
            id: selectedTable.id,
            title: selectedTable.name,
            spaceId: selectedTable.space_id,
            meta: viewId ? { viewId } : undefined,
          },
        });
        return;
      }
    },
    [
      fieldById,
      fieldByName,
      handleOpenRecordHistory,
      resolveContextRowId,
      resolveContextRowLabel,
      resolvedCurrentView?.id,
      selectedTable,
      t,
    ],
  );

  const handleFieldMenuAction = React.useCallback(
    (fieldName: string, info: TableGridHeaderContextMenuInfo) => {
      if (isTableReadonly) {
        return
      }
      const action = info.api?.action as
        | 'sort'
        | 'hide'
        | 'delete'
        | 'edit'
        | 'duplicate'
        | 'insert'
        | 'filter'
        | 'group'
        | 'set-primary'
        | undefined;
      if (!action) {
        console.warn(
          '[DataGridAdapter] handleFieldMenuAction: no action',
        );
        return;
      }

      const fieldNames =
        Array.isArray(info.api?.fields) && info.api.fields.length > 0
          ? (info.api.fields as string[])
          : [fieldName];
      const targetFields = fieldNames
        .map((name) => fieldByName.get(name) ?? fieldById.get(name))
        .filter(Boolean) as Field[];
      const targetField = targetFields[0];
      if (!targetField) {
        console.warn(
          '[DataGridAdapter] handleFieldMenuAction: field not resolved',
          { fieldName, action, fieldNames },
        );
        return;
      }

      if (action === 'sort') {
        if (!resolvedCurrentView?.id) {
          handleSortFromMenu(targetField.name, 'asc');
          dispatchOpenViewSortPopover({ fieldId: targetField.id });
          return;
        }

        if (!allowViewMutation) {
          notifyLockedViewDenied();
          return;
        }

        const currentSorts = Array.isArray(resolvedCurrentView.sorts)
          ? (resolvedCurrentView.sorts as Array<{
              field_id: string;
              direction: string;
              priority?: number;
            }>)
          : [];

        const normalizedCurrentSorts = currentSorts
          .map((sort, index) => {
            if (!sort?.field_id) return null;
            return {
              field_id: sort.field_id,
              direction: sort.direction === 'desc' ? 'desc' : 'asc',
              priority: index + 1,
            } as {
              field_id: string;
              direction: 'asc' | 'desc';
              priority: number;
            };
          })
          .filter(
            (
              item,
            ): item is {
              field_id: string;
              direction: 'asc' | 'desc';
              priority: number;
            } => Boolean(item),
          );

        const hasExistingSort = normalizedCurrentSorts.some(
          (item) => item.field_id === targetField.id,
        );

        const nextSorts = hasExistingSort
          ? normalizedCurrentSorts
          : [
              ...normalizedCurrentSorts,
              {
                field_id: targetField.id,
                direction: 'asc' as const,
                priority: normalizedCurrentSorts.length + 1,
              },
            ];

        if (isPersonalViewEnabled) {
          if (selectedTable?.id) {
            setPersonalViewDraft(
              selectedTable.id,
              resolvedCurrentView.id as string,
              { sorts: nextSorts },
            );
          }
          dispatchOpenViewSortPopover({
            viewId: resolvedCurrentView.id as string,
            fieldId: targetField.id,
          });
          return;
        }

        if (!hasExistingSort) {
          void updateView(
            resolvedCurrentView.id as string,
            { sorts: nextSorts },
            { silent: true },
          ).catch((error: unknown) => {
            console.error('❌ 右键菜单排序同步失败:', error);
            toast({
              title: String(t('table:header.sortFailedTitle' as any)),
              description:
                error instanceof Error
                  ? error.message
                  : String(t('table:header.sortFailedDesc' as any)),
              variant: 'destructive',
            });
          });
        }

        dispatchOpenViewSortPopover({
          viewId: resolvedCurrentView.id as string,
          fieldId: targetField.id,
        });
        return;
      }

      if (action === 'edit') {
        useFieldSettingStore
          .getState()
          .openForEdit(
            targetField.id,
            undefined,
            selectedTable?.id ?? null,
            fieldSettingHostId,
          );
        return;
      }

      if (action === 'duplicate') {
        void handleDuplicateFieldFromMenu(targetField);
        return;
      }

      if (action === 'insert') {
        const position = info.api?.position === 'left' ? 'before' : 'after';
        useFieldSettingStore
          .getState()
          .openForInsert(
            targetField.id,
            position,
            selectedTable?.id ?? null,
            fieldSettingHostId,
          );
        return;
      }

      if (action === 'filter') {
        void handleFilterFieldFromMenu(targetField).then((shouldOpen) => {
          if (!shouldOpen) return;
          dispatchOpenViewFilterPopover({
            viewId: resolvedCurrentView?.id ?? null,
            fieldId: targetField.id,
          });
        });
        return;
      }

      if (action === 'group') {
        void handleGroupFieldFromMenu(targetField);
        return;
      }

      if (action === 'set-primary') {
        void handleSetPrimaryField(targetField);
        return;
      }

      if (action === 'hide') {
        void handleHideField(targetField);
        return;
      }

      if (action === 'delete') {
        handleDeleteField(targetField);
        return;
      }
    },
    [
      allowViewMutation,
      fieldByName,
      fieldById,
      fieldSettingHostId,
      handleDeleteField,
      handleDuplicateFieldFromMenu,
      handleFilterFieldFromMenu,
      handleGroupFieldFromMenu,
      handleHideField,
      handleSetPrimaryField,
      handleSortFromMenu,
      isPersonalViewEnabled,
      isTableReadonly,
      notifyLockedViewDenied,
      resolvedCurrentView,
      setPersonalViewDraft,
      selectedTable?.id,
      t,
      updateView,
    ],
  );

  // ── i18n labels ──

  const {
    fieldMenuLabels: canvasFieldMenuLabels,
    recordMenuLabels: canvasRecordMenuLabels,
    allRecordsCheckboxTooltip,
  } = React.useMemo(
    () => buildCanvasMenuLabels((key, opts) => String(t(`table:${key}`, opts as any))),
    [t],
  );

  const canvasStatisticMenuLabels = React.useMemo(
    () => ({
      [StatFunc.None]: String(t('table:statistics.func.none')),
      [StatFunc.Count]: String(t('table:statistics.func.count')),
      [StatFunc.Empty]: String(t('table:statistics.func.empty')),
      [StatFunc.Filled]: String(t('table:statistics.func.filled')),
      [StatFunc.Unique]: String(t('table:statistics.func.unique')),
      [StatFunc.Sum]: String(t('table:statistics.func.sum')),
      [StatFunc.Average]: String(t('table:statistics.func.average')),
      [StatFunc.Min]: String(t('table:statistics.func.min')),
      [StatFunc.Max]: String(t('table:statistics.func.max')),
      [StatFunc.Checked]: String(t('table:statistics.func.checked')),
      [StatFunc.Unchecked]: String(t('table:statistics.func.unchecked')),
      [StatFunc.PercentEmpty]: String(t('table:statistics.func.percentEmpty')),
      [StatFunc.PercentFilled]: String(
        t('table:statistics.func.percentFilled'),
      ),
      [StatFunc.PercentUnique]: String(
        t('table:statistics.func.percentUnique'),
      ),
      [StatFunc.PercentChecked]: String(
        t('table:statistics.func.percentChecked'),
      ),
      [StatFunc.PercentUnchecked]: String(
        t('table:statistics.func.percentUnchecked'),
      ),
      [StatFunc.EarliestDate]: String(
        t('table:statistics.func.earliestDate'),
      ),
      [StatFunc.LatestDate]: String(t('table:statistics.func.latestDate')),
      [StatFunc.DateRangeOfDays]: String(
        t('table:statistics.func.dateRangeDays'),
      ),
      [StatFunc.DateRangeOfMonths]: String(
        t('table:statistics.func.dateRangeMonths'),
      ),
    }),
    [t],
  );

  const canvasEditorLabels = React.useMemo(
    () => ({
      selectSearchPlaceholder: String(
        t('table:grid.editorSelectSearchPlaceholder'),
      ),
      selectSearchPlaceholderEmpty: String(
        t('table:grid.editorSelectSearchPlaceholderEmpty'),
      ),
      selectNoResults: String(t('table:grid.editorSelectNoResults')),
      selectEmptyHint: String(t('table:grid.editorSelectEmptyHint')),
      selectAddOption: String(t('table:grid.editorSelectAddOption')),
      selectDoneLabel: String(t('table:grid.editorSelectDoneLabel')),
      attachmentUpload: String(t('table:grid.attachmentUpload')),
      attachmentUploading: String(t('table:grid.attachmentUploading')),
      attachmentUploadHint: String(t('table:grid.attachmentUploadHint')),
      attachmentEmpty: String(t('table:grid.attachmentEmpty')),
      attachmentDownloadAll: String(t('table:grid.attachmentDownloadAll')),
      attachmentRemove: String(t('table:grid.attachmentRemove')),
      attachmentFileTypeNotAllowed: String(t('table:grid.attachmentFileTypeNotAllowed')),
    }),
    [t],
  );

  return {
    resolveContextRowId,
    resolveContextRowLabel,
    handleCanvasRowContextMenu,
    handleFieldMenuAction,
    canvasFieldMenuLabels,
    canvasRecordMenuLabels,
    canvasStatisticMenuLabels,
    canvasEditorLabels,
    allRecordsCheckboxTooltip,
  };
}
