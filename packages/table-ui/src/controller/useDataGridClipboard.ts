/**
 * useDataGridClipboard - 复制粘贴 hook（共享组件，Electron / Web 通用）
 *
 * 职责：
 * 1. TSV 文本解析（从剪贴板粘贴的表格数据）
 * 2. 类型转换（将纯文本值转换为字段对应类型）
 * 3. 批量粘贴（多行多列同时写入）
 * 4. 复制提示
 */

import React from 'react'
import { toast, ToastAction, type ToastActionElement } from '@tabtin/smartsheet-ui'
import type {
  TableGridRow,
  TableGridClipboardPayload,
  TableGridRuntimeApi,
} from '@tabtin/table-engine'
import { resolveRecordId } from '@tabtin/table-engine'
import type { TableRecord } from '@tabtin/table-core'
import {
  resolveCreatedRecordVisibility,
  collectDisplayedRecordIds,
} from '../utils/createdRecordVisibility'
import { validateBeforeSave } from './cellValueUtils'
import { resolveClipboardPasteRows } from './clipboardPasteRows'
export { parseTsvText, resolveClipboardPasteRows } from './clipboardPasteRows'
export { resolveCreatedRecordVisibility, collectDisplayedRecordIds }
export type { CreatedRecordVisibilityResult } from '../utils/createdRecordVisibility'

type ClipboardGridApi = Pick<
  TableGridRuntimeApi<TableGridRow>,
  'getDisplayedRowAtIndex' | 'getDisplayedRowCount'
>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViewAwareCreatePlan {
  orderContext?: {
    view_id?: string
    anchor_record_id?: string
    position?: 'before' | 'after' | 'end'
    group_values?: Record<string, unknown>
  }
  prefillValues?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKBOX_TRUE_VALUES = new Set([
  'true', '1', 'yes', 'y', 'on',
  '是', '对', '✓', '✔', '☑', 'checked',
])
const CHECKBOX_FALSE_VALUES = new Set([
  'false', '0', 'no', 'n', 'off',
  '否', '不', '✗', '✘', '☐', 'unchecked',
])
const READONLY_FIELD_TYPES_FOR_PASTE = new Set([
  'created_time',
  'last_modified_time',
  'created_by',
  'last_modified_by',
  'link',
  'attachment',
])

const PASTE_CONFIRM_THRESHOLD = 50
const MAX_AUTO_CREATE_ROWS = 500
const MAX_TOAST_ERROR_REASONS = 3

const resolvePasteAnchorRowIndex = (
  anchor: TableGridClipboardPayload['cells'][number],
  api: ClipboardGridApi,
): number => {
  if (!anchor.rowId) return anchor.rowIndex

  const matchesAnchorRecord = (displayRowIndex: number): boolean => {
    const row = api.getDisplayedRowAtIndex?.(displayRowIndex)?.data
    return Boolean(row && resolveRecordId(row) === anchor.rowId)
  }

  if (matchesAnchorRecord(anchor.rowIndex)) {
    return anchor.rowIndex
  }

  const displayedRowCount = api.getDisplayedRowCount?.() ?? 0
  for (let displayRowIndex = 0; displayRowIndex < displayedRowCount; displayRowIndex++) {
    if (matchesAnchorRecord(displayRowIndex)) {
      return displayRowIndex
    }
  }

  return anchor.rowIndex
}

const buildToastActionElement = (
  label: string,
  onClick: () => void,
): ToastActionElement =>
  React.createElement(
    ToastAction,
    {
      altText: label,
      onClick,
    },
    label,
  )

function deduplicateErrors(errors: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of errors) {
    const reason = raw.replace(/^\[分批 \d+\/\d+\]\s*第\d+条:\s*/, '')
    if (!reason || seen.has(reason)) continue
    seen.add(reason)
    result.push(reason)
    if (result.length >= MAX_TOAST_ERROR_REASONS) break
  }
  return result
}

