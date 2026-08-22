/**
 * useDataGridFieldOps - 字段操作 hook
 *
 * 职责：
 * 1. 字段名称生成（新建、复制）
 * 2. 字段复制 → handleDuplicateFieldFromMenu
 * 3. 字段插入 → handleInsertFieldFromMenu
 * 4. 字段过滤 → handleFilterFieldFromMenu
 * 5. 字段分组 → handleGroupFieldFromMenu
 */

import React from 'react';
import { toast } from '@tabtin/smartsheet-ui';
import type { Field, ViewFilter, ViewGroup, ViewMeta } from '@tabtin/table-core';
import { FieldApiService } from '@tabtin/table-core';

// ---------------------------------------------------------------------------
// Filter helpers (pure functions)
// ---------------------------------------------------------------------------

const FIELD_FILTER_OPERATOR: Record<string, string> = {
  text: 'contains',
  number: 'equals',
  date: 'equals',
  select: 'equals',
  single_select: 'equals', // legacy alias for select
  multi_select: 'has_any_of',
  checkbox: 'is',
  attachment: 'is_empty',
};

const EMPTY_FILTER_OPERATORS = new Set(['is_empty', 'is_not_empty']);

const ARRAY_FILTER_OPERATORS_BY_FIELD_TYPE: Record<string, Set<string>> = {
  select: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
  single_select: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']), // legacy alias for select
  multi_select: new Set([
    'has_any_of',
    'has_all_of',
    'has_none_of',
    'is_exactly',
    'is_not_exactly',
    // 兼容旧值
    'contains',
    'not_contains',
    'equals',
    'not_equals',
    'in',
    'not_in',
  ]),
};

const isArrayFilterOperatorForField = (
  fieldType: string,
  operator: string,
): boolean => {
  return (
    ARRAY_FILTER_OPERATORS_BY_FIELD_TYPE[fieldType]?.has(operator) ?? false
  );
};

export const resolveDefaultFilterOperator = (
  fieldType: unknown,
): string => {
  if (typeof fieldType !== 'string') {
    return 'contains';
  }
  return FIELD_FILTER_OPERATOR[fieldType] ?? 'contains';
};

export const resolveDefaultFilterValue = (
  fieldType: unknown,
  operator: string,
): unknown => {
  if (EMPTY_FILTER_OPERATORS.has(operator)) {
    return null;
  }

  const normalizedFieldType =
    typeof fieldType === 'string' ? fieldType : 'text';
  if (
    normalizedFieldType === 'date'
  ) {
    let timeZone = 'UTC';
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      timeZone = 'UTC';
    }
    return {
      mode: 'exactDate',
      exactDate: '',
      timeZone,
    };
  }
  if (normalizedFieldType === 'checkbox') {
    return null;
  }
  if (
    normalizedFieldType === 'select' ||
    normalizedFieldType === 'single_select' /* legacy alias */ ||
    normalizedFieldType === 'multi_select'
  ) {
    return isArrayFilterOperatorForField(normalizedFieldType, operator)
      ? []
      : '';
  }

  return '';
};

