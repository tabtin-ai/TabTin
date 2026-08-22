import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveRecordId, type TableGridRow } from '@tabtin/table-engine';
import type { TableRecord, ViewRecordsResponse } from '@tabtin/table-core';
import type { RecordFormFocusTarget } from '@/components/record/recordFormFocusTarget';

interface UseDataGridRecordEditorInput {
  useViewData: boolean;
  records: TableRecord[];
  currentViewRecords: ViewRecordsResponse | null;
  visibleRecordIds: string[];
  registerRecordEditor: (
    editor: (row: TableGridRow | null) => void,
  ) => void;
}

interface UseDataGridRecordEditorResult {
  showEditDialog: boolean;
  editingRecord: TableRecord | undefined;
  initialCommentsOpen: boolean;
  initialFocusTarget: RecordFormFocusTarget | null;
  openRecordEditorWithComments: (
    row: TableGridRow,
    options?: { focusTarget?: RecordFormFocusTarget },
  ) => void;
  handleRecordDialogOpenChange: (open: boolean) => void;
  canNavigatePrev: boolean;
  canNavigateNext: boolean;
  navigateToPrevRecord: () => void;
  navigateToNextRecord: () => void;
}

export const useDataGridRecordEditor = ({
  useViewData,
  records,
  currentViewRecords,
  visibleRecordIds,
  registerRecordEditor,
}: UseDataGridRecordEditorInput): UseDataGridRecordEditorResult => {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [initialCommentsOpen, setInitialCommentsOpen] = useState(false);
  const [initialFocusTarget, setInitialFocusTarget] = useState<RecordFormFocusTarget | null>(null);

  const sourceRecords = useMemo(
    () => (useViewData ? (currentViewRecords?.records ?? []) : records),
    [currentViewRecords, records, useViewData],
  );

  const recordById = useMemo(() => {
    const map = new Map<string, TableRecord>();
    sourceRecords.forEach((record) => {
      if (typeof record?.id === 'string' && record.id.length > 0) {
        map.set(record.id, record);
      }
    });
    return map;
  }, [sourceRecords]);

  const editingRecord = useMemo(() => {
    if (!editingRecordId) {
      return undefined;
    }
    return recordById.get(editingRecordId);
  }, [editingRecordId, recordById]);

  const currentRecordIndex = useMemo(() => {
    if (!editingRecordId) {
      return -1;
    }
    return visibleRecordIds.findIndex((id) => id === editingRecordId);
  }, [editingRecordId, visibleRecordIds]);

  const canNavigatePrev = currentRecordIndex > 0;
  const canNavigateNext =
    currentRecordIndex >= 0 && currentRecordIndex < visibleRecordIds.length - 1;

  const handleRecordDialogOpenChange = useCallback((open: boolean) => {
    setShowEditDialog(open);
    if (!open) {
      setEditingRecordId(null);
      setInitialCommentsOpen(false);
      setInitialFocusTarget(null);
    }
  }, []);

  const openRecordEditor = useCallback(
    (
      row: TableGridRow | null,
      commentsOpen: boolean,
      focusTarget: RecordFormFocusTarget | null = null,
    ) => {
      if (!row) {
        setShowEditDialog(false);
        setEditingRecordId(null);
        setInitialCommentsOpen(false);
        setInitialFocusTarget(null);
        return;
      }

      const rowId = resolveRecordId(row) ?? '';

      const candidate =
        sourceRecords.find((record) => {
          if (!rowId) return false;
          if (record.id === rowId) {
            return true;
          }
          if (typeof record.row_id === 'string') {
            return record.row_id === rowId;
          }
          return false;
        }) ?? null;

      if (!candidate) {
        console.warn('⚠️ 找不到记录数据，无法打开编辑器');
        return;
      }

      if (!candidate.id) {
        console.warn('⚠️ 记录缺少 ID，无法打开编辑器');
        return;
      }

      setEditingRecordId(candidate.id);
      setInitialCommentsOpen(commentsOpen);
      setInitialFocusTarget(commentsOpen ? focusTarget : null);
      setShowEditDialog(true);
    },
    [sourceRecords],
  );

  const handleOpenRecordEditor = useCallback(
    (row: TableGridRow | null) => openRecordEditor(row, false),
    [openRecordEditor],
  );

  const openRecordEditorWithComments = useCallback(
    (row: TableGridRow, options?: { focusTarget?: RecordFormFocusTarget }) =>
      openRecordEditor(row, true, options?.focusTarget ?? null),
    [openRecordEditor],
  );

  const navigateToPrevRecord = useCallback(() => {
    if (!canNavigatePrev) {
      return;
    }
    const prevRecordId = visibleRecordIds[currentRecordIndex - 1];
    if (!prevRecordId) {
      return;
    }
    setEditingRecordId(prevRecordId);
  }, [canNavigatePrev, currentRecordIndex, visibleRecordIds]);

  const navigateToNextRecord = useCallback(() => {
    if (!canNavigateNext) {
      return;
    }
    const nextRecordId = visibleRecordIds[currentRecordIndex + 1];
    if (!nextRecordId) {
      return;
    }
    setEditingRecordId(nextRecordId);
  }, [canNavigateNext, currentRecordIndex, visibleRecordIds]);

  useEffect(() => {
    registerRecordEditor(handleOpenRecordEditor);
  }, [registerRecordEditor, handleOpenRecordEditor]);

  return {
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
  };
};