const createFallbackOperationGroupId = (): string => {
  const segment = (length: number) =>
    Array.from({ length }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('')
  return [
    segment(8),
    segment(4),
    `4${segment(3)}`,
    `${(8 + Math.floor(Math.random() * 4)).toString(16)}${segment(3)}`,
    segment(12),
  ].join('-')
}

// ---------------------------------------------------------------------------
// Type conversion helpers (pure functions, exported for testing)
// ---------------------------------------------------------------------------

export function convertPasteValue(raw: string, fieldType: string): unknown {
  if (raw === '') return null
  switch (fieldType) {
    case 'text':
    case 'long_text':
      return raw.replace(/\0/g, '')
    case 'url':
    case 'email':
    case 'phone': {
      // 手动粘贴常带前后空白；入库前 trim，避免 URL 点击拼出非法 href
      const trimmed = raw.trim()
      return trimmed === '' ? null : trimmed
    }
    case 'single_select': // fall-through: legacy alias → select
    case 'select':
      return raw
    case 'multi_select': {
      const items: string[] = []
      let buf = ''
      let inQuotes = false
      for (let j = 0; j < raw.length; j++) {
        const ch = raw[j]
        if (inQuotes) {
          if (ch === '"' && raw[j + 1] === '"') {
            buf += '"'
            j++
          } else if (ch === '"') {
            inQuotes = false
          } else {
            buf += ch
          }
        } else if (ch === '"' && buf.trim() === '') {
          inQuotes = true
          buf = ''
        } else if (ch === ',') {
          const trimmed = buf.trim()
          if (trimmed) items.push(trimmed)
          buf = ''
        } else {
          buf += ch
        }
      }
      const last = buf.trim()
      if (last) items.push(last)
      return items
    }
    case 'number':
    case 'currency':
    case 'percent': {
      let cleaned = raw.trim()
      cleaned = cleaned.replace(
        /^[¥$€£₩₹₽₫₺\s]+|[¥$€£₩₹₽₫₺\s]+$/g,
        '',
      )
      const isAccountingNeg = /^\([\d,.\s]+\)$/.test(cleaned)
      if (isAccountingNeg) {
        cleaned = '-' + cleaned.replace(/[()]/g, '')
      }
      if (cleaned.endsWith('%')) cleaned = cleaned.slice(0, -1)
      cleaned = cleaned.replace(/,/g, '')
      const num = Number(cleaned)
      if (!Number.isFinite(num)) return undefined
      // Percent columns always treat pasted numbers as percent points (12 → 0.12).
      return fieldType === 'percent' ? num / 100 : num
    }
    case 'rating': {
      const n = Math.round(Number(raw))
      return Number.isFinite(n) && n >= 0 ? n : undefined
    }
    case 'checkbox': {
      const lower = raw.toLowerCase().trim()
      if (CHECKBOX_TRUE_VALUES.has(lower)) return true
      if (CHECKBOX_FALSE_VALUES.has(lower)) return false
      return undefined
    }
    case 'date': {
      const ts = Date.parse(raw)
      if (!Number.isNaN(ts)) return new Date(ts).toISOString()

      const cleaned = raw.trim()

      const cnMatch = cleaned.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/)
      if (cnMatch) {
        const d = new Date(
          Number(cnMatch[1]),
          Number(cnMatch[2]) - 1,
          Number(cnMatch[3]),
        )
        if (!Number.isNaN(d.getTime())) return d.toISOString()
      }

      const compactMatch = cleaned.match(/^(\d{4})(\d{2})(\d{2})$/)
      if (compactMatch) {
        const d = new Date(
          Number(compactMatch[1]),
          Number(compactMatch[2]) - 1,
          Number(compactMatch[3]),
        )
        if (!Number.isNaN(d.getTime())) return d.toISOString()
      }

      const dotMatch = cleaned.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/)
      if (dotMatch) {
        const d = new Date(
          Number(dotMatch[1]),
          Number(dotMatch[2]) - 1,
          Number(dotMatch[3]),
        )
        if (!Number.isNaN(d.getTime())) return d.toISOString()
      }

      return undefined
    }
    default:
      return raw
  }
}

