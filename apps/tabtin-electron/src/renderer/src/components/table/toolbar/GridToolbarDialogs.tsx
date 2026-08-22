import React from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog, useOverlayContainer, cn, OVERLAY_SURFACE_CLASS } from '@tabtin/smartsheet-ui';
import { resolveRecordId, type TableGridRow } from '@tabtin/table-engine';
import { FieldManagementDialog } from '@/components/field';
import { FieldSettingPanel } from '@/components/field/FieldSettingPanel';
import { RecordFormContainer } from '@/components/record';
import { ExportContainer } from '@/components/export';
import { ImportContainer } from '@/components/import';
import type { Table } from '@tabtin/table-core';
import { formatNumber } from '@/utils/i18n/format';
import type { GridToolbarUiState } from '@tabtin/table-ui';
import { useTableOverlayDrawerContainer } from '@/components/table/utils/TableOverlayDrawerHost';

interface GridToolbarDialogsProps {
  selectedTable: Table;
  currentViewId?: string | null;
  selectedRows: TableGridRow[];
  selectedRowsCount: number;
  renderedViewRecordCount: number;
  uiState: GridToolbarUiState;
  commonEmojis: string[];
  translate: (key: string, options?: Record<string, unknown>) => string;
  onConfirmDelete: () => void | Promise<void>;
  onEmojiSelect: (emoji: string) => void | Promise<void>;
  isReadonly?: boolean;
}

export const GridToolbarDialogs: React.FC<GridToolbarDialogsProps> = ({
  selectedTable,
  currentViewId,
  selectedRows,
  selectedRowsCount,
  renderedViewRecordCount,
  uiState,
  commonEmojis,
  translate,
  onConfirmDelete,
  onEmojiSelect,
  isReadonly = false,
}) => {
  // Wave 6.3：emoji picker portal 走 OverlayContainer——GridViewHost 内嵌一层
  // OverlayContainerProvider（让 picker 限制在 grid 视图内），SpaceWorkbenchHost
  // 兜底外层 Provider。两层都缺时才 fallback 到 document.body（仅可能在 Provider
  // 之外的场景，hot-Space 切换路径不再走 fallback，无需 isForeground 守门）。
  const overlayContainer = useOverlayContainer();
  const fieldManagementDrawer = useTableOverlayDrawerContainer(
    uiState.showFieldManagement,
  );

  return (
    <>
      {!isReadonly && (
        <ImportContainer
          open={uiState.showImportDialog}
          onOpenChange={uiState.setShowImportDialog}
          tableId={selectedTable.id}
        />
      )}

      <ExportContainer
        open={uiState.showExportDialog}
        onOpenChange={uiState.setShowExportDialog}
        tableId={selectedTable.id}
        selectedRecordIds={selectedRows
          .map((row) => resolveRecordId(row))
          .filter((id): id is string => typeof id === 'string' && id.length > 0)}
        viewId={currentViewId ?? undefined}
        renderedViewRecordCount={renderedViewRecordCount}
      />

      {!isReadonly && fieldManagementDrawer.host}
      {!isReadonly && fieldManagementDrawer.ready && (
        <FieldManagementDialog
          open={uiState.showFieldManagement}
          onOpenChange={uiState.setShowFieldManagement}
          container={fieldManagementDrawer.container ?? undefined}
        />
      )}

      {!isReadonly && <FieldSettingPanel />}

      <RecordFormContainer
        open={uiState.showCreateRecordDialog}
        onOpenChange={uiState.setShowCreateRecordDialog}
        mode="create"
        isReadonly={isReadonly}
      />

      {!isReadonly && (
        <ConfirmDialog
          open={uiState.showDeleteConfirm}
          onOpenChange={uiState.setShowDeleteConfirm}
          title={translate('table:toolbar.confirmDeleteTitle')}
          description={String(
            translate(
              selectedRows.some(
                (row) =>
                  (row as Record<string, unknown>).__treeHasChildren === true,
              )
                ? 'table:toolbar.confirmDeleteWithChildrenDescription'
                : 'table:toolbar.confirmDeleteDescription',
              { count: formatNumber(selectedRowsCount) },
            ),
          )}
          confirmText={translate('table:toolbar.delete')}
          cancelText={translate('common:cancel')}
          variant="destructive"
          onConfirm={onConfirmDelete}
          restoreFocusOnClose
        />
      )}

      {!isReadonly &&
        uiState.showEmojiPicker &&
        uiState.emojiPickerPosition &&
        createPortal(
          // Wave 6.3 修正：emojiPickerPosition 是 viewport 坐标
          // (`getBoundingClientRect()`)，必须用 `position: fixed` 保留
          // viewport 锚定。不要因为 portal 进了 OverlayContainer（absolute
          // div）就切成 absolute——会让 left/top 被解析为相对容器原点，
          // picker 飞到 sidebar 宽 + chat header 高之外的错位。容器 hidden
          // 仍能让 fixed 子元素跟随消失（display:none 沿 DOM 树传播）。
          <div
            className={cn('emoji-picker-menu fixed z-global rounded-interactive p-3', OVERLAY_SURFACE_CLASS)}
            style={{
              left: `${uiState.emojiPickerPosition.x}px`,
              top: `${uiState.emojiPickerPosition.y}px`,
            }}
          >
            <div className="space-y-2">
              <div className="px-1 text-body font-medium text-muted-foreground">
                {translate('table:toolbar.emojiPickerTitle')}
              </div>
              <div className="grid grid-cols-8 gap-1">
                {commonEmojis.map((emoji, index) => (
                  <button
                    key={`emoji-${index}-${emoji}`}
                    onClick={() => onEmojiSelect(emoji)}
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-title transition-colors hover:bg-accent"
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          overlayContainer ?? document.body,
        )}
    </>
  );
};
