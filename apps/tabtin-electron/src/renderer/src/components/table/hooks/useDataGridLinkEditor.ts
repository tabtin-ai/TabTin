import React from 'react';
import type { RecordFieldKeyType, TableRecord } from '@tabtin/table-core';

export interface LinkEditorFieldConfig {
  foreignTableId: string;
  relationship: string;
  lookupFieldId?: string;
  isOneWay?: boolean;
  visibleFieldIds?: string[];
  filterByViewId?: string;
}

export interface LinkEditorState {
  recordId: string;
  fieldId: string;
  fieldConfig: LinkEditorFieldConfig;
  currentValue: Array<{ id: string; title?: string }>;
}

export interface LinkedRecordDetailState {
  foreignTableId: string;
  recordId: string;
  title?: string;
  /** 打开详情前的源单元格，关闭后可回到选择器（可选） */
  sourceCell?: { recordId: string; fieldId: string };
}

interface FieldLike {
  id: string;
  name: string;
  field_type: string;
  options?: Record<string, unknown>;
}

export interface UseDataGridLinkEditorParams {
  fields: FieldLike[];
  records: TableRecord[];
  selectedTableId: string | null;
  updateRecord: (
    recordId: string,
    payload: {
      data: Record<string, unknown>;
      fields: Record<string, unknown>;
      fieldKeyType: RecordFieldKeyType;
    },
  ) => Promise<unknown>;
  mergeIncrementalRecords: (records: TableRecord[], version: number) => void;
  latestVersion: number | null | undefined;
  /** 目标表已打开时刷新其记录（对称展示） */
  onSymmetricLinkSaved?: (foreignTableId: string) => void;
}

export interface UseDataGridLinkEditorReturn {
  showLinkEditor: boolean;
  linkEditorState: LinkEditorState | null;
  linkedRecordDetail: LinkedRecordDetailState | null;
  handleLinkCellExpand: (recordId: string, fieldId: string) => void;
  handleLinkTagClick: (recordId: string, fieldId: string, linkedRecordId: string) => void;
  handleCloseLinkEditor: () => void;
  handleSaveLinkEditor: (newValue: Array<{ id: string; title?: string }>) => Promise<void>;
  handleOpenLinkedRecord: (payload: {
    foreignTableId: string;
    recordId: string;
    title?: string;
  }) => void;
  handleCloseLinkedRecordDetail: () => void;
}

function readLinkCellValue(
  record: TableRecord | undefined,
  field: FieldLike,
): Array<{ id: string; title?: string }> {
  const rawValue =
    (record as any)?.fields?.[field.id] ??
    (record as any)?.data?.[field.name] ??
    (record as any)?.data?.[field.id] ??
    (record as any)?.[field.name] ??
    undefined;
  if (Array.isArray(rawValue)) {
    return rawValue
      .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object')
      .map((v) => ({ id: String(v.id ?? ''), title: v.title ? String(v.title) : undefined }));
  }
  if (rawValue && typeof rawValue === 'object') {
    const v = rawValue as Record<string, unknown>;
    return [{ id: String(v.id ?? ''), title: v.title ? String(v.title) : undefined }];
  }
  return [];
}