// ---------------------------------------------------------------------------
// Paste plan
// ---------------------------------------------------------------------------

interface ColumnDef {
  field: string
  fieldId?: string
  editable?: boolean
  originalFieldType?: string
  type?: string
  validation_rules?: Record<string, unknown>
  options?: Record<string, unknown>
}

interface PlannedPasteUpdate {
  record_id: string
  data: Record<string, unknown>
  cellCount: number
  triggerKeys: string[]
}

interface PlannedPasteCreate {
  data: Record<string, unknown>
}

interface PlanPasteOperationsInput {
  parsedRows: string[][]
  anchorRowIndex: number
  anchorColIndex: number
  columns: ColumnDef[]
  tableId: string | null
  getDisplayRowData: (
    displayRowIndex: number,
  ) => (TableGridRow & Record<string, unknown>) | undefined
  buildCreatePlanFromDisplayRowIndex?: (
    displayRowIndex: number,
  ) => ViewAwareCreatePlan
  maxAutoCreateRows?: number
}

export type PasteZeroWriteReason =
  | 'validation'
  | 'readonly'
  | 'convert'
  | 'noop'
  | 'no_target'
  | 'mixed'

interface PlannedPasteOperations {
  updates: PlannedPasteUpdate[]
  creates: PlannedPasteCreate[]
  updatedCellCount: number
  createdRowCount: number
  skippedRows: number
  truncatedRows: number
  /** 因 validation_rules / 必填未通过而跳过的单元格数 */
  skippedValidationCount: number
  skippedReadonlyCount: number
  skippedConvertCount: number
  skippedNoopCount: number
  /** 整次 0 写入时的主导原因；有写入时为 null */
  zeroWriteReason: PasteZeroWriteReason | null
  createPlan: ViewAwareCreatePlan | null
}

/** 仅在 updates/creates 皆空时解析主导原因（供测试与 toast 分流） */
export function resolvePasteZeroWriteReason(input: {
  skippedValidationCount: number
  skippedReadonlyCount: number
  skippedConvertCount: number
  skippedNoopCount: number
  blockedNoTarget: boolean
}): PasteZeroWriteReason {
  if (input.skippedValidationCount > 0) return 'validation'

  const reasons: PasteZeroWriteReason[] = []
  if (input.skippedReadonlyCount > 0) reasons.push('readonly')
  if (input.skippedConvertCount > 0) reasons.push('convert')
  if (input.skippedNoopCount > 0) reasons.push('noop')
  if (input.blockedNoTarget) reasons.push('no_target')

  if (reasons.length === 0) return 'no_target'
  if (reasons.length > 1) return 'mixed'
  return reasons[0]
}

