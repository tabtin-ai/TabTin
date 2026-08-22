import React from 'react';
import type { AttachmentTaskState } from '@/stores/useAttachmentStore';
import {
  buildUploadingAttachmentRows,
  type AttachmentLikeField,
} from '../utils/uploadingAttachmentRows';
import type { GridDisplayRows } from '../utils/gridDisplayUtils';

const DRAFT_ROW_ID = '__draft_row__';

interface UseGridRowAssemblyInput {
  canvasOptimisticRows: GridDisplayRows | null;
  searchFilteredRowsForDisplay: GridDisplayRows;
  selectedTableId: string | null | undefined;
  fields: AttachmentLikeField[];
  attachmentTasks: Record<string, AttachmentTaskState>;
  attachmentPreviewUrls: Record<string, string>;
  removeAttachmentTask: (key: string) => void;
}

export function useGridRowAssembly({
  canvasOptimisticRows,
  searchFilteredRowsForDisplay,
  selectedTableId,
  fields,
  attachmentTasks,
  attachmentPreviewUrls,
  removeAttachmentTask,
}: UseGridRowAssemblyInput) {
  const baseRowsForGridDisplay = React.useMemo<GridDisplayRows>(
    () => canvasOptimisticRows ?? searchFilteredRowsForDisplay,
    [canvasOptimisticRows, searchFilteredRowsForDisplay],
  );

  const {
    rows: rowsForGridDisplay,
    resolvedTaskKeys: resolvedAttachmentTaskKeys,
  } = React.useMemo(
    () =>
      buildUploadingAttachmentRows({
        rows: baseRowsForGridDisplay,
        selectedTableId: selectedTableId ?? null,
        fields,
        tasks: attachmentTasks,
        previewUrls: attachmentPreviewUrls,
        draftRowId: DRAFT_ROW_ID,
      }),
    [
      attachmentPreviewUrls,
      attachmentTasks,
      baseRowsForGridDisplay,
      fields,
      selectedTableId,
    ],
  );

  React.useEffect(() => {
    if (resolvedAttachmentTaskKeys.length === 0) {
      return;
    }
    resolvedAttachmentTaskKeys.forEach((taskKey) => {
      removeAttachmentTask(taskKey);
    });
  }, [removeAttachmentTask, resolvedAttachmentTaskKeys]);

  return rowsForGridDisplay;
}
