/**
 * useUndoRedo — 组合入口 hook
 *
 * 组合 useUndoRedoCore + useRecordHistory + useTableHistory，
 * 并绑定键盘快捷键。对外 API 与重构前完全一致。
 */

import { useEffect, useRef } from 'react'
import { useUndoRedoCore, COLLAB_OFFLINE } from './useUndoRedoCore'
import { useRecordHistory } from './useRecordHistory'
import { useTableHistory } from './useTableHistory'
import { shouldHandleTableUndoShortcut } from './tableUndoKeyboard'

import type { HistoryOperationOut } from '@tabtin/table-core'

export type {
  CollabUndoRedoState,
  UseUndoRedoCoreResult,
  FieldRestoreNotSupportedDetail,
} from './useUndoRedoCore'
export type { UseRecordHistoryResult } from './useRecordHistory'
export type { UseTableHistoryResult } from './useTableHistory'
export { COLLAB_OFFLINE } from './useUndoRedoCore'
export { useUndoRedoCore } from './useUndoRedoCore'
export { useRecordHistory } from './useRecordHistory'
export { useTableHistory } from './useTableHistory'

import type { UseUndoRedoCoreResult } from './useUndoRedoCore'
import type { UseRecordHistoryResult } from './useRecordHistory'
import type { UseTableHistoryResult } from './useTableHistory'

type AssertNoOverlap<A, B> = keyof A & keyof B extends never ? true : ['CONFLICT', keyof A & keyof B]
type _CheckCoreRecord = AssertNoOverlap<UseUndoRedoCoreResult, UseRecordHistoryResult> & true
type _CheckCoreTable = AssertNoOverlap<UseUndoRedoCoreResult, UseTableHistoryResult> & true
type _CheckRecordTable = AssertNoOverlap<UseRecordHistoryResult, UseTableHistoryResult> & true
void (0 as unknown as _CheckCoreRecord & _CheckCoreTable & _CheckRecordTable)

export interface UseUndoRedoInput {
  selectedTableId: string | null
  selectedTableName?: string | null
  refreshRecords: () => Promise<void>
  refreshViews?: () => Promise<void>
  translate: (key: string, opts?: Record<string, unknown>) => string
  enableUndoRedo?: boolean
  enableKeyboardShortcuts?: boolean
  containerRef?: React.RefObject<HTMLElement | null>
  collabUndoRedo?: import('./useUndoRedoCore').CollabUndoRedoState
  /** When false, skip eager API calls (for portal-parked/inactive tabs). */
  isActive?: boolean
  /** 表数据版本信号（如 record store 的 records 引用）；离线/降级态据此去重刷新撤回栈。 */
  dataVersion?: number | string | object | null
  /**
   * W1.4 / C1:tableUndo 收到 409 + FIELD_RESTORE_NOT_SUPPORTED 时回调,
   * 上层用此弹出 FieldBatchUndoConflictDialog 显示分类。
   */
  onFieldRestoreNotSupported?: (
    detail: import('./useUndoRedoCore').FieldRestoreNotSupportedDetail,
  ) => void
  skipRecordsRefreshOnStackOperation?: boolean
}

export interface UseUndoRedoResult {
  handleUndo: () => Promise<void>
  handleRedo: () => Promise<void>
  canUndo: boolean
  canRedo: boolean
  isUndoing: boolean
  isRedoing: boolean
  undoStackTotal: number
  redoStackTotal: number
  refreshStacks: () => Promise<void>
  recordBackendUndoable: () => void
  recordTimelineEvent: (source: 'collab' | 'backend') => void
  showRecordHistory: boolean
  recordHistoryRecordId: string | null
  recordHistoryRecordLabel: string
  recordHistoryOps: HistoryOperationOut[]
  recordHistoryTotal: number
  isLoadingRecordHistory: boolean
  handleOpenRecordHistory: (recordId: string, label: string) => void
  handleCloseRecordHistory: () => void
  handleLoadMoreRecordHistory: () => void
  showTableHistory: boolean
  tableHistoryLabel: string
  tableHistoryOps: HistoryOperationOut[]
  tableHistoryTotal: number
  isLoadingTableHistory: boolean
  handleOpenTableHistory: () => void
  handleCloseTableHistory: () => void
  handleLoadMoreTableHistory: () => void
  snapshotData: Record<string, unknown> | null
  snapshotLoading: boolean
  restoreLoading: boolean
  handleRequestSnapshot: (
    recordId: string,
    historyId: string,
    _fieldKeys?: string[]
  ) => Promise<void>
  handleRequestRestore: (recordId: string, historyId: string) => Promise<void>
  clearSnapshotPreview: () => void
}

export function useUndoRedo({
  selectedTableId,
  selectedTableName,
  refreshRecords,
  refreshViews,
  translate,
  enableUndoRedo = true,
  enableKeyboardShortcuts = true,
  containerRef,
  collabUndoRedo = COLLAB_OFFLINE,
  isActive = true,
  dataVersion = null,
  onFieldRestoreNotSupported,
  skipRecordsRefreshOnStackOperation,
}: UseUndoRedoInput): UseUndoRedoResult {
  const core = useUndoRedoCore({
    selectedTableId,
    refreshRecords,
    refreshViews,
    translate,
    enableUndoRedo,
    isActive,
    collabUndoRedo,
    dataVersion,
    onFieldRestoreNotSupported,
    skipRecordsRefreshOnStackOperation,
  })

  const recordHistory = useRecordHistory({
    refreshRecords,
    refreshStacks: core.refreshStacks,
    translate,
  })

  const tableHistory = useTableHistory({
    selectedTableId,
    selectedTableName,
    translate,
  })

  // ── Keyboard shortcuts ──

  const handleUndoRef = useRef(core.handleUndo)
  handleUndoRef.current = core.handleUndo
  const handleRedoRef = useRef(core.handleRedo)
  handleRedoRef.current = core.handleRedo

  const containerRefStable = useRef(containerRef)
  containerRefStable.current = containerRef
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  useEffect(() => {
    if (!enableUndoRedo || !enableKeyboardShortcuts) return

    const handler = (e: KeyboardEvent) => {
      if (
        !shouldHandleTableUndoShortcut({
          activeElement: document.activeElement,
          eventTarget: e.target,
          container: containerRefStable.current?.current ?? null,
          isActive: isActiveRef.current,
        })
      ) {
        return
      }

      const modKey = e.metaKey || e.ctrlKey

      if (modKey && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        void handleUndoRef.current()
      } else if (
        (modKey && e.shiftKey && e.key === 'z') ||
        (modKey && e.key === 'y')
      ) {
        e.preventDefault()
        void handleRedoRef.current()
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [enableUndoRedo, enableKeyboardShortcuts])

  return {
    ...core,
    ...recordHistory,
    ...tableHistory,
  }
}
