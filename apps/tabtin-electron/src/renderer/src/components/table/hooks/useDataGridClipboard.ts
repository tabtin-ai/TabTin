/**
 * useDataGridClipboard — Electron 端 thin wrapper
 *
 * 核心逻辑已迁移至 @tabtin/table-ui，此文件注入 Electron 的 RecordStore。
 */

import {
  useDataGridClipboard as useDataGridClipboardBase,
  planPasteOperations,
  convertPasteValue,
  parseTsvText,
  type UseDataGridClipboardParams as BaseParams,
  type UseDataGridClipboardReturn,
  type PasteConfirmState,
  type ViewAwareCreatePlan,
} from '@tabtin/table-ui/clipboard';
import React from 'react';
import type { BulkCreateRecordsRequest, BulkUpdateRecordsRequest, CreateRecordRequest, TableRecord } from '@tabtin/table-core';
import type { TableGridClipboardPayload } from '@tabtin/table-engine';
import { useRecordStore } from '@stores/useRecordStore';

export { planPasteOperations, convertPasteValue, parseTsvText };
export type { UseDataGridClipboardReturn, PasteConfirmState, ViewAwareCreatePlan };

export type UseDataGridClipboardParams = Omit<
  BaseParams,
  'bulkUpdateRecords' | 'bulkCreateRecords'
> & {
  /** 协作在线且非 fallback：粘贴新建/更新走 Y.Doc，不走 REST+mirror */
  isCollabSyncActive?: boolean;
  createRecord?: (params: CreateRecordRequest) => Promise<TableRecord | null>;
  updateRecord?: (
    recordId: string,
    data: { fields?: Record<string, unknown>; data?: Record<string, unknown> },
  ) => Promise<unknown>;
  /** 离线降级：REST 写入后镜像进 Y.Doc */
  mirrorRecordsToCollab?: (records: TableRecord[]) => void;
};

export function useDataGridClipboard(
  params: UseDataGridClipboardParams,
): UseDataGridClipboardReturn {
  const {
    isCollabSyncActive,
    createRecord: createRecordCollab,
    updateRecord: updateRecordCollab,
    mirrorRecordsToCollab: mirrorRecordsToCollabInput,
    refreshAfterPaste,
    ...baseParams
  } = params;
  const bulkCreateRecords = useRecordStore((state) => state.bulkCreateRecords);
  const bulkUpdateRecords = useRecordStore((state) => state.bulkUpdateRecords);

  const mirrorRecordsToCollab = React.useCallback(
    (records: TableRecord[]) => mirrorRecordsToCollabInput?.(records),
    [mirrorRecordsToCollabInput],
  );

  const bulkCreateRecordsWithCollab = React.useCallback(
    async (request: BulkCreateRecordsRequest) => {
      if (isCollabSyncActive && createRecordCollab) {
        const created: TableRecord[] = [];
        let nextOrderContext = request.order_context;
        for (const recordData of request.records) {
          const row = await createRecordCollab({
            table_id: request.table_id,
            data: recordData,
            ...(nextOrderContext ? { order_context: nextOrderContext } : {}),
          });
          if (row) {
            created.push(row);
            // 逐条协作创建必须推进锚点，避免每条都插在同一锚点后而倒序。
            // 失败/空结果不推进，下一条仍相对最后一个成功创建的记录插入。
            if (row.id) {
              nextOrderContext = {
                ...nextOrderContext,
                anchor_record_id: row.id,
                position: 'after',
              };
            }
          }
        }
        return created;
      }
      const created = await bulkCreateRecords(request);
      mirrorRecordsToCollab((created ?? []) as TableRecord[]);
      return created;
    },
    [bulkCreateRecords, createRecordCollab, isCollabSyncActive, mirrorRecordsToCollab],
  );

  const bulkUpdateRecordsWithCollab = React.useCallback(
    async (request: BulkUpdateRecordsRequest) => {
      if (isCollabSyncActive && updateRecordCollab) {
        const records: TableRecord[] = [];
        const errors: string[] = [];
        for (const item of request.updates) {
          try {
            const updated = await updateRecordCollab(item.record_id, {
              data: item.data,
            });
            if (updated && typeof updated === 'object' && 'id' in (updated as object)) {
              records.push(updated as TableRecord);
            }
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        return {
          records,
          errors,
          success_count: records.length,
          failed_count: Math.max(0, request.updates.length - records.length),
        };
      }
      const result = await bulkUpdateRecords(request);
      mirrorRecordsToCollab(((result as { records?: TableRecord[] })?.records ?? []) as TableRecord[]);
      return result;
    },
    [bulkUpdateRecords, isCollabSyncActive, mirrorRecordsToCollab, updateRecordCollab],
  );

  const refreshAfterPersistedPaste = React.useCallback(() => {
    if (isCollabSyncActive) {
      // 协作写入会先落 Y.Doc 和本地视图，REST 投影可能尚未追上。
      // 此时立即刷新会用旧快照覆盖粘贴值，再等远程增量把它加回来。
      return;
    }
    return refreshAfterPaste();
  }, [isCollabSyncActive, refreshAfterPaste]);

  return useDataGridClipboardBase({
    ...baseParams,
    refreshAfterPaste: refreshAfterPersistedPaste,
    bulkUpdateRecords: bulkUpdateRecordsWithCollab,
    bulkCreateRecords: bulkCreateRecordsWithCollab,
  });
}

export type { TableGridClipboardPayload };