export function planPasteOperations({
  parsedRows,
  anchorRowIndex,
  anchorColIndex,
  columns,
  tableId,
  getDisplayRowData,
  buildCreatePlanFromDisplayRowIndex,
  maxAutoCreateRows = MAX_AUTO_CREATE_ROWS,
}: PlanPasteOperationsInput): PlannedPasteOperations {
  const updateMap = new Map<string, PlannedPasteUpdate>()
  let updatedCellCount = 0
  let skippedValidationCount = 0
  let skippedReadonlyCount = 0
  let skippedConvertCount = 0
  let skippedNoopCount = 0
  let sawMappedRecordRow = false
  let dataIndex = 0
  let displayRowOffset = 0
  let createPlanDisplayRowIndex = anchorRowIndex

  const passesFieldValidation = (col: ColumnDef, fieldType: string, value: unknown): boolean => {
    const result = validateBeforeSave(fieldType, value, {
      max_length: col.options?.max_length as number | undefined,
      validation_rules: col.validation_rules,
    })
    if (!result.valid) {
      skippedValidationCount += 1
      return false
    }
    return true
  }

  while (dataIndex < parsedRows.length) {
    const targetRowIndex = anchorRowIndex + dataIndex + displayRowOffset
    const rowData = getDisplayRowData(targetRowIndex)
    if (!rowData) break

    const rowType = rowData.__rowType as string | undefined
    if (
      rowType === 'add' ||
      rowType === 'group_add' ||
      rowType === 'group_header'
    ) {
      displayRowOffset++
      continue
    }

    const recordId = resolveRecordId(rowData)
    if (!recordId) {
      dataIndex++
      createPlanDisplayRowIndex = targetRowIndex
      continue
    }

    sawMappedRecordRow = true
    const pasteRow = parsedRows[dataIndex]
    const existing =
      updateMap.get(recordId) ?? {
        record_id: recordId,
        data: {},
        cellCount: 0,
        triggerKeys: [],
      }

    for (let ci = 0; ci < pasteRow.length; ci++) {
      const targetColIndex = anchorColIndex + ci
      const col = columns[targetColIndex]
      if (!col) continue
      if (col.editable === false) {
        skippedReadonlyCount += 1
        continue
      }

      const fieldType = col.originalFieldType ?? col.type ?? 'text'
      if (READONLY_FIELD_TYPES_FOR_PASTE.has(fieldType)) {
        skippedReadonlyCount += 1
        continue
      }

      const rawPasteValue = pasteRow[ci]
      const converted = convertPasteValue(rawPasteValue, fieldType)
      if (converted === undefined) {
        skippedConvertCount += 1
        continue
      }

      const oldValue = (rowData as Record<string, unknown>)[col.field]
      const isNewEmpty =
        converted === null || converted === undefined || converted === ''
      const isOldEmpty =
        oldValue === null || oldValue === undefined || oldValue === ''
      if ((isNewEmpty && isOldEmpty) || oldValue === converted) {
        skippedNoopCount += 1
        continue
      }

      if (!passesFieldValidation(col, fieldType, converted)) {
        continue
      }

      const writeKey = col.fieldId ?? col.field
      existing.data[writeKey] = converted
      existing.cellCount += 1
      if (!existing.triggerKeys.includes(writeKey)) {
        existing.triggerKeys.push(writeKey)
      }
      updatedCellCount += 1
    }

    if (existing.cellCount > 0) {
      updateMap.set(recordId, existing)
    }

    dataIndex++
    createPlanDisplayRowIndex = targetRowIndex
  }

  const remainingRows = parsedRows.slice(dataIndex)
  const createPlan =
    remainingRows.length > 0 && buildCreatePlanFromDisplayRowIndex
      ? buildCreatePlanFromDisplayRowIndex(createPlanDisplayRowIndex)
      : null

  const creates: PlannedPasteCreate[] = []
  let skippedRows = 0
  const autoCreateCount =
    tableId != null ? Math.min(remainingRows.length, maxAutoCreateRows) : 0
  const truncatedRows = Math.max(remainingRows.length - autoCreateCount, 0)

  for (let ri = 0; ri < autoCreateCount; ri++) {
    const pasteRow = remainingRows[ri]
    const pasteData: Record<string, unknown> = {}
    let hasWritablePasteValue = false

    for (let ci = 0; ci < pasteRow.length; ci++) {
      const col = columns[anchorColIndex + ci]
      if (!col) continue
      if (col.editable === false) {
        skippedReadonlyCount += 1
        continue
      }

      const fieldType = col.originalFieldType ?? col.type ?? 'text'
      if (READONLY_FIELD_TYPES_FOR_PASTE.has(fieldType)) {
        skippedReadonlyCount += 1
        continue
      }

      const converted = convertPasteValue(pasteRow[ci], fieldType)
      if (converted === undefined) {
        skippedConvertCount += 1
        continue
      }

      if (!passesFieldValidation(col, fieldType, converted)) {
        continue
      }

      pasteData[col.fieldId ?? col.field] = converted
      hasWritablePasteValue = true
    }

    if (!hasWritablePasteValue) {
      skippedRows += 1
      continue
    }

    creates.push({
      data: {
        ...(createPlan?.prefillValues ?? {}),
        ...pasteData,
      },
    })
  }

  skippedRows += truncatedRows

  const updates = Array.from(updateMap.values())
  const blockedNoTarget =
    (remainingRows.length > 0 && tableId == null) ||
    (!sawMappedRecordRow && creates.length === 0)

  const zeroWriteReason =
    updates.length === 0 && creates.length === 0
      ? resolvePasteZeroWriteReason({
          skippedValidationCount,
          skippedReadonlyCount,
          skippedConvertCount,
          skippedNoopCount,
          blockedNoTarget,
        })
      : null

  return {
    updates,
    creates,
    updatedCellCount,
    createdRowCount: creates.length,
    skippedRows,
    truncatedRows,
    skippedValidationCount,
    skippedReadonlyCount,
    skippedConvertCount,
    skippedNoopCount,
    zeroWriteReason,
    createPlan,
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseDataGridClipboardParams {
  columns: ColumnDef[]
  gridApiRef: React.RefObject<ClipboardGridApi | null>
  tableId: string | null
  refreshAfterPaste: () => Promise<void> | void
  useViewData: boolean
  buildCreatePlanFromDisplayRowIndex: (
    displayRowIndex: number,
  ) => ViewAwareCreatePlan
  bulkUpdateRecords: (data: {
    updates: Array<{ record_id: string; data: Record<string, unknown> }>
    operation_group_id?: string
  }) => Promise<{ records: TableRecord[]; errors: string[] }>
  bulkCreateRecords: (data: {
    table_id: string
    records: Array<Record<string, unknown>>
    order_context?: Record<string, unknown>
    operation_group_id?: string
  }) => Promise<TableRecord[]>
  applyLocalCreateOverlay?: (
    createdRecords: TableRecord[],
    orderContext?: ViewAwareCreatePlan['orderContext'],
  ) => TableRecord[] | Promise<TableRecord[]>
  onRevealHiddenRecord?: (record: TableRecord) => void | Promise<void>
  onRecordCreated?: (record: TableRecord) => void | Promise<void>
  startPolling: (pendingFields: Set<string>) => void
  checkIfTriggersAutoField: (fieldNameOrId: string) => Array<{ id: string }>
  /**
   * 返回 on_create 触发模式的字段 ID 列表（可选，用于新建行后启动 polling）。
   * 历史遗留：该接口曾服务于已下架的 TabData AI 字段；当前所有 host 都返回空数组，
   * 接口保留以减少调用方改动。后续若有新的 on_create 自动字段类型可复用。
   */
  getOnCreateAutoFieldIds?: () => string[]
  t: (key: string, options?: Record<string, unknown>) => string
}

export interface PasteConfirmState {
  open: boolean
  rowCount: number
  cellCount: number
  newRowCount: number
  skippedRows: number
  truncatedRows: number
}

export interface UseDataGridClipboardReturn {
  handleClipboardCopy: (payload: TableGridClipboardPayload) => void
  handleClipboardPaste: (payload: TableGridClipboardPayload) => void
  pasteConfirmState: PasteConfirmState | null
  confirmPaste: () => void
  cancelPaste: () => void
}

export function useDataGridClipboard({
  columns,
  gridApiRef,
  tableId,
  refreshAfterPaste,
  useViewData,
  buildCreatePlanFromDisplayRowIndex,
  bulkUpdateRecords,
  bulkCreateRecords,
  applyLocalCreateOverlay,
  onRevealHiddenRecord,
  onRecordCreated,
  startPolling,
  checkIfTriggersAutoField,
  getOnCreateAutoFieldIds,
  t,
}: UseDataGridClipboardParams): UseDataGridClipboardReturn {
  const [pasteConfirmState, setPasteConfirmState] =
    React.useState<PasteConfirmState | null>(null)
  const pendingPasteRef = React.useRef<PlannedPasteOperations | null>(null)

  const notifyHiddenCreatedRecords = React.useCallback(
    (hiddenRecords: TableRecord[]) => {
      if (!useViewData || hiddenRecords.length === 0) {
        return
      }
      const firstHiddenRecord = hiddenRecords[0]
      const actionLabel = t('table:record.createdHiddenAction')
      const actionElement = onRevealHiddenRecord
        ? buildToastActionElement(actionLabel, () => {
          void onRevealHiddenRecord(firstHiddenRecord)
        })
        : undefined
      toast({
        title: t('table:record.createdTitle'),
        description: t('table:record.createdHiddenDesc', {
          count: hiddenRecords.length,
        }),
        action: actionElement,
      })
    },
    [onRevealHiddenRecord, t, useViewData],
  )
  const isViewOverlayEligibleRecord = React.useCallback(
    (record: TableRecord | null | undefined) =>
      Boolean(record && (record as Record<string, unknown>).__viewOverlayEligible === true),
    [],
  )

  const executePasteUpdates = React.useCallback(
    (plan: PlannedPasteOperations) => {
      void (async () => {
        const totalOps = plan.updatedCellCount + plan.createdRowCount
        const showProgress = totalOps > 50
        let loadingToast: ReturnType<typeof toast> | undefined

        if (showProgress) {
          loadingToast = toast({
            description: t('table:clipboard.pasting', {
              count: totalOps,
            }),
            duration: 60000,
          })
        }

        let actualUpdatedCount = 0
        let failedUpdateCount = 0
        let actualCreatedCount = 0
        let failedCreateCount = 0
        let createdRecords: TableRecord[] = []
        let updateErrors: string[] = []

        const operationGroupId =
          typeof globalThis.crypto !== 'undefined' &&
          typeof globalThis.crypto.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : createFallbackOperationGroupId()

        try {
          if (plan.updates.length > 0) {
            const updateResult = await bulkUpdateRecords({
              updates: plan.updates.map(({ record_id, data }) => ({
                record_id,
                data,
              })),
              operation_group_id: operationGroupId,
            })
            const updatedRecords = updateResult.records
            updateErrors = updateResult.errors
            const updatedRecordIds = new Set(updatedRecords.map((record) => record.id))
            actualUpdatedCount = plan.updates.reduce(
              (sum, item) =>
                sum + (updatedRecordIds.has(item.record_id) ? item.cellCount : 0),
              0,
            )
            failedUpdateCount = Math.max(
              0,
              plan.updatedCellCount - actualUpdatedCount,
            )

            const pendingFields = new Set<string>()
            for (const item of plan.updates) {
              if (!updatedRecordIds.has(item.record_id)) {
                continue
              }
              for (const triggerKey of item.triggerKeys) {
                const triggeredFields = checkIfTriggersAutoField(triggerKey)
                triggeredFields.forEach((field) => {
                  pendingFields.add(`${item.record_id}_${field.id}`)
                })
              }
            }
            if (pendingFields.size > 0) {
              startPolling(pendingFields)
            }
          }

          if (plan.creates.length > 0 && tableId) {
            createdRecords = await bulkCreateRecords({
              table_id: tableId,
              records: plan.creates.map((item) => item.data),
              ...(plan.createPlan?.orderContext
                ? { order_context: plan.createPlan.orderContext }
                : {}),
              operation_group_id: operationGroupId,
            })
            if (applyLocalCreateOverlay) {
              createdRecords = await applyLocalCreateOverlay(
                createdRecords,
                plan.createPlan?.orderContext
              )
            }
            actualCreatedCount = createdRecords.length
            failedCreateCount = Math.max(
              0,
              plan.createdRowCount - actualCreatedCount,
            )

            if (createdRecords.length > 0 && getOnCreateAutoFieldIds) {
              const onCreateFieldIds = getOnCreateAutoFieldIds()
              if (onCreateFieldIds.length > 0) {
                const pendingFields = new Set<string>()
                for (const record of createdRecords) {
                  for (const fieldId of onCreateFieldIds) {
                    pendingFields.add(`${record.id}_${fieldId}`)
                  }
                }
                if (pendingFields.size > 0) {
                  startPolling(pendingFields)
                }
              }
            }
          }
        } catch (error) {
          toast({
            description:
              error instanceof Error
                ? error.message
                : t('table:clipboard.pasteFailed'),
            variant: 'destructive',
            duration: 4000,
          })
          return
        } finally {
          if (loadingToast) {
            loadingToast.dismiss()
          }
        }

        const hasOverlayCreatedRecords = createdRecords.some(isViewOverlayEligibleRecord)
        if (
          useViewData &&
          (actualUpdatedCount > 0 || (actualCreatedCount > 0 && !hasOverlayCreatedRecords))
        ) {
          try {
            await refreshAfterPaste()
          } catch {
            // ignore
          }
        }

        if (actualCreatedCount > 0) {
          if (useViewData) {
            const { firstVisibleRecord, hiddenRecords } =
              await resolveCreatedRecordVisibility({
                gridApiRef,
                createdRecords,
              })
            if (hiddenRecords.length > 0) {
              notifyHiddenCreatedRecords(hiddenRecords)
            }
            if (firstVisibleRecord && onRecordCreated) {
              try {
                await onRecordCreated(firstVisibleRecord)
              } catch {
                // ignore
              }
            }
          } else if (onRecordCreated) {
            try {
              await onRecordCreated(createdRecords[0])
            } catch {
              // ignore
            }
          }
        }

        if (failedUpdateCount > 0) {
          const uniqueReasons = deduplicateErrors(updateErrors)
          const description = uniqueReasons.length > 0
            ? uniqueReasons.join('；')
            : t('table:clipboard.updatesFailed', { count: failedUpdateCount })
          toast({
            description,
            variant: 'destructive',
            duration: 5000,
          })
        }

        if (failedCreateCount > 0) {
          toast({
            description: t('table:clipboard.createsFailed', { count: failedCreateCount }),
            variant: 'destructive',
            duration: 4000,
          })
        }

        if (plan.skippedRows > 0) {
          toast({
            description: String(
              t('table:clipboard.rowsSkipped', { count: plan.skippedRows }),
            ),
            variant: 'destructive',
            duration: 3000,
          })
        }

        if (plan.skippedValidationCount > 0) {
          toast({
            description: t('table:clipboard.validationSkipped', {
              count: plan.skippedValidationCount,
            }),
            variant: 'destructive',
            duration: 3500,
          })
        }

        const totalPasted = actualUpdatedCount + actualCreatedCount
        if (totalPasted > 0) {
          let desc: string
          if (actualCreatedCount > 0 && actualUpdatedCount > 0) {
            desc = t('table:clipboard.pastedWithNewRows', {
              cells: actualUpdatedCount,
              newRows: actualCreatedCount,
            })
          } else if (actualCreatedCount > 0) {
            desc = t('table:clipboard.pastedNewRowsOnly', {
              count: actualCreatedCount,
            })
          } else {
            desc = t('table:clipboard.pastedCells', {
              count: actualUpdatedCount,
            })
          }
          toast({ description: desc, duration: 2500 })
        }
      })()
    },
    [
      bulkCreateRecords,
      bulkUpdateRecords,
      checkIfTriggersAutoField,
      getOnCreateAutoFieldIds,
      gridApiRef,
      applyLocalCreateOverlay,
      isViewOverlayEligibleRecord,
      notifyHiddenCreatedRecords,
      onRecordCreated,
      refreshAfterPaste,
      startPolling,
      t,
      tableId,
      useViewData,
    ],
  )

  const confirmPaste = React.useCallback(() => {
    const pending = pendingPasteRef.current
    if (pending) {
      executePasteUpdates(pending)
      pendingPasteRef.current = null
    }
    setPasteConfirmState(null)
  }, [executePasteUpdates])

  const cancelPaste = React.useCallback(() => {
    pendingPasteRef.current = null
    setPasteConfirmState(null)
  }, [])

  const handleClipboardCopy = React.useCallback(
    (payload: TableGridClipboardPayload) => {
      const cellCount = payload.cells?.length ?? 0
      if (cellCount > 1) {
        toast({
          description: t('table:clipboard.copiedCells', { count: cellCount }),
          duration: 1500,
        })
      }
    },
    [t],
  )

  const handleClipboardPaste = React.useCallback(
    (payload: TableGridClipboardPayload) => {
      if (pendingPasteRef.current) {
        pendingPasteRef.current = null
        setPasteConfirmState(null)
      }

      const { text, html, cells: anchorCells, hasFiles, uploadError } = payload

      if (uploadError) {
        toast({
          description: t('table:clipboard.uploadFailed', { message: uploadError }),
          variant: 'destructive',
          duration: 3000,
        })
        return
      }

      if (hasFiles && !text) {
        toast({
          description: t('table:clipboard.pasteFilesToNonAttachment'),
          variant: 'destructive',
          duration: 3000,
        })
        return
      }

      if (!text || anchorCells.length === 0) return

      const MAX_PASTE_TEXT_LENGTH = 500 * 1024
      if (text.length > MAX_PASTE_TEXT_LENGTH) {
        toast({
          description: t('table:clipboard.tooLarge'),
          variant: 'destructive',
          duration: 3000,
        })
        return
      }

      const anchor = anchorCells[0]
      const anchorColIndex = anchor.colIndex

      const anchorColumn = columns[anchorColIndex]
      const parsedRows = resolveClipboardPasteRows(
        text,
        html ?? '',
        anchorColumn?.originalFieldType ?? anchorColumn?.type,
      )

      if (parsedRows.length === 0) return

      // TODO: When pasting from TabTin's own copy, extract typed cell values
      // from the HTML channel's data-tabtin-cells attribute to bypass string
      // conversion and preserve original types (link records, attachments, etc.).
      // Use: const result = parseHtmlTable(html ?? '', true)
      // Then feed result.typedCells into planPasteOperations for lossless paste.

      const api = gridApiRef.current
      if (!api) return
      const anchorRowIndex = resolvePasteAnchorRowIndex(anchor, api)

      const totalPasteRows = parsedRows.length
      const plan = planPasteOperations({
        parsedRows,
        anchorRowIndex,
        anchorColIndex,
        columns,
        tableId,
        getDisplayRowData: (displayRowIndex) =>
          api.getDisplayedRowAtIndex?.(displayRowIndex)?.data as
            | (TableGridRow & Record<string, unknown>)
            | undefined,
        buildCreatePlanFromDisplayRowIndex,
      })

      if (plan.updates.length === 0 && plan.creates.length === 0) {
        if (parsedRows.length > 0) {
          const reason = plan.zeroWriteReason
          const zeroWriteToastKey: Record<
            Exclude<PasteZeroWriteReason, 'validation'>,
            string
          > = {
            readonly: 'table:clipboard.readonlyFieldSkipped',
            convert: 'table:clipboard.convertSkipped',
            noop: 'table:clipboard.noChangeSkipped',
            no_target: 'table:clipboard.noTargetSkipped',
            mixed: 'table:clipboard.pasteNothingWritten',
          }
          const description =
            reason === 'validation'
              ? t('table:clipboard.validationSkipped', {
                  count: plan.skippedValidationCount,
                })
              : t(
                  zeroWriteToastKey[reason ?? 'mixed'] ??
                    'table:clipboard.pasteNothingWritten',
                )
          toast({
            description,
            variant: reason === 'validation' ? 'destructive' : undefined,
            duration: 2500,
          })
        }
        return
      }

      if (totalPasteRows >= PASTE_CONFIRM_THRESHOLD) {
        pendingPasteRef.current = plan
        setPasteConfirmState({
          open: true,
          rowCount: totalPasteRows,
          cellCount: plan.updatedCellCount,
          newRowCount: plan.createdRowCount,
          skippedRows: plan.skippedRows,
          truncatedRows: plan.truncatedRows,
        })
        return
      }

      executePasteUpdates(plan)
    },
    [
      buildCreatePlanFromDisplayRowIndex,
      columns,
      executePasteUpdates,
      gridApiRef,
      tableId,
      t,
    ],
  )

  return {
    handleClipboardCopy,
    handleClipboardPaste,
    pasteConfirmState,
    confirmPaste,
    cancelPaste,
  }
}
