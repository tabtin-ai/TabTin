import { useCallback, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { TableGridRow, TableGridRuntimeApi } from '@tabtin/table-engine'
import { RECORD_IDENTITY_KEY, isDraftGridRow, resolveRecordId } from '@tabtin/table-engine'
import type { Field, TableRecord } from '../types'
import { normalizeDateCellValue, normalizeEmptyValue, validateBeforeSave } from './cellValueUtils'
import { type AdvisoryConflict, describeAdvisoryConflicts } from './advisoryConflictNotice'
import { collectDisplayedRecordIds } from '../utils/createdRecordVisibility'
import { recordProbeEvent } from '../probe/dataflowProbe'

export interface DataGridEditingNotification {
  title: string
  description?: string
  variant?: 'default' | 'destructive' | 'warning'
  duration?: number
  action?: {
    label: string
    altText?: string
    onAction: () => void
  }
}

export interface DataGridAddRowContext {
  group_path?: string
  group_values?: Record<string, unknown>
  /** Stable view-order intent captured when the append row was activated. */
  order_context?: DataGridRecordOrderContext
}

export interface DataGridRecordOrderContext {
  view_id?: string
  anchor_record_id?: string
  position?: 'before' | 'after' | 'end'
  group_values?: Record<string, unknown>
}

export interface UseDataGridEditingControllerInput {
  orderedFields: Field[]
  fields: Field[]
  selectedTableId: string | null
  useViewData: boolean
  firstEditableField: string | null
  isReadonly?: boolean
  gridApiRef: MutableRefObject<TableGridRuntimeApi<TableGridRow> | null>
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
    data?: Record<string, unknown>
    fields?: Record<string, unknown>
    fieldKeyType?: 'id' | 'name' | 'dbFieldName'
    order_context?: DataGridRecordOrderContext
  }) => Promise<TableRecord | null>
  updateRecord: (
    recordId: string,
    data: {
      data?: Record<string, unknown>
      fields?: Record<string, unknown>
      fieldKeyType?: 'id' | 'name' | 'dbFieldName'
    }
  ) => Promise<TableRecord | null>
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
  /** Current actor used to prefill creator defaults in the draft row. */
  currentUserId?: string
  resolveDraftAddRowContext?: (
    draftRow: TableGridRow,
    addRowContext?: DataGridAddRowContext
  ) => DataGridAddRowContext | undefined
  onRevealHiddenRecord?: (record: TableRecord) => void | Promise<void>
  onRecordCreated?: (record: TableRecord) => void | Promise<void>
  isRecordVisible?: (record: TableRecord) => boolean | Promise<boolean>
  /**
   * 读取上一次保存返回的 advisory 冲突（写入已成功，只是提示他人改过同一字段）。
   * 未提供时不弹并发提示。
   */
  getLastConflicts?: () => AdvisoryConflict[]
  /**
   * 编辑失败时即时回退单元格显示值，避免等待 refresh 导致的闪烁。
   * 若有提供且 oldValue 可获取，catch 中会先调用此回调再异步 refresh。
   */
  rollbackCellValue?: (params: {
    recordId: string
    fieldName: string
    fieldId: string
    oldValue: unknown
  }) => void
}

export interface DataGridEditingControllerResult {
  draftRowData: TableGridRow | null
  draftAddRowContext: DataGridAddRowContext | null
  isDraftSubmitting: boolean
  handleAddRowClick: (addRowContext?: DataGridAddRowContext) => void
  handleCellValueChanged: (
    rowData: TableGridRow,
    field: string,
    newValue: unknown,
    oldValue?: unknown
  ) => Promise<void>
  handleCellEditingStopped: (event: any) => void
  handleCommitDraftRow: () => Promise<TableRecord | null>
  handleCancelDraftRow: () => void
  handleDraftShortcutKeyDown: (event: {
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
    preventDefault?: () => void
    stopPropagation?: () => void
    nativeEvent?: KeyboardEvent
  }) => void
}

const DEFAULT_DRAFT_ROW_ID = '__draft_row__'
const UNEDITED_DRAFT_INTERACTION_GRACE_MS = 500