export function useDataGridLinkEditor({
  fields,
  records,
  selectedTableId,
  updateRecord,
  mergeIncrementalRecords,
  latestVersion,
  onSymmetricLinkSaved,
}: UseDataGridLinkEditorParams): UseDataGridLinkEditorReturn {
  const [showLinkEditor, setShowLinkEditor] = React.useState(false);
  const [linkEditorState, setLinkEditorState] = React.useState<LinkEditorState | null>(null);
  const [linkedRecordDetail, setLinkedRecordDetail] =
    React.useState<LinkedRecordDetailState | null>(null);

  const buildFieldConfig = React.useCallback((field: FieldLike): LinkEditorFieldConfig | null => {
    const options = field.options as Record<string, unknown> | undefined;
    const foreignTableId = String(options?.foreignTableId ?? '');
    const relationship = String(options?.relationship ?? 'ManyMany');
    if (!foreignTableId) return null;
    const visibleFieldIds = Array.isArray(options?.visibleFieldIds)
      ? (options.visibleFieldIds as unknown[]).map(String).filter(Boolean)
      : undefined;
    return {
      foreignTableId,
      relationship,
      lookupFieldId: options?.lookupFieldId ? String(options.lookupFieldId) : undefined,
      isOneWay: Boolean(options?.isOneWay),
      visibleFieldIds,
      filterByViewId: options?.filterByViewId ? String(options.filterByViewId) : undefined,
    };
  }, []);

  const handleLinkCellExpand = React.useCallback(
    (recordId: string, fieldId: string) => {
      const field = fields.find((f) => f.id === fieldId);
      if (!field || field.field_type !== 'link') return;
      const fieldConfig = buildFieldConfig(field);
      if (!fieldConfig) return;

      const record = records.find((r) => r.id === recordId);
      // 打开选择器时关掉详情侧栏，避免双击 tag 时详情与选择器叠闪
      setLinkedRecordDetail(null);
      setLinkEditorState({
        recordId,
        fieldId,
        fieldConfig,
        currentValue: readLinkCellValue(record, field),
      });
      setShowLinkEditor(true);
    },
    [fields, records, buildFieldConfig],
  );

  /** 点击 chip：打开关联记录详情（复用主字段展开侧栏） */
  const handleLinkTagClick = React.useCallback(
    (recordId: string, fieldId: string, linkedRecordId: string) => {
      const field = fields.find((f) => f.id === fieldId);
      if (!field || field.field_type !== 'link') return;
      const fieldConfig = buildFieldConfig(field);
      if (!fieldConfig) return;

      const record = records.find((r) => r.id === recordId);
      const currentValue = readLinkCellValue(record, field);
      const linked = currentValue.find((item) => item.id === linkedRecordId);

      setShowLinkEditor(false);
      setLinkEditorState(null);
      setLinkedRecordDetail({
        foreignTableId: fieldConfig.foreignTableId,
        recordId: linkedRecordId,
        title: linked?.title,
        sourceCell: { recordId, fieldId },
      });
    },
    [fields, records, buildFieldConfig],
  );

  const handleCloseLinkEditor = React.useCallback(() => {
    setShowLinkEditor(false);
    setLinkEditorState(null);
  }, []);

  const handleOpenLinkedRecord = React.useCallback(
    (payload: { foreignTableId: string; recordId: string; title?: string }) => {
      setShowLinkEditor(false);
      setLinkedRecordDetail({
        foreignTableId: payload.foreignTableId,
        recordId: payload.recordId,
        title: payload.title,
        sourceCell: linkEditorState
          ? { recordId: linkEditorState.recordId, fieldId: linkEditorState.fieldId }
          : undefined,
      });
      setLinkEditorState(null);
    },
    [linkEditorState],
  );

  const handleCloseLinkedRecordDetail = React.useCallback(() => {
    setLinkedRecordDetail(null);
  }, []);

  const handleSaveLinkEditor = React.useCallback(
    async (newValue: Array<{ id: string; title?: string }>) => {
      if (!linkEditorState || !selectedTableId) return;

      const field = fields.find((f) => f.id === linkEditorState.fieldId);
      if (!field) return;

      const isSingle =
        linkEditorState.fieldConfig.relationship === 'OneOne' ||
        linkEditorState.fieldConfig.relationship === 'ManyOne';

      const cellValue = isSingle
        ? newValue.length > 0
          ? newValue[0]
          : null
        : newValue;

      await updateRecord(linkEditorState.recordId, {
        data: { [field.id]: cellValue },
        fields: { [field.id]: cellValue },
        fieldKeyType: 'id',
      });

      mergeIncrementalRecords(
        records.map((r) => {
          if (r.id !== linkEditorState.recordId) return r;
          return {
            ...r,
            data: { ...(r as any).data, [field.id]: cellValue },
            fields: { ...(r as any).fields, [field.id]: cellValue },
          };
        }),
        (latestVersion ?? 0) + 1,
      );

      // 双向关联：目标表已打开时触发刷新，未打开则下次进入读服务端真值
      if (!linkEditorState.fieldConfig.isOneWay) {
        onSymmetricLinkSaved?.(linkEditorState.fieldConfig.foreignTableId);
      }
    },
    [
      linkEditorState,
      selectedTableId,
      fields,
      updateRecord,
      records,
      mergeIncrementalRecords,
      latestVersion,
      onSymmetricLinkSaved,
    ],
  );

  return {
    showLinkEditor,
    linkEditorState,
    linkedRecordDetail,
    handleLinkCellExpand,
    handleLinkTagClick,
    handleCloseLinkEditor,
    handleSaveLinkEditor,
    handleOpenLinkedRecord,
    handleCloseLinkedRecordDetail,
  };
}
