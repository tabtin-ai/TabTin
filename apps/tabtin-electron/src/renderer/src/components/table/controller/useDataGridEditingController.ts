import {
  useDataGridEditingController as useDataGridEditingControllerBase,
  type AdvisoryConflict,
  type DataGridAddRowContext,
  type DataGridEditingNotification,
  type DataGridEditingControllerResult,
  type DataGridRecordOrderContext,
  type UseDataGridEditingControllerInput as UseDataGridEditingControllerInputBase,
} from '@tabtin/table-ui'
import type { TableGridRuntimeApi } from '@tabtin/table-engine'
import type { Field, TableRecord } from '@tabtin/table-core'
import { createElement, type MutableRefObject } from 'react'
import { toast, ToastAction } from '@tabtin/smartsheet-ui'

export interface UseDataGridEditingControllerInput {
  orderedFields: Field[]
  fields: Field[]
  selectedTableId: string | null
  useViewData: boolean
  firstEditableField: string | null
  isReadonly?: boolean
  gridApiRef: MutableRefObject<TableGridRuntimeApi | null>
  viewStoreApi: {
    getState: () => {
      currentViewRecords: {
        records?: TableRecord[]
      } | null
      currentViewEtag?: string | null
    }
    setState?: (updater: (state: any) => any) => void
  }
  createRecord: (data: {
    table_id: string
    data: Record<string, unknown>
    order_context?: DataGridRecordOrderContext
  }) => Promise<TableRecord | null>
  updateRecord: (recordId: string, data: { data: Record<string, unknown> }) => Promise<TableRecord | null>
  refreshCurrentView: () => Promise<void>
  startPolling: (pendingFields: Set<string>) => void
  checkIfTriggersAutoField: (fieldName: string) => Field[]
  translate: (key: string, options?: Record<string, unknown>) => string
  notify?: (notification: DataGridEditingNotification) => void
  draftRowId?: string
  buildCreateRecordOrderContext?: (
    addRowContext?: DataGridAddRowContext
  ) => DataGridRecordOrderContext | undefined
  buildDraftPrefillValues?: (addRowContext?: DataGridAddRowContext) => Record<string, unknown> | undefined
  currentUserId?: string
  resolveDraftAddRowContext?: (
    draftRow: Record<string, unknown>,
    addRowContext?: DataGridAddRowContext
  ) => DataGridAddRowContext | undefined
  onRevealHiddenRecord?: (record: TableRecord) => void | Promise<void>
  onRecordCreated?: (record: TableRecord) => void | Promise<void>
  isRecordVisible?: (record: TableRecord) => boolean | Promise<boolean>
  /** 上一次保存返回的 advisory 冲突，用于弹「他人改过同一字段」的非阻断提示。 */
  getLastConflicts?: () => AdvisoryConflict[]
  rollbackCellValue?: (params: {
    recordId: string
    fieldName: string
    fieldId: string
    oldValue: unknown
  }) => void
}

export const useDataGridEditingController = (
  input: UseDataGridEditingControllerInput
): DataGridEditingControllerResult => {
  const nextInput: UseDataGridEditingControllerInputBase = {
    ...(input as unknown as UseDataGridEditingControllerInputBase),
    notify:
      input.notify ??
      ((notification: DataGridEditingNotification) => {
        toast({
          title: notification.title,
          description: notification.description,
          variant: notification.variant,
          action: notification.action
            ? createElement(
                ToastAction,
                {
                  altText: notification.action.altText ?? notification.action.label,
                  onClick: notification.action.onAction,
                },
                notification.action.label
              ) as any
            : undefined,
        })
      }),
  }

  return useDataGridEditingControllerBase(nextInput) as DataGridEditingControllerResult
}
