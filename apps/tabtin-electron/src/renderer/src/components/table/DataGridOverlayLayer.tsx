import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  RecordHistorySheet,
} from '@tabtin/smartsheet-ui';
import { FieldDeleteConfirmDialog } from './FieldDeleteConfirmDialog';
import type { HistoryOperation } from '@tabtin/smartsheet-ui';
import { RecordFormContainer } from '@/components/record';
import { LinkedRecordFormHost } from '@/components/record/LinkedRecordFormHost';
import { LinkCellEditor } from '@/components/field/LinkCellEditor';
import type { Field, TableRecord } from '@tabtin/table-core';
import {
  announceTableDrawerOpen,
  useCloseOnOtherTableDrawerOpen,
} from './utils/tableDrawerCoordinator';
import type { LinkedRecordDetailState } from './hooks/useDataGridLinkEditor';
import type { RecordFormFocusTarget } from '@/components/record/recordFormFocusTarget';

interface DataGridOverlayLayerProps {
  showEditDialog: boolean;
  editingRecord: TableRecord | undefined;
  initialCommentsOpen?: boolean;
  initialFocusTarget?: RecordFormFocusTarget | null;
  onRecordDialogOpenChange: (open: boolean) => void;
  canNavigatePrev?: boolean;
  canNavigateNext?: boolean;
  onNavigatePrev?: () => void;
  onNavigateNext?: () => void;
  showFieldDeleteConfirm: boolean;
  setShowFieldDeleteConfirm: (value: boolean) => void;
  deletingField: Field | null;
  onConfirmDeleteField: () => Promise<void>;
  /** W1.4 / C1:用户在删除前对话框点「查看版本历史」的回调 */
  onOpenFieldVersionHistory?: () => void;
  translate: (key: string, options?: Record<string, unknown>) => string;
  // 记录变更历史对话框
  showRecordHistory?: boolean;
  recordHistoryRecordLabel?: string;
  recordHistoryOps?: HistoryOperation[];
  recordHistoryTotal?: number;
  isLoadingRecordHistory?: boolean;
  onCloseRecordHistory?: () => void;
  onLoadMoreRecordHistory?: () => void;
  fieldNameMap?: Record<string, string>;
  fieldTypeMap?: Record<string, string>;
  /** 从 RecordForm 打开记录历史 */
  onViewRecordHistory?: (recordId: string, recordLabel: string) => void;
  /** 高亮单元格回调（用于变更历史面板） */
  onHighlightCells?: (recordId: string, fieldKeys: string[]) => void;
  /** 快照数据（记录级历史） */
  snapshotData?: Record<string, unknown> | null;
  snapshotLoading?: boolean;
  onRequestSnapshot?: (recordId: string, historyId: string, fieldKeys?: string[]) => void;
  /** 记录级还原回调 */
  onRequestRestore?: (recordId: string, historyId: string) => void;
  /** 是否正在执行还原 */
  restoreLoading?: boolean;
  // Link cell editor
  showLinkEditor?: boolean;
  linkEditorTableId?: string;
  linkEditorRecordId?: string;
  linkEditorFieldId?: string;
  linkEditorFieldConfig?: {
    foreignTableId: string;
    relationship: string;
    lookupFieldId?: string;
    isOneWay?: boolean;
    visibleFieldIds?: string[];
    filterByViewId?: string;
  };
  linkEditorCurrentValue?: Array<{ id: string; title?: string }>;
  linkEditorSpaceId?: string;
  onCloseLinkEditor?: () => void;
  onSaveLinkEditor?: (newValue: Array<{ id: string; title?: string }>) => Promise<void>;
  onOpenLinkedRecordFromPicker?: (payload: {
    foreignTableId: string;
    recordId: string;
    title?: string;
  }) => void;
  linkedRecordDetail?: LinkedRecordDetailState | null;
  onCloseLinkedRecordDetail?: () => void;
  onLinkedRecordSaved?: () => void;
  isReadonly?: boolean;
}

