/**
 * TablePaneDialogs — 表格相关确认弹窗与历史弹窗
 *
 * 从 TablePaneView 提取的独立组件，包含：
 * - 粘贴确认弹窗
 * - 删除记录确认弹窗
 * - 删除字段确认弹窗
 * - 表格历史弹窗
 */

import React from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tabtin/smartsheet-ui'
import type { Field, HistoryOperationOut } from '@tabtin/table-core'

export interface PasteConfirmState {
  open: boolean
  rowCount: number
  cellCount: number
  newRowCount: number
  skippedRows?: number
}

export interface TablePaneDialogsProps {
  // Paste
  pasteConfirmState: PasteConfirmState | null
  onCancelPaste: () => void
  onConfirmPaste: () => void

  // Delete records
  pendingDeleteRecordIds: string[] | null
  onDismissDeleteRecords: () => void
  onConfirmDeleteRecords: () => void

  // Delete field
  pendingDeleteField: Field | null
  onDismissDeleteField: () => void
  onConfirmDeleteField: () => void

  // Table history
  showTableHistory: boolean
  tableHistoryLabel: string | null
  tableHistoryOps: HistoryOperationOut[]
  tableHistoryTotal: number
  isLoadingTableHistory: boolean
  onCloseTableHistory: () => void
  onLoadMoreTableHistory: () => void

  translate: (key: string, options?: Record<string, unknown>) => string
}

export const TablePaneDialogs: React.FC<TablePaneDialogsProps> = ({
  pasteConfirmState,
  onCancelPaste,
  onConfirmPaste,
  pendingDeleteRecordIds,
  onDismissDeleteRecords,
  onConfirmDeleteRecords,
  pendingDeleteField,
  onDismissDeleteField,
  onConfirmDeleteField,
  showTableHistory,
  tableHistoryLabel,
  tableHistoryOps,
  tableHistoryTotal,
  isLoadingTableHistory,
  onCloseTableHistory,
  onLoadMoreTableHistory,
  translate: t,
}) => {
  return (
    <>
      {/* Paste confirmation */}
      <Dialog open={pasteConfirmState?.open ?? false} onOpenChange={(open) => { if (!open) onCancelPaste() }}>
        <DialogContent className="max-w-sm" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirmPaste() } }}>
          <DialogHeader>
            <DialogTitle>{t('clipboard.confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('clipboard.confirmDesc', {
                rowCount: pasteConfirmState?.rowCount ?? 0,
                cellCount: pasteConfirmState?.cellCount ?? 0,
                newRowCount: pasteConfirmState?.newRowCount ?? 0,
              })}
              {(pasteConfirmState?.skippedRows ?? 0) > 0 && (
                <span className="block mt-1 text-body text-muted-foreground">
                  {t('clipboard.skippedNote', {
                    count: pasteConfirmState?.skippedRows ?? 0,
                  })}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onCancelPaste}>
              {t('common:cancel')}
            </Button>
            <Button onClick={() => { onConfirmPaste() }}>
              {t('clipboard.confirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete records confirmation */}
      <Dialog open={pendingDeleteRecordIds !== null} onOpenChange={(open) => { if (!open) onDismissDeleteRecords() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('toolbar.confirmDeleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('toolbar.confirmDeleteDescription', { count: pendingDeleteRecordIds?.length ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onDismissDeleteRecords}>
              {t('common:cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button variant="destructive" onClick={() => void onConfirmDeleteRecords()}>
              {t('common:delete', { defaultValue: 'Delete' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete field confirmation */}
      <Dialog open={pendingDeleteField !== null} onOpenChange={(open) => { if (!open) onDismissDeleteField() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('toolbar.confirmDeleteFieldTitle')}</DialogTitle>
            <DialogDescription>
              {t('toolbar.confirmDeleteFieldDescription', { name: pendingDeleteField?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onDismissDeleteField}>
              {t('common:cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button variant="destructive" onClick={() => void onConfirmDeleteField()}>
              {t('common:delete', { defaultValue: 'Delete' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Table History Dialog */}
      <Dialog open={showTableHistory} onOpenChange={(open) => { if (!open) onCloseTableHistory() }}>
        <DialogContent className="max-w-lg max-h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{tableHistoryLabel || t('toolbar.tableHistory', { defaultValue: 'Table history' })}</DialogTitle>
            <DialogDescription>
              {t('toolbar.tableHistoryDesc', { defaultValue: 'View operation history for this table' })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto min-h-0 space-y-2 py-2">
            {tableHistoryOps.length === 0 && !isLoadingTableHistory && (
              <div className="py-8 text-center text-body text-muted-foreground">
                {t('toolbar.noHistory', { defaultValue: 'No history records' })}
              </div>
            )}
            {tableHistoryOps.map((op, idx) => (
              <div key={op.id ?? idx} className="rounded-md border border-border/50 px-3 py-2 text-body">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{op.action_display ?? op.action}</span>
                  <span className="text-body text-muted-foreground">
                    {op.created_at ? new Date(op.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}
                  </span>
                </div>
                {op.user != null && (
                  <div className="mt-1 text-body text-muted-foreground">{op.user.name}</div>
                )}
              </div>
            ))}
            {isLoadingTableHistory && (
              <div className="py-4 text-center text-body text-muted-foreground">
                {t('common.loading', { defaultValue: 'Loading...' })}
              </div>
            )}
          </div>
          {tableHistoryOps.length < tableHistoryTotal && !isLoadingTableHistory && (
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onLoadMoreTableHistory}>
                {t('toolbar.loadMore', { defaultValue: 'Load more' })}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