export const useDataGridEditingController = (
  input: UseDataGridEditingControllerInput
): DataGridEditingControllerResult => {
  const {
    orderedFields,
    fields,
    selectedTableId,
    useViewData,
    firstEditableField,
    isReadonly = false,
    gridApiRef,
    viewStoreApi,
    createRecord,
    updateRecord,
    refreshCurrentView,
    startPolling,
    checkIfTriggersAutoField,
    translate,
    notify,
    draftRowId = DEFAULT_DRAFT_ROW_ID,
    buildCreateRecordOrderContext,
    buildDraftPrefillValues,
    resolveDraftAddRowContext,
    onRevealHiddenRecord,
    onRecordCreated,
    isRecordVisible,
    rollbackCellValue,
  } = input

  const [draftRowData, setDraftRowData] = useState<TableGridRow | null>(null)
  const [draftAddRowContext, setDraftAddRowContext] = useState<DataGridAddRowContext | null>(null)
  const [isDraftSubmitting, setIsDraftSubmitting] = useState(false)
  const selectedTableIdRef = useRef(selectedTableId)
  selectedTableIdRef.current = selectedTableId

  const draftRowDataRef = useRef<TableGridRow | null>(null)
  const isCreatingDraftRef = useRef(false)
  const isCancellingDraftRef = useRef(false)
  const isExplicitDraftCommitRef = useRef(false)
  const editedDraftFieldKeysRef = useRef<Set<string>>(new Set())
  const pendingDraftUpdatesRef = useRef<Record<string, unknown>>({})
  const pendingAddRowContextRef = useRef<DataGridAddRowContext | undefined>(undefined)
  const skipNextUneditedDraftInteractionStopRef = useRef(false)
  const preserveUneditedDraftUntilRef = useRef(0)
  const preservedUneditedDraftStopCountRef = useRef(0)

  const setDraftRowState = useCallback((nextDraft: TableGridRow | null) => {
    draftRowDataRef.current = nextDraft
    setDraftRowData(nextDraft)
  }, [])

  const t = useCallback(
    (key: string, options?: Record<string, unknown>) => String(translate(key, options)),
    [translate]
  )

  const emitNotification = useCallback(
    (notification: DataGridEditingNotification) => {
      if (notify) {
        notify(notification)
      }
    },
    [notify]
  )

  const invalidateCurrentViewEtag = useCallback(() => {
    viewStoreApi.setState?.((state: any) => ({
      ...state,
      currentViewEtag: null,
    }))
  }, [viewStoreApi])

  const isOptimisticLocalCreateRecord = useCallback((record: TableRecord | null | undefined) => {
    return Boolean(
      record &&
      (record as Record<string, unknown>).__optimistic === true &&
      (record as Record<string, unknown>).__optimisticSource === 'collab' &&
      (record as Record<string, unknown>).__viewOverlayEligible === true
    )
  }, [])

  const isEmptyDraftValue = useCallback((value: unknown) => {
    if (value === null || value === undefined || value === '') {
      return true
    }
    if (Array.isArray(value)) {
      return value.length === 0
    }
    return false
  }, [])

  const hasDraftValues = useCallback(
    (draft: TableGridRow | null) => {
      if (!draft) {
        return false
      }
      return orderedFields.some(field => {
        const value = draft[field.name]
        return !isEmptyDraftValue(value)
      })
    },
    [orderedFields, isEmptyDraftValue]
  )

  const resolveFieldWriteKey = useCallback(
    (fieldKey: string) => {
      const fieldMeta = fields.find(item => item.id === fieldKey || item.name === fieldKey)
      return fieldMeta?.id ?? fieldKey
    },
    [fields]
  )

  const shouldPreserveDateTimeForDateField = useCallback((field: Field | undefined | null) => {
    if (field?.field_type !== 'date') return false
    const timeFormat = (field.options as any)?.formatting?.time
    return typeof timeFormat === 'string' && timeFormat !== 'None'
  }, [])

  const buildDraftPayload = useCallback(
    (draft: TableGridRow) => {
      const data: Record<string, unknown> = {}
      orderedFields.forEach(field => {
        const value = draft[field.name]
        const explicitlyEdited =
          editedDraftFieldKeysRef.current.has(field.name)
          || editedDraftFieldKeysRef.current.has(field.id)
        if (!isEmptyDraftValue(value) || explicitlyEdited) {
          let payloadValue = value
          if (field.field_type === 'date') {
            const dateTimeZone =
              typeof (field.options as any)?.formatting?.timeZone === 'string'
                ? String((field.options as any).formatting.timeZone)
                : undefined
            const normalized = normalizeDateCellValue(
              value,
              field.field_type,
              dateTimeZone,
              shouldPreserveDateTimeForDateField(field),
            )
            if (normalized.isValid) {
              payloadValue = normalized.value
            }
          }
          data[field.id] = payloadValue
        }
      })
      return data
    },
    [orderedFields, isEmptyDraftValue, shouldPreserveDateTimeForDateField]
  )

  const buildQueuedDraftPatch = useCallback(
    (basePayload: Record<string, unknown>, queuedValues: Record<string, unknown>) => {
      const patch: Record<string, unknown> = {}
      Object.entries(queuedValues).forEach(([fieldName, nextValue]) => {
        const baseValue = basePayload[fieldName]
        const bothEmpty = isEmptyDraftValue(nextValue) && isEmptyDraftValue(baseValue)
        if (bothEmpty || nextValue === baseValue) {
          return
        }
        patch[fieldName] = nextValue
      })
      return patch
    },
    [isEmptyDraftValue]
  )

  const clearPendingDraftUpdates = useCallback(() => {
    pendingDraftUpdatesRef.current = {}
  }, [])

  const runQueuedDraftPatch = useCallback(
    async (recordId: string, queuedPatch: Record<string, unknown>) => {
      const queuedPatchKeys = Object.keys(queuedPatch)
      if (queuedPatchKeys.length === 0) {
        return
      }

      const updatedRecord = await updateRecord(String(recordId), {
        data: queuedPatch,
        fields: queuedPatch,
        fieldKeyType: 'id',
      })
      if (!updatedRecord) {
        throw new Error(t('table:record.createPatchFailedDesc'))
      }

      const pendingFields = new Set<string>()
      queuedPatchKeys.forEach(fieldKey => {
        const triggeredFields = checkIfTriggersAutoField(fieldKey)
        triggeredFields.forEach(fieldMeta => {
          pendingFields.add(`${recordId}_${fieldMeta.id}`)
        })
      })
      if (pendingFields.size > 0) {
        startPolling(pendingFields)
      }
    },
    [checkIfTriggersAutoField, startPolling, t, updateRecord]
  )

  const notifyQueuedDraftPatchFailure = useCallback(
    (error?: unknown) => {
      emitNotification({
        title: t('table:record.createPatchFailedTitle'),
        description:
          error instanceof Error && error.message
            ? error.message
            : t('table:record.createPatchFailedDesc'),
        variant: 'destructive',
      })
    },
    [emitNotification, t]
  )

  const resolveCurrentDraftAddRowContext = useCallback(
    (draft: TableGridRow) => {
      const baseContext = pendingAddRowContextRef.current ?? draftAddRowContext ?? undefined
      return resolveDraftAddRowContext?.(draft, baseContext) ?? baseContext
    },
    [draftAddRowContext, resolveDraftAddRowContext]
  )

  const focusDraftRowFirstCell = useCallback(() => {
    const api = gridApiRef.current
    if (!api || !firstEditableField) {
      return false
    }

    const bottomCount = api.getPinnedBottomRowCount?.() ?? 0

    let draftPinnedIndex: number | null = null
    for (let i = 0; i < bottomCount; i += 1) {
      const row = api.getPinnedBottomRow?.(i)
      const data = row?.data as TableGridRow | undefined
      if (isDraftGridRow(data, draftRowId)) {
        draftPinnedIndex = i
        break
      }
    }

    if (draftPinnedIndex == null) {
      const displayedCount =
        typeof api.getDisplayedRowCount === 'function' ? api.getDisplayedRowCount() : 0
      for (let i = 0; i < displayedCount; i += 1) {
        const rowNode = api.getDisplayedRowAtIndex?.(i)
        const data = rowNode?.data as TableGridRow | undefined
        if (isDraftGridRow(data, draftRowId)) {
          api.startEditingCell?.({
            rowIndex: i,
            colKey: firstEditableField,
          })
          return true
        }
      }
      return false
    }

    api.startEditingCell?.({
      rowIndex: draftPinnedIndex,
      colKey: firstEditableField,
      rowPinned: 'bottom',
    })
    return true
  }, [draftRowId, firstEditableField, gridApiRef])

  const getFocusedDraftCell = useCallback((): { field: string | null } | null => {
    const api = gridApiRef.current
    const focusedCell = api?.getFocusedCell?.()
    if (!api || !focusedCell) {
      return null
    }

    let focusedData: TableGridRow | undefined
    if (focusedCell.rowPinned === 'bottom') {
      const focusedPinnedRow = api.getPinnedBottomRow?.(focusedCell.rowIndex)
      focusedData = focusedPinnedRow?.data as TableGridRow | undefined
    } else {
      const focusedRow = api.getDisplayedRowAtIndex?.(focusedCell.rowIndex)
      focusedData = focusedRow?.data as TableGridRow | undefined
    }

    if (!isDraftGridRow(focusedData, draftRowId)) {
      return null
    }

    return {
      field: typeof focusedCell.field === 'string' ? focusedCell.field : null,
    }
  }, [draftRowId, gridApiRef])

  const resolveFocusedAddRowContext = useCallback((): DataGridAddRowContext | undefined => {
    const api = gridApiRef.current
    const focusedCell = api?.getFocusedCell?.()
    if (!api || !focusedCell) {
      return undefined
    }

    let focusedData: TableGridRow | undefined
    if (focusedCell.rowPinned === 'bottom') {
      const focusedPinnedRow = api.getPinnedBottomRow?.(focusedCell.rowIndex)
      focusedData = focusedPinnedRow?.data as TableGridRow | undefined
    } else {
      const focusedRow = api.getDisplayedRowAtIndex?.(focusedCell.rowIndex)
      focusedData = focusedRow?.data as TableGridRow | undefined
    }

    if (
      !focusedData ||
      (focusedData.__rowType !== 'add' &&
        focusedData.__rowType !== 'group_add' &&
        focusedData.__rowType !== 'group_header')
    ) {
      return undefined
    }

    if (focusedData.__rowType === 'group_add') {
      return {
        group_path: typeof focusedData.__groupPath === 'string' ? focusedData.__groupPath : undefined,
        group_values:
          focusedData.__groupValues && typeof focusedData.__groupValues === 'object'
            ? (focusedData.__groupValues as Record<string, unknown>)
            : undefined,
      }
    }

    if (focusedData.__rowType === 'group_header' && Boolean((focusedData as any).__groupCollapsed)) {
      return {
        group_path: typeof focusedData.__groupPath === 'string' ? focusedData.__groupPath : undefined,
        group_values:
          focusedData.__groupValues && typeof focusedData.__groupValues === 'object'
            ? (focusedData.__groupValues as Record<string, unknown>)
            : undefined,
      }
    }

    if (focusedData.__rowType === 'add') {
      return {}
    }

    return undefined
  }, [gridApiRef])

  const isFocusOnAddRow = useCallback(() => {
    return Boolean(resolveFocusedAddRowContext())
  }, [resolveFocusedAddRowContext])

  const handleCommitDraftRow = useCallback(async () => {
    if (isReadonly) {
      return null
    }
    if (isCreatingDraftRef.current) {
      return null
    }

    const draft = draftRowDataRef.current ?? draftRowData
    if (!draft) {
      return null
    }

    if (!selectedTableId) {
      emitNotification({
        title: t('table:record.createMissingTableTitle'),
        description: t('table:record.createMissingTableDesc'),
        variant: 'destructive',
      })
      return null
    }

    const createPayload = buildDraftPayload(draft)

    for (const [fieldKey, fieldValue] of Object.entries(createPayload)) {
      const fieldMeta = fields.find(item => item.id === fieldKey || item.name === fieldKey)
      const fieldChoices = fieldMeta?.options?.choices
        ?.map((c: string | Record<string, unknown>) =>
          typeof c === 'string'
            ? c
            : String((c as Record<string, unknown>).value ?? (c as Record<string, unknown>).name ?? ''),
        )
        .filter(Boolean) as string[] | undefined
      const validation = validateBeforeSave(fieldMeta?.field_type ?? '', fieldValue, {
        max_length: (fieldMeta?.options as Record<string, unknown>)?.max_length as number | undefined,
        choices: fieldChoices,
        validation_rules: fieldMeta?.validation_rules as Record<string, unknown> | undefined,
      })
      if (!validation.valid) {
        const customMessage =
          typeof validation.params?.message === 'string' ? validation.params.message : undefined
        emitNotification({
          title: t('table:error.validationFailed'),
          description: customMessage ?? t(`table:validation.${validation.errorCode}`, validation.params),
          variant: 'destructive',
        })
        return null
      }
    }

    isCreatingDraftRef.current = true
    setIsDraftSubmitting(true)
    clearPendingDraftUpdates()
    try {
      const resolvedAddRowContext = resolveCurrentDraftAddRowContext(draft)
      pendingAddRowContextRef.current = resolvedAddRowContext
      setDraftAddRowContext(resolvedAddRowContext ?? null)
      const orderContext =
        resolvedAddRowContext?.order_context ?? buildCreateRecordOrderContext?.(resolvedAddRowContext)
      const record = await createRecord({
        table_id: selectedTableId,
        data: createPayload,
        fields: createPayload,
        fieldKeyType: 'id',
        order_context: orderContext,
      })

      if (!record) {
        emitNotification({
          title: t('table:record.createFailedTitle'),
          description: t('table:record.createFailedDesc'),
          variant: 'destructive',
        })
        return null
      }

      let appliedPayload: Record<string, unknown> = {
        ...createPayload,
      }
      while (true) {
        const queuedSnapshot = {
          ...pendingDraftUpdatesRef.current,
        }
        clearPendingDraftUpdates()
        const queuedPatch = buildQueuedDraftPatch(appliedPayload, queuedSnapshot)
        if (Object.keys(queuedPatch).length === 0) {
          break
        }

        try {
          await runQueuedDraftPatch(String(record.id), queuedPatch)
          appliedPayload = {
            ...appliedPayload,
            ...queuedPatch,
          }
        } catch (patchError) {
          const mergedQueuedValues = {
            ...queuedSnapshot,
            ...pendingDraftUpdatesRef.current,
          }
          const retryPatch = buildQueuedDraftPatch(appliedPayload, mergedQueuedValues)
          clearPendingDraftUpdates()
          if (Object.keys(retryPatch).length > 0) {
            notifyQueuedDraftPatchFailure(patchError)
          }
          break
        }
      }

      setDraftRowState(null)
      editedDraftFieldKeysRef.current.clear()
      clearPendingDraftUpdates()
      pendingAddRowContextRef.current = undefined
      preserveUneditedDraftUntilRef.current = 0
      preservedUneditedDraftStopCountRef.current = 0
      setDraftAddRowContext(null)

      const safeCallRecordCreated = async () => {
        if (!onRecordCreated) return
        try {
          await onRecordCreated(record)
        } catch {
          // 定位/高亮失败不应影响新增主流程
        }
      }

      if (!useViewData) {
        await safeCallRecordCreated()
      } else {
        if (isOptimisticLocalCreateRecord(record)) {
          // Electron 协作在线时，如果当前视图允许本地 overlay，
          // createRecord 返回的是已在本地显示层挂上的 optimistic 记录；
          // 立刻 refresh 会被后端尚未追上的 view 投影覆盖。
          startPolling(new Set())
          await safeCallRecordCreated()
          return record
        }

        const tableIdBeforeRefresh = selectedTableIdRef.current
        const previousViewEtag = viewStoreApi.getState().currentViewEtag ?? null
        let refreshOk = false
        try {
          // 新建后立刻 refresh 时，沿用旧 ETag 容易把“尚未反映到视图”的瞬时状态误判成 304。
          invalidateCurrentViewEtag()
          await refreshCurrentView()
          refreshOk = true
        } catch {
          // 主写入已成功，刷新失败不应误报为“创建失败”
        }

        // `refreshCurrentView` 宿主侧可能吞掉异常；若刷新后 ETag 仍为空，则恢复旧值，避免影响后续增量同步。
        if (viewStoreApi.getState().currentViewEtag == null && previousViewEtag != null) {
          viewStoreApi.setState?.((state: any) => ({
            ...state,
            currentViewEtag: previousViewEtag,
          }))
        }

        if (selectedTableIdRef.current !== tableIdBeforeRefresh) return null

        if (refreshOk) {
          const checkVisibleInStore = () => {
            const s = viewStoreApi.getState()
            if ((s.currentViewRecords?.records ?? []).some(r => r.id === record.id)) return true
            const displayed = collectDisplayedRecordIds(gridApiRef)
            return displayed.has(record.id)
          }
          let isVisible = checkVisibleInStore()

          if (!isVisible) {
            // 给予后端视图刷新 / WS 补偿同步更充足的窗口，避免把短暂同步延迟误报为“当前视图不可见”。
            const RETRY_DELAY_MS = 100
            const MAX_RETRIES = 15
            for (let i = 0; i < MAX_RETRIES && !isVisible; i++) {
              await new Promise<void>(r => setTimeout(r, RETRY_DELAY_MS))
              if (selectedTableIdRef.current !== tableIdBeforeRefresh) return null
              isVisible = checkVisibleInStore()
            }
          }

          if (!isVisible && isRecordVisible) {
            try {
              isVisible = Boolean(await isRecordVisible(record))
            } catch {
              isVisible = false
            }
          }

          if (!isVisible) {
            const hiddenActionLabel = t('table:record.createdHiddenAction')
            emitNotification({
              title: t('table:record.createdTitle'),
              description: t('table:record.createdHiddenDesc', { count: 1 }),
              action: onRevealHiddenRecord
                ? {
                    label: hiddenActionLabel,
                    altText: hiddenActionLabel,
                    onAction: () => {
                      void onRevealHiddenRecord(record)
                    },
                  }
                : undefined,
            })
          } else {
            await safeCallRecordCreated()
          }
        } else {
          await safeCallRecordCreated()
        }
      }
      return record
    } catch (error) {
      emitNotification({
        title: t('table:record.createFailedTitle'),
        description:
          error instanceof Error
            ? error.message
            : t('table:record.createFailedFallback'),
        variant: 'destructive',
      })
      return null
    } finally {
      isCreatingDraftRef.current = false
      setIsDraftSubmitting(false)
      clearPendingDraftUpdates()
    }
  }, [
    buildDraftPayload,
    buildQueuedDraftPatch,
    clearPendingDraftUpdates,
    createRecord,
    buildCreateRecordOrderContext,
    notifyQueuedDraftPatchFailure,
    resolveCurrentDraftAddRowContext,
    draftRowData,
    emitNotification,
    invalidateCurrentViewEtag,
    isOptimisticLocalCreateRecord,
    refreshCurrentView,
    selectedTableId,
    setDraftRowState,
    setDraftAddRowContext,
    t,
    onRevealHiddenRecord,
    onRecordCreated,
    isRecordVisible,
    isReadonly,
    runQueuedDraftPatch,
    updateRecord,
    useViewData,
    viewStoreApi,
  ])

  const handleCancelDraftRow = useCallback(() => {
    if (isCreatingDraftRef.current) {
      return
    }
    isCancellingDraftRef.current = true
    skipNextUneditedDraftInteractionStopRef.current = false
    preserveUneditedDraftUntilRef.current = 0
    preservedUneditedDraftStopCountRef.current = 0
    setDraftRowState(null)
    editedDraftFieldKeysRef.current.clear()
    clearPendingDraftUpdates()
    pendingAddRowContextRef.current = undefined
    setDraftAddRowContext(null)
  }, [clearPendingDraftUpdates, setDraftAddRowContext, setDraftRowState])

  const handleAddRowClick = useCallback((addRowContext?: DataGridAddRowContext) => {
    if (isReadonly) {
      return
    }
    const currentDraft = draftRowDataRef.current ?? draftRowData
    if (currentDraft) {
      skipNextUneditedDraftInteractionStopRef.current = true
      preserveUneditedDraftUntilRef.current = Date.now() + UNEDITED_DRAFT_INTERACTION_GRACE_MS
      preservedUneditedDraftStopCountRef.current = 0
      focusDraftRowFirstCell()
      return
    }

    isCancellingDraftRef.current = false
    skipNextUneditedDraftInteractionStopRef.current = true
    preserveUneditedDraftUntilRef.current = Date.now() + UNEDITED_DRAFT_INTERACTION_GRACE_MS
    preservedUneditedDraftStopCountRef.current = 0
    editedDraftFieldKeysRef.current.clear()
    pendingAddRowContextRef.current = addRowContext
    setDraftAddRowContext(addRowContext ?? null)
    const defaultValues: Record<string, unknown> = {}
    const now = new Date().toISOString()
    for (const field of fields) {
      const spec = field.default_value
      if (spec?.mode === 'literal') defaultValues[field.name] = spec.value
      if (spec?.mode === 'created_time' || spec?.mode === 'last_modified_time') {
        defaultValues[field.name] = now
      }
      if (spec?.mode === 'creator' && input.currentUserId) {
        defaultValues[field.name] = field.isMultipleCellValue === true || field.options?.multiple === true
          ? [input.currentUserId]
          : input.currentUserId
      }
    }
    const prefillValues = {
      ...defaultValues,
      ...(buildDraftPrefillValues?.(addRowContext) ?? {}),
    }
    setDraftRowState({
      ...prefillValues,
      [RECORD_IDENTITY_KEY]: draftRowId,
      __rowType: 'draft',
    })

    setTimeout(() => {
      let attempts = 0
      const maxAttempts = 8
      const tryFocus = () => {
        attempts += 1
        const focused = focusDraftRowFirstCell()
        if (focused || attempts >= maxAttempts) {
          return
        }
        setTimeout(tryFocus, 80)
      }
      tryFocus()
    }, 0)
  }, [
    buildDraftPrefillValues,
    fields,
    input.currentUserId,
    draftRowData,
    draftRowId,
    focusDraftRowFirstCell,
    isReadonly,
    setDraftAddRowContext,
    setDraftRowState,
  ])

  const handleDraftShortcutKeyDown = useCallback(
    (event: {
      key: string
      metaKey?: boolean
      ctrlKey?: boolean
      shiftKey?: boolean
      preventDefault?: () => void
      stopPropagation?: () => void
      nativeEvent?: KeyboardEvent
    }) => {
      if (event.nativeEvent?.isComposing) return
      const api = gridApiRef.current
      const isEditing = (api?.getEditingCells?.()?.length ?? 0) > 0
      const isCommitShortcut = event.key === 'Enter' && (Boolean(event.metaKey) || Boolean(event.ctrlKey))
      const currentDraft = draftRowDataRef.current ?? draftRowData

      if (!currentDraft) {
        if (isCommitShortcut && !isEditing) {
          event.preventDefault?.()
          handleAddRowClick(resolveFocusedAddRowContext())
          return
        }

        if (event.key === 'Enter' && !isEditing && isFocusOnAddRow()) {
          event.preventDefault?.()
          handleAddRowClick(resolveFocusedAddRowContext())
        }
        return
      }

      const focusedFieldKey = api?.getFocusedCell?.()?.field
      const focusedField = fields.find(
        field => field.id === focusedFieldKey || field.name === focusedFieldKey
      )
      // 多行文本的普通 Enter 属于编辑器内容，不得被草稿行提交快捷键抢走。
      // Cmd/Ctrl+Enter 仍可显式提交整行。
      if (
        event.key === 'Enter'
        && !event.metaKey
        && !event.ctrlKey
        && focusedField?.field_type === 'long_text'
      ) {
        return
      }

      // 其他字段的普通 Enter（非 Shift）= 提交整行并关闭草稿，与 Cmd/Ctrl+Enter 同义；
      // Shift+Enter 不在此拦截，兼容已有编辑器的换行手势。
      // 此处于捕获阶段统一收口提交意图，绕开依赖焦点解析的 editing-stopped 收尾——
      // 后者在「分组（组内行）/ 不分组（底部行）」两种草稿摆放下行为分叉，正是  的来源。
      const isDraftCommitKey = event.key === 'Enter' && !event.shiftKey
      if (isDraftCommitKey) {
        event.preventDefault?.()
        // 阻断事件抵达编辑器自身的 Enter 处理，避免其「确认文本+退出编辑」分支
        // 重复触发收尾（分组下误提交后重开空草稿、不分组下文本残留不提交）。
        event.stopPropagation?.()
        // 标记显式提交：stopEditing 触发的 editingStopped 不得把「仅预填」草稿丢掉
        isExplicitDraftCommitRef.current = true
        if (isEditing) {
          // stopEditing → saveValue → onChange，把编辑器里刚输入的值刷进草稿后再提交。
          // 不清焦点：isEditing 转 false 后编辑器 editorStyle 折叠为 0×0 不可见（不会残留输入框），
          // 而提交后由 onRecordCreated 把新记录单元格设为选中态（选中边框 + 填充手柄）。这里若清焦点
          // 会把这份选中态一并抹掉，与「提交后选中新行」预期相悖。
          api?.stopEditing?.()
        }
        queueMicrotask(() => {
          void handleCommitDraftRow().finally(() => {
            isExplicitDraftCommitRef.current = false
          })
        })
        return
      }

      if (event.key === 'Escape' && !isEditing) {
        event.preventDefault?.()
        handleCancelDraftRow()
      }
    },
    [
      draftRowData,
      fields,
      gridApiRef,
      handleAddRowClick,
      handleCancelDraftRow,
      handleCommitDraftRow,
      isFocusOnAddRow,
      resolveFocusedAddRowContext,
    ]
  )

  // ── 单元格编辑去重（防止 saveValue 被 onBlur + programmatic 双触发） ──
  const lastCellUpdateRef = useRef<{ key: string; ts: number }>({ key: '', ts: 0 })
  const CELL_UPDATE_DEDUP_MS = 500

  const handleCellValueChanged = useCallback(
    async (rowData: TableGridRow, field: string, newValue: unknown, oldValue?: unknown) => {
      if (isReadonly) {
        return
      }
      if (
        rowData?.__rowType === 'add' ||
        rowData?.__rowType === 'group_add' ||
        rowData?.__rowType === 'group_header'
      ) {
        return
      }

      if (newValue === undefined) {
        return
      }

      // 去重：同一 record + field + value 在短时间内不重复提交
      const dedupeKey = `${resolveRecordId(rowData)}:${field}:${JSON.stringify(newValue)}`
      const now = Date.now()
      if (dedupeKey === lastCellUpdateRef.current.key && now - lastCellUpdateRef.current.ts < CELL_UPDATE_DEDUP_MS) {
        return
      }
      lastCellUpdateRef.current = { key: dedupeKey, ts: now }

      const fieldMeta = fields.find(item => item.name === field || item.id === field)
      const resolvedFieldKey = resolveFieldWriteKey(field)
      const dateTimeZone =
        typeof (fieldMeta?.options as any)?.formatting?.timeZone === 'string'
          ? String((fieldMeta?.options as any).formatting.timeZone)
          : undefined

      let normalizedValue = newValue
      let normalizedOldValue = oldValue

      if (fieldMeta?.field_type === 'date') {
        const preserveDateTimeForDate = shouldPreserveDateTimeForDateField(fieldMeta)
        const normalized = normalizeDateCellValue(
          newValue,
          fieldMeta.field_type,
          dateTimeZone,
          preserveDateTimeForDate,
        )
        if (!normalized.isValid) {
          return
        }
        normalizedValue = normalized.value

        const normalizedOld = normalizeDateCellValue(
          oldValue,
          fieldMeta.field_type,
          dateTimeZone,
          preserveDateTimeForDate,
        )
        if (normalizedOld.isValid) {
          normalizedOldValue = normalizedOld.value
        }
      }

      // Number / currency / percent: NaN / Infinity 与邮箱非法格式同路径——
      // 交给下方 validateBeforeSave + toast，不再静默丢弃（避免编辑器内联提示
      // 随 setEditing(false) 卸载而时隐时现，见 ）。
      if (
        fieldMeta?.field_type &&
        ['number', 'currency', 'percent'].includes(fieldMeta.field_type) &&
        typeof normalizedValue === 'number' &&
        !Number.isFinite(normalizedValue)
      ) {
        emitNotification({
          title: t('table:error.validationFailed'),
          description: t('table:validation.invalid_number'),
          variant: 'destructive',
        })
        return
      }

      if (fieldMeta?.field_type) {
        normalizedValue = normalizeEmptyValue(fieldMeta.field_type, normalizedValue) as typeof normalizedValue
        normalizedOldValue = normalizeEmptyValue(fieldMeta.field_type, normalizedOldValue) as typeof normalizedOldValue
      }

      const isNewEmpty = normalizedValue === null || normalizedValue === undefined || normalizedValue === ''
      const isOldEmpty = normalizedOldValue === null || normalizedOldValue === undefined || normalizedOldValue === ''

      if ((isNewEmpty && isOldEmpty) || normalizedValue === normalizedOldValue) {
        return
      }

      if (rowData?.__rowType === 'draft') {
        if (isCancellingDraftRef.current) {
          return
        }

        skipNextUneditedDraftInteractionStopRef.current = false
        preserveUneditedDraftUntilRef.current = 0
        preservedUneditedDraftStopCountRef.current = 0
        editedDraftFieldKeysRef.current.add(resolvedFieldKey)

        // [Fix 7] 使用 ref 读取最新的 draft state，避免快速编辑多字段时 stale state 丢失字段值
        const currentDraft = draftRowDataRef.current ?? draftRowData

        if (isCreatingDraftRef.current) {
          if (!currentDraft) {
            // 提交已清空本地草稿后，忽略延后的 blur/save 回调，避免“新建记录”提示被重新拉起。
            return
          }

          const nextDraft: TableGridRow = {
            ...currentDraft,
            [RECORD_IDENTITY_KEY]: draftRowId,
            __rowType: 'draft',
            [field]: normalizedValue,
          }

          const nextAddRowContext = resolveCurrentDraftAddRowContext(nextDraft)
          pendingAddRowContextRef.current = nextAddRowContext
          setDraftAddRowContext(nextAddRowContext ?? null)
          setDraftRowState(nextDraft)
          pendingDraftUpdatesRef.current = {
            ...pendingDraftUpdatesRef.current,
            [resolvedFieldKey]: normalizedValue,
          }
          return
        }

        const baseDraft = currentDraft ?? {
          [RECORD_IDENTITY_KEY]: draftRowId,
          __rowType: 'draft',
        }

        const nextDraft: TableGridRow = {
          ...baseDraft,
          [RECORD_IDENTITY_KEY]: draftRowId,
          __rowType: 'draft',
          [field]: normalizedValue,
        }

        const nextAddRowContext = resolveCurrentDraftAddRowContext(nextDraft)
        pendingAddRowContextRef.current = nextAddRowContext
        setDraftAddRowContext(nextAddRowContext ?? null)
        setDraftRowState(nextDraft)
        return
      }

      const systemRecordId = resolveRecordId(rowData)
      if (!systemRecordId) {
        return
      }

      const fieldChoices = fieldMeta?.options?.choices
        ?.map((c: string | Record<string, unknown>) => (typeof c === 'string' ? c : String((c as Record<string, unknown>).value ?? (c as Record<string, unknown>).name ?? '')))
        .filter(Boolean) as string[] | undefined
      const validation = validateBeforeSave(fieldMeta?.field_type ?? '', normalizedValue, {
        max_length: (fieldMeta?.options as Record<string, unknown>)?.max_length as number | undefined,
        choices: fieldChoices,
        validation_rules: fieldMeta?.validation_rules as Record<string, unknown> | undefined,
      })
      if (!validation.valid) {
        const customMessage =
          typeof validation.params?.message === 'string' ? validation.params.message : undefined
        emitNotification({
          title: t('table:error.validationFailed'),
          description: customMessage ?? t(`table:validation.${validation.errorCode}`, validation.params),
          variant: 'destructive',
        })
        return
      }

      // 交互数据流探针（dev-only，未启用时为廉价 no-op）：标记一次「单元格提交」，
      // 走的是 UI 同款 updateRecord 路径，origin 由探针运行时决定（真人 user / fireIntent agent）。
      recordProbeEvent({
        component: 'editing',
        event: 'cell.commit',
        tableId: selectedTableId ?? undefined,
        recordId: systemRecordId,
        payload: { field: resolvedFieldKey },
      })

      try {
        const updatedRecord = await updateRecord(systemRecordId, {
          data: {
            [resolvedFieldKey]: normalizedValue,
          },
          fields: {
            [resolvedFieldKey]: normalizedValue,
          },
          fieldKeyType: 'id',
        })

        if (!updatedRecord) {
          return
        }

        recordProbeEvent({
          component: 'editing',
          event: 'cell.commitOk',
          tableId: selectedTableId ?? undefined,
          recordId: systemRecordId,
          payload: {
            field: resolvedFieldKey,
            version: (updatedRecord as Record<string, unknown>)?.version,
          },
        })

        if (input.getLastConflicts) {
          const description = describeAdvisoryConflicts(input.getLastConflicts(), input.fields, t)
          if (description) {
            emitNotification({
              title: t('table:collab.conflictDetected'),
              description,
              variant: 'warning',
              duration: 6000,
            })
          }
        }

        const triggeredFields = checkIfTriggersAutoField(resolvedFieldKey)
        if (triggeredFields.length > 0) {
          const pendingFields = new Set(triggeredFields.map(f => `${systemRecordId}_${f.id}`))
          startPolling(pendingFields)
        }
      } catch (error) {
        recordProbeEvent({
          component: 'editing',
          event: 'cell.rollback',
          tableId: selectedTableId ?? undefined,
          recordId: systemRecordId,
          payload: {
            field: resolvedFieldKey,
            message: error instanceof Error ? error.message : String(error),
          },
        })

        if (rollbackCellValue) {
          rollbackCellValue({
            recordId: systemRecordId,
            fieldName: field,
            fieldId: resolvedFieldKey,
            oldValue: normalizedOldValue,
          })
        }

        const errorDetail = error instanceof Error ? error.message : ''
        const apiDetail =
          (error as any)?.response?.data?.detail ??
          (error as any)?.response?.data?.message ??
          ''

        emitNotification({
          title: t('table:error.cellUpdateFailed'),
          description: apiDetail || errorDetail || undefined,
          variant: 'destructive',
        })

        void refreshCurrentView?.()
      }
    },
    [
      checkIfTriggersAutoField,
      draftRowId,
      emitNotification,
      fields,
      refreshCurrentView,
      resolveFieldWriteKey,
      rollbackCellValue,
      selectedTableId,
      setDraftRowState,
      shouldPreserveDateTimeForDateField,
      startPolling,
      t,
      updateRecord,
      isReadonly,
    ]
  )

  const handleCellEditingStopped = useCallback(
    (event: any) => {
      if (isReadonly) {
        return
      }
      if (isCancellingDraftRef.current) {
        return
      }

      const currentDraft = draftRowDataRef.current ?? draftRowData
      if (!currentDraft) {
        return
      }

      if (event?.data?.__rowType !== 'draft') {
        return
      }

      const api = gridApiRef.current
      const isEditing = (api?.getEditingCells?.()?.length ?? 0) > 0
      if (isEditing || isCreatingDraftRef.current) {
        return
      }

      const now = Date.now()
      const isUneditedDraft = editedDraftFieldKeysRef.current.size === 0
      const isWithinAddRowGesture = now <= preserveUneditedDraftUntilRef.current
      const stopReason = event?.reason
      const isInitialAddRowGestureStop =
        skipNextUneditedDraftInteractionStopRef.current &&
        isWithinAddRowGesture &&
        (stopReason === 'interaction' || stopReason === 'api')
      const isFollowUpAddRowGestureStop =
        preservedUneditedDraftStopCountRef.current > 0 &&
        isWithinAddRowGesture &&
        (stopReason === undefined || stopReason === 'interaction' || stopReason === 'api')
      const shouldPreserveUneditedDraftInteractionStop =
        isUneditedDraft && (isInitialAddRowGestureStop || isFollowUpAddRowGestureStop)
      if (shouldPreserveUneditedDraftInteractionStop) {
        skipNextUneditedDraftInteractionStopRef.current = false
        preservedUneditedDraftStopCountRef.current += 1
        focusDraftRowFirstCell()
        return
      }
      skipNextUneditedDraftInteractionStopRef.current = false
      preserveUneditedDraftUntilRef.current = 0
      preservedUneditedDraftStopCountRef.current = 0

      const focusedDraftCell = getFocusedDraftCell()
      const stoppedField =
        typeof event?.colDef?.field === 'string'
          ? event.colDef.field
          : typeof event?.field === 'string'
            ? event.field
            : typeof event?.column?.getColId === 'function'
              ? event.column.getColId()
              : null

      // 从空首列直接点到后续字段时，焦点已经属于同一草稿的另一个单元格。
      // 先保留草稿，再由后续字段承接输入；不能因为当前 payload 仍为空就删行。
      if (
        typeof focusedDraftCell?.field === 'string'
        && focusedDraftCell.field.length > 0
        && typeof stoppedField === 'string'
        && stoppedField.length > 0
        && focusedDraftCell.field !== stoppedField
      ) {
        return
      }

      if (!hasDraftValues(currentDraft)) {
        setDraftRowState(null)
        editedDraftFieldKeysRef.current.clear()
        clearPendingDraftUpdates()
        setDraftAddRowContext(null)
        return
      }

      // 仅有预填、用户未改：点空白收起草稿，不自动创建。
      // Enter 显式提交时 stopEditing 也会进这里——用 isExplicitDraftCommitRef 放行给 microtask commit
      if (editedDraftFieldKeysRef.current.size === 0) {
        if (isExplicitDraftCommitRef.current) {
          return
        }
        setDraftRowState(null)
        editedDraftFieldKeysRef.current.clear()
        clearPendingDraftUpdates()
        pendingAddRowContextRef.current = undefined
        setDraftAddRowContext(null)
        return
      }

      if (focusedDraftCell) {
        const stopReason =
          event?.reason === 'api' ||
          event?.reason === 'interaction' ||
          event?.reason === 'editor'
            ? event.reason
            : null
        if (
          typeof focusedDraftCell.field === 'string' &&
          focusedDraftCell.field.length > 0 &&
          typeof stoppedField === 'string' &&
          stoppedField.length > 0 &&
          focusedDraftCell.field !== stoppedField
        ) {
          return
        }

        if (
          stopReason === 'editor' &&
          typeof focusedDraftCell.field === 'string' &&
          focusedDraftCell.field.length > 0 &&
          typeof stoppedField === 'string' &&
          stoppedField.length > 0 &&
          focusedDraftCell.field === stoppedField
        ) {
          return
        }
      }

      void handleCommitDraftRow()
    },
    [
      clearPendingDraftUpdates,
      draftRowData,
      focusDraftRowFirstCell,
      getFocusedDraftCell,
      gridApiRef,
      handleCommitDraftRow,
      hasDraftValues,
      isReadonly,
      setDraftAddRowContext,
      setDraftRowState,
    ]
  )

  return {
    draftRowData,
    draftAddRowContext,
    isDraftSubmitting,
    handleAddRowClick,
    handleCellValueChanged,
    handleCellEditingStopped,
    handleCommitDraftRow,
    handleCancelDraftRow,
    handleDraftShortcutKeyDown,
  }
}
