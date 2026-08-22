import { useRef, useCallback } from 'react';
import { toast } from '@tabtin/smartsheet-ui';
import type { TableGridRow, TableGridRowMoveContext } from '@tabtin/table-engine';
import { RecordApiService, type ViewGroup, type ViewMeta } from '@tabtin/table-core';
import {
  reorderCanvasRowsByDragSnapshot,
  resolveCanvasReorderPersistenceContext,
  resolveCanvasTreeMoveContext,
  expandMovedRowIdsWithDescendants,
  type TreeDataNodeMeta,
} from '../utils/gridRowUtils';
import type { GridDisplayRows } from '../utils/gridDisplayUtils';

export interface UseCanvasRowReorderParams {
  selectedTableId: string | null;
  rowsForGridDisplay: GridDisplayRows;
  setCanvasOptimisticRows: (rows: GridDisplayRows | null) => void;
  rowsData: TableGridRow[];
  treeDataForMove: Record<string, TreeDataNodeMeta> | null;
  subRecordParentFieldId: string | null;
  fieldById: Map<string, { name: string }>;
  resolvedCurrentView: ViewMeta | null;
  useViewData: boolean;
  currentViewId: string | undefined | null;
  refreshCurrentView: () => Promise<unknown>;
  loadRecordsByTable: (
    tableId: string,
    params: { page: number; page_size: number },
  ) => Promise<unknown>;
  page: number;
  pageSize: number;
  t: (key: string, options?: Record<string, unknown>) => string;
  reorderInFlightRef: React.MutableRefObject<boolean>;
  isTableReadonly: boolean;
  /** 协作在线（Y.Doc，非 fallback）时为 true。此时层级变更走 Y.Doc，不走 REST。 */
  collabActive?: boolean;
  /**
   * 协作在线时的层级移动 + 排序：把被拖根记录的父字段写入 Y.Doc（collab 落库同步
   * LinkRecord），并按落点更新 Y.Doc 行序（同父纯排序也走这里，否则排序不可见）。
   * 返回 true 表示已接管，调用方不再走 REST reorderTree。
   * 可同步或异步（例如等待父字段进入 fields 后再写）。
   */
  applyCollabTreeMove?: (args: {
    movedRootId: string;
    /** 是否改变父级；false 表示同父纯排序，只更新行序不写父 cell。 */
    changeParent: boolean;
    newParentId: string | null;
    movedRowIds: string[];
    anchorRowId?: string | null;
    position: 'before' | 'after' | 'end';
  }) => boolean | Promise<boolean>;
}

export interface UseCanvasRowReorderReturn {
  handleCanvasRowMoved: (
    rowIds: string[],
    context?: TableGridRowMoveContext,
  ) => void;
}