export const createViewFilterId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `filter_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseDataGridFieldOpsParams {
  fields: Field[];
  selectedTableId: string | null;
  currentViewId: string | null;
  resolvedCurrentView: ViewMeta | null;
  allowViewMutation: boolean;
  draftFilters: ViewFilter[];
  setDraftFilters: (viewId: string, filters: ViewFilter[]) => void;
  setDraftGroups: (viewId: string, groups: ViewGroup[]) => void;
  applyDraft: (viewId: string) => Promise<void>;
  refreshFieldsAndView: () => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
  isTableReadonly?: boolean;
  isCollabSyncActive?: boolean;
  createFieldForRuntime?: (payload: {
    name: string;
    field_type: string;
    options?: Record<string, unknown>;
    insert_position?: 'before' | 'after';
    reference_field_id?: string;
  }) => Promise<Record<string, unknown> | null>;
}

const isStructuralFieldType = (fieldType: string) => fieldType === 'link';

export interface UseDataGridFieldOpsReturn {
  buildInsertedFieldName: () => string;
  buildDuplicatedFieldName: (field: Field) => string;
  notifyLockedViewDenied: () => void;
  handleDuplicateFieldFromMenu: (field: Field) => Promise<void>;
  handleInsertFieldFromMenu: (
    field: Field,
    position: 'left' | 'right',
  ) => Promise<void>;
  handleFilterFieldFromMenu: (field: Field) => Promise<boolean>;
  handleGroupFieldFromMenu: (field: Field) => Promise<void>;
}

export function useDataGridFieldOps({
  fields,
  selectedTableId,
  currentViewId,
  resolvedCurrentView,
  allowViewMutation,
  draftFilters,
  setDraftFilters,
  setDraftGroups,
  applyDraft,
  refreshFieldsAndView,
  t,
  isTableReadonly = false,
  isCollabSyncActive = false,
  createFieldForRuntime,
}: UseDataGridFieldOpsParams): UseDataGridFieldOpsReturn {
  const notifyLockedViewDenied = React.useCallback(() => {
    toast({
      title: String(t('table:header.lockedEditDeniedTitle' as any)),
      description: String(t('table:header.lockedEditDeniedDesc' as any)),
      variant: 'destructive',
    });
  }, [t]);

  const buildInsertedFieldName = React.useCallback(() => {
    const baseName = String(t('table:field.defaultName' as any)).trim();
    const existingNames = new Set(fields.map((item) => item.name));
    if (!existingNames.has(baseName)) {
      return baseName;
    }
    let index = 2;
    let candidate = `${baseName} ${index}`;
    while (existingNames.has(candidate)) {
      index += 1;
      candidate = `${baseName} ${index}`;
    }
    return candidate;
  }, [fields, t]);

  const buildDuplicatedFieldName = React.useCallback(
    (field: Field) => {
      const suffix = String(t('table:field.copySuffix' as any)).trim();
      const baseName = `${field.name} ${suffix}`.trim();
      const existingNames = new Set(fields.map((item) => item.name));
      if (!existingNames.has(baseName)) {
        return baseName;
      }
      let index = 2;
      let candidate = `${baseName} ${index}`;
      while (existingNames.has(candidate)) {
        index += 1;
        candidate = `${baseName} ${index}`;
      }
      return candidate;
    },
    [fields, t],
  );

  const handleDuplicateFieldFromMenu = React.useCallback(
    async (field: Field) => {
      if (isTableReadonly) return
      const tableId = selectedTableId ?? field.table_id;
      if (!tableId) {
        return;
      }

      try {
        if (
          isCollabSyncActive &&
          createFieldForRuntime &&
          !isStructuralFieldType(field.field_type)
        ) {
          // 协作路径已乐观写入 fields store + Y.Doc，跳过会覆盖新字段的立即 REST refresh。
          await createFieldForRuntime({
            name: buildDuplicatedFieldName(field),
            field_type: field.field_type,
            options: field.options as Record<string, unknown> | undefined,
            insert_position: 'after',
            reference_field_id: field.id,
          });
        } else {
          await FieldApiService.createField({
            table_id: tableId,
            name: buildDuplicatedFieldName(field),
            field_type: field.field_type,
            description: field.description,
            options: field.options,
            width: field.width,
            validation_rules: field.validation_rules,
            visibility_roles: field.visibility_roles,
            insert_position: 'after',
            reference_field_id: field.id,
          });
          await refreshFieldsAndView();
        }
      } catch (error) {
        toast({
          title: String(t('table:field.duplicateFailedTitle' as any)),
          description:
            error instanceof Error
              ? error.message
              : String(t('table:field.operationRetryDesc' as any)),
          variant: 'destructive',
        });
      }
    },
    [buildDuplicatedFieldName, createFieldForRuntime, isCollabSyncActive, isTableReadonly, refreshFieldsAndView, selectedTableId, t],
  );

  const handleInsertFieldFromMenu = React.useCallback(
    async (field: Field, position: 'left' | 'right') => {
      if (isTableReadonly) return
      const tableId = selectedTableId ?? field.table_id;
      if (!tableId) {
        return;
      }

      try {
        if (isCollabSyncActive && createFieldForRuntime) {
          // 协作路径已乐观写入 fields store + Y.Doc，跳过会覆盖新字段的立即 REST refresh。
          await createFieldForRuntime({
            name: buildInsertedFieldName(),
            field_type: 'text',
            insert_position: position === 'left' ? 'before' : 'after',
            reference_field_id: field.id,
          });
        } else {
          await FieldApiService.createField({
            table_id: tableId,
            name: buildInsertedFieldName(),
            field_type: 'text',
            insert_position: position === 'left' ? 'before' : 'after',
            reference_field_id: field.id,
          });
          await refreshFieldsAndView();
        }
      } catch (error) {
        toast({
          title: String(t('table:field.insertFailedTitle' as any)),
          description:
            error instanceof Error
              ? error.message
              : String(t('table:field.operationRetryDesc' as any)),
          variant: 'destructive',
        });
      }
    },
    [buildInsertedFieldName, createFieldForRuntime, isCollabSyncActive, isTableReadonly, refreshFieldsAndView, selectedTableId, t],
  );

  const handleFilterFieldFromMenu = React.useCallback(
    async (field: Field) => {
      if (!currentViewId) {
        return false;
      }
      if (!allowViewMutation) {
        notifyLockedViewDenied();
        return false;
      }

      const alreadyHasFilter = draftFilters.some(
        (filter) => filter.field_id === field.id,
      );
      if (alreadyHasFilter) {
        return true;
      }

      const operator = resolveDefaultFilterOperator(field.field_type);
      const nextFilter: ViewFilter = {
        id: createViewFilterId(),
        field_id: field.id,
        operator,
        value: resolveDefaultFilterValue(field.field_type, operator),
        enabled: true,
      };

      try {
        setDraftFilters(currentViewId, [...draftFilters, nextFilter]);
        await applyDraft(currentViewId);
        return true;
      } catch (error) {
        toast({
          title: String(t('view:filterPanel.updateFailedTitle' as any)),
          description:
            error instanceof Error
              ? error.message
              : String(t('view:filterPanel.updateFailedDesc' as any)),
          variant: 'destructive',
        });
        return false;
      }
    },
    [
      allowViewMutation,
      applyDraft,
      currentViewId,
      draftFilters,
      notifyLockedViewDenied,
      setDraftFilters,
      t,
    ],
  );

  const handleGroupFieldFromMenu = React.useCallback(
    async (field: Field) => {
      if (!currentViewId) {
        return;
      }
      if (!allowViewMutation) {
        notifyLockedViewDenied();
        return;
      }

      const currentGroups = Array.isArray(resolvedCurrentView?.groups)
        ? (resolvedCurrentView!.groups as ViewGroup[])
        : [];
      if (currentGroups.some((group) => group.field_id === field.id)) {
        return;
      }

      const nextGroups: ViewGroup[] = [
        ...currentGroups,
        {
          field_id: field.id,
          direction: 'asc',
        },
      ];

      try {
        setDraftGroups(currentViewId, nextGroups);
        await applyDraft(currentViewId);
      } catch (error) {
        toast({
          title: String(t('view:groupPanel.updateFailedTitle' as any)),
          description:
            error instanceof Error
              ? error.message
              : String(t('view:groupPanel.updateFailedDesc' as any)),
          variant: 'destructive',
        });
      }
    },
    [
      allowViewMutation,
      applyDraft,
      currentViewId,
      notifyLockedViewDenied,
      resolvedCurrentView,
      setDraftGroups,
      t,
    ],
  );

  return {
    buildInsertedFieldName,
    buildDuplicatedFieldName,
    notifyLockedViewDenied,
    handleDuplicateFieldFromMenu,
    handleInsertFieldFromMenu,
    handleFilterFieldFromMenu,
    handleGroupFieldFromMenu,
  };
}