export const DataGridOverlayLayer: React.FC<DataGridOverlayLayerProps> = ({
  showEditDialog,
  editingRecord,
  initialCommentsOpen = false,
  initialFocusTarget = null,
  onRecordDialogOpenChange,
  canNavigatePrev = false,
  canNavigateNext = false,
  onNavigatePrev,
  onNavigateNext,
  showFieldDeleteConfirm,
  setShowFieldDeleteConfirm,
  deletingField,
  onConfirmDeleteField,
  onOpenFieldVersionHistory,
  translate,
  showRecordHistory = false,
  recordHistoryRecordLabel = '',
  recordHistoryOps = [],
  recordHistoryTotal = 0,
  isLoadingRecordHistory = false,
  onCloseRecordHistory,
  onLoadMoreRecordHistory,
  fieldNameMap = {},
  fieldTypeMap = {},
  onViewRecordHistory,
  onHighlightCells,
  snapshotData,
  snapshotLoading = false,
  onRequestSnapshot,
  onRequestRestore,
  restoreLoading = false,
  showLinkEditor = false,
  linkEditorTableId = '',
  linkEditorRecordId = '',
  linkEditorFieldId = '',
  linkEditorFieldConfig,
  linkEditorCurrentValue = [],
  linkEditorSpaceId,
  onCloseLinkEditor,
  onSaveLinkEditor,
  onOpenLinkedRecordFromPicker,
  linkedRecordDetail = null,
  onCloseLinkedRecordDetail,
  onLinkedRecordSaved,
  isReadonly = false,
}) => {
  const { i18n } = useTranslation();
  const recordHistoryDrawerId = React.useId();
  const isRecordHistoryOpen = Boolean(showRecordHistory && onCloseRecordHistory);

  React.useEffect(() => {
    if (isRecordHistoryOpen) {
      announceTableDrawerOpen('record-history', recordHistoryDrawerId);
    }
  }, [isRecordHistoryOpen, recordHistoryDrawerId]);

  useCloseOnOtherTableDrawerOpen(
    'record-history',
    recordHistoryDrawerId,
    isRecordHistoryOpen,
    () => {
      onCloseRecordHistory?.();
    },
  );

  return (
    <>
      <RecordFormContainer
        open={showEditDialog}
        onOpenChange={onRecordDialogOpenChange}
        mode={editingRecord ? 'edit' : 'create'}
        record={editingRecord}
        initialCommentsOpen={initialCommentsOpen}
        initialFocusTarget={initialFocusTarget}
        canNavigatePrev={canNavigatePrev}
        canNavigateNext={canNavigateNext}
        onNavigatePrev={onNavigatePrev}
        onNavigateNext={onNavigateNext}
        onViewHistory={onViewRecordHistory}
        isReadonly={isReadonly}
      />

      <FieldDeleteConfirmDialog
        open={showFieldDeleteConfirm}
        onOpenChange={setShowFieldDeleteConfirm}
        fieldId={deletingField?.id ?? ''}
        fieldName={deletingField?.name ?? ''}
        fieldType={deletingField?.field_type ?? ''}
        isPrimary={deletingField?.is_primary ?? false}
        onConfirm={onConfirmDeleteField}
        onOpenVersionHistory={onOpenFieldVersionHistory}
      />

      {onCloseRecordHistory && (
        <RecordHistorySheet
          open={showRecordHistory}
          onOpenChange={(open) => {
            if (!open) onCloseRecordHistory();
          }}
          label={recordHistoryRecordLabel}
          operations={recordHistoryOps}
          total={recordHistoryTotal}
          loading={isLoadingRecordHistory}
          onLoadMore={onLoadMoreRecordHistory}
          fieldNameMap={fieldNameMap}
          fieldTypeMap={fieldTypeMap}
          onGroupClick={onHighlightCells ? (group) => {
            const fieldKeys = group.changes.map(c => c.fieldId);
            for (const rid of group.recordIds) {
              onHighlightCells(rid, fieldKeys);
            }
          } : undefined}
          snapshotData={snapshotData}
          snapshotLoading={snapshotLoading}
          onRequestSnapshot={onRequestSnapshot ? (group) => {
            if (group.recordIds.length > 0) {
              onRequestSnapshot(
                group.recordIds[0],
                group.id,
                group.changes.map((c) => c.fieldId),
              );
            }
          } : undefined}
          onRequestRestore={
            isReadonly || !onRequestRestore
              ? undefined
              : (group) => {
                  if (group.recordIds.length > 0) {
                    onRequestRestore(group.recordIds[0], group.id);
                  }
                }
          }
          restoreLoading={isReadonly ? false : restoreLoading}
          locale={i18n.language}
        />
      )}

      {onCloseLinkEditor && onSaveLinkEditor && linkEditorFieldConfig && !isReadonly && (
        <LinkCellEditor
          open={showLinkEditor}
          onClose={onCloseLinkEditor}
          tableId={linkEditorTableId}
          recordId={linkEditorRecordId}
          fieldId={linkEditorFieldId}
          fieldConfig={linkEditorFieldConfig}
          currentValue={linkEditorCurrentValue}
          onSave={onSaveLinkEditor}
          spaceId={linkEditorSpaceId}
          onOpenLinkedRecord={onOpenLinkedRecordFromPicker}
        />
      )}

      {linkedRecordDetail && onCloseLinkedRecordDetail && (
        <LinkedRecordFormHost
          open={Boolean(linkedRecordDetail)}
          onOpenChange={(open) => {
            if (!open) onCloseLinkedRecordDetail();
          }}
          foreignTableId={linkedRecordDetail.foreignTableId}
          recordId={linkedRecordDetail.recordId}
          titleHint={linkedRecordDetail.title}
          // 关联 chip / 完整详情入口：只查看目标记录，不跨表编辑
          isReadonly
          onSaved={onLinkedRecordSaved}
          // 从画布 chip 打开时不广播互斥，避免与其它 record-form 监听竞态误关
          coordinateDrawers={false}
        />
      )}
    </>
  );
};