export function useCanvasRowReorder(
  params: UseCanvasRowReorderParams,
): UseCanvasRowReorderReturn {
  const {
    selectedTableId,
    rowsForGridDisplay,
    setCanvasOptimisticRows,
    rowsData,
    treeDataForMove,
    subRecordParentFieldId,
    fieldById,
    resolvedCurrentView,
    useViewData,
    currentViewId,
    refreshCurrentView,
    loadRecordsByTable,
    page,
    pageSize,
    t,
    reorderInFlightRef,
    isTableReadonly,
    collabActive,
    applyCollabTreeMove,
  } = params;

  const canvasRowReorderRequestSeqRef = useRef(0);

  const resolveCanvasReorderGroupValues = useCallback(
    (
      anchorRowData?: Record<string, unknown>,
    ): Record<string, unknown> | undefined => {
      const groups = Array.isArray(resolvedCurrentView?.groups)
        ? (resolvedCurrentView.groups as ViewGroup[])
        : [];
      if (!anchorRowData || groups.length === 0) {
        return undefined;
      }

      const values: Record<string, unknown> = {};
      groups.forEach((group) => {
        const groupFieldId =
          (group as { field_id?: unknown }).field_id ??
          (group as { field?: unknown }).field;
        if (typeof groupFieldId !== 'string' || groupFieldId.length === 0) {
          return;
        }

        const fieldMeta = fieldById.get(groupFieldId);
        if (!fieldMeta) {
          return;
        }
        const groupValue = anchorRowData[fieldMeta.name];
        values[fieldMeta.name] = groupValue === undefined ? null : groupValue;
      });

      return Object.keys(values).length > 0 ? values : undefined;
    },
    [fieldById, resolvedCurrentView?.groups],
  );

  const handleCanvasRowMoved = useCallback(
    (rowIds: string[], context?: TableGridRowMoveContext) => {
      if (isTableReadonly) {
        return;
      }
      if (!Array.isArray(rowIds) || rowIds.length === 0) {
        return;
      }

      const dropRowIndex = context?.dropRowIndex;
      if (typeof dropRowIndex !== 'number' || !Number.isFinite(dropRowIndex)) {
        console.warn(
          '[DataGridAdapter] Canvas 行重排缺少 dropRowIndex，已跳过本地重排。收到 rowIds:',
          rowIds,
        );
        return;
      }

      if (!selectedTableId) {
        return;
      }
      // 窄化后绑定常量：嵌套 persistViaRest 不会丢失 string / non-null 类型
      const tableId: string = selectedTableId;

      const persistenceContext = resolveCanvasReorderPersistenceContext(
        rowsForGridDisplay,
        rowIds,
        dropRowIndex,
      );
      if (!persistenceContext || persistenceContext.movedRowIds.length === 0) {
        console.warn(
          '[DataGridAdapter] Canvas 行重排无法解析持久化上下文，已跳过。',
          {
            rowIds,
            dropRowIndex,
          },
        );
        return;
      }
      const resolvedPersistence = persistenceContext;

      const reorderedRows = reorderCanvasRowsByDragSnapshot(
        rowsForGridDisplay,
        rowIds,
        dropRowIndex,
      );
      const didReorderRows = reorderedRows !== rowsForGridDisplay;
      const canResolveInsideTreeDrop = Boolean(
        subRecordParentFieldId &&
        context?.dropMode === 'inside' &&
        context.targetRowId,
      );
      if (!didReorderRows && !canResolveInsideTreeDrop) {
        return;
      }

      const movedRowIdsForPersist =
        treeDataForMove && rowsData.length > 0
          ? expandMovedRowIdsWithDescendants(
              persistenceContext.movedRowIds,
              rowsData,
              treeDataForMove,
            )
          : persistenceContext.movedRowIds;

      const previousRowsSnapshot = rowsForGridDisplay;
      if (didReorderRows) {
        setCanvasOptimisticRows(reorderedRows);
      }

      const treeMoveContext = subRecordParentFieldId
        ? resolveCanvasTreeMoveContext(
            rowsForGridDisplay,
            reorderedRows,
            movedRowIdsForPersist,
            {
              dropMode: context?.dropMode,
              targetRowId: context?.targetRowId,
            },
          )
        : null;

      if (!didReorderRows && !treeMoveContext) {
        return;
      }

      const requestSeq = canvasRowReorderRequestSeqRef.current + 1;
      canvasRowReorderRequestSeqRef.current = requestSeq;
      reorderInFlightRef.current = true;
      const groupValues = resolveCanvasReorderGroupValues(
        persistenceContext.anchorRowData,
      );
      const isDropInside =
        context?.dropMode === 'inside' && Boolean(context.targetRowId);

      // ── Tree mode: 使用原子 reorder-tree API（排序 + 层级单事务） ──
      if (treeMoveContext?.depthExceeded) {
        setCanvasOptimisticRows(null);
        reorderInFlightRef.current = false;
        toast({
          title: String(t('table:record.reorderFailedTitle' as any)),
          description: String(
            t('table:subRecord.depthExceeded' as any),
          ),
          variant: 'destructive',
        });
        return;
      }
      // ── 协作在线：行序统一走 Y.Doc（cell + reorderRows），覆盖普通表与子记录树表 ──
      // 协作态显示由 Y.Doc rowOrder 驱动；若走 REST 只改 DB 不写 Y.Doc，会被旧 Y.Doc
      // 覆盖而回弹。普通表（无 subRecordParentFieldId）同样必须经此路径，否则拖拽回弹。
      // 子记录树表额外在父级变化时写父字段 cell（changeParent=true）。
      if (collabActive && applyCollabTreeMove) {
        const movedRootId = treeMoveContext?.recordId ?? persistenceContext.movedRowIds[0];
        if (movedRootId) {
          void Promise.resolve(
            applyCollabTreeMove({
              movedRootId,
              changeParent: Boolean(treeMoveContext),
              newParentId: treeMoveContext?.newParentId ?? null,
              movedRowIds: movedRowIdsForPersist,
              anchorRowId: isDropInside ? null : persistenceContext.anchorRowId,
              position: (isDropInside ? 'end' : persistenceContext.position) as
                | 'before'
                | 'after'
                | 'end',
            }),
          )
            .then((handled) => {
              if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
                return;
              }
              if (handled) {
                setCanvasOptimisticRows(null);
                reorderInFlightRef.current = false;
                return;
              }
              // 协作态改父失败时不要退回 REST：DB 改了但 Y.Doc 未写会回弹，
              // 表现为「前几次拖入建子失败」。回滚乐观 UI 并提示稍后重试。
              // inside 落点行序可能未变（未写过乐观行），此时应清回 null，勿锁成快照。
              if (treeMoveContext && subRecordParentFieldId) {
                setCanvasOptimisticRows(
                  didReorderRows ? previousRowsSnapshot : null,
                );
                reorderInFlightRef.current = false;
                toast({
                  title: String(t('table:record.reorderFailedTitle' as any)),
                  description: String(
                    t('table:subRecord.parentFieldNotReady' as any, {
                      defaultValue: '层级字段同步中，请稍后再拖入建立子记录',
                    }),
                  ),
                  variant: 'destructive',
                });
                return;
              }
              // 同父纯排序未接管：继续走下方 REST（非树表 / 无父字段时）
              persistViaRest();
            })
            .catch(() => {
              if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
                return;
              }
              setCanvasOptimisticRows(
                didReorderRows ? previousRowsSnapshot : null,
              );
              reorderInFlightRef.current = false;
              toast({
                title: String(t('table:record.reorderFailedTitle' as any)),
                description: String(
                  t('table:subRecord.parentFieldNotReady' as any, {
                    defaultValue: '层级字段同步中，请稍后再拖入建立子记录',
                  }),
                ),
                variant: 'destructive',
              });
            });
          return;
        }
      }

      persistViaRest();

      function persistViaRest() {
        // ── REST tree mode（非协作 / fallback）──
        if (treeMoveContext && subRecordParentFieldId) {
          const treePayload = {
            table_id: tableId,
            moved_root_record_id: treeMoveContext.recordId,
            new_parent_id: treeMoveContext.newParentId,
            position: (isDropInside ? 'end' : resolvedPersistence.position) as
              | 'before'
              | 'after'
              | 'end',
            ...(!isDropInside && resolvedPersistence.anchorRowId
              ? { anchor_record_id: resolvedPersistence.anchorRowId }
              : {}),
            parent_field_id: subRecordParentFieldId,
            move_with_descendants: true,
          };

          void RecordApiService.reorderTree(treePayload)
            .then(async () => {
              if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
                return;
              }
              if (useViewData && currentViewId) {
                await refreshCurrentView();
              } else {
                await loadRecordsByTable(tableId, {
                  page,
                  page_size: pageSize,
                });
              }
              if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
                return;
              }
              setCanvasOptimisticRows(null);
              reorderInFlightRef.current = false;
            })
            .catch((error: unknown) => {
              if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
                return;
              }
              setCanvasOptimisticRows(previousRowsSnapshot);
              reorderInFlightRef.current = false;
              if (useViewData && currentViewId) {
                void refreshCurrentView().catch(() => undefined);
              } else {
                void loadRecordsByTable(tableId, {
                  page,
                  page_size: pageSize,
                }).catch(() => undefined);
              }
              toast({
                title: String(t('table:record.reorderFailedTitle' as any)),
                description:
                  error instanceof Error
                    ? error.message
                    : String(t('table:record.reorderFailedDesc' as any)),
                variant: 'destructive',
              });
              console.error('[DataGridAdapter] 树拖拽原子提交失败', {
                rowIds,
                dropRowIndex,
                treePayload,
                error,
              });
            });
          return;
        }

        // ── Non-tree mode: 使用旧的 reorderRecords API ──
        const requestPayload = {
          table_id: tableId,
          record_ids: movedRowIdsForPersist,
          position: resolvedPersistence.position,
          ...(resolvedPersistence.anchorRowId
            ? { anchor_record_id: resolvedPersistence.anchorRowId }
            : {}),
          ...(useViewData && currentViewId ? { view_id: currentViewId } : {}),
          ...(groupValues ? { group_values: groupValues } : {}),
        };

        void RecordApiService.reorderRecords(requestPayload)
          .then(async (result) => {
            if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
              return;
            }
            const reorderErrors =
              Array.isArray(result.errors) && result.errors.length > 0
                ? result.errors
                : null;
            if (useViewData && currentViewId) {
              await refreshCurrentView();
            } else {
              await loadRecordsByTable(tableId, {
                page,
                page_size: pageSize,
              });
            }
            if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
              return;
            }
            setCanvasOptimisticRows(null);
            reorderInFlightRef.current = false;
            if (reorderErrors) {
              toast({
                title: String(t('table:record.reorderFailedTitle' as any)),
                description: reorderErrors.join('；'),
                variant: 'destructive',
              });
            }
          })
          .catch((error: unknown) => {
            if (canvasRowReorderRequestSeqRef.current !== requestSeq) {
              return;
            }
            setCanvasOptimisticRows(previousRowsSnapshot);
            reorderInFlightRef.current = false;
            if (useViewData && currentViewId) {
              void refreshCurrentView().catch(() => undefined);
            } else {
              void loadRecordsByTable(tableId, {
                page,
                page_size: pageSize,
              }).catch(() => undefined);
            }
            toast({
              title: String(t('table:record.reorderFailedTitle' as any)),
              description:
                error instanceof Error
                  ? error.message
                  : String(t('table:record.reorderFailedDesc' as any)),
              variant: 'destructive',
            });
            console.error('[DataGridAdapter] Canvas 行重排持久化失败', {
              rowIds,
              dropRowIndex,
              requestPayload,
              error,
            });
          });
      }
    },
    [
      currentViewId,
      loadRecordsByTable,
      page,
      pageSize,
      refreshCurrentView,
      resolveCanvasReorderGroupValues,
      rowsData,
      rowsForGridDisplay,
      selectedTableId,
      subRecordParentFieldId,
      t,
      treeDataForMove,
      useViewData,
      isTableReadonly,
      collabActive,
      applyCollabTreeMove,
    ],
  );

  return { handleCanvasRowMoved };
}
